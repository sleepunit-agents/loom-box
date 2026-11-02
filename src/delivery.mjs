// Delivery (loom docs/specs/agent-runtime.md, section 5): anything addressed to an agent arrives the same way.
//
//   a source ──► core ──► deliver {source, id, agent, venue, place, label?, from, kind: message|wake, at, text}
//                  1. the turn, then its text, to core (core.mjs): if the turn can't be written, a 5xx answer,
//                     and nothing reaches a body
//                  2. the conversation's body, for up to 2 s: live → fed; turn over → resumed (the same session);
//                     ended with a slot → resumed from it; none → started through the runner interface
//                  3. {conversation, seq, body: fed|resumed|started|queued|failed, reason?}
//
// Bodies, capacity and continuity are bridges.md's, ported from the bridges piece (shuttle): dispatch.py's `offer`
// (the conversation's body takes it, else it's held, else a fresh body), nowlog.py's hold order (the conversation's
// body is busy → queued; every slot busy → queued; short of memory → queued), core.py's drop (what a body's inbox still
// held goes to the next body), config.py's limits (5 busy, 1500 MB), and the body host's idle time (600 s). What
// bridges.md added and shuttle never had is here too:
//   - capacity counts busy bodies (mid-turn, or starting): a body whose turn is over stays warm and holds no slot;
//   - over the limit, a new conversation takes the least recently active warm idle body's place (ended, its slot
//     saved); only busy bodies make a message wait;
//   - continuity: a body that ends leaves a slot, its harness's session files sealed to the runtime's key
//     (sealed.mjs), kept for the venue's continuity window (at most 14 days) and restored to resume it; when a slot
//     goes, the harness's own local transcript files go with it, and the conversation resumes from its digests.
//
// What the runtime keeps here is mechanism (conversations.md: session-resume state, queues), under
// <data>/delivery: conversations/<cv>.json (which body, which run, what waits: each message's text sealed), slots/,
// seen/ (each delivery's answer for 24 h: the same (source, id) answers the same and writes nothing).
//
// Outbound (`send`): the venue's declared send argv, `--place <place> --agent <agent>`, the text on stdin, 15 s,
// `{ok, id?}`, one retry; then the agent's turn (`reply`, outcome answered or failed) and its text, to core.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountsFrom } from './accounts.mjs';
import { endBody, readBody, resumeBody, startBody } from './bodies.mjs';
import { CoreError, coreFrom } from './core.mjs';
import { venueKind as kindOf } from './models.mjs';
import { setting } from './piece.mjs';
import { runnerFor } from './runners.mjs';
import { ageSealer } from './sealed.mjs';
import { AGENT_NAME, alive, withLock } from './state.mjs';

const DAY_MS = 86_400_000;
export const MAX_TEXT = 40_000;
export const MAX_ID = 200;
export const MAX_PLACE = 200;
export const MAX_LABEL = 80;
/** How long a source's call waits for the body (agent-runtime.md, "The runtime", step 2). */
export const REACH_MS = 2000;
/** Bodies an agent has mid-turn before a new conversation's message waits (shuttle's MAX_LIVE). */
export const BUSY_LIMIT = 5;
/** A warm body whose turn is over is ended after this long idle (shuttle's body host, idle_s). */
export const WARM_IDLE_S = 600;
/** No new body below this much available memory (shuttle's MIN_AVAIL_MB). */
export const MIN_AVAIL_MB = 1500;
/** A slot lasts its venue's continuity window, and never longer than this. */
export const MAX_CONTINUITY_DAYS = 14;
/** Each venue kind's window, unless LOOM_RUNTIME_CONTINUITY says (bridges.md: a DM for weeks, a busy thread a day). */
export const CONTINUITY_DAYS = { live: 14, scheduled: 1, agent: 3 };
/** A send has this long (agent-runtime.md, "Outbound"). */
export const SEND_MS = 15_000;
/** A slot's packed session files, at most: past it, no slot is kept (the digests carry it). */
const MAX_SLOT_BYTES = 64 * 1024 * 1024;
/** A start or resume that's been "starting" this long, its process gone or not, is given up. */
const STARTING_MS = 120_000;
const OUTCOME_MS = 3_600_000;

const KINDS = ['message', 'wake'];
const FROM_KINDS = ['person', 'agent', 'schedule', 'unknown'];
const VENUE = /^[a-z][a-z0-9-]{0,31}$/;
const PIECE = /^[a-z][a-z0-9-]{0,39}$/;
const CV = /^cv-[0-9a-f]{12}$/;

export class DeliveryError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (m, status = 400) => { throw new DeliveryError(m, status); };

// ─── Where it lives ─────────────────────────────────────────────────────────

const dataDir = (env) => env.LOOM_BOX_DATA || join(env.HOME || homedir(), '.local', 'share', 'loom-box');
export const deliveryDir = (env) => join(dataDir(env), 'delivery');
const convDir = (env) => join(deliveryDir(env), 'conversations');
const slotFile = (env, cv) => join(deliveryDir(env), 'slots', `${cv}.age`);
const seenFile = (env, key) => join(deliveryDir(env), 'seen', `${key}.json`);

function writeJson(path, v) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(v) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };

export const loadConv = (env, cv) => (CV.test(cv ?? '') ? readJson(join(convDir(env), `${cv}.json`)) : null);
const saveConv = (env, c) => writeJson(join(convDir(env), `${c.conversation}.json`), c);
export function listConvs(env) {
  try { return readdirSync(convDir(env)).filter((n) => /^cv-[0-9a-f]{12}\.json$/.test(n)).sort().map((n) => readJson(join(convDir(env), n))).filter(Boolean); } catch { return []; }
}

/** Every change to delivery's state, under one lock: never while a harness starts (that's outside it). */
const locked = (env, f) => withLock(deliveryDir(env), 'lock', f, 'delivery', 10_000);

// ─── Settings and what it's made of ─────────────────────────────────────────

const num = (v, d) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d; };

export function limitsOf(env) {
  let continuity = {};
  try { const c = JSON.parse(setting(env, 'CONTINUITY') || '{}'); if (c && typeof c === 'object' && !Array.isArray(c)) continuity = c; } catch { /* the defaults */ }
  return {
    busy: Math.max(1, Math.floor(num(setting(env, 'BUSY_LIMIT'), BUSY_LIMIT))),
    warmIdleS: num(setting(env, 'WARM_IDLE_S'), WARM_IDLE_S),
    minAvailMb: num(setting(env, 'MIN_AVAIL_MB'), MIN_AVAIL_MB),
    continuity,
  };
}

/** A venue's continuity window: LOOM_RUNTIME_CONTINUITY by venue, else by kind, else the kind's default; ≤ 14 days. */
export function windowMs(env, venue, kind) {
  const c = limitsOf(env).continuity;
  const days = num(c[venue], num(c[kind], CONTINUITY_DAYS[kind] ?? MAX_CONTINUITY_DAYS));
  return Math.min(days, MAX_CONTINUITY_DAYS) * DAY_MS;
}

function memAvailableMb() {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf-8'));
    return m ? Number(m[1]) / 1024 : Infinity;
  } catch { return Infinity; }
}

// ─── A body's environment ───────────────────────────────────────────────────

/**
 * What a body's environment may carry: the basics a harness runs with, the harness's own settings, and nothing of the
 * runtime's (no LOOM_RUNTIME_* or LOOM_BOX_*: not its token, not where its key or slots are). LOOM_RUNTIME_BODY_ENV
 * names more, comma-separated (never one of the runtime's own). The agent's own loom token, when the runtime is
 * given a dir of them (LOOM_RUNTIME_AGENT_TOKENS/<agent>), is its LOOM_TOKEN_FILE, with LOOM_URL beside it.
 */
const BODY_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|TZ|TMPDIR|XDG_[A-Z_]+|CLAUDE_CONFIG_DIR|ANTHROPIC_[A-Z0-9_]+|CODEX_HOME|OPENAI_[A-Z0-9_]+|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/;
const RUNTIME_OWN = /^(LOOM_RUNTIME_|LOOM_BOX_|LOOM_TOKEN|LOOM_AGE)/;
export const BODY_KEY = 'LOOM_BODY_KEY';

export function bodyEnvOf(env, { agent, key } = {}) {
  const extra = new Set(String(setting(env, 'BODY_ENV') ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || RUNTIME_OWN.test(k) || k === BODY_KEY) continue;
    if (BODY_ENV.test(k) || extra.has(k)) out[k] = v;
  }
  const dir = setting(env, 'AGENT_TOKENS');
  if (agent && dir && AGENT_NAME.test(agent) && existsSync(join(dir, agent))) {
    out.LOOM_TOKEN_FILE = join(dir, agent);
    out.LOOM_URL = `${(setting(env, 'LOOM_URL') || 'http://127.0.0.1:8787/mcp')}`;
  }
  // Its run's own key: `send` answers only the body holding its conversation's current one.
  if (key) out[BODY_KEY] = key;
  return out;
}

const keyHash = (k) => createHash('sha256').update(String(k)).digest();

/** What delivery is made of, so a test (or a caller) can hand in fakes: core, the runners, the key, the clock. */
export function depsOf(env, o = {}) {
  let sealer;
  const core = o.core ?? coreFrom(env, { fetchImpl: o.fetchImpl });
  return {
    core,
    runner: o.runner ?? ((h) => runnerFor(h, env)),
    sealer: o.sealer ?? (sealer ??= ageSealer(env, deliveryDir(env))),
    now: o.now ?? (() => new Date()),
    memAvailableMb: o.memAvailableMb ?? memAvailableMb,
    accounts: o.accounts ?? accountsFrom(env),
    fetchImpl: o.fetchImpl,
    venues: o.venues ?? (() => core.venues()),
    run: o.run ?? spawnSync,
    /** A body's environment: scrubbed of the runtime's own (bodyEnvOf), with its agent's token and its run's key. */
    bodyEnv: (agent, key) => bodyEnvOf(env, { agent, key }),
    cwd: o.cwd ?? setting(env, 'BODY_CWD'),
    warn: o.warn ?? ((m) => process.stderr.write(`loom-runtime deliver: ${m}\n`)),
  };
}

// ─── The deliver body ───────────────────────────────────────────────────────

/** A venue as core has it ({kind, piece, send?}), or undefined: none, or core couldn't say. */
async function venueOf(d, name) {
  try { return (await d.venues())?.[name]; } catch (e) { d.warn(`core couldn't list the venues: ${e.message}`); return undefined; }
}

const str = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;

/** The deliver body (agent-runtime.md, "The deliver contract"), checked whole: `source` (the calling piece) is core's, added as it forwards. */
export function parseDelivery(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('a delivery is a JSON object');
  const bad = Object.keys(raw).find((k) => !['id', 'agent', 'venue', 'place', 'label', 'from', 'kind', 'at', 'text', 'source'].includes(k));
  if (bad !== undefined) fail(`a delivery has no key ${JSON.stringify(bad)}`);
  if (!str(raw.id, MAX_ID)) fail(`id is the source's own id for the message, 1-${MAX_ID} characters`);
  if (!AGENT_NAME.test(raw.agent ?? '')) fail('agent is an agent id');
  if (!VENUE.test(raw.venue ?? '')) fail('venue is a venue name');
  if (!str(raw.place, MAX_PLACE)) fail(`place is 1-${MAX_PLACE} characters`);
  if (raw.label !== undefined && !str(raw.label, MAX_LABEL, 0)) fail(`label is at most ${MAX_LABEL} characters`);
  if (!raw.from || typeof raw.from !== 'object' || Array.isArray(raw.from) || !FROM_KINDS.includes(raw.from.kind)) fail(`from is {kind: ${FROM_KINDS.join('|')}, …}`);
  if (!KINDS.includes(raw.kind)) fail(`kind is ${KINDS.join(', ')}`);
  if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) fail('at is an ISO-8601 time');
  if (!str(raw.text, MAX_TEXT)) fail(`text is 1-${MAX_TEXT} characters`);
  if (!PIECE.test(raw.source ?? '')) fail('source is the calling piece, as core forwards it');
  return { ...raw };
}

/** A delivery's key: (source piece, id), as one opaque name. */
export const deliveryKey = (m) => createHash('sha256').update(`${m.source}\0${m.id}`).digest('hex').slice(0, 32);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One delivery: the answer {conversation, seq, body, reason?}, or {status, error} when it was refused (4xx) or the
 * turn couldn't be written (5xx). `o.detach`: reach the body from a detached process (a harness can take longer to
 * start than the 2 s a source waits), as the CLI does; else here, in this process (the tests' fake runners).
 */
export async function deliver(env, raw, o = {}) {
  const d = depsOf(env, o);
  let m;
  try { m = parseDelivery(raw); } catch (e) { return { status: e.status ?? 400, error: e.message }; }
  const key = deliveryKey(m);
  const now = () => d.now().getTime();

  // Once: the same (source, id) within 24 hours answers what the first call answered, and writes nothing.
  const first = locked(env, () => {
    const s = readJson(seenFile(env, key));
    if (s && now() - s.at < DAY_MS && (s.answer || alive(s.pid))) return s;
    writeJson(seenFile(env, key), { at: now(), pid: process.pid });
    return null;
  });
  if (first) {
    for (let i = 0; !first.answer && i < 100; i++) {
      await sleep(50);
      first.answer = readJson(seenFile(env, key))?.answer;
    }
    return first.answer ?? { status: 409, error: 'the same delivery is still being made' };
  }
  const settle = (answer) => { locked(env, () => writeJson(seenFile(env, key), { at: now(), answer })); return answer; };
  const unsee = () => locked(env, () => rmSync(seenFile(env, key), { force: true }));

  // 1. The turn, first; a body sees nothing that isn't recorded.
  let turn;
  try {
    turn = await d.core.turn({ agent: m.agent, venue: m.venue, place: m.place, at: m.at, from: m.from, kind: m.kind, ...(m.label !== undefined ? { label: m.label } : {}) });
  } catch (e) {
    unsee();
    const status = e instanceof CoreError && e.status < 500 ? e.status : 503;
    return { status, error: e.message };
  }
  // Its text, for review. A failed audit write leaves the turn standing without it (conversations.md).
  try { await d.core.audit({ conversation: turn.conversation, seq: turn.seq, text: m.text }); } catch (e) { d.warn(`the turn stands without its audit text: ${e.message}`); }

  // 2. The body. The message joins its conversation's queue (sealed), and the queue is drained.
  let sealed = null;
  try { sealed = d.sealer.seal(Buffer.from(m.text, 'utf-8')).toString('base64'); } catch (e) { d.warn(`can't seal the message (${e.message}): it's delivered from memory, or not at all`); }
  const venueInfo = await venueOf(d, m.venue);
  let kind;
  try { kind = kindOf(m.venue, venueInfo?.kind); } catch { kind = 'live'; }
  locked(env, () => {
    const c = loadConv(env, turn.conversation) ?? { conversation: turn.conversation, agent: m.agent, venue: m.venue, place: m.place, kind, queue: [], outcomes: {}, runs: 0, started: d.now().toISOString() };
    if (m.label !== undefined) c.label = m.label;
    c.queue.push({ key, id: m.id, at: m.at, from: m.from, kind: m.kind, ...(sealed ? { sealed } : { mem: true }) });
    c.last = d.now().toISOString();
    saveConv(env, c);
  });
  const mem = new Map(sealed ? [] : [[key, m.text]]);
  if (o.detach && sealed) {
    o.spawnWorker?.(turn.conversation) ?? spawnWorker(env, turn.conversation);
  } else {
    await drain(env, turn.conversation, d, mem);
  }
  let out;
  for (const end = now() + REACH_MS; ; await sleep(50)) {
    out = loadConv(env, turn.conversation)?.outcomes?.[key];
    if (out || now() >= end) break;
  }
  const { at: _at, ...body } = out ?? { body: 'queued', reason: 'its body is still starting' };
  return settle({ conversation: turn.conversation, seq: turn.seq, ...body });
}

/** `loom-runtime deliver tick --conversation <cv>`, detached: it outlives the call (core's runner ends that process group). */
function spawnWorker(env, cv) {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
  mkdirSync(deliveryDir(env), { recursive: true, mode: 0o700 });
  const log = openSync(join(deliveryDir(env), 'worker.log'), 'a', 0o600);
  const child = nodeSpawn(process.execPath, [cli, 'deliver', 'tick', '--conversation', cv], { env, detached: true, stdio: ['ignore', log, log] });
  child.unref();
}

// ─── Bodies ─────────────────────────────────────────────────────────────────

const idOf = (ref) => String(ref).split(':')[1];

/** How a conversation's body is: none, working (mid-turn), idle (turn over, warm), ended or unknown. */
function statusOf(env, c, d) {
  if (!c.body) return 'none';
  let rec;
  try { rec = readBody(env, c.body); } catch { return 'unknown'; }
  if (rec.ended) return 'ended';
  try { return d.runner(rec.harness).status({ id: idOf(c.body), ...rec }); } catch { return 'unknown'; }
}

const isStarting = (c, now) => !!c.starting && alive(c.starting.pid) && now - c.starting.since < STARTING_MS;

/** An agent's bodies, for capacity: busy (mid-turn, or starting) and warm (busy, or idle and still up). */
function census(env, agent, d, now) {
  const busy = [];
  const idle = [];
  for (const c of listConvs(env)) {
    if (c.agent !== agent) continue;
    if (isStarting(c, now)) { busy.push(c); continue; }
    const st = statusOf(env, c, d);
    if (st === 'working') busy.push(c);
    else if (st === 'idle') idle.push(c);
  }
  return { busy, idle };
}

const who = (from) => (from?.kind === 'person' ? from.slug : from?.kind === 'agent' ? from.id : from?.kind === 'schedule' ? 'the schedule' : 'someone');
const render = (msgs) => msgs.map((x) => (x.kind === 'wake' ? x.text : `${who(x.from)}: ${x.text}`)).join('\n\n');

/** The brief a new body starts with: where it is, its conversation and run (for identity), and the messages. */
function startBrief(c, msgs, run, sends) {
  return [
    `You are ${c.agent}, in a conversation on ${c.venue}: ${c.label ?? c.place}.`,
    `Its conversation is ${c.conversation} and this run is ${run}: call identity with {conversation: "${c.conversation}", run: "${run}"} first.`,
    ...(c.runs > 0 ? [`It has history this session doesn't: read it with conversation({id: "${c.conversation}"}) (its digests) before you answer.`] : []),
    ...(sends ? [`To say something there, pipe it to \`loom runtime send --conversation ${c.conversation}\`; it answers {ok, id?} and, when it couldn't post, why.`] : []),
    '',
    render(msgs),
  ].join('\n');
}

/** What a resumed body is given: the new messages, and its new run. */
const resumeBrief = (c, msgs, run) => `(${c.venue}: ${c.label ?? c.place}. This run is ${run}: call identity with {conversation: "${c.conversation}", run: "${run}"} again.)\n\n${render(msgs)}`;

function open(d, x, mem) {
  if (x.sealed) return d.sealer.open(Buffer.from(x.sealed, 'base64')).toString('utf-8');
  if (mem.has(x.key)) return mem.get(x.key);
  return null;
}

function outcome(c, keys, o, now) {
  c.outcomes ??= {};
  for (const k of keys) c.outcomes[k] = { ...o, at: now };
}

/**
 * The next thing to do for conversation `cv`, decided under the lock (dispatch.py's `offer`, in its order): the body
 * holding it takes the messages; else they wait (every body busy, short of memory); else a warm idle body makes room;
 * else its body is resumed (its session, or its slot) or started. Feeding happens here; anything that runs a harness
 * is returned, with the conversation marked starting (it counts as busy until it's done).
 */
function plan(env, cv, d, mem) {
  const now = d.now().getTime();
  const c = loadConv(env, cv);
  if (!c?.queue?.length) return null;
  const wait = (reason) => {
    // A message the runtime couldn't seal can't wait: it's lost here, and said so.
    const lost = c.queue.filter((x) => !x.sealed);
    if (lost.length) outcome(c, lost.map((x) => x.key), { body: 'failed', reason: `${reason}, and the runtime can't keep its text to deliver it later (no age)` }, now);
    c.queue = c.queue.filter((x) => x.sealed);
    outcome(c, c.queue.filter((x) => !c.outcomes?.[x.key]).map((x) => x.key), { body: 'queued', reason }, now);
    c.waiting = reason;
    saveConv(env, c);
    return null;
  };
  if (c.starting) {
    if (isStarting(c, now)) return wait('its body is starting');
    delete c.starting;
  }
  const take = () => { const q = c.queue; c.queue = []; delete c.waiting; return q; };
  const begin = (op) => { c.starting = { pid: process.pid, since: now }; saveConv(env, c); return { cv, ...op }; };
  const st = statusOf(env, c, d);
  if (st === 'working') {
    // Mid-turn: into its inbox, where its harness hears it (shuttle's hand_over).
    const rec = readBody(env, c.body);
    const runner = d.runner(rec.harness);
    const left = [];
    for (const x of c.queue) {
      const text = open(d, x, mem);
      const r = text === null ? { fed: false, reason: 'its text is gone' } : runner.feed({ id: idOf(c.body), ...rec }, { id: x.key, text: render([{ ...x, text }]) });
      if (r.fed) outcome(c, [x.key], { body: 'fed' }, now); else left.push({ x, reason: r.reason });
    }
    c.queue = left.map((l) => l.x);
    c.idleSince = undefined;
    if (!c.queue.length) { delete c.waiting; saveConv(env, c); return null; }
    return wait(`its body is mid-turn and can't hear it yet (${left[0].reason}): it waits for the turn to end`);
  }
  const { busy, idle } = census(env, c.agent, d, now);
  const limits = limitsOf(env);
  if (st === 'idle') {
    // Its own body, warm, its turn over: resumed in the same session, if the agent has a slot free.
    if (busy.length >= limits.busy) return wait(`every body is busy (${busy.length} of ${limits.busy} mid-turn)`);
    return begin({ type: 'resume-warm', body: c.body, msgs: take() });
  }
  if (st === 'ended' || st === 'unknown') {
    // Gone on its own: what it leaves is saved, then this conversation is planned again.
    const ref = c.body;
    c.body = undefined;
    saveConv(env, c);
    return { cv, type: 'retire', body: ref };
  }
  if (busy.length >= limits.busy) return wait(`every body is busy (${busy.length} of ${limits.busy} mid-turn)`);
  if (d.memAvailableMb() < limits.minAvailMb) return wait(`this machine is short of memory (under ${limits.minAvailMb} MB available)`);
  if (busy.length + idle.length >= limits.busy) {
    // Over the limit with a warm idle body: it makes room (the least recently active), its conversation saved.
    const victim = idle.filter((v) => v.conversation !== cv && !v.queue?.length).sort((a, b) => String(a.last).localeCompare(String(b.last)))[0];
    if (!victim) return wait(`every body is busy (${busy.length} of ${limits.busy} mid-turn)`);
    victim.starting = { pid: process.pid, since: now };
    saveConv(env, victim);
    return { cv: victim.conversation, type: 'evict', body: victim.body, for: cv };
  }
  if (c.slot && Date.parse(c.slot.until) > now && existsSync(slotFile(env, cv))) return begin({ type: 'resume', slot: c.slot, msgs: take() });
  return begin({ type: 'start', msgs: take() });
}

/** Drain one conversation: plan, run what the plan says outside the lock, again, until there's nothing to do. */
export async function drain(env, cv, d = depsOf(env), mem = new Map()) {
  for (let i = 0; i < 6; i++) {
    const op = locked(env, () => plan(env, cv, d, mem));
    if (!op) return;
    await execute(env, op, d, mem);
  }
}

const newRun = () => `run-${randomBytes(6).toString('hex')}`;

async function execute(env, op, d, mem) {
  const now = () => d.now().getTime();
  if (op.type === 'retire' || op.type === 'evict') {
    let saved = { slot: null, pending: [] };
    try { saved = retire(env, op.cv, op.body, d, op.type === 'evict'); } catch (e) { d.warn(`ending ${op.body}: ${e.message}`); }
    locked(env, () => {
      const c = loadConv(env, op.cv);
      if (!c) return;
      if (c.body === op.body) c.body = undefined;
      delete c.starting;
      c.idleSince = undefined;
      if (saved.slot) c.slot = saved.slot; else delete c.slot;
      // What its inbox still held goes to its next body (shuttle's drop: pending becomes a fresh batch).
      c.queue = [...saved.pending, ...(c.queue ?? [])];
      saveConv(env, c);
    });
    return;
  }
  const c0 = loadConv(env, op.cv);
  const run = newRun();
  const keys = op.msgs.map((x) => x.key);
  let restored = [];
  try {
    const msgs = op.msgs.map((x) => ({ ...x, text: open(d, x, mem) })).filter((x) => x.text !== null);
    if (!msgs.length) throw new DeliveryError('its messages\' text is gone');
    const sends = !!(await venueOf(d, c0.venue))?.send;
    const runKey = randomBytes(24).toString('hex');
    const bodyDeps = { runner: d.runner, accounts: d.accounts, now: d.now, fetchImpl: d.fetchImpl, bodyEnv: d.bodyEnv(c0.agent, runKey) };
    const base = { agent: c0.agent, venue: c0.venue, venueKind: c0.kind, cwd: d.cwd };
    let r;
    if (op.type === 'start') {
      r = await startBody(env, { ...base, place: c0.place, brief: startBrief(c0, msgs, run, sends) }, bodyDeps);
    } else if (op.type === 'resume-warm') {
      const rec = readBody(env, op.body);
      const runner = d.runner(rec.harness);
      const slot = runner.slotOf({ id: idOf(op.body), ...rec }) ?? rec.slot;
      const pending = takeInbox(runner, op.body);
      endBody(env, op.body, bodyDeps);
      const extra = pending.map((p) => ({ key: p.id, kind: 'message', from: { kind: 'unknown' }, text: p.text }));
      if (!slot) throw new DeliveryError(`${op.body} has no slot: its harness never said which session it is`);
      r = await resumeBody(env, { ...base, slot, brief: resumeBrief(c0, [...extra, ...msgs], run) }, bodyDeps);
    } else {
      const got = restoreSlot(env, op.cv, d);
      restored = got.written;
      r = await resumeBody(env, { ...base, slot: got.slot, brief: resumeBrief(c0, msgs, run) }, bodyDeps);
      rmSync(slotFile(env, op.cv), { force: true });
    }
    locked(env, () => {
      const c = loadConv(env, op.cv);
      c.body = r.body;
      c.run = run;
      c.sendKey = keyHash(runKey).toString('hex');
      c.runs = (c.runs ?? 0) + 1;
      if (op.type === 'resume') delete c.slot;
      delete c.starting;
      c.idleSince = undefined;
      c.last = new Date(now()).toISOString();
      outcome(c, keys, { body: op.type === 'start' ? 'started' : 'resumed' }, now());
      saveConv(env, c);
    });
  } catch (e) {
    // A body that fails to start is `failed`: the turn stands, and nothing is retried here.
    for (const p of restored) rmSync(p, { recursive: true, force: true });
    locked(env, () => {
      const c = loadConv(env, op.cv);
      if (!c) return;
      delete c.starting;
      if (op.type === 'resume-warm') c.body = undefined;
      outcome(c, keys, { body: 'failed', reason: String(e.message).split('\n')[0].slice(0, 300) }, now());
      saveConv(env, c);
    });
  }
}

/** A body's inbox, closed: what it never took, and the inbox gone (its text with it). */
function takeInbox(runner, ref) {
  const id = idOf(ref);
  if (!runner.inbox) return [];
  runner.inbox.close(id);
  const pending = runner.inbox.pending(id).filter((p) => typeof p.text === 'string' && typeof p.id === 'string');
  runner.inbox.remove(id);
  return pending;
}

// ─── Continuity slots ───────────────────────────────────────────────────────

function readTree(root, rel, out, budget) {
  const p = join(root, rel);
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) { for (const n of readdirSync(p)) readTree(root, join(rel, n), out, budget); return; }
  if (!st.isFile()) return;
  budget.n += st.size;
  if (budget.n > MAX_SLOT_BYTES) throw new DeliveryError(`its session is over ${MAX_SLOT_BYTES / 1024 / 1024} MB`);
  out.push({ rel, data: readFileSync(p).toString('base64') });
}

/** A rel path that stays under its root. */
const safeRel = (rel) => typeof rel === 'string' && rel && !isAbsolute(rel) && !normalize(rel).split(sep).includes('..') && normalize(rel) === rel;

/**
 * A body ends (or has ended): it's stopped, what its inbox held is taken, its session's files are sealed into its
 * conversation's slot, and the harness's own local copies (its transcript, its job or run dir) are deleted: they're in
 * the slot now, or kept nowhere. Without a key (no age) there's no slot: the conversation resumes from its digests.
 */
function retire(env, cv, ref, d, stop) {
  const c = loadConv(env, cv);
  let rec;
  try { rec = readBody(env, ref); } catch { return { slot: null, pending: [] }; }
  const runner = d.runner(rec.harness);
  const body = { id: idOf(ref), ...rec };
  if (stop && !rec.ended) endBody(env, ref, { runner: d.runner, now: d.now, bodyEnv: d.bodyEnv(rec.agent) });
  const pending = takeInbox(runner, ref).map((p) => {
    try { return { key: p.id, id: p.id, at: d.now().toISOString(), from: { kind: 'unknown' }, kind: 'message', sealed: d.sealer.seal(Buffer.from(p.text, 'utf-8')).toString('base64') }; } catch { return null; }
  }).filter(Boolean);
  const slot = (() => { try { return runner.slotOf(body) ?? rec.slot; } catch { return rec.slot; } })();
  const files = runner.sessionFiles?.(slot, body) ?? { keep: [], drop: [] };
  let kept = null;
  if (slot && c) {
    try {
      const out = [];
      const budget = { n: 0 };
      for (const f of files.keep) for (const x of (() => { const o = []; readTree(runner.roots[f.root], f.rel, o, budget); return o; })()) out.push({ root: f.root, ...x });
      const blob = d.sealer.seal(Buffer.from(JSON.stringify({ v: 1, harness: slot.harness, session: slot.session, files: out })));
      mkdirSync(dirname(slotFile(env, cv)), { recursive: true, mode: 0o700 });
      writeFileSync(slotFile(env, cv), blob, { mode: 0o600 });
      const now = d.now().getTime();
      kept = { harness: slot.harness, session: slot.session, saved: new Date(now).toISOString(), until: new Date(now + windowMs(env, c.venue, c.kind)).toISOString() };
    } catch (e) {
      d.warn(`no slot kept for ${cv} (${e.message}): it resumes from its digests`);
    }
  }
  for (const f of files.keep) rmSync(join(runner.roots[f.root], f.rel), { recursive: true, force: true });
  for (const p of files.drop) rmSync(p, { recursive: true, force: true });
  return { slot: kept, pending };
}

/** A slot's session files back where its harness looks for them, for a resume: {slot: {harness, session}, written}. */
function restoreSlot(env, cv, d) {
  const pack = JSON.parse(d.sealer.open(readFileSync(slotFile(env, cv))).toString('utf-8'));
  if (pack?.v !== 1 || !Array.isArray(pack.files)) throw new DeliveryError('its slot isn\'t one this runtime wrote');
  const runner = d.runner(pack.harness);
  const written = [];
  for (const f of pack.files) {
    const root = runner.roots && Object.hasOwn(runner.roots, f.root) ? runner.roots[f.root] : undefined;
    if (!root || !safeRel(f.rel)) throw new DeliveryError('its slot names a file outside its harness\'s session dirs');
    const p = join(root, f.rel);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, Buffer.from(f.data, 'base64'), { mode: 0o600 });
    written.push(p);
  }
  return { slot: { harness: pack.harness, session: pack.session }, written };
}

/** A slot past its window: deleted, with the harness's own local transcript files for that session. */
function expireSlot(env, c, d) {
  rmSync(slotFile(env, c.conversation), { force: true });
  try {
    const runner = d.runner(c.slot.harness);
    const files = runner.sessionFiles?.(c.slot) ?? { keep: [] };
    for (const f of files.keep) rmSync(join(runner.roots[f.root], f.rel), { recursive: true, force: true });
  } catch { /* a harness this machine no longer runs */ }
}

// ─── The tick ───────────────────────────────────────────────────────────────

/**
 * What runs on a clock (the `delivery` service, and after each delivery): warm bodies idle past their time are ended
 * (their slots saved), bodies gone on their own leave their slots, slots past their window go, and every queue is
 * drained. `only`: one conversation's queue first (the detached worker a delivery starts).
 */
export async function tick(env, o = {}, only) {
  const d = depsOf(env, o);
  if (only) await drain(env, only, d);
  const now = d.now().getTime();
  const warm = limitsOf(env).warmIdleS * 1000;
  const ops = [];
  locked(env, () => {
    for (const c of listConvs(env)) {
      let dirty = false;
      if (c.starting && !isStarting(c, now)) { delete c.starting; dirty = true; }
      if (!c.starting && c.body) {
        const st = statusOf(env, c, d);
        if (st === 'working' && c.idleSince) { c.idleSince = undefined; dirty = true; }
        if (st === 'idle') {
          if (!c.idleSince) { c.idleSince = now; dirty = true; }
          if (now - c.idleSince >= warm && !c.queue?.length) { c.starting = { pid: process.pid, since: now }; ops.push({ cv: c.conversation, type: 'evict', body: c.body }); dirty = true; }
        }
        if (st === 'ended' || st === 'unknown') { ops.push({ cv: c.conversation, type: 'retire', body: c.body }); c.body = undefined; dirty = true; }
      }
      if (c.slot && !c.body && Date.parse(c.slot.until) <= now) { expireSlot(env, c, d); delete c.slot; dirty = true; }
      for (const [k, v] of Object.entries(c.outcomes ?? {})) if (now - v.at > OUTCOME_MS) { delete c.outcomes[k]; dirty = true; }
      // Nothing left of it here (no body, no slot, nothing waiting) for 14 days: the record is core's, this was mechanism.
      if (!c.body && !c.slot && !c.queue?.length && !c.starting && now - Date.parse(c.last) > MAX_CONTINUITY_DAYS * DAY_MS) {
        rmSync(join(convDir(env), `${c.conversation}.json`), { force: true });
        continue;
      }
      if (dirty) saveConv(env, c);
    }
    const seen = join(deliveryDir(env), 'seen');
    for (const n of (() => { try { return readdirSync(seen); } catch { return []; } })()) {
      const s = readJson(join(seen, n));
      if (!s || now - s.at >= DAY_MS) rmSync(join(seen, n), { force: true });
    }
  });
  for (const op of ops) await execute(env, op, d, new Map());
  for (const c of listConvs(env)) if (c.queue?.length) await drain(env, c.conversation, d);
}

// ─── Outbound ───────────────────────────────────────────────────────────────

/** One run of a venue's send: {ok, id?} or {ok: false, reason}. */
function sendOnce(d, argv, c, text) {
  const r = d.run(argv[0], [...argv.slice(1), '--place', c.place, '--agent', c.agent], { input: text, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: SEND_MS, maxBuffer: 1024 * 1024 });
  if (r.error) return { ok: false, reason: r.error.code === 'ETIMEDOUT' ? `no answer in ${SEND_MS / 1000}s` : r.error.message };
  let a;
  try { a = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { return { ok: false, reason: `its send answered no JSON (exit ${r.status})` }; }
  if (a?.ok === true) return { ok: true, ...(typeof a.id === 'string' && a.id.length <= 200 ? { id: a.id } : {}) };
  return { ok: false, reason: typeof a?.reason === 'string' ? a.reason.slice(0, 300) : `its send said no (exit ${r.status})` };
}

/**
 * An agent's message out, in its conversation's venue: sent first (one retry), then its turn recorded with outcome
 * `answered`, or `failed` when the send failed twice; the answer is what the body is told.
 */
export async function send(env, { conversation, text, key }, o = {}) {
  const d = depsOf(env, o);
  const c = loadConv(env, conversation);
  if (!c) return { ok: false, reason: `no conversation ${conversation} here` };
  // Only the body holding this conversation now, in its current run, speaks in it (as its agent, to its place).
  const want = typeof c.sendKey === 'string' && /^[0-9a-f]{64}$/.test(c.sendKey) ? Buffer.from(c.sendKey, 'hex') : null;
  if (!want || !c.body || typeof key !== 'string' || !key || !timingSafeEqual(keyHash(key), want)) {
    return { ok: false, reason: `only the body holding ${conversation} speaks in it (its run's ${BODY_KEY} doesn't match)` };
  }
  if (!str(text, MAX_TEXT)) return { ok: false, reason: `a message is 1-${MAX_TEXT} characters` };
  const v = await venueOf(d, c.venue);
  if (!v?.send) return { ok: false, reason: `venue ${c.venue} declares no send: nothing posts there` };
  let r = sendOnce(d, v.send, c, text);
  if (!r.ok) r = sendOnce(d, v.send, c, text);
  let rec = null;
  try { rec = c.body ? readBody(env, c.body) : null; } catch { /* its body is gone: the turn says no model */ }
  const turn = {
    agent: c.agent, venue: c.venue, place: c.place, at: d.now().toISOString(), from: { kind: 'agent', id: c.agent }, kind: 'reply',
    run: c.run ?? newRun(), ...(rec?.model ? { model: rec.model } : {}), ...(rec?.harness ? { harness: rec.harness } : {}), outcome: r.ok ? 'answered' : 'failed',
  };
  let seq;
  try {
    ({ seq } = await d.core.turn(turn));
    try { await d.core.audit({ conversation: c.conversation, seq, text }); } catch (e) { d.warn(`the reply's turn stands without its audit text: ${e.message}`); }
  } catch (e) { d.warn(`the reply went out but its turn wasn't recorded: ${e.message}`); }
  locked(env, () => { const x = loadConv(env, conversation); if (x) { x.last = d.now().toISOString(); saveConv(env, x); } });
  return { ...r, conversation: c.conversation, ...(seq ? { seq } : {}) };
}
