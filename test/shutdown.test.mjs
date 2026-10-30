// t-1498: on SIGTERM (systemd restarting loom-box-local's service), the
// runner used to be dropped with no chance to tell podman to stop the houses
// it was running — Node's default SIGTERM disposition is to terminate at
// once. Nothing ever ran `podman stop -t 25` on the box's own shutdown (that
// path only existed inside box.mjs's per-house `stop(id)`, reached by a
// manual `down`), so a container whose PID 1 ignores SIGTERM (the real
// adapters, cf. the bug report) never exited, and systemd's own stop timeout
// fired instead.
//
// This runs the real CLI (`loom-box run`, joined mode) as a child process
// against a fake control plane (control.mjs's real api(), over a loopback
// HTTP server standing in for loom) and a fake podman (test/fake-podman.mjs)
// with a house up, then sends the child SIGTERM and checks: podman was told
// to stop the house's container, and the process exits promptly instead of
// leaving it to a 90s unit timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from '../src/control.mjs';
import { scratch } from './scratch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (x) => { assert.equal(x.status, 200, JSON.stringify(x.body)); return x.body; };

const HOUSE = {
  build: { containerfile: 'house/Containerfile', context: 'house' },
  command: ['claude', '-p'],
  secrets: { 'loom-token': { file: 'loom-token' }, 'github-token': { file: 'github-token' } },
  env: {},
  mounts: { state: '/home/art/.local/state' },
};

function agentRepo(dir) {
  mkdirSync(join(dir, 'house'), { recursive: true });
  writeFileSync(join(dir, 'house', 'Containerfile'), 'FROM scratch\n');
  writeFileSync(join(dir, 'house', 'house.json'), JSON.stringify(HOUSE));
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'house']]) {
    assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  }
}

async function until(f, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(25); }
}

/** A fake loom: the real control-plane api(), over HTTP, as `remoteClient` (box.mjs) calls it. */
function fakeLoom(env, fx, boxId) {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const path = req.url.replace(/^\/api\/box\//, '');
      const r = api(env, fx, { caller: { kind: 'piece', subject: boxId }, path, body: body ? JSON.parse(body) : {} });
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

async function sigtermWithAHouseUp(onExit, check) {
  const home = scratch('loom-box-term-');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  copyFileSync(join(here, 'fake-podman.mjs'), join(bin, 'podman'));
  chmodSync(join(bin, 'podman'), 0o755);
  const fake = join(bin, 'podman-state');
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, 'config.json'), JSON.stringify({ run: 'sleep' }));

  const repo = join(home, 'art-repo');
  mkdirSync(repo, { recursive: true });
  agentRepo(repo);

  const env = {
    HOME: home, PATH: process.env.PATH,
    LOOM_BOX_HOME: join(home, 'state'), LOOM_BOX_DATA: join(home, 'data'),
    LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_PODMAN: join(bin, 'podman'),
    LOOM_BOX_POLL_MS: '150', LOOM_BOX_ON_EXIT: onExit,
  };
  const fx = { now: () => new Date(), mint: () => 'loom_house_token_aaaaaaaaaaaaaaaa', revoke: () => {}, secret: (n) => `secret:${n}` };
  const owner = { kind: 'owner' };

  ok(api(env, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo, nested: false, secrets: { 'github-token': 'gh-art' } } }));
  const h = ok(api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'up', body: { task: 'wait' } }));

  const srv = await fakeLoom(env, fx, 'one');
  const port = srv.address().port;
  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'state', 'box.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, name: 'one' }));
  writeFileSync(join(home, 'state', 'credential'), 'loom_test_credential\n', { mode: 0o600 });

  const child = spawn(process.execPath, [cli, 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });

  try {
    // The house is up and podman is running it (the fake "container" is a live process).
    await until(() => existsSync(join(fake, 'runs', `loom-house-${h.id}.pid`)));
    assert.equal(existsSync(join(fake, 'runs', `loom-house-${h.id}.stop`)), false, 'not stopped yet');

    const before = Date.now();
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - before })));
    child.kill('SIGTERM');
    let giveUp;
    const timeout = new Promise((resolve) => { giveUp = setTimeout(() => resolve('timeout'), 20_000); });
    const result = await Promise.race([exited, timeout]);
    clearTimeout(giveUp);

    assert.notEqual(result, 'timeout', `loom-box didn't exit within 20s of SIGTERM (stderr: ${err})`);
    assert.equal(result.code, 0, `exit code (stderr: ${err})`);
    assert.equal(result.signal, null, `exit signal (stderr: ${err})`);
    await check({ result, err, fake, h });
  } finally {
    srv.close();
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

test('SIGTERM stops every running house before loom-box exits, when its unit would kill them anyway (t-1498)', async () => {
  await sigtermWithAHouseUp('stop', ({ result, err, fake, h }) => {
    // Clean and prompt: well inside systemd's 90s "final-sigterm" timeout, and exited on
    // its own (code 0), not killed out from under a stop still in flight.
    assert.equal(result.code, 0, `exit code (stderr: ${err})`);
    assert.equal(result.signal, null, `exit signal (stderr: ${err})`);
    assert.ok(result.ms < 5000, `took ${result.ms}ms to exit`);
    // The point of the fix: `podman stop -t 25` actually ran for the house's container,
    // which is what it takes for even a PID 1 that ignores SIGTERM to be made to exit.
    assert.ok(existsSync(join(fake, 'runs', `loom-house-${h.id}.stop`)), 'podman stop was never called for the running house');
    assert.match(err, /SIGTERM: stopping 1 house/);
  });
});

test('SIGTERM leaves the houses running when its unit keeps them: the next start adopts them (a box update)', async () => {
  // 2026-10-30: \`loom pieces update box\` stopped all 7 houses at once, and at load 120+ they took 10 minutes to
  // come back. Under loom's unit (KillMode=process) a house outlives loom-box; the restarted box adopts it.
  await sigtermWithAHouseUp('keep', ({ result, err, fake, h }) => {
    assert.ok(result.ms < 5000, `took ${result.ms}ms to exit`);
    assert.equal(existsSync(join(fake, 'runs', `loom-house-${h.id}.stop`)), false, 'podman stop ran: the house went down with the box');
    const pid = Number(readFileSync(join(fake, 'runs', `loom-house-${h.id}.pid`), 'utf-8'));
    assert.doesNotThrow(() => process.kill(pid, 0), 'the house is still running');
    process.kill(pid, 'SIGKILL');
    assert.match(err, /SIGTERM: leaving 1 house\(s\) running/);
  });
});

test('whether the houses outlive the box: the setting, else the unit it runs in', async () => {
  const { keepsHousesOnExit } = await import('../src/cli.mjs');
  const inUnit = (unit, mode) => ({ cgroup: () => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`, killMode: (u) => (u === unit ? `${mode}\n` : '') });
  assert.equal(keepsHousesOnExit({}, inUnit('loom-piece-box-run.service', 'process')), true);
  assert.equal(keepsHousesOnExit({}, inUnit('loom-box.service', 'control-group')), false);
  assert.equal(keepsHousesOnExit({}, { cgroup: () => '0::/user.slice/session-3.scope\n', killMode: () => 'process' }), false, 'not a service: stop them');
  assert.equal(keepsHousesOnExit({ LOOM_BOX_ON_EXIT: 'keep' }, inUnit('x.service', 'control-group')), true);
  assert.equal(keepsHousesOnExit({ LOOM_BOX_ON_EXIT: 'stop' }, inUnit('x.service', 'process')), false);
});
