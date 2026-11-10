// On whose behalf (t-1943). The owner's ruling, 2026-11-07: his standing permissions and approvals cover work an
// agent does for him. Work done for anyone else needs a grant he gave for that person, or it asks. So a piece that
// decides by permission (approvals, the clock's wakes) needs to know who a body acts for: its *principal*.
//
// The runtime is where that's known, so it's the root of trust. Core vouches for a house's caller (agent, house,
// service), never for a conversation. The runtime queues every message a body hears, with its sender, and already
// proves "this is the body holding conversation cv, in its current run" for `send` (the run's key and its session).
//
//   1. Each conversation keeps `actsFor`: whether its owner spoke, the non-owner people who did, and whether anything
//      it can't place steered it (a relay from another agent, a sender it can't name, a wake with no record, or
//      history from before this was kept). It only grows, for good: a body's context remembers what it heard, so a
//      conversation once unknown asks from then on (fails closed), until the owner vouches for it (--reset).
//   2. Its principal: unknown if anything unplaced steered it; the one non-owner person if exactly one spoke; unknown
//      (several people) if more did; the owner if only the owner did; unknown if nothing did. Never the owner by default.
//   3. A statement: the principal, signed (HMAC-SHA256) with a key only the runtime holds, for one agent and
//      conversation, for 5 minutes (minted for each call). A body gets one through the piece API with the same proof `send` takes; a piece
//      on loom's machine checks one with `loom runtime principal --verify`. The run's key never leaves the runtime.
//   4. A wake: the clock records who a wake is for when it's set, and hands that to the runtime as it fires
//      (`--wake`, loom's machine only). It's taken as the wake's message is queued, so a wake set by a body working
//      for someone else stays theirs.
//
// Houses (t-1952): one per steering principal. A body runs in the house of whom its conversation acts for (seatOf):
// the owner's work in the agent's one owner house, a person's in that person's own, an unknown principal's in a house
// of that conversation alone. So a body can't read the run key or session of a conversation steered by someone else:
// they're files in another container. A principal that changes moves the body (delivery.mjs, plan: reseat).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { membersOf, ownersOf } from './owners.mjs';
import { setting } from './piece.mjs';

export const STATEMENT_TTL_S = 5 * 60;   // README: 5 minutes
const PERSON = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_PEOPLE = 20;
/** A wake's hand-over waits this long for its message, then it's dropped. */
const WAKE_FOR_MS = 24 * 3600_000;

/** The agent's owners (owners.mjs): the people whose word is the owner's. */
export const ownersFor = (env, agent) => ownersOf(membersOf(env), agent);

/**
 * Note who steered a conversation, as a message joins its queue: `c.actsFor` grows (never shrinks). `wakeFor` is
 * what the clock handed over for a wake ('owner', a person's slug, '-' for unknown, or undefined: none). A
 * conversation that ran before this was kept, in any venue, starts unknown: its earlier runs heard people this never
 * saw, and a body resumes their session or their digests. Messages already waiting in its queue are noted first (the
 * body will hear them). Only the owner clears it (`loom runtime principal --reset`, resetActsFor).
 */
export function noteSender(env, c, m, { wakeFor } = {}) {
  if (!c.actsFor) {
    c.actsFor = { owner: false, people: [], unknown: (c.runs ?? 0) > 0 || (c.runLog ?? []).length > 0 };
    for (const q of c.queue ?? []) noteOne(env, c.actsFor, { ...q, agent: c.agent }, undefined);
  }
  // A local wake (t-1830) is no exception: the clock says whom every wake it fires is for (`--wake --for`, its explicit
  // word: `owner` for one set on loom's machine), and a wake with no word (its hand-over failed, or expired) is unknown,
  // as anywhere (fail closed; the clock logs `principal-fail`).
  return noteOne(env, c.actsFor, m, wakeFor);
}

/**
 * The owner's word that a conversation is his from here (loom's machine only): what it heard before is set aside.
 * What still waits in its queue, the body hasn't heard yet: that's noted again, as at the first message.
 */
export function resetActsFor(env, c, at, { dir, by, counted = [] } = {}) {
  c.actsFor = { owner: false, people: [], unknown: false, reset: at };
  // Who made it, signed with the runtime's key (t-1952): only a signed reset vouches a local conversation for a body
  // on loom's machine (delivery.mjs, localForeign). An unsigned one (from before, or a test's) sets the record aside
  // and vouches for nothing more.
  if (dir && by) { c.actsFor.resetBy = by; c.actsFor.resetSig = b64u(sign(signingKey(dir), resetPayload(c, at, by))); }
  // Waiting messages are noted again, as at the first message: a person's as theirs, a wake as whom the clock said
  // (t-1975: kept on its queue row). Only those the owner was shown on the card he allowed (`counted`, their keys:
  // delivery.mjs shownRows, never a person's, never a wake the clock named someone for) count as his; anything else
  // waiting, a relay from an agent included, is noted as ever.
  for (const q of c.queue ?? []) {
    if (counted.includes(q.key) && q.from?.kind !== 'person') { c.actsFor.owner = true; continue; }
    noteOne(env, c.actsFor, { ...q, agent: c.agent }, q.wakeFor);
  }
  return c.actsFor;
}

const resetPayload = (c, at, by) => JSON.stringify(['reset', 1, c.agent, c.conversation, at, by]);
/** Whether a conversation's reset was the owner's, made here: signed with this runtime's key, for it, by the owner. */
export function resetSigned(dir, c) {
  const a = c?.actsFor;
  if (typeof a?.reset !== 'string' || a.resetBy !== 'owner' || typeof a.resetSig !== 'string') return false;
  const key = signingKey(dir, { make: false });
  if (!key) return false;
  const want = sign(key, resetPayload(c, a.reset, a.resetBy));
  const got = Buffer.from(a.resetSig, 'base64url');
  return got.length === want.length && timingSafeEqual(got, want);
}

function noteOne(env, a, m, wakeFor) {
  const owners = ownersFor(env, m.agent);
  const person = (slug) => {
    if (owners.includes(slug)) {
      // Which owner spoke too, when an agent has more than one: the statement names them.
      a.owner = true;
      if (!Array.isArray(a.owners)) a.owners = [];
      if (!a.owners.includes(slug) && a.owners.length < MAX_PEOPLE) a.owners.push(slug);
    }
    else if (!a.people.includes(slug)) {
      if (a.people.length >= MAX_PEOPLE) a.unknown = true;
      else a.people.push(slug);
    }
  };
  if (m.from?.kind === 'person' && PERSON.test(m.from.slug ?? '')) person(m.from.slug);
  else if (m.from?.kind === 'schedule') {
    if (wakeFor === 'owner') a.owner = true;
    else if (typeof wakeFor === 'string' && PERSON.test(wakeFor)) person(wakeFor);
    else a.unknown = true;
  } else a.unknown = true;     // a relay from another agent, or a sender no one can name
  return a;
}

/**
 * A conversation's principal: {for, owner, people}. `for` is the one person it acts for (the owner's slug when it's
 * the owner's), or null when that can't be said (unknown, several people, nothing heard). `owner` is true only when
 * every voice it heard was the owner's. `people` names the non-owners who spoke, for the owner to read.
 */
export function principalOf(env, c) {
  const a = c?.actsFor;
  // Who owns the agent is read now, not when they spoke: a member who no longer owns it is a person like any other.
  const owners = ownersFor(env, c?.agent);
  const former = Array.isArray(a?.owners) ? a.owners.filter((p) => PERSON.test(p) && !owners.includes(p)) : [];
  const people = [...new Set([...(Array.isArray(a?.people) ? a.people.filter((p) => PERSON.test(p)) : []), ...former])].slice(0, MAX_PEOPLE);
  if (!a || a.unknown) return { for: null, owner: false, people, ...(a?.unknown ? { unknown: true } : {}) };
  if (people.length === 1) return { for: people[0], owner: false, people };
  if (people.length > 1) return { for: null, owner: false, people };
  if (a.owner) {
    // The owner who spoke (one of several, the first); a wake the clock called the owner's names the first owner.
    // Named only when one owner (still an owner now) spoke; several, or a wake the clock called the owner's, name the
    // agent's sole owner if it has one, else no one. `owner` is what approvals reads; `for` is for the card.
    const spoke = Array.isArray(a.owners) ? [...new Set(a.owners.filter((p) => PERSON.test(p) && owners.includes(p)))] : [];
    return { for: spoke.length === 1 ? spoke[0] : spoke.length === 0 && owners.length === 1 ? owners[0] : null, owner: true, people: [] };
  }
  return { for: null, owner: false, people: [] };
}

// ─── Seats: whose house a body runs in (t-1952) ────────────────────────────

/** A house's seat: `owner`, `p-<person>` (one non-owner person's) or `u-<conversation>` (an unknown principal's). */
export const SEAT = /^(owner|p-[a-z0-9]+(-[a-z0-9]+)*|u-cv-[0-9a-f]{12}|j-h-[0-9]{1,9})$/;
export const OWNER_SEAT = 'owner';
/**
 * A body host record's key (t-2092): its seat, and when its bodies need something of their box (a worker role's
 * `needs`, box facts like gpu:5090) a short hash of those needs, `<seat>~<hash>`. One seat's needs house is still that
 * seat's alone: the key only ever narrows the seat, never joins two. The seat cap counts seats, so a seat's needs
 * house and its plain one are one seat's.
 */
export const HOST_KEY = /^(owner|p-[a-z0-9]+(-[a-z0-9]+)*|u-cv-[0-9a-f]{12}|j-h-[0-9]{1,9})(~[0-9a-f]{10})?$/;
export const needsKey = (needs) => {
  const n = [...new Set((needs ?? []).map(String))].sort();
  return n.length ? createHash('sha256').update(n.join('\n')).digest('hex').slice(0, 10) : '';
};
export const hostKeyOf = (seat, needs) => { const k = needsKey(needs); return k ? `${seat}~${k}` : seat; };
export const seatOfKey = (key) => String(key ?? '').split('~')[0];

/**
 * Whose house a conversation's body runs in, by its principal (principalOf): the owner's only when every voice was the
 * owner's; one non-owner person's, theirs; anything else (unknown, several people, nothing heard) is a house of this
 * conversation alone, never shared: two unknowns are no more one principal than two strangers are.
 */
export function seatOf(p, conversation) {
  if (p?.owner === true) return OWNER_SEAT;
  if (typeof p?.for === 'string' && PERSON.test(p.for) && p.for.length <= 40) return `p-${p.for}`;
  if (!/^cv-[0-9a-f]{12}$/.test(conversation ?? '')) throw new Error('an unknown principal\'s seat is its conversation\'s');
  return `u-${conversation}`;
}

/**
 * Whether a conversation's own session (its slot) may follow it from seat `was` to seat `now`: resumed only in the
 * seat it began in, or moved from the owner's seat into this conversation's own unknown house (no one else's bodies
 * are there; a relay's answer into his thread lands that way). Never into a person's house (it runs their other
 * conversations, whose bodies could read the transcript), and never out of one: a session a person steered goes
 * nowhere but their house, so one person's context never reaches another's work, and the owner's house never
 * inherits a session someone else steered. Otherwise the session is dropped and a fresh body reads the digests.
 */
export function carriesSession(was, now, conversation) {
  const w = was ?? OWNER_SEAT;
  const n = now ?? OWNER_SEAT;
  return w === n || (w === OWNER_SEAT && n === `u-${conversation}`);
}

/** The houses for seats other than the owner's, at work for an agent in state `s`, but `seat`'s own. */
export function otherSeatHouses(s, agent, seat) {
  const LIVE = new Set(['wanted', 'starting', 'running', 'stopping']);
  const of = (h) => (typeof h?.seat === 'string' && SEAT.test(h.seat) ? h.seat : OWNER_SEAT);
  const host = (h) => h.kind === 'body-host' || /^loom-runtime body-host /.test(String(h.task ?? ''));
  return Object.values(s?.houses ?? {}).filter((h) => h.agent === agent && !h.collection && LIVE.has(h.state) && host(h) && of(h) !== OWNER_SEAT && !/^j-h-[0-9]{1,9}$/.test(of(h)) && of(h) !== seat);
}

/** The cap on an agent's houses for other people (LOOM_RUNTIME_SEAT_HOUSES, default 4). */
export const SEAT_HOUSES = 4;
export const seatCap = (env) => { const v = setting(env ?? {}, 'SEAT_HOUSES'); const n = Number(v); return v !== undefined && Number.isInteger(n) && n >= 1 && n <= 64 ? n : SEAT_HOUSES; };
/** Why a house for `seat` can't be had at the cap, or null. The owner's is never capped. */
export function seatCapProblem(env, s, agent, seat) {
  if (seat === OWNER_SEAT || /^j-h-[0-9]{1,9}$/.test(seat)) return null;
  // Counted by seat: a seat's draining house and its new one are one seat's.
  const seats = new Set(otherSeatHouses(s, agent, seat).map((h) => h.seat)).size;
  const cap = seatCap(env);
  return seats >= cap ? `${agent} already has ${seats} house${seats === 1 ? '' : 's'} at work for other people (the cap is ${cap}, LOOM_RUNTIME_SEAT_HOUSES): it waits for one to idle out` : null;
}

// ─── Statements ─────────────────────────────────────────────────────────────

const b64u = (b) => Buffer.from(b).toString('base64url');
const keyFile = (dir) => join(dir, 'principal.key');

/** The runtime's signing key: made once (32 random bytes, 0600). `make: false` reads only, and answers null. */
function signingKey(dir, { make = true } = {}) {
  try { const k = readFileSync(keyFile(dir)); if (k.length >= 32) return k; } catch { /* none yet */ }
  if (!make) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Made exclusively: two first statements at once share one key (the loser reads the winner's).
  try { writeFileSync(keyFile(dir), randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e?.code !== 'EEXIST') throw e; }
  return readFileSync(keyFile(dir));
}

const sign = (key, payload) => createHmac('sha256', key).update(payload).digest();

/** A signed statement of a conversation's principal, for its agent: `<payload>.<mac>`, both base64url. */
export function mint(dir, { agent, conversation, principal }, nowMs = Date.now()) {
  const p = b64u(JSON.stringify({ v: 1, agent, conversation, for: principal.for, owner: principal.owner === true, people: principal.people ?? [], exp: Math.floor(nowMs / 1000) + STATEMENT_TTL_S }));
  return `${p}.${b64u(sign(signingKey(dir), p))}`;
}

/** A statement checked: {ok: true, agent, conversation, for, owner, people, exp} or {ok: false, reason}. */
export function verify(dir, statement, nowMs = Date.now()) {
  const s = String(statement ?? '').trim();
  const m = /^([A-Za-z0-9_-]{1,4000})\.([A-Za-z0-9_-]{43})$/.exec(s);
  if (!m) return { ok: false, reason: 'not a statement' };
  const key = signingKey(dir, { make: false });
  if (!key) return { ok: false, reason: 'this runtime has made no statements' };
  const want = sign(key, m[1]);
  const got = Buffer.from(m[2], 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'its signature doesn\'t match' };
  let p;
  try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf-8')); } catch { return { ok: false, reason: 'not a statement' }; }
  if (p?.v !== 1 || typeof p.agent !== 'string' || typeof p.conversation !== 'string' || !Number.isInteger(p.exp)) return { ok: false, reason: 'not a statement' };
  if (p.exp * 1000 <= nowMs) return { ok: false, reason: 'it expired' };
  return { ok: true, agent: p.agent, conversation: p.conversation, for: typeof p.for === 'string' ? p.for : null, owner: p.owner === true, people: Array.isArray(p.people) ? p.people : [], exp: p.exp };
}

// ─── A wake's hand-over (the clock, on loom's machine) ──────────────────────

const wakeFile = (dir) => join(dir, 'wake-for.json');
const wakeKey = (agent, place, id) => `${agent}\u0000${place}\u0000${id}`;
const readMap = (dir) => { try { const d = JSON.parse(readFileSync(wakeFile(dir), 'utf-8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; } };
function writeMap(dir, d) {
  mkdirSync(dirname(wakeFile(dir)), { recursive: true, mode: 0o700 });
  const tmp = `${wakeFile(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(d) + '\n', { mode: 0o600 });
  renameSync(tmp, wakeFile(dir));
}

/**
 * The clock's word on who a firing wake is for: 'owner', a person's slug, or '-' (unknown), for exactly that wake
 * (agent, place and the delivery's id): a word for a wake that never arrives is never another wake's. The caller
 * holds the lock.
 */
export function putWakeFor(dir, { agent, place, id, for: who, origin }, nowMs = Date.now()) {
  if (!(who === 'owner' || who === '-' || PERSON.test(who ?? ''))) throw new Error('--for is owner, a person\'s slug, or - (unknown)');
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('--id is the wake delivery\'s id');
  if (origin !== undefined && !/^cv-[0-9a-f]{12}$/.test(origin)) throw new Error('--origin-conversation is a conversation id');
  const d = Object.fromEntries(Object.entries(readMap(dir)).filter(([, v]) => nowMs - (v?.at ?? 0) < WAKE_FOR_MS));
  d[wakeKey(agent, place, id)] = { for: who, at: nowMs, ...(origin ? { origin } : {}) };
  writeMap(dir, d);
}

/** Take (and drop) the clock's word for this wake (agent, place, id): what it said, or undefined. The caller holds the lock. */
export function takeWakeContext(dir, agent, place, id, nowMs = Date.now()) {
  const d = readMap(dir);
  const k = wakeKey(agent, place, id);
  const v = d[k];
  if (v === undefined) return undefined;
  delete d[k];
  writeMap(dir, d);
  return nowMs - (v?.at ?? 0) < WAKE_FOR_MS ? v : undefined;
}

/** Compatibility reader when the caller only needs the principal. */
export const takeWakeFor = (...args) => takeWakeContext(...args)?.for;
