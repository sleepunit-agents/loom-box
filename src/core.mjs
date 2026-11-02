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
// And the venues (conversations.md, "Venues"; agent-runtime.md, "Outbound"): which piece declares each venue, its
// kind and its `send` argv, read from the managed pieces' records ($LOOM_HOME/pieces/<name>/piece.json, as core reads
// them), with argv[0] one of that piece's bins, run from the managed bin dir.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setting } from './piece.mjs';

export class CoreError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

/** loom's API base, from the MCP URL the runtime is given. */
export const apiBase = (env) => (setting(env, 'LOOM_URL') || 'http://127.0.0.1:8787/mcp').replace(/\/mcp\/?$/, '').replace(/\/+$/, '');

export function coreFrom(env, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const post = async (path, body) => {
    const tokenFile = setting(env, 'TOKEN_FILE');
    if (!tokenFile) throw new CoreError('no runtime token (LOOM_RUNTIME_TOKEN_FILE): the runtime can\'t write to core');
    let token;
    try { token = readFileSync(tokenFile, 'utf-8').trim(); } catch { throw new CoreError(`can't read the runtime token file ${tokenFile}`); }
    let r;
    try {
      r = await fetchImpl(`${apiBase(env)}/api/loom/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { throw new CoreError(`core didn't answer ${path}: ${e.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : e.message}`); }
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new CoreError(`core refused ${path}: ${out.error ?? `${r.status}`}`, r.status >= 500 ? 503 : r.status);
    return out;
  };
  return {
    async turn(t) {
      const out = await post('conversations/turn', t);
      if (typeof out.conversation !== 'string' || !Number.isSafeInteger(out.seq)) throw new CoreError('core answered a turn write without its conversation and seq');
      return { conversation: out.conversation, seq: out.seq };
    },
    audit: (a) => post('audit', a),
  };
}

const loomHome = (env) => env.LOOM_HOME || join(env.HOME || '', '.config', 'loom');

/** Every venue the managed pieces declare: {name: {piece, label, kind, send?: [abs bin, ...args]}}. */
export function venuesFrom(env) {
  const root = join(loomHome(env), 'pieces');
  const out = {};
  let names = [];
  try { names = readdirSync(root); } catch { return out; }
  for (const name of names) {
    let rec;
    try { rec = JSON.parse(readFileSync(join(root, name, 'piece.json'), 'utf-8')); } catch { continue; }
    const venues = rec?.loom?.venues;
    if (!venues || typeof venues !== 'object') continue;
    for (const [v, d] of Object.entries(venues)) {
      if (!d || typeof d !== 'object') continue;
      const send = Array.isArray(d.send) && d.send.every((a) => typeof a === 'string') && Array.isArray(rec.bins) && rec.bins.includes(d.send[0]) && existsSync(join(root, 'bin', d.send[0]))
        ? [join(root, 'bin', d.send[0]), ...d.send.slice(1)] : undefined;
      out[v] = { piece: rec.name ?? name, label: d.label, kind: d.kind, ...(send ? { send } : {}) };
    }
  }
  return out;
}
