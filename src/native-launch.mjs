import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { admitLaunch, cancelReservedLaunch, completeLaunch, launchWorkerAlive, readLaunch, recoverLaunchReceipt, refuseLaunch, reserveLaunch } from './launch-journal.mjs';
import { RunnerError, configuredNativeRunner } from './runners.mjs';
import { restoreFiles } from './sessions.mjs';
import { rmSync } from 'node:fs';

/** A restart observes/adopts this same attempt. It never launches another native
 * request merely because an observer or the original registrar went away. */
export async function superviseNativeLaunch(env, { id, harness, options, resume, configuration, files }, { pollMs = 100, spawnWorker = spawn } = {}) {
  const intent = { harness, options, ...(resume ? { resume } : {}), ...(configuration ? { configuration } : {}), ...(files !== undefined ? { files } : {}) };
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


/** Explicitly injected adapters use the same admission ledger in-process.
 * Production native adapters always use the owned OS worker above. */
export async function launchInjectedNative(env, { id, harness, options, resume, files }, runner) {
  const intent = { harness, options, ...(resume ? { resume } : {}), ...(files !== undefined ? { files } : {}) };
  const intentHash = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  const record = reserveLaunch(env, { id, harness, intentHash });
  if (record.state === 'ready') return { ...record.body, ...(record.input !== 'confirmed' ? { inputUncertain: true } : {}) };
  if (record.state === 'refused') throw Object.assign(new RunnerError(record.reason), { nativeNotStarted: true });
  const admission = admitLaunch(env, id);
  if (!admission.admitted) throw Object.assign(new RunnerError('the injected native attempt remains admitted; observe its original receipt'), { nativePending: true });
  let enteredNative = false, restored = [];
  try {
    if (files !== undefined) restored = restoreFiles(runner, files);
    enteredNative = true;
    const input = { ...options, launchToken: record.token };
    const body = resume ? await runner.resume(resume, input) : await runner.start(input);
    if (body.inputReady) await body.inputReady;
    completeLaunch(env, id, body, { inputConfirmed: true });
    return body;
  } catch (error) {
    if (!enteredNative || error.nativeNotStarted === true) {
      for (const file of restored) rmSync(file, { recursive: true, force: true });
      refuseLaunch(env, id, error.message); error.nativeNotStarted = true;
    } else error.nativePending = true;
    throw error;
  }
}
