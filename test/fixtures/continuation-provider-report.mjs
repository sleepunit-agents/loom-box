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
// The parent releases each stage by a file; this body's own shell does every call, with its own key.
const released = (name) => {
  const end = Date.now() + 90000;
  while (!existsSync(`/fixture/house/release${name ? `-${name}` : ''}`)) {
    if (Date.now() > end) throw Error(`provider release deadline${name ? `: ${name}` : ''}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
};
const runtime = (args) => spawnSync(process.execPath, ['/runtime/src/cli.mjs', 'continuation', ...args, '--piece', 'runtime', '--handle', handle], {
  env: { ...process.env, CODEX_THREAD_ID: session }, encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL',
});
// Only the runtime's known refusal words are kept, never its whole output.
const KNOWN = ['continuation expired', 'continuation source was reset or changed', 'not the bound continuation run'];
const refusal = (r) => ({ refused: r.status !== 0, reason: KNOWN.find((k) => `${r.stdout}${r.stderr}`.includes(k)) ?? 'other' });
released('');
const result = runtime(['enqueue', '--id', 'provider-report', '--text', 'actual Codex continuation report']);
if (result.status !== 0) throw Error('provider enqueue refused');
const receipt = JSON.parse(result.stdout);
if (receipt.state !== 'pending' || !receipt.ref) throw Error('provider enqueue missing pending receipt');
writeFileSync('/fixture/house/enqueued.json', JSON.stringify({ state: receipt.state, ref: receipt.ref }), { mode: 0o600 });
released('status');
const status = runtime(['status', '--id', 'provider-report']);
if (status.status !== 0) throw Error('provider status refused');
writeFileSync('/fixture/house/status.json', JSON.stringify({ state: JSON.parse(status.stdout)?.state ?? null }), { mode: 0o600 });
released('cutoff');
writeFileSync('/fixture/house/cutoff.json', JSON.stringify(refusal(runtime(['enqueue', '--id', 'after-cutoff', '--text', 'late report']))), { mode: 0o600 });
released('reset');
writeFileSync('/fixture/house/reset.json', JSON.stringify(refusal(runtime(['enqueue', '--id', 'after-reset', '--text', 'report after reset']))), { mode: 0o600 });
