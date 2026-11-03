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
// Who may do what (t-1756; policy.mjs): each message's sender tier is read from the runtime's gates when it's
// delivered; a body's rules (tier, guest venue or not, its readers' cards, the owner, peers, the agent's own brief
// files, the deny list its harness starts with) are resolved when it starts. A guest's message is never fed to a body
// that isn't a guest venue's, and a session (a warm body or a slot) is resumed only under the rules it began with.
//
// Presence and the stop word: when a message reaches a body, the venue's adapter is told (`<send> --place --agent
// --status working --message <id>`): it shows the platform's "on it" (typing, 👀). The tick says so again every
// PRESENCE_MS while the body works, and `--status done` when its turn is over. The adapter's answer carries
// `stop: true` when a person said the stop word there: the body is ended, what waited is dropped.
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
import { HouseRunner, sweepTransfers } from './houserunner.mjs';
import { venueKind as kindOf } from './models.mjs';
import { setting } from './piece.mjs';
import { dropSession, packSession, restoreFiles } from './sessions.mjs';
import { ageSealer } from './sealed.mjs';
import { RulesError, policyOf, rulesFor, tierOf } from './policy.mjs';
import { gatesOf } from './gates.mjs';
import { loomStore } from './store.mjs';
import { namesFiles } from './briefs.mjs';
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
/** A send has this long (agent-runtime.md, "Outbound"): all of it, since it runs outside the body's own call. */
export const SEND_MS = 15_000;
/** A start or resume that's been "starting" this long, its process gone or not, is given up (a cold house is slow). */
const STARTING_MS = 240_000;
const OUTCOME_MS = 3_600_000;
/** How often a working body's presence is said again to its adapter (and its stop word asked after). */
export const PRESENCE_MS = 15_000;
/** A presence or describe call to an adapter has this long. */
const ADAPTER_MS = 15_000;
/** The same words to the same person from one conversation within this long: once. */
const RELAY_SAME_MS = 600_000;
/** An agent's gates, as delivery reads them, kept this long in a process. */
const GATES_MS = 30_000;
/**
 * A body that fails to start is the runtime's to try again, on its tick: after each of these waits (about 15 minutes
 * in all), then given up, with a `failed` note on the conversation and a notice for the owner. A source never polls.
 * LOOM_RUNTIME_RETRY_S (a JSON list of seconds, 1-5 of them, each 1-3600) changes them.
 */
export const RETRY_DELAYS_MS = [60_000, 240_000, 600_000];
/** Given-up deliveries, as the owner's notices: this many, for this long. */
const NOTICE_MS = 86_400_000;
const NOTICES_MAX = 20;

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
export function retryDelaysOf(env) {
  try {
    const v = JSON.parse(setting(env, 'RETRY_S') ?? 'null');
    if (Array.isArray(v) && v.length >= 1 && v.length <= 5 && v.every((x) => Number.isFinite(x) && x >= 1 && x <= 3600)) return v.map((x) => x * 1000);
  } catch { /* the defaults */ }
  return RETRY_DELAYS_MS;
}

// ─── Given up: the owner hears of it ────────────────────────────────────────

const noticesFile = (env) => join(deliveryDir(env), 'notices.json');

/** The deliveries the runtime gave up on in the last day, newest first: what the runtime's page shows the owner. */
export function deliveryNotices(env, nowMs = Date.now()) {
  const l = readJson(noticesFile(env));
  return (Array.isArray(l) ? l : []).filter((n) => n && typeof n.text === 'string' && nowMs - Date.parse(n.at) < NOTICE_MS).slice(0, NOTICES_MAX);
}

const cap = (x) => String(x).charAt(0).toUpperCase() + String(x).slice(1);

/**
 * A delivery given up on: a `failed` note on its conversation in core (the agent's turn, its outcome failed; the reason
 * as its audit text) and a notice for the owner. Neither failing stops the other.
 */
async function giveUp(env, c, reason, tries, d) {
  const at = d.now().toISOString();
  const said = `couldn't start a body after ${tries} tries: ${reason}`;
  try {
    const { seq } = await d.core.turn({ agent: c.agent, venue: c.venue, place: c.place, at, from: { kind: 'agent', id: c.agent }, kind: 'note', run: newRun(), outcome: 'failed', ...(c.label !== undefined ? { label: c.label } : {}) });
    try { await d.core.audit({ conversation: c.conversation, seq, text: said }); } catch (e) { d.warn(`the failed note on ${c.conversation} stands without its reason: ${e.message}`); }
  } catch (e) { d.warn(`couldn't record the failed note on ${c.conversation}: ${e.message}`); }
  const notice = {
    text: `${cap(c.agent)}'s ${c.venue} ${c.place} couldn't start a body: ${reason}`.slice(0, 300),
    meta: `${tries} tries over ${Math.round(retryDelaysOf(env).reduce((a, b) => a + b, 0) / 60_000)} min · ${c.conversation}`,
    at, agent: c.agent, tone: 'warn', page: '',
  };
  locked(env, () => writeJson(noticesFile(env), [notice, ...deliveryNotices(env, d.now().getTime())].slice(0, NOTICES_MAX)));
  d.warn(`gave up on ${c.conversation}: ${said}`);
}

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
/** Which conversation a body's run key speaks in: its house's host keeps the key by it (bodyhost.mjs, keyFile). */
export const BODY_CONVERSATION = 'LOOM_BODY_CONVERSATION';

export function bodyEnvOf(env, { key, conversation } = {}) {
  const extra = new Set(String(setting(env, 'BODY_ENV') ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || NEVER.test(k)) continue;
    if (BODY_ENV.test(k) || extra.has(k)) out[k] = v;
  }
  // Its run's own key: `send` answers only the body holding its conversation's current one.
  if (key) out[BODY_KEY] = key;
  if (key && CV.test(conversation ?? '')) out[BODY_CONVERSATION] = conversation;
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
    sendMs: o.sendMs ?? SEND_MS,
    bodyEnv: (key, conversation) => bodyEnvOf(env, { key, conversation }),
    cwd: o.cwd ?? setting(env, 'BODY_CWD'),
    warn: o.warn ?? ((m) => process.stderr.write(`loom-runtime deliver: ${m}\n`)),
    // Who may do what (policy.mjs): the owner's policy and the gates, from the runtime's own store; a person's card,
    // from core's CLI; and the venue's adapter, through its declared send argv (describe, presence).
    policy: o.policy ?? ((agent) => policyOf(storeOf(env, o), agent).doc),
    gates: o.gates ?? ((agent) => cachedGates(env, o, agent)),
    card: o.card ?? ((slug) => personCard(env, slug)),
    adapter: o.adapter ?? ((argv, c, args) => adapterCall(argv, c, args, o.adapterMs ?? ADAPTER_MS)),
  };
}

let store;
const storeOf = (env, o) => o.store ?? (store ??= loomStore(env));
const gatesCache = new Map();
function cachedGates(env, o, agent) {
  const hit = gatesCache.get(agent);
  if (hit && Date.now() - hit.at < GATES_MS) return hit.doc;
  const doc = gatesOf(storeOf(env, o), agent).doc;
  if (!doc || typeof doc !== 'object') throw new DeliveryError(`the runtime holds no gates for ${agent}`, 503);
  gatesCache.set(agent, { at: Date.now(), doc });
  return doc;
}

/** A person's card as loom renders it (`loom person show <slug>`), or null: none, archived, or loom can't say. */
function personCard(env, slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug ?? '')) return null;
  const { LOOM_STORE_GRANT: _g, ...clean } = env;
  const r = spawnSync(env.LOOM_BIN || 'loom', ['person', 'show', slug], { env: clean, encoding: 'utf-8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
  const t = (r.stdout ?? '').trim();
  return r.status === 0 && t.startsWith('## ') ? t.slice(0, 8000) : null;
}

/**
 * One call of a venue adapter's declared send argv that posts nothing (`--describe`, `--status …`): the argv, then
 * `--place <place> --agent <agent>`, then `args`, with nothing on stdin. Its answer, `{ok: true, …}`; anything else
 * throws, with the adapter's reason.
 */
function adapterCall(argv, c, args, ms) {
  return new Promise((resolve, reject) => {
    let out = '';
    let done = false;
    const finish = (f, v) => { if (!done) { done = true; clearTimeout(timer); f(v); } };
    let child;
    try { child = nodeSpawn(argv[0], [...argv.slice(1), '--place', c.place, '--agent', c.agent, ...args], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(reject, new Error(`no answer in ${ms / 1000}s`)); }, ms);
    child.on('error', (e) => finish(reject, e));
    child.stdout.on('data', (x) => { if (out.length < 256 * 1024) out += x; });
    child.on('close', (status) => {
      let a;
      try { a = JSON.parse(out.trim().split('\n').pop()); } catch { return finish(reject, new Error(`it answered no JSON (exit ${status})`)); }
      if (a?.ok === true) return finish(resolve, a);
      finish(reject, new Error(typeof a?.reason === 'string' ? a.reason.slice(0, 300) : `it said no (exit ${status})`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end('');
  });
}

// ─── The deliver body ───────────────────────────────────────────────────────

/**
 * A scheduled venue with no send (core's own `wake`): there's nowhere to post, and the body's message is its run's
 * reply all the same. It's recorded (the agent's `reply` turn, answered, and its text in the audit log) and posted
 * nowhere, so a scheduled run has the agent turn its measures read (conversations.md, "What each kind is measured on").
 */
export const recordsOnly = (v) => !v?.send && !v?.orphaned && v?.kind === 'scheduled';

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
  // Who a person is, against the gates, is t-1746's; one without a slug is malformed now.
  if (raw.from.kind === 'person' && !(typeof raw.from.slug === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(raw.from.slug) && raw.from.slug.length <= 80)) fail('from {kind: person} names its slug');
  if (raw.from.kind === 'agent' && !AGENT_NAME.test(raw.from.id ?? '')) fail('from {kind: agent} names its id');
  if (!KINDS.includes(raw.kind)) fail(`kind is ${KINDS.join(', ')}`);
  if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) fail('at is an ISO-8601 time');
  if (!str(raw.text, MAX_TEXT)) fail(`text is 1-${MAX_TEXT} characters`);
  if (!PIECE.test(raw.source ?? '')) fail('source is the calling piece, as core forwards it');
  return { ...raw };
}

/** Its turn's idempotency key in core: `<source>:<id>` (loom: conversations/turn `key`). */
export const turnKey = (m) => `${m.source}:${m.id}`;

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

async function deliverOnce(env, raw, o) {
  const d = depsOf(env, o);
  let m;
  try { m = parseDelivery(raw); } catch (e) { return { status: e.status ?? 400, error: e.message }; }
  const key = deliveryKey(m);
  const now = () => d.now().getTime();

  // Once: the same (source, id) within 24 hours answers what the first call answered, and writes nothing; the same
  // (source, id) with a different message is refused (409). A call that wrote its turn and then died left the turn's
  // seq here: its retry carries on from that turn. One still being made answers 503: retry shortly.
  const hash = createHash('sha256').update(JSON.stringify(m)).digest('hex');
  const first = locked(env, () => {
    const s = readJson(seenFile(env, key));
    const recent = s && now() - s.at < DAY_MS;
    if (recent && s.hash && s.hash !== hash) return { other: true };
    const live = recent && alive(s.pid) && (s.pid !== process.pid || inFlight.has(key));
    if (recent && (s.answer || live)) return { wait: s };
    writeJson(seenFile(env, key), { at: now(), pid: process.pid, hash, ...(recent && s.turn ? { turn: s.turn } : {}) });
    return { resume: recent && s.turn ? s.turn : null };
  });
  if (first.other) return { status: 409, error: `${m.source}'s message ${m.id} was delivered already, as another message` };
  if (first.wait) {
    if (first.wait.answer) return first.wait.answer;
    return { status: 503, error: 'the same delivery is still being made: retry in a few seconds', retryAfter: 2 };
  }
  inFlight.add(key);
  try {
    const settle = (answer) => { locked(env, () => writeJson(seenFile(env, key), { at: now(), hash, answer })); return answer; };

    // 1. The turn, first; a body sees nothing that isn't recorded.
    let turn = first.resume;
    if (!turn) {
      try {
        // Its idempotency key (source:id): the same key and turn answer the first write's {conversation, seq}, so a
        // retry after a lost answer writes nothing new; the same key with another turn is refused (409). Needs a core
        // with turn keys: an older one refuses the unknown key (400), and so does this, whole.
        turn = await d.core.turn({ key: turnKey(m), agent: m.agent, venue: m.venue, place: m.place, at: m.at, from: m.from, kind: m.kind, ...(m.label !== undefined ? { label: m.label } : {}) });
      } catch (e) {
        const definite = e instanceof CoreError && e.status < 500;
        // Refused (4xx, a 409 among them: never a match): nothing of it is this delivery's. Anything else (core down,
        // a timeout) may have landed: either way nothing's kept here, and a retry posts the same turn with the same
        // key, so core answers the first write's {conversation, seq} if it did land (loom#426).
        locked(env, () => rmSync(seenFile(env, key), { force: true }));
        if (definite && e.status === 409) return { status: 409, error: `core refused the turn: its key ${turnKey(m)} is another turn's (${e.message})` };
        return { status: definite ? e.status : 503, error: e.message };
      }
      if (!CV.test(turn?.conversation ?? '') || !Number.isSafeInteger(turn?.seq) || turn.seq < 1) {
        return { status: 503, error: 'core answered the turn write with something that isn\'t a conversation id and seq' };
      }
    }
    // On record at once: a crash from here on, and the retry uses this turn.
    locked(env, () => writeJson(seenFile(env, key), { at: now(), pid: process.pid, hash, turn: { conversation: turn.conversation, seq: turn.seq } }));
    o.afterTurn?.();
    // Its text, for review. A failed audit write leaves the turn standing without it (conversations.md); a retry's
    // second one is refused by core (409), which is fine.
    try { await d.core.audit({ conversation: turn.conversation, seq: turn.seq, text: m.text }); } catch (e) { if (e?.status !== 409) d.warn(`the turn stands without its audit text: ${e.message}`); }

    // 2. The body. The message joins its conversation's queue (sealed; without age, only in memory, on its way to
    // the worker), and the queue is drained: from a detached worker (the CLI), or here; never waited on past 2 s.
    // Its sender's tier, by the runtime's gates, now: what decides whether a body that isn't a guest venue's may hear
    // it (plan). A person whose tier can't be read waits for a body that resolves it at its start.
    let tier = null;
    let tierUnread = false;
    if (m.from.kind === 'person') { try { tier = tierOf(d.gates(m.agent), m.from); } catch { tierUnread = true; } }
    let sealed = null;
    try { sealed = d.sealer.seal(Buffer.from(m.text, 'utf-8')).toString('base64'); } catch (e) { d.warn(`can't seal the message (${e.message}): it goes to the body from memory, and can't wait`); }
    const venueInfo = await venueOf(d, m.venue);
    let kind;
    try { kind = kindOf(m.venue, venueInfo?.kind); } catch { kind = 'live'; }
    locked(env, () => {
      const c = loadConv(env, turn.conversation) ?? { conversation: turn.conversation, agent: m.agent, venue: m.venue, place: m.place, kind, queue: [], outcomes: {}, runs: 0, started: d.now().toISOString() };
      if (m.label !== undefined) c.label = m.label;
      // A retry after a crash may find its message already queued (or already answered): never twice.
      if (!c.queue.some((x) => x.key === key) && !c.outcomes?.[key]) c.queue.push({ key, id: m.id, at: m.at, from: m.from, kind: m.kind, ...(tier ? { tier } : {}), ...(tierUnread ? { tierUnread: true } : {}), ...(sealed ? { sealed } : { mem: true }) });
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
const tierTag = (x) => (Number.isInteger(x.tier) ? ` [tier ${x.tier}]` : '');
const render = (msgs) => msgs.map((x) => (x.kind === 'wake' ? x.text : `${who(x.from)}${tierTag(x)}: ${x.text}`)).join('\n\n');

/**
 * The brief a new body starts with: where it is, its conversation and run (for identity), its rules (policy.mjs: who
 * wrote, the owner, a guest venue's floor and cards, the agent's own files), and the messages. Text, or parts when
 * its rules name the agent's files (briefs.mjs).
 */
function startBrief(c, msgs, run, sends, rules = { sections: [] }) {
  const how = sends === 'record'
    ? `When you're done, pipe a short account of what you did to \`loom runtime send --conversation ${c.conversation}\`: on ${c.venue} nothing is posted; it's recorded as this run's reply.`
    : `To say something there, pipe it to \`loom runtime send --conversation ${c.conversation}\`; it answers {ok, id?} and, when it couldn't post, why.`;
  const relay = `To message one person directly instead (one DM, posted as you, in a venue that has DMs), add \`--person <their slug> --via <venue>\`${rules.guest ? ': from a guest venue, only to your owner' : ''}.`;
  const head = [
    `You are ${c.agent}, in a conversation on ${c.venue}: ${c.label ?? c.place}.`,
    `Its conversation is ${c.conversation} and this run is ${run}: call identity with {conversation: "${c.conversation}", run: "${run}"} first.`,
    ...(c.runs > 0 ? [`It has history this session doesn't: read it with conversation({id: "${c.conversation}"}) (its digests) before you answer.`] : []),
    ...(sends ? [how] : []),
    ...(sends === 'post' ? [relay] : []),
  ].join('\n');
  const tail = `\n${render(msgs)}`;
  if (!rules.sections.length) return `${head}\n${tail}`;
  const parts = [{ text: `${head}\n` }, ...rules.sections, { text: tail }];
  // Only the agent's own files need the repo; with none, it's one text, as it always was.
  return namesFiles(parts) ? parts : parts.map((p) => p.text).join('');
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
    // A guest's message never reaches a body that isn't a guest venue's (its tools aren't narrowed, its brief has no
    // floor): that body is ended, its session not kept, and a body under a guest venue's rules starts for it.
    if (!c.bodyRules?.guest && c.queue.some((x) => x.tier === 1)) return begin({ type: 'reseat', body: c.body });
    // Mid-turn: into its inbox, where its harness hears it (shuttle's hand_over).
    const rec = readBody(env, c.body);
    const runner = d.runner(rec.harness);
    const left = [];
    for (const x of c.queue) {
      if (x.tierUnread && !c.bodyRules?.guest) { left.push({ x, reason: 'its sender\'s tier couldn\'t be read' }); continue; }
      const text = open(d, x, mem);
      const r = text === null ? { fed: false, reason: 'its text is gone' } : runner.feed(bodyOf(c.body, rec), { id: x.key, text: render([{ ...x, text }]) });
      // The runtime's own copy of what it fed (sealed): the inbox's files are the body's to write, so they only ever
      // say which ids it never took, never what they said (shuttle's drop_inner).
      if (r.fed) { outcome(c, [x.key], { body: 'fed' }, now); if (x.sealed) (c.fed ??= []).push(x); ack(c, [x]); } else left.push({ x, reason: r.reason });
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
  // A start that failed is tried again at its time, on the tick: until then it waits (what it was told stands).
  if (c.retryAt && now < c.retryAt) return null;
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
    if (!op) break;
    await execute(env, op, d, mem);
  }
  await announce(env, cv, d);
}

// ─── Rules, presence and the stop word ──────────────────────────────────────

/** What policy.mjs's rulesFor reads, for one conversation in its venue. */
const rulesDeps = (d, v, c) => ({
  policy: d.policy, gates: d.gates, card: d.card,
  describe: () => (v?.send ? d.adapter(v.send, c, ['--describe']) : {}),
});

/** Messages that reached a body: the adapter is told, on the drain's way out (announce). */
function ack(c, msgs) {
  const ids = msgs.filter((x) => x.kind === 'message' && typeof x.id === 'string').map((x) => x.id);
  if (ids.length) c.acks = [...new Set([...(c.acks ?? []), ...ids])].slice(-20);
}

/**
 * The adapter hears which messages a body has taken (`--status working --message <id>…`): its "on it" (typing, 👀)
 * starts there. Best effort: a venue that can't show it is told nothing more, and nothing waits on it.
 */
async function announce(env, cv, d) {
  const c = loadConv(env, cv);
  if (!c?.acks?.length) return;
  const ids = c.acks;
  const v = await venueOf(d, c.venue);
  if (v?.send) {
    try { await d.adapter(v.send, c, ['--status', 'working', ...ids.flatMap((i) => ['--message', i])]); } catch (e) { d.warn(`${c.venue} couldn't show ${cv}'s body at work: ${e.message}`); }
  }
  const now = d.now().getTime();
  locked(env, () => {
    const x = loadConv(env, cv);
    if (!x) return;
    x.acks = (x.acks ?? []).filter((i) => !ids.includes(i));
    if (!x.acks.length) delete x.acks;
    if (v?.send) x.presence = { since: x.presence?.since ?? now, last: now };
    saveConv(env, x);
  });
}

/**
 * The tick's presence pass, for a conversation the adapter was told is worked on: said again while its body works
 * (the answer may carry the stop word), `done` once it doesn't. A stop ends the body (its session kept in its slot,
 * as any end) and drops what waited.
 */
async function presencePass(env, c, d, now) {
  const v = await venueOf(d, c.venue);
  if (!v?.send) { locked(env, () => { const x = loadConv(env, c.conversation); if (x) { delete x.presence; saveConv(env, x); } }); return; }
  const working = isStarting(c, now) || statusOf(env, c, d) === 'working';
  if (working) {
    if (now - (c.presence.last ?? 0) < PRESENCE_MS) return;
    let a = null;
    try { a = await d.adapter(v.send, c, ['--status', 'working']); } catch (e) { d.warn(`${c.venue} couldn't show ${c.conversation}'s body at work: ${e.message}`); }
    if (a?.stop === true && c.body && !isStarting(c, now)) return stopBody(env, c, d, v);
    locked(env, () => { const x = loadConv(env, c.conversation); if (x?.presence) { x.presence.last = now; saveConv(env, x); } });
    return;
  }
  try { await d.adapter(v.send, c, ['--status', 'done']); } catch (e) { d.warn(`${c.venue} couldn't clear ${c.conversation}'s presence: ${e.message}`); }
  locked(env, () => { const x = loadConv(env, c.conversation); if (x) { delete x.presence; saveConv(env, x); } });
}

/** A person said the stop word where this body works: it's ended (a slot kept), and nothing that waited goes on. */
async function stopBody(env, c, d, v) {
  const now = d.now().getTime();
  const op = locked(env, () => {
    const x = loadConv(env, c.conversation);
    if (!x?.body || x.starting) return null;
    outcome(x, (x.queue ?? []).map((q) => q.key), { body: 'failed', reason: 'stopped: a person said the stop word there' }, now);
    x.queue = [];
    delete x.waiting;
    x.starting = mark(now);
    saveConv(env, x);
    return { cv: x.conversation, mark: x.starting.op, type: 'evict', body: x.body };
  });
  if (!op) return;
  await execute(env, op, d, new Map());
  // What its inbox held when it stopped isn't asked for any more either.
  locked(env, () => { const x = loadConv(env, c.conversation); if (x) { x.queue = []; delete x.presence; delete x.acks; saveConv(env, x); } });
  d.warn(`${c.conversation}: stopped by the stop word`);
  try { await d.adapter(v.send, c, ['--status', 'done']); } catch { /* best effort */ }
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
      if (saved.slot) c.slot = { ...saved.slot, rules: c.bodyRules ?? { guest: false } }; else delete c.slot;
      requeue(c, [...saved.pending, ...op.msgs]);
      if (ours(c, op)) delete c.starting;
      saveConv(env, c);
    });
    return;
  }
  if (op.type === 'reseat') {
    // A body whose rules aren't what its next message needs (a guest's, to a body that isn't a guest venue's): ended,
    // its session not kept (no slot), what its inbox held back on the queue, and the next plan starts a fresh one.
    let saved = { slot: null, pending: [] };
    try { saved = await retire(env, op.cv, op.body, d, true); } catch (e) { d.warn(`ending ${op.body}: ${e.message}`); }
    locked(env, () => {
      rmSync(slotFile(env, op.cv), { force: true });
      const c = loadConv(env, op.cv);
      if (!c) return;
      if (c.body === op.body) { c.body = undefined; c.idleSince = undefined; delete c.bodyRules; }
      delete c.slot;
      if (ours(c, op)) delete c.starting;
      requeue(c, saved.pending);
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
      if (saved.slot) c.slot = { ...saved.slot, rules: c.bodyRules ?? { guest: false } }; else if (c.body === undefined) delete c.slot;
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
  let rules;
  try {
    const msgs = op.msgs.map((x) => ({ ...x, text: open(d, x, mem) })).filter((x) => x.text !== null);
    if (!msgs.length) throw new DeliveryError('its messages\' text is gone');
    const v0 = await venueOf(d, c0.venue);
    const sends = v0?.send ? 'post' : recordsOnly(v0) ? 'record' : null;
    // Its rules (policy.mjs): what it's told and what it may use. Any that can't be had is no body (fail closed).
    rules = await rulesFor(c0, msgs, rulesDeps(d, v0, c0), { platform: !!v0?.send });
    if (op.type === 'resume' && (op.slot?.rules?.guest ?? false) !== rules.guest) {
      // A session is resumed only under the rules it began with: a guest venue's never as anyone else's, nor the other
      // way. Its slot goes, and its messages go back for a fresh body, in this same drain.
      locked(env, () => {
        rmSync(slotFile(env, op.cv), { force: true });
        const c = loadConv(env, op.cv);
        if (!c) return;
        delete c.slot;
        if (ours(c, op)) delete c.starting;
        requeue(c, op.msgs);
        saveConv(env, c);
      });
      return;
    }
    const runKey = randomBytes(24).toString('hex');
    const bodyDeps = { runner: d.runner, accounts: d.accounts, now: d.now, fetchImpl: d.fetchImpl, bodyEnv: d.bodyEnv(runKey, op.cv) };
    const base = { agent: c0.agent, venue: c0.venue, venueKind: c0.kind, cwd: d.cwd, deny: rules.deny, guest: rules.guest };
    if (op.type === 'start') {
      r = await startBody(env, { ...base, place: c0.place, brief: startBrief(c0, msgs, run, sends, rules) }, bodyDeps);
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
      c.bodyRules = { guest: rules.guest, key: rules.key };
      ack(c, op.msgs);
      delete c.retryAt; delete c.startFails; delete c.retryReason;
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
    if (!keep) endAndForget(env, r.body, d);
  } catch (e) {
    for (const p of restored) rmSync(p, { recursive: true, force: true });
    let gaveUp = null;
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
        // A body that fails to start: the turn stands, and the runtime tries again on its tick, after a wait that
        // grows. Only a message it keeps sealed can wait; one it can't (no age) is failed now.
        const reason = String(e.message).split('\n')[0].slice(0, 300);
        const delays = retryDelaysOf(env);
        const tries = (c.startFails ?? 0) + 1;
        const keep = op.msgs.filter((x) => x.sealed);
        const lost = op.msgs.filter((x) => !x.sealed).map((x) => x.key);
        if (lost.length) outcome(c, lost, { body: 'failed', reason: `${reason}, and the runtime can't keep its text to try again (no age)` }, now());
        if (keep.length && tries <= delays.length) {
          c.startFails = tries;
          c.retryAt = now() + delays[tries - 1];
          c.retryReason = reason;
          requeue(c, keep);
          outcome(c, keep.map((x) => x.key), { body: 'queued', reason: `no body could start (${reason}): trying again in ${Math.round(delays[tries - 1] / 1000)} s` }, now());
        } else if (keep.length) {
          outcome(c, keep.map((x) => x.key), { body: 'failed', reason }, now());
          delete c.retryAt; delete c.startFails; delete c.retryReason;
          gaveUp = { c: { ...c }, reason, tries };
        }
      }
      saveConv(env, c);
    });
    if (gaveUp) await giveUp(env, gaveUp.c, gaveUp.reason, gaveUp.tries, d);
  }
}

/**
 * A body ended with nothing kept: stopped, and its harness's session files deleted (in its house, the host does that
 * on a plain stop). Every end either packs into a slot (retire) or comes here: none leaves a transcript behind.
 */
function endAndForget(env, ref, d) {
  try {
    const rec = readBody(env, ref);
    const runner = d.runner(rec.harness);
    const body = bodyOf(ref, rec);
    const slot = (() => { try { return runner.slotOf(body) ?? rec.slot; } catch { return rec.slot; } })();
    endBody(env, ref, { runner: d.runner, now: d.now, bodyEnv: d.bodyEnv() });
    if (!runner.remote) dropSession(runner, slot, body);
  } catch (e) { d.warn(`ending ${ref}: ${e.message}`); }
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
  // Transfers from houses nobody will finish or collect (houserunner.mjs, sweepTransfers).
  try { sweepTransfers(env, now, Date.now()); } catch (e) { d.warn(`sweeping transfers: ${e.message}`); }
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
  for (const c of listConvs(env)) if (c.presence) { try { await presencePass(env, c, d, now); } catch (e) { d.warn(`presence for ${c.conversation}: ${e.message}`); } }
  for (const c of listConvs(env)) if (c.queue?.length) await drain(env, c.conversation, d);
}

// ─── Outbound ───────────────────────────────────────────────────────────────

/**
 * One run of a venue's send, with the full time it has (15 s): {ok, id?}; {ok: false, answered: true, reason} when the
 * adapter said no; {ok: false, answered: false, reason} when it didn't say (a timeout, a crash, no JSON), which may
 * have posted all the same.
 */
function sendOnce(d, argv, c, text) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try { child = nodeSpawn(argv[0], [...argv.slice(1), '--place', c.place, '--agent', c.agent], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) { return finish({ ok: false, answered: false, reason: e.message }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, answered: false, reason: `no answer in ${d.sendMs / 1000}s` }); }, d.sendMs);
    child.on('error', (e) => finish({ ok: false, answered: false, reason: e.message }));
    child.stdout.on('data', (x) => { if (out.length < 1024 * 1024) out += x; });
    child.on('close', (status) => {
      let a;
      try { a = JSON.parse(out.trim().split('\n').pop()); } catch { return finish({ ok: false, answered: false, reason: `its send answered no JSON (exit ${status})` }); }
      if (a?.ok === true) return finish({ ok: true, ...(typeof a.id === 'string' && a.id.length <= 200 ? { id: a.id } : {}) });
      finish({ ok: false, answered: true, reason: typeof a?.reason === 'string' ? a.reason.slice(0, 300) : `its send said no (exit ${status})` });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

/**
 * An agent's message out, in its conversation's venue. Checked, then accepted at once ({accepted, ref}): the post runs
 * with its full 15 s outside the body's own call, from a detached worker (the piece API) or here (`o.onSend` gets it).
 * Errors before acceptance are {ok: false, reason}. `o.caller`: who's asking: an agent speaks only in its own
 * conversations, and only the body holding it, in its current run (LOOM_BODY_KEY).
 */
/** A harness session id, as `send` carries it (the harness's own, per session: CLAUDE_CODE_SESSION_ID). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/;

/**
 * The harness session of the body holding a conversation now, as its runner sees it (in a house, its host's report),
 * or null when its runner can't say. A body's key alone isn't enough in a house: each conversation's key is a file
 * there (bodyhost.mjs), so a sibling body of the same agent could read it; its session is its own.
 */
function sessionOf(d, ref) {
  try {
    const rec = readBody(d.env, ref);
    const s = d.runner(rec.harness).slotOf(bodyOf(ref, rec))?.session ?? rec.slot?.session;
    return typeof s === 'string' && SESSION_ID.test(s) ? s : null;
  } catch { return null; }
}

export async function send(env, { conversation, text, key, session, person, via }, o = {}) {
  const d = depsOf(env, o);
  const c = loadConv(env, conversation);
  if (!c) return { ok: false, reason: `no conversation ${conversation} here` };
  if (o.caller && (o.caller.kind !== 'agent' || o.caller.agent !== c.agent)) return { ok: false, reason: `only ${c.agent}'s own body speaks in ${conversation}` };
  const want = typeof c.sendKey === 'string' && /^[0-9a-f]{64}$/.test(c.sendKey) ? Buffer.from(c.sendKey, 'hex') : null;
  if (!want || !c.body || typeof key !== 'string' || !key || !timingSafeEqual(keyHash(key), want)) {
    return { ok: false, reason: `only the body holding ${conversation} speaks in it (its run's ${BODY_KEY} doesn't match)` };
  }
  // Its harness session too, where the runner knows the body's: a sibling body holding this conversation's key (its
  // house's file) is another session. A sender that names no session is refused once the body's is known.
  const own = sessionOf({ ...d, env }, c.body);
  if (own && session !== own) {
    return { ok: false, reason: `only the body holding ${conversation} speaks in it (${session ? 'another session is' : 'no session is named'}: ${conversation} is a session of its own)` };
  }
  if (!str(text, MAX_TEXT)) return { ok: false, reason: `a message is 1-${MAX_TEXT} characters` };
  // To a person (a DM), not the conversation's own place: the relay to a person, through that venue's adapter.
  let to;
  if (person !== undefined || via !== undefined) {
    const r = await dmPlace(env, c, { person, via, text }, d);
    if (!r.ok) return r;
    to = r.to;
  } else {
    const v = await venueOf(d, c.venue);
    if (!v?.send && !recordsOnly(v)) return { ok: false, reason: `venue ${c.venue} declares no send: nothing posts there` };
  }
  const ref = `out-${randomBytes(6).toString('hex')}`;
  const out = { body: c.body, run: c.run, ...(to ? { to } : {}) };
  if (o.detach) (o.spawnSender ?? ((...a) => spawnSender(env, ...a)))(conversation, ref, text, out);
  else { const p = post(env, conversation, ref, text, out, o).catch((e) => d.warn(`posting ${ref}: ${e.message}`)); o.onSend?.(p); }
  return { accepted: true, ref, conversation: c.conversation };
}

/** A platform id from a gate entry's ids for a venue: a list, one id, or (Slack) {team: [ids]}; the first. */
function firstId(v) {
  const one = (x) => ((typeof x === 'string' || typeof x === 'number') && /^[A-Za-z0-9]{1,24}$/.test(String(x)) ? String(x) : null);
  if (Array.isArray(v)) return v.map(one).find(Boolean) ?? null;
  if (v && typeof v === 'object') return Object.values(v).map(firstId).find(Boolean) ?? null;
  return one(v);
}

/**
 * Where a message to a person goes: their DM place on `via` (`dm:<their id there>`, by the agent's gates), checked.
 * Only a person at tier 2 or up (from a guest venue's body, only the owner, tier 3); the same words to the same
 * person from one conversation once in 10 minutes. {ok, to: {venue, place, label}} | {ok: false, reason}.
 */
async function dmPlace(env, c, { person, via, text }, d) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(person ?? '') || !VENUE.test(via ?? '')) return { ok: false, reason: 'a message to a person names --person <their slug> and --via <venue>' };
  const v = await venueOf(d, via);
  if (!v?.send) return { ok: false, reason: `venue ${via} declares no send: nothing posts there` };
  let gates;
  try { gates = d.gates(c.agent); } catch (e) { return { ok: false, reason: `${c.agent}'s gates can't be read (${e.message}): no DM goes out` }; }
  const tier = tierOf(gates, { kind: 'person', slug: person });
  if (!tier || tier < 2) return { ok: false, reason: `${person} isn't in ${c.agent}'s gates at tier 2 or up: no DM goes to them` };
  if (c.bodyRules?.guest && tier !== 3) return { ok: false, reason: 'from a guest venue, a DM goes only to your owner (tier 3)' };
  const e = gates.people[person];
  const id = firstId(e?.[via]);
  if (!id) return { ok: false, reason: `${person} has no ${via} id in ${c.agent}'s gates` };
  const h = createHash('sha256').update(`${person}\0${via}\0${text}`).digest('hex').slice(0, 16);
  const now = d.now().getTime();
  const dup = locked(env, () => {
    const x = loadConv(env, c.conversation);
    if (!x) return true;
    x.relays = (x.relays ?? []).filter((r) => now - r.at < RELAY_SAME_MS);
    if (x.relays.some((r) => r.h === h)) return true;
    x.relays.push({ h, at: now });
    saveConv(env, x);
    return false;
  });
  if (dup) return { ok: false, reason: `the same words went to ${person} on ${via} already: once is enough` };
  const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim().slice(0, 60) : person;
  return { ok: true, to: { venue: via, place: `dm:${id}`, label: `DM with ${name}` } };
}

/** A post's other place (a DM), as the detached sender is handed it: checked again. */
const cleanTo = (t) => (t && VENUE.test(t.venue ?? '') && typeof t.place === 'string' && /^dm:[A-Za-z0-9]{1,24}$/.test(t.place) ? { venue: t.venue, place: t.place, ...(str(t.label, MAX_LABEL) ? { label: t.label } : {}) } : null);

/** `loom-runtime deliver post --conversation <cv> --ref <ref> --stdin`: the post, detached; its text on stdin, never a file. */
function spawnSender(env, cv, ref, text, out) {
  if (!CV.test(cv) || !/^out-[0-9a-f]{12}$/.test(ref)) fail('not a post', 500);
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
  mkdirSync(deliveryDir(env), { recursive: true, mode: 0o700 });
  const log = openSync(join(deliveryDir(env), 'worker.log'), 'a', 0o600);
  const child = nodeSpawn(process.execPath, [cli, 'deliver', 'post', '--conversation', cv, '--ref', ref, '--stdin'], { env, detached: true, stdio: ['pipe', log, log] });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ text, ...out }));
  child.unref();
}

/**
 * The post itself: the venue's send, retried once only when the adapter answered no (a timed-out post may have
 * landed, so it's never posted twice), then the agent's turn (`reply`, answered or failed) and its text; a failure is
 * told to the body that sent it, through its inbox (or, its turn over, as a message waiting for its next one).
 */
export async function post(env, conversation, ref, text, { body, run, to } = {}, o = {}) {
  const d = depsOf(env, o);
  const c = loadConv(env, conversation);
  if (!c) return { ok: false, reason: `no conversation ${conversation} here` };
  // Where it goes: the conversation's own place, or a person's DM (dmPlace), whose turn is that DM's conversation's.
  const dm = to === undefined ? null : cleanTo(to);
  if (to !== undefined && !dm) return { ok: false, reason: 'not a DM place' };
  const at = dm ? { agent: c.agent, venue: dm.venue, place: dm.place, label: dm.label } : c;
  const v = await venueOf(d, at.venue);
  // A scheduled venue with no send (a wake) posts nowhere: its message is only recorded.
  let r = v?.send ? await sendOnce(d, v.send, at, text) : !dm && recordsOnly(v) ? { ok: true, recorded: true } : { ok: false, answered: true, reason: `venue ${at.venue} declares no send` };
  if (!r.ok && r.answered && v?.send) r = await sendOnce(d, v.send, at, text);
  let rec = null;
  try { rec = body ? readBody(env, body) : null; } catch { /* its body is gone: the turn says no model */ }
  const turn = {
    agent: c.agent, venue: at.venue, place: at.place, ...(dm?.label ? { label: dm.label } : {}), at: d.now().toISOString(), from: { kind: 'agent', id: c.agent }, kind: 'reply',
    run: run ?? c.run ?? newRun(), ...(rec?.model ? { model: rec.model } : {}), ...(rec?.harness ? { harness: rec.harness } : {}), outcome: r.ok ? 'answered' : 'failed',
  };
  try {
    const t = await d.core.turn(turn);
    try { await d.core.audit({ conversation: t.conversation, seq: t.seq, text }); } catch (e) { d.warn(`the reply's turn stands without its audit text: ${e.message}`); }
  } catch (e) { d.warn(`${ref} went out but its turn wasn't recorded: ${e.message}`); }
  if (!r.ok) tellBody(env, conversation, body, `(couldn't post your message ${ref} in ${dm ? `${dm.venue} ${dm.label ?? dm.place}` : c.venue}: ${r.reason})`, d);
  locked(env, () => { const x = loadConv(env, conversation); if (x) { x.last = d.now().toISOString(); saveConv(env, x); } });
  return { ...r, ref };
}

/** A note for the body that sent something: into its inbox mid-turn, else waiting for its conversation's next body. */
function tellBody(env, cv, ref, text, d) {
  const id = `note-${randomBytes(6).toString('hex')}`;
  try {
    const rec = ref ? readBody(env, ref) : null;
    if (rec && d.runner(rec.harness).feed(bodyOf(ref, rec), { id, text }).fed) return;
  } catch { /* not fed */ }
  try {
    const sealed = d.sealer.seal(Buffer.from(text, 'utf-8')).toString('base64');
    locked(env, () => { const c = loadConv(env, cv); if (c) { c.queue = [...(c.queue ?? []), { key: id, id, at: d.now().toISOString(), from: { kind: 'unknown' }, kind: 'message', sealed }]; saveConv(env, c); } });
  } catch (e) { d.warn(`couldn't tell ${ref} of a failed post: ${e.message}`); }
}
