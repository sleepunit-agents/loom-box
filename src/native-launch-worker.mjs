// Shared launch worker: survives its registrar, calls the existing native
// adapters, and commits a receipt before there is anything to return. Input is
// private stdin, never argv or a plain file. No model routing happens here.
import { createHash } from 'node:crypto';
import { admitLaunch, completeLaunch, readLaunch, refuseLaunch } from './launch-journal.mjs';
import { runnerFor } from './runners.mjs';

let text = '';
for await (const chunk of process.stdin) {
  text += chunk;
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('native launch input exceeds its bound');
}
const request = JSON.parse(text);
const { id, harness, options, resume } = request;
const record = readLaunch(process.env, id);
const hash = createHash('sha256').update(JSON.stringify({ harness, options, ...(resume ? { resume } : {}) })).digest('hex');
if (!record || record.harness !== harness || record.intentHash !== hash) throw new Error('native launch input changed after reservation');
const admission = admitLaunch(process.env, id);
if (admission.admitted) {
  let runner;
  try {
    runner = runnerFor(harness, process.env);
    const o = { ...options, launchToken: record.token };
    const body = resume ? await runner.resume(resume, o) : await runner.start(o);
    // A native identity alone is not acknowledgement that its prompt pipe was
    // written. Recovery after worker death retains explicit input uncertainty.
    if (body.inputReady) await body.inputReady;
    completeLaunch(process.env, id, body, { inputConfirmed: true });
  } catch (error) {
    // Unknown failures retain admission. The controller's native observer will
    // reconcile the stable token; it cannot treat a lost response as no work.
    if (!runner || error.nativeNotStarted === true) refuseLaunch(process.env, id, error.message);
  }
}
