// Native admission ownership shared by launch supervisors. A dead registrar or
// worker does not prove that a submitted native/daemon request cannot run.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StateError, withLock } from './state.mjs';

const ID = /^[0-9a-f]{64}$/;
const BODY = /^[A-Za-z0-9-]{4,64}$/;
const fail = message => { throw new StateError(message, 409); };
const root = env => join(env.LOOM_BOX_DATA || join(env.HOME || homedir(), '.local/share/loom-box'), 'launches');
const checked = id => { if (!ID.test(id ?? '')) fail('invalid native launch attempt'); return id; };
const file = (env, id) => join(root(env), checked(id) + '.json');
const locked = (env, fn) => withLock(root(env), 'lock', fn, 'native launch admissions', 10_000);

export function launchAttempt(conversation, operation) {
  if (!/^cv-[0-9a-f]{12}$/.test(conversation ?? '') || !/^[0-9a-f]{12}$/.test(operation ?? '')) fail('a launch needs its conversation and durable operation');
  return createHash('sha256').update(conversation + '\0' + operation).digest('hex');
}

export function readLaunch(env, id) {
  try {
    const r = JSON.parse(readFileSync(file(env, id), 'utf8'));
    if (r?.v !== 1 || r.id !== id || !['claude', 'codex'].includes(r.harness) || !ID.test(r.intentHash ?? '') ||
        !/^[0-9a-f]{24}$/.test(r.token ?? '') || !['reserved', 'admitted', 'ready', 'refused'].includes(r.state)) fail('invalid native launch journal; admission remains held');
    return r;
  }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function save(env, record) {
  mkdirSync(root(env), { recursive: true, mode: 0o700 });
  const target = file(env, record.id), tmp = target + '.' + randomBytes(8).toString('hex') + '.tmp';
  writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmp, target);
}

/** No text, run key or native credentials in this journal; hash a sealed intent. */
export function reserveLaunch(env, { id, harness, intentHash }) {
  checked(id);
  if (!['claude', 'codex'].includes(harness) || !ID.test(intentHash ?? '')) fail('a launch needs its harness and immutable intent hash');
  return locked(env, () => {
    const old = readLaunch(env, id);
    if (old) {
      if (old.harness !== harness || old.intentHash !== intentHash) fail('native launch attempt already has another intent');
      return old;
    }
    const record = { v: 1, id, harness, intentHash, token: randomBytes(12).toString('hex'), state: 'reserved', at: Date.now() };
    save(env, record);
    return record;
  });
}

/** The boot and kernel process start time distinguish a worker from PID reuse. */
export function launchWorkerIdentity() {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!/^[0-9a-f-]{36}$/.test(boot) || !/^\d+$/.test(tail[19] ?? '')) fail('cannot establish native worker OS identity');
  return { pid: process.pid, boot, birth: tail[19] };
}
const sameWorker = (a, b) => !!a && a.pid === b.pid && a.boot === b.boot && a.birth === b.birth;
/** false is positive OS evidence of termination; null is a failed observation. */
export function launchWorkerAlive(worker) {
  if (!worker || !Number.isInteger(worker.pid) || worker.pid <= 0) return null;
  try {
    if (readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== worker.boot) return false;
    const stat = readFileSync(`/proc/${worker.pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (tail[19] !== worker.birth) return false;
    return !['Z', 'X'].includes(tail[0]);
  } catch (e) { return ['ENOENT', 'ESRCH'].includes(e.code) ? false : null; }
}

/** Only a reserved attempt grants permission to enter the native launcher, once.
 * Re-reading even from the same worker is observation, never another admission. */
export function admitLaunch(env, id) {
  const worker = launchWorkerIdentity();
  return locked(env, () => {
    const r = readLaunch(env, id);
    if (!r) fail('native launch was not reserved');
    if (r.state !== 'reserved') return { admitted: false, record: r };
    Object.assign(r, { state: 'admitted', worker, admittedAt: Date.now() });
    save(env, r);
    return { admitted: true, record: r };
  });
}

/** The worker commits a native identity before returning it to its registrar. */
export function completeLaunch(env, id, body) {
  if (!body || !BODY.test(body.id ?? '') || !['claude', 'codex'].includes(body.harness)) fail('invalid native launch receipt');
  if (body.slot !== undefined && (!body.slot || body.slot.harness !== body.harness || !BODY.test(body.slot.session ?? ''))) fail('invalid native continuation receipt');
  // Only the receipt fields, never arbitrary caller data (brief/env/key).
  const receipt = { id: body.id, harness: body.harness,
    ...(body.slot ? { slot: { harness: body.harness, session: body.slot.session } } : {}) };
  const worker = launchWorkerIdentity();
  return locked(env, () => {
    const r = readLaunch(env, id);
    if (!r || !sameWorker(r.worker, worker)) fail('native launch receipt is not this worker\'s');
    if (r.harness !== receipt.harness) fail('native launch receipt changed harness');
    if (r.state === 'ready') {
      if (JSON.stringify(r.body) !== JSON.stringify(receipt)) fail('native launch already has another receipt');
      return r;
    }
    if (r.state !== 'admitted') fail('native launch was not admitted');
    Object.assign(r, { state: 'ready', body: receipt, readyAt: Date.now() });
    save(env, r);
    return r;
  });
}

/** Only a native adapter's positive pre-spawn failure can release the attempt.
 * Absence, age, a dead worker and daemon timeouts never call this transition. */
export function refuseLaunch(env, id, reason) {
  return locked(env, () => {
    const r = readLaunch(env, id);
    if (!r || r.state !== 'admitted' || !sameWorker(r.worker, launchWorkerIdentity())) fail('native refusal is not this worker\'s admission');
    Object.assign(r, { state: 'refused', reason: String(reason).slice(0, 300), refusedAt: Date.now() });
    save(env, r);
    return r;
  });
}

/** Internal native observer commits an adapter-recovered identity. It has no
 * permission to reset/relaunch the attempt, and conflicting receipts refuse. */
export function recoverLaunchReceipt(env, id, body) {
  if (!body || !BODY.test(body.id ?? '') || !['claude', 'codex'].includes(body.harness) ||
      (body.slot !== undefined && (!body.slot || body.slot.harness !== body.harness || !BODY.test(body.slot.session ?? '')))) fail('invalid recovered native receipt');
  const receipt = { id: body.id, harness: body.harness, ...(body.slot ? { slot: { harness: body.harness, session: body.slot.session } } : {}) };
  return locked(env, () => {
    const r = readLaunch(env, id);
    if (!r || r.harness !== body.harness || !['admitted', 'ready'].includes(r.state)) fail('native attempt cannot accept a recovered receipt');
    if (r.state === 'ready') {
      if (JSON.stringify(r.body) !== JSON.stringify(receipt)) fail('native attempt has another receipt');
      return r;
    }
    Object.assign(r, { state: 'ready', body: receipt, recoveredAt: Date.now() });
    save(env, r);
    return r;
  });
}
