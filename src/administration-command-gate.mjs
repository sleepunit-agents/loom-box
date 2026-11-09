// One private child gate per administrative operation. This helper stays alive
// to seal its result even if the box worker disappears.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { executionHash, executionTransaction, monotonicMs, readExecution } from './administration-execution-journal.mjs';
import { launchWorkerIdentity } from './launch-journal.mjs';
import { ageSealer } from './sealed.mjs';

process.stdout.on('error', () => {});
let text = '';
for await (const chunk of process.stdin) {
  text += chunk;
  if (Buffer.byteLength(text) > 256 * 1024) throw Error('administrative gate input exceeds its bound');
}
if (!text) process.exit(0); // Lost worker before release: no command was received.
const { id, payload } = JSON.parse(text), root = process.env.LOOM_ADMIN_EXEC_DATA;
const own = launchWorkerIdentity(), r = readExecution(root, id);
const identity = r?.child;
if (!identity || identity.pid !== own.pid || identity.boot !== own.boot || identity.birth !== own.birth ||
    process.getuid() !== r.execution.uid || process.getgid() !== r.execution.gid || executionHash(payload) !== r.payloadHash) throw Error('administrative child gate identity changed');
const sealer = ageSealer(process.env, join(root, 'secrets'));
function complete(result) {
  executionTransaction(root, id, live => live.phase === 'finished' ? null : { ...live, phase: 'sealing' });
  const sealed = sealer.seal(Buffer.from(JSON.stringify(result))).toString('base64');
  executionTransaction(root, id, live => {
    if (live.phase === 'finished') return null;
    return { ...live, phase: 'finished', resultSealed: sealed };
  });
}
if (monotonicMs() >= r.deadlineMono) {
  complete({ outcome: 'not-started', exitCode: null, signal: null, stdout: '', stderr: 'Lease expired before physical admission.', truncated: false });
  process.exit(0);
}
let admitted = false;
executionTransaction(root, id, live => {
  if (live.phase !== 'released' || live.child.pid !== own.pid || live.child.birth !== own.birth) return null;
  admitted = true;
  return { ...live, phase: 'executing' };
});
if (!admitted) process.exit(0);
if (monotonicMs() >= r.deadlineMono) {
  complete({ outcome: 'not-started', exitCode: null, signal: null, stdout: '', stderr: 'Lease expired while recording physical admission.', truncated: false });
  process.exit(0);
}

let child, output = [], errors = [], bytes = 0, truncated = false, escalation;
const capture = into => chunk => {
  const keep = Math.min(chunk.length, Math.max(0, 64 * 1024 - bytes));
  if (keep) { into.push(chunk.subarray(0, keep)); bytes += keep; }
  if (keep < chunk.length) truncated = true;
};
const stop = () => {
  child?.kill('SIGTERM');
  escalation ??= setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }, 1000);
};
process.on('SIGTERM', stop);
const timer = setTimeout(() => { try { process.kill(-process.pid, 'SIGTERM'); } catch { stop(); } }, Math.max(1, r.deadlineMono - monotonicMs()));
try {
  child = spawn(payload.argv[0], payload.argv.slice(1), {
    cwd: payload.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    // No box token, run key, broker credentials or model environment reaches the command.
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME, LANG: 'C.UTF-8' },
  });
  child.stdin.on('error', () => {});
  child.stdout.on('data', capture(output)); child.stderr.on('data', capture(errors));
  const result = await new Promise(resolve => {
    child.once('error', () => resolve({ outcome: 'not-started', exitCode: null, signal: null, stderr: 'The command could not be started.' }));
    child.once('close', (exitCode, signal) => resolve({ outcome: 'exited', exitCode, signal }));
    child.stdin.end(payload.stdin);
  });
  // Once the command is gone, do not let an escalation kill its only result
  // writer while encryption or fsync is in progress.
  clearTimeout(timer); clearTimeout(escalation);
  complete({ stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8'), truncated, ...result });
} finally { clearTimeout(timer); clearTimeout(escalation); }
