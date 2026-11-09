import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { launchWorkerAlive, readLaunch, recoverLaunchReceipt, reserveLaunch } from './launch-journal.mjs';
import { RunnerError, runnerFor } from './runners.mjs';

/** A restart observes/adopts this same attempt. It never launches another native
 * request merely because an observer or the original registrar went away. */
export async function superviseNativeLaunch(env, { id, harness, options, resume }, { pollMs = 100 } = {}) {
  const intent = { harness, options, ...(resume ? { resume } : {}) };
  const intentHash = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  const first = reserveLaunch(env, { id, harness, intentHash });
  if (first.state === 'reserved') {
    // Racing registrars can start workers; the journal admits exactly one.
    const child = spawn(process.execPath, [fileURLToPath(new URL('./native-launch-worker.mjs', import.meta.url))], {
      env, detached: true, stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ id, ...intent }));
    child.unref();
  }
  let runner;
  for (;;) {
    const record = readLaunch(env, id);
    if (!record) throw new RunnerError('native launch journal disappeared; its admission remains uncertain');
    if (record.state === 'ready') return { ...record.body, model: options.model, ...(record.input !== 'confirmed' ? { inputUncertain: true } : {}) };
    if (record.state === 'refused') {
      const error = new RunnerError(record.reason);
      error.nativeNotStarted = true;
      throw error;
    }
    if (record.state === 'admitted' && launchWorkerAlive(record.worker) === false) {
      runner ??= runnerFor(harness, env);
      const observed = runner.recoverLaunch(record.token, { model: options.model, env: options.env });
      if (observed.state === 'ready') recoverLaunchReceipt(env, id, observed.body);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
