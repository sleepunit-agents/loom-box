// The piece rename (loom docs/specs/agent-runtime.md, section 1): loom-box becomes the runtime. Its piece name is
// `runtime` (bin loom-runtime), with `loom-box` kept as a second bin through the move; its loom block's role is
// `runtime`; it keeps owners.md's "owners": 2 opt-in; and everything a box already holds keeps working: a box that
// joined under `box` keeps calling /api/box/ with its piece:box/<id> credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pieceName, setting } from '../src/piece.mjs';
import { joinLoom, remoteClient } from '../src/box.mjs';
import { api } from '../src/control.mjs';
import { manifest } from '../src/ui.mjs';
import { scratch } from './scratch.mjs';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const dist = process.env.LOOM_DIST || join(homedir(), 'Code', 'loom', 'dist');
const managed = existsSync(join(dist, 'cli', 'pieces-managed.js')) ? await import(join(dist, 'cli', 'pieces-managed.js')) : null;

test('the package is the runtime piece: loom-runtime, with loom-box as a second bin, role runtime', () => {
  assert.equal(pkg.name, 'loom-runtime');
  assert.deepEqual(pkg.bin, { 'loom-runtime': 'src/cli.mjs', 'loom-box': 'src/cli.mjs' });
  // Two loom-<name> bins: loom.name says which one is the piece (loom's pieces-managed.ts).
  assert.equal(pkg.loom.name, 'runtime');
  assert.equal(pkg.loom.role, 'runtime');
  assert.deepEqual(pkg.loom.services.map((s) => s.argv[0]), ['loom-runtime']);
  assert.deepEqual(pkg.loom.strangers, ['join-request', 'join-poll']);
  // loom lets a piece declare settings only under its own prefix: the runtime's are LOOM_RUNTIME_*.
  for (const s of pkg.loom.settings) assert.match(s.name, /^LOOM_RUNTIME_/);
});

test('loom\'s own install check takes the loom block as piece runtime, and would refuse the old LOOM_BOX_* settings', { skip: !managed && 'no built loom' }, () => {
  const bins = Object.keys(pkg.bin);
  const parsed = managed.parseLoomBlock(pkg.loom, 'runtime', bins);
  assert.equal(typeof parsed, 'object', String(parsed));
  assert.equal(parsed.role, 'runtime');
  assert.match(managed.parseLoomBlock({ ...pkg.loom, settings: [{ name: 'LOOM_BOX_PUBLIC_URL', label: 'x' }] }, 'runtime', bins), /apart from LOOM_RUNTIME_\*/);
});

test('it keeps owners.md\'s "owners": 2 opt-in', () => {
  const env = { HOME: scratch('rt-rename-'), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  assert.equal(manifest(env).owners, 2);
});

test('its name on the wire: box until loom installs it as runtime; settings by the new name or the old', () => {
  assert.equal(pieceName({}), 'box');
  assert.equal(pieceName({ LOOM_PIECE_NAME: 'box' }), 'box');
  assert.equal(pieceName({ LOOM_PIECE_NAME: 'runtime' }), 'runtime');
  assert.equal(pieceName({ LOOM_PIECE_NAME: 'runtime', LOOM_RUNTIME_PIECE: 'box' }), 'box');
  assert.equal(pieceName({ LOOM_PIECE_NAME: '../x' }), 'box');
  assert.equal(setting({ LOOM_BOX_PUBLIC_URL: 'https://old' }, 'PUBLIC_URL'), 'https://old');
  assert.equal(setting({ LOOM_BOX_PUBLIC_URL: 'https://old', LOOM_RUNTIME_PUBLIC_URL: 'https://new' }, 'PUBLIC_URL'), 'https://new');
});

test('a new box\'s credential is minted for the piece loom runs it as: piece:box/<id> under box, piece:runtime/<id> under runtime', () => {
  for (const name of ['box', 'runtime']) {
    const env = { HOME: scratch('rt-mint-'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_PIECE_NAME: name };
    env.LOOM_BOX_HOME = join(env.HOME, 'state');
    const minted = [];
    const fx = { now: () => new Date(), mint: (role, label) => { minted.push(role); return `loom_${'t'.repeat(30)}`; }, revoke: () => {}, secret: () => '' };
    const r = api(env, fx, { caller: { kind: 'owner' }, path: 'add-box', body: { name: 'thor' } });
    assert.equal(r.status, 200);
    assert.deepEqual(minted[0], ['--piece', `${name}/${r.body.box}`]);
  }
});

test('a box remembers the name it joined under; one from before (no `piece` in box.json) keeps calling /api/box/', async () => {
  const asked = [];
  const fakeFetch = async (url) => { asked.push(url); return new Response(JSON.stringify({ box: 'thor', name: 'thor' }), { status: 200 }); };
  const env = { HOME: scratch('rt-join-'), LOOM_PIECE_NAME: 'runtime' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  await joinLoom(env, { url: 'https://loom.test', name: 'thor', credential: `loom_${'c'.repeat(30)}` }, fakeFetch);
  assert.deepEqual(asked, ['https://loom.test/api/runtime/hello']);
  assert.equal(JSON.parse(readFileSync(join(env.LOOM_BOX_HOME, 'box.json'), 'utf-8')).piece, 'runtime');
  await remoteClient('https://loom.test', 'loom_x', fakeFetch).call('poll', {});
  await remoteClient('https://loom.test', 'loom_x', fakeFetch, 'runtime').call('poll', {});
  assert.deepEqual(asked.slice(1), ['https://loom.test/api/box/poll', 'https://loom.test/api/runtime/poll']);
});

test('both bins are the same program, and each names itself in what it says', () => {
  const dir = scratch('rt-bins-');
  for (const bin of ['loom-runtime', 'loom-box']) {
    symlinkSync(join(root, 'src', 'cli.mjs'), join(dir, bin));
    const help = spawnSync(process.execPath, [join(dir, bin), 'help'], { encoding: 'utf-8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /loom runtime body start --agent a --venue v/);
    const bad = spawnSync(process.execPath, [join(dir, bin), 'body', 'feed', 'nope', '--text', 'x'], { encoding: 'utf-8', env: { ...process.env, HOME: dir } });
    assert.match(bad.stderr, new RegExp(`^loom ${bin === 'loom-box' ? 'box' : 'runtime'}: a body is <harness>:<id>`));
  }
});
