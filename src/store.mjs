// The runtime's own store in loom (loom docs/specs/piece-storage.md): collections of JSON documents, each write a
// revision, through `loom store <piece> …` on loom's machine. Who may write is core's to say: loom gives an owner's
// page action, or the owner's own run of `loom runtime …`, a grant for the owner-written collections (`grants`,
// `gates`), and the piece's own processes write its piece collections (`gate-proposals`). Reads are anyone's on
// loom's machine. The runtime reads and writes only its own store, never another piece's.
import { spawnSync } from 'node:child_process';
import { pieceName } from './piece.mjs';

export class StoreError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

/** A store over `loom store <piece>`: get → {doc, rev} | null; put → rev; del; list → [{key, doc, rev}]. */
export function loomStore(env = process.env, { run = spawnSync, piece = pieceName(env) } = {}) {
  const loom = env.LOOM_BIN || 'loom';
  const call = (args, input) => {
    if (env.HOUSE_ID) throw new StoreError('the runtime store lives on loom, not in a house; use the runtime API');
    const r = run(loom, ['store', piece, ...args], { env, encoding: 'utf-8', input, timeout: 20_000, stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.error) throw new StoreError(`loom store: can't run ${loom}: ${r.error.message}`);
    return r;
  };
  const why = (r) => (r.stderr || '').trim().split('\n').find((line) => line.trim() && !/^[{}\[\]]$/.test(line.trim()))?.replace(/^loom store: /, '').slice(0, 300) || `exit ${r.status}`;
  return {
    get(collection, key) {
      const r = call(['get', collection, key]);
      // Exit 3 is also `loom store`'s "no managed piece named …": that's no store read, never "nothing written" (an
      // empty grants document allows everyone).
      if (r.status === 3 && /no managed piece/.test(r.stderr || '')) throw new StoreError(`loom store: ${why(r)}`);
      if (r.status === 3) return null;
      if (r.status !== 0) throw new StoreError(`loom store: ${why(r)}`);
      const d = JSON.parse(r.stdout);
      return { doc: d.doc, rev: d.rev };
    },
    put(collection, key, doc, ifRev) {
      const r = call(['put', collection, key, ...(ifRev !== undefined ? ['--if-rev', String(ifRev)] : [])], JSON.stringify(doc));
      if (r.status === 4) throw new StoreError('someone changed it since you opened it: reload and try again', 409);
      if (r.status !== 0) throw new StoreError(`loom store: ${why(r)}`, /only .* writes|written only by/.test(r.stderr || '') ? 403 : 503);
      return JSON.parse(r.stdout).rev;
    },
    del(collection, key) {
      const r = call(['del', collection, key]);
      if (r.status !== 0 && r.status !== 3) throw new StoreError(`loom store: ${why(r)}`);
    },
    list(collection, prefix) {
      const r = call(['list', collection, ...(prefix ? ['--prefix', prefix] : []), '--limit', '1000']);
      if (r.status !== 0) throw new StoreError(`loom store: ${why(r)}`);
      return JSON.parse(r.stdout || '[]').map((d) => ({ key: d.key, doc: d.doc, rev: d.rev }));
    },
  };
}

/** The same in memory, for the tests: `writable(collection)` says whether this caller may write there. */
export function memStore({ writable = () => true } = {}) {
  const docs = new Map();
  const k = (c, key) => `${c}\0${key}`;
  return {
    docs,
    get(c, key) { const d = docs.get(k(c, key)); return d ? { doc: structuredClone(d.doc), rev: d.rev } : null; },
    put(c, key, doc, ifRev) {
      if (!writable(c)) throw new StoreError(`${c} is written only by a household owner, on the page`, 403);
      const cur = docs.get(k(c, key));
      if (ifRev !== undefined && (cur?.rev ?? 0) !== ifRev) throw new StoreError('someone changed it since you opened it: reload and try again', 409);
      const rev = (cur?.rev ?? 0) + 1;
      docs.set(k(c, key), { doc: structuredClone(doc), rev });
      return rev;
    },
    del(c, key) { if (!writable(c)) throw new StoreError(`${c} is written only by a household owner`, 403); docs.delete(k(c, key)); },
    list(c, prefix = '') {
      return [...docs.entries()].filter(([kk]) => kk.startsWith(`${c}\0${prefix}`)).map(([kk, d]) => ({ key: kk.slice(c.length + 1), doc: structuredClone(d.doc), rev: d.rev }));
    },
  };
}
