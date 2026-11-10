import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';
import { administrationUnit } from '../src/administration-supervisor.mjs';
import { cleanupAdministrationFixture, trackAdministrationFixture } from './administration-fixture.mjs';

test('fixture teardown requires positive manager evidence and attempts every exact unit', () => {
  const root = scratch('admin-cleanup-'), log = join(root, 'calls');
  const bin = join(root, 'systemctl');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.includes('show')) {
  if (process.env.FIXTURE_MANAGER_DOWN) process.exit(1);
  console.log('inactive');
}
`);
  chmodSync(bin, 0o755);
  const saved = { ...process.env };
  try {
    process.env.PATH = root;
    process.env.LOOM_ADMIN_TEST_SUPERVISOR = 'systemd';
    const a = 'ado-' + 'a'.repeat(32), b = 'ado-' + 'b'.repeat(32);
    trackAdministrationFixture(root, () => a);
    cleanupAdministrationFixture();
    let calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(args => args.includes(administrationUnit(root, a, true))));
    assert.ok(calls.every(args => !args.includes(administrationUnit(root, a))));
    process.env.FIXTURE_MANAGER_DOWN = '1';
    trackAdministrationFixture(root, () => a);
    trackAdministrationFixture(root, () => b);
    assert.throws(cleanupAdministrationFixture, error => error instanceof AggregateError && error.errors.length === 2);
    calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 9); // both units attempted even after first observation fails
    assert.ok(calls.at(-1).includes(administrationUnit(root, b, true)));
    cleanupAdministrationFixture(); // failed entries do not leak into later tests
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 9);
  } finally {
    process.env = saved;
  }
});
