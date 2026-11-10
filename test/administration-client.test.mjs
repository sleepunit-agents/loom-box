import test, { afterEach } from 'node:test';
import { cleanupAdministrationFixture, trackAdministrationFixture } from './administration-fixture.mjs';
afterEach(cleanupAdministrationFixture);
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { world } from './delivery-world.mjs';
import { deliver, loadConv } from '../src/delivery.mjs';
import { api } from '../src/control.mjs';
import { update } from '../src/state.mjs';
import { remoteClient } from '../src/box.mjs';
import { readExecution } from '../src/administration-execution-journal.mjs';
import { administrationUnit } from '../src/administration-supervisor.mjs';
import { administrativeHost } from '../src/administration-worker.mjs';
import { reconcileAdministration, readAdministrationRequest } from '../src/administration-client.mjs';
import { requestAdministration, administrationApproval, advanceAdministration, queueAdministration, administrationResult } from '../src/administration.mjs';
import { launchWorkerIdentity } from '../src/launch-journal.mjs';

async function fixture(t, lose, from = { kind: 'person', slug: 'owner' }, principalOutput = false) {
  const w = world(), caller = { kind: 'agent', agent: 'art' }, root = join(w.env.HOME, 'box-client');
  const { conversation } = await deliver(w.env, w.msg('dm:admin-client', 'Isolated client test', { from }), w.o);
  const c = loadConv(w.env, conversation), raw = c.body.split(':')[1];
  const proof = { conversation, key: w.runner.envs[raw].LOOM_BODY_KEY, session: w.sessionFor(conversation) };
  const identity = process.getuid() === 0 ? 'root' : 'runner';
  update(w.env, s => { s.agents.art = {}; s.boxes.one.administration = { v: 1, host: administrativeHost(), identities: { [identity]: { uid: process.getuid(), gid: process.getgid() } } }; });
  const scope = requestAdministration(w.env, caller, { ...proof, requestKey: 'client-scope', box: 'one', identity, cwd: w.env.HOME,
    work: 'Inspect the isolated fixture', why: 'Verify client recovery', minutes: 1 }, w.o);
  administrationApproval(w.env, scope.id, 'a-12345678', w.o);
  const journal = () => JSON.parse(readFileSync(join(w.env.LOOM_BOX_DATA, 'administration/journal.json'), 'utf8'));
  let used = false;
  await advanceAdministration(w.env, scope.id, { check: async () => ({ id: 'a-12345678', agent: 'art', for: scope.principal.owner ? 'owner' : scope.principal.for ?? '?', kind: 'box-administration', target: journal().scopes[scope.id].target,
    state: used ? 'used' : 'allowed', decidedBy: 'owner', expires: new Date(w.clock.now().getTime() + 60000).toISOString() }), use: async () => { used = true; } }, w.o);
  const marker = join(w.env.HOME, 'effects');
  const op = queueAdministration(w.env, caller, { ...proof, scope: scope.id, requestKey: 'client-command', intent: 'Inspect the isolated fixture',
    argv: [process.execPath, '-e', 'require("fs").appendFileSync(' + JSON.stringify(marker) + ',"one\\n");process.stdout.write(' + (principalOutput ? 'JSON.stringify({principal:process.env.APPROVALS_LOCAL_PRINCIPAL,conversation:process.env.LOOM_BODY_CONVERSATION,key:process.env.LOOM_BODY_KEY})' : '"private-client-output"') + ')'], stdin: 'private-client-input', timeoutMs: 10000 }, w.o);
  const calls = {};
  let lost = false;
  const server = createServer(async (req, res) => {
    try {
      const caller = req.headers.authorization === 'Bearer fixture-box-client' ? { kind: 'piece', subject: 'one' } : undefined;
      let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 1024 * 1024) throw Error('fixture input budget'); }
      const path = new URL(req.url, 'http://fixture').pathname.split('/').at(-1);
      calls[path] = (calls[path] ?? 0) + 1;
      const answer = await api(w.env, w.o, { caller, path, body: JSON.parse(text || '{}') });
      if (!lost && lose === 'mismatch-ack' && path === 'administration-complete' && answer.status === 200) {
        lost = true; answer.body.result.hash = '0'.repeat(64);
      }
      if (!lost && path === lose && answer.status === 200) { lost = true; res.destroy(); return; }
      res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer.body));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port, client = remoteClient(url, 'fixture-box-client');
  trackAdministrationFixture(join(root, 'executions'), () => op.id);
  const config = { root, id: op.id, env: { PATH: process.env.PATH, HOME: w.env.HOME },
    supervisor: process.env.LOOM_ADMIN_TEST_SUPERVISOR === 'systemd' ? 'systemd-fixture' : 'process-fixture' };
  return { ...w, root, op, marker, journal, proof, caller, calls, client, config, url };
}

async function fresh(w, expectFailure = false) {
  const script = `import{readFileSync}from'node:fs';import{remoteClient}from${JSON.stringify(new URL('../src/box.mjs', import.meta.url).href)};import{reconcileAdministration}from${JSON.stringify(new URL('../src/administration-client.mjs', import.meta.url).href)};const q=JSON.parse(readFileSync(0,'utf8'));try{console.log(JSON.stringify(await reconcileAdministration({...q.config,client:remoteClient(q.url,'fixture-box-client')})));}catch{console.log(JSON.stringify({failed:true}));}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, HOME: w.env.HOME }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
  child.stdin.end(JSON.stringify({ config: w.config, url: w.url }));
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0, errors);
  const result = JSON.parse(output);
  if (expectFailure) assert.equal(result.failed, true);
  return result;
}

test('lost claim reply reconciles the same worker ticket before one physical effect', async t => {
  const w = await fixture(t, 'administration-claim');
  await assert.rejects(reconcileAdministration({ ...w.config, client: w.client }));
  assert.equal(readAdministrationRequest(w.root, w.op.id).state, 'claiming');
  assert.equal(existsSync(w.marker), false);
  const answer = await reconcileAdministration({ ...w.config, client: w.client });
  assert.equal(answer.state, 'uploaded'); assert.equal(readFileSync(w.marker, 'utf8'), 'one\n');
  if (w.config.supervisor === 'systemd-fixture') assert.equal(readExecution(join(w.root, 'executions'), w.op.id).supervisor.unit, administrationUnit(join(w.root, 'executions'), w.op.id, true));
  assert.equal(w.calls['administration-claim'], 2); assert.equal(w.calls['administration-admit'], 1);
  assert.equal(administrationResult(w.env, w.caller, { ...w.proof, operation: w.op.id }, w.o).result.stdout, 'private-client-output');
  assert.deepEqual(await reconcileAdministration({ ...w.config, client: w.client }), answer);
});

test('a fresh client reconciles a lost completion acknowledgement without repeating a command', async t => {
  const w = await fixture(t, 'administration-complete');
  await assert.rejects(reconcileAdministration({ ...w.config, client: w.client }));
  assert.equal(w.journal().operations[w.op.id].state, 'finished');
  assert.equal(readAdministrationRequest(w.root, w.op.id).state, 'ready');
  const disk = readFileSync(join(w.root, 'requests', w.op.id + '.json'), 'utf8');
  assert.equal(disk.includes('private-client-input'), false); assert.equal(disk.includes('private-client-output'), false);
  const answer = await fresh(w);
  assert.equal(answer.state, 'uploaded'); assert.equal(w.calls['administration-admit'], 1);
  assert.equal(w.calls['administration-complete'], 2); assert.equal(readFileSync(w.marker, 'utf8'), 'one\n');
  assert.equal(readAdministrationRequest(w.root, w.op.id).state, 'uploaded');
  assert.equal(existsSync(join(w.root, 'executions', w.op.id + '.json')), true);
});

test('a dead claimant is fenced before admission instead of transferring its command to a new worker', async t => {
  const w = await fixture(t, 'administration-claim');
  await fresh(w, true);
  assert.equal(w.journal().operations[w.op.id].state, 'claimed');
  const answer = await reconcileAdministration({ ...w.config, client: w.client });
  assert.equal(answer.state, 'cancelled');
  assert.equal(w.journal().operations[w.op.id].state, 'cancelled');
  assert.equal(w.journal().operations[w.op.id].admission, undefined);
  assert.equal(w.calls['administration-admit'], undefined);
  assert.equal(existsSync(w.marker), false);
});

test('host execution does not turn an approved non-owner principal into the owner', async t => {
  const w = await fixture(t, undefined, { kind: 'agent', id: 'mark' }, true);
  assert.equal((await reconcileAdministration({ ...w.config, client: w.client })).state, 'uploaded');
  const context = JSON.parse(administrationResult(w.env, w.caller, { ...w.proof, operation: w.op.id }, w.o).result.stdout);
  assert.equal(context.principal, 'unknown'); assert.equal(context.conversation, w.proof.conversation);
  assert.equal(context.key, 'non-native-administration-command'); assert.notEqual(context.key, w.proof.key);
});

test('a mismatched completion acknowledgement retains the local result for an exact retry', async t => {
  const w = await fixture(t, 'mismatch-ack');
  await assert.rejects(reconcileAdministration({ ...w.config, client: w.client }), /acknowledgement does not match/);
  assert.equal(readAdministrationRequest(w.root, w.op.id).state, 'ready');
  assert.equal(w.journal().operations[w.op.id].state, 'finished');
  const reply = await fresh(w);
  assert.equal(reply.state, 'uploaded');
  assert.equal(w.calls['administration-admit'], 1); assert.equal(w.calls['administration-complete'], 2);
  assert.equal(readFileSync(w.marker, 'utf8'), 'one\n');
});

test('claim cancellation fences a late admission but cannot cancel an already admitted command', async t => {
  for (const admitFirst of [false, true]) {
    const w = await fixture(t);
    const worker = { ...launchWorkerIdentity(), host: administrativeHost(), uid: process.getuid(), gid: process.getgid() };
    const claim = await w.client.call('administration-claim', { operation: w.op.id, worker });
    const proof = { operation: w.op.id, worker, ticket: claim.ticket };
    await assert.rejects(w.client.call('administration-cancel-claim', { ...proof, ticket: 'wrong' }), /403/);
    if (admitFirst) assert.equal((await w.client.call('administration-admit', proof)).authorized, true);
    const cancel = await w.client.call('administration-cancel-claim', proof);
    assert.equal(cancel.cancelled, !admitFirst);
    if (!admitFirst) assert.equal((await w.client.call('administration-admit', proof)).authorized, false);
    else assert.equal(w.journal().operations[w.op.id].state, 'admitted');
    assert.equal(existsSync(w.marker), false);
  }
});

test('administrative remote calls use an abortable observation deadline', async () => {
  let aborted = false;
  // A real pending network request keeps an OS handle alive. Model that handle
  // separately from AbortSignal.timeout's intentionally unreferenced timer.
  const network = setInterval(() => {}, 1000);
  const client = remoteClient('http://fixture', 'fixture-only', async (_url, options) => new Promise((_resolve, reject) => {
    assert.ok(options.signal);
    options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
  }));
  try {
    await assert.rejects(client.call('administration-work', {}, { timeoutMs: 100 }), { name: 'TimeoutError' });
    assert.equal(aborted, true);
  } finally { clearInterval(network); }
});
