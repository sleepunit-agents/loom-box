import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';

const owned = new Map();
const replaced = new WeakSet();
export const observationReplaced = child => replaced.has(child);
process.once('exit', () => { for (const child of owned.values()) child.kill('SIGKILL'); });

// Replacing observation never replaces the container's work.
export function observeHouse(command, name, options) {
  const previous = owned.get(name);
  if (previous) { replaced.add(previous); previous.kill('SIGKILL'); }
  const child = spawn(command, ['wait', name], { ...options, detached: false });
  owned.set(name, child);
  const forget = () => { if (owned.get(name) === child) owned.delete(name); };
  child.once('exit', forget);
  child.once('error', forget);
  return child;
}

// Only init or known service/container subreaper orphans with this executable and exact assigned container argv.
export function reapHouseWaits(command, names, proc = '/proc', kill = process.kill, path = process.env.PATH) {
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
      if (parent !== '1' && !['systemd', 'tini', 'dumb-init'].includes(readFileSync(`${proc}/${parent}/comm`, 'utf8').trim())) continue;
      if (realpathSync(`${base}/exe`) !== executable) continue;
      const args = readFileSync(`${base}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (args.length !== 3 || args[1] !== 'wait' || !names.has(args[2])) continue;
      kill(Number(pid), 'SIGKILL');
      reaped.push(Number(pid));
    } catch { /* disappeared or inaccessible */ }
  }
  return reaped;
}
