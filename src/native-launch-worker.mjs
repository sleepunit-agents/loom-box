// Shared launch worker: survives its registrar, calls the existing native
// adapters, and commits a receipt before there is anything to return. Input is
// private stdin, never argv or a plain file. No model routing happens here.
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { MAX_SESSION_BYTES, restoreFiles } from './sessions.mjs';
import { admitLaunch, completeLaunch, readLaunch, refuseLaunch } from './launch-journal.mjs';
import { configuredNativeRunner } from './runners.mjs';

let text = '';
for await (const chunk of process.stdin) {
  text += chunk;
  if (Buffer.byteLength(text) > 9 * 1024 * 1024 + Math.ceil(MAX_SESSION_BYTES * 4 / 3)) throw new Error('native launch input exceeds its bound');
}
const request = JSON.parse(text);
const { id, harness, options, resume, configuration, files } = request;
if (files !== undefined && (!resume || !Array.isArray(files))) throw new Error('restored files belong to a native resume');
const record = readLaunch(process.env, id);
const hash = createHash('sha256').update(JSON.stringify({ harness, options, ...(resume ? { resume } : {}), ...(configuration ? { configuration } : {}), ...(files !== undefined ? { files } : {}) })).digest('hex');
if (!record || record.harness !== harness || record.intentHash !== hash) throw new Error('native launch input changed after reservation');
const admission = admitLaunch(process.env, id);
if (admission.admitted) {
  let runner, nativeCalled = false;
  let restored = [];
  try {
    runner = configuredNativeRunner(harness, configuration, process.env);
    // Only the admitted worker restores files. A registrar retry never writes
    // over the session of a worker/native process that already owns this token.
    if (files !== undefined) restored = restoreFiles(runner, files);
    const o = { ...options, launchToken: record.token };
    nativeCalled = true;
    const body = resume ? await runner.resume(resume, o) : await runner.start(o);
    // A native identity alone is not acknowledgement that its prompt pipe was
    // written. Recovery after worker death retains explicit input uncertainty.
    if (body.inputReady) await body.inputReady;
    completeLaunch(process.env, id, body, { inputConfirmed: true });
  } catch (error) {
    // Unknown failures retain admission. The controller's native observer will
    // reconcile the stable token; it cannot treat a lost response as no work.
    if (!nativeCalled || error.nativeNotStarted === true) {
      for (const file of restored) rmSync(file, { recursive: true, force: true });
      refuseLaunch(process.env, id, error.message);
    }
  }
}
