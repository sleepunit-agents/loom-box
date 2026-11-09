import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { admitLaunch, cancelReservedLaunch, completeLaunch, launchWorkerAlive, readLaunch, recoverLaunchReceipt, refuseLaunch, reserveLaunch } from './launch-journal.mjs';
import { RunnerError } from './runners.mjs';
import { restoreFiles } from './sessions.mjs';
import { rmSync } from 'node:fs';

/** One owned read-only query at a time for this caller. Query failures carry
 * no evidence of native absence and never release the admission ledger. */
export function observeNativeLaunch(env, request, { spawnObserver = spawn } = {}) {
  return new Promise(resolve => {
    let payload;
    try { payload = JSON.stringify(request); if (Buffer.byteLength(payload) > 4 * 1024 * 1024) return resolve({ state: 'pending' }); }
    catch { return resolve({ state: 'pending' }); }
    let child;
    try {
      child = spawnObserver(process.execPath, [fileURLToPath(new URL('./native-launch-observer.mjs', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return resolve({ state: 'pending' }); }
    let output = '', bytes = 0, overflow = false;
    child.on('error', () => resolve({ state: 'pending' }));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { overflow = true; child.kill('SIGKILL'); }
      else output += chunk;
    });
    child.on('close', code => {
      try {
        if (code !== 0 || overflow) return resolve({ state: 'pending' });
        const result = JSON.parse(output);
        if (result?.state !== 'ready' || result.body?.harness !== request.harness || !/^[A-Za-z0-9-]{4,64}$/.test(result.body?.id ?? '')) return resolve({ state: 'pending' });
        const body = result.body;
        if (body.slot && (body.slot.harness !== request.harness || !/^[A-Za-z0-9-]{4,64}$/.test(body.slot.session ?? ''))) return resolve({ state: 'pending' });
        resolve({ state: 'ready', body: { id: body.id, harness: request.harness, ...(body.slot ? { slot: { harness: request.harness, session: body.slot.session } } : {}) } });
      } catch { resolve({ state: 'pending' }); }
    });
    child.stdin.end(payload);
  });
}

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

  for (;;) {
    let delay = pollMs;
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
      const observed = await observeNativeLaunch(env, { harness, configuration, token: record.token, model: options.model, bodyEnv: options.env });
      if (observed.state === 'ready') recoverLaunchReceipt(env, id, observed.body);
      else delay = Math.max(pollMs, 1000); // unavailable native metadata must not create a busy query loop
    }
    await new Promise(resolve => setTimeout(resolve, delay));
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
