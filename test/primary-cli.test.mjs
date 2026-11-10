import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';

test('primary reads without writing; clearing requires --clear', () => {
  const home = scratch('primary-cli-');
  const state = join(home, 'state.json');
  writeFileSync(state, JSON.stringify({ v: 1, boxes: { loom: { local: true, mayHost: '*' }, one: { mayHost: '*' } }, primaries: { art: ['one', 'loom'] }, agents: {}, houses: {}, seq: 0 }), { mode: 0o600 });
  const run = (...args) => spawnSync(process.execPath, [join(import.meta.dirname, '../src/cli.mjs'), 'primary', ...args], { encoding: 'utf8', env: { ...process.env, LOOM_BOX_HOME: home, LOOM_BOX_LOCAL_NAME: 'loom' } });
  const before = readFileSync(state, 'utf8');
  const read = run('art');
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), { agent: 'art', primary: 'one', boxes: ['one', 'loom'] });
  assert.equal(readFileSync(state, 'utf8'), before);
  for (const args of [[], ['art', '--typo'], ['art', '--clear', 'one']]) {
    assert.notEqual(run(...args).status, 0);
    assert.equal(readFileSync(state, 'utf8'), before);
  }
  assert.equal(run('art', '--clear').status, 0);
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).primaries.art, undefined);
  assert.deepEqual(JSON.parse(run('art', 'one', 'loom').stdout).boxes, ['one', 'loom']);
});
