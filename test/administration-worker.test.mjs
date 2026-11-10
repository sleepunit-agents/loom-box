// Harmless physical commands with a fixture admission callback, never a live
// owner approval or production box capability.
import test, { afterEach } from 'node:test';
import { cleanupAdministrationFixture, trackAdministrationFixture } from './administration-fixture.mjs';
afterEach(cleanupAdministrationFixture);
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';
import { administrativeHost, runAdministrationCommand, observeAdministrationExecution } from '../src/administration-worker.mjs';
import { readExecution } from '../src/administration-execution-journal.mjs';
import { launchWorkerAlive } from '../src/launch-journal.mjs';
import { administrationUnit, administrationSupervisorAvailable, administrationUnitState, signalAdministrationUnit } from '../src/administration-supervisor.mjs';
import { world } from './delivery-world.mjs';
import { deliver, loadConv } from '../src/delivery.mjs';
import { update } from '../src/state.mjs';
import { requestAdministration, administrationApproval, advanceAdministration, queueAdministration, claimAdministration, admitAdministration, completeAdministrationCommand, administrationResult } from '../src/administration.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 15_000;
  while (!fn()) { if (Date.now() >= end) throw Error('physical administrative fixture did not reach its boundary'); await delay(20); }
}
function fixture() {
  const root = scratch('administrative-execution-'), id = 'ado-' + 'a'.repeat(32);
  const execution = { host: administrativeHost(), uid: process.getuid(), gid: process.getgid() };
  const env = { PATH: process.env.PATH, HOME: root, LOOM_FAKE_BOX_TOKEN: 'private-box-token' };
  const payload = { argv: [process.execPath, '-e', 'process.stdout.write("ok")'], cwd: root, stdin: '', identity: process.getuid() === 0 ? 'root' : 'runner', timeoutMs: 10_000 };
  const admit = async q => ({ authorized: true, receipt: { operation: q.operation, payloadHash: q.payloadHash, worker: q.worker,
    serverAt: Date.now(), until: Date.now() + 10_000, remainingMs: 10_000 } });
  // Freeze both wall timestamps together; this is a protocol fixture, not a grant.
  const admission = async q => { const r = await admit(q); r.receipt.until = r.receipt.serverAt + r.receipt.remainingMs; return r; };
  trackAdministrationFixture(root, () => id);
  return { root, id, env, execution, payload, admit: admission, supervisor: process.env.LOOM_ADMIN_TEST_SUPERVISOR === 'systemd' ? 'systemd-fixture' : 'process-fixture' };
}

test('a physical command runs once, receives stdin, and seals input and output without box credentials', async () => {
  const q = fixture(), marker = join(q.root, 'effect');
  q.payload.argv = [process.execPath, '-e', 'const f=require("fs");let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{f.appendFileSync(' + JSON.stringify(marker) + ',"one\\n");process.stdout.write(s+":"+String(process.env.LOOM_FAKE_BOX_TOKEN));});'];
  q.payload.stdin = 'private-command-stdin';
  const result = await runAdministrationCommand(q);
  assert.equal(result.result.outcome, 'exited', result.result.stderr); assert.equal(result.result.exitCode, 0);
  assert.equal(result.result.stdout, 'private-command-stdin:undefined');
  if (q.supervisor === 'systemd-fixture') assert.equal(readExecution(q.root, q.id).supervisor.unit, administrationUnit(q.root, q.id, true));
  const again = await runAdministrationCommand(q);
  assert.deepEqual(again, result); assert.equal(readFileSync(marker, 'utf8'), 'one\n');
  const journal = readFileSync(join(q.root, q.id + '.json'), 'utf8');
  assert.equal(journal.includes('private-command-stdin'), false);
  assert.equal(journal.includes('private-box-token'), false);
});

test('wrong OS identity, refused admission, and elapsed network time never release command input', async () => {
  const wrong = fixture();
  await assert.rejects(runAdministrationCommand({ ...wrong, execution: { ...wrong.execution, uid: wrong.execution.uid + 1 } }), /approved host and OS identity/);
  for (const slow of [false, true]) {
    const q = fixture(), marker = join(q.root, 'must-not-exist');
    q.payload.argv = [process.execPath, '-e', 'require("fs").writeFileSync(' + JSON.stringify(marker) + ',"bad")'];
    q.admit = async request => {
      if (!slow) return { authorized: false };
      await delay(100);
      return { authorized: true, receipt: { operation: request.operation, payloadHash: request.payloadHash, worker: request.worker, serverAt: 100, until: 101, remainingMs: 1 } };
    };
    const result = await runAdministrationCommand(q);
    assert.equal(result.result.outcome, 'not-started'); assert.equal(existsSync(marker), false);
    assert.equal((await runAdministrationCommand(q)).result.outcome, 'not-started');
  }
});

test('physical output is bounded and a targeted revoke stops an actually running command', async () => {
  const q = fixture();
  q.payload.argv = [process.execPath, '-e', 'process.stdout.write("x".repeat(200000))'];
  const output = await runAdministrationCommand(q);
  assert.equal(output.result.truncated, true); assert.ok(Buffer.byteLength(output.result.stdout) <= 64 * 1024);
  const stop = fixture(), marker = join(stop.root, 'started');
  stop.payload.timeoutMs = 20_000;
  stop.payload.argv = [process.execPath, '-e', 'require("fs").writeFileSync(' + JSON.stringify(marker) + ',"started");setTimeout(()=>{},60000)'];
  stop.isStopped = async () => existsSync(marker);
  const result = await runAdministrationCommand(stop);
  assert.equal(existsSync(marker), true);
  assert.equal(result.result.outcome, 'exited'); assert.equal(result.result.signal, 'SIGTERM');
  assert.equal(launchWorkerAlive(readExecution(stop.root, stop.id).child), false);
});

test('the gate seals a result after worker SIGKILL and restart never repeats the physical effect', async t => {
  const q = fixture(), marker = join(q.root, 'effect');
  q.payload.argv = [process.execPath, '-e', 'require("fs").appendFileSync(' + JSON.stringify(marker) + ',"one\\n");setTimeout(()=>process.stdout.write("saved-after-worker-death"),1200)'];
  const script = `import{readFileSync}from'node:fs';import{runAdministrationCommand}from${JSON.stringify(new URL('../src/administration-worker.mjs', import.meta.url).href)};const q=JSON.parse(readFileSync(0,'utf8'));await runAdministrationCommand({...q,admit:async r=>({authorized:true,receipt:{operation:r.operation,payloadHash:r.payloadHash,worker:r.worker,serverAt:100,until:10100,remainingMs:10000}})});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, HOME: q.root }, stdio: ['pipe', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const record = readExecution(q.root, q.id);
    if (record?.supervisor) signalAdministrationUnit(q.env, record, 'SIGKILL');
    else if (record?.child && launchWorkerAlive(record.child) === true) { try { process.kill(-record.child.pid, 'SIGKILL'); } catch {} }
  });
  child.stdin.end(JSON.stringify({ root: q.root, id: q.id, execution: q.execution, payload: q.payload, env: q.env, supervisor: q.supervisor }));
  await until(() => existsSync(marker));
  assert.equal(readExecution(q.root, q.id).phase, 'executing', errors);
  child.kill('SIGKILL'); assert.equal((await closed).signal, 'SIGKILL');
  await until(() => readExecution(q.root, q.id).phase === 'finished');
  const result = observeAdministrationExecution(q);
  assert.equal(result.result.stdout, 'saved-after-worker-death');
  assert.deepEqual(await runAdministrationCommand(q), result);
  assert.equal(readFileSync(marker, 'utf8'), 'one\n');
});

test('a physical command uses the actual controller claim, admission and sealed result operations', async () => {
  const q = fixture(), w = world(), caller = { kind: 'agent', agent: 'art' }, box = { kind: 'piece', subject: 'one' };
  const { conversation } = await deliver(w.env, w.msg('dm:physical-admin', 'Isolated host fixture', { from: { kind: 'person', slug: 'owner' } }), w.o);
  const c = loadConv(w.env, conversation), raw = c.body.split(':')[1];
  const proof = { conversation, key: w.runner.envs[raw].LOOM_BODY_KEY, session: w.sessionFor(conversation) };
  update(w.env, s => { s.agents.art = {}; s.boxes.one.administration = { v: 1, host: q.execution.host,
    identities: { [q.payload.identity]: { uid: q.execution.uid, gid: q.execution.gid } } }; });
  const scope = requestAdministration(w.env, caller, { ...proof, requestKey: 'physical-scope', box: 'one', identity: q.payload.identity,
    cwd: q.root, work: 'Inspect the isolated fixture', why: 'Verify physical admission', minutes: 1 }, w.o);
  administrationApproval(w.env, scope.id, 'a-12345678', w.o);
  let used = false;
  // Fixture owner decision only; no production approval is answered here.
  await advanceAdministration(w.env, scope.id, { check: async () => ({ id: 'a-12345678', agent: 'art', for: 'owner', kind: 'box-administration',
    target: JSON.parse(readFileSync(join(w.env.LOOM_BOX_DATA, 'administration/journal.json'), 'utf8')).scopes[scope.id].target,
    state: used ? 'used' : 'allowed', decidedBy: 'owner', expires: new Date(w.clock.now().getTime() + 60_000).toISOString() }), use: async () => { used = true; } }, w.o);
  const op = queueAdministration(w.env, caller, { ...proof, scope: scope.id, requestKey: 'physical-command', intent: 'Print the isolated fixture', ...q.payload }, w.o);
  q.id = op.id;
  trackAdministrationFixture(q.root, () => q.id);
  q.payload = { argv: q.payload.argv, stdin: q.payload.stdin, cwd: q.payload.cwd, identity: q.payload.identity, timeoutMs: q.payload.timeoutMs };
  let ticket, worker;
  q.admit = async request => {
    worker = request.worker;
    const claim = claimAdministration(w.env, box, { operation: op.id, worker }, w.o);
    ticket = claim.ticket; assert.deepEqual(claim.payload, q.payload);
    return admitAdministration(w.env, box, { operation: op.id, worker, ticket }, w.o);
  };
  const result = await runAdministrationCommand(q);
  assert.equal(result.result.stdout, 'ok');
  const saved = completeAdministrationCommand(w.env, box, { operation: op.id, worker, ticket, result: result.result }, w.o);
  assert.equal(saved.state, 'finished');
  assert.equal(administrationResult(w.env, caller, { ...proof, operation: op.id }, w.o).result.stdout, 'ok');
  assert.deepEqual(await runAdministrationCommand(q), result);
});

test('loss of the executing gate records unknown and never replays a possibly effective command', async t => {
  const q = fixture(), marker = join(q.root, 'command-identity'), effect = join(q.root, 'effect');
  q.payload.argv = [process.execPath, '-e', 'const f=require("fs");const s=f.readFileSync("/proc/self/stat","utf8");f.appendFileSync(' + JSON.stringify(effect) + ',"one\\n");f.writeFileSync(' + JSON.stringify(marker) + ',JSON.stringify({pid:process.pid,boot:f.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),birth:s.slice(s.lastIndexOf(")")+2).trim().split(/\\s+/)[19]}));setTimeout(()=>{},1000);'];
  t.after(() => {
    if (!existsSync(marker)) return;
    const command = JSON.parse(readFileSync(marker, 'utf8'));
    if (launchWorkerAlive(command) === true) { try { process.kill(command.pid, 'SIGKILL'); } catch {} }
  });
  const running = runAdministrationCommand(q);
  await until(() => existsSync(marker));
  const gate = readExecution(q.root, q.id).child;
  if (q.supervisor === 'systemd-fixture') {
    const unit = administrationUnitState(q.env, readExecution(q.root, q.id).supervisor.unit);
    assert.equal(unit.killMode, 'control-group');
    assert.equal(unit.stopTimeout, '2s');
    assert.notEqual(unit.runtimeMax, 'infinity');
  }
  assert.equal(launchWorkerAlive(gate), true);
  process.kill(gate.pid, 'SIGKILL');
  const result = await running;
  assert.equal(result.result.outcome, 'unknown');
  assert.deepEqual(await runAdministrationCommand(q), result);
  assert.equal(readFileSync(effect, 'utf8'), 'one\n');
  if (q.supervisor === 'systemd-fixture') {
    const command = JSON.parse(readFileSync(marker, 'utf8'));
    await until(() => launchWorkerAlive(command) === false);
  }
});

test('an unavailable supervisor refuses before making an execution record and never falls back', async () => {
  const q = fixture();
  q.env.PATH = '/fixture-no-executables';
  assert.equal(administrationSupervisorAvailable(q.env), false);
  await assert.rejects(runAdministrationCommand({...q, supervisor:'systemd'}), /available systemd user manager/);
  assert.equal(readExecution(q.root,q.id),null);
});

test('the lease deadline refuses expired startup or stops the admitted command after worker death', async t => {
  const q = fixture(), marker = join(q.root, 'started');
  q.payload.argv = [process.execPath, '-e', 'require("fs").writeFileSync(' + JSON.stringify(marker) + ',"started");setTimeout(()=>{},60000)'];
  const script = `import{readFileSync}from'node:fs';import{runAdministrationCommand}from${JSON.stringify(new URL('../src/administration-worker.mjs', import.meta.url).href)};const q=JSON.parse(readFileSync(0,'utf8'));await runAdministrationCommand({...q,admit:async r=>({authorized:true,receipt:{operation:r.operation,payloadHash:r.payloadHash,worker:r.worker,serverAt:100,until:3100,remainingMs:3000}})});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, HOME: q.root }, stdio: ['pipe', 'ignore', 'ignore'] });
  let ended = false;
  const closed = new Promise(resolve => child.once('close', code => { ended = true; resolve(code); }));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const r = readExecution(q.root, q.id);
    if (r?.supervisor) signalAdministrationUnit(q.env, r, 'SIGKILL');
    else if (r?.child && launchWorkerAlive(r.child) === true) { try { process.kill(-r.child.pid, 'SIGKILL'); } catch {} }
  });
  child.stdin.end(JSON.stringify({ root: q.root, id: q.id, execution: q.execution, payload: q.payload, env: q.env, supervisor: q.supervisor }));
  await until(() => existsSync(marker) || ended);
  if (!existsSync(marker)) {
    const result = observeAdministrationExecution(q);
    assert.equal(result.result.outcome, 'not-started');
    assert.match(result.result.stderr, /ended|expired/i);
    t.diagnostic('Startup lease expired: safe refusal verified; running-expiry boundary not exercised in this run.');
    return;
  }
  child.kill('SIGKILL'); await closed;
  await until(() => readExecution(q.root, q.id).phase === 'finished');
  const result = observeAdministrationExecution(q);
  assert.equal(result.result.outcome, 'exited');
  assert.equal(result.result.signal, 'SIGTERM');
  await until(() => launchWorkerAlive(readExecution(q.root, q.id).child) === false);
  assert.deepEqual(await runAdministrationCommand(q), result);
  t.diagnostic('Actual running command lease expiry verified after worker SIGKILL.');
});
