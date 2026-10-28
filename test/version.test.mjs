// Keeping a box on the loom-box loom runs (src/version.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownCommit, maybeUpgrade, vetCommit, UPGRADE_RETRY_MS } from '../src/version.mjs';

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
  const vet = () => null;
  assert.match(maybeUpgrade({ want: B, mine: A, stateDir, env: {}, nowMs: t0, spawn, vet }), /installing loom-box bbbbbbb/);
  assert.deepEqual(runs[0].slice(0, 5), ['systemd-run', '--user', '--collect', '--quiet', `--unit=loom-box-upgrade-${B.slice(0, 12)}`]);
  assert.deepEqual(runs[0].slice(5), ['loom', 'pieces', 'install', '--from', `github:sleepunit-agents/loom-box#${B}`, '--yes']);
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'upgrade.json'), 'utf-8')).commit, B);
  // Not again until the retry time: a failed install isn't a loop.
  assert.equal(maybeUpgrade({ want: B, mine: A, stateDir, env: {}, nowMs: t0 + 60_000, spawn, vet }), null);
  assert.match(maybeUpgrade({ want: B, mine: A, stateDir, env: {}, nowMs: t0 + UPGRADE_RETRY_MS + 1, spawn, vet }), /installing/);
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

test('a commit the box can\'t vet isn\'t installed: off main, or behind what it runs', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'loom-box-v-'));
  const spawn = () => assert.fail('nothing should be installed');
  assert.match(maybeUpgrade({ want: B, mine: A, stateDir, env: {}, spawn, vet: () => `${B.slice(0, 7)} isn't on sleepunit-agents/loom-box's main` }), /not installing loom-box bbbbbbb: .* isn't on/);
});

test('vetting asks git: on main, and not behind', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args.slice(2).join(' ')); const verb = args[2];
    if (verb === 'merge-base' && args[5] === 'FETCH_HEAD') return { status: 0 };
    if (verb === 'merge-base') return { status: 1 };   // not an ancestor of mine: forward
    return { status: 0 }; };
  assert.equal(vetCommit('o/r', B, A, run), null);
  assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['init', 'fetch', 'merge-base', 'merge-base']);
  const offMain = (cmd, args) => ({ status: args[2] === 'merge-base' && args[5] === 'FETCH_HEAD' ? 1 : 0 });
  assert.match(vetCommit('o/r', B, A, offMain), /isn't on o\/r's main/);
  const back = (cmd, args) => ({ status: 0 });
  assert.match(vetCommit('o/r', B, A, back), /rollback is done by hand/);
});
