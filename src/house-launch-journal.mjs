// The controller's sealed request and native receipt survive its registrar.
// All mutations share houserunner's host lock with publication and host sync.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StateError } from './state.mjs';
import { SEAT } from './principal.mjs';

const ID = /^[0-9a-f]{64}$/;
const root = env => join(env.LOOM_BOX_DATA || join(env.HOME || homedir(), '.local/share/loom-box'), 'delivery/house-launches');
const file = (env, id) => {
  if (!ID.test(id ?? '')) throw new StateError('invalid house launch attempt', 409);
  return join(root(env), id + '.json');
};
function validate(r, id) {
  if (r?.v !== 1 || r.id !== id || !ID.test(r.intentHash ?? '') || !['claude', 'codex'].includes(r.harness)
      || !/^[a-z][a-z0-9-]{0,39}$/.test(r.agent ?? '') || !/^h-[0-9]{1,9}$/.test(r.house ?? '')
      || !/^[0-9a-f]{16}$/.test(r.rid ?? '') || !['reserved', 'publishing', 'published', 'ready', 'refused'].includes(r.state)
      || !SEAT.test(r.seat ?? '') || (['reserved', 'publishing', 'published'].includes(r.state) && typeof r.sealed !== 'string')) {
    throw new StateError('invalid house launch journal; its admission remains held', 409);
  }
  if (r.state === 'ready' && (!/^[A-Za-z0-9-]{4,64}$/.test(r.body?.id ?? '') || r.body.harness !== r.harness || r.body.house !== r.house || r.body.seat !== r.seat)) {
    throw new StateError('invalid house native receipt; its admission remains held', 409);
  }
  if (r.state === 'refused' && typeof r.reason !== 'string') throw new StateError('invalid house refusal receipt', 409);
  return r;
}
export function readHouseLaunch(env, id) {
  try { return validate(JSON.parse(readFileSync(file(env, id), 'utf8')), id); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function writeHouseLaunch(env, record) {
  validate(record, record.id);
  mkdirSync(root(env), { recursive: true, mode: 0o700 });
  const target = file(env, record.id), temporary = target + '.' + randomBytes(8).toString('hex') + '.tmp';
  writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, target);
}
export const houseLaunchHandle = r => Object.fromEntries(['id', 'intentHash', 'harness', 'agent', 'seat', 'house', 'rid'].map(k => [k, r[k]]));
