// Explicit integration check, outside the default unit suite:
// LOOM_NATIVE_HOST_IMAGE=<existing local Node24 house image> node --test test/integration/native-host-death.mjs
// Real Podman and real runtime processes; model-free provider CLIs only. No
// production credentials, conversations, houses or provider endpoints are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, setAgent } from '../../src/control.mjs';
import { load, update } from '../../src/state.mjs';
import { setModels } from '../../src/models.mjs';
import { deliver, loadConv } from '../../src/delivery.mjs';
import { HouseRunner, hostOf } from '../../src/houserunner.mjs';
import { collectNativeHistory } from '../../src/native-collection-client.mjs';
import { MAX_SESSION_BYTES } from '../../src/sessions.mjs';
import { readHouseLaunch } from '../../src/house-launch-journal.mjs';
import { cvOf, fakeLoomBin } from '../delivery-world.mjs';
import { scratch } from '../scratch.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(repo, 'src/cli.mjs');
const image = process.env.LOOM_NATIVE_HOST_IMAGE;
assert.ok(image, 'set LOOM_NATIVE_HOST_IMAGE to an existing local house image; this test never pulls or builds images');
const pod = args => spawnSync('podman', args, { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
assert.equal(pod(['image', 'exists', image]).status, 0, 'integration image must already exist locally');
const nodeLocation = pod(['run', '--rm', '--pull=never', '--network=none', '--entrypoint', 'node', image, '-p', 'process.execPath']);
assert.equal(nodeLocation.status, 0, nodeLocation.stderr);
const imageNode = nodeLocation.stdout.trim();
assert.match(imageNode, /^\/[A-Za-z0-9_./-]+$/, 'use the image\'s actual Node binary, not a HOME-dependent mise shim');
const wait = async (fn, label) => {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = await fn(); if (value) return value;
    if (Date.now() > end) throw Error(`host-death fixture timed out: ${label}`);
    await new Promise(r => setTimeout(r, 25));
  }
};
function child(bin, args, env, input = '') {
  const process = spawn(bin, args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', x => { stdout = (stdout + x).slice(-20_000); });
  process.stderr.on('data', x => { stderr = (stderr + x).slice(-20_000); });
  process.stdin.on('error', () => {}); process.stdin.end(input);
  const done = new Promise((resolve, reject) => {
    process.once('error', reject); process.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { process, done, diagnostics: () => ({ code: process.exitCode, signal: process.signalCode,
    stderr: stderr.slice(-2000).replace(/[0-9a-f]{40,}/gi, '[fixture-key]') }), kill() {
    if (process.exitCode === null && process.signalCode === null) {
      try { globalThis.process.kill(-process.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } };
}
async function serverFor(env, holdReceipts = false) {
  const seqs = new Map();
  let held = false, release;
  const gate = new Promise(r => { release = r; });
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', x => { raw += x; }); req.on('end', async () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      try {
        const body = JSON.parse(raw || '{}'), token = req.headers.authorization?.replace(/^Bearer /, '');
        if (req.url.startsWith('/api/loom/')) {
          if (token !== 'fixture-runtime-token') return send(403, { error: 'wrong runtime credential' });
          if (req.url === '/api/loom/conversations/turn') {
            const conversation = cvOf(body.agent, body.venue, body.place), seq = (seqs.get(conversation) ?? 0) + 1;
            seqs.set(conversation, seq); return send(200, { conversation, seq });
          }
          if (req.url === '/api/loom/audit') return send(200, { conversation: body.conversation, seq: body.seq });
          if (req.url === '/api/loom/venues') return send(200, { venues: [{ name: 'slack', kind: 'live', piece: 'slack', send: [process.execPath, join(repo, 'test/fake-send.mjs')] }] });
          return send(404, { error: 'fixture route not found' });
        }
        const path = /^\/api\/box\/([a-z-]+)$/.exec(req.url)?.[1], house = /^fixture-house-token-(h-[0-9]+)$/.exec(token ?? '')?.[1];
        if (!path || !house) return send(403, { error: 'wrong house credential' });
        if (holdReceipts && house === 'h-1' && path === 'body-sync' && Object.values(body.report?.done ?? {}).some(d => d.id)) { held = true; await gate; }
        const result = await api(env, { now: () => new Date() }, { caller: { kind: 'agent', agent: 'art', house }, path, body });
        send(result.status, result.body);
      } catch { send(500, { error: 'fixture request failed' }); }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, held: () => held, release, close: () => new Promise(r => server.close(r)) };
}

for (const harness of ['claude', 'codex']) for (const mode of ['normal', 'size', 'missing-bound', 'missing-unbound']) test(`${harness}: real container host SIGKILL ${mode} recovery preserves usable sender identity`, { timeout: 120_000 }, async t => {
  const oversized = mode === 'size', missing = mode.startsWith('missing'), unbound = mode === 'missing-unbound';
  const root = scratch('native-container-death-'), home = join(root, 'controller'), tag = randomBytes(6).toString('hex');
  const env = { PATH: process.env.PATH, HOME: home, LOOM_HOME: join(home, '.config/loom'), LOOM_BOX_HOME: join(root, 'state'), LOOM_BOX_DATA: join(root, 'data'),
    LOOM_BOX_LOCAL_NAME: 'one', LOOM_RUNTIME_ACCOUNTS: 'none', LOOM_RUNTIME_SCORECARDS: 'off', LOOM_RUNTIME_TOKEN_FILE: join(root, 'runtime-token') };
  mkdirSync(env.LOOM_HOME, { recursive: true }); writeFileSync(env.LOOM_RUNTIME_TOKEN_FILE, 'fixture-runtime-token\n', { mode: 0o600 });
  env.LOOM_BIN = fakeLoomBin(root);
  const sends = join(root, 'sends'); mkdirSync(sends); env.FAKE_SEND = sends;
  const previousSend = process.env.FAKE_SEND; process.env.FAKE_SEND = sends;
  const server = await serverFor(env, unbound); env.LOOM_RUNTIME_LOOM_URL = server.url;
  setAgent(env, { now: () => new Date() }, { agent: 'art', repo: 'https://example.com/art.git' });
  setModels(env, { list: [{ id: harness === 'claude' ? 'opus' : 'gpt-5.5', harness, family: harness === 'claude' ? 'anthropic' : 'openai' }] });
  update(env, s => { Object.values(s.boxes).find(b => b.local).harnesses = { [harness]: { loggedIn: true } }; });
  const box = { kind: 'piece', subject: Object.keys(load(env).boxes).find(k => load(env).boxes[k].local) };
  const call = async (path, body) => {
    const result = await api(env, { mint: () => 'fixture-minted-token', revoke: () => {}, secret: () => '' }, { caller: box, path, body });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  };
  const containers = [], controllers = [];
  const abort = () => { for (const p of [...controllers, ...containers.map(c => c.host)]) p.kill(); };
  t.signal.addEventListener('abort', abort);
  let serial = 0;
  const message = text => ({ source: 'slack', id: `${tag}-${++serial}`, agent: 'art', venue: 'slack', place: 'dm:native-host-death', label: 'fixture',
    from: { kind: 'person', slug: 'loren' }, kind: 'message', at: new Date().toISOString(), text });
  const queue = text => deliver(env, message(text), { detach: true, spawnWorker: () => {} });
  const tick = cv => { const p = child(process.execPath, [cli, 'deliver', 'tick', '--conversation', cv], env); controllers.push(p); return p; };
  const bound = (controller, house) => Promise.race([controller.done, house.host.done.then(result => {
    throw Error(`fixture host exited before native bind: ${JSON.stringify({ code: result.code, stderr: result.stderr.replace(/[0-9a-f]{40,}/gi, '[fixture-key]') })}`);
  })]);
  async function house(id) {
    const allocated = await wait(() => load(env).houses[id], `allocation ${id}`);
    const dir = join(root, id), history = join(root, `${id}-native`), snapshot = join(root, `${id}-snapshot`);
    mkdirSync(join(dir, 'work'), { recursive: true, mode: 0o700 }); mkdirSync(history, { mode: 0o700 });
    writeFileSync(join(dir, 'token'), `fixture-house-token-${id}\n`, { mode: 0o600 });
    const claimed = await call('claim', { id, nativeHistory: 1 }); assert.equal(claimed.nativeHistory.v, 1);
    await call('report', { id, state: 'running' });
    const name = `loom-native-death-${tag}-${id}`;
    const variables = { HOME: '/fixture/house', PATH: `${dirname(imageNode)}:/usr/local/bin:/usr/bin:/bin`, HOUSE_ID: id, HOUSE_AGENT: 'art', LOOM_URL: server.url, LOOM_TOKEN_FILE: '/fixture/house/token',
      CLAUDE_CONFIG_DIR: '/fixture/house', LOOM_RUNTIME_CLAUDE_JOBS: '/fixture/house/jobs', LOOM_RUNTIME_CODEX_RUNS: '/fixture/house/runs',
      LOOM_RUNTIME_CLAUDE: '/runtime/test/integration/native-host-fixture.mjs', LOOM_RUNTIME_CODEX: '/runtime/test/integration/native-host-fixture.mjs',
      LOOM_RUNTIME_INBOX_DIR: '/fixture/house/inbox', LOOM_RUNTIME_NATIVE_HISTORY: '/run/loom-native-history', FIXTURE_NATIVE_HARNESS: harness,
      ...(oversized && id === 'h-1' ? { FIXTURE_SESSION_BYTES: String(MAX_SESSION_BYTES + 1) } : {}),
      ...(harness === 'claude' ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/house/login' } : { LOOM_LOGIN_CODEX: '/fixture/house/login' }) };
    const boot = /--host-key ([0-9a-f]{48})/.exec(allocated.task)?.[1]; assert.ok(boot);
    const args = ['run', '--rm', '--pull=never', '--name', name, '--network=host',
      '-v', `${dir}:/fixture/house`, '-v', `${history}:/run/loom-native-history`, '-v', `${repo}:/runtime:ro`, '-w', '/fixture/house/work',
      ...Object.entries(variables).flatMap(([key, value]) => ['-e', `${key}=${value}`]), '--entrypoint', imageNode, image,
      '/runtime/src/cli.mjs', 'body-host', '--piece', 'box', '--host-key', boot, '--beats', '200'];
    const host = child('podman', args, { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR });
    const value = { id, name, dir, history, snapshot, host }; containers.push(value); return value;
  }
  try {
    const queued = await queue('INITIAL-HOST-DEATH-TURN'); assert.equal(queued.body, 'queued'); const cv = queued.conversation;
    const firstController = tick(cv), first = await house('h-1');
    if (unbound) { await wait(server.held, 'native receipt held before core handoff'); firstController.kill(); assert.equal((await firstController.done).signal, 'SIGKILL'); }
    else { const started = await bound(firstController, first); assert.equal(started.code, 0, started.stderr); }
    const before = loadConv(env, cv); assert.equal(!!before.body, !unbound, JSON.stringify(before.outcomes)); assert.equal(before.actsFor.owner, false);
    if (unbound) assert.equal(readHouseLaunch(env, before.starting.prepared.id).state, 'published');
    const originalProof = await wait(() => existsSync(join(first.dir, 'proof.json')) && JSON.parse(readFileSync(join(first.dir, 'proof.json'), 'utf8')), 'original native proof');
    assert.equal(originalProof.resumed, false);
    await queue('PENDING-HOST-DEATH-FOLLOWUP');
    if (!unbound) {
      const fed = await tick(cv).done; assert.equal(fed.code, 0, fed.stderr);
      await wait(() => Object.values(hostOf(env, 'art', 'p-loren').report?.bodies ?? {}).some(b => b.pending?.length), 'pending native inbox');
    }
    assert.equal(pod(['kill', '--signal', 'KILL', first.name]).status, 0, 'kill the actual body-host container, not the delivery controller');
    const dead = await first.host.done; assert.notEqual(dead.code, 0);
    await wait(() => pod(['container', 'exists', first.name]).status === 1, 'positive physical disappearance');
    rmSync(first.dir, { recursive: true, force: true }); // Container HOME is lost; only the private native mount survives.
    if (missing) rmSync(first.history, { recursive: true, force: true }); // Deliberate fixture loss after positive physical termination.
    const client = { call };
    await collectNativeHistory({ client, id: first.id, root: first.history, snapshot: first.snapshot, physical: 'gone' });
    assert.equal(load(env).houses[first.id].nativeHistory.complete, true);
    server.release();
    await call('report', { id: first.id, state: 'failed' });
    await queue('NEXT-HOST-DEATH-TURN');
    const resumedController = tick(cv), second = await house('h-2');
    const resumed = await bound(resumedController, second); assert.equal(resumed.code, 0, resumed.stderr);
    const after = loadConv(env, cv), proof = await wait(() => existsSync(join(second.dir, 'proof.json')) && JSON.parse(readFileSync(join(second.dir, 'proof.json'), 'utf8')), 'restored native proof');
    assert.equal(proof.resumed, !oversized && !missing);
    if (oversized || missing) assert.notEqual(proof.session, originalProof.session, 'explicit context loss continues fresh, never with a fabricated native session');
    else assert.equal(proof.session, originalProof.session);
    assert.equal(proof.reconciliation, missing, 'missing history must reach the model as an explicit reconciliation notice');
    if (missing) assert.equal(proof.initial, 1, 'the original sealed intent is supplied exactly once as reconciliation context');
    assert.equal(proof.pending, 1); assert.equal(proof.next, 1);
    assert.equal(after.body?.startsWith(`${harness}:h-2-`), true); assert.equal(after.runs, unbound ? 1 : 2);
    assert.deepEqual(after.actsFor, before.actsFor); assert.notEqual(after.run, before.run); assert.notEqual(after.sendKey, before.sendKey);
    if (missing) {
      assert.equal(after.nativeLossCount, 1); assert.equal(after.nativeLosses[0].mayHaveActed, true);
      assert.equal(after.runLog.at(-1).recovery.kind, 'native-history-missing'); assert.equal(after.nativeRecovery, undefined);
    }
    const reply = await child('podman', ['exec', '-e', `${harness === 'claude' ? 'CLAUDE_CODE_SESSION_ID' : 'CODEX_THREAD_ID'}=${proof.session}`,
      second.name, imageNode, '/runtime/src/cli.mjs', 'send', '--conversation', cv, '--piece', 'box', '--text', 'native host-death recovered sender'],
    { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }).done;
    assert.equal(reply.code, 0, reply.stdout + reply.stderr); assert.equal(JSON.parse(reply.stdout).posted, true);
    const posted = readFileSync(join(sends, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(posted.map(x => x.text), ['native host-death recovered sender']);
    assert.equal(Object.keys(load(env).houses).length, 2);
    if (unbound) { const old = readHouseLaunch(env, before.starting.prepared.id); assert.equal(old.state, 'terminated'); assert.equal(old.termination.consumed, true); assert.notEqual(after.sendKey, before.starting.prepared.snapshot.senderHash); }
    else assert.equal(new HouseRunner(env, harness).packReady({ id: before.body.split(':')[1], house: 'h-1', agent: 'art' }), false, 'the committed continuity slot consumed its old core pack');
  } catch (error) {
    console.error('owned fixture lifecycle', JSON.stringify(containers.map(c => ({ house: c.id, ...c.host.diagnostics() }))));
    throw error;
  } finally {
    server.release();
    for (const p of controllers) p.kill();
    const cleanup = [];
    for (const value of containers) {
      pod(['rm', '-f', '--time', '0', value.name]);
      if (pod(['container', 'exists', value.name]).status !== 1) cleanup.push(value.name);
    }
    await Promise.allSettled([...controllers, ...containers.map(c => c.host)].map(p => p.done));
    await server.close(); if (previousSend === undefined) delete process.env.FAKE_SEND; else process.env.FAKE_SEND = previousSend;
    t.signal.removeEventListener('abort', abort);
    assert.deepEqual(cleanup, [], 'every owned fixture container must be positively gone after cleanup');
  }
});
