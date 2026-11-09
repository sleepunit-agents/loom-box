// Bodies in the agent's own warm house (loom docs/specs/bridges.md, "Bodies before the one service"; agent-runtime.md,
// section 5), ported from shuttle's bodies.py: delivery says who to wake and for what; a body host in the agent's
// house (bodyhost.mjs) wakes them, with that house's harness, its login, its repo, its secrets and its agent's token.
// The runtime never runs a body on loom's own machine.
//
// The control plane's side is HouseRunner: the runner interface (runners.mjs) over a house. Each agent has one host
// record, <data>/delivery/hosts/<agent>.json:
//   house    the agent's warm house (asked for through `up`, placed by placement.mjs)
//   report   the host's last sync: {at, house, bodies: {id: {harness, status, session, feedable}}, done: {rid: {id}|{error}}}
//   req      bodies to start: {rid: {at, sealed}}  (the brief, the model, its run's key, a resume's session files: sealed)
//   stop     {id: {pack}}: bodies to end (pack: send their session files back first, for a slot)
//   inbox    {id: [{key, sealed}]}: follow-ups for a body mid-turn
//   draining {house: {since, report, hostHash, req, stop, inbox, claimed, cancel}}: the agent's earlier houses on an
//            older image (control.mjs, outdatedHouse), each still the host of the bodies it has, and of none new
// and packed/<id>.age: a body's session files, sent back in parts by its host, sealed whole.
//
// Draining (t-1764): a warm house built from an older image than its agent's current one would take every delivery
// and never idle out. So when the next body is wanted and the agent's house is outdated, that house moves to
// `draining`: it's asked for no new body, its bodies finish their turns there (fed, stopped and packed through its
// own part of the record), and a fresh house on the new image takes the record. A conversation whose body was in the
// old house resumes in the new one from its slot, as any resume does; the old house idles out the usual way.
//
// The host reaches it through the piece API, `body-sync`, as its house's own token (an agent caller with its house):
// an agent's host sees only its own agent's record, and only the house the record names (or a live house of that
// agent, adopted when the record names none).
//
// One house per steering principal (t-1952): an agent has a host record per *seat* (principal.mjs, seatOf): the
// owner's is <agent>.json (as it always was, so a live house is kept across the change), a person's or an unknown
// conversation's is <agent>@<seat>.json, each with its own house. A body is started in its conversation's seat's
// house, its record says which seat (`seat`), and everything asked of it goes through that seat's record. A house's
// host finds its record by its house (from its token), so no house is ever handed another seat's bodies, keys or
// sessions. Houses for anyone but the owner are capped per agent (seatRoom, LOOM_RUNTIME_SEAT_HOUSES): at the cap a
// body waits for one to idle out; it never shares one.
import { houseLaunchHandle, readHouseLaunch, writeHouseLaunch } from './house-launch-journal.mjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listConvs } from './delivery.mjs';
import { outdatedHouse, up } from './control.mjs';
import { pieceName } from './piece.mjs';
import { bodyBox } from './placement.mjs';
import { isParts } from './briefs.mjs';
import { RunnerError } from './runners.mjs';
import { MAX_SESSION_BYTES, safeRel } from './sessions.mjs';
import { GONE, part, redact, UNPRINTABLE_ONE } from './redact.mjs';
import { cardTime } from './activity.mjs';
import { ageSealer } from './sealed.mjs';
import { AGENT_NAME, StateError, load, update, withLock } from './state.mjs';
import { OWNER_SEAT, SEAT, seatCapProblem } from './principal.mjs';

/** A host report older than this: no host (its house is gone, or its host stopped). */
export const HOST_STALE_MS = 30_000;
/** How long a start waits for the house (a cold one is about 10 s, plus the image) and then for the body. */
export const WARM_MS = 150_000;
export const CLAIM_MS = 60_000;
/** A packed session travels in parts this big (base64), inside loom's piece API body cap. */
export const PART_CHARS = 360 * 1024;
const RID = /^[0-9a-f]{16}$/;
/** A body ref's id part, as bodies.mjs takes it: a house's body id (house, dash, the harness's id) fits it, or is refused. */
export const MAX_BODY_ID = 64;
const BODY_REF = new RegExp(`^[A-Za-z0-9-]{4,${MAX_BODY_ID}}$`);
const BODY_ID = /^[A-Za-z0-9-]{4,64}$/;
const HOUSE = /^h-[0-9]{1,9}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A start that found the agent's houses for other people at the cap (t-1952): delivery makes it wait, never a failure. */
const seatFull = (m) => Object.assign(new RunnerError(m), { seatFull: true });
/** A part transfer that hasn't finished in this long is given up, and swept. */
export const PARTS_MS = 3_600_000;
/** A request given up on (its claim wait ran out) is remembered this long, so a body its house starts late is stopped. */
const CANCEL_MS = 600_000;

/**
 * What waits in the host record for its house, sealed: a request (its brief) and a follow-up. Without age, these alone
 * are held in the clear (0600), only until the house takes them, so delivery still works; nothing else is kept then
 * (no slot, no queue: the next body starts fresh). `P:` marks one held that way.
 */
function transit(sealer) {
  return {
    seal(b) { try { return `A:${sealer.seal(b).toString('base64')}`; } catch { return `P:${Buffer.from(b).toString('base64')}`; } },
    open(t) { return String(t).startsWith('P:') ? Buffer.from(t.slice(2), 'base64') : sealer.open(Buffer.from(String(t).replace(/^A:/, ''), 'base64')); },
  };
}

/**
 * Transfers nobody will finish or collect: part transfers older than an hour (their parts are sealed, but a stopped
 * transfer never completes), and a session sent back that no pack() collected within the claim window (a pack that
 * gave up waiting). No slot ever references a packed file: a slot is its own file, sealed again by delivery.
 */
export function sweepTransfers(env, nowMs = Date.now(), fileNowMs = Date.now()) {
  const ls = (d) => { try { return readdirSync(d); } catch { return []; } };
  const parts = join(hostsDir(env), 'parts');
  for (const a of ls(parts)) for (const h of ls(join(parts, a))) for (const id of ls(join(parts, a, h))) {
    const dir = join(parts, a, h, id);
    if (existsSync(join(dir, 'offline.json'))) continue;
    const at = readJson(join(dir, 'at.json'));
    if (typeof at !== 'number' || nowMs - at >= PARTS_MS) rmSync(dir, { recursive: true, force: true });
  }
  const packed = join(hostsDir(env), 'packed');
  for (const a of ls(packed)) for (const h of ls(join(packed, a))) for (const f of ls(join(packed, a, h))) {
    const p = join(packed, a, h, f);
    if (f.endsWith('.offline.json') || existsSync(offlinePin(p))) continue;
    // By its file's own time: a packed file is a file, and its clock is the disk's.
    try { if (fileNowMs - statSync(p).mtimeMs >= 2 * CLAIM_MS) rmSync(p, { force: true }); } catch { /* gone */ }
  }
}

// The body host's own credential (never a body's): its house's task carries a one-time boot key; its first sync trades
// it for the host's key, held only in the host process's memory. A body in the house has its agent's token and its
// run's key, and neither reaches body-sync.
const keyHash = (k) => createHash('sha256').update(String(k)).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const dataDir = (env) => env.LOOM_BOX_DATA || join(env.HOME || '', '.local', 'share', 'loom-box');
const hostsDir = (env) => join(dataDir(env), 'delivery', 'hosts');
const ownerSeat = (seat) => seat === undefined || seat === null || seat === OWNER_SEAT;
const hostFile = (env, agent, seat) => {
  if (ownerSeat(seat)) return join(hostsDir(env), `${agent}.json`);
  if (!SEAT.test(seat)) throw new StateError('not a seat', 400);
  return join(hostsDir(env), `${agent}@${seat}.json`);
};
/** The agent's seats with a host record: the owner's (always), then each other seat's. */
function seatsOf(env, agent) {
  let names = [];
  try { names = readdirSync(hostsDir(env)); } catch { /* none yet */ }
  const pre = `${agent}@`;
  return [OWNER_SEAT, ...names.filter((n) => n.startsWith(pre) && n.endsWith('.json')).map((n) => n.slice(pre.length, -5)).filter((x) => SEAT.test(x) && x !== OWNER_SEAT)];
}
// Every path is the agent's and the house's own, and an id is checked before it names one.
const safe = (agent, house, id) => AGENT_NAME.test(agent ?? '') && HOUSE.test(house ?? '') && BODY_ID.test(id ?? '');
const packedFile = (env, agent, house, id) => { if (!safe(agent, house, id)) throw new StateError('not a body of a house', 400); return join(hostsDir(env), 'packed', agent, house, `${id}.age`); };
const offlinePin = file => file + '.offline.json';
const partDir = (env, agent, house, id) => { if (!safe(agent, house, id)) throw new StateError('not a body of a house', 400); return join(hostsDir(env), 'parts', agent, house, id); };
/**
 * A body's id, as the runtime knows it: its house's id, then the id the house's harness gave it. House ids are never
 * reused, so no house can report an id that's another house's body (another agent's, or its own agent's earlier house).
 */
export const bodyIdOf = (house, raw) => `${house}-${raw}`;

// Persist an authenticated receipt before its transient host report can vanish.
// A legacy host's identity alone does not prove that the full input was handed on.
function keepHouseLaunchReceipt(env, record, receipt) {
  if (['ready', 'refused'].includes(record.state)) return record;
  if (!['publishing', 'published'].includes(record.state)) throw new RunnerError('house receipt preceded request publication');
  if (receipt?.id) {
    const id = bodyIdOf(record.house, receipt.id);
    if (!BODY_REF.test(id)) throw new RunnerError('house launch receipt has an invalid body id');
    record.state = 'ready';
    record.input = receipt.inputConfirmed === true ? 'confirmed' : 'uncertain';
    record.body = { id, harness: record.harness, house: record.house, seat: record.seat,
      ...(record.model ? { model: record.model } : {}), ...(record.slot ? { slot: record.slot } : {}),
      ...(receipt.inputConfirmed !== true ? { inputUncertain: true } : {}) };
    delete record.sealed; writeHouseLaunch(env, record);
  } else if (receipt?.nativeNotStarted === true) {
    record.state = 'refused'; record.reason = receipt.error; delete record.sealed; writeHouseLaunch(env, record);
  }
  return record;
}

const rawOf = (body) => (body?.house && HOUSE.test(body.house) && String(body.id).startsWith(`${body.house}-`) ? String(body.id).slice(body.house.length + 1) : null);

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
function writeJson(p, v) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(v) + '\n', { mode: 0o600 });
  renameSync(tmp, p);
}

const hostLocked = (env, f) => withLock(hostsDir(env), 'lock', f, 'the body hosts', 10_000);
const loadHost = (env, agent, seat) => readJson(hostFile(env, agent, seat)) ?? { agent, ...(ownerSeat(seat) ? {} : { seat }), req: {}, stop: {}, inbox: {} };
export const hostOf = loadHost;


/**
 * Whether a body for `seat` can have a house now: null when it can (the owner's always can; a seat whose house is up
 * already can), else why it waits. Another seat's house is never shared: at the cap, the body waits for one of the
 * agent's other houses (a person's, an unknown conversation's) to idle out.
 */
export function seatRoom(env, agent, seat) {
  if (ownerSeat(seat)) return null;
  let s;
  try { s = load(env); } catch { return null; }   // the start reads it again, and says so
  const own = loadHost(env, agent, seat);
  if (own.house && TAKES.has(s.houses[own.house]?.state)) return null;
  return seatCapProblem(env, s, agent, seat);
}

/**
 * At the cap (seatRoom), the agent's houses for other seats that hold no body at all are asked to stop now, rather
 * than idling out their host's 600 s: what waits gets a house sooner. Only a running house whose host reports, fresh,
 * that every body it had has ended, and that nothing is asked of it. Returns the houses asked down.
 */
export function releaseEmptySeatHouses(env, agent, seat, nowMs = Date.now()) {
  // Under the hosts lock: no request joins a record between its look here and its house's stop.
  try { return hostLocked(env, () => releaseLocked(env, agent, seat, nowMs)); } catch { return []; }
}
function releaseLocked(env, agent, seat, nowMs) {
  let s;
  try { s = load(env); } catch { return []; }
  const empty = [];
  for (const other of seatsOf(env, agent)) {
    if (other === OWNER_SEAT || other === seat) continue;
    const h = loadHost(env, agent, other);
    if (!h.house || s.houses[h.house]?.collection || s.houses[h.house]?.session || s.houses[h.house]?.state !== 'running' || !freshRec(h, h.house, nowMs) || h.draining) continue;
    if (Object.values(h.report.bodies ?? {}).some((b) => b.status !== 'ended')) continue;
    if (Object.keys(h.req ?? {}).length || Object.keys(h.stop ?? {}).length || Object.keys(h.inbox ?? {}).length) continue;
    // Just handed to a start (warm, then launch's request): not empty, it's about to have a body.
    if (Number.isFinite(h.handedAt) && nowMs - h.handedAt < CLAIM_MS) continue;
    empty.push(h.house);
  }
  if (!empty.length) return [];
  try {
    update(env, (st) => { for (const id of empty) { const x = st.houses[id]; if (x?.state === 'running') { x.state = 'stopping'; x.updated = new Date(nowMs).toISOString(); x.log = 'stopped early: its agent\'s houses for other people were at the cap, and it held no body'; } } });
  } catch { return []; }
  return empty;
}

/** The record of the seat whose house (the agent's, or one draining) is `house`, with its seat; null when none is. */
function recordOfHouse(env, agent, house) {
  for (const seat of seatsOf(env, agent)) {
    const h = loadHost(env, agent, seat);
    if (houseRec(h, house)) return { h, seat };
  }
  return null;
}

/**
 * Seat records that are over: no house that's live, nothing draining, nothing asked. The owner's is kept (it's the
 * agent's own); an unknown conversation's or a person's goes, and comes back with its next body.
 */
export function sweepSeats(env) {
  let names = [];
  try { names = readdirSync(hostsDir(env)); } catch { return; }
  for (const n of names) {
    const m = /^([a-z][a-z0-9-]{0,39})@(.+)\.json$/.exec(n);
    if (!m || !SEAT.test(m[2]) || m[2] === OWNER_SEAT) continue;
    hostLocked(env, () => {
      const h = readJson(join(hostsDir(env), n));
      if (!h) return;
      // The state read under the lock, after the record: a house warm() asked for (up, then its record) is in it.
      let s;
      try { s = load(env); } catch { return; }
      pruneDraining(env, h);
      const live = h.house && LIVE.has(s.houses[h.house]?.state);
      if (!live && !h.draining && !Object.keys(h.req ?? {}).length && !retainOfflineHouse(env, h.house, h, s)) rmSync(join(hostsDir(env), n), { force: true });
    });
  }
}
/** One house's part of its agent's host record: the record itself for the agent's house, else that house's draining entry. */
const houseRec = (h, house) => (house && h.house === house ? h : (house && h.draining?.[house]) || null);
const freshRec = (x, house, now) => !!x?.report && now - x.report.at < HOST_STALE_MS && x.report.house === house;
const fresh = (h, now) => freshRec(h, h.house, now);
/** What's one house's in the record (the rest is the agent's). */
const PER_HOUSE = ['report', 'hostHash', 'bootHash', 'req', 'stop', 'inbox', 'claimed', 'cancel', 'quiescing', 'admissionProtocol', 'offlineCollection'];
function retainOfflineHouse(env, house, record, s) {
  if (s.houses[house]?.nativeHistory?.v === 1 && !s.houses[house].nativeHistory.complete) return true;
  const collection = record.offlineCollection;
  if (!collection) return false;
  if (!collection.complete) return true;
  return collection.entries.some(e => {
    const id = collection.done[e.key]?.bodyId ?? e.transfer?.bodyId ?? e.bodyId;
    return id && existsSync(offlinePin(packedFile(env, record.agent ?? s.houses[house]?.agent, house, id)));
  });
}
/** Draining houses that are over (or gone from the state): nothing of theirs is left to finish. */
function pruneDraining(env, h) {
  if (!h.draining) return;
  let s;
  try { s = load(env); } catch { return; }
  for (const id of Object.keys(h.draining)) if (!LIVE.has(s.houses[id]?.state) && !retainOfflineHouse(env, id, { agent: h.agent, ...h.draining[id] }, s)) delete h.draining[id];
  if (!Object.keys(h.draining).length) delete h.draining;
}
/** Down and body-sync share this lock: an unauthenticated host cannot acquire work between stop admission and state change. */
export const hostStopLock = (env, action) => hostLocked(env, action);
export const hasHostSession = (env, agent, house) => { const found = recordOfHouse(env, agent, house); return !!found && !!houseRec(found.h, house)?.hostHash; };
export function stoppingHosts(env) {
  const houses = Object.values(load(env).houses ?? {}).filter(h => h.state === 'stopping' && h.cooperativeStop === true);
  return houses.map(h => {
    const found = recordOfHouse(env, h.agent, h.id);
    return { house: h.id, agent: h.agent, conversations: found ? houseRec(found.h, h.id)?.quiescing?.conversations ?? [] : [] };
  });
}
const belongsToHouse = (c, house) => ['claude', 'codex'].some(h => c.body?.startsWith(`${h}:${house}-`));

/** A house a body may still be handed to: asked for, starting or running. One stopping (or gone) never is, however fresh its host's last report. */
const TAKES = new Set(['wanted', 'starting', 'running']);
const LIVE = new Set([...TAKES, 'stopping']);
const houseTakes = (env, id) => { try { const h = load(env).houses[id]; return !!h && !h.collection && TAKES.has(h.state); } catch { return false; } };

/** What a house runs as its task to be the agent's body host. */
/** Register an already allocated raw-task house, retaining its box, needs and state slot. */
export function registerTaskHost(env, agent, house, { sealer = ageSealer(env, join(dataDir(env), 'delivery')) } = {}) {
  const seat = `j-${house}`;
  return hostLocked(env, () => {
    const h = loadHost(env, agent, seat);
    if (h.house && h.house !== house) throw new StateError('the task host changed', 409);
    if (h.hostHash) throw new StateError('the task host is already running', 409);
    let boot;
    if (h.bootSealed) boot = sealer.open(Buffer.from(h.bootSealed, 'base64')).toString();
    else {
      boot = randomBytes(24).toString('hex');
      Object.assign(h, { house, bootHash: keyHash(boot), bootSealed: sealer.seal(Buffer.from(boot)).toString('base64') });
      writeJson(hostFile(env, agent, seat), h);
    }
    return { seat, hostKey: boot };
  });
}

export const hostTask = (env, bootKey) => `loom-runtime body-host --piece ${pieceName(env)} --host-key ${bootKey}`;

// ─── The host's sync (the piece API's `body-sync`) ─────────────────────────

/** A host's activity cards, as core takes them (loom src/comms.ts postActivity): anything else is left out. */
export function cleanCards(cards) {
  return cards.slice(-100).flatMap((c) => {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !/^[A-Za-z0-9_.:\-]{1,80}$/.test(c.id)) return [];
    if (typeof c.tool !== 'string' || !/^[A-Za-z0-9_.:\-]{1,64}$/.test(c.tool)) return [];
    // A label never holds an unprintable character (redact.mjs UNPRINTABLE, the one list).
    if (typeof c.summary !== 'string' || !c.summary || c.summary.length > 120 || UNPRINTABLE_ONE.test(c.summary)) return [];
    if (!['running', 'done', 'failed'].includes(c.state)) return [];
    // A house's word is data: its label passes the same gate as one made here (redacted, a private path named
    // "a private file", one printable line of 120 at most), its id and tool must be nothing secret-shaped, and its
    // time is an ISO time or now.
    if (redact(c.id) !== c.id || redact(c.tool) !== c.tool) return [];
    const summary = part('text', c.summary, 120);
    if (summary === GONE || summary.length > 120 || UNPRINTABLE_ONE.test(summary)) return [];
    return [{ id: c.id, at: cardTime(c.at), tool: c.tool, summary, state: c.state }];
  });
}

function cleanReport(r) {
  const bodies = {};
  for (const [id, b] of Object.entries(r?.bodies ?? {}).slice(0, 64)) {
    if (!BODY_ID.test(id) || !b || typeof b !== 'object') continue;
    bodies[id] = {
      harness: ['claude', 'codex'].includes(b.harness) ? b.harness : 'unknown',
      status: ['working', 'idle', 'ended', 'unknown'].includes(b.status) ? b.status : 'unknown',
      ...(typeof b.session === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(b.session) ? { session: b.session } : {}),
      feedable: b.feedable === true,
      pending: Array.isArray(b.pending) ? b.pending.filter((k) => typeof k === 'string' && k.length <= 64).slice(0, 64) : [],
      // A Comms thread's body's tool steps (activity.mjs), checked here as core will check them.
      ...(Array.isArray(b.cards) ? { cards: cleanCards(b.cards) } : {}),
      ...(typeof b.final === 'string' ? { final: b.final.slice(0, 40000) } : {}),
      // How its turn went, once over (runners.mjs, turn): a host before t-1763 says nothing.
      ...(b.turn && typeof b.turn === 'object' ? { turn: { failed: b.turn.failed === true, worked: typeof b.turn.worked === 'boolean' ? b.turn.worked : null, ...(typeof b.turn.error === 'string' && b.turn.error ? { error: b.turn.error.slice(0, 200) } : {}),
        // Refused for a usage limit, and when its account has room again (t-1907).
        ...(b.turn.limited === true ? { limited: true, ...(Number.isFinite(b.turn.resets) && b.turn.resets > 0 ? { resets: Math.floor(b.turn.resets) } : {}) } : {}) } } : {}),
    };
  }
  const done = {};
  for (const [rid, d] of Object.entries(r?.done ?? {}).slice(0, 64)) {
    if (!RID.test(rid) || !d || typeof d !== 'object') continue;
    const attempt = r?.caps?.includes('native-admission') && /^[0-9a-f]{64}$/.test(d.attempt ?? '') ? { attempt: d.attempt } : {};
    if (typeof d.id === 'string' && BODY_ID.test(d.id)) done[rid] = { id: d.id, ...attempt, ...(r?.caps?.includes('native-admission') && d.inputConfirmed === true ? { inputConfirmed: true } : {}) };
    else done[rid] = { ...attempt, error: String(d.error ?? 'its host couldn\'t start it').slice(0, 300), ...(r?.caps?.includes('native-admission') && d.nativeNotStarted === true ? { nativeNotStarted: true } : {}) };
  }
  // What this host can do beyond the first version's: `parts`, a brief that names the agent's files (briefs.mjs).
  const caps = Array.isArray(r?.caps) ? r.caps.filter((c) => c === 'parts' || c === 'native-admission') : [];
  const startingUnknown = caps.includes('native-admission') && (!Array.isArray(r?.starting) || r.starting.some(id => !RID.test(id)));
  const starting = caps.includes('native-admission') && Array.isArray(r?.starting) ? [...new Set(r.starting.filter(id => RID.test(id)))] : [];
  return { bodies, done, caps, starting, startingUnknown };
}

/**
 * POST /api/<piece>/body-sync {report: {bodies, done, packed: {id: {part, parts, data}}}}, from an agent's house:
 * its report goes into its agent's host record, and it's answered what to start, stop and feed.
 */
export function bodySync(env, caller, body, o = {}) {
  if (caller?.kind !== 'agent' || !AGENT_NAME.test(caller.agent ?? '')) throw new StateError('body-sync is a body host\'s, in its agent\'s house', 403);
  const agent = caller.agent;
  // Which house this is, only from its token (core gives the caller's house): never from what it says.
  const house = caller.house;
  if (!HOUSE.test(house ?? '')) throw new StateError('body-sync comes from a house, and this token names none', 403);
  const sealer = o.sealer ?? ageSealer(env, join(dataDir(env), 'delivery'));
  const t = transit(sealer);
  const now = (o.now ?? (() => new Date()))().getTime();
  return hostLocked(env, () => {
    // The seat whose house this is (t-1952): the agent's house for it, or one of its draining houses (an older image's:
    // it finishes its bodies, and gets no new one). Only from its token's house, never from what it says.
    const found = recordOfHouse(env, agent, house);
    if (!found) return { exit: true, reason: `${agent}'s bodies aren't ${house}'s now` };
    const { h, seat } = found;
    const x = houseRec(h, house);
    // Only the body host, with its own key: never a body (an agent's token in the house is all a body has).
    const given = keyHash(body?.hostKey ?? '');
    let issued;
    if (!(x.hostHash && sameHash(given, x.hostHash))) {
      if (!(x.bootHash && sameHash(given, x.bootHash))) throw new StateError('body-sync takes the body host\'s own key: a body in the house has none', 403);
      // The boot key, once: traded for the host's own key, which only the host process holds.
      issued = randomBytes(24).toString('hex');
      x.hostHash = keyHash(issued);
      delete x.bootHash; delete x.bootSealed;
    }
    const { bodies, done, caps, starting, startingUnknown: malformedStarting } = cleanReport(body?.report);
    const startingUnknown = malformedStarting || (x.admissionProtocol === true && !caps.includes('native-admission'));
    if (caps.includes('native-admission')) x.admissionProtocol = true;
    const current = load(env).houses?.[house];
    if (current?.nativeHistory?.plan) return { exit: true, reason: 'its box is collecting this physically stopped house' };
    const stopping = current?.state === 'stopping' && !current.job && !current.session;
    if (stopping) {
      x.quiescing ??= { at: now, conversations: [], seen: [] };
      const conversations = new Set(x.quiescing.conversations);
      for (const [rid, request] of Object.entries(x.req ?? {})) {
        try { const q = JSON.parse(t.open(request.sealed).toString('utf8')); if (/^cv-[0-9a-f]{12}$/.test(q.conversation ?? '')) conversations.add(q.conversation); } catch { /* no text is recovered by guessing */ }
        // A host syncs only between native launch calls: a request absent from done has not run here.
        if (!done[rid] && !startingUnknown && !starting.includes(rid)) done[rid] = { error: 'its house is stopping before this request starts', nativeNotStarted: true };
      }
      x.quiescing.conversations = [...conversations];
      for (const [id, b] of Object.entries(bodies)) {
        if (x.quiescing.seen.includes(id)) continue;
        x.quiescing.seen.push(id);
        (x.stop ??= {})[id] ??= { pack: true, at: now, ...(b.session ? { session: b.session } : {}) };
      }
    }
    for (const b of Object.values(bodies)) if (typeof b.final === 'string') {
      // A host reports over its authenticated channel; words are sealed before they reach disk.
      try { b.finalSealed = sealer.seal(Buffer.from(b.final)).toString('base64'); } catch { /* retry next sync */ }
      delete b.final;
    }
    // An id this house already gave one request is never another's (a second claim of the same body is refused).
    x.claimed ??= {};
    for (const [rid, d] of Object.entries(done)) {
      if (!d.id || !x.req?.[rid]) continue;
      if (x.claimed[d.id] && x.claimed[d.id] !== rid) done[rid] = { error: `${house} reported ${d.id} for a second request` };
      else x.claimed[d.id] = rid;
    }
    const received = [];
    for (const [rid, receipt] of Object.entries(done)) {
      const attempt = x.req?.[rid]?.launch ?? receipt.attempt;
      if (!attempt) continue;
      const record = readHouseLaunch(env, attempt);
      if (!record || record.agent !== agent || record.house !== house || record.seat !== seat || record.rid !== rid) throw new RunnerError('house launch receipt belongs to another request');
      keepHouseLaunchReceipt(env, record, receipt);
      if (['ready', 'refused'].includes(record.state)) received.push(rid);
    }
    x.report = { at: now, house, bodies, done, caps, starting, startingUnknown };
    // A request given up on whose body the house started late: stopped, never run.
    x.cancel ??= {};
    for (const [rid, at] of Object.entries(x.cancel)) {
      if (done[rid]?.id) { (x.stop ??= {})[done[rid].id] = { pack: false, at: now }; delete x.cancel[rid]; } else if (now - at > CANCEL_MS) delete x.cancel[rid];
    }
    // Follow-ups the house says it took leave the record; until then they're sent again (and it hears each once).
    for (const [id, keys] of Object.entries(body?.report?.inboxAck ?? {})) {
      if (!BODY_ID.test(id) || !Array.isArray(keys) || !x.inbox?.[id]) continue;
      x.inbox[id] = x.inbox[id].filter((y) => !keys.includes(y.key));
      if (!x.inbox[id].length) delete x.inbox[id];
    }
    // A packed session, in parts: each sealed as it comes (never on disk in the clear), then opened and sealed whole.
    const got = [], restart = [];
    for (const [id, p] of Object.entries(body?.report?.packed ?? {}).slice(0, 8)) {
      if (!BODY_ID.test(id) || !Number.isSafeInteger(p?.part) || !Number.isSafeInteger(p?.parts) || p.part < 0 || p.part >= p.parts) continue;
      // A pack nobody's waiting for any more (its stop was dropped): its parts are acknowledged and thrown away, so its
      // house finishes the transfer and can idle out.
      if (!x.stop?.[id]?.pack) { got.push([id, p.part]); continue; }
      if (!Number.isSafeInteger(p?.part) || !Number.isSafeInteger(p?.parts) || p.parts < 1 || p.parts > 64 || p.part < 0 || p.part >= p.parts || typeof p.data !== 'string' || p.data.length > PART_CHARS) continue;
      const dir = partDir(env, agent, house, id);
      let sealedPart;
      try { sealedPart = sealer.seal(Buffer.from(p.data)); } catch { continue; } // no key: not kept (and not acked)
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!existsSync(join(dir, 'at.json'))) writeJson(join(dir, 'at.json'), now);
      if (current?.nativeHistory?.v === 1) writeJson(join(dir, 'offline.json'), { v: 1, source: 'host', bodyId: id });
      writeFileSync(join(dir, `${p.part}.age`), sealedPart, { mode: 0o600 });
      const files = Array.from({ length: p.parts }, (_, i) => join(dir, `${i}.age`));
      let complete = false;
      if (files.every((f) => existsSync(f))) {
        const whole = Buffer.from(files.map((f) => sealer.open(readFileSync(f)).toString()).join(''), 'base64');
        const f = packedFile(env, agent, house, id);
        mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
        // Keep the native session identity with its files. The host may forget
        // the body after this acknowledgement, before a later tick retires it.
        const session = bodies[id]?.session ?? x.stop[id]?.session;
        const kept = session ? Buffer.from(JSON.stringify({ v: 1, session, files: JSON.parse(whole.toString('utf8')) })) : whole;
        if (current?.nativeHistory?.v === 1) writeJson(offlinePin(f), { v: 1, source: 'host' });
        writeFileSync(f, sealer.seal(kept), { mode: 0o600 });
        rmSync(dir, { recursive: true, force: true });
        complete = true;
      }
      if (p.part !== p.parts - 1 || complete) got.push([id, p.part]);
      if (!complete && current?.nativeHistory?.v === 1 && files.slice(0, p.part).some(f => !existsSync(f))) restart.push(id);
    }
    // A stop is done once its body is gone from the report (and its pack, if it was asked for, is in).
    for (const id of Object.keys(x.stop ?? {})) {
      const gone = !bodies[id] || bodies[id].status === 'ended';
      // Done, and its id's claim with it: a resume of its session comes back under that id (t-1881). Only now, once
      // it's gone from the house, never while it may still run there. A transfer deadline is not a collected session.
      if (gone && (!x.stop[id].pack || existsSync(packedFile(env, agent, house, id)))) { delete x.stop[id]; if (x.claimed) delete x.claimed[id]; }
    }
    const req = {};
    for (const [rid, r] of Object.entries(x.req ?? {})) {
      if (stopping || done[rid] || x.cancel[rid]) continue;
      if (r.launch) {
        const record = readHouseLaunch(env, r.launch);
        if (!record || record.agent !== agent || record.house !== house || record.seat !== seat || record.rid !== rid) throw new RunnerError('house request journal does not match its publication');
        if (['ready', 'refused'].includes(record.state)) continue;
      }
      try { req[rid] = JSON.parse(t.open(r.sealed).toString('utf-8')); } catch { /* its text is gone: never started */ }
    }
    const inbox = {};
    for (const [id, items] of Object.entries(x.inbox ?? {})) {
      inbox[id] = items.flatMap((y) => { try { return [{ id: y.key, text: t.open(y.sealed).toString('utf-8') }]; } catch { return []; } });
    }
    if (x === h) pruneDraining(env, h);
    writeJson(hostFile(env, agent, seat), h);
    const wanted = new Set(x.quiescing?.conversations ?? []);
    const outstanding = stopping && listConvs(env).some(c => c.agent === agent && (wanted.has(c.conversation) || belongsToHouse(c, house)) && (c.body || c.starting || c.control?.state !== 'held'));
    const live = Object.values(bodies).some(b => b.status !== 'ended');
    const exit = stopping && !startingUnknown && !starting.length && !live && !outstanding && !Object.keys(x.stop ?? {}).length && !Object.keys(req).length;
    return { req, stop: x.stop ?? {}, inbox, acked: got, received, ...(restart.length ? { restart } : {}), ...(stopping ? { stopping: true } : {}), ...(exit ? { exit: true, reason: 'its conversations and native sessions were collected before house rescue' } : {}), ...(issued ? { hostKey: issued } : {}) };
  });
}

// A box's offline collection uses the same host lock, receipt journal and
// sealed native packs as the live host. The control plane authenticates the
// allocated box and freezes publication before entering this function.
export function nativeCollectionExchange(env, { agent, house, plan, requiredHost }, q, o = {}) {
  const sealer = o.sealer ?? ageSealer(env, join(dataDir(env), 'delivery'));
  const fail = message => { throw new StateError(message, 409); };
  return hostLocked(env, () => {
    const found = recordOfHouse(env, agent, house);
    if (!found) {
      if (requiredHost) fail('the native host record is unavailable; collection remains pending');
      return { plan, entries: [], complete: q.phase === 'finish' };
    }
    const { h, seat } = found, x = houseRec(h, house);
    if (!x.offlineCollection) {
      const entries = new Map();
      const addBody = (id, harness, session, attempt) => {
        if (!BODY_ID.test(id ?? '') || !['claude', 'codex'].includes(harness)) fail('native collection has an invalid body identity');
        const key = `body:${id}`, old = entries.get(key);
        if (old && (old.harness !== harness || old.session && session && old.session !== session)) fail('native collection identities conflict');
        const entry = old ?? { key, bodyId: id, harness, attempts: [] };
        if (session) entry.session = session;
        if (attempt && !entry.attempts.includes(attempt)) entry.attempts.push(attempt);
        entries.set(key, entry);
      };
      for (const c of listConvs(env)) {
        if (c.agent !== agent || typeof c.body !== 'string') continue;
        const [harness, id] = c.body.split(':');
        if (id?.startsWith(`${house}-`)) {
          const raw = id.slice(house.length + 1), report = x.report?.bodies?.[raw];
          addBody(raw, harness, report?.session);
        }
      }
      for (const [id, b] of Object.entries(x.report?.bodies ?? {})) {
        if (b.status !== 'ended' || x.stop?.[id]?.pack) addBody(id, b.harness, b.session);
      }
      for (const request of Object.values(x.req ?? {})) {
        if (!request.launch) fail('legacy native request needs explicit reconciliation before offline collection');
        const record = readHouseLaunch(env, request.launch);
        if (!record || record.agent !== agent || record.house !== house || record.seat !== seat) fail('native collection request belongs to another house');
        if (record.state === 'refused') continue;
        if (record.state === 'ready') addBody(rawOf(record.body), record.harness, record.body.slot?.session, record.id);
        else entries.set(`attempt:${record.id}`, { key: `attempt:${record.id}`, harness: record.harness, attempts: [record.id] });
      }
      x.offlineCollection = { v: 1, plan, entries: [...entries.values()], done: {} };
      for (const entry of x.offlineCollection.entries) if (entry.bodyId) {
        const packed = packedFile(env, agent, house, entry.bodyId);
        if (!existsSync(packed)) continue;
        let kept;
        try { kept = JSON.parse(sealer.open(readFileSync(packed)).toString('utf8')); } catch { fail('the existing native pack cannot be read'); }
        if (kept?.v !== 1 || !Array.isArray(kept.files) || !/^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(kept.session ?? '') || entry.session && entry.session !== kept.session) fail('the existing native pack has no matching identity');
        entry.session = kept.session;
        const sha256 = createHash('sha256').update(JSON.stringify(kept.files)).digest('hex');
        writeJson(offlinePin(packed), { v: 1, plan, sha256 });
        x.offlineCollection.done[entry.key] = { inherited: true, bodyId: entry.bodyId, session: kept.session, sha256 };
      }
      writeJson(hostFile(env, agent, seat), h);
    }
    const collection = x.offlineCollection;
    if (collection.plan !== plan) fail('native collection plan changed');
    const transferDir = key => partDir(env, agent, house, 'nc-' + createHash('sha256').update(plan + '\0' + key).digest('hex').slice(0, 40));
    const result = () => ({ plan, complete: collection.complete === true, entries: collection.entries.map(e => ({ ...e, received: !!collection.done[e.key] })) });
    if (q.phase === 'plan') return result();
    if (q.phase === 'finish') {
      if (collection.entries.some(e => !collection.done[e.key])) fail('native session collection has not been acknowledged');
      // A worker may have died after committing its receipt but before
      // deleting duplicate encrypted parts. Finish is retryable cleanup too.
      for (const entry of collection.entries) rmSync(transferDir(entry.key), { recursive: true, force: true });
      for (const entry of collection.entries) {
        const bodyId = collection.done[entry.key]?.bodyId;
        if (bodyId) rmSync(partDir(env, agent, house, bodyId), { recursive: true, force: true });
      }
      collection.complete = true; writeJson(hostFile(env, agent, seat), h);
      return result();
    }
    const entry = collection.entries.find(e => e.key === q.key);
    if (!entry) fail('native collection entry belongs to another plan');
    if (q.phase === 'refuse') {
      if (entry.bodyId || entry.attempts.length !== 1 || q.nativeNotStarted !== true) fail('a native body cannot be refused as unstarted');
      if (collection.done[entry.key]) {
        if (!collection.done[entry.key].refused) fail('native collection already has a body');
        return { plan, received: true };
      }
      const record = readHouseLaunch(env, entry.attempts[0]);
      if (!record || record.state === 'ready') fail('native collection already has a receipt');
      keepHouseLaunchReceipt(env, record, { nativeNotStarted: true, error: 'its stopped house confirms this native attempt was not started' });
      collection.done[entry.key] = { refused: true };
      writeJson(hostFile(env, agent, seat), h);
      return { plan, received: true };
    }
    if (q.phase !== 'part') fail('unknown native collection operation');
    if (!BODY_ID.test(q.bodyId ?? '') || entry.bodyId && q.bodyId !== entry.bodyId || entry.session && q.session !== entry.session ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(q.session ?? '') || !/^[0-9a-f]{64}$/.test(q.sha256 ?? '')) fail('native collection identity changed');
    if (!Number.isSafeInteger(q.part) || !Number.isSafeInteger(q.parts) || q.parts < 1 || q.parts > 64 || q.part < 0 || q.part >= q.parts || typeof q.data !== 'string' || q.data.length > PART_CHARS) fail('invalid native collection part');
    const signature = { bodyId: q.bodyId, session: q.session, sha256: q.sha256, parts: q.parts, inputConfirmed: q.inputConfirmed === true };
    if (entry.transfer && JSON.stringify(entry.transfer) !== JSON.stringify(signature)) fail('native collection transfer changed');
    if (collection.done[entry.key]) {
      if (collection.done[entry.key].sha256 !== q.sha256) fail('native collection already has another receipt');
      return { plan, part: q.part, received: true, complete: true };
    }
    entry.transfer = signature;
    const dir = transferDir(entry.key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJson(join(dir, 'offline.json'), { v: 1, plan, key: entry.key });
    const partFile = join(dir, `${q.part}.age`);
    if (existsSync(partFile)) {
      if (sealer.open(readFileSync(partFile)).toString() !== q.data) fail('native collection part changed');
    } else writeFileSync(partFile, sealer.seal(Buffer.from(q.data)), { mode: 0o600 });
    writeJson(hostFile(env, agent, seat), h);
    const parts = Array.from({ length: q.parts }, (_, i) => join(dir, `${i}.age`));
    if (!parts.every(f => existsSync(f))) return { plan, part: q.part, received: true, complete: false };
    const encoded = parts.map(f => sealer.open(readFileSync(f)).toString()).join('');
    const whole = Buffer.from(encoded, 'base64');
    if (whole.length > 12 * 1024 * 1024 || whole.toString('base64') !== encoded || createHash('sha256').update(whole).digest('hex') !== q.sha256) fail('native collection content changed');
    let files;
    try { files = JSON.parse(whole.toString('utf8')); } catch { fail('invalid native session encoding'); }
    let bytes = 0; const names = new Set();
    if (!Array.isArray(files) || files.length > 10_000) fail('invalid native session files');
    for (const f of files) {
      if (f?.root !== (entry.harness === 'claude' ? 'projects' : 'sessions') || !safeRel(f.rel) || typeof f.data !== 'string') fail('native session file is outside its harness');
      if (names.has(f.rel)) fail('native session file appears twice');
      names.add(f.rel);
      const data = Buffer.from(f.data, 'base64'); bytes += data.length;
      if (data.toString('base64') !== f.data || bytes > MAX_SESSION_BYTES) fail('invalid native session size');
    }
    if (!files.length) fail('offline native collection cannot acknowledge missing history');
    const nativeBody = { id: q.bodyId, harness: entry.harness, slot: { harness: entry.harness, session: q.session } };
    for (const attempt of entry.attempts) {
      const record = readHouseLaunch(env, attempt);
      if (!record || record.agent !== agent || record.house !== house || record.seat !== seat || record.harness !== entry.harness) fail('native collection receipt belongs to another house');
      if (record.state === 'ready' && rawOf(record.body) !== q.bodyId) fail('native collection receipt changed body');
      if (record.state === 'refused') fail('native collection cannot replace a refusal');
      if (x.claimed?.[q.bodyId] && x.claimed[q.bodyId] !== record.rid) fail('native collection body belongs to another attempt');
    }
    const packed = packedFile(env, agent, house, q.bodyId);
    mkdirSync(dirname(packed), { recursive: true, mode: 0o700 });
    writeJson(offlinePin(packed), { v: 1, plan, sha256: q.sha256 });
    const temporary = packed + '.tmp';
    writeFileSync(temporary, sealer.seal(Buffer.from(JSON.stringify({ v: 1, session: q.session, files }))), { mode: 0o600 });
    renameSync(temporary, packed);
    x.report ??= { bodies: {}, done: {}, caps: [] };
    x.report.bodies ??= {}; x.report.done ??= {};
    x.report.bodies[q.bodyId] = { ...(x.report.bodies[q.bodyId] ?? {}), harness: entry.harness, session: q.session, status: 'ended', feedable: false };
    for (const attempt of entry.attempts) {
      const record = readHouseLaunch(env, attempt);
      keepHouseLaunchReceipt(env, record, { id: nativeBody.id, inputConfirmed: q.inputConfirmed === true });
      x.report.done[record.rid] = { id: nativeBody.id, attempt, inputConfirmed: q.inputConfirmed === true };
      (x.claimed ??= {})[q.bodyId] = record.rid;
    }
    collection.done[entry.key] = { sha256: q.sha256, bodyId: q.bodyId, session: q.session };
    writeJson(hostFile(env, agent, seat), h);
    rmSync(dir, { recursive: true, force: true });
    return { plan, part: q.part, received: true, complete: true };
  });
}

// ─── The runner interface over a house ──────────────────────────────────────

/**
 * A runner whose bodies run in their agent's warm house. Its start asks for the house when there's none (placed
 * on a box its owner owns, with the harness logged in), waits for its host, hands it the request and waits for the
 * body; feeding, ending and status go through the host record. `remote`: a slot's files travel with the resume.
 */
export class HouseRunner {
  remote = true;

  constructor(env, harness, o = {}) {
    Object.assign(this, { env, harness, sealer: o.sealer ?? ageSealer(env, join(dataDir(env), 'delivery')), now: o.now ?? (() => new Date()), up: o.up ?? up, warmMs: o.warmMs ?? WARM_MS, claimMs: o.claimMs ?? CLAIM_MS, poll: o.poll ?? 250 });
    this.transit = transit(this.sealer);
  }

  /** Whether the runtime's key works here (age is installed): without it, no session is kept (no slot). */
  canSeal() {
    if (this.sealable === undefined) { try { this.sealer.seal(Buffer.from('?')); this.sealable = true; } catch { this.sealable = false; } }
    return this.sealable;
  }

  host(agent, seat) { return loadHost(this.env, agent, seat); }

  /** The seat a body's record (and so its house) is: its own word, else the seat whose house it's in, else the owner's. */
  seatFor(body) {
    if (typeof body?.seat === 'string' && SEAT.test(body.seat)) return body.seat;
    return (body?.agent && body?.house && recordOfHouse(this.env, body.agent, body.house)?.seat) || OWNER_SEAT;
  }

  /** The seat's house (the owner's, a person's, an unknown conversation's) with its body host up: asked for when there's none. */
  async warm(agent, seat = OWNER_SEAT) {
    const end = Date.now() + this.warmMs;
    for (;;) {
      const now = this.now().getTime();
      const h = this.host(agent, seat);
      let takes = !!h.house && houseTakes(this.env, h.house);
      // An older image than the agent's current build: drained, and the next body goes to a fresh house (t-1764).
      if (takes && !/^j-h-[0-9]{1,9}$/.test(seat) && this.drain(agent, h.house, seat)) takes = false;
      else if (fresh(h, now) && takes) {
        // Handed out (its launch writes the request next): marked, so the cap's release never stops it in between.
        hostLocked(this.env, () => { const x = loadHost(this.env, agent, seat); if (x.house === h.house) { x.handedAt = now; writeJson(hostFile(this.env, agent, seat), x); } });
        return h.house;
      }
      if (!takes) {
        if (/^j-h-[0-9]{1,9}$/.test(seat)) {
          const state = load(this.env).houses?.[h.house]?.state;
          if (['wanted', 'starting'].includes(state) && Date.now() <= end) { await sleep(this.poll); continue; }
          throw new RunnerError('the task’s allocated house is no longer running');
        }
        // Never past the cap, and never into another seat's house: the body waits (delivery.mjs asks seatRoom first;
        // this is the same check, for a start that raced past it).
        const full = seatRoom(this.env, agent, seat);
        if (full) { releaseEmptySeatHouses(this.env, agent, seat, now); throw seatFull(full); }
        const s = load(this.env);
        const at = bodyBox(s, agent, this.harness, this.env);
        if (!at.box) throw new RunnerError(at.reason);
        const boot = randomBytes(24).toString('hex');
        // up() checks the cap again in the same state write that makes the house: two starts at once never pass it both.
        let r;
        try { r = this.up(this.env, { now: () => this.now() }, { kind: 'owner' }, { agent, box: at.box, task: hostTask(this.env, boot) }, { kind: 'body-host', seat }); } catch (e) { if (e?.seatFull) throw seatFull(e.message); throw e; }
        // A new house: what was asked of the last one (and what it claimed) isn't this one's, nor is its host's key.
        hostLocked(this.env, () => {
          const x = loadHost(this.env, agent, seat);
          if (x.house && retainOfflineHouse(this.env, x.house, x, load(this.env))) {
            (x.draining ??= {})[x.house] = Object.fromEntries(PER_HOUSE.filter(k => k in x).map(k => [k, x[k]]));
            for (const k of PER_HOUSE) delete x[k];
          }
          x.house = r.id; delete x.report; delete x.hostHash; delete x.cancel; delete x.quiescing; delete x.offlineCollection;
          x.bootHash = keyHash(boot); x.req = {}; x.stop = {}; x.inbox = {}; x.claimed = {};
          pruneDraining(this.env, x); writeJson(hostFile(this.env, agent, seat), x);
        });
      }
      if (Date.now() > end) throw new RunnerError(`${agent}'s house ${h.house ?? ''} didn't start its body host in ${this.warmMs / 1000} s`);
      await sleep(this.poll);
    }
  }

  /**
   * When the agent's house `house` runs an older image than the agent's current build, it's moved to the record's
   * draining houses (its host's key, its bodies, what's asked of them all go with it) and the record names no house:
   * the caller asks for a fresh one. Its state record says so (`draining`), for the page. True if it was drained.
   */
  drain(agent, house, seat = OWNER_SEAT) {
    let s;
    try { s = load(this.env); } catch { return false; }
    if (!outdatedHouse(s, house)) return false;
    const at = this.now().toISOString();
    const moved = hostLocked(this.env, () => {
      const x = loadHost(this.env, agent, seat);
      if (x.house !== house) return false;
      (x.draining ??= {})[house] = { since: this.now().getTime(), ...Object.fromEntries(PER_HOUSE.filter((k) => k in x).map((k) => [k, x[k]])) };
      for (const k of PER_HOUSE) delete x[k];
      delete x.house;
      x.req = {}; x.stop = {}; x.inbox = {};
      writeJson(hostFile(this.env, agent, seat), x);
      return true;
    });
    if (moved) {
      try {
        update(this.env, (st) => { const hh = st.houses[house]; if (hh && !hh.draining) hh.draining = { at, reason: 'outdated image', build: hh.build, current: st.builds?.[agent]?.id ?? null }; });
      } catch { /* the page shows it next time */ }
    }
    return moved;
  }

  /** Reserve a stable request without handing any work to its host. The caller
   * persists this public handle with its conversation before publication. */
  async prepareLaunch(id, o, resume) {
    if (!/^[0-9a-f]{64}$/.test(id ?? '') || !AGENT_NAME.test(o.agent ?? '')) throw new RunnerError('a house launch needs its durable attempt and agent');
    const seat = o.seat ?? OWNER_SEAT;
    if (!SEAT.test(seat)) throw new RunnerError('invalid house launch seat');
    const parts = isParts(o.brief);
    const ask = { attempt: id, harness: this.harness, model: o.model, deny: o.deny ?? [], ...(parts ? { parts: o.brief } : { brief: o.brief }), key: o.env?.LOOM_BODY_KEY,
      ...(o.env?.LOOM_BODY_CONVERSATION ? { conversation: o.env.LOOM_BODY_CONVERSATION } : {}), ...(o.activity ? { activity: true } : {}),
      ...(resume ? { resume: resume.session, files: o.files ?? [] } : {}) };
    const intent = JSON.stringify({ agent: o.agent, seat, ask });
    const intentHash = createHash('sha256').update(intent).digest('hex');
    const check = old => {
      if (old.intentHash !== intentHash || old.agent !== o.agent || old.seat !== seat || old.harness !== this.harness) throw new RunnerError('house launch attempt already has another intent');
      return houseLaunchHandle(old);
    };
    const old = readHouseLaunch(this.env, id);
    if (old) return check(old);
    const house = await this.warm(o.agent, seat);
    return hostLocked(this.env, () => {
      const existing = readHouseLaunch(this.env, id);
      if (existing) return check(existing);
      const host = this.host(o.agent, seat);
      if (host.house !== house || !houseTakes(this.env, house)) throw Object.assign(new RunnerError('its house stopped before launch reservation'), { nativeNotStarted: true });
      if (!host.report?.caps?.includes('native-admission')) throw Object.assign(new RunnerError('its body host needs the native admission protocol; update its house runtime'), { nativeNotStarted: true, hostUpgradeRequired: true });
      if (load(this.env).houses[house]?.nativeHistory?.v === 1 && !host.report?.caps?.includes('native-history')) throw Object.assign(new RunnerError('its body host needs durable native history; update its house runtime'), { nativeNotStarted: true, hostUpgradeRequired: true });
      if (parts && !host.report?.caps?.includes('parts')) throw Object.assign(new RunnerError('its body host cannot read this brief'), { nativeNotStarted: true });
      const record = { v: 1, id, intentHash, harness: this.harness, agent: o.agent, seat, house, rid: id.slice(0, 16),
        state: 'reserved', at: this.now().getTime(), sealed: this.transit.seal(Buffer.from(JSON.stringify(ask))),
        ...(o.model ? { model: o.model } : {}), ...(resume ? { slot: { harness: resume.harness, session: resume.session } } : {}) };
      writeHouseLaunch(this.env, record);
      return houseLaunchHandle(record);
    });
  }

  checkedLaunch(handle) {
    const record = readHouseLaunch(this.env, handle?.id);
    if (!record || JSON.stringify(houseLaunchHandle(record)) !== JSON.stringify(houseLaunchHandle(handle)) || record.harness !== this.harness) throw new RunnerError('house launch handle does not match its sealed request');
    return record;
  }

  /** Cancel only a request that has never become visible to the host. An
   * interrupted two-file publication is recognized from its exact req marker. */
  cancelPreparedLaunch(handle) {
    return hostLocked(this.env, () => {
      const record = this.checkedLaunch(handle);
      const h = this.host(record.agent, record.seat), x = houseRec(h, record.house);
      if (record.state === 'reserved' && x?.req?.[record.rid]?.launch === record.id) {
        record.state = 'published'; writeHouseLaunch(this.env, record);
      }
      if (record.state !== 'reserved') return false;
      record.state = 'refused'; record.reason = 'cancelled before house request publication'; delete record.sealed;
      writeHouseLaunch(this.env, record);
      return true;
    });
  }

  publishPreparedLaunch(handle) {
    return hostLocked(this.env, () => {
      const record = this.checkedLaunch(handle);
      if (!['reserved', 'publishing'].includes(record.state)) return record.state;
      const h = this.host(record.agent, record.seat), x = houseRec(h, record.house);
      if (!x || !houseTakes(this.env, record.house) || x.quiescing) {
        if (record.state === 'publishing') return record.state;
        record.state = 'refused'; record.reason = 'its house stopped before request publication'; delete record.sealed;
        writeHouseLaunch(this.env, record); return record.state;
      }
      const request = x.req?.[record.rid];
      if (request && request.launch !== record.id) throw new RunnerError('house launch request id is already occupied');
      // Persist irrevocable publication intent first. Losing a transient host
      // record later can never turn possibly published work back into reserved.
      record.state = 'publishing'; writeHouseLaunch(this.env, record);
      (x.req ??= {})[record.rid] = { at: record.at, sealed: record.sealed, launch: record.id };
      // Recovery can repeat publication only to this same house and request.
      writeJson(hostFile(this.env, record.agent, record.seat), h);
      record.state = 'published'; writeHouseLaunch(this.env, record);
      return record.state;
    });
  }

  observePreparedLaunch(handle) {
    return hostLocked(this.env, () => {
      const record = this.checkedLaunch(handle);
      if (record.state === 'ready') return { state: 'ready', body: record.body };
      if (record.state === 'refused') return { state: 'refused', reason: record.reason };
      const h = this.host(record.agent, record.seat), x = houseRec(h, record.house);
      if (['reserved', 'publishing'].includes(record.state)) {
        if (x?.req?.[record.rid]?.launch !== record.id) return { state: 'pending' };
        record.state = 'published'; writeHouseLaunch(this.env, record);
      }
      const receipt = x?.report?.done?.[record.rid];
      if (receipt) keepHouseLaunchReceipt(this.env, record, receipt);
      if (record.state === 'ready') return { state: 'ready', body: record.body };
      if (record.state === 'refused') return { state: 'refused', reason: record.reason };
      return { state: 'pending', ...(receipt?.error ? { reason: receipt.error } : {}) };
    });
  }

  async waitPreparedLaunch(handle, { claimMs = this.claimMs } = {}) {
    const end = Date.now() + claimMs;
    for (;;) {
      const result = this.observePreparedLaunch(handle);
      if (result.state === 'ready') return result.body;
      if (result.state === 'refused') throw Object.assign(new RunnerError(result.reason), { nativeNotStarted: true });
      if (Date.now() > end) throw Object.assign(new RunnerError('its house launch is still uncertain; the original request is retained'), { nativePending: true });
      await sleep(this.poll);
    }
  }

  /** Called after the conversation bound the durable receipt. Removing the
   * request cannot remove that receipt or authorize another native admission. */
  acknowledgePreparedLaunch(handle) {
    return hostLocked(this.env, () => {
      const record = this.checkedLaunch(handle);
      if (!['ready', 'refused'].includes(record.state)) return false;
      const h = this.host(record.agent, record.seat), x = houseRec(h, record.house);
      if (x?.req?.[record.rid]?.launch === record.id) {
        delete x.req[record.rid]; writeJson(hostFile(this.env, record.agent, record.seat), h);
      }
      return true;
    });
  }

  async launch(o, resume) {
    if (!AGENT_NAME.test(o.agent ?? '')) throw new RunnerError('a body in a house is some agent\'s: say which');
    // Whose house (t-1952): the seat delivery gives, by the conversation's principal; none given is the owner's.
    const seat = o.seat ?? OWNER_SEAT;
    if (!SEAT.test(seat)) throw new RunnerError('a body\'s seat is owner, p-<person> or u-<conversation>');
    // A brief that names the agent's files goes as `parts`, never as `brief`: only a host that says it reads them
    // gets one (an older host would start the body without them).
    const parts = isParts(o.brief);
    const rid = randomBytes(8).toString('hex');
    const ask = { harness: this.harness, model: o.model, deny: o.deny ?? [], ...(parts ? { parts: o.brief } : { brief: o.brief }), key: o.env?.LOOM_BODY_KEY, ...(o.env?.LOOM_BODY_CONVERSATION ? { conversation: o.env.LOOM_BODY_CONVERSATION } : {}), ...(o.activity ? { activity: true } : {}), ...(resume ? { resume: resume.session, files: o.files ?? [] } : {}) };
    const sealed = this.transit.seal(Buffer.from(JSON.stringify(ask)));
    // Asked of the house warm() gave, only while it's still the agent's house (not drained since): else warm again.
    let house;
    for (;;) {
      // No native request exists until warm succeeds and req is published.
      try { house = await this.warm(o.agent, seat); }
      catch (error) { error.nativeNotStarted = true; throw error; }
      const asked = hostLocked(this.env, () => {
        const h = loadHost(this.env, o.agent, seat);
        if (h.house !== house) return false;
        if (parts && !h.report?.caps?.includes('parts')) return 'old';
        (h.req ??= {})[rid] = { at: this.now().getTime(), sealed };
        writeJson(hostFile(this.env, o.agent, seat), h);
        return true;
      });
      if (asked === 'old') throw new RunnerError(`${o.agent}'s house ${house} runs a body host too old to read its brief files: update the house's loom-runtime`);
      if (asked) break;
      await sleep(this.poll);
    }
    const end = Date.now() + this.claimMs;
    try {
      for (;;) {
        const d = houseRec(this.host(o.agent, seat), house)?.report?.done?.[rid];
        if (d?.id) {
          const id = bodyIdOf(house, d.id);
          // The composed id must still be a body ref (bodies.mjs REF: 4-64 of [A-Za-z0-9-]): the house's id takes room.
          if (!BODY_REF.test(id)) throw new RunnerError(`${house} reported a body id too long to be one here (${d.id.length} characters; at most ${MAX_BODY_ID - house.length - 1})`);
          // An id that's a body's already is refused, but for a resume of a body that ended: Claude Code gives a resumed
          // session back its own job id, so the house reports the body it was (t-1881). That record is the resumed
          // body's now; refusing it left the resumed body running in the house, unknown here, beside a fresh one.
          // (Refused, an id that's a live body's is left alone: it is that body's harness job, and stopping it would end the body it is.)
          const rec = readJson(join(dataDir(this.env), 'bodies', `${this.harness}-${id}.json`));
          if (rec && !(resume && rec.ended)) throw new RunnerError(`${house} reported ${d.id}, which is already a body's`);
          if (rec) this.forgetStop(o.agent, house, d.id, seat);
          return { id, harness: this.harness, model: o.model, house, seat, ...(resume ? { slot: resume } : {}) };
        }
        if (d?.error) throw Object.assign(new RunnerError(d.error), d.nativeNotStarted === true ? { nativeNotStarted: true } : {});
        if (Date.now() > end) {
          // Given up on: should its house start it late, that body is stopped, never run (bodySync, h.cancel).
          hostLocked(this.env, () => { const h = loadHost(this.env, o.agent, seat); const x = houseRec(h, house); if (x) { (x.cancel ??= {})[rid] = this.now().getTime(); writeJson(hostFile(this.env, o.agent, seat), h); } });
          throw new RunnerError(`${o.agent}'s body host didn't start the body in ${this.claimMs / 1000} s`);
        }
        await sleep(this.poll);
      }
    } finally {
      hostLocked(this.env, () => { const h = loadHost(this.env, o.agent, seat); const x = houseRec(h, house); if (x?.req?.[rid]) { delete x.req[rid]; writeJson(hostFile(this.env, o.agent, seat), h); } });
    }
  }

  /** The stop a body's last run had, gone from its house's record: it was that run's, never this body's (t-1881). */
  forgetStop(agent, house, raw, seat = OWNER_SEAT) {
    hostLocked(this.env, () => { const h = loadHost(this.env, agent, seat); const x = houseRec(h, house); if (x?.stop?.[raw]) { delete x.stop[raw]; writeJson(hostFile(this.env, agent, seat), h); } });
  }

  start(o) { return this.launch(o); }
  resume(slot, o) {
    if (slot?.harness !== this.harness || !slot.session) throw new RunnerError(`a ${this.harness} body resumes from a ${this.harness} slot`);
    return this.launch(o, slot);
  }

  /** Its house's part of the record, if its house is the agent's or draining, and its host is reporting. */
  rec(body) {
    const x = houseRec(this.host(body.agent, this.seatFor(body)), body.house);
    let collecting = false;
    try { collecting = !!load(this.env).houses?.[body.house]?.collection; } catch { /* fresh reports still carry their own facts */ }
    return x && (collecting || freshRec(x, body.house, this.now().getTime())) ? x : null;
  }

  entry(body) {
    const raw = rawOf(body);
    const x = raw ? this.rec(body) : null;
    if (!x) return null;
    const entry = x.report?.bodies?.[raw] ?? { status: 'ended' };
    try { if (load(this.env).houses?.[body.house]?.collection) return { ...entry, status: 'ended' }; } catch { /* keep the observed report */ }
    return entry;
  }

  status(body) { return this.entry(body)?.status ?? 'unknown'; }
  /** A stale host report is not proof that a running house's body ended. */
  pending(body) {
    try {
      const raw = rawOf(body);
      if (raw && existsSync(offlinePin(packedFile(this.env, body.agent, body.house, raw)))) return true;
      const h = load(this.env).houses?.[body.house];
      if (!h) return true; // Missing ownership metadata is not physical termination.
      if (h?.agent === body.agent && h.nativeHistory?.v === 1 && !h.nativeHistory.complete) return true;
      return !!h && !h.collection && h.agent === body.agent && ['wanted', 'starting', 'running', 'stopping'].includes(h.state);
    } catch { return true; } // An unreadable control plane cannot prove termination either.
  }
  /** Its host reports it alive/ended; a live house with no fresh report is unknown. */
  alive(body) {
    const e = this.entry(body);
    return e ? e.status !== 'ended' : this.pending(body) ? undefined : false;
  }
  slotOf(body) {
    let s = this.entry(body)?.session;
    if (!s) {
      const raw = rawOf(body);
      try {
        const pack = JSON.parse(this.sealer.open(readFileSync(packedFile(this.env, body.agent, body.house, raw))).toString('utf8'));
        if (pack?.v === 1 && typeof pack.session === 'string') s = pack.session;
      } catch { /* no acknowledged pack yet */ }
    }
    return s ? { harness: this.harness, session: s } : null;
  }
  /** How its turn went, as its house's host reports it: null from a host that doesn't say. */
  turn(body) { return this.entry(body)?.turn ?? null; }
  final(body) {
    const s = this.entry(body)?.finalSealed;
    return s ? this.sealer.open(Buffer.from(s, 'base64')).toString('utf-8') : null;
  }
  /** Its activity cards, as its host last reported them (only a Comms thread's body has any). */
  activity(body) { return this.entry(body)?.cards ?? []; }

  feed(body, message) {
    const e = this.entry(body);
    if (e?.status !== 'working') return { fed: false, reason: 'its turn is over: resume it' };
    if (!e.feedable) return { fed: false, reason: 'its house\'s harness has no inbox, so a body hears nothing mid-turn' };
    hostLocked(this.env, () => {
      const seat = this.seatFor(body);
      const h = loadHost(this.env, body.agent, seat);
      const x = houseRec(h, body.house);
      if (!x) return;
      ((x.inbox ??= {})[rawOf(body)] ??= []).push({ key: message.id, sealed: this.transit.seal(Buffer.from(String(message.text))) });
      writeJson(hostFile(this.env, body.agent, seat), h);
    });
    return { fed: true };
  }

  /**
   * The follow-ups fed to a body that it may never have heard: the ones its house hasn't acknowledged, and the ones its
   * house says are still in its inbox. Null when its host can't say (gone, or stale): then every one fed is unheard.
   */
  unheard(body) {
    const raw = rawOf(body);
    const x = raw ? this.rec(body) : null;
    if (!x) return null;
    return [...new Set([...(x.inbox?.[raw] ?? []).map((y) => y.key), ...(x.report.bodies[raw]?.pending ?? [])])];
  }

  /** Its follow-ups, gone from the record (the runtime keeps its own copies). */
  forgetInbox(body) {
    const raw = rawOf(body);
    if (!raw) return;
    const seat = this.seatFor(body);
    hostLocked(this.env, () => { const h = loadHost(this.env, body.agent, seat); const x = houseRec(h, body.house); if (x?.inbox?.[raw]) { delete x.inbox[raw]; writeJson(hostFile(this.env, body.agent, seat), h); } });
  }

  end(body) {
    const raw = rawOf(body);
    if (!body.agent || !raw) return;
    hostLocked(this.env, () => {
      const seat = this.seatFor(body);
      const h = loadHost(this.env, body.agent, seat);
      const x = houseRec(h, body.house);
      if (!x) return;
      // A stop of its own, with its own time (a pack already asked for stays one): its host carries out each stop once,
      // so an older one still on the record would never end this body (bodyhost.mjs, t-1881).
      (x.stop ??= {})[raw] = { pack: x.stop[raw]?.pack ?? false, at: this.now().getTime() };
      writeJson(hostFile(this.env, body.agent, seat), h);
    });
  }

  /** Ask once, without waiting: an interrupt must survive an unavailable house. */
  requestPack(body) {
    const raw = rawOf(body);
    if (!raw) return false;
    return hostLocked(this.env, () => {
      const seat = this.seatFor(body);
      const h = loadHost(this.env, body.agent, seat);
      const x = houseRec(h, body.house);
      if (!x) return false;
      if (existsSync(packedFile(this.env, body.agent, body.house, raw))) return true;
      if (!x.stop?.[raw]?.pack) {
        const session = x.report?.bodies?.[raw]?.session;
        (x.stop ??= {})[raw] = { pack: true, at: this.now().getTime(), ...(session ? { session } : {}) };
        writeJson(hostFile(this.env, body.agent, seat), h);
      }
      return true;
    });
  }

  packReady(body) {
    const raw = rawOf(body);
    return !!raw && existsSync(packedFile(this.env, body.agent, body.house, raw));
  }

  /** Its session's files, from its house: it's stopped there and its host sends them back. [] when its house is gone. */
  async pack(body, { deferAck = false } = {}) {
    const raw = rawOf(body);
    if (!raw) return [];
    const f = packedFile(this.env, body.agent, body.house, raw);
    const collecting = load(this.env).houses?.[body.house];
    if (!existsSync(f) && !collecting) throw new RunnerError('house metadata is unavailable; native ownership remains held');
    if (!existsSync(f) && collecting?.nativeHistory?.v === 1 && collecting.collection?.phase === 'native') throw new RunnerError('native session collection is still pending on its box');
    // No key here: no slot, at once. It's stopped, and its session stays in its house (thrown away with it).
    if (!this.canSeal()) {
      if (load(this.env).houses?.[body.house]?.nativeHistory?.v === 1) throw new RunnerError('native collection needs its sealing key');
      this.end(body); return null;
    }
    // The native process can end a sync before its host sends the pack. Only
    // termination of the house proves there is no host left to return it.
    if (!this.pending(body) && !existsSync(f)) return [];
    const asked = existsSync(f) || this.requestPack(body);
    if (!asked) {
      if (this.pending(body)) throw new RunnerError('native session collection is still pending');
      return [];
    }
    const end = Date.now() + this.claimMs;
    while (!existsSync(f)) {
      if (Date.now() > end || !this.rec(body)) throw new RunnerError(`${body.agent}'s house didn't send ${body.id}'s session back`);
      await sleep(this.poll);
    }
    const pack = JSON.parse(this.sealer.open(readFileSync(f)).toString('utf-8'));
    const files = pack?.v === 1 && Array.isArray(pack.files) ? pack.files : pack;
    if (!deferAck) this.ackPack(body);
    return files;
  }

  /** The conversation has durably committed its slot: only now discard the received native pack. */
  ackPack(body) {
    const raw = rawOf(body);
    if (!raw) return;
    hostLocked(this.env, () => {
      const seat = this.seatFor(body), h = loadHost(this.env, body.agent, seat), x = houseRec(h, body.house);
      if (x?.stop?.[raw]) { delete x.stop[raw]; writeJson(hostFile(this.env, body.agent, seat), h); }
      rmSync(packedFile(this.env, body.agent, body.house, raw), { force: true });
      rmSync(offlinePin(packedFile(this.env, body.agent, body.house, raw)), { force: true });
    });
  }
}
