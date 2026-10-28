// Keeping a box on the loom-box loom runs (src/version.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownCommit, maybeUpgrade, UPGRADE_RETRY_MS } from '../src/version.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40);

test('a process knows its commit from the path loom installed it at; a dev checkout has none', () => {
  assert.equal(ownCommit(`file:///home/x/.config/loom/pieces/box/versions/${A}/node_modules/loom-box/src/version.mjs`), A);
  assert.equal(ownCommit('file:///home/x/Code/loom-box/src/version.mjs'), null);
});

test('a box on another commit installs loom\'s, from a unit of its own, once until the retry time', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'loom-box-v-'));
  const runs = [];
  const spawn = (cmd, args) => { runs.push([cmd, ...args]); return { status: 0 }; };
  const t0 = Date.parse('2026-10-28T12:00:00Z');
  assert.match(maybeUpgrade({ want: B, mine: A, stateDir, env: {}, nowMs: t0, spawn }), /installing loom-box bbbbbbb/);
  assert.deepEqual(runs[0].slice(0, 5), ['systemd-run', '--user', '--collect', '--quiet', `--unit=loom-box-upgrade-${B.slice(0, 12)}`]);
  assert.deepEqual(runs[0].slice(5), ['loom', 'pieces', 'install', '--from', `github:sleepunit-agents/loom-box#${B}`, '--yes']);
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'upgrade.json'), 'utf-8')).commit, B);
  // Not again until the retry time: a failed install isn't a loop.
  assert.equal(maybeUpgrade({ want: B, mine: A, stateDir, env: {}, nowMs: t0 + 60_000, spawn }), null);
  assert.match(maybeUpgrade({ want: B, mine: A, stateDir, env: {}, nowMs: t0 + UPGRADE_RETRY_MS + 1, spawn }), /installing/);
  assert.equal(runs.length, 2);
});

test('nothing when it\'s the same, unknown, mid-start, off, or loom names no commit', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'loom-box-v-'));
  const spawn = () => assert.fail('nothing should run');
  for (const args of [{ want: A, mine: A }, { want: B, mine: null }, { want: B, mine: A, starting: true },
    { want: B, mine: A, env: { LOOM_BOX_UPGRADE: 'off' } }, { want: undefined, mine: A }, { want: 'not-a-commit', mine: A }]) {
    assert.equal(maybeUpgrade({ env: {}, stateDir, spawn, ...args }), null, JSON.stringify(args));
  }
});
