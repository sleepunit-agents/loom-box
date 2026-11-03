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
//   GET  /api/loom/venues              → {venues: [{name, label, kind, piece, send?: [argv], orphaned?}]}  (loom#424)
//                                      the venues registry, as core keeps it (conversations.md, "Venues"; agent-runtime.md,
//                                      "Outbound"). A piece reads only its own store, so the runtime asks core, never the
//                                      other pieces' files; a venue's send runs as core answered its argv.
//   POST /api/loom/people/ensure, /people/merge   a person's card, for the gates (person-cards.md; gates.mjs)
//   POST /api/loom/deliver             a delivery the runtime makes itself (an allowed proposal's follow-up)
// The turn write carries `key` ("<source>:<id>", loom#426): the same key and turn answer the first write.
import { readFileSync } from 'node:fs';
import { setting } from './piece.mjs';

export class CoreError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

/** loom's API base, from the MCP URL the runtime is given. */
export const apiBase = (env) => (setting(env, 'LOOM_URL') || 'http://127.0.0.1:8787/mcp').replace(/\/mcp\/?$/, '').replace(/\/+$/, '');

export function coreFrom(env, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const call = async (method, path, body) => {
    const tokenFile = setting(env, 'TOKEN_FILE');
    if (!tokenFile) throw new CoreError('no runtime token (LOOM_RUNTIME_TOKEN_FILE): the runtime can\'t write to core');
    let token;
    try { token = readFileSync(tokenFile, 'utf-8').trim(); } catch { throw new CoreError(`can't read the runtime token file ${tokenFile}`); }
    let r;
    try {
      r = await fetchImpl(`${apiBase(env)}/api/loom/${path}`, {
        method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { throw new CoreError(`core didn't answer ${path}: ${e.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : e.message}`); }
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new CoreError(`core refused ${path}: ${out.error ?? `${r.status}`}`, r.status >= 500 ? 503 : r.status);
    return out;
  };
  const post = (path, body) => call('POST', path, body);
  return {
    async turn(t) {
      const out = await post('conversations/turn', t);
      if (typeof out.conversation !== 'string' || !Number.isSafeInteger(out.seq)) throw new CoreError('core answered a turn write without its conversation and seq');
      return { conversation: out.conversation, seq: out.seq };
    },
    audit: (a) => post('audit', a),
    // A person's card (person-cards.md, "Ensure" and "Merge"): the gates' seam (gates.mjs).
    ensure: (b) => post('people/ensure', b),
    merge: (b) => post('people/merge', b),
    // A delivery the runtime itself makes (a gate's follow-up relay): core's deliver route, as the runtime.
    deliver: (b) => post('deliver', b),
    venues: async () => venuesOf(await call('GET', 'venues')),
  };
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
    out[v.name] = { kind: v.kind, ...(typeof v.label === 'string' ? { label: v.label.slice(0, 40) } : {}), ...(typeof v.piece === 'string' ? { piece: v.piece } : {}), ...(send && v.orphaned !== true ? { send } : {}), ...(v.orphaned === true ? { orphaned: true } : {}) };
  }
  return out;
}
