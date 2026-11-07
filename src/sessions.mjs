// A harness session's own local files (runners.mjs, sessionFiles/roots), packed for a continuity slot and put back for
// a resume. Used where the harness runs: by the body host in an agent's house, and by delivery with a local runner.
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';

/** A slot's packed session files, at most: past it, no slot is kept (the digests carry the conversation). */
export const MAX_SESSION_BYTES = 6 * 1024 * 1024;

export class SessionError extends Error {}

function readTree(root, rel, out, budget) {
  const p = join(root, rel);
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) { for (const n of readdirSync(p)) readTree(root, join(rel, n), out, budget); return; }
  if (!st.isFile()) return;
  budget.n += st.size;
  if (budget.n > MAX_SESSION_BYTES) throw new SessionError(`its session is over ${MAX_SESSION_BYTES / 1024 / 1024} MB`);
  out.push({ rel, data: readFileSync(p).toString('base64') });
}

/** A rel path that stays under its root. */
export const safeRel = (rel) => typeof rel === 'string' && rel !== '' && !isAbsolute(rel) && !normalize(rel).split(sep).includes('..') && normalize(rel) === rel;

/** The session's files, read: [{root, rel, data}] (base64). */
export function packSession(runner, slot, body) {
  const files = runner.sessionFiles?.(slot, body) ?? { keep: [], drop: [] };
  const out = [];
  const budget = { n: 0 };
  for (const f of files.keep) {
    const got = [];
    readTree(runner.roots[f.root], f.rel, got, budget);
    for (const x of got) out.push({ root: f.root, ...x });
  }
  return out;
}

/**
 * The harness's own local copies gone: its transcript, and the body's job or run dir; then whatever the runner made for
 * bodies that no live one uses now (a Codex body's home, with its copied credentials: runners.mjs, sweepHomes, t-1924).
 */
export function dropSession(runner, slot, body) {
  const files = runner.sessionFiles?.(slot, body) ?? { keep: [], drop: [] };
  for (const f of files.keep) rmSync(join(runner.roots[f.root], f.rel), { recursive: true, force: true });
  for (const p of files.drop) rmSync(p, { recursive: true, force: true });
  try { runner.sweepHomes?.(); } catch { /* locked or unreadable: the next end, or the tick, sweeps */ }
}

/** Packed files back where the harness looks for them. Returns the paths written (to remove if the resume fails). */
export function restoreFiles(runner, files) {
  const written = [];
  for (const f of Array.isArray(files) ? files : []) {
    const root = runner.roots && Object.hasOwn(runner.roots, f.root) ? runner.roots[f.root] : undefined;
    if (!root || !safeRel(f.rel) || typeof f.data !== 'string') throw new SessionError('a session file outside its harness\'s session dirs');
    const p = join(root, f.rel);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, Buffer.from(f.data, 'base64'), { mode: 0o600 });
    written.push(p);
  }
  return written;
}
