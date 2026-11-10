import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';

const owned = new Map();
const pending = new Map();
const statFields = text => text.split(') ').pop().split(' ');
const ownerIdentity = () => `${process.pid}:${statFields(readFileSync('/proc/self/stat', 'utf8'))[19]}`;
const guard = fileURLToPath(new URL('./house-wait-guard.mjs', import.meta.url));
const replaced = new WeakSet();
export const observationReplaced = child => replaced.has(child);
process.once('exit', () => { for (const child of owned.values()) child.kill('SIGKILL'); });

// Replacing observation never replaces the container's work.
export function observeHouse(command, name, options) {
  // Serialize different runner instances too: no replacement can spawn until
  // the previous guardian has killed and reaped its actual wait.
  const next = (pending.get(name) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const previous = owned.get(name);
    if (previous) {
      replaced.add(previous);
      if (previous.exitCode === null && previous.signalCode === null) {
        const closed = new Promise(resolve => previous.once('close', resolve));
        previous.kill('SIGKILL');
        await closed;
      }
    }
    const output = Array.isArray(options?.stdio) ? options.stdio.slice(0, 3) :
      [options?.stdio ?? 'pipe', options?.stdio ?? 'pipe', options?.stdio ?? 'pipe'];
    const child = spawn(process.execPath, [guard, command, name], { ...options,
      env: { ...(options?.env ?? process.env), LOOM_WAIT_OWNER: ownerIdentity() },
      stdio: [...output, 'pipe'], detached: false });
    // Never SIGKILL the guardian before it has killed and reaped its wait.
    child.kill = () => { child.stdio[3]?.end(); return true; };
    owned.set(name, child);
    const forget = () => { if (owned.get(name) === child) owned.delete(name); };
    child.once('exit', forget);
    child.once('error', forget);
    return child;
  });
  pending.set(name, next);
  const forgetPending = () => { if (pending.get(name) === next) pending.delete(name); };
  next.then(forgetPending, forgetPending);
  return next;
}

// New waits carry their runtime's pid + Linux start time, independent of their
// current parent. Unmarked pre-upgrade waits are recoverable only under known
// init supervisors; unknown parents cannot safely prove legacy ownership.
export function reapHouseWaits(command, names, proc = '/proc', kill = process.kill, path = process.env.PATH, legacyPids = new Set()) {
  let executable;
  try {
    executable = command.includes('/') ? realpathSync(command) :
      (path ?? '').split(delimiter).map(p => join(p, command)).map(p => { try { accessSync(p, constants.X_OK); return statSync(p).isFile() ? realpathSync(p) : null; } catch { return null; } }).find(Boolean);
    if (!executable) return [];
  } catch { return []; }
  const reaped = [];
  let entries;
  try { entries = readdirSync(proc); } catch { return reaped; }
  for (const pid of entries.filter(p => /^\d+$/.test(p))) {
    try {
      const base = `${proc}/${pid}`;
      const parent = readFileSync(`${base}/status`, 'utf8').match(/^PPid:\s+(\d+)/m)?.[1];
      let marker;
      try { marker = readFileSync(`${base}/environ`, 'utf8').split('\0').find(v => v.startsWith('LOOM_WAIT_OWNER='))?.slice(16); } catch (e) { if (e.code !== 'ENOENT') continue; }
      if (marker !== undefined) {
        const match = /^(\d+):(\d+)$/.exec(marker);
        if (!match) continue;
        try {
          const stat = statFields(readFileSync(`${proc}/${match[1]}/stat`, 'utf8'));
          if (stat[19] === match[2] && !['Z', 'X'].includes(stat[0])) continue;
        } catch (e) { if (e.code !== 'ENOENT') continue; }
      } else if (!legacyPids.has(Number(pid)) && parent !== '1' && !['systemd', 'tini', 'dumb-init'].includes(readFileSync(`${proc}/${parent}/comm`, 'utf8').trim())) continue;
      if (realpathSync(`${base}/exe`) !== executable) continue;
      const args = readFileSync(`${base}/cmdline`, 'utf8').split('\0');
      if (args.at(-1) === '') args.pop();
      if (args.length !== 3 || args[1] !== 'wait' || !names.has(args[2])) continue;
      kill(Number(pid), 'SIGKILL');
      reaped.push(Number(pid));
    } catch { /* disappeared or inaccessible */ }
  }
  return reaped;
}
