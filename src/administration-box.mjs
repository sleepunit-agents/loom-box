// The normal box runner's administration adapter. Privilege changes use one
// fixed helper; credentials stay in this parent and never reach command envs.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { constants, existsSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync } from 'node:fs';
import { administrationCapability } from './administration-capabilities.mjs';

const RPC = new Set(['administration-claim', 'administration-admit', 'administration-command', 'administration-cancel-claim', 'administration-complete']);
const caches = new Map();
export function administrationJob({ env, namespace, identity, mode, id, base, client }) {
  if (!/^[0-9a-f]{64}$/.test(namespace) || !['runner', 'root'].includes(identity) || !['capabilities', 'list', 'work'].includes(mode) || mode === 'work' && !/^ado-[0-9a-f]{32}$/.test(id ?? '')) throw Error('invalid box administration job');
  const helper = fileURLToPath(new URL('./administration-job.mjs', import.meta.url));
  const childEnv = { PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: identity === 'root' ? '/root' : env.HOME,
    ...(env.LOOM_AGE ? { LOOM_AGE: env.LOOM_AGE } : {}), ...(env.LOOM_AGE_KEYGEN ? { LOOM_AGE_KEYGEN: env.LOOM_AGE_KEYGEN } : {}) };
  const root = identity === 'root' && process.getuid() !== 0;
  const command = root ? '/usr/bin/sudo' : process.execPath;
  const argv = root ? ['-n', '--', '/usr/bin/env', '-i', ...Object.entries(childEnv).filter(([, v]) => typeof v === 'string').map(([k, v]) => k + '=' + v), process.execPath, helper] : [helper];
  const child = spawn(command, argv, { env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  let buffer = '', done, failure, timer;
  const promise = new Promise((resolve, reject) => {
    const fail = () => { failure = Error('box administration helper failed'); child.stdin.destroy(); child.kill('SIGTERM'); };
    child.on('error', () => { failure = Error('box administration helper could not start'); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { fail(); return; }
      for (;;) {
        const at = buffer.indexOf('\n'); if (at < 0) break;
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let packet; try { packet = JSON.parse(line); } catch { fail(); return; }
        if (packet.type === 'done') done = packet.result;
        else if (packet.type === 'failed') failure = Error('box administration helper refused the operation');
        else if (packet.type === 'call') {
          const allowed = mode === 'work' && Number.isSafeInteger(packet.seq) && packet.seq > 0 && RPC.has(packet.path) && packet.body?.operation === id;
          if (!allowed) { fail(); return; }
          Promise.resolve().then(() => client.call(packet.path, packet.body, { timeoutMs: 6000 }))
            .then(result => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ seq: packet.seq, result }) + '\n'); },
              () => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ seq: packet.seq, error: true }) + '\n'); });
        } else { fail(); return; }
      }
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0 || done === undefined) reject(failure || Error('box administration helper ended without a receipt'));
      else resolve(done);
    });
    if (mode !== 'work') timer = setTimeout(fail, 9000);
    child.stdin.write(JSON.stringify({ type: 'start', namespace, identity, mode, id, base }) + '\n');
  });
  return { promise, child, close() { child.stdin.destroy(); child.kill('SIGTERM'); } };
}

export function boxAdministration(env, client, { namespace, base, secure = true, log = () => {}, job = administrationJob } = {}) {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return { async capabilities() { return null; }, async tick() {}, active: new Map(), close() {} };
  if (!/^[0-9a-f]{64}$/.test(namespace ?? '')) throw Error('box administration needs its enrollment namespace');
  const active = new Map(), settled = new Set();
  const marker = join(base, namespace, 'used');
  let closing = false;
  const identities = process.getuid() === 0 ? ['root'] : ['runner', 'root'];
  const invoke = (identity, mode, id) => job({ env, namespace, identity, mode, id, base, client });
  async function capabilities() {
    if (!secure || closing) return null;
    const key = JSON.stringify([process.getuid(), env.PATH, env.LOOM_AGE, env.LOOM_AGE_KEYGEN]);
    let cached = job === administrationJob ? caches.get(key) : null;
    if (!cached || Date.now() - cached.at > 300_000) {
      const result = { v: 1, host: null, identities: {} };
      for (const identity of identities) {
        try {
          const cap = administrationCapability(await invoke(identity, 'capabilities').promise);
          if (cap && (!result.host || result.host === cap.host) && cap.identities[identity]) { result.host = cap.host; result.identities[identity] = cap.identities[identity]; }
        } catch { /* Unsupported identities are not advertised. */ }
      }
      cached = { at: Date.now(), cap: result.host ? administrationCapability(result) : null };
      if (job === administrationJob) caches.set(key, cached);
    }
    return cached.cap;
  }
  async function tick({ reportOnly = false } = {}) {
    if (!secure || closing) return;
    if (reportOnly && !existsSync(marker)) return;
    const pending = new Map();
    for (const identity of identities) {
      try {
        const rows = await invoke(identity, 'list').promise;
        if (!Array.isArray(rows) || rows.length > 4096) throw Error('invalid administrative inventory');
        for (const row of rows) {
          if (!/^ado-[0-9a-f]{32}$/.test(row.id ?? '') || row.identity !== identity) throw Error('invalid administrative inventory entry');
          pending.set(identity + ':' + row.id, row);
        }
      } catch { /* A disconnected root helper retains its private receipts. */ }
    }
    if (!reportOnly) {
      const cap = await capabilities();
      const offered = await client.call('administration-work', {}, { timeoutMs: 6000 });
      if (!Array.isArray(offered) || offered.length > 4096) throw Error('invalid administrative work offer');
      for (const row of offered) {
        if (/^ado-[0-9a-f]{32}$/.test(row.id ?? '') && cap?.identities[row.identity]) pending.set(row.identity + ':' + row.id, row);
      }
    }
    for (const [key, row] of pending) {
      if (closing || active.size >= 2) break;
      if (active.has(key) || settled.has(key)) continue;
      mkdirSync(join(base, namespace), { recursive: true, mode: 0o700 });
      const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, '1'); fsyncSync(fd); } finally { closeSync(fd); }
      for (const path of [join(base, namespace), base]) {
        const directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      const task = invoke(row.identity, 'work', row.id); active.set(key, task);
      task.promise.then(result => {
        if (['uploaded', 'cancelled', 'unknown'].includes(result?.state)) settled.add(key);
        else if (result?.state !== 'pending') throw Error('invalid administrative job receipt');
      }).catch(() => log('administration ' + row.id + ': receipt pending; will reconcile the same operation'))
        .finally(() => { active.delete(key); });
    }
  }
  return { capabilities, tick, active, close() { closing = true; for (const t of active.values()) t.close(); } };
}

export const administrationNamespace = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex');
