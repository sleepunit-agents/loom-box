import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cancelReservedLaunch, launchWorkerAlive, readLaunch, recoverLaunchReceipt, reserveLaunch } from './launch-journal.mjs';
import { RunnerError, configuredNativeRunner } from './runners.mjs';

/** A restart observes/adopts this same attempt. It never launches another native
 * request merely because an observer or the original registrar went away. */
export async function superviseNativeLaunch(env, { id, harness, options, resume, configuration }, { pollMs = 100, spawnWorker = spawn } = {}) {
  const intent = { harness, options, ...(resume ? { resume } : {}), ...(configuration ? { configuration } : {}) };
  const intentHash = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  const first = reserveLaunch(env, { id, harness, intentHash });
  let helperFailed = false;
  if (first.state === 'reserved') {
    // Racing registrars can start workers; the journal admits exactly one.
    try {
      const child = spawnWorker(process.execPath, [fileURLToPath(new URL('./native-launch-worker.mjs', import.meta.url))], {
        env, detached: true, stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', () => { helperFailed = true; });
      child.on('exit', () => { helperFailed = true; });
      child.stdin.on('error', () => { helperFailed = true; });
      child.stdin.end(JSON.stringify({ id, ...intent }));
      child.unref();
    } catch { helperFailed = true; }
  }

  let runner;
  for (;;) {
    // Cancellation is a journal CAS: it can refuse only a still-reserved
    // attempt. Any worker already admitted keeps ownership, even when this
    // helper failed or its private input pipe closed.
    if (helperFailed) { cancelReservedLaunch(env, id); helperFailed = false; }
    const record = readLaunch(env, id);
    if (!record) throw new RunnerError('native launch journal disappeared; its admission remains uncertain');
    if (record.state === 'ready') return { ...record.body, model: options.model, ...(record.input !== 'confirmed' ? { inputUncertain: true } : {}) };
    if (record.state === 'refused') {
      const error = new RunnerError(record.reason);
      error.nativeNotStarted = true;
      throw error;
    }
    if (record.state === 'admitted' && launchWorkerAlive(record.worker) === false) {
      runner ??= configuredNativeRunner(harness, configuration, env);
      const observed = runner.recoverLaunch(record.token, { model: options.model, env: options.env });
      if (observed.state === 'ready') recoverLaunchReceipt(env, id, observed.body);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
