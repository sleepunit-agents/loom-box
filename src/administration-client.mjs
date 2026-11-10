// Durable box-side claim and upload reconciliation. No model or SSH runner.
import { join } from 'node:path';
import { ageSealer } from './sealed.mjs';
import { launchWorkerAlive, launchWorkerIdentity } from './launch-journal.mjs';
import { administrativeHost, observeAdministrationExecution, runAdministrationCommand } from './administration-worker.mjs';
import { signalAdministrationUnit } from './administration-supervisor.mjs';
import { executionHash, readExecution, readPrivateRecord, privateRecordTransaction } from './administration-execution-journal.mjs';

function validate(r, id) {
  if (r?.v !== 1 || r.id !== id || !['claiming', 'ready', 'uploaded', 'cancelled', 'unknown'].includes(r.state) ||
      !r.worker || !Number.isSafeInteger(r.worker.pid) || r.worker.pid < 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.worker.boot ?? '') || !/^[0-9]{1,24}$/.test(r.worker.birth ?? '') ||
      !/^linux-[0-9a-f]{64}$/.test(r.worker.host ?? '') || !Number.isInteger(r.worker.uid) || r.worker.uid < 0 || !Number.isInteger(r.worker.gid) || r.worker.gid < 0 ||
      typeof r.sealed !== 'string' || !r.sealed || r.state === 'uploaded' && !/^[0-9a-f]{64}$/.test(r.receipt?.hash ?? '')) throw Error('administrative client receipt cannot be decoded');
  return r;
}
const canonicalResult = r => ({ outcome: r.outcome, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
  exitCode: r.exitCode ?? null, signal: r.signal ?? null, truncated: r.truncated ?? false });

export function readAdministrationRequest(root, id) {
  return readPrivateRecord(join(root, 'requests'), id, validate);
}

/** One pass: observe the same operation after restart, or perform it once in
 * its original worker. Nothing is deleted before an immutable server receipt. */
export async function reconcileAdministration({ root, id, client, env = process.env, supervisor = 'systemd' }) {
  const requests = join(root, 'requests'), executions = join(root, 'executions');
  const sealer = ageSealer(env, join(requests, 'secrets'));
  const own = { ...launchWorkerIdentity(), host: administrativeHost(), uid: process.getuid(), gid: process.getgid() };
  const tx = fn => privateRecordTransaction(requests, id, fn, validate);
  const call = (path, body) => client.call(path, body, { timeoutMs: 6000 });
  let record = readAdministrationRequest(root, id);
  if (!record) record = tx(old => old || { v: 1, id, worker: own, state: 'claiming', sealed: sealer.seal(Buffer.from(JSON.stringify({ worker: own }))).toString('base64') });
  if (record.worker.host !== own.host || record.worker.uid !== own.uid || record.worker.gid !== own.gid) throw Error('administrative client moved to another host or OS identity');
  if (['uploaded', 'cancelled', 'unknown'].includes(record.state)) return { state: record.state, ...(record.receipt ? { receipt: record.receipt } : {}) };
  let claim = JSON.parse(sealer.open(Buffer.from(record.sealed, 'base64')).toString('utf8'));
  if (executionHash(claim.worker) !== executionHash(record.worker)) throw Error('administrative client lost its worker binding');
  const original = executionHash(record.worker) === executionHash(own);
  if (record.state === 'claiming' && !original && launchWorkerAlive(record.worker) !== false) return { state: 'pending', reason: 'original worker remains live or unobserved' };

  if (record.state === 'claiming') {
    const answer = await call('administration-claim', { operation: id, worker: record.worker });
    if (!answer.claimed) {
      const state = ['cancelled', 'finished', 'failed'].includes(answer.operation?.state) ? 'cancelled' : 'unknown';
      record = tx(r => ({ ...r, state })); return { state: record.state };
    }
    if (answer.operation?.id !== id || executionHash(answer.worker) !== executionHash(record.worker) ||
        !/^[0-9a-f]{64}$/.test(answer.ticket ?? '') || executionHash(answer.payload) !== answer.operation.payloadHash) throw Error('administrative claim response changed its command or worker');
    claim = { worker: record.worker, ticket: answer.ticket, payload: answer.payload, conversation: answer.conversation, principalOwner: answer.principalOwner === true };
    const sealed = sealer.seal(Buffer.from(JSON.stringify(claim))).toString('base64');
    record = tx(r => {
      if (r.state !== 'claiming') return r;
      return { ...r, state: 'ready', sealed };
    });
    if (record.state !== 'ready') return { state: record.state, ...(record.receipt ? { receipt: record.receipt } : {}) };
  }
  const proof = { operation: id, worker: record.worker, ticket: claim.ticket };
  let execution = readExecution(executions, id), observed;
  if (!execution && !original) {
    if (launchWorkerAlive(record.worker) !== false) return { state: 'pending', reason: 'original worker remains live or unobserved' };
    const answer = await call('administration-cancel-claim', proof);
    record = tx(r => ({ ...r, state: answer.cancelled ? 'cancelled' : 'unknown' }));
    return { state: record.state };
  }
  if (execution) {
    const status = await call('administration-command', proof);
    if (status.stop && execution.supervisor && !['sealing', 'finished'].includes(execution.phase)) signalAdministrationUnit(env, execution, 'SIGTERM');
    observed = observeAdministrationExecution({ root: executions, id, env });
  } else {
    observed = await runAdministrationCommand({ root: executions, id, env, supervisor, payload: claim.payload,
      execution: { host: own.host, uid: own.uid, gid: own.gid, conversation: claim.conversation, principalOwner: claim.principalOwner === true },
      admit: request => {
        if (executionHash(request.worker) !== executionHash(record.worker)) throw Error('administrative admission moved to another worker');
        return call('administration-admit', proof);
      },
      isStopped: async () => (await call('administration-command', proof)).stop,
    });
  }
  if (!observed?.result) return { state: 'pending', phase: observed?.phase };
  if (observed.result.outcome === 'not-started') {
    const status = await call('administration-command', proof);
    if (['claimed', 'cancelled'].includes(status.operation.state)) {
      const cancelled = await call('administration-cancel-claim', proof);
      if (cancelled.cancelled) { record = tx(r => ({ ...r, state: 'cancelled' })); return { state: record.state }; }
    }
  }
  const result = canonicalResult(observed.result), expected = executionHash(result);
  const answer = await call('administration-complete', { ...proof, result });
  if (answer.id !== id || answer.result?.hash !== expected || !['finished', 'failed', 'unknown', 'cancelled'].includes(answer.state)) throw Error('administrative result acknowledgement does not match its sealed output');
  record = tx(r => ({ ...r, state: 'uploaded', receipt: { hash: expected, state: answer.state } }));
  return { state: record.state, receipt: record.receipt };
}
