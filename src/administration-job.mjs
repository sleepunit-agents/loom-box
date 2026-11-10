// Private parent/worker IPC. The worker receives no box credential: its parent
// performs only operation-bound calls through the box's existing client.
import { createInterface } from 'node:readline';
import { existsSync, lstatSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reconcileAdministration, readAdministrationRequest } from './administration-client.mjs';
import { administrativeHost } from './administration-worker.mjs';
import { administrationSupervisorAvailable } from './administration-supervisor.mjs';
import { agePrograms } from './sealed.mjs';

const input = createInterface({ input: process.stdin }), waiting = new Map();
process.stdout.on('error', () => process.exit(1));
const send = packet => process.stdout.write(JSON.stringify(packet) + '\n');
let start, begin;
const started = new Promise(resolve => { begin = resolve; });
input.on('line', line => {
  if (Buffer.byteLength(line) > 1024 * 1024) process.exit(2);
  let packet; try { packet = JSON.parse(line); } catch { process.exit(2); }
  if (!start) { start = packet; begin(); return; }
  const w = waiting.get(packet.seq);
  if (w) { waiting.delete(packet.seq); clearTimeout(w.timer); packet.error ? w.reject(Error('box administration transport refused the request')) : w.resolve(packet.result); }
});
input.on('close', () => { for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(Error('box administration transport closed')); } waiting.clear(); });
await started;
try {
  if (start.type !== 'start' || !/^[0-9a-f]{64}$/.test(start.namespace ?? '') || !['capabilities', 'list', 'work'].includes(start.mode)) throw Error('invalid administration worker request');
  const identity = process.getuid() === 0 ? 'root' : 'runner';
  if (start.identity !== identity) throw Error('administration worker has another OS identity');
  const base = process.getuid() === 0 ? '/var/lib/loom-runtime-administration' : start.base;
  if (typeof base !== 'string' || !base.startsWith('/')) throw Error('invalid administration worker data directory');
  const root = join(base, start.namespace);
  if (start.mode === 'capabilities') {
    const { age, keygen } = agePrograms(process.env);
    const available = administrationSupervisorAvailable(process.env) &&
      spawnSync(age, ['--version'], { stdio: 'ignore', timeout: 2000 }).status === 0 &&
      spawnSync(keygen, ['--help'], { stdio: 'ignore', timeout: 2000 }).status === 0;
    send({ type: 'done', result: available ? { v: 1, host: administrativeHost(), identities: { [identity]: { uid: process.getuid(), gid: process.getgid() } } } : null });
  } else {
    if (process.getuid() === 0) {
      if (!existsSync(base)) mkdirSync(base, { mode: 0o700 });
      const st = lstatSync(base);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o077) throw Error('root administrative storage is not private');
    }
    if (start.mode === 'list') {
      const requests = join(root, 'requests');
      const entries = existsSync(requests) ? readdirSync(requests).filter(n => /^ado-[0-9a-f]{32}\.json$/.test(n)) : [];
      if (entries.length > 4096) throw Error('administrative request inventory exceeds its bound');
      const pending = entries.map(n => readAdministrationRequest(root, n.slice(0, -5))).filter(r => ['claiming', 'ready'].includes(r.state)).map(r => ({ id: r.id, identity }));
      send({ type: 'done', result: pending });
    } else {
      if (!/^ado-[0-9a-f]{32}$/.test(start.id ?? '')) throw Error('invalid administration operation');
      let seq = 0;
      const client = { call(path, body) { return new Promise((resolve, reject) => {
        const id = ++seq, timer = setTimeout(() => { waiting.delete(id); reject(Error('box administration transport timed out')); }, 6500);
        waiting.set(id, { resolve, reject, timer }); send({ type: 'call', seq: id, path, body });
      }); } };
      send({ type: 'done', result: await reconcileAdministration({ root, id: start.id, client, env: process.env }) });
    }
  }
} catch { send({ type: 'failed' }); process.exitCode = 1; }
finally { input.close(); process.stdin.destroy(); }
