// Delivery (loom docs/specs/agent-runtime.md, section 5): anything addressed to an agent arrives the same way.
//
//   a source ──► core ──► deliver {source, id, agent, venue, place, label?, from, kind: message|wake, at, text}
//                  1. the turn, then its text, to core (core.mjs): if the turn can't be written, a 5xx answer,
//                     and nothing reaches a body
//                  2. the conversation's body, for up to 2 s: live → fed; turn over → resumed (the same session);
//                     ended with a slot → resumed from it; none → started through the runner interface
//                  3. {conversation, seq, body: fed|resumed|started|queued|failed, reason?}
//
// A body is a session in its agent's own warm house (houserunner.mjs, bodyhost.mjs): the house holds only that
// agent's token, its secrets, its repo and its box's harness login. The runtime never runs one on loom's own machine.
//
// Bodies, capacity and continuity are bridges.md's, ported from the bridges piece (shuttle): dispatch.py's `offer`
// (the conversation's body takes it, else it's held, else a fresh body), nowlog.py's hold order (the conversation's
// body is busy → queued; every slot busy → queued; its memory guard is the box's now), core.py's drop (what a body's inbox still held goes to the next
// body), config.py's limit (5 busy), and the body host's idle time (600 s). What bridges.md added and shuttle never
// had is here too:
//   - capacity counts busy bodies (mid-turn, or starting), and nothing else makes a message wait: a body whose turn
//     is over stays warm and holds no slot;
//   - over the limit, a new conversation takes the least recently active warm idle body's place (ended, its slot
//     saved); only busy bodies make a message wait;
//   - continuity: a body that ends leaves a slot, its harness's session files sealed to the runtime's key
//     (sealed.mjs), kept for the venue's continuity window (at most 14 days) and restored to resume it; when a slot
//     goes, the harness's own local transcript files go with it, and the conversation resumes from its digests.
//
// What the runtime keeps here is mechanism (conversations.md: session-resume state, queues), under
// <data>/delivery: conversations/<cv>.json (which body, which run, what waits: each message's text sealed), slots/,
// seen/ (each delivery's turn and answer for 24 h: the same (source, id) answers the same and writes nothing).
//
// Outbound (`send`): only the body holding the conversation, in its current run (LOOM_BODY_KEY), through the piece
// API as its own agent. The venue's declared send argv, `--place <place> --agent <agent>`, the text on stdin, a time
// limit, `{ok, id?}`, one retry; then the agent's turn (`reply`, outcome answered or failed) and its text, to core.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountsFrom } from './accounts.mjs';
import { endBody, readBody, resumeBody, startBody } from './bodies.mjs';
import { CoreError, coreFrom } from './core.mjs';
import { HouseRunner, sweepParts } from './houserunner.mjs';
import { venueKind as kindOf } from './models.mjs';
import { setting } from './piece.mjs';
import { dropSession, packSession, restoreFiles } from './sessions.mjs';
import { ageSealer } from './sealed.mjs';
import { AGENT_NAME, StateError, alive, withLock } from './state.mjs';

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
/** A slot lasts its venue's continuity window, and never longer than this. */
export const MAX_CONTINUITY_DAYS = 14;
/** Each venue kind's window, unless LOOM_RUNTIME_CONTINUITY says (bridges.md: a DM for weeks, a busy thread a day). */
export const CONTINUITY_DAYS = { live: 14, scheduled: 1, agent: 3 };
/** A send has this long (agent-runtime.md, "Outbound"); through the piece API, whose call is 15 s whole, less. */
export const SEND_MS = 15_000;
export const SEND_VIA_API_MS = 6_000;
/** A start or resume that's been "starting" this long, its process gone or not, is given up (a cold house is slow). */
const STARTING_MS = 240_000;
const OUTCOME_MS = 3_600_000;

const KINDS = ['message', 'wake'];
const FROM_KINDS = ['person', 'agent', 'schedule', 'unknown'];
const VENUE = /^[a-z][a-z0-9-]{0,31}$/;
const PIECE = /^[a-z][a-z0-9-]{0,39}$/;
export const CV = /^cv-[0-9a-f]{12}$/;

export class DeliveryError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (m, status = 400) => { throw new DeliveryError(m, status); };

// ─── Where it lives ─────────────────────────────────────────────────────────

const dataDir = (env) => env.LOOM_BOX_DATA || join(env.HOME || homedir(), '.local', 'share', 'loom-box');
export const deliveryDir = (env) => join(dataDir(env), 'delivery');
const convDir = (env) => join(deliveryDir(env), 'conversations');
const slotFile = (env, cv) => { if (!CV.test(cv ?? '')) fail('not a conversation id', 500); return join(deliveryDir(env), 'slots', `${cv}.age`); };
const seenFile = (env, key) => join(deliveryDir(env), 'seen', `${key}.json`);

function writeJson(path, v) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(v) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };

export const loadConv = (env, cv) => (CV.test(cv ?? '') ? readJson(join(convDir(env), `${cv}.json`)) : null);
const saveConv = (env, c) => {
  if (!CV.test(c?.conversation ?? '')) fail('not a conversation id', 500);
  writeJson(join(convDir(env), `${c.conversation}.json`), c);
};
export function listConvs(env) {
  try { return readdirSync(convDir(env)).filter((n) => /^cv-[0-9a-f]{12}\.json$/.test(n)).sort().map((n) => readJson(join(convDir(env), n))).filter((c) => c && CV.test(c.conversation ?? '')); } catch { return []; }
}

/** Every change to delivery's state, under one lock: never while a harness starts (that's outside it). */
const locked = (env, f) => withLock(deliveryDir(env), 'lock', f, 'delivery', num(env.LOOM_RUNTIME_LOCK_WAIT_MS, 10_000));

// ─── Settings and what it's made of ─────────────────────────────────────────

const num = (v, d) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d; };

export function limitsOf(env) {
  let continuity = {};
  try { const c = JSON.parse(setting(env, 'CONTINUITY') || '{}'); if (c && typeof c === 'object' && !Array.isArray(c)) continuity = c; } catch { /* the defaults */ }
  return {
    busy: Math.max(1, Math.floor(num(setting(env, 'BUSY_LIMIT'), BUSY_LIMIT))),
    warmIdleS: num(setting(env, 'WARM_IDLE_S'), WARM_IDLE_S),
    continuity,
  };
}

/** A venue's continuity window: LOOM_RUNTIME_CONTINUITY by venue, else by kind, else the kind's default; ≤ 14 days. */
export function windowMs(env, venue, kind) {
  const c = limitsOf(env).continuity;
  const days = num(c[venue], num(c[kind], CONTINUITY_DAYS[kind] ?? MAX_CONTINUITY_DAYS));
  return Math.min(days, MAX_CONTINUITY_DAYS) * DAY_MS;
}

// ─── A body's environment ───────────────────────────────────────────────────

/**
 * What the runtime hands a body of its environment: the basics only, and its run's key. A body in a house runs in the
 * house's environment (its own token, its box's harness login); nothing of the runtime's goes with it: no
 * LOOM_* (not the runtime's token, not where its key or slots are) and no harness setting or credential
 * (ANTHROPIC_*, OPENAI_*, CLAUDE_*, CODEX_*). LOOM_RUNTIME_BODY_ENV names more, comma-separated, never one of those.
 */
const BODY_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|TZ|TMPDIR)$/;
const NEVER = /^(LOOM_|ANTHROPIC_|OPENAI_|CLAUDE|CODEX_|GEMINI_|GOOGLE_|MISTRAL_|AWS_|GH_|GITHUB_)/;
export const BODY_KEY = 'LOOM_BODY_KEY';

export function bodyEnvOf(env, { key } = {}) {
  const extra = new Set(String(setting(env, 'BODY_ENV') ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || NEVER.test(k)) continue;
    if (BODY_ENV.test(k) || extra.has(k)) out[k] = v;
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
  const seal = o.sealer ?? (sealer ??= ageSealer(env, deliveryDir(env)));
  const houses = {};
  return {
    core,
    // Bodies run in their agent's house; a test hands in a local (fake) runner.
    runner: o.runner ?? ((h) => (houses[h] ??= new HouseRunner(env, h, { sealer: seal, now: o.now }))),
    sealer: seal,
    now: o.now ?? (() => new Date()),
    accounts: o.accounts ?? accountsFrom(env),
    fetchImpl: o.fetchImpl,
    venues: o.venues ?? (() => core.venues()),
    run: o.run ?? spawnSync,
    sendMs: o.sendMs ?? SEND_MS,
    bodyEnv: (key) => bodyEnvOf(env, { key }),
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
/** The deliveries this process is making now: a seen entry under this pid that isn't here was left by a crash. */
const inFlight = new Set();

/**
 * One delivery: the answer {conversation, seq, body, reason?}, or {status, error} when it was refused (4xx) or the
 * turn couldn't be written, or the runtime's state couldn't be had (5xx). `o.detach`: reach the body from a detached
 * process (a house can take longer to start than the 2 s a source waits), as the CLI does; else here.
 */
export async function deliver(env, raw, o = {}) {
  try { return await deliverOnce(env, raw, o); } catch (e) {
    if (e instanceof StateError || e instanceof DeliveryError) return { status: e.status >= 400 ? e.status : 503, error: e.message };
    throw e;
  }
}

/** Core's conversation id for a key (loom src/backends/conversations.ts, conversationId): known before core answers. */
export const conversationIdOf = (agent, venue, place) => `cv-${createHash('sha256').update(`${agent}\0${venue}\0${place}`).digest('hex').slice(0, 12)}`;

/** The seqs the runtime knows it wrote in a conversation (it's the only writer of its venues' turns), last 64. */
const noteSeq = (c, seq) => { c.seqs = [...new Set([...(c.seqs ?? []), seq])].sort((a, b) => a - b).slice(-64); };

/**
 * A turn write that may have landed (core didn't answer): is it there? Core has no lookup by (source, id), so this asks
 * with what it does have: an audit write for the seqs after the last one the runtime knew of, in order. A seq with no
 * turn answers 404 (so none after it is the one); one that's there takes this message's text (200), or already has
 * text (409). That turn is this message's: the runtime is its venue's only writer, so a seq it didn't record is the
 * one whose answer was lost. Another writer's turn (403) is skipped.
 */
async function findLanded(d, u, text, known) {
  for (let seq = (u.before ?? 0) + 1, i = 0; i < 16; seq++, i++) {
    if (known.includes(seq)) continue;
    try { await d.core.audit({ conversation: u.cv, seq, text }); return { conversation: u.cv, seq }; } catch (e) {
      if (e?.status === 409) return { conversation: u.cv, seq };
      if (e?.status === 404) return null;
      if (e?.status === 403) continue;
      throw e;
    }
  }
  return null;
}

async function deliverOnce(env, raw, o) {
  const d = depsOf(env, o);
  let m;
  try { m = parseDelivery(raw); } catch (e) { return { status: e.status ?? 400, error: e.message }; }
  const key = deliveryKey(m);
  const now = () => d.now().getTime();
  const cvGuess = conversationIdOf(m.agent, m.venue, m.place);

  // Once: the same (source, id) within 24 hours answers what the first call answered, and writes nothing. A call
  // that wrote its turn and then died left the turn's seq here: its retry carries on from that turn, writing none.
  // A turn write core didn't answer is `uncertain`: its retry looks for it before writing again (findLanded).
  const first = locked(env, () => {
    const s = readJson(seenFile(env, key));
    const recent = s && now() - s.at < DAY_MS;
    const live = recent && alive(s.pid) && (s.pid !== process.pid || inFlight.has(key));
    if (recent && (s.answer || live)) return { wait: s };
    writeJson(seenFile(env, key), { at: now(), pid: process.pid, ...(recent && s.turn ? { turn: s.turn } : {}), ...(recent && s.uncertain ? { uncertain: s.uncertain } : {}) });
    return { resume: recent && s.turn ? s.turn : null, uncertain: recent && !s.turn ? s.uncertain ?? null : null };
  });
  if (first.wait) {
    let answer = first.wait.answer;
    for (let i = 0; !answer && i < 100; i++) { await sleep(50); answer = readJson(seenFile(env, key))?.answer; }
    return answer ?? { status: 409, error: 'the same delivery is still being made' };
  }
  inFlight.add(key);
  try {
    const settle = (answer) => { locked(env, () => writeJson(seenFile(env, key), { at: now(), answer })); return answer; };

    // 1. The turn, first; a body sees nothing that isn't recorded.
    let turn = first.resume;
    let audited = false;
    if (!turn && first.uncertain) {
      try { turn = await findLanded(d, first.uncertain, m.text, loadConv(env, cvGuess)?.seqs ?? []); } catch (e) {
        return { status: 503, error: `couldn't tell whether this message's turn is in core: ${e.message}` };
      }
      audited = !!turn;
    }
    if (!turn) {
      const before = Math.max(0, ...(loadConv(env, cvGuess)?.seqs ?? []), first.uncertain?.before ?? 0);
      try {
        turn = await d.core.turn({ agent: m.agent, venue: m.venue, place: m.place, at: m.at, from: m.from, kind: m.kind, ...(m.label !== undefined ? { label: m.label } : {}) });
      } catch (e) {
        const definite = e instanceof CoreError && e.status < 500;
        // Refused (4xx): nothing was written. Anything else (core down, a timeout) may have landed: kept as uncertain.
        locked(env, () => (definite ? rmSync(seenFile(env, key), { force: true }) : writeJson(seenFile(env, key), { at: now(), uncertain: { cv: cvGuess, before } })));
        return { status: definite ? e.status : 503, error: e.message };
      }
      if (!CV.test(turn?.conversation ?? '') || !Number.isSafeInteger(turn?.seq) || turn.seq < 1) {
        return { status: 503, error: 'core answered the turn write with something that isn\'t a conversation id and seq' };
      }
    }
    // On record at once: a crash from here on, and the retry uses this turn.
    locked(env, () => writeJson(seenFile(env, key), { at: now(), pid: process.pid, turn: { conversation: turn.conversation, seq: turn.seq } }));
    o.afterTurn?.();
    // Its text, for review. A failed audit write leaves the turn standing without it (conversations.md); a retry's
    // second one is refused by core (409), which is fine.
    if (!audited) { try { await d.core.audit({ conversation: turn.conversation, seq: turn.seq, text: m.text }); } catch (e) { if (e?.status !== 409) d.warn(`the turn stands without its audit text: ${e.message}`); } }

    // 2. The body. The message joins its conversation's queue (sealed; without age, only in memory, on its way to
    // the worker), and the queue is drained: from a detached worker (the CLI), or here; never waited on past 2 s.
    let sealed = null;
    try { sealed = d.sealer.seal(Buffer.from(m.text, 'utf-8')).toString('base64'); } catch (e) { d.warn(`can't seal the message (${e.message}): it goes to the body from memory, and can't wait`); }
    const venueInfo = await venueOf(d, m.venue);
    let kind;
    try { kind = kindOf(m.venue, venueInfo?.kind); } catch { kind = 'live'; }
    locked(env, () => {
      const c = loadConv(env, turn.conversation) ?? { conversation: turn.conversation, agent: m.agent, venue: m.venue, place: m.place, kind, queue: [], outcomes: {}, runs: 0, started: d.now().toISOString() };
      if (m.label !== undefined) c.label = m.label;
      noteSeq(c, turn.seq);
      // A retry after a crash may find its message already queued (or already answered): never twice.
      if (!c.queue.some((x) => x.key === key) && !c.outcomes?.[key]) c.queue.push({ key, id: m.id, at: m.at, from: m.from, kind: m.kind, ...(sealed ? { sealed } : { mem: true }) });
      c.last = d.now().toISOString();
      saveConv(env, c);
    });
    const mem = new Map(sealed ? [] : [[key, m.text]]);
    // The source's 2 s are real time, whatever clock the records are kept by.
    const reachEnd = Date.now() + REACH_MS;
    if (o.detach) {
      (o.spawnWorker ?? ((cv, mm) => spawnWorker(env, cv, mm)))(turn.conversation, mem);
    } else {
      const drained = drain(env, turn.conversation, d, mem).catch((e) => d.warn(`reaching ${turn.conversation}'s body: ${e.message}`));
      o.onDrain?.(drained);
      await Promise.race([drained, sleep(Math.max(0, reachEnd - Date.now()))]);
    }
    let out;
    for (; ; await sleep(50)) {
      out = loadConv(env, turn.conversation)?.outcomes?.[key];
      if (out || Date.now() >= reachEnd) break;
    }
    const { at: _at, ...body } = out ?? { body: 'queued', reason: 'its body is still starting' };
    return settle({ conversation: turn.conversation, seq: turn.seq, ...body });
  } finally { inFlight.delete(key); }
}

/**
 * `loom-runtime deliver tick --conversation <cv> --stdin`, detached: it outlives the call (core's runner ends that
 * process group). A message the runtime couldn't seal goes to it on its stdin, never in a file or argv.
 */
function spawnWorker(env, cv, mem = new Map()) {
  if (!CV.test(cv)) fail('not a conversation id', 500);
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
  mkdirSync(deliveryDir(env), { recursive: true, mode: 0o700 });
  const log = openSync(join(deliveryDir(env), 'worker.log'), 'a', 0o600);
  const child = nodeSpawn(process.execPath, [cli, 'deliver', 'tick', '--conversation', cv, '--stdin'], { env, detached: true, stdio: ['pipe', log, log] });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(Object.fromEntries(mem)));
  child.unref();
}

// ─── Bodies ─────────────────────────────────────────────────────────────────

const idOf = (ref) => String(ref).split(':')[1];
const bodyOf = (ref, rec) => ({ id: idOf(ref), ...rec });

/** How a conversation's body is: none, working (mid-turn), idle (turn over, warm), ended or unknown. */
function statusOf(env, c, d) {
  if (!c.body) return 'none';
  let rec;
  try { rec = readBody(env, c.body); } catch { return 'unknown'; }
  if (rec.ended) return 'ended';
  try { return d.runner(rec.harness).status(bodyOf(c.body, rec)); } catch { return 'unknown'; }
}

const isStarting = (c, now) => !!c.starting && alive(c.starting.pid) && now - c.starting.since < STARTING_MS;
/** A marker of one op's own: only that op clears it (H: an op that outlived its marker can't clear the next one's). */
const mark = (now) => ({ pid: process.pid, since: now, op: randomBytes(6).toString('hex') });
const ours = (c, op) => !!c?.starting && c.starting.op === op.mark;

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

/** Messages back on a conversation's queue, ahead of what's there, none twice. */
function requeue(c, items) {
  const have = new Set((c.queue ?? []).map((x) => x.key));
  c.queue = [...items.filter((x) => (x.sealed || x.mem) && !have.has(x.key) && (have.add(x.key), true)), ...(c.queue ?? [])];
}

/**
 * The next thing to do for conversation `cv`, decided under the lock (dispatch.py's `offer`, in its order): the body
 * holding it takes the messages; else they wait (only when every slot's body is busy); else a warm idle body makes room;
 * else its body is resumed (its session, or its slot) or started. Feeding happens here; anything that runs a harness
 * is returned, with the conversation marked starting by this op (it counts as busy until it's done).
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
  const begin = (op) => { c.starting = mark(now); saveConv(env, c); return { cv, mark: c.starting.op, ...op }; };
  const st = statusOf(env, c, d);
  if (st === 'working') {
    // Mid-turn: into its inbox, where its harness hears it (shuttle's hand_over).
    const rec = readBody(env, c.body);
    const runner = d.runner(rec.harness);
    const left = [];
    for (const x of c.queue) {
      const text = open(d, x, mem);
      const r = text === null ? { fed: false, reason: 'its text is gone' } : runner.feed(bodyOf(c.body, rec), { id: x.key, text: render([{ ...x, text }]) });
      // The runtime's own copy of what it fed (sealed): the inbox's files are the body's to write, so they only ever
      // say which ids it never took, never what they said (shuttle's drop_inner).
      if (r.fed) { outcome(c, [x.key], { body: 'fed' }, now); if (x.sealed) (c.fed ??= []).push(x); } else left.push({ x, reason: r.reason });
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
    return begin({ type: 'retire', body: c.body });
  }
  if (busy.length >= limits.busy) return wait(`every body is busy (${busy.length} of ${limits.busy} mid-turn)`);
  if (busy.length + idle.length >= limits.busy) {
    // Over the limit with a warm idle body: it makes room (the least recently active), its conversation saved.
    const victim = idle.filter((v) => v.conversation !== cv && !v.queue?.length).sort((a, b) => String(a.last).localeCompare(String(b.last)))[0];
    if (!victim) return wait(`every body is busy (${busy.length} of ${limits.busy} mid-turn)`);
    victim.starting = mark(now);
    saveConv(env, victim);
    return { cv: victim.conversation, mark: victim.starting.op, type: 'evict', body: victim.body, for: cv };
  }
  if (c.slot && Date.parse(c.slot.until) > now && existsSync(slotFile(env, cv))) return begin({ type: 'resume', slot: c.slot, msgs: take() });
  return begin({ type: 'start', msgs: take() });
}

/** Drain one conversation: plan, run what the plan says outside the lock, again, until there's nothing to do. */
export async function drain(env, cv, d = depsOf(env), mem = new Map()) {
  if (!CV.test(cv ?? '')) return;
  for (let i = 0; i < 6; i++) {
    const op = locked(env, () => plan(env, cv, d, mem));
    if (!op) return;
    await execute(env, op, d, mem);
  }
}

const newRun = () => `run-${randomBytes(6).toString('hex')}`;

async function execute(env, op, d, mem) {
  const now = () => d.now().getTime();
  if (op.type === 'resume-warm') {
    // Its own warm body, its turn over: its session is sealed into its slot first (so a resume that fails leaves no
    // transcript in the clear), and what it was given goes back on the queue; the next plan resumes from that slot,
    // or starts fresh when there's none.
    let saved = { slot: null, pending: [] };
    try { saved = await retire(env, op.cv, op.body, d, true); } catch (e) { d.warn(`ending ${op.body}: ${e.message}`); }
    locked(env, () => {
      const c = loadConv(env, op.cv);
      if (!c) return;
      if (c.body === op.body) { c.body = undefined; c.idleSince = undefined; }
      if (saved.slot) c.slot = saved.slot; else delete c.slot;
      requeue(c, [...saved.pending, ...op.msgs]);
      if (ours(c, op)) delete c.starting;
      saveConv(env, c);
    });
    return;
  }
  if (op.type === 'retire' || op.type === 'evict') {
    let saved = { slot: null, pending: [] };
    try { saved = await retire(env, op.cv, op.body, d, op.type === 'evict'); } catch (e) { d.warn(`ending ${op.body}: ${e.message}`); }
    locked(env, () => {
      const c = loadConv(env, op.cv);
      if (!c) return;
      if (c.body === op.body) { c.body = undefined; c.idleSince = undefined; }
      if (ours(c, op)) delete c.starting;
      if (saved.slot) c.slot = saved.slot; else if (c.body === undefined) delete c.slot;
      // What its inbox still held goes to its next body (shuttle's drop: pending becomes a fresh batch).
      requeue(c, saved.pending);
      saveConv(env, c);
    });
    return;
  }
  const c0 = loadConv(env, op.cv);
  const run = newRun();
  const keys = op.msgs.map((x) => x.key);
  let restored = [];
  const pending = [];
  let r;
  try {
    const msgs = op.msgs.map((x) => ({ ...x, text: open(d, x, mem) })).filter((x) => x.text !== null);
    if (!msgs.length) throw new DeliveryError('its messages\' text is gone');
    const sends = !!(await venueOf(d, c0.venue))?.send;
    const runKey = randomBytes(24).toString('hex');
    const bodyDeps = { runner: d.runner, accounts: d.accounts, now: d.now, fetchImpl: d.fetchImpl, bodyEnv: d.bodyEnv(runKey) };
    const base = { agent: c0.agent, venue: c0.venue, venueKind: c0.kind, cwd: d.cwd };
    if (op.type === 'start') {
      r = await startBody(env, { ...base, place: c0.place, brief: startBrief(c0, msgs, run, sends) }, bodyDeps);
    } else {
      const pack = JSON.parse(d.sealer.open(readFileSync(slotFile(env, op.cv))).toString('utf-8'));
      if (pack?.v !== 1 || !Array.isArray(pack.files)) throw new DeliveryError('its slot isn\'t one this runtime wrote');
      const runner = d.runner(pack.harness);
      const slot = { harness: pack.harness, session: pack.session };
      // A house's body gets its files with the resume (its host puts them back); a local one, here.
      if (!runner.remote) restored = restoreFiles(runner, pack.files);
      r = await resumeBody(env, { ...base, slot, brief: resumeBrief(c0, msgs, run), ...(runner.remote ? { files: pack.files } : {}) }, bodyDeps);
      rmSync(slotFile(env, op.cv), { force: true });
    }
    const keep = locked(env, () => {
      const c = loadConv(env, op.cv);
      if (!ours(c, op)) {
        // This op outlived its marker (another took the conversation): its body isn't the conversation's. Its messages
        // go back on the queue, for whichever body is.
        requeue(c, [...op.msgs, ...pending]);
        saveConv(env, c);
        return false;
      }
      c.body = r.body;
      c.run = run;
      c.sendKey = keyHash(runKey).toString('hex');
      c.runs = (c.runs ?? 0) + 1;
      if (op.type === 'resume') delete c.slot;
      delete c.starting;
      c.idleSince = undefined;
      c.fed = [];
      c.last = new Date(now()).toISOString();
      outcome(c, [...keys, ...pending.map((p) => p.key)], { body: op.type === 'start' ? 'started' : 'resumed' }, now());
      saveConv(env, c);
      return true;
    });
    if (!keep) { try { endBody(env, r.body, { runner: d.runner, now: d.now, bodyEnv: d.bodyEnv() }); } catch { /* gone */ } }
  } catch (e) {
    for (const p of restored) rmSync(p, { recursive: true, force: true });
    locked(env, () => {
      const c = loadConv(env, op.cv);
      if (!c) return;
      if (ours(c, op)) delete c.starting;
      if (op.type === 'resume') {
        // A slot that won't resume is no slot: cleared, and the messages go back for a fresh body, in this same drain.
        rmSync(slotFile(env, op.cv), { force: true });
        delete c.slot;
        requeue(c, op.msgs);
      } else {
        // A body that fails to start is `failed`: the turn stands, and nothing is retried here.
        outcome(c, keys, { body: 'failed', reason: String(e.message).split('\n')[0].slice(0, 300) }, now());
      }
      saveConv(env, c);
    });
  }
}

/**
 * A body's inbox, closed: the messages the runtime fed it that its hook never took (G: not one it took, nor one already
 * waiting again, nor one twice), from the runtime's own sealed copies; then the inbox is gone, its text with it.
 */
function takeInbox(runner, ref, c, rec) {
  const id = idOf(ref);
  const queued = new Set((c?.queue ?? []).map((x) => x.key));
  if (runner.remote) {
    // A house's body: what its house never acknowledged, or still holds unheard; all of it when its host can't say
    // (it died). From the runtime's own copies, as for a local inbox (a duplicate beats a loss).
    const body = bodyOf(ref, rec ?? {});
    const unheard = runner.unheard?.(body);
    const out = (c?.fed ?? []).filter((x, i, all) => (unheard === null || unheard === undefined || unheard.includes(x.key)) && !queued.has(x.key) && all.findIndex((y) => y.key === x.key) === i);
    runner.forgetInbox?.(body);
    return out;
  }
  if (!runner.inbox) return [];
  runner.inbox.close(id);
  const pending = new Set(runner.inbox.pending(id).map((p) => p?.id).filter((k) => typeof k === 'string'));
  const taken = new Set(runner.inbox.taken(id));
  const out = [];
  for (const x of c?.fed ?? []) {
    if (!pending.has(x.key) || taken.has(x.key) || queued.has(x.key) || out.some((y) => y.key === x.key)) continue;
    out.push(x);
  }
  runner.inbox.remove(id);
  return out;
}

// ─── Continuity slots ───────────────────────────────────────────────────────

/**
 * A body ends (or has ended): it's stopped, what its inbox held is taken, its session's files are sealed into its
 * conversation's slot, and the harness's own local copies (its transcript, its job or run dir) are deleted: they're in
 * the slot now, or kept nowhere. A house's body is packed by its host and sent back; a local one, here. Without a key
 * (no age) there's no slot: the conversation resumes from its digests.
 */
async function retire(env, cv, ref, d, stop) {
  const c = loadConv(env, cv);
  let rec;
  try { rec = readBody(env, ref); } catch { return { slot: null, pending: [] }; }
  const runner = d.runner(rec.harness);
  const body = bodyOf(ref, rec);
  const pending = takeInbox(runner, ref, c, rec);
  const slot = (() => { try { return runner.slotOf(body) ?? rec.slot; } catch { return rec.slot; } })();
  let files = [];
  try {
    if (runner.remote) files = await runner.pack(body);
    else {
      if (stop && !rec.ended) endBody(env, ref, { runner: d.runner, now: d.now, bodyEnv: d.bodyEnv() });
      files = packSession(runner, slot, body);
    }
  } catch (e) { d.warn(`no session files for ${cv} (${e.message}): it resumes from its digests`); files = null; }
  if (runner.remote && !rec.ended) { try { endBody(env, ref, { runner: d.runner, now: d.now, bodyEnv: d.bodyEnv() }); } catch { /* gone */ } }
  if (!runner.remote) dropSession(runner, slot, body);
  let kept = null;
  // An empty pack (its harness kept nothing, or it was too big to keep) is no slot: a slot that could never resume
  // would fail every delivery for its whole window. The next body starts fresh, from the conversation's digests.
  if (slot && c && Array.isArray(files) && files.length) {
    try {
      const blob = d.sealer.seal(Buffer.from(JSON.stringify({ v: 1, harness: slot.harness, session: slot.session, files })));
      mkdirSync(dirname(slotFile(env, cv)), { recursive: true, mode: 0o700 });
      writeFileSync(slotFile(env, cv), blob, { mode: 0o600 });
      const now = d.now().getTime();
      kept = { harness: slot.harness, session: slot.session, saved: new Date(now).toISOString(), until: new Date(now + windowMs(env, c.venue, c.kind)).toISOString() };
    } catch (e) {
      d.warn(`no slot kept for ${cv} (${e.message}): it resumes from its digests`);
    }
  }
  return { slot: kept, pending };
}

/** A slot past its window: deleted, with the harness's own local transcript files for that session, where they're here. */
function expireSlot(env, c, d) {
  rmSync(slotFile(env, c.conversation), { force: true });
  try {
    const runner = d.runner(c.slot.harness);
    if (!runner.remote) dropSession(runner, c.slot);
  } catch { /* a harness this machine no longer runs */ }
}

// ─── The tick ───────────────────────────────────────────────────────────────

/**
 * What runs on a clock (the `delivery` service, and after each delivery): warm bodies idle past their time are ended
 * (their slots saved); bodies gone on their own, or still "working" with their harness gone (J), leave their slots
 * (their transcript sealed, not left in the clear); slots past their window go; and every queue is drained.
 * `only`: one conversation's queue first (the detached worker a delivery starts).
 */
export async function tick(env, o = {}, only, mem = new Map()) {
  const d = depsOf(env, o);
  if (only) await drain(env, only, d, mem);
  const now = d.now().getTime();
  // A house's session coming back in parts that stopped coming: swept after an hour.
  try { sweepParts(env, now); } catch (e) { d.warn(`sweeping part transfers: ${e.message}`); }
  const warm = limitsOf(env).warmIdleS * 1000;
  const ops = [];
  locked(env, () => {
    for (const c of listConvs(env)) {
      let dirty = false;
      if (c.starting && !isStarting(c, now)) { delete c.starting; dirty = true; }
      if (!c.starting && c.body) {
        let st = statusOf(env, c, d);
        if (st === 'working') {
          // Its harness gone (its process dead, its house down) while it says it's mid-turn: it ended.
          let gone = false;
          try { const rec = readBody(env, c.body); const r = d.runner(rec.harness); gone = typeof r.alive === 'function' && r.alive(bodyOf(c.body, rec)) === false; } catch { gone = false; }
          if (gone) st = 'ended';
        }
        if (st === 'working' && c.idleSince) { c.idleSince = undefined; dirty = true; }
        if (st === 'idle') {
          if (!c.idleSince) { c.idleSince = now; dirty = true; }
          if (now - c.idleSince >= warm && !c.queue?.length) { c.starting = mark(now); ops.push({ cv: c.conversation, mark: c.starting.op, type: 'evict', body: c.body }); dirty = true; }
        }
        if (st === 'ended' || st === 'unknown') { c.starting = mark(now); ops.push({ cv: c.conversation, mark: c.starting.op, type: 'retire', body: c.body }); dirty = true; }
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
  const r = d.run(argv[0], [...argv.slice(1), '--place', c.place, '--agent', c.agent], { input: text, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: d.sendMs, maxBuffer: 1024 * 1024 });
  if (r.error) return { ok: false, reason: r.error.code === 'ETIMEDOUT' ? `no answer in ${d.sendMs / 1000}s` : r.error.message };
  let a;
  try { a = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { return { ok: false, reason: `its send answered no JSON (exit ${r.status})` }; }
  if (a?.ok === true) return { ok: true, ...(typeof a.id === 'string' && a.id.length <= 200 ? { id: a.id } : {}) };
  return { ok: false, reason: typeof a?.reason === 'string' ? a.reason.slice(0, 300) : `its send said no (exit ${r.status})` };
}

/**
 * An agent's message out, in its conversation's venue: sent first (one retry), then its turn recorded with outcome
 * `answered`, or `failed` when the send failed twice; the answer is what the body is told. `o.caller`: who's asking
 * (the piece API's caller): an agent speaks only in its own conversations.
 */
export async function send(env, { conversation, text, key }, o = {}) {
  const d = depsOf(env, o);
  const c = loadConv(env, conversation);
  if (!c) return { ok: false, reason: `no conversation ${conversation} here` };
  if (o.caller && (o.caller.kind !== 'agent' || o.caller.agent !== c.agent)) return { ok: false, reason: `only ${c.agent}'s own body speaks in ${conversation}` };
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
    locked(env, () => { const x = loadConv(env, conversation); if (x) { noteSeq(x, seq); saveConv(env, x); } });
    try { await d.core.audit({ conversation: c.conversation, seq, text }); } catch (e) { d.warn(`the reply's turn stands without its audit text: ${e.message}`); }
  } catch (e) { d.warn(`the reply went out but its turn wasn't recorded: ${e.message}`); }
  locked(env, () => { const x = loadConv(env, conversation); if (x) { x.last = d.now().toISOString(); saveConv(env, x); } });
  return { ...r, conversation: c.conversation, ...(seq ? { seq } : {}) };
}
