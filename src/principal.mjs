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
//      history from before this was kept). It only grows: a body's context remembers what it heard.
//   2. Its principal: unknown if anything unplaced steered it; the one non-owner person if exactly one spoke; unknown
//      (several people) if more did; the owner if only the owner did; unknown if nothing did. Never the owner by default.
//   3. A statement: the principal, signed (HMAC-SHA256) with a key only the runtime holds, for one agent and
//      conversation, for 5 minutes (minted for each call). A body gets one through the piece API with the same proof `send` takes; a piece
//      on loom's machine checks one with `loom runtime principal --verify`. The run's key never leaves the runtime.
//   4. A wake: the clock records who a wake is for when it's set, and hands that to the runtime as it fires
//      (`--wake`, loom's machine only). It's taken as the wake's message is queued, so a wake set by a body working
//      for someone else stays theirs.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { membersOf, ownersOf } from './owners.mjs';

export const STATEMENT_TTL_S = 5 * 60;
const PERSON = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_PEOPLE = 20;
/** A wake's hand-over waits this long for its message, then it's dropped. */
const WAKE_FOR_MS = 24 * 3600_000;

/** The agent's owners (owners.mjs): the people whose word is the owner's. */
export const ownersFor = (env, agent) => ownersOf(membersOf(env), agent);

/**
 * Note who steered a conversation, as a message joins its queue: `c.actsFor` grows (never shrinks). `wakeFor` is
 * what the clock handed over for a wake ('owner', a person's slug, '-' for unknown, or undefined: none). `comms` and
 * `wake` venues have no history this can't place (only the owner speaks in a Comms thread; only the clock delivers
 * on venue wake), so a conversation there that ran before this was kept starts clean; any other starts unknown.
 */
export function noteSender(env, c, m, { wakeFor, historyFree = false } = {}) {
  if (!c.actsFor) {
    c.actsFor = { owner: false, people: [], unknown: false, since: m.at };
    // Its earlier runs heard people this never saw: whoever they were, it can't say.
    if ((c.runs ?? 0) > 0 && !historyFree) c.actsFor.unknown = true;
  }
  const a = c.actsFor;
  const owners = ownersFor(env, m.agent);
  const person = (slug) => {
    if (owners.includes(slug)) a.owner = true;
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
  const people = Array.isArray(a?.people) ? a.people.filter((p) => PERSON.test(p)).slice(0, MAX_PEOPLE) : [];
  if (!a || a.unknown) return { for: null, owner: false, people, ...(a?.unknown ? { unknown: true } : {}) };
  if (people.length === 1) return { for: people[0], owner: false, people };
  if (people.length > 1) return { for: null, owner: false, people };
  if (a.owner) return { for: ownersFor(env, c.agent)[0] ?? null, owner: true, people: [] };
  return { for: null, owner: false, people: [] };
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
const wakeKey = (agent, place) => `${agent}\u0000${place}`;
const readMap = (dir) => { try { const d = JSON.parse(readFileSync(wakeFile(dir), 'utf-8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; } };
function writeMap(dir, d) {
  mkdirSync(dirname(wakeFile(dir)), { recursive: true, mode: 0o700 });
  const tmp = `${wakeFile(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(d) + '\n', { mode: 0o600 });
  renameSync(tmp, wakeFile(dir));
}

/** The clock's word on who a firing wake is for: 'owner', a person's slug, or '-' (unknown). The caller holds the lock. */
export function putWakeFor(dir, { agent, place, for: who }, nowMs = Date.now()) {
  if (!(who === 'owner' || who === '-' || PERSON.test(who ?? ''))) throw new Error('--for is owner, a person\'s slug, or - (unknown)');
  const d = Object.fromEntries(Object.entries(readMap(dir)).filter(([, v]) => nowMs - (v?.at ?? 0) < WAKE_FOR_MS));
  d[wakeKey(agent, place)] = { for: who, at: nowMs };
  writeMap(dir, d);
}

/** Take (and drop) the clock's word for this wake: what it said, or undefined. The caller holds the lock. */
export function takeWakeFor(dir, agent, place, nowMs = Date.now()) {
  const d = readMap(dir);
  const k = wakeKey(agent, place);
  const v = d[k];
  if (v === undefined) return undefined;
  delete d[k];
  writeMap(dir, d);
  return nowMs - (v?.at ?? 0) < WAKE_FOR_MS ? v.for : undefined;
}
