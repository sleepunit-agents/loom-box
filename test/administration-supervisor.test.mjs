import test from 'node:test';
import assert from 'node:assert/strict';
import { administrationUnit, administrationUnitState } from '../src/administration-supervisor.mjs';

test('only an explicit fixture adapter selects the test unit namespace', () => {
  const id = 'ado-' + 'a'.repeat(32), root = '/isolated/execution';
  assert.match(administrationUnit(root, id), /^loom-admin-[a-f0-9]{32}-[a-f0-9]{12}\.service$/);
  assert.match(administrationUnit(root, id, true), /^loom-admin-test-[a-f0-9]{32}-[a-f0-9]{12}\.service$/);
  assert.notEqual(administrationUnit(root, id), administrationUnit(root, id, true));
  assert.match(administrationUnit('/tmp/loom-box-test-example', id), /^loom-admin-a/);
  assert.throws(() => administrationUnitState({}, 'loom-admin-test-arbitrary.service'), /invalid/);
});
