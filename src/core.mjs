// What delivery needs of core (loom docs/specs/conversations.md, "Who writes what"), as the runtime:
//
//   POST /api/loom/conversations/turn  {agent, venue, place, at, from, kind, label?, run?, model?, harness?, outcome?}
//                                      → {conversation, seq}           (loom src/conversations.ts, writeTurn)
//   POST /api/loom/audit               {conversation, seq, text}       → {conversation, seq}
//                                      the turn's raw text, by the turn's writer, after the turn (loom src/audit.ts)
//
// Both with the runtime's token (role `runtime`, LOOM_RUNTIME_TOKEN_FILE), at loom's URL (LOOM_RUNTIME_LOOM_URL, its
// /mcp dropped). A refusal keeps core's status; anything else (no URL, no token, core down, a timeout) is a 503.
//
//   GET  /api/loom/venues              → {venues: [{name, label, kind, piece, send?: [argv], adapter?: 'core', orphaned?}]}  (loom#424, comms.md)
//   POST /api/loom/comms/adapter       {op: post|describe|status, place, agent, …}: venue loom's adapter (comms.md)
//   POST /api/loom/comms/activity      {conversation, run, cards, alive?}: a thread's tool cards and its body's last sign of life (comms.md, section 3)
//                                      the venues registry, as core keeps it (conversations.md, "Venues"; agent-runtime.md,
//                                      "Outbound"). A piece reads only its own store, so the runtime asks core, never the
//                                      other pieces' files; a venue's send runs as core answered its argv.
//   POST /api/loom/people/ensure, /people/merge   a person's card, for the gates (person-cards.md; gates.mjs)
//   POST /api/loom/deliver             a delivery the runtime makes itself (an allowed proposal's follow-up)
// The turn write carries `key` ("<source>:<id>", loom#426): the same key and turn answer the first write.
//
// The review job's (conversations.md, "Review"; review.mjs):
//   GET  /api/loom/review/config       → {review: 'on'|'off'|[argv], tz}           (the runtime's token)
//   POST /api/loom/review/token        → {token, expires}: a `review` token for one run, 2 hours
//   POST /api/loom/audit/take {limit}  → {entries: [{ref, agent, venue, kind, family, text, only_families?}]}
//   POST /api/loom/scores {ref, grader_family, score}, /findings {ref, text}, /audit/done {refs}
// the last four with the run's review token, held in memory only: never written, logged or shown.
import { readFileSync } from 'node:fs';
import { setting } from './piece.mjs';

export class CoreError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

/** loom's API base, from the MCP URL the runtime is given. */
export const apiBase = (env) => (setting(env, 'LOOM_URL') || 'http://127.0.0.1:8787/mcp').replace(/\/mcp\/?$/, '').replace(/\/+$/, '');

/** One call to core's API with a bearer token: its JSON answer, or a CoreError keeping core's status (a 5xx as 503). */
async function callCore(env, token, method, path, body, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  let r;
  try {
    r = await fetchImpl(`${apiBase(env)}/api/loom/${path}`, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) { throw new CoreError(`core didn't answer ${path}: ${e.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : e.message}`); }
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new CoreError(`core refused ${path}: ${out.error ?? `${r.status}`}`, r.status >= 500 ? 503 : r.status);
  return out;
}

export function coreFrom(env, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const call = async (method, path, body, ms = timeoutMs) => {
    const tokenFile = setting(env, 'TOKEN_FILE');
    if (!tokenFile) throw new CoreError('no runtime token (LOOM_RUNTIME_TOKEN_FILE): the runtime can\'t write to core');
    let token;
    try { token = readFileSync(tokenFile, 'utf-8').trim(); } catch { throw new CoreError(`can't read the runtime token file ${tokenFile}`); }
    return callCore(env, token, method, path, body, { fetchImpl, timeoutMs: ms });
  };
  const post = (path, body) => call('POST', path, body);
  return {
    async turn(t) {
      const out = await post('conversations/turn', t);
      if (typeof out.conversation !== 'string' || !Number.isSafeInteger(out.seq)) throw new CoreError('core answered a turn write without its conversation and seq');
      return { conversation: out.conversation, seq: out.seq };
    },
    audit: (a) => post('audit', a),
    // Which one conversation a body's house holds (t-2061): said once, before the house is handed its body. Core then
    // takes a digest from that house for that conversation only; a house is never bound to a second.
    bindHouse: ({ agent, house, conversation }) => post('conversations/house', { agent, house, conversation }),
    // A person's card (person-cards.md, "Ensure" and "Merge"): the gates' seam (gates.mjs).
    ensure: (b) => post('people/ensure', b),
    merge: (b) => post('people/merge', b),
    // A delivery the runtime itself makes (a gate's follow-up relay): core's deliver route, as the runtime.
    deliver: (b) => post('deliver', b),
    venues: async () => venuesOf(await call('GET', 'venues')),
    // Venue loom's adapter calls and its threads' tool cards (loom docs/specs/comms.md): core is that venue's adapter.
    // The same 15 s an adapter's argv has (delivery.mjs SEND_MS, ADAPTER_MS): core is this venue's adapter.
    comms: (b) => call('POST', 'comms/adapter', b, 15_000),
    activity: (b) => call('POST', 'comms/activity', b, 15_000),
    // What this piece's manifest says moved (a body at work, or done): core asks for it again now (t-1945).
    changed: () => post('pieces/changed', {}),
    // The review job's: its settings, and a token for one run.
    reviewConfig: async () => reviewConfigOf(await call('GET', 'review/config')),
    async reviewToken() {
      const out = await post('review/token', {});
      if (typeof out.token !== 'string' || !out.token) throw new CoreError('core answered a review token request without a token');
      return { token: out.token, expires: typeof out.expires === 'string' ? out.expires : null };
    },
  };
}

/** A review run's calls, as that run (its review token, held only here). */
export function reviewFrom(env, token, { fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  const post = (path, body) => callCore(env, token, 'POST', path, body, { fetchImpl, timeoutMs });
  return {
    async take(limit) {
      const out = await post('audit/take', { limit });
      if (!Array.isArray(out.entries)) throw new CoreError('core answered a take without entries');
      return out.entries;
    },
    score: (ref, graderFamily, score) => post('scores', { ref, grader_family: graderFamily, score }),
    finding: (ref, text) => post('findings', { ref, text }),
    done: (refs) => post('audit/done', { refs }),
  };
}

/** Core's review settings, checked: {review: 'on'|'off'|[argv], tz}. Anything else is 'on' in UTC, as core's defaults. */
export function reviewConfigOf(raw) {
  const r = raw?.review;
  const review = r === 'off' ? 'off' : Array.isArray(r) && r.length >= 1 && r.length <= 16 && r.every((a) => typeof a === 'string' && a && a.length <= 200) ? [...r] : 'on';
  let tz = typeof raw?.tz === 'string' && raw.tz ? raw.tz : 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'UTC'; }
  return { review, tz };
}

const VENUE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Core's venues answer, checked and keyed by name: {name: {kind, piece, send?}}. The one place its shape is read, so
 * when core's route lands only this changes if the shape does. A row that doesn't fit is left out (no venue, no send).
 */
export function venuesOf(raw) {
  const out = {};
  for (const v of Array.isArray(raw?.venues) ? raw.venues : []) {
    if (!v || !VENUE.test(v.name ?? '') || !['live', 'scheduled', 'agent'].includes(v.kind)) continue;
    const send = Array.isArray(v.send) && v.send.length >= 1 && v.send.length <= 16 && v.send.every((a) => typeof a === 'string' && a && a.length <= 200) ? [...v.send] : undefined;
    // An orphaned venue (its piece removed) keeps its name and kind, and posts nowhere.
    out[v.name] = { kind: v.kind, ...(typeof v.label === 'string' ? { label: v.label.slice(0, 40) } : {}), ...(typeof v.piece === 'string' ? { piece: v.piece } : {}), ...(send && v.orphaned !== true ? { send } : {}),
      // A venue core carries itself (loom): its adapter is core's route, never an argv, and only core's own name it.
      ...(v.adapter === 'core' && v.piece === 'loom' && !send && v.orphaned !== true ? { adapter: 'core' } : {}),
      ...(v.orphaned === true ? { orphaned: true } : {}) };
  }
  return out;
}
