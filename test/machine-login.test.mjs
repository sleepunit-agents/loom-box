import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';
import { api } from '../src/control.mjs';
import { load, update } from '../src/state.mjs';
import { page, act, manifest } from '../src/ui.mjs';
import { deriveAccounts } from '../src/accounts.mjs';
import { machineClaudeStatus, startLogin } from '../src/logins.mjs';
import { runner } from '../src/box.mjs';
const DAY = 86400000;
const setup = () => { const HOME = scratch('machine-login-'); return { HOME, LOOM_RUNTIME_MACHINE_CLAUDE_LOGIN: 'on', PATH: process.env.PATH, LOOM_BOX_HOME: join(HOME, 'state'), LOOM_BOX_LOCAL_NAME: 'local', XDG_RUNTIME_DIR: join(HOME, 'run') }; };
const st = (days) => ({ installed: true, loggedIn: true, method: 'claude.ai', loginExpiresAt: new Date(Date.now() + days * DAY).toISOString() });
const fx = { now: () => new Date(), alert: () => {} };
const call = (env, caller, path, body) => api(env, fx, { caller, path, body });
const local = { kind: 'piece', subject: 'local' }, owner = { kind: 'owner' };
test('machine expiry is distinct, its exact owner-only action reaches the runner; renewal clears only its warning', async () => {
  const env = setup();
  const privateStatus = st(2), sharedStatus = st(30);
  assert.equal(call(env, local, 'poll', { harnesses: { claude: sharedStatus }, machineHarnesses: { claude: privateStatus } }).status, 200);
  const row = page(env, { path: 'box/local' }).sections.flatMap((s) => s.blocks).flatMap((b) => b.rows ?? []).find((r) => r.label === 'Claude on this machine');
  assert.equal(row.act.label, 'Renew login');
  assert.deepEqual(row.act.fields, { box: 'local', harness: 'claude', scope: 'machine' });
  assert.match(manifest(env).asks.find((a) => /machine login/.test(a.text)).text, /ends in 2 days/);
  assert.equal(call(env, { kind: 'agent', agent: 'art' }, 'login-start', row.act.fields).status, 403);
  const result = act(env, fx, row.act), id = result.page.slice(6);
  const shared = call(env, owner, 'login-start', { box: 'local', harness: 'claude' });
  assert.notEqual(shared.body.id, id, 'separate scopes cannot deduplicate');
  const seen = [];
  let current = privateStatus;
  const client = { async call(path, body) { const x = call(env, local, path, body); assert.equal(x.status, 200, JSON.stringify(x)); return x.body; } };
  const box = runner(env, client, { loomUrl: 'http://localhost/mcp', machineLogin: true, machineStatus: () => current, status: () => ({ claude: sharedStatus }), sweep: () => [], upgrade: () => null, log: () => {},
    login(h, o) { seen.push(o); return { cancel() {}, code() {} }; },
  });
  await box.tick();
  assert.equal(seen.filter((o) => o.machine).length, 1);
  current = st(31);
  await seen.find((o) => o.machine).say({ state: 'done' });
  assert.equal(load(env).boxes.local.machineHarnesses.claude.loginExpiresAt, current.loginExpiresAt);
  assert.equal(load(env).boxes.local.harnesses.claude.loginExpiresAt, sharedStatus.loginExpiresAt);
  assert.equal(manifest(env).asks.some((a) => /machine login/.test(a.text)), false);
  assert.equal(deriveAccounts(load(env)).accounts.length, 1, 'machine login is not a house account');
});
test('remote boxes cannot report or start machine logins; disabled runner refuses native execution', async () => {
  const env = setup();
  update(env, (s) => { s.boxes.remote = { name: 'remote', token: 'x', local: false, facts: [] }; });
  const r = { kind: 'piece', subject: 'remote' };
  assert.equal(call(env, r, 'poll', { machineHarnesses: { claude: st(2) } }).status, 200);
  assert.equal(load(env).boxes.remote.machineHarnesses, undefined);
  assert.equal(call(env, owner, 'login-start', { box: 'remote', harness: 'claude', scope: 'machine' }).status, 409);
  call(env, local, 'poll', { machineHarnesses: { claude: st(2) } });
  const id = call(env, owner, 'login-start', { box: 'local', harness: 'claude', scope: 'machine' }).body.id;
  const client = { async call(path, body) { const x = call(env, local, path, body); assert.equal(x.status, 200); return x.body; } };
  const box = runner(env, client, { loomUrl: 'http://localhost/mcp', status: () => ({}), sweep: () => [], upgrade: () => null, log: () => {}, login() { assert.fail('native login must not start'); } });
  await box.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(load(env).logins[id].state, 'failed');
  env.LOOM_RUNTIME_MACHINE_CLAUDE_LOGIN = 'off';
  assert.equal(call(env, owner, 'login-start', { box: 'local', harness: 'claude', scope: 'machine' }).status, 409);
});
test('native status uses trusted machine home, strips provider overrides, never mounts or reads shared credentials', () => {
  const env = { ...setup(), CLAUDE_CODE_OAUTH_TOKEN: 'secret', ANTHROPIC_API_KEY: 'secret', CLAUDE_CONFIG_DIR: '/untrusted', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/shared' };
  const result = machineClaudeStatus(env, (cmd, args, opts) => {
    assert.equal(cmd, join(env.HOME, '.local/bin/claude'));
    assert.deepEqual(args, ['auth', 'status', '--json']);
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) assert.equal(opts.env[k], undefined);
    return { status: 0, stdout: JSON.stringify({ ...st(2), refreshToken: 'private' }) };
  });
  assert.equal(result.loggedIn, true);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('native renewal cannot report old login success after cancellation or an unchanged deadline', async () => {
  for (const [exit, afterDays, expected] of [[1, 30, 'failed'], [0, 2, 'failed'], [0, 30, 'done']]) {
    const env = setup(), before = st(2);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.kill = () => {};
    let queried = 0, finish;
    const done = new Promise((r) => { finish = r; });
    const login = startLogin(env, 'claude', { machine: true, status: () => (++queried === 1 || afterDays === 2 ? before : st(afterDays)), say: finish,
      spawnImpl(cmd, args, opts) { assert.equal(cmd, 'script'); assert.equal(args.join(' ').includes('podman'), false); assert.equal(opts.env.BROWSER, '/bin/false'); return child; }, until: 2000, every: 50,
    });
    child.emit('exit', exit);
    const result = await done;
    assert.equal(result.state, expected);
    assert.equal(login.over, true);
  }
});
