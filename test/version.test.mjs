// Keeping a box on the runtime loom runs (src/version.mjs): the install, what the box says about it, "Update now",
// and the box → runtime swap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyUpgrade, carriedSettings, lastUpgrade, maybeUpgrade, ownCommit, ownPiece, packagePiece, swapCommand, vetCommit, INSTALL_STALE_MS, UPGRADE_RETRY_MS } from '../src/version.mjs';
import { scratch } from './scratch.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const record = (dir) => JSON.parse(readFileSync(join(dir, 'upgrade.json'), 'utf-8'));

test('a process knows its commit and the piece it\'s installed as from the path loom installed it at; a dev checkout has neither', () => {
  assert.equal(ownCommit(`file:///home/x/.config/loom/pieces/box/versions/${A}/node_modules/loom-box/src/version.mjs`), A);
  assert.equal(ownPiece(`file:///home/x/.config/loom/pieces/box/versions/${A}/node_modules/loom-box/src/version.mjs`), 'box');
  assert.equal(ownPiece(`file:///home/x/.config/loom/pieces/runtime/versions/${A}/node_modules/loom-runtime/src/version.mjs`), 'runtime');
  assert.equal(ownCommit('file:///home/x/Code/loom-box/src/version.mjs'), null);
  assert.equal(ownPiece('file:///home/x/Code/loom-box/src/version.mjs'), null);
  assert.equal(packagePiece({ loom: { name: 'runtime' }, bin: { 'loom-runtime': 'x', 'loom-box': 'x' } }), 'runtime');
  assert.equal(packagePiece({ bin: { 'loom-box': 'x' } }), 'box');
});

test('a box on another commit installs loom\'s, from a unit of its own running this version\'s upgrade-apply, once until the retry time', () => {
  const stateDir = scratch('loom-box-v-');
  const runs = [];
  const spawn = (cmd, args) => { runs.push([cmd, ...args]); return { status: 0 }; };
  const t0 = Date.parse('2026-10-28T12:00:00Z');
  const vet = (_r, _w, _m, _run, out) => { out.piece = 'runtime'; return null; };
  const o = { want: B, mine: A, piece: 'runtime', stateDir, env: {}, spawn, vet, cli: '/v/cli.mjs', node: '/usr/bin/node' };
  assert.match(maybeUpgrade({ ...o, nowMs: t0 }), /installing bbbbbbb/);
  assert.deepEqual(runs[0].slice(0, 5), ['systemd-run', '--user', '--collect', '--quiet', `--unit=loom-box-upgrade-${B.slice(0, 12)}`]);
  assert.deepEqual(runs[0].slice(5), ['/usr/bin/node', '/v/cli.mjs', 'upgrade-apply', '--commit', B, '--from', A, '--repo', 'sleepunit-agents/loom-box', '--piece', 'runtime', '--target', 'runtime']);
  assert.deepEqual([record(stateDir).commit, record(stateDir).state], [B, 'installing']);
  // Not again until the retry time: a failed install isn't a loop.
  assert.equal(maybeUpgrade({ ...o, nowMs: t0 + 60_000 }), null);
  assert.match(maybeUpgrade({ ...o, nowMs: t0 + UPGRADE_RETRY_MS + 1 }), /installing/);
  assert.equal(runs.length, 2);
});

test('nothing when it\'s the same, unknown, mid-start, off, or loom names no commit', () => {
  const stateDir = scratch('loom-box-v-');
  const spawn = () => assert.fail('nothing should run');
  for (const args of [{ want: A, mine: A }, { want: B, mine: null }, { want: B, mine: A, starting: true },
    { want: B, mine: A, env: { LOOM_BOX_UPGRADE: 'off' } }, { want: undefined, mine: A }, { want: 'not-a-commit', mine: A }]) {
    assert.equal(maybeUpgrade({ env: {}, stateDir, spawn, ...args }), null, JSON.stringify(args));
  }
});

test('a commit the box can\'t vet isn\'t installed, and the box says why and when it asks again', () => {
  const stateDir = scratch('loom-box-v-');
  const spawn = () => assert.fail('nothing should be installed');
  const t0 = Date.parse('2026-10-28T12:00:00Z');
  assert.match(maybeUpgrade({ want: B, mine: A, stateDir, env: {}, spawn, nowMs: t0, vet: () => `${B.slice(0, 7)} isn't on sleepunit-agents/loom-box's main` }), /not installing bbbbbbb: .* isn't on/);
  const u = lastUpgrade(stateDir, t0 + 1000);
  assert.deepEqual([u.state, u.error, u.retryAt], ['refused', 'bbbbbbb isn\'t on sleepunit-agents/loom-box\'s main', new Date(t0 + UPGRADE_RETRY_MS).toISOString()]);
});

test('an install the unit never finished reads as failed, saying so; a record from before says it\'s installing', () => {
  const stateDir = scratch('loom-box-v-');
  const t0 = Date.parse('2026-10-28T12:00:00Z');
  writeFileSync(join(stateDir, 'upgrade.json'), JSON.stringify({ commit: B, from: A, at: new Date(t0).toISOString(), state: 'installing' }));
  assert.equal(lastUpgrade(stateDir, t0 + 60_000).state, 'installing');
  const late = lastUpgrade(stateDir, t0 + INSTALL_STALE_MS + 1);
  assert.equal(late.state, 'failed');
  assert.match(late.error, /never said how it went/);
  writeFileSync(join(stateDir, 'upgrade.json'), JSON.stringify({ commit: B, from: A, at: new Date(t0).toISOString() }));
  assert.equal(lastUpgrade(stateDir, t0).state, 'installing');
});

test('"Update now" clears the retry wait (the vetting stays), but never starts a second install over one under way', () => {
  const stateDir = scratch('loom-box-v-');
  const t0 = Date.parse('2026-10-28T12:00:00Z');
  let vetted = 0;
  const runs = [];
  const o = { want: B, mine: A, piece: 'runtime', stateDir, env: {}, spawn: (c, a) => { runs.push(a); return { status: 0 }; }, vet: () => { vetted++; return null; } };
  writeFileSync(join(stateDir, 'upgrade.json'), JSON.stringify({ commit: B, from: A, at: new Date(t0).toISOString(), state: 'failed', error: 'loom pieces install failed (exit 1)', retryAt: new Date(t0 + UPGRADE_RETRY_MS).toISOString() }));
  assert.equal(maybeUpgrade({ ...o, nowMs: t0 + 60_000 }), null, 'inside the wait');
  assert.match(maybeUpgrade({ ...o, nowMs: t0 + 60_000, now: true }), /installing/);
  assert.deepEqual([vetted, runs.length, record(stateDir).state], [1, 1, 'installing']);
  assert.equal(maybeUpgrade({ ...o, nowMs: t0 + 120_000, now: true }), null, 'one under way: not again');
  // A refusal on vetting holds with "now" too: the box doesn't trust the commit any more for being asked twice.
  const d2 = scratch('loom-box-v-');
  assert.match(maybeUpgrade({ ...o, stateDir: d2, now: true, vet: () => 'not on main' }), /not installing/);
});

test('vetting asks git: on main, not behind, and reads what the commit installs as', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args.slice(2).join(' ')); return args[2] === 'show' ? { status: 0, stdout: JSON.stringify({ loom: { name: 'runtime' } }) } : { status: 0 }; };
  const out = {};
  assert.equal(vetCommit('o/r', B, A, run, out), null, 'on main, and mine comes before it');
  assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['init', 'fetch', 'merge-base', 'merge-base', 'show']);
  assert.equal(calls[3], `merge-base --is-ancestor ${A} ${B}`);
  assert.equal(out.piece, 'runtime');
  const offMain = (cmd, args) => ({ status: args[2] === 'merge-base' && args[5] === 'FETCH_HEAD' ? 1 : 0 });
  assert.match(vetCommit('o/r', B, A, offMain), /isn't on o\/r's main/);
  for (const code of [1, 128]) {
    const notForward = (cmd, args) => ({ status: args[2] === 'merge-base' && args[4] === A ? code : 0 });
    assert.match(vetCommit('o/r', B, A, notForward), /rollback is done by hand/, String(code));
  }
});

/** A stand-in `loom`: records each call, and fails the ones `fails` names (by their argv, joined). */
function fakeLoom(home, fails = []) {
  const calls = [];
  const run = (bin, args) => {
    calls.push(args.join(' '));
    if (fails.some((f) => args.join(' ').startsWith(f))) return { status: 1, stdout: '', stderr: 'npm ERR! EEXIST: file already exists, bin loom-box\nnpm ERR! token=npm_SECRET0123456789abcdefghij' };
    // A successful install of runtime: loom writes its piece.json, with the settings it declares.
    if (args[0] === 'pieces' && args[1] === 'install' && args[3].endsWith(B)) {
      mkdirSync(join(home, 'pieces', 'runtime'), { recursive: true });
      writeFileSync(join(home, 'pieces', 'runtime', 'piece.json'), JSON.stringify({ loom: { settings: [{ name: 'LOOM_RUNTIME_LOOM_URL' }, { name: 'LOOM_RUNTIME_PUBLIC_URL' }] } }));
    }
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  return { run, calls };
}
function oldBox() {
  const home = scratch('loom-home-');
  mkdirSync(join(home, 'pieces', 'box'), { recursive: true });
  writeFileSync(join(home, 'pieces', 'box', 'settings.json'), JSON.stringify({ LOOM_BOX_LOOM_URL: 'https://loom.example.ts.net/mcp', LOOM_BOX_PUBLIC_URL: 'https://loom.example', LOOM_BOX_GONE: 'x' }));
  return home;
}

test('the rename: a box installed as box, told to install a runtime commit, swaps the pieces and carries its settings over', () => {
  const home = oldBox();
  const stateDir = scratch('loom-box-v-');
  const { run, calls } = fakeLoom(home);
  const r = applyUpgrade({ commit: B, from: A, piece: 'box', target: 'runtime', env: { LOOM_HOME: home }, stateDir, run });
  assert.equal(r.state, 'done');
  assert.deepEqual(calls, [
    'pieces remove box',
    `pieces install --from github:sleepunit-agents/loom-box#${B} --yes`,
    // Only what runtime declares, under its names: LOOM_BOX_GONE isn't one of them.
    'pieces set runtime LOOM_RUNTIME_LOOM_URL=https://loom.example.ts.net/mcp LOOM_RUNTIME_PUBLIC_URL=https://loom.example',
  ]);
  assert.deepEqual([record(stateDir).state, record(stateDir).swapped], ['done', { from: 'box', to: 'runtime', settings: 2 }]);
});

test('the rename: an install that fails puts the box piece back, and says so, with the install\'s last lines and no token', () => {
  const home = oldBox();
  const stateDir = scratch('loom-box-v-');
  const { run, calls } = fakeLoom(home, [`pieces install --from github:sleepunit-agents/loom-box#${B}`]);
  const r = applyUpgrade({ commit: B, from: A, piece: 'box', target: 'runtime', env: { LOOM_HOME: home }, stateDir, run });
  assert.equal(r.state, 'failed');
  assert.deepEqual(calls, ['pieces remove box', `pieces install --from github:sleepunit-agents/loom-box#${B} --yes`, `pieces install --from github:sleepunit-agents/loom-box#${A} --yes`]);
  assert.match(record(stateDir).error, /installing runtime failed \(exit 1\); the box piece is back as it was/);
  assert.match(record(stateDir).detail, /EEXIST: file already exists, bin loom-box/);
  assert.equal(record(stateDir).detail.includes('npm_SECRET'), false);
  // Both failing: it says what to run by hand.
  const both = fakeLoom(oldBox(), ['pieces install']);
  const r2 = applyUpgrade({ commit: B, from: A, piece: 'box', target: 'runtime', env: { LOOM_HOME: home }, stateDir, run: both.run });
  assert.match(r2.error, /putting the box piece back failed too .*loom pieces install --from github:sleepunit-agents\/loom-box#a{40} --yes/);
});

test('a plain update is one install; a failed one says so', () => {
  const stateDir = scratch('loom-box-v-');
  const { run, calls } = fakeLoom(scratch('loom-home-'), ['pieces install']);
  const r = applyUpgrade({ commit: B, from: A, piece: 'runtime', target: 'runtime', env: {}, stateDir, run });
  assert.deepEqual([r.state, calls.length], ['failed', 1]);
  assert.match(record(stateDir).error, /loom pieces install failed \(exit 1\)/);
});

test('settings carry under the new names, and the one line for a box too old to swap itself', () => {
  assert.deepEqual(carriedSettings({ LOOM_BOX_LOOM_URL: 'u', LOOM_RUNTIME_ACCOUNTS: 'none', OTHER: 'x' }), ['LOOM_RUNTIME_LOOM_URL=u', 'LOOM_RUNTIME_ACCOUNTS=none']);
  assert.equal(swapCommand(B), `loom pieces remove box && loom pieces install --from github:sleepunit-agents/loom-box#${B} --yes && loom runtime carry-settings`);
});
