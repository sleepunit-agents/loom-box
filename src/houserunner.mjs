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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { outdatedHouse, up } from './control.mjs';
import { pieceName } from './piece.mjs';
import { bodyBox } from './placement.mjs';
import { isParts } from './briefs.mjs';
import { RunnerError } from './runners.mjs';
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
    const at = readJson(join(dir, 'at.json'));
    if (typeof at !== 'number' || nowMs - at >= PARTS_MS) rmSync(dir, { recursive: true, force: true });
  }
  const packed = join(hostsDir(env), 'packed');
  for (const a of ls(packed)) for (const h of ls(join(packed, a))) for (const f of ls(join(packed, a, h))) {
    const p = join(packed, a, h, f);
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
const partDir = (env, agent, house, id) => { if (!safe(agent, house, id)) throw new StateError('not a body of a house', 400); return join(hostsDir(env), 'parts', agent, house, id); };
/**
 * A body's id, as the runtime knows it: its house's id, then the id the house's harness gave it. House ids are never
 * reused, so no house can report an id that's another house's body (another agent's, or its own agent's earlier house).
 */
export const bodyIdOf = (house, raw) => `${house}-${raw}`;
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
      if (!live && !h.draining && !Object.keys(h.req ?? {}).length) rmSync(join(hostsDir(env), n), { force: true });
    });
  }
}
/** One house's part of its agent's host record: the record itself for the agent's house, else that house's draining entry. */
const houseRec = (h, house) => (house && h.house === house ? h : (house && h.draining?.[house]) || null);
const freshRec = (x, house, now) => !!x?.report && now - x.report.at < HOST_STALE_MS && x.report.house === house;
const fresh = (h, now) => freshRec(h, h.house, now);
/** What's one house's in the record (the rest is the agent's). */
const PER_HOUSE = ['report', 'hostHash', 'bootHash', 'req', 'stop', 'inbox', 'claimed', 'cancel'];
/** Draining houses that are over (or gone from the state): nothing of theirs is left to finish. */
function pruneDraining(env, h) {
  if (!h.draining) return;
  let s;
  try { s = load(env); } catch { return; }
  for (const id of Object.keys(h.draining)) if (!LIVE.has(s.houses[id]?.state)) delete h.draining[id];
  if (!Object.keys(h.draining).length) delete h.draining;
}
/** A house a body may still be handed to: asked for, starting or running. One stopping (or gone) never is, however fresh its host's last report. */
const TAKES = new Set(['wanted', 'starting', 'running']);
const LIVE = new Set([...TAKES, 'stopping']);
const houseTakes = (env, id) => { try { return TAKES.has(load(env).houses[id]?.state); } catch { return false; } };

/** What a house runs as its task to be the agent's body host. */
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
      // How its turn went, once over (runners.mjs, turn): a host before t-1763 says nothing.
      ...(b.turn && typeof b.turn === 'object' ? { turn: { failed: b.turn.failed === true, worked: typeof b.turn.worked === 'boolean' ? b.turn.worked : null, ...(typeof b.turn.error === 'string' && b.turn.error ? { error: b.turn.error.slice(0, 200) } : {}),
        // Refused for a usage limit, and when its account has room again (t-1907).
        ...(b.turn.limited === true ? { limited: true, ...(Number.isFinite(b.turn.resets) && b.turn.resets > 0 ? { resets: Math.floor(b.turn.resets) } : {}) } : {}) } } : {}),
    };
  }
  const done = {};
  for (const [rid, d] of Object.entries(r?.done ?? {}).slice(0, 64)) {
    if (!RID.test(rid) || !d || typeof d !== 'object') continue;
    if (typeof d.id === 'string' && BODY_ID.test(d.id)) done[rid] = { id: d.id };
    else done[rid] = { error: String(d.error ?? 'its host couldn\'t start it').slice(0, 300) };
  }
  // What this host can do beyond the first version's: `parts`, a brief that names the agent's files (briefs.mjs).
  const caps = Array.isArray(r?.caps) ? r.caps.filter((c) => c === 'parts') : [];
  return { bodies, done, caps };
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
      delete x.bootHash;
    }
    const { bodies, done, caps } = cleanReport(body?.report);
    // An id this house already gave one request is never another's (a second claim of the same body is refused).
    x.claimed ??= {};
    for (const [rid, d] of Object.entries(done)) {
      if (!d.id || !x.req?.[rid]) continue;
      if (x.claimed[d.id] && x.claimed[d.id] !== rid) done[rid] = { error: `${house} reported ${d.id} for a second request` };
      else x.claimed[d.id] = rid;
    }
    x.report = { at: now, house, bodies, done, caps };
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
    const got = [];
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
      writeFileSync(join(dir, `${p.part}.age`), sealedPart, { mode: 0o600 });
      got.push([id, p.part]);
      const files = Array.from({ length: p.parts }, (_, i) => join(dir, `${i}.age`));
      if (files.every((f) => existsSync(f))) {
        const whole = Buffer.from(files.map((f) => sealer.open(readFileSync(f)).toString()).join(''), 'base64');
        const f = packedFile(env, agent, house, id);
        mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
        writeFileSync(f, sealer.seal(whole), { mode: 0o600 });
        rmSync(dir, { recursive: true, force: true });
      }
    }
    // A stop is done once its body is gone from the report (and its pack, if it was asked for, is in).
    for (const id of Object.keys(x.stop ?? {})) {
      const gone = !bodies[id] || bodies[id].status === 'ended';
      // Done, and its id's claim with it: a resume of its session comes back under that id (t-1881). Only now, once
      // it's gone from the house, never while it may still run there.
      if (gone && (!x.stop[id].pack || existsSync(packedFile(env, agent, house, id)) || now - x.stop[id].at > CLAIM_MS)) { delete x.stop[id]; if (x.claimed) delete x.claimed[id]; }
    }
    const req = {};
    for (const [rid, r] of Object.entries(x.req ?? {})) {
      if (done[rid] || x.cancel[rid]) continue;
      try { req[rid] = JSON.parse(t.open(r.sealed).toString('utf-8')); } catch { /* its text is gone: never started */ }
    }
    const inbox = {};
    for (const [id, items] of Object.entries(x.inbox ?? {})) {
      inbox[id] = items.flatMap((y) => { try { return [{ id: y.key, text: t.open(y.sealed).toString('utf-8') }]; } catch { return []; } });
    }
    if (x === h) pruneDraining(env, h);
    writeJson(hostFile(env, agent, seat), h);
    return { req, stop: x.stop ?? {}, inbox, acked: got, ...(issued ? { hostKey: issued } : {}) };
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
      if (takes && this.drain(agent, h.house, seat)) takes = false;
      else if (fresh(h, now) && takes) return h.house;
      if (!takes) {
        // Never past the cap, and never into another seat's house: the body waits (delivery.mjs asks seatRoom first;
        // this is the same check, for a start that raced past it).
        const full = seatRoom(this.env, agent, seat);
        if (full) throw seatFull(full);
        const s = load(this.env);
        const at = bodyBox(s, agent, this.harness, this.env);
        if (!at.box) throw new RunnerError(at.reason);
        const boot = randomBytes(24).toString('hex');
        // up() checks the cap again in the same state write that makes the house: two starts at once never pass it both.
        let r;
        try { r = this.up(this.env, { now: () => this.now() }, { kind: 'owner' }, { agent, box: at.box, task: hostTask(this.env, boot) }, { kind: 'body-host', seat }); } catch (e) { if (e?.seatFull) throw seatFull(e.message); throw e; }
        // A new house: what was asked of the last one (and what it claimed) isn't this one's, nor is its host's key.
        hostLocked(this.env, () => { const x = loadHost(this.env, agent, seat); x.house = r.id; delete x.report; delete x.hostHash; delete x.cancel; x.bootHash = keyHash(boot); x.req = {}; x.stop = {}; x.inbox = {}; x.claimed = {}; pruneDraining(this.env, x); writeJson(hostFile(this.env, agent, seat), x); });
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
      house = await this.warm(o.agent, seat);
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
        if (d?.error) throw new RunnerError(d.error);
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
    return x && freshRec(x, body.house, this.now().getTime()) ? x : null;
  }

  entry(body) {
    const raw = rawOf(body);
    const x = raw ? this.rec(body) : null;
    if (!x) return null;
    return x.report.bodies[raw] ?? { status: 'ended' };
  }

  status(body) { return this.entry(body)?.status ?? 'unknown'; }
  /** Its harness is still there: its house's host reports it. */
  alive(body) { const e = this.entry(body); return !!e && e.status !== 'ended'; }
  slotOf(body) { const s = this.entry(body)?.session; return s ? { harness: this.harness, session: s } : null; }
  /** How its turn went, as its house's host reports it: null from a host that doesn't say. */
  turn(body) { return this.entry(body)?.turn ?? null; }
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

  /** Its session's files, from its house: it's stopped there and its host sends them back. [] when its house is gone. */
  async pack(body) {
    const raw = rawOf(body);
    if (!raw) return [];
    // No key here: no slot, at once. It's stopped, and its session stays in its house (thrown away with it).
    if (!this.canSeal()) { this.end(body); return null; }
    const f = packedFile(this.env, body.agent, body.house, raw);
    if (!this.alive(body) && !existsSync(f)) return [];
    const asked = hostLocked(this.env, () => {
      const seat = this.seatFor(body);
      const h = loadHost(this.env, body.agent, seat);
      // Its house isn't the agent's house now, nor one draining: nothing there to ask, and nothing to wait for.
      const x = houseRec(h, body.house);
      if (!x) return false;
      (x.stop ??= {})[raw] = { pack: true, at: this.now().getTime() };
      writeJson(hostFile(this.env, body.agent, seat), h);
      return true;
    });
    if (!asked) return [];
    const end = Date.now() + this.claimMs;
    while (!existsSync(f)) {
      if (Date.now() > end || !this.rec(body)) throw new RunnerError(`${body.agent}'s house didn't send ${body.id}'s session back`);
      await sleep(this.poll);
    }
    try { return JSON.parse(this.sealer.open(readFileSync(f)).toString('utf-8')); } finally { rmSync(f, { force: true }); }
  }
}
