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
// What the runtime shows of it: on its page, the Now board (the model accounts' quota, the old status board's tiles,
// and a row per agent, its bridges and bodies in words; a tap opens now/<agent>: its bridges, who they're talking
// with, what waits and why); in its manifest, a bridge that's actually down (an alert on loom's Inbox), one back
// after an outage (an FYI) and each agent's `doing` (its card on Home).
//
// A bridge's state (bridgeStatus; Jonathan, 2026-11-03: notify when it's actually down, not on every blip):
//
//   live        its snapshot is fresh (three of its intervals, 30 s at least)
//   late        silent for less than LOOM_RUNTIME_BRIDGE_DARK_S (default 300) and nothing explains it: shown, never said
//   restarting  silent, and the runtime knows why: its service's house is wanted, starting or stopping, being moved
//               or restarted, or just started and not heard from yet. Never an alert (so never a push). Not forever:
//               a house stuck that way for three dark thresholds is dark.
//   down        silent, and the owner took its service down: nothing is meant to be running
//   dark        silent for longer than the threshold while its house is supposed to be running: an alert
//   looping     its service's house ended unasked LOOP_RESTARTS times or more within LOOP_WINDOW_S (control.mjs keeps
//               them, `crashes`): an alert at once, whatever the timer says
//
// What was dark or looping is remembered (<data>/now-watch.json): back live, it leaves one FYI ("was down 7 min, back
// at 14:02"); a blip under the threshold leaves nothing. The alert's text is fixed for its outage (when it began), so
// loom pushes it once (loom src/ui/push.ts: an ask's key is its text); the FYI is a notice, which never pushes.
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, appendFileSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setting } from './piece.mjs';
import { AGENT_NAME, load, withLock } from './state.mjs';
import { raiseAlert } from './alerthook.mjs';

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
  for (const b of bridgesOf(dir, nowS)) out[b.name] = { talking: b.talking.length, waiting: b.waiting.length, age_s: Math.round(nowS - b.at), fresh: !b.stale };
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

/** A board's bridges: each snapshot with its freshness (stale: older than three of its intervals, 30 s at least). */
export function bridgesOf(dir, nowS = Date.now() / 1000) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const snap = readJson(join(dir, n));
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) continue;
    const name = n.slice(0, -5);
    if (!BRIDGE.test(name) || name === 'convs') continue;
    // `at` is the house's word: a finite time, not after now (a minute's skew aside), or the snapshot is unreadable.
    const at = typeof snap.at === 'number' ? snap.at : Number.NaN;
    if (!Number.isFinite(at) || at <= 0 || at > nowS + 60) continue;
    const every = Math.max(10, Number(snap.interval_s) || 10);
    out.push({
      name, at, stale: nowS - at > Math.max(30, 3 * every),
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

// ─── What each bridge is: live, restarting, dark… ───────────────────────────

/** Silence this long, with nothing to explain it, is a bridge down. */
export const DARK_DEFAULT_S = 300;
/** A crash loop: this many unasked ends of a bridge's service house within the window. */
export const LOOP_RESTARTS = 3;
export const LOOP_WINDOW_S = 15 * 60;
/** A service house on its way up or down: the runtime is (re)starting it. */
const TRANSIT = new Set(['wanted', 'starting', 'stopping']);
const FYI_MAX = 10;
const FYI_S = 86_400;

/** LOOM_RUNTIME_BRIDGE_DARK_S: 30 s to a day, else the default. */
export function darkAfterS(env) {
  const n = Number.parseInt(setting(env, 'BRIDGE_DARK_S') ?? '', 10);
  return Number.isInteger(n) && n >= 30 && n <= 86_400 ? n : DARK_DEFAULT_S;
}

const sec = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t / 1000; };

/** The unasked ends of a service's house within the loop window (control.mjs, serviceHouseEnded), oldest first. */
export function recentCrashes(svc, nowS) {
  if (!svc || svc.want !== 'up' || !Array.isArray(svc.crashes)) return [];
  return svc.crashes.filter((c) => c && nowS - sec(c.at) < LOOP_WINDOW_S && sec(c.at) > 0).sort((x, y) => sec(x.at) - sec(y.at));
}

/**
 * What a bridge is now (the states above): {state, …}. `b` from bridgesOf; `svc` its service's record (agent/<bridge>,
 * control.mjs) and `house` that service's current house, when the runtime runs it; a bridge it doesn't run has only
 * its silence to go by.
 */
export function bridgeStatus(b, svc, house, nowS, darkS = DARK_DEFAULT_S) {
  const crashes = recentCrashes(svc, nowS);
  if (crashes.length >= LOOP_RESTARTS) return { state: 'looping', crashes };
  if (!b.stale) return { state: 'live' };
  if (svc && svc.want !== 'up') return { state: 'down' };
  if (svc) {
    // Its house is on its way (wanted, perhaps waiting out a back-off; claimed and starting; stopping for a move or a
    // restart), or there's none yet: the runtime is replacing it.
    if (!house || TRANSIT.has(house.state) || svc.moveTo) {
      const since = house ? Math.max(sec(house.updated ?? house.created), sec(house.notBefore)) : nowS;
      if (nowS - since <= 3 * darkS) return { state: 'restarting', house: house?.state ?? 'none', since };
      return { state: 'dark', stuck: house?.state ?? 'none', stuckS: nowS - since };
    }
    // A fresh house, up but not heard from yet: its bridge is still connecting.
    const started = sec(house.started ?? house.updated);
    if (house.state === 'running' && started > b.at && nowS - started <= darkS) return { state: 'restarting', house: 'running', since: started };
  }
  return nowS - b.at > darkS ? { state: 'dark', ...(svc ? { running: true } : {}) } : { state: 'late' };
}

const watchFile = (env) => join(dataDir(env), 'now-watch.json');

/**
 * Every board's bridges with their state, and the outages remembered: a bridge dark or looping is noted (when it
 * began), and back live it leaves one FYI. `s` is the runtime's state (load), read here if not given. Remembering is
 * best-effort: a watch file that can't be had leaves the states as they are, with no FYI.
 */
export function watchBridges(env, nowS = Date.now() / 1000, s = undefined, o = {}) {
  const all = boards(env, nowS);
  let st = s;
  if (st === undefined) { try { st = load(env); } catch { st = null; } }
  const darkS = darkAfterS(env);
  const out = {};
  for (const [agent, bs] of Object.entries(all)) {
    out[agent] = bs.map((b) => {
      const svc = st?.services?.[`${agent}/${b.name}`];
      return { ...b, ...bridgeStatus(b, svc, svc ? st?.houses?.[svc.house] : undefined, nowS, darkS) };
    });
  }
  let w = { v: 1, bridges: {}, notices: [] };
  const began = [];
  try {
    withLock(dataDir(env), 'now-watch.lock', () => {
      const had = readJson(watchFile(env));
      if (had && typeof had === 'object' && had.bridges && typeof had.bridges === 'object') w = { v: 1, bridges: had.bridges, notices: Array.isArray(had.notices) ? had.notices : [] };
      const before = JSON.stringify(w);
      const seen = new Set();
      for (const [agent, bs] of Object.entries(out)) {
        for (const b of bs) {
          const k = `${agent}/${b.name}`;
          seen.add(k);
          // Each bridge on its own: one that can't be noted never holds up the others.
          try { if (noteBridge(w, k, agent, b)) began.push({ agent, b }); } catch { /* noted next time */ }
        }
      }
      for (const k of Object.keys(w.bridges)) if (!seen.has(k)) delete w.bridges[k];
      w.notices = w.notices.filter((n) => n && typeof n.text === 'string' && nowS - sec(n.at) < FYI_S).slice(0, FYI_MAX);
      if (JSON.stringify(w) !== before) { ensureDir(dataDir(env)); writePrivate(watchFile(env), JSON.stringify(w)); }
    }, 'the now board\'s watch', 2000);
  } catch { /* remembered next time */ }
  for (const [agent, bs] of Object.entries(out)) for (const b of bs) { const r = w.bridges[`${agent}/${b.name}`]; if (r) b.outage = r; }
  // An outage that began just now: the owner's alert command hears of it once (t-1830), as the Inbox's alert does.
  for (const { agent, b } of began) {
    const looping = b.state === 'looping';
    (o.alert ?? raiseAlert)(env, { source: 'runtime-bridge', severity: 'bad',
      summary: `${cap(agent)}'s ${b.name} bridge ${looping ? 'keeps restarting' : 'is down'}`,
      facts: { agent, bridge: b.name, state: b.state, since: clock(looping ? sec(b.crashes[0].at) : b.at), ...(looping ? { restarts: b.crashes.length, error: lastError(b.crashes) } : {}) } });
  }
  return { all: out, notices: w.notices };
}

/** One bridge's part of the watch: an outage noted (dark, looping), or ended (back live: its FYI; taken down: none). */
function noteBridge(w, k, agent, b) {
  const r = w.bridges[k];
  if (b.state === 'dark' || b.state === 'looping') {
    // An outage's start: its last word (dark), or its first restart in the window (looping). Kept while it lasts.
    if (!r || r.kind !== b.state) { w.bridges[k] = { kind: b.state, since: b.state === 'dark' ? b.at : sec(b.crashes[0].at), outage: r?.outage ?? b.at, restarts: b.crashes?.length ?? 0 }; return !r; }
    if (b.state === 'looping') r.restarts = Math.max(r.restarts ?? 0, b.crashes.length);
  } else if (b.state === 'live' && r) {
    w.notices.unshift(backNotice(agent, b, r));
    delete w.bridges[k];
  } else if (b.state === 'down' && r) delete w.bridges[k]; // the owner took it down: nothing to report
  // Restarting or late: an outage still going (if one was noted), never a new one.
}

/** The FYI a bridge back from an outage leaves: how long it was down (or that it settled), and when it came back. */
function backNotice(agent, b, r) {
  const who = `${cap(agent)}'s ${b.name} bridge`;
  const text = r.kind === 'looping'
    ? `${who} is steady again after ${r.restarts} restarts, back at ${clock(b.at)}`
    : `${who} was down ${minutes(b.at - (r.outage ?? r.since))}, back at ${clock(b.at)}`;
  return { text, at: new Date(b.at * 1000).toISOString(), agent, page: `now/${agent}` };
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const minutes = (s) => { const m = Math.max(1, Math.round(s / 60)); return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`; };
const lastError = (crashes) => { const e = [...crashes].reverse().find((c) => c.error)?.error; return e ? String(e).replace(/\s+/g, ' ').trim().slice(0, 140) : ''; };
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

/** The manifest's part: an alert for each bridge actually down (dark or looping), the FYIs, and each agent's doing. */
export function nowManifest(env, nowS = Date.now() / 1000, s = undefined) {
  const { all, notices } = watchBridges(env, nowS, s);
  const asks = [];
  const agents = {};
  for (const [agent, bs] of Object.entries(all)) {
    for (const b of bs) {
      const who = `${cap(agent)}'s ${b.name} bridge`;
      // Something wrong to look at, not a choice (loom's Inbox files it under Alerts, not Decisions). Its text is fixed
      // for the outage (when it began), so it's pushed once; what changes goes in its meta.
      if (b.state === 'dark') {
        asks.push({ text: `${who} is down: no word since ${clock(b.at)}`,
          meta: b.stuck ? `its house has been ${b.stuck === 'none' ? 'missing' : b.stuck} for ${minutes(b.stuckS)}` : `nothing from it for ${ago(nowS - b.at)}${b.running ? ', while its house is up' : ''}`,
          at: new Date(b.at * 1000).toISOString(), page: `now/${agent}`, label: 'Look', kind: 'alert', agent });
      } else if (b.state === 'looping') {
        const since = b.outage?.kind === 'looping' ? b.outage.since : sec(b.crashes[0].at);
        const err = lastError(b.crashes);
        asks.push({ text: `${who} keeps restarting, since ${clock(since)}`,
          meta: `${b.crashes.length} restarts in ${minutes(nowS - sec(b.crashes[0].at))}${err ? `, last error: ${err}` : ''}`,
          at: new Date(since * 1000).toISOString(), page: `now/${agent}`, label: 'Look', kind: 'alert', agent });
      }
    }
    // Each conversation one of its bodies is in, simply (as shuttle's card said it): who or where, and how lately.
    const doing = bs.filter((b) => !b.stale).flatMap((b) => b.talking.map((t) => {
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
  return { asks: asks.slice(0, ASKS_MAX), agents, notices };
}

/** The Now page: the old status board's tiles (bridges, talking, waiting, quota), then a row per agent. */
/** A usage window in words: "7d" -> "week", "5h" -> "5 hours". */
const windowName = (k) => (k === '7d' ? 'week' : /^\d+h$/.test(k) ? `${k.slice(0, -1)} hours` : /^\d+d$/.test(k) ? `${k.slice(0, -1)} days` : k);

export function nowPage(env, { usage = [], nowS = Date.now() / 1000, state = undefined } = {}) {
  const { all } = watchBridges(env, nowS, state);
  const flat = Object.values(all).flat();
  const isLive = (x) => x.state === 'live' || x.state === 'late';
  const live = flat.filter(isLive);
  const sections = [];
  const dark = flat.filter((x) => x.state === 'dark' || x.state === 'looping').length;
  const restarting = flat.filter((x) => x.state === 'restarting').length;
  const off = flat.filter((x) => x.state === 'down').length;
  // Who's talking and waiting: from snapshots still current, whatever the bridge's state.
  const current = flat.filter((x) => !x.stale);
  const talking = current.reduce((n, x) => n + x.talking.length, 0);
  const waiting = current.reduce((n, x) => n + x.waiting.length, 0);
  // The quota, as the boxes report it (accounts.mjs): each window a meter; the fullest one a tile.
  const windows = usage.filter((u) => Object.keys(u.windows ?? {}).length).flatMap((u) => Object.entries(u.windows).filter(([, v]) => typeof v === 'number').map(([w, v]) => ({ u, w, v: Math.max(0, Math.min(1, v)) })));
  const fullest = windows.reduce((m, x) => (!m || x.v > m.v ? x : m), null);
  const toneOfUse = (v) => (v >= 0.95 ? { tone: 'bad' } : v >= 0.8 ? { tone: 'warn' } : {});
  // The headline: the bridges in a word, then the quota if it's running out.
  const detail = [`${live.length} live`, ...(restarting ? [`${restarting} restarting`] : []), ...(off ? [`${off} down`] : []), `${talking} talking`, `${waiting} waiting`].join(' · ');
  const health = dark
    ? { tone: 'bad', text: `${dark === 1 ? 'A bridge is' : `${dark} bridges are`} down`, detail }
    : restarting ? { tone: 'warn', text: `${restarting === 1 ? 'A bridge is' : `${restarting} bridges are`} restarting`, detail }
    : fullest && fullest.v >= 0.95 ? { tone: 'bad', text: `${fullest.u.label} is nearly out`, detail: `${Math.round(fullest.v * 100)}% of its ${windowName(fullest.w)} used` }
      : !flat.length ? { tone: 'muted', text: 'No bridge reports yet', detail: 'A bridge writes here once it\'s up.' }
        : { tone: fullest && fullest.v >= 0.8 ? 'warn' : 'ok', text: `${flat.length === 1 ? 'The bridge is' : `All ${flat.length} bridges are`} live`, detail: `${talking} talking · ${waiting} waiting${fullest && fullest.v >= 0.8 ? ` · ${fullest.u.label} at ${Math.round(fullest.v * 100)}%` : ''}` };
  const stats = [
    { label: 'Bridges', value: `${live.length} live`, ...(dark ? { detail: `${dark} down`, tone: 'bad' } : restarting ? { detail: `${restarting} restarting`, tone: 'warn' } : { tone: live.length ? 'ok' : 'muted' }) },
    { label: 'Talking', value: String(talking), detail: 'conversations' },
    { label: 'Waiting', value: String(waiting), ...(waiting ? { tone: 'warn', detail: 'for a body' } : { detail: 'nothing' }) },
    ...(fullest ? [{ label: 'Quota', value: `${Math.round(fullest.v * 100)}%`, detail: `${fullest.u.label}, ${windowName(fullest.w)}`, meter: fullest.v, ...toneOfUse(fullest.v) }] : []),
  ];
  sections.push({ id: 'now', blocks: [{ type: 'health', ...health }, { type: 'stats', items: stats }] });
  const meters = windows.map(({ u, w, v }) => ({ label: `${u.label} · ${windowName(w)}`, value: v, detail: `${Math.round(v * 100)}%${u.resets?.[w] ? `, resets ${clock(u.resets[w])}` : ''}`, ...toneOfUse(v) }));
  sections.push({ id: 'quota', title: 'Quota', side: true, blocks: [meters.length ? { type: 'meter', items: meters.slice(0, 12) } : { type: 'text', tone: 'muted', text: 'No account has reported its usage yet.' }] });
  // A row per agent, what's wrong first: its bridges and its bodies in words, a tap from its own board (now/<agent>).
  // One section, whatever the count: a page holds ten, and a section per agent broke Now at the ninth (t-1869). A panel
  // holds ROWS_MAX rows (loom's vocab, LIMITS.items); past that the rest are counted, never silently dropped.
  const rows = Object.entries(all).map(([agent, bs]) => agentSummary(agent, bs, nowS)).sort((x, y) => RANK[x.tone] - RANK[y.tone]);
  sections.push({ id: 'agents', title: 'Agents', blocks: rows.length
    ? [{ type: 'panel', rows: rows.slice(0, ROWS_MAX) }, ...(rows.length > ROWS_MAX ? [{ type: 'text', tone: 'muted', text: `And ${rows.length - ROWS_MAX} more agents, fine ones last.` }] : [])]
    : [{ type: 'text', tone: 'muted', text: 'No agent\'s bridge has reported yet.' }] });
  return { title: 'Now', intro: 'Live state: a row per agent, its bridges and bodies; tap one for who it\'s talking with and what waits. Nothing anyone said is kept here.', sections };
}

const RANK = { bad: 0, warn: 1, ok: 2, muted: 3 };
const ROWS_MAX = 200;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An agent's bridges, worst first: each with its row (badge, tone, why) from bridgeRow. */
function rankBridges(bs, nowS) {
  return bs.map((b) => ({ b, ...bridgeRow(b, nowS) })).sort((x, y) => RANK[x.tone] - RANK[y.tone]);
}

/** A bridge's state as a few words for an agent's row: "Discord bridge is down". */
function bridgeWords(b) {
  const n = `${cap(b.name)} bridge`;
  return { looping: `${n} keeps restarting`, dark: `${n} is down`, restarting: `${n} is restarting`, down: `${n} is off`, late: `${n} is late`, live: `${n} is live` }[b.state] ?? `${n} is ${b.state}`;
}

/** An agent in a line (its row on Now, its headline on its own board): its bridges' worst state, then its bodies. */
function agentSummary(agent, bs, nowS, ranked = rankBridges(bs, nowS)) {
  const worst = ranked[0];
  const troubled = ranked.filter((r) => r.tone === 'bad' || r.tone === 'warn');
  const live = bs.filter((b) => b.state === 'live' || b.state === 'late').length;
  const off = bs.filter((b) => b.state === 'down').length;
  const value = troubled.length
    ? `${bridgeWords(troubled[0].b)}${troubled.length > 1 ? ` (and ${troubled.length - 1} more)` : ''}`
    : live ? (bs.length === 1 ? `${cap(bs[0].name)} bridge is live` : `${live === bs.length ? 'All ' : ''}${plural(live, 'bridge')} live${off ? ` · ${off} off` : ''}`)
      : bs.length === 1 ? `${cap(bs[0].name)} bridge is off` : `${plural(off, 'bridge')} off`;
  // Its bodies, from snapshots still current: how many are talking, how many wait for one, and its slots if it says.
  const current = bs.filter((b) => !b.stale);
  const talk = current.reduce((n, b) => n + b.talking.length, 0);
  const wait = current.reduce((n, b) => n + b.waiting.length, 0);
  const slots = current.filter((b) => b.slots && Number(b.slots.cap) > 0);
  const used = slots.reduce((n, b) => n + (Number(b.slots.used) || 0), 0), capN = slots.reduce((n, b) => n + Number(b.slots.cap), 0);
  const bodies = current.length
    ? [talk ? `${plural(talk, 'body', 'bodies')} talking` : 'No body talking', ...(wait ? [`${wait} waiting for a body`] : []), ...(slots.length ? [`${used} of ${capN} slots in use`] : [])].join(' · ')
    : 'Nothing current from its bodies';
  const tone = worst.tone === 'bad' ? 'bad' : worst.tone === 'warn' || wait ? 'warn' : live ? 'ok' : 'muted';
  return { label: cap(agent), agent, value, detail: bodies, tone, page: `now/${agent}` };
}

/** One agent's board, a tap from its row on Now: how its bridges are in a line, each bridge, who they're talking with and what waits. */
export function nowAgentPage(env, agent, { nowS = Date.now() / 1000, state = undefined } = {}) {
  const { all } = watchBridges(env, nowS, state);
  const bs = all[agent];
  const back = { type: 'link', text: 'Back to Now', page: 'now' };
  if (!bs) return { title: 'Not found', sections: [{ id: 'gone', blocks: [{ type: 'text', tone: 'muted', text: `No bridge of ${cap(agent)}'s has reported here.` }, back] }] };
  const ranked = rankBridges(bs, nowS);
  const sum = agentSummary(agent, bs, nowS, ranked);
  const rows = ranked.map(({ b, ...r }) => ({ text: `${cap(b.name)} bridge`, agent, ...r }));
  const talk = bs.filter((b) => !b.stale).flatMap((b) => b.talking.map((t) => ({ text: withWhom(t), meta: b.name })));
  const wait = bs.filter((b) => !b.stale).flatMap((b) => b.waiting.map((w) => ({ text: withWhom(w), meta: [b.name, why(w)].filter(Boolean).join(' · '), tone: 'warn' })));
  return { title: `${cap(agent)}'s bridges`, sections: [
    { id: 'status', blocks: [{ type: 'health', tone: sum.tone, text: sum.value, detail: sum.detail }] },
    { id: 'bridges', title: 'Bridges', blocks: [{ type: 'list', items: rows }] },
    ...(talk.length ? [{ id: 'talking', title: 'Talking now', blocks: [{ type: 'list', items: talk.slice(0, 20) }] }] : []),
    ...(wait.length ? [{ id: 'waiting', title: 'Waiting', blocks: [{ type: 'list', items: wait.slice(0, 20) }] }] : []),
    { id: 'back', blocks: [back] },
  ] };
}

/** A bridge's row on the Now page: its badge and tone by its state, and a line saying why. */
function bridgeRow(b, nowS) {
  const busy = [`${b.talking.length} talking`, `${b.waiting.length} waiting`, ...(b.slots ? [`${b.slots.used ?? 0} of ${b.slots.cap ?? '?'} slots`] : []), ...(b.socket?.state ? [`socket ${b.socket.state}`] : [])].join(' · ');
  switch (b.state) {
    case 'looping': { const err = lastError(b.crashes); return { badge: 'restarting', tone: 'bad', meta: `keeps restarting: ${b.crashes.length} restarts in ${minutes(nowS - sec(b.crashes[0].at))}${err ? `, last error: ${err}` : ''}` }; }
    case 'dark': return { badge: 'down', tone: 'bad', meta: b.stuck ? `down: its house has been ${b.stuck === 'none' ? 'missing' : b.stuck} for ${minutes(b.stuckS)}` : `down: no word for ${ago(nowS - b.at)}${b.running ? ', while its house is up' : ''}` };
    case 'restarting': return { badge: 'restarting', tone: 'warn', meta: `the runtime is ${b.house === 'running' ? 'bringing it back: its house is up, the bridge is connecting' : b.house === 'stopping' ? 'restarting its house' : 'starting its house'}` };
    case 'down': return { badge: 'off', tone: 'muted', meta: 'taken down: its service is down' };
    case 'late': return { badge: 'live', tone: 'warn', meta: `no word for ${ago(nowS - b.at)}` };
    default: return { badge: 'live', tone: 'ok', meta: busy };
  }
}

export const boardExists = (env, agent) => existsSync(boardDir(env, agent));
