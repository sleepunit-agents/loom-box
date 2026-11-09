// Offline readers only. The box must first establish physical house termination.
// A container PID is never interpreted as a PID on the box, nor is native work
// started, resumed, queried through a CLI, or stopped from this module.
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { HISTORY_DIRS, historyPaths } from './native-history.mjs';
import { ClaudeRunner, CodexRunner } from './runners.mjs';
import { packSession } from './sessions.mjs';

const stat = file => { try { return lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const inside = (root, file) => { const rel = relative(resolve(root), resolve(file)); return rel === '' || !rel.startsWith('../') && rel !== '..' && !isAbsolute(rel); };

/** Copy only native history into a private, bounded plain-file snapshot. No
 * agent-controlled links reach the host's adapter readers. Failed snapshots
 * never replace a published one or delete the original history. */
export function snapshotNativeHistory(root, target, { maxBytes = 64 * 1024 * 1024, maxEntries = 10_000 } = {}) {
  if (inside(root, target) || inside(target, root) || stat(target)) throw Error('native history snapshot needs a new separate directory');
  if (!stat(root)?.isDirectory() || stat(root).isSymbolicLink()) throw Error('native history root is not plain');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(dirname(target), '.native-history-'));
  let bytes = 0, entries = 0;
  const copy = (source, dest) => {
    const current = lstatSync(source);
    if (++entries > maxEntries) throw Error('native history snapshot has too many entries');
    if (current.isSymbolicLink()) throw Error('native history snapshot refuses links');
    if (current.isDirectory()) {
      mkdirSync(dest, { mode: 0o700 });
      for (const name of readdirSync(source)) copy(join(source, name), join(dest, name));
      return;
    }
    if (!current.isFile() || current.nlink !== 1) throw Error('native history snapshot needs plain files');
    bytes += current.size;
    if (bytes > maxBytes) throw Error('native history snapshot is too large');
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = fstatSync(fd);
      if (!actual.isFile() || actual.dev !== current.dev || actual.ino !== current.ino || actual.size !== current.size) throw Error('native history changed during collection');
      const data = readFileSync(fd);
      if (data.length !== current.size) throw Error('native history changed during collection');
      writeFileSync(dest, data, { mode: 0o600, flag: 'wx' });
    } finally { closeSync(fd); }
  };
  try {
    for (const name of HISTORY_DIRS) if (stat(join(root, name))) copy(join(root, name), join(tmp, name));
    renameSync(tmp, target);
    return { bytes, entries };
  } catch (error) { rmSync(tmp, { recursive: true, force: true }); throw error; }
}

/** Decode precisely one body's session with the existing adapter and session
 * codec. Missing identity/history is uncertainty, never an empty saved slot. */
export function offlineNativeSession(snapshot, { harness, id, session }) {
  if (!['claude', 'codex'].includes(harness) || !/^[A-Za-z0-9-]{4,64}$/.test(id ?? '') || session !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(session)) throw Error('invalid offline native body');
  const paths = historyPaths(snapshot);
  const forbidden = () => { throw Error('offline collection cannot invoke a native process'); };
  const runner = harness === 'claude'
    ? new ClaudeRunner({ jobsDir: paths['claude-jobs'], projectsDir: paths['claude-projects'], run: forbidden })
    : new CodexRunner({ runsDir: paths['codex-runs'], sessionsDir: paths['codex-sessions'], codexHome: join(snapshot, 'unused-home'), run: forbidden, spawn: forbidden });
  const actual = runner.slotOf({ id });
  if (actual?.session && session && actual.session !== session) throw Error('native history belongs to a different session');
  const slot = actual ?? (session ? { harness, session } : null);
  if (!slot?.session) throw Error('native session identity is not collected yet');
  const files = packSession(runner, slot, { id });
  if (!files.length) throw Error('native session history is not collected yet');
  return { harness, id, session: slot.session, files };
}
