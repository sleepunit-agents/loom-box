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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_STATE_BYTES, api } from '../src/control.mjs';
import { PART_RAW, partsOf } from '../src/blobs.mjs';
import { randomBytes } from 'node:crypto';
import { houseBadge } from '../src/ui.mjs';
import { pruneImages } from '../src/box.mjs';
import { joinLoom, runner } from '../src/box.mjs';
import { HouseFileError, NESTED_ARGS, parseHouseFile } from '../src/house.mjs';
import { scratch } from './scratch.mjs';
import { load } from '../src/state.mjs';

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
  secrets: { 'loom-token': { file: 'loom-token' }, 'github-token': { file: 'github-token' }, 'anthropic-api-key': { env: 'ANTHROPIC_API_KEY' } },
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
  ok(api(env, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo, nested: true, secrets: { 'github-token': 'gh-art', 'anthropic-api-key': 'art-anthropic-key' }, ...body } }));
}
const up = (task = 'say hi') => ok(api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'up', body: { task } }));

beforeEach(() => {
  const home = scratch('loom-box-run-');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  copyFileSync(join(here, 'fake-podman.mjs'), join(bin, 'podman'));
  chmodSync(join(bin, 'podman'), 0o755);
  fake = join(bin, 'podman-state');
  env = { HOME: home, PATH: process.env.PATH, LOOM_BOX_HOME: join(home, 'state'), LOOM_BOX_DATA: join(home, 'data'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_PODMAN: join(bin, 'podman'), SECRET_IN_BOX_ENV: 'never-in-a-house',
    // No real harness CLI answers for this box's logins (a test of its own says what it reports).
    LOOM_RUNTIME_CLAUDE: '/nonexistent/claude', LOOM_RUNTIME_CODEX: '/nonexistent/codex' };
  env.XDG_RUNTIME_DIR = join(home, 'run');
  revoked = [];
  fx = { now: () => new Date(), mint: () => 'loom_house_token_aaaaaaaaaaaaaaaa', revoke: (l) => revoked.push(l), secret: (n) => `secret:${n}` };
  repo = join(home, 'art-repo');
  const caller = { kind: 'piece', subject: 'one' };
  // This test's own state, captured: a house from an earlier test that ends late must not report into this one.
  const myEnv = env, myFx = fx;
  client = { async call(path, body) { const x = api(myEnv, myFx, { caller, path, body }); if (x.status !== 200) throw new Error(x.body.error); return x.body; } };
  // A tailnet socket "exists" on this test box unless its path says it's missing.
  r = runner(env, client, { loomUrl: 'http://loom.test/mcp', log: () => {}, hasSocket: (p) => !p.includes('missing') });
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
    'mount:loom-token': 'loom_house_token_aaaaaaaaaaaaaaaa', 'mount:github-token': 'secret:gh-art', 'env:ANTHROPIC_API_KEY': 'secret:art-anthropic-key',
  });
  const s = args.join(' ');
  for (const want of ['--rm', '--init', '--name loom-house-h-1', '--hostname art-house', '-i', ...NESTED_ARGS,
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

test('a tailnet socket goes in only when the owner grants it for that agent, from the socket the grant names', async () => {
  agentRepo(repo, { ...HOUSE, nested: false, tailnets: { fleet: '/run/tailscale-fleet.sock' } });
  setAgent({ nested: false });
  const h = up();
  await r.tick();
  assert.equal(house(h.id).state, 'failed');
  assert.match(house(h.id).log, /asks for the fleet tailnet, and the owner hasn't allowed that/);
  setAgent({ nested: false, tailnets: ['fleet=/run/tailscale-fleet/tailscaled.sock'] });
  const h2 = up();
  await r.tick();
  await until(() => house(h2.id).state === 'done');
  const a = ran(h2.id).args;
  assert.ok(a.flatMap((x, i) => (a[i - 1] === '-v' ? [x] : [])).includes('/run/tailscale-fleet/tailscaled.sock:/run/tailscale-fleet.sock'));
  // A box without that socket (it's another box's tailnet) starts the house without it, and says so in its log.
  setAgent({ nested: false, tailnets: ['fleet=/run/tailscale-missing/tailscaled.sock'] });
  const h3 = up();
  await r.tick();
  await until(() => house(h3.id).state === 'done');
  const a3 = ran(h3.id).args;
  assert.ok(!a3.some((x) => x.includes('tailscale-missing')));
  assert.match(house(h3.id).log, /this box has no fleet tailnet \(\/run\/tailscale-missing\/tailscaled.sock\); the house starts without it/);
  // A grant is a name and a socket path; anything else is refused when it's set.
  for (const bad of ['fleet', 'fleet=relative.sock', 'fleet=/etc/passwd', 'Fleet=/run/tailscale/tailscaled.sock', 'fleet=/run/user/1000/podman/podman.sock',
    'fleet=/run/tailscale-fleet/../user/1000/podman/podman.sock/tailscaled.sock', 'fleet=/run/./tailscale/tailscaled.sock']) {
    assert.throws(() => setAgent({ tailnets: [bad] }), /a tailnet grant is a name and a tailscaled socket/);
  }
});

test('a house asked for with a GPU need gets the GPU through CDI; a box without the CDI spec says how to make it', async () => {
  agentRepo(repo, { ...HOUSE, nested: false });
  setAgent({ nested: false });
  let cdi = true;
  // This box has a GPU (its facts say so) and, until it's made, no CDI spec.
  const g = runner(env, client, { loomUrl: 'http://loom.test/mcp', log: () => {}, labels: ['gpu:nvidia-test'], hasCdi: () => cdi });
  await g.tick();
  const want = (needs) => ok(api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'up', body: { task: 'x', needs } }));
  // The GPU is the owner's grant, per agent: not given, the house fails and says so.
  const h0 = want(['gpu']);
  await g.tick();
  await until(() => house(h0.id).state === 'failed');
  assert.match(house(h0.id).log, /the owner hasn't allowed art's houses a GPU/);
  setAgent({ nested: false, gpu: true });
  cdi = false;
  const h1 = want(['gpu']);
  await g.tick();
  await until(() => house(h1.id).state === 'failed');
  assert.match(house(h1.id).log, /no NVIDIA CDI spec: run `sudo nvidia-ctk cdi generate --output=\/etc\/cdi\/nvidia.yaml`/);
  cdi = true;
  const h2 = want(['gpu:nvidia']);
  await g.tick();
  await until(() => house(h2.id).state === 'done');
  const a2 = ran(h2.id).args;
  assert.equal(a2[a2.indexOf('--device') + 1], 'nvidia.com/gpu=all');
  const h3 = want([]);
  await g.tick();
  await until(() => house(h3.id).state === 'done');
  assert.ok(!ran(h3.id).args.includes('--device'), 'only when it asked for the GPU');
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
  assert.match(house(h.id).log, /wants anthropic-api-key/);
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
  // The runner says running once podman is started; the (fake) container is up a moment later (t-1521: the
  // fresh runner sometimes looked in between, found none, and the test flaked).
  await until(() => existsSync(join(fake, 'runs', `loom-house-${s.house}.pid`)));
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
  const probes=readdirSync(join(fake,'log')).map(n=>JSON.parse(readFileSync(join(fake,'log',n),'utf8')));
  assert.ok(probes.some(a=>a[0]==='container'&&a[1]==='exists'&&a[2]===`loom-house-${s.house}`),'physical absence was checked before state collection');
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
  const laptop = ok(api(env, fx, { caller: owner, path: 'add-box', body: { name: 'laptop' } })).box;
  podmanCfg({ run: 'sleep' });
  const lapEnv = { ...env, LOOM_BOX_DATA: join(env.HOME, 'laptop-data') };
  const lapClient = { async call(path, body) { const x = api(env, fx, { caller: { kind: 'piece', subject: laptop }, path, body }); if (x.status !== 200) throw new Error(x.body.error); return x.body; } };
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
  await until(() => list().services[0].box === laptop);
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

test('a box reports its harness logins on its poll, runs the owner\'s login, and a house that wants a login gets the box\'s own', async () => {
  let loggedIn = false;
  const said = [];
  const box = runner(env, client, { loomUrl: 'http://loom.test/mcp', log: () => {},
    status: () => ({ claude: { installed: true, loggedIn, method: 'claude.ai', plan: 'max', account: 'claude-0123456789' }, codex: { installed: false, loggedIn: false } }),
    login: (h, { say }) => { said.push(h); setTimeout(() => say({ state: 'waiting', link: 'https://claude.com/cai/oauth/authorize?x=1' }), 0); return { code(c) { said.push(`code ${c}`); loggedIn = true; say({ state: 'done' }); return true; }, cancel() {} }; } });
  // A house that wants Claude's login, on a box that isn't logged in: refused, saying how to fix it.
  agentRepo(repo, { ...HOUSE, harnesses: ['claude'] });
  setAgent();
  const h = up();
  await box.tick();
  await until(() => house(h.id).state === 'failed');
  assert.match(house(h.id).log, /this box has no Claude login for art's houses: log it in from its page/);
  assert.equal(ok(api(env, fx, { caller: owner, path: 'list', body: {} })).boxes.find((b) => b.id === 'one').harnesses.claude.loggedIn, false);
  // The owner logs it in: the box runs the login, its link comes back, the code goes in.
  const l = ok(api(env, fx, { caller: owner, path: 'login-start', body: { box: 'one', harness: 'claude' } }));
  await box.tick();
  await until(() => load(env).logins[l.id].state === 'waiting');
  ok(api(env, fx, { caller: owner, path: 'login-code', body: { id: l.id, code: 'good-code#s1' } }));
  await box.tick();
  await until(() => load(env).logins[l.id].state === 'done');
  assert.deepEqual(said, ['claude', 'code good-code#s1']);
  assert.equal(load(env).boxes.one.harnesses.claude.loggedIn, true);
  // Now the house starts with the box's login dir mounted, and its CLI pointed there.
  const h2 = up();
  await box.tick();
  await until(() => house(h2.id).state === 'done');
  const s = ran(h2.id).args.join(' ');
  assert.match(s, new RegExp(`-v ${env.LOOM_BOX_DATA}/logins/claude:/run/loom/login/claude:rw,nosuid,nodev,noexec -e CLAUDE_SECURESTORAGE_CONFIG_DIR=/run/loom/login/claude`));
  // A house planted things in the login dir: before the next house gets it, it's cut down to the credential file.
  const { symlinkSync, existsSync: ex } = await import('node:fs');
  const shared = join(env.LOOM_BOX_DATA, 'logins', 'claude');
  symlinkSync('/etc/passwd', join(shared, 'planted'));
  writeFileSync(join(shared, 'settings.json'), '{"hooks":{}}');
  writeFileSync(join(shared, '.credentials.json'), '{}');
  const h3 = up();
  await box.tick();
  await until(() => house(h3.id).state === 'done');
  assert.deepEqual([ex(join(shared, 'planted')), ex(join(shared, 'settings.json')), ex(join(shared, '.credentials.json'))], [false, false, true]);
  assert.equal(ex('/etc/passwd'), true, 'the link went, not what it pointed at');
  // A credential file that's a symlink is refused: the house doesn't start on it.
  rmSync(join(shared, '.credentials.json'));
  symlinkSync('/etc/passwd', join(shared, '.credentials.json'));
  const h4 = up();
  await box.tick();
  await until(() => house(h4.id).state === 'failed');
  assert.match(house(h4.id).log, /login dir isn't safe to mount: \.credentials\.json is a symlink/);
});

test('a sentinel token in the box\'s credential files never shows in any argv, env, log line, call body, state.json or house file loom makes', async () => {
  const SENTINEL = 'sk-ant-oat01-SENTINEL-must-never-leave-the-file-0000';
  const { spawn: realSpawn, spawnSync: realSpawnSync } = await import('node:child_process');
  const { harnessStatus, startLogin, loginDir } = await import('../src/logins.mjs');
  const fakeCli = join(here, 'fake-login.mjs');
  // Two fake CLIs (claude, codex) that log in and read their own credential files, as the real ones do.
  const bin = join(env.HOME, 'clis');
  mkdirSync(bin);
  for (const h of ['claude', 'codex']) { writeFileSync(join(bin, h), `#!/bin/sh\nFAKE_LOGIN_AS=${h} exec "${process.execPath}" "${fakeCli}" "$@"\n`); chmodSync(join(bin, h), 0o755); }
  // The fake podman runs them as the throwaway CLI container's (its cliBin), in the image of an agent the control plane names.
  const cfgFile = join(fake, 'config.json');
  mkdirSync(fake, { recursive: true });
  writeFileSync(cfgFile, JSON.stringify({ ...(existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf-8')) : {}), cliBin: bin }));
  const benv = { ...env, FAKE_LOGIN_DEVICE_MS: '200' };
  writeFileSync(join(loginDir(benv, 'claude'), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: SENTINEL } }), { mode: 0o600 });
  writeFileSync(join(loginDir(benv, 'codex'), 'auth.json'), JSON.stringify({ tokens: { access_token: SENTINEL } }), { mode: 0o600 });
  // Everything loom hands anything: each spawn's argv and env, each log line, each call to the control plane.
  const seen = [];
  const note = (what, v) => seen.push(`${what} ${JSON.stringify(v)}`);
  const run = (cmd, args, o = {}) => { note('spawnSync', [cmd, args, o.env, o.input]); return realSpawnSync(cmd, args, o); };
  const spawnImpl = (cmd, args, o = {}) => { note('spawn', [cmd, args, o.env]); const c = realSpawn(cmd, args, o); const w = c.stdin.write.bind(c.stdin); c.stdin.write = (d, ...r) => { note('stdin', String(d)); return w(d, ...r); }; return c; };
  const spied = { async call(path, body) { note(`call ${path}`, body); const out = await client.call(path, body); note(`answer ${path}`, out); return out; } };
  const box = runner(benv, spied, { loomUrl: 'http://loom.test/mcp', log: (m) => note('log', m),
    status: (agents) => harnessStatus(benv, { run, agents }), login: (h, o) => startLogin(benv, h, { ...o, spawnImpl, run, every: 100 }) });
  // A status, a Codex login (device: it finishes by itself), and a house on the Claude login. art's image is the one
  // the box runs its CLI in (art may use this box's logins).
  agentRepo(repo, { ...HOUSE, harnesses: ['claude', 'codex'] });
  setAgent();
  await box.tick();
  assert.equal(load(env).boxes.one.harnesses.claude.loggedIn, true);
  const l = ok(api(env, fx, { caller: owner, path: 'login-start', body: { box: 'one', harness: 'codex' } }));
  await box.tick();
  await until(() => load(env).logins[l.id].state === 'done');
  const h = up();
  await box.tick();
  await until(() => house(h.id).state === 'done');
  // Sanity: the sentinel is where the CLI keeps it (the Codex one replaced by the fresh login), and loom's things were watched.
  assert.equal(readFileSync(join(loginDir(benv, 'claude'), '.credentials.json'), 'utf-8').includes(SENTINEL), true);
  assert.ok(seen.some((x) => x.startsWith('spawnSync')) && seen.some((x) => x.startsWith('spawn ')) && seen.some((x) => x.startsWith('call poll')));
  const everything = [...seen, readFileSync(join(env.LOOM_BOX_HOME, 'state.json'), 'utf-8'), JSON.stringify(ran(h.id))];
  const hd = join(env.LOOM_BOX_DATA, 'houses');
  if (existsSync(hd)) for (const id of readdirSync(hd)) for (const f of readdirSync(join(hd, id))) { try { everything.push(readFileSync(join(hd, id, f), 'utf-8')); } catch { /* a dir */ } }
  for (const x of everything) assert.equal(x.includes(SENTINEL), false, x.slice(0, 200));
  assert.equal(everything.join('\n').includes('SENTINEL'), false);
});

test('a build leaves an agent its two newest house images: older ones go, unless a container uses them', () => {
  const t = (n) => `localhost/loom-house-art:${String(n).repeat(20)}`;
  podmanCfg({
    // podman prints CreatedAt in the box's zone: 02:00 CST is 08:00Z, so 3 is the second newest.
    images: [`${t(2)} 2026-11-07 09:00:00 +0000 UTC`, `${t(1)} 2026-11-08 09:00:00 +0000 UTC`, `${t(3)} 2026-11-08 02:00:00 -0600 CST`,
      `${t(4)} 2026-11-06 09:00:00 +0000 UTC`, `${t(5)} 2026-11-05 09:00:00 +0000 UTC`,
      `localhost/loom-house-mark:${'6'.repeat(20)} 2026-11-01 09:00:00 +0000 UTC`, 'localhost/loom-grader:1 2026-11-01 09:00:00 +0000 UTC'],
    inUse: [t(5)],
  });
  assert.deepEqual(pruneImages(env, 'art'), [t(2), t(4)]);
  assert.deepEqual(readFileSync(join(fake, 'rmis'), 'utf-8').trim().split('\n'), [t(2), t(4)]);
});

test('a held image build leaves polls and health reports flowing without duplicate claims', async () => {
  agentRepo(repo);
  setAgent();
  const h = up();
  podmanCfg({ holdBuild: true });
  const calls = [];
  const box = runner(env, { async call(path, body) {
    calls.push({ path, body });
    return client.call(path, body);
  } }, { loomUrl: 'http://loom.test/mcp', log: () => {},
    sampleHealth: async () => ({ marker: 'fresh health' }), sampleUnits: async () => [],
  });
  try {
    await box.tick({ wait: false });
    await until(() => existsSync(join(fake, 'building')));
    await box.settled();
    for (let i = 0; i < 3; i++) await box.tick({ wait: false });
    assert.equal(house(h.id).state, 'starting');
    assert.equal(calls.filter((c) => c.path === 'claim').length, 1);
    const polls = calls.filter((c) => c.path === 'poll' && c.body.facts);
    assert.equal(polls.length, 4);
    assert.ok(polls.slice(1).some((c) => c.body.health?.marker === 'fresh health'));
    podmanCfg({});
    await until(() => house(h.id).state === 'done');
    assert.equal(readFileSync(join(fake, 'builds'), 'utf-8').trim().split('\n').length, 1);
  } finally {
    podmanCfg({});
    await box.shutdown();
  }
});

test('shutdown cancels a held image build before starting a container', async () => {
  agentRepo(repo);
  setAgent();
  const h = up();
  podmanCfg({ holdBuild: true });
  await r.tick({ wait: false });
  await until(() => existsSync(join(fake, 'building')));
  await r.shutdown();
  assert.equal(house(h.id).state, 'failed');
  assert.equal(existsSync(join(fake, 'runs', `loom-house-${h.id}.json`)), false);
});

 test('build.watch accepts bounded repository paths and refuses paths outside the repository', () => {
  const parse = (watch) => parseHouseFile(JSON.stringify({ ...HOUSE, build: { ...HOUSE.build, watch } }));
  assert.deepEqual(parse(['bin', '.claude', 'bin']).build.watch, ['.claude', 'bin']);
  for (const watch of ['bin', [null], ['../private'], ['/etc'], Array(65).fill('bin')]) {
    assert.throws(() => parse(watch), /build.watch/);
  }
});


test('manual stop retains ownership and state until the container finishes rescue, after its attached client can exit', async () => {
  agentRepo(repo);setAgent();podmanCfg({run:'separate'});
  const h=ok(api(env,fx,{caller:owner,path:'up',body:{agent:'art',slot:'rescue-check',task:'work'}}));
  const prefix=join(fake,'runs',`loom-house-${h.id}`);
  try {
    await r.tick();
    await until(()=>existsSync(prefix+'.ready'));
    ok(api(env,fx,{caller:owner,path:'down',body:{id:h.id}}));
    await r.tick();
    await until(()=>existsSync(prefix+'.stopping'));
    await sleep(150);
    assert.equal(house(h.id).state,'stopping','the client exit is not the container stop acknowledgement');
    assert.equal(r.houses.has(h.id),true,'the runner still owns its physical container');
    assert.equal(existsSync(join(env.LOOM_BOX_DATA,'houses',h.id,'state','cursor')),true,'state is not cleaned while rescue can write');
    writeFileSync(prefix+'.release','');
    await until(()=>house(h.id).state==='stopped');
    assert.equal(house(h.id).exit,0,'report the actual completed container outcome');
    const saved=ok(api(env,fx,{caller:owner,path:'saved-state',body:{agent:'art',name:'rescue-check',slot:true}}));
    const cursor=spawnSync('tar',['-xzOf','-','./cursor'],{input:Buffer.from(saved.state,'base64'),encoding:'utf8'});
    assert.equal(cursor.status,0,cursor.stderr);assert.equal(cursor.stdout,'RESCUE-COMPLETED','saved state includes the final rescue write');
  } finally {
    writeFileSync(prefix+'.release','');
    await until(()=>existsSync(prefix+'.exit')).catch(()=>{});
  }
});


test('a failed stop while its container is still being created retries without orphaning the launch', async()=>{
  agentRepo(repo);setAgent();podmanCfg({run:'separate',createGate:true});
  const h=up('wait'),prefix=join(fake,'runs',`loom-house-${h.id}`);
  try{
    await r.tick();await until(()=>existsSync(prefix+'.json'));
    ok(api(env,fx,{caller:owner,path:'down',body:{id:h.id}}));await r.tick();
    await until(()=>existsSync(prefix+'.attempts')&&!r.houses.get(h.id)?.stopProcess);
    assert.equal(house(h.id).state,'stopping');assert.equal(r.houses.has(h.id),true);
    writeFileSync(prefix+'.create','');await until(()=>existsSync(prefix+'.ready'));
    await r.tick();await until(()=>existsSync(prefix+'.stopping'));
    assert.ok(Number(readFileSync(prefix+'.attempts','utf8'))>=2,'the original stop failed before the container existed');
    assert.equal(house(h.id).state,'stopping');
    writeFileSync(prefix+'.release','');await until(()=>house(h.id).state==='stopped');
    assert.equal(house(h.id).exit,0);
  }finally{writeFileSync(prefix+'.create','');writeFileSync(prefix+'.release','');await until(()=>existsSync(prefix+'.exit')).catch(()=>{});}
});


test('an inspection error during restart preserves a live house until it can be adopted',async()=>{
  agentRepo(repo);setAgent();podmanCfg({run:'sleep'});const h=up('work');
  await r.tick();await until(()=>existsSync(join(fake,'runs',`loom-house-${h.id}.pid`)));
  const old=r.houses.get(h.id);old.child.removeAllListeners('exit');
  const fresh=runner(env,client,{loomUrl:'http://loom.test/mcp',log:()=>{}});
  try{
    podmanCfg({run:'sleep',inspectError:true});await fresh.tick();
    assert.equal(house(h.id).state,'running','unknown inspection is not a dead container');
    assert.equal(existsSync(join(fake,'runs',`loom-house-${h.id}.stop`)),false);
    assert.ok(readdirSync(join(fake,'secrets')).length>0);
    podmanCfg({run:'sleep'});await fresh.tick();
    assert.equal(fresh.houses.get(h.id)?.adopted,true);
    ok(api(env,fx,{caller:owner,path:'down',body:{id:h.id}}));await fresh.tick();
    await until(()=>house(h.id).state==='stopped');
  }finally{try{process.kill(-old.child.pid,'SIGKILL');}catch{}}
});

test('a completed slot retains its only state when upload fails, then retries after a runner restart',async()=>{
  agentRepo(repo);setAgent();podmanCfg({run:'exit:0'});
  let fail=true;
  const flaky={async call(path,body){if(path==='save-state'&&fail)throw Error('temporary upload outage');return client.call(path,body);}};
  const box=runner(env,flaky,{loomUrl:'http://loom.test/mcp',log:()=>{}});
  const h=ok(api(env,fx,{caller:owner,path:'up',body:{agent:'art',slot:'upload-recovery',task:'PRIVATE-PROMPT-MUST-NOT-BE-IN-ENDING'}}));
  await box.tick();
  await until(()=>existsSync(join(fake,'runs',`loom-house-${h.id}.json`)));
  await sleep(150);
  assert.equal(house(h.id).state,'running','no terminal report before the state is safely stored');
  const cursor=join(env.LOOM_BOX_DATA,'houses',h.id,'state','cursor');
  assert.ok(existsSync(cursor),'keep the only saved state through upload failure');
  assert.equal(house(h.id).collection.phase,'state');
  assert.equal(houseBadge(house(h.id)),'saving state');
  const receipt=join(env.LOOM_BOX_DATA,'houses',h.id,'ending.json');
  assert.equal(statSync(receipt).mode&0o777,0o600);
  assert.equal(readFileSync(receipt,'utf8').includes('PRIVATE-PROMPT-MUST-NOT-BE-IN-ENDING'),false);
  assert.equal(readFileSync(receipt,'utf8').includes('loom_house_token_aaaaaaaaaaaaaaaa'),false);
  fail=false;
  const fresh=runner(env,flaky,{loomUrl:'http://loom.test/mcp',log:()=>{}});
  await fresh.tick();
  await until(()=>house(h.id).state==='done');
  const saved=ok(api(env,fx,{caller:owner,path:'saved-state',body:{agent:'art',name:'upload-recovery',slot:true}}));
  const contents=spawnSync('tar',['-xzOf','-','./cursor'],{input:Buffer.from(saved.state,'base64'),encoding:'utf8'});
  assert.equal(contents.stdout,`loom-house-${h.id};`);
});


for(const exit of [0,9])test(`losing an attached client adopts the existing physical container and preserves its outcome ${exit}`,async()=>{
  agentRepo(repo);setAgent();podmanCfg({run:'separate',separateExit:exit});const h=up('work');
  const prefix=join(fake,'runs',`loom-house-${h.id}`);
  try{
    await r.tick();await until(()=>existsSync(prefix+'.ready'));
    if(exit===9)podmanCfg({run:'separate',separateExit:exit,inspectError:true});
    process.kill(Number(readFileSync(prefix+'.client.pid','utf8')),'SIGTERM');
    if(exit===9){
      await until(()=>r.houses.get(h.id)?.pendingExit);await r.tick();
      assert.equal(house(h.id).state,'running');assert.equal(r.houses.get(h.id)?.adopted,undefined,'unknown inspection retains the original ownership');
      podmanCfg({run:'separate',separateExit:exit});await r.tick();
    }
    await until(()=>r.houses.get(h.id)?.adopted);
    assert.equal(house(h.id).state,'running');assert.equal(existsSync(prefix+'.stop'),false);
    const runs=readdirSync(join(fake,'log')).map(n=>JSON.parse(readFileSync(join(fake,'log',n),'utf8'))).filter(a=>a[0]==='run'&&a.includes(`loom-house-${h.id}`));
    assert.equal(runs.length,1,'no replacement container or restarted work');
    ok(api(env,fx,{caller:owner,path:'down',body:{id:h.id}}));await r.tick();
    await until(()=>existsSync(prefix+'.stopping'));writeFileSync(prefix+'.release','');
    await until(()=>house(h.id).state==='stopped');assert.equal(house(h.id).exit,exit);
  }finally{writeFileSync(prefix+'.release','');await until(()=>existsSync(prefix+'.exit')).catch(()=>{});}
});

test('a lost terminal-report response does not re-upload or discard unacknowledged state',async()=>{
  agentRepo(repo);setAgent();podmanCfg({run:'exit:0'});let dropped=false,uploads=0;
  const flaky={async call(path,body){
    if(path==='save-state')uploads++;
    const answer=await client.call(path,body);
    if(path==='report'&&body.state==='done'&&!dropped){dropped=true;throw Error('reply lost after commit');}
    return answer;
  }};
  const box=runner(env,flaky,{loomUrl:'http://loom.test/mcp',log:()=>{}});
  const h=ok(api(env,fx,{caller:owner,path:'up',body:{agent:'art',slot:'report-recovery',task:'work'}}));
  await box.tick();await until(()=>dropped);await sleep(50);
  const cursor=join(env.LOOM_BOX_DATA,'houses',h.id,'state','cursor');assert.ok(existsSync(cursor));
  const count=uploads;await box.tick();
  assert.equal(uploads,count,'already acknowledged state is not uploaded into a closed house');
  assert.equal(existsSync(cursor),false,'cleanup follows authoritative confirmation from the next poll');
  assert.equal(box.houses.has(h.id),false);
});

test('a fast container exit is not missed while the initial running report is still awaiting its response',async()=>{
  agentRepo(repo);setAgent();podmanCfg({run:'exit:0'});
  const slow={async call(path,body){const answer=await client.call(path,body);if(path==='report'&&body.state==='running')await sleep(300);return answer;}};
  const box=runner(env,slow,{loomUrl:'http://loom.test/mcp',log:()=>{}});const h=up('quick work');
  await box.tick();await until(()=>house(h.id).state==='done',1200);
  assert.equal(box.houses.has(h.id),false);
});

test('a lost reply after state upload commits is retried without losing the saved slot or its local copy',async()=>{
  agentRepo(repo);setAgent();podmanCfg({run:'exit:0'});let dropped=false,uploads=0;
  const flaky={async call(path,body){
    const answer=await client.call(path,body);
    if(path==='save-state'){uploads++;if(!dropped&&body.part===body.parts-1){dropped=true;throw Error('upload committed but reply lost');}}
    return answer;
  }};
  const box=runner(env,flaky,{loomUrl:'http://loom.test/mcp',log:()=>{}});
  const h=ok(api(env,fx,{caller:owner,path:'up',body:{agent:'art',slot:'upload-reply',task:'work'}}));
  await box.tick();await until(()=>dropped);await sleep(50);
  assert.equal(house(h.id).state,'running');assert.equal(house(h.id).collection.phase,'state');
  const dir=join(env.LOOM_BOX_DATA,'houses',h.id);
  assert.ok(existsSync(join(dir,'state','cursor')));
  assert.equal(JSON.parse(readFileSync(join(dir,'ending.json'),'utf8')).uploaded,false);
  assert.equal(ok(api(env,fx,{caller:owner,path:'saved-state',body:{agent:'art',name:'upload-reply',slot:true}})).from,h.id);
  await box.tick();await until(()=>house(h.id).state==='done');assert.ok(uploads>=2);
  const saved=ok(api(env,fx,{caller:owner,path:'saved-state',body:{agent:'art',name:'upload-reply',slot:true}}));
  assert.equal(spawnSync('tar',['-xzOf','-','./cursor'],{input:Buffer.from(saved.state,'base64'),encoding:'utf8'}).stdout,`loom-house-${h.id};`);
});
