// Supported OS ownership for administrative command gates. A missing user
// manager refuses admission; root workers use the system manager. Neither falls back to an uncontained process.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { executionTransaction } from './administration-execution-journal.mjs';

export const administrationUnit = (root, id, fixture = false) => (fixture ? 'loom-admin-test-' : 'loom-admin-') + id.slice(4) + '-' + createHash('sha256').update(root).digest('hex').slice(0, 12) + '.service';
const managerKind = () => process.getuid() === 0 ? 'systemd-system' : 'systemd-user';
const managerArgs = () => process.getuid() === 0 ? [] : ['--user'];
const managerEnv = env => ({ PATH: env.PATH, HOME: env.HOME,
  ...(process.getuid() === 0 ? {} : { XDG_RUNTIME_DIR: '/run/user/' + process.getuid(), DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/' + process.getuid() + '/bus' }) });
function call(env, args) {
  return spawnSync('systemctl', [...managerArgs(), ...args], { env: managerEnv(env), encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 });
}
export function administrationSupervisorAvailable(env = process.env) {
  if (process.getuid() !== process.geteuid() || process.getgid() !== process.getegid()) return false;
  const r = call(env, ['show', '--property=Version', '--value']);
  if (r.status !== 0 || !/^\d/.test(r.stdout.trim())) return false;
  if (process.getuid() !== 0) {
    const manager = spawnSync('busctl', ['--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetConnectionUnixProcessID', 's', 'org.freedesktop.systemd1'], { env: managerEnv(env), encoding: 'utf8', timeout: 3000 });
    const pid = /^u ([1-9][0-9]*)\s*$/.exec(manager.stdout ?? '')?.[1];
    if (manager.status !== 0 || !pid) return false;
    try {
      const status = readFileSync('/proc/' + pid + '/status', 'utf8');
      if (Number(/^Uid:\s+\d+\s+(\d+)/m.exec(status)?.[1]) !== process.getuid() || Number(/^Gid:\s+\d+\s+(\d+)/m.exec(status)?.[1]) !== process.getgid()) return false;
    } catch { return false; }
  }
  return true;
}
export function administrationUnitState(env, unit) {
  if (!/^loom-admin-(?:test-)?[0-9a-f]{32}-[0-9a-f]{12}\.service$/.test(unit ?? '')) throw Error('invalid administrative supervisor unit');
  const r = call(env, ['show', unit, '--property=MainPID,InvocationID,ActiveState,LoadState,KillMode,RuntimeMaxUSec,TimeoutStopUSec']);
  if (r.status !== 0 || r.error) return null;
  const fields = Object.fromEntries(r.stdout.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  return { pid: Number(fields.MainPID), invocation: fields.InvocationID, active: fields.ActiveState, loaded: fields.LoadState,
    killMode: fields.KillMode, runtimeMax: fields.RuntimeMaxUSec, stopTimeout: fields.TimeoutStopUSec };
}
export function signalAdministrationUnit(env, record, signal) {
  const s = record.supervisor;
  if (s?.kind !== managerKind() || !s.invocation) return false;
  const live = administrationUnitState(env, s.unit);
  if (!live || live.invocation !== s.invocation) return false;
  const r = call(env, ['kill', '--kill-whom=all', '--signal=' + signal, s.unit]);
  return r.status === 0;
}
export async function startAdministrationUnit({ root, id, env, gateEnv, boot, maxMs, fixture = false }) {
  if (!administrationSupervisorAvailable(env)) throw Error('administrative commands require an available systemd manager for its OS identity');
  const unit = administrationUnit(root, id, fixture);
  executionTransaction(root, id, r => ({ ...r, supervisor: { kind: managerKind(), unit } }));
  const args = [...managerArgs(), '--quiet', '--pipe', '--wait', '--unit=' + unit,
    '--property=Type=exec', '--property=KillMode=control-group', '--property=TimeoutStopSec=2s',
    ...(process.getuid() === 0 ? ['--property=Group=' + process.getgid()] : []),
    '--property=RuntimeMaxSec=' + Math.ceil((maxMs + 30_000) / 1000) + 's',
    ...Object.entries(gateEnv).filter(([, value]) => typeof value === 'string').map(([key, value]) => '--setenv=' + key + '=' + value),
    process.execPath, fileURLToPath(new URL('./administration-command-gate.mjs', import.meta.url))];
  const child = spawn('systemd-run', args, { env: managerEnv(env), stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.on('error', () => {});
  let ended = false;
  const closed = new Promise(resolve => { child.once('error', e => { ended = true; resolve(e); }); child.once('close', code => { ended = true; resolve(code); }); });
  const deadline = Date.now() + 5000;
  while (!ended && Date.now() < deadline) {
    const live = administrationUnitState(env, unit);
    if (live?.pid > 0 && /^[0-9a-f]{32}$/.test(live.invocation ?? '')) {
      const stat = readFileSync('/proc/' + live.pid + '/stat', 'utf8');
      const birth = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      if (!/^\d+$/.test(birth ?? '')) throw Error('cannot establish supervised administrative child identity');
      executionTransaction(root, id, r => ({ ...r, supervisor: { kind: managerKind(), unit, invocation: live.invocation } }));
      return { child, closed, identity: { pid: live.pid, boot, birth } };
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  // No input was released. A lost submit response cannot run a command, even
  // if its empty gate appears later. Its bounded unit remains observable.
  child.stdin.destroy();
  throw Error('administrative supervisor did not confirm the child gate');
}
