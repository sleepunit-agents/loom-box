// The box (loom docs/specs/runtime.md, "Boxes"), end to end against the real
// control plane in-process, with a real git repo as the agent's and a real
// house command:
//  - a house gets its task, its loom token and its secrets as 0600 files, and
//    runs in a fresh clone of the agent's repo;
//  - when it ends, the secrets and the clone are gone, the control plane
//    hears how it went, and the house's token is revoked;
//  - a stop request ends a running house (its whole process group);
//  - a box that restarted under its houses says they're gone;
//  - join keeps the credential 0600 and refuses one that isn't this box's.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from '../src/control.mjs';
import { joinLoom, runner } from '../src/box.mjs';

let env, fx, revoked, repo, client, r;
const owner = { kind: 'owner' };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const ok = (x) => { assert.equal(x.status, 200, JSON.stringify(x.body)); return x.body; };

function agentRepo(dir, houseUp) {
  mkdirSync(join(dir, 'house'), { recursive: true });
  writeFileSync(join(dir, 'house', 'up'), houseUp);
  chmodSync(join(dir, 'house', 'up'), 0o755);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'house']]) {
    assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  }
}

async function until(f, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = f(); if (v) return v; await sleep(50); }
  throw new Error('timed out');
}

const house = (id) => ok(api(env, fx, { caller: owner, path: 'list', body: {} })).houses.find((h) => h.id === id);

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'loom-box-run-'));
  env = { HOME: home, PATH: process.env.PATH, LOOM_BOX_HOME: join(home, 'state'), LOOM_BOX_DATA: join(home, 'data'), LOOM_BOX_LOCAL_NAME: 'one' };
  revoked = [];
  fx = { now: () => new Date(), mint: () => 'loom_house_token_aaaaaaaaaaaaaaaa', revoke: (l) => revoked.push(l), secret: (n) => `secret:${n}` };
  repo = join(home, 'art-repo');
  const caller = { kind: 'piece', subject: 'one' };
  client = { async call(path, body) { const x = api(env, fx, { caller, path, body }); if (x.status !== 200) throw new Error(x.body.error); return x.body; } };
  r = runner(env, client, { loomUrl: 'http://loom.test/mcp', log: () => {} });
});

test('a house runs its task in a fresh clone with its secrets, and leaves nothing behind', async () => {
  const out = join(env.HOME, 'out.json');
  agentRepo(repo, `#!/bin/sh
cat > ${out} <<EOF
{"task": "$HOUSE_TASK", "agent": "$HOUSE_AGENT", "url": "$LOOM_URL", "token": "$(cat "$HOUSE_SECRETS_DIR/loom-token")",
 "gh": "$(cat "$HOUSE_SECRETS_DIR/github-token")", "mode": "$(stat -c %a "$HOUSE_SECRETS_DIR/github-token")", "pwd": "$(pwd)", "dir": "$HOUSE_SECRETS_DIR"}
EOF
`);
  ok(api(env, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo, secrets: { 'github-token': 'gh-art' } } }));
  const h = ok(api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'up', body: { task: 'say hi' } }));
  await r.tick();
  await until(() => house(h.id).state === 'done');
  const got = JSON.parse(readFileSync(out, 'utf-8'));
  assert.deepEqual([got.task, got.agent, got.url, got.token, got.gh, got.mode], ['say hi', 'art', 'http://loom.test/mcp', 'loom_house_token_aaaaaaaaaaaaaaaa', 'secret:gh-art', '600']);
  assert.match(got.pwd, /houses\/h-1\/repo$/);
  assert.equal(existsSync(got.dir), false, 'the secrets are gone');
  assert.equal(existsSync(got.pwd), false, 'the clone is gone');
  assert.deepEqual(revoked, ['art · house h-1 on one']);
  assert.equal(house(h.id).exit, 0);
});

test('a house that fails says so, with the tail of its log', async () => {
  agentRepo(repo, '#!/bin/sh\necho "no gpu here" >&2\nexit 3\n');
  ok(api(env, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo } }));
  const h = ok(api(env, fx, { caller: owner, path: 'up', body: { agent: 'art', task: 'x' } }));
  await r.tick();
  const done = await until(() => (house(h.id).state === 'failed' ? house(h.id) : null));
  assert.equal(done.exit, 3);
  assert.match(done.log, /no gpu here/);
});

test('a repo without the house command fails the house without running anything', async () => {
  agentRepo(repo, '#!/bin/sh\nexit 0\n');
  ok(api(env, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo, houseCmd: 'house/missing' } }));
  const h = ok(api(env, fx, { caller: owner, path: 'up', body: { agent: 'art', task: 'x' } }));
  await r.tick();
  assert.equal(house(h.id).state, 'failed');
  assert.match(house(h.id).log, /no house\/missing/);
  assert.deepEqual(revoked, ['art · house h-1 on one']);
});

test('stop ends a running house and everything it started', async () => {
  const pidfile = join(env.HOME, 'child.pid');
  agentRepo(repo, `#!/bin/sh\nsleep 300 &\necho $! > ${pidfile}\nwait\n`);
  ok(api(env, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo } }));
  const h = ok(api(env, fx, { caller: owner, path: 'up', body: { agent: 'art', task: 'wait' } }));
  await r.tick();
  await until(() => existsSync(pidfile) && readFileSync(pidfile, 'utf-8').trim());
  const child = Number(readFileSync(pidfile, 'utf-8'));
  assert.equal(house(h.id).state, 'running');
  ok(api(env, fx, { caller: owner, path: 'down', body: { id: h.id } }));
  await r.tick();
  await until(() => house(h.id).state === 'stopped');
  await until(() => { try { process.kill(child, 0); return false; } catch { return true; } });
});

test('a box that restarted under its houses reports them gone', async () => {
  agentRepo(repo, '#!/bin/sh\nsleep 300\n');
  ok(api(env, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo } }));
  const h = ok(api(env, fx, { caller: owner, path: 'up', body: { agent: 'art', task: 'x' } }));
  await r.tick();
  await until(() => house(h.id).state === 'running');
  const pid = r.houses.get(h.id).child.pid;
  // A new runner: the box's process restarted and knows nothing.
  const fresh = runner(env, client, { loomUrl: 'http://loom.test/mcp', log: () => {} });
  await fresh.tick();
  assert.equal(house(h.id).state, 'failed');
  assert.match(house(h.id).log, /no longer has this house/);
  process.kill(-pid, 'SIGKILL');
});

test('join keeps the credential 0600 and refuses one that names another box', async () => {
  const fakeFetch = (name) => async (url, init) => {
    assert.equal(url, 'https://loom.test/api/box/hello');
    assert.equal(init.headers.authorization, 'Bearer loom_cred_bbbbbbbbbbbbbbbbbbbb');
    assert.ok(Array.isArray(JSON.parse(init.body).facts));
    return new Response(JSON.stringify({ box: name, mayHost: '*' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(joinLoom(env, { url: 'https://loom.test', name: 'thor', credential: 'loom_cred_bbbbbbbbbbbbbbbbbbbb' }, fakeFetch('rig')), /rig's, not thor's/);
  assert.equal(existsSync(join(env.LOOM_BOX_HOME, 'credential')), false);
  await joinLoom(env, { url: 'https://loom.test', name: 'thor', credential: 'loom_cred_bbbbbbbbbbbbbbbbbbbb' }, fakeFetch('thor'));
  assert.equal(statSync(join(env.LOOM_BOX_HOME, 'credential')).mode & 0o777, 0o600);
  await assert.rejects(joinLoom(env, { url: 'https://loom.test', name: 'thor', credential: 'hunter2' }, fakeFetch('thor')), /isn't a loom credential/);
});
