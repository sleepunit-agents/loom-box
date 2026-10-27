// Enrollment by request (t-1617): a new box asks to join, the owner lets it in or
// blocks it on loom's page, and nobody handles a credential.
//
//   box:   join-request {name, labels, facts, proof_hash}   (a stranger: loom's piece API with
//          no token, on a path this piece declares in its loom block)
//          → {id, code, expires}; the box shows the code
//   owner: a card on Home, "a box asks to join: <name> from <address>, code <code>"
//          with Let it in / Block (the page's allow-join / block-join)
//   box:   join-poll {id, proof} every few seconds → pending | blocked | {allowed, credential}
//
// The box keeps `proof`, a random secret, and sends only its hash with the
// request. The credential goes only to whoever shows the proof, once, and the
// code (from the same hash) lets the owner match the card to the terminal in
// front of them. Requests are capped (a few, per address and in all) and
// expire, so a stranger can't fill the page.
import { createHash, randomBytes } from 'node:crypto';
import { BOX_NAME, StateError, update } from './state.mjs';
import { BOX_ID, addBox } from './control.mjs';

const TTL_MS = 15 * 60_000;
const MAX_PENDING = 20;         // in all: generous, so a few addresses can't fill it
const MAX_PER_NET = 2;          // per /24 (IPv4) or /64 (IPv6)
const HASH = /^[0-9a-f]{64}$/;
const ID = /^j-[0-9a-f]{8}$/;
const FACT = /^[a-z][a-z0-9-]{0,31}(:[A-Za-z0-9._ +-]{1,64})?$/;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

const fail = (message, status = 400) => { throw new StateError(message, status); };
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** The code both the box and the card show: from the proof's hash, so neither side can pick it. */
export function codeOf(proofHash) {
  let n = parseInt(proofHash.slice(0, 12), 16);
  let c = '';
  for (let i = 0; i < 6; i++) { c += CODE_CHARS[n % CODE_CHARS.length]; n = Math.floor(n / CODE_CHARS.length); }
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}

/** The box side: a fresh proof and the hash it sends. */
export function newProof() {
  const proof = randomBytes(32).toString('hex');
  return { proof, proofHash: sha(proof), code: codeOf(sha(proof)) };
}

function sweep(s, now) {
  s.joins ??= {};
  for (const [id, j] of Object.entries(s.joins)) {
    if (now - Date.parse(j.at) > TTL_MS || j.state === 'delivered') delete s.joins[id];
  }
}

const stranger = (caller) => {
  if (caller?.kind !== 'stranger') fail('a join request comes from a box that has no credential yet', 403);
  const a = String(caller.address ?? '').replace(/^::ffff:/, '');
  if (!a || a === 'unknown') fail('a join request needs an address to come from', 400);
  return a.slice(0, 64);
};

/** The network an address is in, for the per-network limit: a /24 for IPv4, a /64 for IPv6. */
export function netOf(address) {
  const a = String(address).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '').replace(/^::ffff:(?=\d+\.)/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) return a.split('.').slice(0, 3).join('.') + '.0/24';
  // The whole address first: '::' stands for however many zero groups, so the first four
  // groups of the compressed form aren't the /64's.
  let [head, tail] = a.includes('::') ? a.split('::') : [a, undefined];
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : (tail ? tail.split(':') : []);
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return `other:${a}`;
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

export function joinRequest(env, effects, caller, b) {
  const address = stranger(caller);
  const name = String(b.name ?? '').toLowerCase();
  if (!BOX_NAME.test(name)) fail('a box name is lowercase letters, digits, dots, dashes and underscores');
  if (BOX_ID.test(name)) fail('that looks like a box id; a name is what you call it');
  if (!HASH.test(b.proof_hash ?? '')) fail('proof_hash is the sha256 of a secret the box keeps');
  const facts = Array.isArray(b.facts) ? b.facts.filter((f) => typeof f === 'string' && FACT.test(f)).slice(0, 32) : [];
  const labels = Array.isArray(b.labels) ? b.labels.filter((f) => typeof f === 'string' && FACT.test(f)).slice(0, 16) : [];
  const now = effects.now().getTime();
  return update(env, (s) => {
    sweep(s, now);
    const pending = Object.values(s.joins).filter((j) => j.state === 'pending');
    // A name is only what it's called: loom gives the box its own id when it's let in, so
    // two boxes may both be one (Jonathan, 2026-10-27).
    const given = name;
    if (pending.length >= MAX_PENDING) fail('too many boxes are asking to join right now; try again later', 429);
    if (pending.filter((j) => netOf(j.address) === netOf(address)).length >= MAX_PER_NET) fail('this network is already asking; wait for the owner', 429);
    const id = 'j-' + randomBytes(4).toString('hex');
    const at = new Date(now).toISOString();
    s.joins[id] = { id, name: given, labels, facts, address, proofHash: b.proof_hash, code: codeOf(b.proof_hash), at, state: 'pending' };
    return { id, code: s.joins[id].code, name: given, expires: new Date(now + TTL_MS).toISOString() };
  });
}

export function joinPoll(env, effects, caller, b) {
  stranger(caller);
  if (!ID.test(b.id ?? '') || typeof b.proof !== 'string') fail('join-poll takes the request id and its proof');
  const now = effects.now().getTime();
  return update(env, (s) => {
    sweep(s, now);
    const j = s.joins[b.id];
    if (!j) return { state: 'gone' };
    if (sha(b.proof) !== j.proofHash) fail('that proof isn\'t this request\'s', 403);
    if (j.state === 'pending') return { state: 'pending' };
    if (j.state === 'blocked') { delete s.joins[b.id]; return { state: 'blocked' }; }
    // Allowed: the credential, once, to the box that holds the proof; then it's gone from here.
    const credential = j.credential;
    j.state = 'delivered';
    delete j.credential;
    return { state: 'allowed', box: j.box, name: j.name, credential };
  });
}

/** What's waiting for the owner, for the page. */
export function pendingJoins(s, now = Date.now()) {
  return Object.values(s.joins ?? {}).filter((j) => j.state === 'pending' && now - Date.parse(j.at) <= TTL_MS);
}

/** The owner lets it in: the box is added (may host anyone, as Add a box does), its credential waits for its poll. */
export function allowJoin(env, effects, { id }) {
  if (!ID.test(id ?? '')) fail('that isn\'t a join request');
  const now = effects.now().getTime();
  let j;
  update(env, (s) => {
    sweep(s, now);
    j = s.joins[id];
    if (!j || j.state !== 'pending') fail('that request is gone (it expired, or was answered)', 404);
  });
  const { box, name, token } = addBox(env, effects, { name: j.name, mayHost: 'anyone', labels: j.labels });
  update(env, (s) => {
    const k = s.joins?.[id];
    if (k) { k.state = 'allowed'; k.box = box; k.credential = token; k.answered = new Date(now).toISOString(); }
  });
  return { box, name, code: j.code };
}

export function blockJoin(env, effects, { id }) {
  if (!ID.test(id ?? '')) fail('that isn\'t a join request');
  return update(env, (s) => {
    sweep(s, effects.now().getTime());
    const j = s.joins[id];
    if (!j || j.state !== 'pending') fail('that request is gone (it expired, or was answered)', 404);
    j.state = 'blocked';
    return { name: j.name };
  });
}

/** The owner clears every waiting request at once (a flood of strangers). */
export function blockAllJoins(env, effects) {
  return update(env, (s) => {
    sweep(s, effects.now().getTime());
    let n = 0;
    for (const j of Object.values(s.joins)) if (j.state === 'pending') { j.state = 'blocked'; n++; }
    return { blocked: n };
  });
}
