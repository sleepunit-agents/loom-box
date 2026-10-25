// The box (loom docs/specs/runtime.md), end to end against the real control
// plane in-process, a real git repo as the agent's, and a stand-in podman
// that records what it was asked (test/fake-podman.mjs):
//  - a house is a container and only a container: the box builds the image
//    from the repo's house file and runs it with exactly the house's own
//    secrets (as podman secrets), env and per-house dirs, and nothing of the
//    box's; no agent code runs on the box;
//  - nested containers only when the owner allows them; a secret the control
//    plane didn't give is refused; a Containerfile can't point outside the repo;
//  - the image is cached by the build context's tree;
//  - when a house ends, its secrets, clone and dirs go, and its token is revoked;
//  - stop ends a running house; a box that restarted cleans up and reports;
//  - join keeps the credential 0600 and refuses one that isn't this box's.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_STATE_BYTES, api } from '../src/control.mjs';
import { PART_RAW, partsOf } from '../src/blobs.mjs';
import { randomBytes } from 'node:crypto';
import { joinLoom, runner } from '../src/box.mjs';
import { HouseFileError, NESTED_ARGS, parseHouseFile } from '../src/house.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let env, fx, revoked, repo, client, r, fake;
const owner = { kind: 'owner' };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const ok = (x) => { assert.equal(x.status, 200, JSON.stringify(x.body)); return x.body; };
const house = (id) => ok(api(env, fx, { caller: owner, path: 'list', body: {} })).houses.find((h) => h.id === id);
const ran = (id) => JSON.parse(readFileSync(join(fake, 'runs', `loom-house-${id}.json`), 'utf-8'));
const podmanCfg = (c) => { mkdirSync(fake, { recursive: true }); writeFileSync(join(fake, 'config.json'), JSON.stringify(c)); };

const HOUSE = {
  build: { containerfile: 'house/Containerfile', context: 'house' },
  command: ['claude', '-p'],
  secrets: { 'loom-token': { file: 'loom-token' }, 'github-token': { file: 'github-token' }, 'claude-oauth': { env: 'CLAUDE_CODE_OAUTH_TOKEN' } },
  env: { ART_REPO: 'https://example.com/art.git' },
  mounts: { state: '/home/art/.local/state', nested: '/var/lib/containers', mirror: '/garage/git/art.git' },
  nested: true,
  hostname: 'art-house',
};

function agentRepo(dir, houseFile = HOUSE, extra = () => {}) {
  mkdirSync(join(dir, 'house'), { recursive: true });
  writeFileSync(join(dir, 'house', 'Containerfile'), 'FROM scratch\n');
  writeFileSync(join(dir, 'house', 'house.json'), typeof houseFile === 'string' ? houseFile : JSON.stringify(houseFile));
  extra(dir);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'house']]) {
    assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  }
}

async function until(f, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = f(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}

function setAgent(body = {}) {
  ok(api(env, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo, nested: true, secrets: { 'github-token': 'gh-art', 'claude-oauth': 'claude-oauth-token' }, ...body } }));
}
const up = (task = 'say hi') => ok(api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'up', body: { task } }));

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'loom-box-run-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  copyFileSync(join(here, 'fake-podman.mjs'), join(bin, 'podman'));
  chmodSync(join(bin, 'podman'), 0o755);
  fake = join(bin, 'podman-state');
  env = { HOME: home, PATH: process.env.PATH, LOOM_BOX_HOME: join(home, 'state'), LOOM_BOX_DATA: join(home, 'data'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_PODMAN: join(bin, 'podman'), SECRET_IN_BOX_ENV: 'never-in-a-house' };
  revoked = [];
  fx = { now: () => new Date(), mint: () => 'loom_house_token_aaaaaaaaaaaaaaaa', revoke: (l) => revoked.push(l), secret: (n) => `secret:${n}` };
  repo = join(home, 'art-repo');
  const caller = { kind: 'piece', subject: 'one' };
  // This test's own state, captured: a house from an earlier test that ends late must not report into this one.
  const myEnv = env, myFx = fx;
  client = { async call(path, body) { const x = api(myEnv, myFx, { caller, path, body }); if (x.status !== 200) throw new Error(x.body.error); return x.body; } };
  r = runner(env, client, { loomUrl: 'http://loom.test/mcp', log: () => {} });
});

test('a house is a container with exactly its own secrets, env and dirs, and nothing of the box\'s', async () => {
  agentRepo(repo);
  setAgent();
  const h = up('say hi');
  await r.tick();
  await until(() => house(h.id).state === 'done');
  const { args, seen, stdin } = ran(h.id);
  assert.equal(stdin, 'say hi');
  assert.deepEqual(seen, {
    'mount:loom-token': 'loom_house_token_aaaaaaaaaaaaaaaa', 'mount:github-token': 'secret:gh-art', 'env:CLAUDE_CODE_OAUTH_TOKEN': 'secret:claude-oauth-token',
  });
  const s = args.join(' ');
  for (const want of ['--rm', '--name loom-house-h-1', '--hostname art-house', '-i', ...NESTED_ARGS,
    '-e ART_REPO=https://example.com/art.git', '-e LOOM_URL=http://loom.test/mcp', '-e HOUSE_ID=h-1', '-e HOUSE_AGENT=art']) assert.ok(s.includes(want), want);
  const vols = args.filter((_, i) => args[i - 1] === '-v');
  assert.deepEqual(vols.map((v) => v.split(':').slice(1).join(':')), ['/home/art/.local/state', '/var/lib/containers', '/garage/git/art.git:ro']);
  for (const v of vols) assert.ok(v.startsWith(env.LOOM_BOX_DATA), `${v} is the box's own per-house or mirror dir`);
  assert.ok(args.at(-3).startsWith('loom-house-art:'));
  assert.deepEqual(args.slice(-2), ['claude', '-p']);
  // Nothing of the box's: no secret values in argv, no box env, no home.
  assert.ok(!s.includes('secret:') && !s.includes('loom_house_token') && !s.includes('never-in-a-house') && !s.includes(`${env.HOME}:`));
  // After: its podman secrets, clone and dirs are gone; its token is revoked.
  assert.deepEqual(readdirSync(join(fake, 'secrets')), []);
  assert.deepEqual(readdirSync(join(env.LOOM_BOX_DATA, 'houses', h.id)), ['log']);
  assert.deepEqual(revoked, ['art · house h-1 on one']);
});

test('nested containers only when the owner allows them', async () => {
  agentRepo(repo);
  setAgent({ nested: false });
  const h = up();
  await r.tick();
  assert.equal(house(h.id).state, 'failed');
  assert.match(house(h.id).log, /hasn't allowed that/);
  assert.equal(existsSync(join(fake, 'runs', `loom-house-${h.id}.json`)), false);
  assert.deepEqual(readdirSync(join(fake, 'secrets')), []);
  // A house that doesn't ask gets none of the capabilities.
  const plain = { ...HOUSE, nested: false };
  const repo2 = join(env.HOME, 'plain');
  agentRepo(repo2, plain);
  setAgent({ repo: repo2, nested: false });
  const h2 = up();
  await r.tick();
  await until(() => house(h2.id).state === 'done');
  assert.ok(!ran(h2.id).args.some((a) => a.startsWith('--cap-add') || a === '/dev/net/tun'));
});

test('a port is published only when the owner allows it for that agent', async () => {
  agentRepo(repo, { ...HOUSE, nested: false, ports: ['7401', '127.0.0.1:4747'] });
  setAgent({ nested: false, ports: ['0.0.0.0:7401'] });
  const h = up();
  await r.tick();
  assert.equal(house(h.id).state, 'failed');
  assert.match(house(h.id).log, /publish port 4747, and the owner hasn't allowed that/);
  assert.equal(existsSync(join(fake, 'runs', `loom-house-${h.id}.json`)), false);
  setAgent({ nested: false, ports: ['0.0.0.0:7401', '4747'] });
  const h2 = up();
  await r.tick();
  await until(() => house(h2.id).state === 'done');
  const a = ran(h2.id).args;
  assert.deepEqual(a.flatMap((x, i) => (a[i - 1] === '-p' ? [x] : [])), ['0.0.0.0:7401:7401', '127.0.0.1:4747:4747']);
  // A bare grant binds loopback: the house can't take it to every interface.
  agentRepo(repo, { ...HOUSE, nested: false, ports: ['0.0.0.0:4747'] });
  const h3 = up();
  await r.tick();
  assert.match(house(h3.id).log, /port 4747 on 0.0.0.0; the owner allowed it on 127.0.0.1/);
});

test('a house file\'s ports are checked', () => {
  for (const bad of [['80'], ['70000'], ['1.2.3:7401'], ['999.0.0.1:7401'], [7401], ['7401', '7401'], 'x']) {
    assert.throws(() => parseHouseFile(JSON.stringify({ ...HOUSE, ports: bad })), HouseFileError, JSON.stringify(bad));
  }
});

test('a house file that wants a secret its agent\'s houses don\'t get is refused', async () => {
  agentRepo(repo);
  setAgent({ secrets: { 'github-token': 'gh-art' } });
  const h = up();
  await r.tick();
  assert.equal(house(h.id).state, 'failed');
  assert.match(house(h.id).log, /wants claude-oauth/);
  assert.deepEqual(revoked, ['art · house h-1 on one']);
});

test('a house file is checked: no host paths, no reserved env, nothing unknown', async () => {
  for (const [bad, why] of [
    [{ ...HOUSE, mounts: { home: '/home/art' } }, /only state, nested and mirror/],
    [{ ...HOUSE, mounts: { state: '/run/secrets' } }, /isn't a usable path/],
    [{ ...HOUSE, env: { LD_PRELOAD: '/x.so' } }, /LD_PRELOAD isn't allowed/],
    [{ ...HOUSE, privileged: true }, /unknown key: privileged/],
    [{ ...HOUSE, build: { containerfile: '../Containerfile', context: 'house' } }, /path inside the repo/],
  ]) {
    const dir = mkdtempSync(join(env.HOME, 'bad-'));
    agentRepo(dir, bad);
    setAgent({ repo: dir });
    const h = up();
    await r.tick();
    assert.equal(house(h.id).state, 'failed');
    assert.match(house(h.id).log, why);
  }
});

test('a Containerfile that\'s a symlink out of the repo is refused', async () => {
  const outside = join(env.HOME, 'Evilfile');
  writeFileSync(outside, 'FROM scratch\n');
  agentRepo(repo, { ...HOUSE, build: { containerfile: 'house/Linked', context: 'house' } }, (d) => symlinkSync(outside, join(d, 'house', 'Linked')));
  setAgent();
  const h = up();
  await r.tick();
  assert.equal(house(h.id).state, 'failed');
  assert.match(house(h.id).log, /points outside the repo/);
});

test('the image is built once per build context, and a failed build fails the house', async () => {
  agentRepo(repo);
  setAgent();
  const a = up('one');
  await r.tick();
  await until(() => house(a.id).state === 'done');
  const b = up('two');
  await r.tick();
  await until(() => house(b.id).state === 'done');
  assert.equal(readFileSync(join(fake, 'builds'), 'utf-8').trim().split('\n').length, 1);
  podmanCfg({ build: 1 });
  writeFileSync(join(repo, 'house', 'Containerfile'), 'FROM scratch\nRUN true\n');
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change'], { cwd: repo });
  const c = up('three');
  await r.tick();
  assert.equal(house(c.id).state, 'failed');
  assert.match(house(c.id).log, /build broke/);
});

test('stop ends a running house through podman', async () => {
  agentRepo(repo);
  setAgent();
  podmanCfg({ run: 'sleep' });
  const h = up('wait');
  await r.tick();
  await until(() => existsSync(join(fake, 'runs', `loom-house-${h.id}.pid`)));
  assert.equal(house(h.id).state, 'running');
  ok(api(env, fx, { caller: owner, path: 'down', body: { id: h.id } }));
  await r.tick();
  await until(() => house(h.id).state === 'stopped');
  assert.ok(existsSync(join(fake, 'runs', `loom-house-${h.id}.stop`)));
  assert.deepEqual(readdirSync(join(fake, 'secrets')), []);
});

test('a box that restarted under a house removes what\'s left of it and says so', async () => {
  agentRepo(repo);
  setAgent();
  podmanCfg({ run: 'sleep' });
  const h = up('x');
  await r.tick();
  await until(() => house(h.id).state === 'running');
  // The box goes away (its watcher with it), and so does the container.
  const pid = r.houses.get(h.id).child.pid;
  r.houses.get(h.id).child.removeAllListeners('exit');
  process.kill(-pid, 'SIGKILL');
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  const fresh = runner(env, client, { loomUrl: 'http://loom.test/mcp', log: () => {} });
  await fresh.tick();
  assert.equal(house(h.id).state, 'failed');
  assert.match(house(h.id).log, /no longer has this house/);
  assert.ok(existsSync(join(fake, 'runs', `loom-house-${h.id}.rm`)));
  assert.deepEqual(readdirSync(join(fake, 'secrets')), []);
});

test('a box that restarts while a house is still running watches it again, not bounces it', async () => {
  agentRepo(repo, { ...HOUSE, services: { discord: { command: ['x'], mounts: { state: '/s' }, secrets: { 'loom-token': { file: 'loom-token' } } } } });
  setAgent();
  podmanCfg({ run: 'sleep' });
  const s = ok(api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'service-up', body: { name: 'discord' } }));
  await r.tick();
  await until(() => house(s.house).state === 'running');
  // Only the box goes away; the container keeps running.
  r.houses.get(s.house).child.removeAllListeners('exit');
  const logs = [];
  const fresh = runner(env, client, { loomUrl: 'http://loom.test/mcp', log: (m) => logs.push(m) });
  await fresh.tick();
  assert.ok(fresh.houses.get(s.house)?.adopted, 'adopted');
  assert.equal(house(s.house).state, 'running');
  assert.equal(existsSync(join(fake, 'runs', `loom-house-${s.house}.stop`)), false, 'not bounced');
  assert.deepEqual(readdirSync(join(fake, 'secrets')), [`loom-${s.house}-loom-token`]);
  // Later it's taken down: it ends like any house, its state saved, its secrets gone.
  ok(api(env, fx, { caller: owner, path: 'service-down', body: { agent: 'art', name: 'discord' } }));
  await fresh.tick();
  await until(() => house(s.house).state === 'stopped');
  assert.equal(ok(api(env, fx, { caller: owner, path: 'saved-state', body: { agent: 'art', name: 'discord' } })).from, s.house);
  assert.deepEqual(readdirSync(join(fake, 'secrets')), []);
});

test('a box that restarts under a service\'s house sends its state back first', async () => {
  agentRepo(repo, { ...HOUSE, services: { discord: { command: ['x'], mounts: { state: '/s' } } } });
  setAgent();
  podmanCfg({ run: 'sleep' });
  const s = ok(api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'service-up', body: { name: 'discord' } }));
  await r.tick();
  await until(() => house(s.house).state === 'running');
  const pid = r.houses.get(s.house).child.pid;
  r.houses.get(s.house).child.removeAllListeners('exit');
  process.kill(-pid, 'SIGKILL');
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  const fresh = runner(env, client, { loomUrl: 'http://loom.test/mcp', log: () => {} });
  await fresh.tick();
  const saved = ok(api(env, fx, { caller: owner, path: 'saved-state', body: { agent: 'art', name: 'discord' } }));
  assert.equal(saved.from, s.house, 'the restarted box sent the house\'s state before removing it');
  assert.ok(existsSync(join(fake, 'runs', `loom-house-${s.house}.stop`)), 'stopped first, so it could finish writing');
  assert.equal(existsSync(join(env.LOOM_BOX_DATA, 'houses', s.house)), false);
});

test('a service moves between boxes by hand-off, and its state goes with it', async () => {
  const withService = { ...HOUSE, services: { discord: {
    command: ['python3', '/home/art/Code/shuttle/adapters/discord.py'],
    secrets: { 'loom-token': { file: 'loom-token' }, 'github-token': { file: 'github-token' } },
    mounts: { state: '/home/art/.local/state/art-discord', mirror: '/garage/git/art.git' },
  } } };
  agentRepo(repo, withService);
  setAgent();
  ok(api(env, fx, { caller: owner, path: 'add-box', body: { name: 'laptop' } }));
  podmanCfg({ run: 'sleep' });
  const lapEnv = { ...env, LOOM_BOX_DATA: join(env.HOME, 'laptop-data') };
  const lapClient = { async call(path, body) { const x = api(env, fx, { caller: { kind: 'piece', subject: 'laptop' }, path, body }); if (x.status !== 200) throw new Error(x.body.error); return x.body; } };
  const lap = runner(lapEnv, lapClient, { loomUrl: 'http://loom.test/mcp', log: () => {} });
  const sweep = () => { for (const x of [r, lap]) for (const e of x.houses.values()) { try { process.kill(-e.child.pid, 'SIGKILL'); } catch { /* gone */ } } };
  try {
  // A bridge moving in with more history than one part holds: seeded in parts.
  const seed = join(env.HOME, 'seed');
  mkdirSync(seed);
  writeFileSync(join(seed, 'cursor'), 'seeded;');
  writeFileSync(join(seed, 'archive.jsonl'), randomBytes(900 * 1024));
  const packed = spawnSync('tar', ['--format=ustar', '-C', seed, '-czf', '-', '.'], { maxBuffer: 1 << 26 }).stdout;
  const parts = partsOf(packed.length);
  assert.ok(parts >= 3);
  for (let part = 0; part < parts; part++) {
    ok(api(env, fx, { caller: owner, path: 'seed-state', body: { agent: 'art', name: 'discord', part, parts, state: packed.subarray(part * PART_RAW, (part + 1) * PART_RAW).toString('base64') } }));
  }
  const up1 = ok(api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'service-up', body: { name: 'discord' } }));
  await r.tick();
  await until(() => existsSync(join(fake, 'runs', `loom-house-${up1.house}.json`)));
  const first = ran(up1.house);
  assert.equal(first.stateBefore, 'seeded;', 'the first house started from the seed, put back together from its parts');
  assert.ok(first.args.includes('HOUSE_SERVICE=discord') && first.args.includes('--stop-timeout'));
  assert.ok(!first.args.includes('-i'), 'a service has no task on stdin');
  ok(api(env, fx, { caller: owner, path: 'service-move', body: { agent: 'art', name: 'discord', box: 'laptop' } }));
  await lap.tick();
  assert.equal(lap.houses.size, 0, 'the laptop waits for the hand-off');
  await r.tick(); // the old box stops it, saves its state, reports
  const list = () => ok(api(env, fx, { caller: owner, path: 'list', body: {} }));
  await until(() => list().services[0].box === 'laptop');
  await lap.tick();
  const second = list().services[0].house;
  await until(() => existsSync(join(fake, 'runs', `loom-house-${second}.json`)));
  assert.equal(ran(second).stateBefore, `seeded;loom-house-${up1.house};`, 'the laptop picked up where the first box left off');
  const saved = ok(api(env, fx, { caller: owner, path: 'saved-state', body: { agent: 'art', name: 'discord' } }));
  assert.ok(saved.parts >= 3 && saved.from === up1.house, 'the old box sent all of it back, in parts');
  assert.equal(house(up1.house).state, 'stopped');
  } finally { sweep(); }
});

test('a saved state that would unpack too big is refused before it touches the disk', async () => {
  agentRepo(repo, { ...HOUSE, services: { discord: { command: ['x'], mounts: { state: '/s' } } } });
  setAgent();
  const big = join(env.HOME, 'big');
  mkdirSync(big);
  spawnSync('sh', ['-c', `head -c 70000000 /dev/zero > ${big}/zeros`]);
  const packed = spawnSync('tar', ['-C', big, '-czf', '-', '.'], { maxBuffer: 1 << 26 }).stdout.toString('base64');
  assert.ok(packed.length < MAX_STATE_BYTES, 'small packed: one part');
  ok(api(env, fx, { caller: owner, path: 'seed-state', body: { agent: 'art', name: 'discord', state: packed } }));
  const s = ok(api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'service-up', body: { name: 'discord' } }));
  await r.tick();
  assert.equal(house(s.house).state, 'failed');
  assert.match(house(s.house).log, /too big to unpack/);
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

test('a session house is told it is one, and the box keeps what attaching runs', async () => {
  agentRepo(repo, { ...HOUSE, attach: ['/home/art/Art/house/attach'] });
  setAgent();
  podmanCfg({ run: 'sleep' });
  const h = ok(api(env, fx, { caller: owner, path: 'up', body: { agent: 'art', session: true } }));
  await r.tick();
  await until(() => existsSync(join(fake, 'runs', `loom-house-${h.id}.json`)));
  try {
  assert.ok(ran(h.id).args.includes('HOUSE_SESSION=1'));
  const a = JSON.parse(readFileSync(join(env.LOOM_BOX_DATA, 'houses', h.id, 'attach.json'), 'utf-8'));
  assert.deepEqual(a, { container: `loom-house-${h.id}`, command: ['/home/art/Art/house/attach'] });
  } finally { process.kill(-r.houses.get(h.id).child.pid, 'SIGKILL'); }
});

test('a task house with a slot starts from it and leaves its own behind', async () => {
  agentRepo(repo);
  setAgent();
  const seed = join(env.HOME, 'slot-seed');
  mkdirSync(seed);
  writeFileSync(join(seed, 'cursor'), 'seeded;');
  const packed = spawnSync('tar', ['--format=ustar', '-C', seed, '-czf', '-', '.']).stdout.toString('base64');
  ok(api(env, fx, { caller: owner, path: 'seed-state', body: { agent: 'art', name: 'tending', slot: true, state: packed } }));
  const h = ok(api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'up', body: { task: 'tend', slot: 'tending' } }));
  await r.tick();
  await until(() => house(h.id).state === 'done');
  assert.equal(ran(h.id).stateBefore, 'seeded;');
  const saved = ok(api(env, fx, { caller: owner, path: 'saved-state', body: { agent: 'art', name: 'tending', slot: true } }));
  assert.equal(saved.from, h.id, 'the house that ran left its state for the next');
});
