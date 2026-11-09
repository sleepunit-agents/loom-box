import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { admitLaunch, completeLaunch, launchAttempt, readLaunch, reserveLaunch } from '../src/launch-journal.mjs';
import { scratch } from './scratch.mjs';

const exec = promisify(execFile);
const setup = () => {
  const env = { LOOM_BOX_DATA: scratch('launch-journal-') };
  const id = launchAttempt('cv-123456789abc', '123456789abc');
  const request = { id, harness: 'codex', intentHash: 'a'.repeat(64) };
  return { env, id, request };
};

test('an attempt retains its token and refuses changes to the immutable native intent', () => {
  const { env, id, request } = setup();
  const first = reserveLaunch(env, request);
  assert.deepEqual(reserveLaunch(env, request), first);
  assert.throws(() => reserveLaunch(env, { ...request, harness: 'claude' }), /another intent/);
  assert.throws(() => reserveLaunch(env, { ...request, intentHash: 'b'.repeat(64) }), /another intent/);
  assert.equal(statSync(join(env.LOOM_BOX_DATA, 'launches', id + '.json')).mode & 0o777, 0o600);
});

test('even the same worker receives native admission only once; a receipt cannot change', () => {
  const { env, id, request } = setup();
  reserveLaunch(env, request);
  assert.equal(admitLaunch(env, id).admitted, true);
  assert.equal(admitLaunch(env, id).admitted, false);
  const body = { id: 'native-1234', harness: 'codex', brief: 'must not persist', env: { secret: 'must not persist' } };
  const ready = completeLaunch(env, id, body);
  assert.deepEqual(ready.body, { id: 'native-1234', harness: 'codex' });
  assert.deepEqual(completeLaunch(env, id, body), ready);
  assert.throws(() => completeLaunch(env, id, { ...body, id: 'native-5678' }), /another receipt/);
  assert.equal(admitLaunch(env, id).admitted, false);
  assert.doesNotMatch(readFileSync(join(env.LOOM_BOX_DATA, 'launches', id + '.json'), 'utf8'), /must not persist/);
});

test('independent actual worker processes race for one admission; death never grants another', async () => {
  const { env, id, request } = setup();
  reserveLaunch(env, request);
  const moduleURL = new URL('../src/launch-journal.mjs', import.meta.url).href;
  const code = `import {admitLaunch} from ${JSON.stringify(moduleURL)};console.log(JSON.stringify(admitLaunch(process.env,process.argv[1])));`;
  const workers = await Promise.all([0, 1].map(() => exec(process.execPath, ['--input-type=module', '-e', code, id], { env: { ...process.env, ...env } })));
  assert.equal(workers.map(w => JSON.parse(w.stdout)).filter(w => w.admitted).length, 1);
  assert.equal(readLaunch(env, id).state, 'admitted');
  // Both worker processes are now authoritatively terminal. Native work may
  // outlive them, so a fresh worker still receives no new launch permission.
  const fresh = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', code, id], { env: { ...process.env, ...env } })).stdout);
  assert.equal(fresh.admitted, false);
  assert.throws(() => completeLaunch(env, id, { id: 'native-1234', harness: 'codex' }), /not this worker/);
});
