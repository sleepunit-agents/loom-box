// Keeping a box on the runtime loom runs (src/version.mjs): the install, what the box says about it, "Update now",
// and the box → runtime swap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyUpgrade, carriedSettings, coreDir, updateCore, lastUpgrade, loadCarried, maybeUpgrade, ownCommit, ownPiece, packagePiece, recoverUpgrade, recoveryTrusted, swapCommand, vetCommit, INSTALL_STALE_MS, RECOVER_TRUST_MS, UPGRADE_RETRY_MS } from '../src/version.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

test('"Update now" clears the retry wait (the vetting stays), carries its token into the record, and says why when it can\'t start', () => {
  const stateDir = scratch('loom-box-v-');
  const t0 = Date.parse('2026-10-28T12:00:00Z');
  let vetted = 0;
  const runs = [];
  const vet = (_r, _w, _m, _run, out) => { vetted++; out.piece = 'runtime'; return null; };
  const o = { want: B, mine: A, piece: 'runtime', stateDir, env: {}, spawn: (c, a) => { runs.push(a); return { status: 0 }; }, vet };
  writeFileSync(join(stateDir, 'upgrade.json'), JSON.stringify({ commit: B, from: A, at: new Date(t0).toISOString(), state: 'failed', error: 'loom pieces install failed (exit 1)', retryAt: new Date(t0 + UPGRADE_RETRY_MS).toISOString() }));
  assert.equal(maybeUpgrade({ ...o, nowMs: t0 + 60_000 }), null, 'inside the wait');
  // Can't start yet: it says why, and nothing is tried (loom keeps asking until an attempt carries the token).
  assert.equal(maybeUpgrade({ ...o, nowMs: t0 + 60_000, now: 'a1b2c3d4e5f6', starting: true }), 'update now waits: a house is starting; it tries after');
  assert.equal(maybeUpgrade({ ...o, nowMs: t0 + 60_000, now: 'a1b2c3d4e5f6', env: { LOOM_BOX_UPGRADE: 'off' } }), 'update now waits: upgrades are off on this box (LOOM_BOX_UPGRADE=off)');
  assert.equal(maybeUpgrade({ ...o, nowMs: t0 + 60_000, now: 'a1b2c3d4e5f6', want: undefined }), 'update now waits: loom names no runtime commit (it runs a dev checkout)');
  assert.equal(runs.length, 0);
  assert.match(maybeUpgrade({ ...o, nowMs: t0 + 60_000, now: 'a1b2c3d4e5f6' }), /installing/);
  assert.deepEqual([vetted, runs.length, record(stateDir).state, record(stateDir).now], [1, 1, 'installing', 'a1b2c3d4e5f6']);
  assert.match(maybeUpgrade({ ...o, nowMs: t0 + 120_000, now: 'ffffffffffff' }), /update now waits: an upgrade to bbbbbbb is under way/);
  assert.equal(runs.length, 1, 'never a second install over one under way');
  // A refusal on vetting holds with "now" too.
  assert.match(maybeUpgrade({ ...o, stateDir: scratch('loom-box-v-'), now: 'a1b2c3d4e5f6', vet: () => 'not on main' }), /not installing/);
});

test('vetting asks git: on main, not behind, and reads what the commit installs as; a package.json it can\'t read is a refusal', () => {
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
  // Before, an unreadable package.json fell back to a plain install, which is the bin clash on a renamed package.
  const noShow = (cmd, args) => (args[2] === 'show' ? { status: 128, stdout: '' } : { status: 0 });
  assert.equal(vetCommit('o/r', B, A, noShow), `couldn't read bbbbbbb's package.json, so can't tell which piece it installs as`);
  const noName = (cmd, args) => (args[2] === 'show' ? { status: 0, stdout: '{"name":"x"}' } : { status: 0 });
  assert.match(vetCommit('o/r', B, A, noName), /doesn't say which piece it installs as/);
});

test('vetting with real git, against a local bare repo as the remote', () => {
  const root = scratch('loom-box-git-');
  const git = (cwd, ...args) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf-8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const src = join(root, 'src');
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'loom-box', bin: { 'loom-box': 'x' } }));
  git(src, 'add', '.'); git(src, 'commit', '-qm', 'box');
  const old = git(src, 'rev-parse', 'HEAD');
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'loom-runtime', bin: { 'loom-runtime': 'x', 'loom-box': 'x' }, loom: { name: 'runtime' } }));
  git(src, 'add', '.'); git(src, 'commit', '-qm', 'runtime');
  const renamed = git(src, 'rev-parse', 'HEAD');
  git(src, 'checkout', '-qb', 'side', old);
  writeFileSync(join(src, 'f'), 'x'); git(src, 'add', '.'); git(src, 'commit', '-qm', 'side');
  const side = git(src, 'rev-parse', 'HEAD');
  git(root, 'clone', '-q', '--bare', src, 'bare.git');
  const url = `file://${join(root, 'bare.git')}`;
  const out = {};
  assert.equal(vetCommit('o/r', renamed, old, spawnSync, out, url), null);
  assert.equal(out.piece, 'runtime');
  assert.match(vetCommit('o/r', old, renamed, spawnSync, {}, url), /rollback is done by hand/);
  assert.match(vetCommit('o/r', side, old, spawnSync, {}, url), /isn't on o\/r's main/);
});

/**
 * A stand-in `loom` (and systemd-run, systemctl), keeping what's installed as loom does: pieces/<name>/piece.json.
 * `fails` lists argv prefixes that exit 1; `dies` ones that throw, as a unit killed mid-step would stop.
 */
function fakeLoom(home, { fails = [], dies = [] } = {}) {
  const calls = [];
  let active = false;
  const rec = (name, r) => { mkdirSync(join(home, 'pieces', name), { recursive: true }); writeFileSync(join(home, 'pieces', name, 'piece.json'), JSON.stringify(r)); };
  const run = (bin, args) => {
    const line = args.join(' ');
    calls.push(bin === 'systemd-run' || bin === 'systemctl' ? `${bin} ${line}` : line);
    if (dies.some((f) => line.startsWith(f))) throw new Error('killed');
    if (fails.some((f) => line.startsWith(f))) return { status: 1, stdout: '', stderr: 'npm ERR! EEXIST: file already exists, bin loom-box\nnpm ERR! token=npm_SECRET0123456789abcdefghij' };
    // systemd as far as the recovery timer goes: is-active is "its files are there and it was enabled since boot".
    if (bin === 'systemctl' && args.includes('enable')) active = true;
    if (bin === 'systemctl' && args.includes('disable')) active = false;
    if (bin === 'systemctl' && args.includes('is-active')) return { status: active && existsSync(join(home, '.config', 'systemd', 'user', 'loom-box-upgrade-recover.timer')) ? 0 : 3 };
    if (bin !== 'loom' && !bin.endsWith('/loom')) return { status: 0 };
    if (args[0] === 'pieces' && args[1] === 'remove') rmSync(join(home, 'pieces', args[2], 'piece.json'), { force: true });
    if (args[0] === 'pieces' && args[1] === 'install') {
      if (args[3].endsWith(B)) rec('runtime', { commit: B, loom: { settings: [{ name: 'LOOM_RUNTIME_LOOM_URL' }, { name: 'LOOM_RUNTIME_PUBLIC_URL' }] } });
      else rec('box', { commit: A, source: args[3] });
    }
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  return { run, calls };
}
function oldBox() {
  const home = scratch('loom-home-');
  mkdirSync(join(home, 'pieces', 'box'), { recursive: true });
  writeFileSync(join(home, 'pieces', 'box', 'piece.json'), JSON.stringify({ commit: A }));
  // LOOM_BOX_DATA, LOOM_BOX_PODMAN, LOOM_RUNTIME_LOGIN_IMAGE: settings runtime doesn't declare, which the code reads.
  writeFileSync(join(home, 'pieces', 'box', 'settings.json'), JSON.stringify({ LOOM_BOX_LOOM_URL: 'https://loom.example.ts.net/mcp', LOOM_BOX_PUBLIC_URL: 'https://loom.example',
    LOOM_BOX_DATA: '/srv/box-data', LOOM_BOX_PODMAN: '/usr/local/bin/podman', LOOM_RUNTIME_LOGIN_IMAGE: 'localhost/clis:1' }));
  // The running version's package, which the swap keeps a copy of to roll back to without the network.
  const pkg = join(home, 'pieces', 'box', 'versions', A, 'node_modules', 'loom-box');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'loom-box', bin: { 'loom-box': 'src/cli.mjs' } }));
  writeFileSync(join(pkg, 'src', 'cli.mjs'), '// old\n');
  return { home, pkg };
}
// The box's home is the loom home's dir here: its systemd user units go in <home>/.config/systemd/user.
const swap = (home, pkg, stateDir, run) => applyUpgrade({ commit: B, from: A, piece: 'box', target: 'runtime', env: { LOOM_HOME: home, HOME: home }, stateDir, run, keepDir: pkg, node: 'node', cli: 'cli.mjs' });
const recover = (home, stateDir, run) => recoverUpgrade({ env: { LOOM_HOME: home, HOME: home }, stateDir, run, node: 'node', cli: 'cli.mjs' });
const ARM = ['systemctl --user daemon-reload', 'systemctl --user enable --now loom-box-upgrade-recover.timer'];
const DISARM = ['systemctl --user disable --now loom-box-upgrade-recover.timer', 'systemctl --user daemon-reload'];
const units = (home) => ['timer', 'service'].map((x) => existsSync(join(home, '.config', 'systemd', 'user', `loom-box-upgrade-recover.${x}`)));

test('the rename: kept copy, recovery timer, remove, install, every setting carried, timer stopped', () => {
  const { home, pkg } = oldBox();
  const stateDir = scratch('loom-box-v-');
  const { run, calls } = fakeLoom(home);
  const r = swap(home, pkg, stateDir, run);
  assert.equal(r.state, 'done');
  assert.deepEqual(calls, [
    ...ARM,
    'pieces remove box',
    `pieces install --from github:sleepunit-agents/loom-box#${B} --yes`,
    // The new names of what runtime declares, in loom's settings store.
    'pieces set runtime LOOM_RUNTIME_LOOM_URL=https://loom.example.ts.net/mcp LOOM_RUNTIME_PUBLIC_URL=https://loom.example',
    ...DISARM,
  ]);
  assert.deepEqual(units(home), [false, false], 'the recovery timer\'s files are gone with the swap done');
  // Every one of the old settings, under its own name, where the runtime reads them at start (loadCarried).
  const carried = readFileSync(join(home, 'pieces', 'runtime', 'carried.env'), 'utf-8');
  for (const line of ['LOOM_BOX_DATA=/srv/box-data', 'LOOM_BOX_PODMAN=/usr/local/bin/podman', 'LOOM_RUNTIME_LOGIN_IMAGE=localhost/clis:1', 'LOOM_BOX_LOOM_URL=https://loom.example.ts.net/mcp']) assert.ok(carried.includes(line), line);
  const env = { LOOM_PIECE_HOME: join(home, 'pieces', 'runtime'), LOOM_BOX_PODMAN: '/set/by/loom' };
  assert.equal(loadCarried(env), 4);
  assert.deepEqual([env.LOOM_BOX_DATA, env.LOOM_BOX_PODMAN], ['/srv/box-data', '/set/by/loom'], 'it fills in; what loom sets wins');
  assert.deepEqual([record(stateDir).state, record(stateDir).swapped], ['done', { from: 'box', to: 'runtime', settings: 5, declared: 2 }]);
  assert.equal(existsSync(join(stateDir, 'upgrade-keep', A, 'package.json')), true);
});

test('the rename: an install that fails puts the kept copy back from path: (no network), and says so with no token', () => {
  const { home, pkg } = oldBox();
  const stateDir = scratch('loom-box-v-');
  const { run, calls } = fakeLoom(home, { fails: [`pieces install --from github:sleepunit-agents/loom-box#${B}`] });
  const r = swap(home, pkg, stateDir, run);
  assert.equal(r.state, 'failed');
  assert.deepEqual(calls, [...ARM, 'pieces remove box', `pieces install --from github:sleepunit-agents/loom-box#${B} --yes`,
    `pieces install --from path:${join(stateDir, 'upgrade-keep', A)} --yes`, ...DISARM]);
  assert.match(record(stateDir).error, /installing runtime failed \(exit 1\); the box piece is back as it was/);
  assert.match(record(stateDir).detail, /EEXIST: file already exists, bin loom-box/);
  assert.equal(record(stateDir).detail.includes('npm_SECRET'), false);
});

test('the rename: a unit killed after the remove leaves neither piece; the recovery timer finishes the swap', () => {
  const { home, pkg } = oldBox();
  const stateDir = scratch('loom-box-v-');
  const dying = fakeLoom(home, { dies: ['pieces install'] });
  assert.throws(() => swap(home, pkg, stateDir, dying.run), /killed/);
  // What's on disk: no box, no runtime, and upgrade.json at its last step, with the timer armed.
  assert.deepEqual([existsSync(join(home, 'pieces', 'box', 'piece.json')), existsSync(join(home, 'pieces', 'runtime', 'piece.json'))], [false, false]);
  assert.deepEqual([record(stateDir).state, record(stateDir).recoverUnit], ['installing', 'loom-box-upgrade-recover.timer']);
  assert.equal(lastUpgrade(stateDir, Date.now() + INSTALL_STALE_MS + 1).state, 'installing', 'the timer\'s, not given up');
  // The timer fires.
  const later = fakeLoom(home);
  const r = recover(home, stateDir, later.run);
  assert.equal(r.state, 'done');
  assert.equal(JSON.parse(readFileSync(join(home, 'pieces', 'runtime', 'piece.json'), 'utf-8')).commit, B, 'a running piece');
  assert.equal(later.calls[0], `pieces install --from github:sleepunit-agents/loom-box#${B} --yes`);
  assert.deepEqual(later.calls.slice(-2), DISARM);
  assert.deepEqual(units(home), [false, false]);
  // Fired again (a stray timer): nothing more to do.
  assert.equal(recover(home, stateDir, () => assert.fail('nothing to run')).state, 'done');
});

test('the rename: install and both rollbacks failing re-arm the timer; its next run puts the old piece back from path:', () => {
  const { home, pkg } = oldBox();
  const stateDir = scratch('loom-box-v-');
  const broken = fakeLoom(home, { fails: ['pieces install'] });
  const r = swap(home, pkg, stateDir, broken.run);
  assert.equal(r.state, 'rolling-back');
  assert.match(r.error, /putting the box piece back failed too \(exit 1\): it tries again in 10min\. By hand, on the box: loom pieces install --from path:.*upgrade-keep/);
  assert.deepEqual(units(home), [true, true], 'the timer stays armed: it repeats until the swap is over');
  assert.equal(broken.calls.filter((c) => c.includes('enable')).length, 1);
  assert.equal(existsSync(join(home, 'pieces', 'box', 'piece.json')), false);
  // The network's back (or the disk had room again): the recovery puts the kept copy back.
  const later = fakeLoom(home, { fails: [`pieces install --from github:sleepunit-agents/loom-box#${B}`] });
  const back = recover(home, stateDir, later.run);
  assert.equal(back.state, 'failed');
  assert.match(back.error, /the box piece is back as it was/);
  assert.equal(later.calls[0], `pieces install --from path:${join(stateDir, 'upgrade-keep', A)} --yes`);
  assert.equal(JSON.parse(readFileSync(join(home, 'pieces', 'box', 'piece.json'), 'utf-8')).source, `path:${join(stateDir, 'upgrade-keep', A)}`);
});

test('a swap that can\'t keep a copy or arm its timer changes nothing', () => {
  const { home } = oldBox();
  const { run, calls } = fakeLoom(home);
  assert.match(swap(home, join(home, 'nowhere'), scratch('loom-box-v-'), run).error, /couldn't keep a copy of the box piece .*nothing changed/);
  assert.equal(calls.length, 0);
  const noTimer = fakeLoom(home, { fails: ['--user enable'] });
  const { pkg } = oldBox();
  assert.match(swap(home, pkg, scratch('loom-box-v-'), noTimer.run).error, /couldn't arm the recovery timer/);
  assert.equal(noTimer.calls.some((c) => c.startsWith('pieces remove')), false);
});

test('a plain update is one install; a failed one says so', () => {
  const stateDir = scratch('loom-box-v-');
  const { run, calls } = fakeLoom(scratch('loom-home-'), { fails: ['pieces install'] });
  const r = applyUpgrade({ commit: B, from: A, piece: 'runtime', target: 'runtime', env: {}, stateDir, run });
  assert.deepEqual([r.state, calls.length], ['failed', 1]);
  assert.match(record(stateDir).error, /loom pieces install failed \(exit 1\)/);
});

test('settings: every one kept under its name, the declared ones also under the new; the one line for a box too old to swap itself', () => {
  const c = carriedSettings({ LOOM_BOX_LOOM_URL: 'u', LOOM_BOX_DATA: '/d', LOOM_RUNTIME_ACCOUNTS: 'none', OTHER: 'x' }, ['LOOM_RUNTIME_LOOM_URL', 'LOOM_RUNTIME_ACCOUNTS']);
  assert.deepEqual(c.all, [['LOOM_BOX_LOOM_URL', 'u'], ['LOOM_BOX_DATA', '/d'], ['LOOM_RUNTIME_ACCOUNTS', 'none']]);
  assert.deepEqual(c.set, ['LOOM_RUNTIME_LOOM_URL=u', 'LOOM_RUNTIME_ACCOUNTS=none']);
  assert.equal(swapCommand(B), `loom pieces remove box && loom pieces install --from github:sleepunit-agents/loom-box#${B} --yes && loom runtime carry-settings`);
});

test('a recovery timer that\'s gone (a reboot wiped it) or never fires isn\'t trusted: the runner\'s next poll recovers at once', () => {
  const { home, pkg } = oldBox();
  const stateDir = scratch('loom-box-v-');
  assert.throws(() => swap(home, pkg, stateDir, fakeLoom(home, { dies: ['pieces install'] }).run), /killed/);
  const env = { LOOM_HOME: home, HOME: home };
  const rec = record(stateDir);
  const spawned = [];
  const poll = (spawn, nowMs = Date.now()) => maybeUpgrade({ want: B, mine: A, piece: 'box', stateDir, env, nowMs, spawn, vet: () => assert.fail('no new upgrade over a stuck swap'), node: 'node', cli: 'cli.mjs' });
  const systemd = (active) => (bin, args) => { spawned.push(`${bin} ${args.join(' ')}`); return { status: bin === 'systemctl' ? (active ? 0 : 3) : 0 }; };
  // Its timer is there and active: the swap is the timer's.
  assert.equal(recoveryTrusted(rec, { env, run: systemd(true) }), true);
  assert.equal(poll(systemd(true)), null);
  assert.equal(spawned.filter((c) => c.startsWith('systemd-run')).length, 0);
  // Files there, but systemd doesn't have it (a reboot dropped what it knew; the timer isn't enabled): recover now.
  assert.equal(recoveryTrusted(rec, { env, run: systemd(false) }), false);
  assert.match(poll(systemd(false)), /stopped at installing and its recovery timer isn't there: recovering now/);
  assert.equal(spawned.at(-1), `systemd-run --user --collect --quiet --unit=loom-box-upgrade-recover-now --setenv=LOOM_HOME=${home} --setenv=HOME=${home} node cli.mjs upgrade-apply --recover`);
  // Active, but it hasn't run in three times an install's time: not trusted either.
  assert.equal(recoveryTrusted(rec, { env, run: systemd(true), nowMs: Date.now() + RECOVER_TRUST_MS + 1 }), false);
  assert.match(poll(systemd(true), Date.now() + RECOVER_TRUST_MS + 1), /recovering now/);
  // Unit files gone altogether.
  rmSync(join(home, '.config', 'systemd', 'user'), { recursive: true, force: true });
  assert.equal(recoveryTrusted(rec, { env, run: systemd(true) }), false);
  // What it runs (upgrade-apply --recover) finishes the swap.
  assert.equal(recover(home, stateDir, fakeLoom(home).run).state, 'done');
  assert.equal(poll(systemd(true)), null, 'over: nothing more');
});

test('a reboot mid-swap with neither piece installed: the timer is real unit files (Persistent), and its run after boot recovers', () => {
  const { home, pkg } = oldBox();
  const stateDir = scratch('loom-box-v-');
  assert.throws(() => swap(home, pkg, stateDir, fakeLoom(home, { dies: ['pieces install'] }).run), /killed/);
  // The reboot: every process and transient unit gone, no piece installed, so no runner. What's left is on disk.
  assert.deepEqual([existsSync(join(home, 'pieces', 'box', 'piece.json')), existsSync(join(home, 'pieces', 'runtime', 'piece.json'))], [false, false]);
  const dir = join(home, '.config', 'systemd', 'user');
  const timer = readFileSync(join(dir, 'loom-box-upgrade-recover.timer'), 'utf-8');
  for (const line of ['OnBootSec=2min', 'Persistent=true', 'WantedBy=timers.target']) assert.ok(timer.includes(line), line);
  const service = readFileSync(join(dir, 'loom-box-upgrade-recover.service'), 'utf-8');
  assert.match(service, /^ExecStart="node" "cli.mjs" "upgrade-apply" "--recover"$/m);
  assert.match(service, new RegExp(`^Environment="LOOM_HOME=${home}"$`, 'm'));
  // After boot, systemd starts the enabled timer, and it runs the service's ExecStart.
  const booted = fakeLoom(home);
  assert.equal(recover(home, stateDir, booted.run).state, 'done');
  assert.equal(JSON.parse(readFileSync(join(home, 'pieces', 'runtime', 'piece.json'), 'utf-8')).commit, B);
  assert.deepEqual(units(home), [false, false]);
});

test('one step at a time: a recovery while the upgrade unit holds the lock does nothing', () => {
  const stateDir = scratch('loom-box-v-');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'upgrade.json'), JSON.stringify({ commit: B, from: A, piece: 'box', target: 'runtime', repo: 'sleepunit-agents/loom-box', state: 'installing', at: new Date().toISOString() }));
  // A live process (this test's parent) holds it.
  writeFileSync(join(stateDir, 'upgrade.lock'), String(process.ppid));
  assert.equal(recoverUpgrade({ env: { LOOM_HOME: scratch('h-') }, stateDir, run: () => assert.fail('nothing runs under another\'s lock') }).state, 'installing');
  // A dead holder doesn't hold.
  writeFileSync(join(stateDir, 'upgrade.lock'), '999999999');
  const home = scratch('h-');
  assert.equal(recoverUpgrade({ env: { LOOM_HOME: home, HOME: home }, stateDir, run: fakeLoom(home).run }).state, 'done');
});

// Core/piece skew (t-2086): loom core on a box is a checkout built in place, and nothing updated it. loom#707 raised a
// piece's loom.settings cap from 20 to 32; the runtime declared 21, and boxes on an older core refused it on every try.
const git = (dir, ...a) => { const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
/** A canonical loom repo whose main has an old core (cap 20) then a new one (cap 32), and a box's checkout of the old. */
function coreRepos() {
  const up = scratch('loom-core-up-');
  git(up, 'init', '-q', '-b', 'main');
  const commitCap = (cap) => { writeFileSync(join(up, 'package.json'), JSON.stringify({ name: '@jbarket/loomai', cap })); git(up, 'add', '.'); git(up, 'commit', '-q', '-m', `cap ${cap}`); return git(up, 'rev-parse', 'HEAD'); };
  const old = commitCap(20);
  const box = join(scratch('loom-core-box-'), 'loom');
  spawnSync('git', ['clone', '-q', up, box]);
  mkdirSync(join(box, 'dist'), { recursive: true });
  writeFileSync(join(box, 'dist', 'index.js'), '#!/usr/bin/env node\n');
  const neu = commitCap(32);
  return { up, box, old, neu };
}
/** git for real; npm and loom faked: `loom pieces install` checks a 21-setting runtime against the checkout's own cap. */
function skewedBox(box, { buildFails = false } = {}) {
  const calls = [];
  const run = (bin, args, opts) => {
    if (bin === 'git') return spawnSync(bin, args, opts);
    calls.push(`${bin} ${args.join(' ')}`);
    // buildFails: the new core doesn't build here; the old one still does.
    const capNow = () => JSON.parse(readFileSync(join(box, 'package.json'), 'utf-8')).cap;
    if (bin === 'npm') return buildFails && args[1] === 'build' && capNow() === 32 ? { status: 2, stdout: '', stderr: 'tsc: error' } : { status: 0, stdout: '', stderr: '' };
    if (bin === 'loom' && args[1] === 'install') {
      const cap = JSON.parse(readFileSync(join(box, 'package.json'), 'utf-8')).cap;
      return 21 > cap ? { status: 1, stdout: '', stderr: `loom pieces: loom-runtime: loom.settings is not a list of at most ${cap}` } : { status: 0, stdout: 'ok', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('a box finds its loom core from the bin it runs, through the link to the checkout\'s dist', () => {
  const { box } = coreRepos();
  const bin = scratch('loom-bin-');
  spawnSync('ln', ['-s', join(box, 'dist', 'index.js'), join(bin, 'loom')]);
  assert.equal(coreDir({ PATH: `/nowhere:${bin}` }), box);
  assert.equal(coreDir({ LOOM_CORE_DIR: box }), box);
  assert.equal(coreDir({ PATH: '/nowhere' }), null);
  assert.equal(coreDir({ LOOM_CORE_DIR: bin }), null);
});

test('a box whose loom core is older than the runtime it installs brings core forward and installs it, instead of failing every retry', () => {
  const { up, box, old, neu } = coreRepos();
  const stateDir = scratch('loom-box-v-');
  const { run, calls } = skewedBox(box);
  const env = { LOOM_CORE_DIR: box, LOOM_CORE_URL: up };
  const r = applyUpgrade({ commit: B, from: A, piece: 'runtime', target: 'runtime', env, stateDir, run });
  assert.equal(r.state, 'done', r.error);
  assert.deepEqual(r.core, { from: old, to: neu });
  assert.equal(git(box, 'rev-parse', 'HEAD'), neu);
  assert.deepEqual(calls, [`loom pieces install --from github:sleepunit-agents/loom-box#${B} --yes`, 'npm ci --no-audit --no-fund', 'npm run build', `loom pieces install --from github:sleepunit-agents/loom-box#${B} --yes`]);
  // Without the core update (the box's old upgrade), the same install fails as it did on one and wunder.
  const { box: box2 } = coreRepos();
  const stuck = applyUpgrade({ commit: B, from: A, piece: 'runtime', target: 'runtime', env: { LOOM_CORE_DIR: box2 }, stateDir: scratch('loom-box-v-'), run: skewedBox(box2).run, core: () => ({ error: 'no core update' }) });
  assert.equal(stuck.state, 'failed');
  assert.match(stuck.detail, /loom\.settings is not a list of at most 20/);
});

test('a core build that fails puts the old core back, and the upgrade says why it still failed', () => {
  const { up, box, old } = coreRepos();
  const { run } = skewedBox(box, { buildFails: true });
  const r = applyUpgrade({ commit: B, from: A, piece: 'runtime', target: 'runtime', env: { LOOM_CORE_DIR: box, LOOM_CORE_URL: up }, stateDir: scratch('loom-box-v-'), run });
  assert.equal(r.state, 'failed');
  assert.match(r.core.error, /building loom core at .* failed \(exit 2\); it's back at/);
  assert.equal(git(box, 'rev-parse', 'HEAD'), old);
});

test('core is only ever fast-forwarded on canonical main: a checkout ahead of it or beside it is left alone; one already current isn\'t rebuilt', () => {
  const { up, box } = coreRepos();
  git(box, 'commit', '-q', '--allow-empty', '-m', 'local');
  const mine = git(box, 'rev-parse', 'HEAD');
  const { run, calls } = skewedBox(box);
  assert.match(updateCore({ LOOM_CORE_DIR: box }, { run, url: up }).error, /isn't behind sleepunit-agents\/loom's main; left as it is/);
  assert.equal(git(box, 'rev-parse', 'HEAD'), mine);
  assert.equal(calls.length, 0);
  const { up: up2, box: box2, neu } = coreRepos();
  git(box2, 'fetch', '-q', up2, 'main'); git(box2, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
  assert.deepEqual(updateCore({ LOOM_CORE_DIR: box2 }, { run, url: up2 }), { from: neu, to: neu });
  assert.equal(calls.length, 0);
  assert.match(updateCore({ PATH: '/nowhere' }, { run }).error, /isn't a checkout of loom this box can update/);
});
