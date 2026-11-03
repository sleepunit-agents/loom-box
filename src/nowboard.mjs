// The now board (loom docs/specs/agent-runtime.md, "The sources": "The now board (live state: who's talking, who's
// waiting) is the runtime's own state, shown on its page"; t-1731). It was an agent-specific piece outside loom's
// catalog (loom-now, in Art's repo) and the bridges' tile, asks and doing in shuttle's manifest; both are here now.
//
// The inbox, for a bridge in a house (shuttle's nowlog.py posts here with $SHUTTLE_NOW_REMOTE=runtime/now), through
// loom's piece API, as the bridge's own agent (or the owner, for the household's default agent):
//
//   POST /api/runtime/now/snapshot  {bridge, snap}   → <board>/<bridge>.json      (64 KB at most)
//   POST /api/runtime/now/event     {record}         → <board>/events-YYYY-MM.jsonl (16 KB at most)
//   POST /api/runtime/run {argv: ["now", "talking"]} → the caller's bridges: talking, waiting, how fresh
//
// Each agent has its own board, <LOOM_RUNTIME_NOW_DIR>/<agent>-now (default <data>/now): the layout loom-now kept, so
// what reads those files (shuttle's Bridges pages) reads the same ones. Files are 0600, a snapshot lands by rename.
// A board holds no message text: nowlog never writes any (its own tests pin it).
//
// What the runtime shows of it: on its page, the Now board (each agent's bridges, who they're talking with, what
// waits and why, and the model accounts' quota, the old status board's tiles); in its manifest, a bridge gone dark
// (an alert on loom's Inbox) and each agent's `doing` (its card on Home).
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, appendFileSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setting } from './piece.mjs';
import { AGENT_NAME } from './state.mjs';

const BRIDGE = /^[a-z][a-z0-9-]{0,30}$/;
export const SNAP_MAX = 64 * 1024;
export const EVENT_MAX = 16 * 1024;
/** A dark bridge's ask, at most this many; the doing rows on a card, at most this many. */
const ASKS_MAX = 10;
const DOING_MAX = 6;

export class NowError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const dataDir = (env) => env.LOOM_BOX_DATA || join(env.HOME || homedir(), '.local', 'share', 'loom-box');
export const nowBase = (env) => setting(env, 'NOW_DIR') || join(dataDir(env), 'now');
export const boardDir = (env, agent) => {
  if (!AGENT_NAME.test(agent ?? '')) throw new NowError('a board is an agent\'s', 400);
  return join(nowBase(env), `${agent}-now`);
};

function defaultAgent(env) {
  try {
    const h = JSON.parse(readFileSync(join(env.LOOM_HOME || join(env.HOME || homedir(), '.config', 'loom'), 'household.json'), 'utf-8'));
    return typeof h.default === 'string' && AGENT_NAME.test(h.default) ? h.default : undefined;
  } catch { return undefined; }
}

/**
 * Whose board a call reaches: an agent's own. A household owner's is the household's default agent's (loom-now's
 * "art"). An agent owner (an owner caller with an `agents` list, loom docs/specs/owners.md) reaches only an agent of
 * theirs, named as `agent`: never the default agent's or another member's.
 */
function boardOf(env, caller, want) {
  if (caller?.kind === 'agent' && AGENT_NAME.test(caller.agent ?? '')) return caller.agent;
  if (caller?.kind === 'owner' && Array.isArray(caller.agents)) {
    if (typeof want === 'string' && AGENT_NAME.test(want) && caller.agents.includes(want)) return want;
    throw new NowError('an agent owner reaches only their own agents\' boards: name one of them (agent)', 403);
  }
  if (caller?.kind === 'owner') {
    const a = defaultAgent(env);
    if (a) return a;
    throw new NowError('the household names no default agent, so the owner has no board to write', 409);
  }
  throw new NowError('the board is written by the owner and the agents\' bridges', 403);
}

function ensureDir(d) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function writePrivate(path, text) {
  const tmp = join(path, '..', `.${path.split('/').pop()}.${process.pid}.tmp`);
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Each bridge on a board: how many it's talking with, how many wait, and whether its snapshot is fresh. */
export function talking(dir, nowS = Date.now() / 1000) {
  const out = {};
  for (const b of bridgesOf(dir, nowS)) out[b.name] = { talking: b.talking.length, waiting: b.waiting.length, age_s: Math.round(nowS - b.at), fresh: !b.dark };
  return out;
}

/** The inbox's three calls. `path` is what follows /api/<runtime>/. */
export function inbox(env, caller, path, body, nowMs = Date.now()) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const dir = ensureDir(boardDir(env, boardOf(env, caller, b.agent)));
  if (path === 'now/snapshot') {
    if (!BRIDGE.test(b.bridge ?? '') || !b.snap || typeof b.snap !== 'object' || Array.isArray(b.snap)) throw new NowError('snapshot is {bridge, snap}: a plain bridge name and an object');
    const text = JSON.stringify(b.snap);
    if (Buffer.byteLength(text) > SNAP_MAX) throw new NowError('a snapshot is 64 KB at most', 413);
    writePrivate(join(dir, `${b.bridge}.json`), text);
    return { ok: true };
  }
  if (path === 'now/event') {
    const rec = b.record;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) || !BRIDGE.test(String(rec.bridge ?? ''))) throw new NowError('event is {record}, a record naming its bridge');
    const line = JSON.stringify(rec);
    if (Buffer.byteLength(line) > EVENT_MAX) throw new NowError('an event is 16 KB at most', 413);
    const t = typeof rec.t === 'number' && Number.isFinite(rec.t) ? rec.t * 1000 : nowMs;
    const d = new Date(t);
    const f = join(dir, `events-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`);
    const fd = openSync(f, 'a', 0o600);
    try { appendFileSync(fd, `${line}\n`); } finally { closeSync(fd); }
    return { ok: true };
  }
  throw new NowError('the board\'s calls are now/snapshot and now/event, and run: now talking', 404);
}

/** `loom runtime now talking` over the run path: the caller's own board. */
export function runNow(env, caller, argv) {
  if (argv.length !== 2 || argv[1] !== 'talking') return { exit: 2, stdout: '', stderr: 'the board\'s one read is: now talking\n' };
  let dir;
  try { dir = boardDir(env, boardOf(env, caller)); } catch (e) {
    if (e instanceof NowError) return { exit: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
  return { exit: 0, stdout: `${JSON.stringify(talking(dir))}\n`, stderr: '' };
}

// ─── Reading the boards ─────────────────────────────────────────────────────

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };

/** A board's bridges: each snapshot with its freshness (dark: older than three of its intervals, 30 s at least). */
export function bridgesOf(dir, nowS = Date.now() / 1000) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const snap = readJson(join(dir, n));
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) continue;
    const name = n.slice(0, -5);
    if (!BRIDGE.test(name) || name === 'convs') continue;
    const at = Number(snap.at) || 0;
    const every = Math.max(10, Number(snap.interval_s) || 10);
    out.push({
      name, at, dark: nowS - at > Math.max(30, 3 * every),
      talking: Array.isArray(snap.talking) ? snap.talking : [], waiting: Array.isArray(snap.waiting) ? snap.waiting : [],
      slots: snap.slots && typeof snap.slots === 'object' ? snap.slots : null, socket: snap.socket && typeof snap.socket === 'object' ? snap.socket : null,
    });
  }
  return out;
}

/** Every agent's board under the base: {agent: [bridge…]}, the agents whose board has a bridge. */
export function boards(env, nowS = Date.now() / 1000) {
  let names = [];
  try { names = readdirSync(nowBase(env)); } catch { return {}; }
  const out = {};
  for (const n of names.sort()) {
    const m = /^([a-z][a-z0-9-]{0,39})-now$/.exec(n);
    if (!m) continue;
    const bs = bridgesOf(join(nowBase(env), n), nowS);
    if (bs.length) out[m[1]] = bs;
  }
  return out;
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const clock = (s) => new Date(s * 1000).toISOString().slice(11, 16) + ' UTC';
function ago(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
/** Who a talking or waiting row is with, without anything a message said: its name, else its place. */
const withWhom = (t) => {
  const w = Array.isArray(t?.who) ? t.who.filter((x) => typeof x === 'string').join(', ') : t?.who;
  return String(w || t?.chan || 'someone').slice(0, 80);
};
const why = (w) => String(w?.why ?? w?.reason ?? w?.hold ?? '').slice(0, 80);

/** The manifest's part: a dark bridge's alert, and each agent's doing (its card on Home). */
export function nowManifest(env, nowS = Date.now() / 1000) {
  const all = boards(env, nowS);
  const asks = [];
  const agents = {};
  for (const [agent, bs] of Object.entries(all)) {
    for (const b of bs.filter((x) => x.dark)) {
      asks.push({ text: `${cap(agent)}'s ${b.name} bridge is dark since ${clock(b.at)}`, meta: `no word from it for ${ago(nowS - b.at)}`,
        // Something wrong to look at, not a choice (loom's Inbox files it under Alerts, not Decisions).
        page: 'now', label: 'Look', kind: 'alert', agent });
    }
    // Each conversation one of its bodies is in, simply (as shuttle's card said it): who or where, and how lately.
    const doing = bs.filter((b) => !b.dark).flatMap((b) => b.talking.map((t) => {
      const who = Array.isArray(t.who) ? t.who.filter((x) => typeof x === 'string') : [];
      const venue = typeof t.venue === 'string' ? t.venue.slice(0, 40) : '';
      const dm = /\bdm\b/i.test(venue);
      const since = Number(t.body_since);
      return {
        text: (dm && who.length ? `Talking with ${who.join(', ')}` : venue ? `Talking in ${venue}` : 'A conversation').slice(0, 100), kind: 'talk',
        where: [`${cap(b.name)}${dm ? ` ${venue}` : ''}`, `active ${ago(Number(t.active_s) || 0)} ago`, ...(t.stalled ? ['stalled'] : [])].join(' · '),
        ...(Number.isFinite(since) && since > 0 ? { since: new Date(since * 1000).toISOString() } : {}),
      };
    }));
    if (doing.length) agents[agent] = doing.slice(0, DOING_MAX);
  }
  return { asks: asks.slice(0, ASKS_MAX), agents };
}

/** The Now page: the old status board's tiles (bridges, talking, waiting, quota), then each agent's board. */
export function nowPage(env, { usage = [], nowS = Date.now() / 1000 } = {}) {
  const all = boards(env, nowS);
  const flat = Object.values(all).flat();
  const live = flat.filter((b) => !b.dark);
  const sections = [];
  const stats = [
    { label: 'Bridges', value: `${live.length} live`, ...(flat.length > live.length ? { detail: `${flat.length - live.length} dark`, tone: 'bad' } : { tone: 'ok' }) },
    { label: 'Talking', value: String(live.reduce((n, b) => n + b.talking.length, 0)) },
    { label: 'Waiting', value: String(live.reduce((n, b) => n + b.waiting.length, 0)) },
  ];
  sections.push({ id: 'now', title: 'Now', blocks: [{ type: 'stats', items: stats }] });
  // The quota, as the boxes report it (accounts.mjs): what the old board's quota tile showed.
  const meters = usage.filter((u) => Object.keys(u.windows ?? {}).length).flatMap((u) => Object.entries(u.windows).filter(([, v]) => typeof v === 'number').map(([w, v]) => ({
    label: `${u.label} · ${w}`, value: Math.max(0, Math.min(1, v)), detail: `${Math.round(v * 100)}%${u.resets?.[w] ? `, resets ${clock(u.resets[w])}` : ''}`,
    ...(v >= 0.95 ? { tone: 'bad' } : v >= 0.8 ? { tone: 'warn' } : {}),
  })));
  sections.push({ id: 'quota', title: 'Quota', side: true, blocks: [meters.length ? { type: 'meter', items: meters.slice(0, 12) } : { type: 'text', tone: 'muted', text: 'No account has reported its usage yet.' }] });
  for (const [agent, bs] of Object.entries(all)) {
    const rows = bs.map((b) => ({
      text: `${cap(b.name)}`, agent,
      meta: b.dark ? `dark: no word for ${ago(nowS - b.at)}` : [`${b.talking.length} talking`, `${b.waiting.length} waiting`, ...(b.slots ? [`${b.slots.used ?? 0} of ${b.slots.cap ?? '?'} slots`] : []), ...(b.socket?.state ? [`socket ${b.socket.state}`] : [])].join(' · '),
      badge: b.dark ? 'dark' : 'live', tone: b.dark ? 'bad' : 'ok',
    }));
    const talk = bs.filter((b) => !b.dark).flatMap((b) => b.talking.map((t) => ({ text: withWhom(t), meta: b.name })));
    const wait = bs.filter((b) => !b.dark).flatMap((b) => b.waiting.map((w) => ({ text: withWhom(w), meta: [b.name, why(w)].filter(Boolean).join(' · '), tone: 'warn' })));
    sections.push({ id: `board-${agent}`, title: `${cap(agent)}'s bridges`, blocks: [
      { type: 'list', items: rows },
      ...(talk.length ? [{ type: 'text', tone: 'muted', text: 'Talking now' }, { type: 'list', items: talk.slice(0, 20) }] : []),
      ...(wait.length ? [{ type: 'text', tone: 'muted', text: 'Waiting' }, { type: 'list', items: wait.slice(0, 20) }] : []),
    ] });
  }
  if (!Object.keys(all).length) sections.push({ id: 'none', blocks: [{ type: 'text', tone: 'muted', text: 'No bridge has written to the board yet.' }] });
  return { title: 'Now', intro: 'Live state: each agent\'s bridges, who they\'re talking with and what waits. Nothing anyone said is kept here.', sections };
}

export const boardExists = (env, agent) => existsSync(boardDir(env, agent));
