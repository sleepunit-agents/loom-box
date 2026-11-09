// Box-side physical execution primitive. The normal authenticated box protocol
// supplies admission; this module never launches a model or obtains authority.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ageSealer } from './sealed.mjs';
import { launchWorkerAlive, launchWorkerIdentity } from './launch-journal.mjs';
import { executionHash, executionTransaction, monotonicMs, readExecution } from './administration-execution-journal.mjs';
import { administrationSupervisorAvailable, startAdministrationUnit, signalAdministrationUnit } from './administration-supervisor.mjs';

export function administrativeHost() {
  const machine = readFileSync('/etc/machine-id', 'utf8').trim();
  if (!/^[0-9a-f]{32}$/.test(machine)) throw Error('cannot establish administrative host identity');
  return 'linux-' + createHash('sha256').update(machine).digest('hex');
}
function childIdentity(pid, boot) {
  const text = readFileSync('/proc/' + pid + '/stat', 'utf8');
  const tail = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (!/^\d+$/.test(tail[19] ?? '')) throw Error('cannot establish administrative child identity');
  return { pid, boot, birth: tail[19] };
}
function resultOf(record, sealer) {
  return record.resultSealed ? JSON.parse(sealer.open(Buffer.from(record.resultSealed, 'base64')).toString('utf8')) : null;
}
function finish(root, id, sealer, result) {
  const sealed = sealer.seal(Buffer.from(JSON.stringify(result))).toString('base64');
  return executionTransaction(root, id, r => r.phase === 'finished' ? null : { ...r, phase: 'finished', resultSealed: sealed });
}
const unstarted = message => ({ outcome: 'not-started', exitCode: null, signal: null, stdout: '', stderr: message, truncated: false });

/** Observation never re-enters the command. A live child may still finish and
 * seal its result after the original worker dies. Failed OS reads stay pending. */
export function observeAdministrationExecution({ root, id, env = process.env }) {
  const r = readExecution(root, id);
  if (!r) return null;
  const sealer = ageSealer(env, join(root, 'secrets'));
  if (r.phase === 'finished') return { phase: r.phase, result: resultOf(r, sealer) };
  const alive = r.child ? launchWorkerAlive(r.child) : launchWorkerAlive(r.worker);
  if (alive !== false) return { phase: r.phase, pending: true };
  const result = ['prepared', 'gated', 'released'].includes(r.phase) ? unstarted('Worker ended before physical execution.')
    : { outcome: 'unknown', exitCode: null, signal: null, stdout: '', stderr: 'The admitted child ended without a sealed outcome; inspect effects before another command.', truncated: false };
  const done = finish(root, id, sealer, result);
  return { phase: done.phase, result: resultOf(done, sealer) };
}

export async function runAdministrationCommand({ root, id, payload, execution, env = process.env, admit, isStopped = async () => false, supervisor = 'systemd' }) {
  if (!['systemd', 'process-fixture'].includes(supervisor)) throw Error('unsupported administrative supervisor');
  if (execution.host !== administrativeHost() || execution.uid !== process.getuid() || execution.gid !== process.getgid()) throw Error('administrative worker is not the approved host and OS identity');
  if (!Array.isArray(payload?.argv) || !payload.argv.length || payload.argv.length > 128 || payload.argv.some(a => typeof a !== 'string' || a.includes('\0')) || !payload.argv[0] ||
      typeof payload.cwd !== 'string' || !payload.cwd.startsWith('/') || typeof payload.stdin !== 'string' ||
      !Number.isInteger(payload.timeoutMs) || payload.timeoutMs < 1 || payload.timeoutMs > 600_000 || Buffer.byteLength(JSON.stringify(payload)) > 128 * 1024) throw Error('invalid administrative command payload');
  const existing = readExecution(root, id);
  if (existing) {
    if (existing.payloadHash !== executionHash(payload) || executionHash(existing.execution) !== executionHash(execution)) throw Error('administrative execution id has another immutable command');
    return observeAdministrationExecution({ root, id, env });
  }
  if (supervisor === 'systemd' && !administrationSupervisorAvailable(env)) throw Error('administrative commands require an available systemd user manager');
  const payloadHash = executionHash(payload), worker = { ...launchWorkerIdentity(), host: execution.host, uid: process.getuid(), gid: process.getgid() };
  const sealer = ageSealer(env, join(root, 'secrets'));
  let owned = false;
  executionTransaction(root, id, old => {
    if (old) { if (old.payloadHash !== payloadHash || executionHash(old.execution) !== executionHash(execution)) throw Error('administrative execution id has another immutable command'); return null; }
    owned = true;
    return { v: 1, id, payloadHash, execution, worker, phase: 'prepared', inputSealed: sealer.seal(Buffer.from(JSON.stringify(payload))).toString('base64') };
  });
  if (!owned) return observeAdministrationExecution({ root, id, env });
  let child, closed, timer, escalation, interval, stopping = false, checking = false;
  const stop = () => {
    if (stopping || !child) return;
    stopping = true;
    const r = readExecution(root, id);
    if (['sealing', 'finished'].includes(r.phase)) return;
    if (r.supervisor) signalAdministrationUnit(env, r, 'SIGTERM');
    else if (launchWorkerAlive(r.child) === true) { try { process.kill(-r.child.pid, 'SIGTERM'); } catch {} }
    escalation = setTimeout(() => {
      const live = readExecution(root, id);
      if (!['sealing', 'finished'].includes(live.phase)) {
        if (live.supervisor) signalAdministrationUnit(env, live, 'SIGKILL');
        else if (launchWorkerAlive(r.child) === true) { try { process.kill(-r.child.pid, 'SIGKILL'); } catch {} }
      }
    }, 1200);
  };
  try {
    const requested = monotonicMs(), answer = await admit({ worker, operation: id, payloadHash });
    const receipt = answer?.receipt;
    if (!answer?.authorized || !receipt || receipt.operation !== id || receipt.payloadHash !== payloadHash || executionHash(receipt.worker) !== executionHash(worker) ||
        !Number.isSafeInteger(receipt.remainingMs) || receipt.remainingMs < 1 || receipt.remainingMs > 8 * 3600_000 ||
        receipt.until - receipt.serverAt !== receipt.remainingMs) throw Error('Administrative admission was refused or could not be verified.');
    const deadlineMono = requested + Math.min(receipt.remainingMs, payload.timeoutMs);
    executionTransaction(root, id, r => ({ ...r, deadlineMono }));
    if (monotonicMs() >= deadlineMono || await isStopped()) throw Error('Administrative access ended before creating its supervisor.');
    const gateEnv = { PATH: env.PATH, HOME: env.HOME, LOOM_ADMIN_EXEC_DATA: root,
      ...(env.LOOM_AGE ? { LOOM_AGE: env.LOOM_AGE } : {}), ...(env.LOOM_AGE_KEYGEN ? { LOOM_AGE_KEYGEN: env.LOOM_AGE_KEYGEN } : {}) };
    let identity;
    if (supervisor === 'systemd') {
      const unit = await startAdministrationUnit({ root, id, env, gateEnv, boot: worker.boot, maxMs: Math.max(1, deadlineMono - monotonicMs()) });
      child = unit.child; closed = unit.closed; identity = unit.identity;
    } else {
      // Explicit fixture adapter, never an automatic production fallback.
      child = spawn(process.execPath, [fileURLToPath(new URL('./administration-command-gate.mjs', import.meta.url))], { env: gateEnv, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.on('error', () => {});
      closed = new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
      if (!child.pid) throw Error('administrative child gate could not start');
      identity = childIdentity(child.pid, worker.boot);
    }
    executionTransaction(root, id, r => ({ ...r, phase: 'gated', child: identity }));
    executionTransaction(root, id, r => ({ ...r, phase: 'released', deadlineMono }));
    if (monotonicMs() >= deadlineMono || await isStopped()) throw Error('Administrative access ended before physical admission.');
    child.stdin.end(JSON.stringify({ id, payload }));
    timer = setTimeout(stop, Math.max(1, deadlineMono - monotonicMs()));
    interval = setInterval(async () => {
      if (checking) return;
      checking = true;
      try { if (await isStopped()) stop(); } catch { /* the independent lease deadline still holds */ }
      finally { checking = false; }
    }, 100);
    await closed;
    return observeAdministrationExecution({ root, id, env });
  } catch (error) {
    if (child) { child.stdin.destroy(); stop(); await closed; }
    const r = readExecution(root, id);
    if (r.phase !== 'finished') finish(root, id, sealer, ['executing', 'sealing'].includes(r.phase)
      ? { outcome: 'unknown', exitCode: null, signal: null, stdout: '', stderr: 'Execution outcome is uncertain.', truncated: false }
      : unstarted(String(error.message).slice(0, 200)));
    return observeAdministrationExecution({ root, id, env });
  } finally { clearTimeout(timer); clearTimeout(escalation); clearInterval(interval); }
}
