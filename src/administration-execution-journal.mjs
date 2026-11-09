// Box-private execution receipts. Inputs and results are sealed; no shell text
// or host credential belongs in this journal.
import { randomBytes, createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withLock } from './state.mjs';

export const executionHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const target = (root, id) => {
  if (!/^ado-[0-9a-f]{32}$/.test(id ?? '')) throw Error('invalid administrative execution id');
  return join(root, id + '.json');
};
const identity = r => r && Number.isSafeInteger(r.pid) && r.pid > 0 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.boot ?? '') && /^[0-9]{1,24}$/.test(r.birth ?? '');
function validate(r, id) {
  const broken = () => { throw Error('administrative execution receipt cannot be decoded'); };
  if (r?.v !== 1 || r.id !== id || !/^[0-9a-f]{64}$/.test(r.payloadHash ?? '') ||
      !['prepared', 'gated', 'released', 'executing', 'sealing', 'finished'].includes(r.phase) || !identity(r.worker) ||
      !/^linux-[0-9a-f]{64}$/.test(r.execution?.host ?? '') || !Number.isInteger(r.execution.uid) || r.execution.uid < 0 ||
      !Number.isInteger(r.execution.gid) || r.execution.gid < 0 || r.worker.host !== r.execution.host ||
      r.worker.uid !== r.execution.uid || r.worker.gid !== r.execution.gid || typeof r.inputSealed !== 'string' || !r.inputSealed) broken();
  if (r.child && !identity(r.child)) broken();
  if (['gated', 'released', 'executing', 'sealing'].includes(r.phase) && !r.child) broken();
  if (['released', 'executing'].includes(r.phase) && (!Number.isSafeInteger(r.deadlineMono) || r.deadlineMono <= 0)) broken();
  if (r.phase === 'finished' && (typeof r.resultSealed !== 'string' || !r.resultSealed)) broken();
  return r;
}
export function readExecution(root, id) {
  let fd;
  try { fd = openSync(target(root, id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.mode & 0o077 || st.uid !== process.getuid() || st.size > 2 * 1024 * 1024) throw Error('administrative execution is not a bounded private file');
    const text = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(text) !== st.size) throw Error('administrative execution changed while reading');
    return validate(JSON.parse(text), id);
  } finally { closeSync(fd); }
}
export function executionTransaction(root, id, fn) {
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  return withLock(root, id + '.lock', () => {
    const old = readExecution(root, id), next = fn(old);
    if (!next) return old;
    validate(next, id);
    const path = target(root, id), tmp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error('administrative execution exceeds its journal budget');
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    // A durable encrypted receipt also needs its key to survive a restart.
    for (const name of ['runtime.key', 'runtime.pub']) {
      let key;
      try { key = openSync(join(root, 'secrets', name), constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      try { fsyncSync(key); } finally { closeSync(key); }
    }
    renameSync(tmp, path);
    for (const path of [join(root, 'secrets'), root, dirname(root)]) {
      const directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return next;
  }, 'administrative execution');
}
export const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);
