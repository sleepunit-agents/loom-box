// Actual provider's shell executes this helper. Parent never supplies a holder
// key or native session. Those come from this body's own environment/history.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const handle = process.argv[2];
if (!/^cont-[0-9a-f]{64}$/.test(handle ?? '')) throw Error('invalid test handle');
if (process.env.HOME !== '/fixture/house') throw Error('provider fixture HOME required');
const scan = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? scan(join(dir, e.name)) : e.name.endsWith('.jsonl') ? [join(dir, e.name)] : []);
const ids = scan(join(process.env.CODEX_HOME, 'sessions')).flatMap(file =>
  readFileSync(file, 'utf8').split('\n').flatMap(line => {
    try { const value = JSON.parse(line); return value.type === 'session_meta' ? [value.payload.id] : []; }
    catch { return []; }
  }));
if (ids.length !== 1 || !/^[0-9a-f-]{36}$/.test(ids[0])) throw Error('expected exactly one actual native UUID');
const session = ids[0];
writeFileSync('/fixture/house/ready.json', JSON.stringify({ session }), { mode: 0o600 });
const end = Date.now() + 90000;
while (!existsSync('/fixture/house/release')) {
  if (Date.now() > end) throw Error('provider release deadline');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}
const result = spawnSync(process.execPath, ['/runtime/src/cli.mjs', 'continuation', 'enqueue',
  '--piece', 'runtime', '--handle', handle, '--id', 'provider-report', '--text', 'actual Codex continuation report'], {
  env: { ...process.env, CODEX_THREAD_ID: session }, encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL',
});
if (result.status !== 0) throw Error('provider enqueue refused');
const receipt = JSON.parse(result.stdout);
if (receipt.state !== 'pending' || !receipt.ref) throw Error('provider enqueue missing pending receipt');
writeFileSync('/fixture/house/enqueued.json', JSON.stringify({ state: receipt.state, ref: receipt.ref }), { mode: 0o600 });
