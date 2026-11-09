// No administrative command or real approval is executed by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestAdministration, administrationApproval, advanceAdministration, administrationStatus, queueAdministration, endAdministration, listAdministration, administrationWork, claimAdministration, admitAdministration, completeAdministrationCommand, administrationResult, administrationApprovals, ADMINISTRATION_KIND } from '../src/administration.mjs';
import { deliver, loadConv, saveConv, tick } from '../src/delivery.mjs';
import { load, update } from '../src/state.mjs';
import { world } from './delivery-world.mjs';
import { verify } from '../src/principal.mjs';
import { deliveryDir } from '../src/delivery.mjs';
import { page, act } from '../src/ui.mjs';
import { createServer } from 'node:http';
import { api } from '../src/control.mjs';
import { remoteClient } from '../src/box.mjs';

async function setup(from = { kind: 'person', slug: 'owner' }) {
  const w = world(), caller = { kind: 'agent', agent: 'art' };
  const { conversation } = await deliver(w.env, w.msg('dm:administration', 'Harmless administrative fixture', { from }), w.o);
  update(w.env, s => { s.agents.art = {}; s.boxes.one.administration = { v: 1, host: 'fixture-machine', identities: { runner: { uid: 1000, gid: 1000 }, root: { uid: 0, gid: 0 } } }; });
  const proof = () => { const c = loadConv(w.env, conversation), raw = c.body.split(':')[1]; return { conversation, key: w.runner.envs[raw].LOOM_BODY_KEY, session: w.sessionFor(conversation) }; };
  const q = () => ({ ...proof(), requestKey: 'request-one', box: 'one', identity: 'runner', cwd: '/tmp', work: 'Repair the isolated fixture', why: 'Exercise scope admission', minutes: 60 });
  const request = (extra = {}) => requestAdministration(w.env, caller, { ...q(), ...extra }, w.o);
  const journal = () => JSON.parse(readFileSync(join(w.env.LOOM_BOX_DATA, 'administration/journal.json'), 'utf8'));
  const scope = request();
  let state = 'allowed', uses = 0, lose = false, expires = new Date(w.clock.now().getTime() + 120 * 60_000).toISOString();
  const card = () => { const s = journal().scopes[scope.id]; return { id: s.approval, agent: s.agent, for: s.authority.principal.owner ? 'owner' : s.authority.principal.for ?? '?', kind: ADMINISTRATION_KIND, target: s.target, state, decidedBy: ['allowed', 'used'].includes(state) ? 'owner' : null, expires: state === 'allowed' ? expires : null }; };
  const approvals = {
    async check() { return card(); },
    async use() { assert.equal(state, 'allowed'); state = 'used'; uses++; if (lose) throw Error('lost approval-use reply'); },
  };
  const bind = () => administrationApproval(w.env, scope.id, 'a-12345678', w.o);
  const activate = async () => { bind(); return advanceAdministration(w.env, scope.id, approvals, w.o); };
  const command = (extra = {}) => ({ ...proof(), scope: scope.id, requestKey: 'command-one', intent: 'Inspect the fixture', argv: ['/usr/bin/printf', 'private-command-input'], stdin: 'private-stdin-input', ...extra });
  const queue = (extra = {}) => queueAdministration(w.env, caller, command(extra), w.o);
  return { ...w, caller, conversation, scope, proof, request, journal, approvals, bind, activate, command, queue, card,
    state: value => { state = value; }, lose: value => { lose = value; }, expiry: value => { expires = value; }, uses: () => uses };
}

test('administration requires actual native conversation proof and reports its exact OS identity', async () => {
  const w = await setup();
  assert.deepEqual(w.scope.execution, { host: 'fixture-machine', owner: 'owner', uid: 1000, gid: 1000 });
  assert.equal(w.scope.principal.owner, true);
  for (const caller of [{ kind: 'owner' }, { kind: 'agent', agent: 'mark' }, { ...w.caller, service: 'bridge' }]) {
    assert.throws(() => requestAdministration(w.env, caller, { ...w.proof(), requestKey: 'forged' }, w.o), /current native body/);
  }
  for (const proof of [{ key: 'incorrect' }, { session: 'another-session' }, { conversation: 'cv-ffffffffffff' }]) assert.throws(() => w.request(proof), /current native body/);
  assert.throws(() => w.request({ requestKey: 'root-change', identity: 'root', minutes: 481 }), /1–480/);
  update(w.env, s => { delete s.boxes.one.administration.identities.root; });
  assert.throws(() => w.request({ requestKey: 'root-change', identity: 'root' }), /does not support/);
  update(w.env, s => { s.boxes.one.mayHost = []; });
  assert.throws(() => w.request({ requestKey: 'ineligible' }), /eligible box/);
});

test('administration scopes and approvals are immutable across retries', async () => {
  const w = await setup();
  assert.deepEqual(w.request(), w.scope);
  for (const extra of [{ identity: 'root' }, { work: 'Different work' }, { cwd: '/etc' }, { minutes: 30 }]) assert.throws(() => w.request(extra), /another scope/);
  w.bind(); w.bind();
  assert.throws(() => administrationApproval(w.env, w.scope.id, 'a-aaaaaaaa', w.o), /another approval/);
  assert.equal(Object.keys(w.journal().scopes).length, 1);
  assert.equal(statSync(join(w.env.LOOM_BOX_DATA, 'administration/journal.json')).mode & 0o777, 0o600);
});

test('lost approval consumption recovers the same fixed lease in an independent controller', async () => {
  const w = await setup(); w.bind(); w.lose(true);
  assert.throws(() => w.queue(), /not active/);
  await assert.rejects(advanceAdministration(w.env, w.scope.id, w.approvals, w.o), /lost approval-use reply/);
  const before = w.journal().scopes[w.scope.id];
  assert.equal(before.state, 'activating'); assert.equal(w.uses(), 1);
  assert.equal(before.activation.until, w.clock.now().getTime() + 60 * 60_000);
  w.clock.advance(10_000);
  const script = `import{readFileSync}from'node:fs';import{advanceAdministration}from${JSON.stringify(new URL('../src/administration.mjs', import.meta.url).href)};const q=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify(await advanceAdministration(q.env,q.id,{check:async()=>q.card,use:async()=>{throw Error('must not consume twice')}},{now:()=>new Date(q.now)})));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input: JSON.stringify({ env: w.env, id: w.scope.id, card: w.card(), now: w.clock.now().getTime() }), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).state, 'active');
  assert.equal(w.journal().scopes[w.scope.id].activation.until, before.activation.until);
  assert.equal(w.uses(), 1); assert.equal(w.queue().state, 'queued');
});

test('a used approval with no recorded expiry intent never invents a lease', async () => {
  const w = await setup(); w.bind(); w.state('used');
  assert.equal((await advanceAdministration(w.env, w.scope.id, w.approvals, w.o)).state, 'approval-unresolved');
  assert.equal(w.journal().scopes[w.scope.id].activation, undefined);
  assert.throws(() => w.queue(), /not active/); assert.equal(w.uses(), 0);
});

test('denial, mismatched approval and expiry during consumption cannot activate administrative work', async () => {
  const denied = await setup(); denied.bind(); denied.state('denied');
  assert.equal((await advanceAdministration(denied.env, denied.scope.id, denied.approvals, denied.o)).state, 'denied');
  const mismatch = await setup(); mismatch.bind();
  await assert.rejects(advanceAdministration(mismatch.env, mismatch.scope.id, { check: async () => ({ ...mismatch.card(), target: 'another-target' }) }, mismatch.o), /does not match/);
  assert.equal(mismatch.uses(), 0);
  const expired = await setup(); expired.bind(); expired.expiry(new Date(expired.clock.now().getTime() + 1000).toISOString());
  expired.approvals.use = async () => { expired.state('used'); expired.clock.advance(1001); };
  assert.equal((await advanceAdministration(expired.env, expired.scope.id, expired.approvals, expired.o)).state, 'expired');
  assert.throws(() => expired.queue(), /not active/);
});

test('command input stays sealed and an idempotency key cannot change its payload', async () => {
  const w = await setup(); await w.activate();
  const result = w.queue(); assert.deepEqual(w.queue(), result);
  assert.throws(() => w.queue({ argv: ['different-command'] }), /another payload/);
  assert.throws(() => w.queue({ identity: 'root' }), /cannot change/);
  assert.throws(() => w.queue({ stdin: 'x'.repeat(128 * 1024) }), /too large/);
  const raw = readFileSync(join(w.env.LOOM_BOX_DATA, 'administration/journal.json'), 'utf8');
  assert.doesNotMatch(raw, /private-command-input|private-stdin-input/);
  const stored = w.journal().operations[result.id];
  assert.equal(JSON.parse(w.o.sealer.open(Buffer.from(stored.sealed, 'base64')).toString()).stdin, 'private-stdin-input');
  const view = administrationStatus(w.env, w.caller, { ...w.proof(), scope: w.scope.id }, w.o);
  assert.equal(view.operations.length, 1); assert.equal(view.operations[0].sealed, undefined);
  endAdministration(w.env, w.caller, { ...w.proof(), scope: w.scope.id }, w.o);
  assert.equal(w.queue().state, 'cancelled', 'a lost queue reply still retrieves its existing cancelled operation');
  assert.throws(() => w.queue({ requestKey: 'new-command' }), /not active/);
});

test('changed steering, reset, box ownership and OS identity block further commands', async () => {
  for (const change of ['principal', 'reset', 'owner', 'identity', 'host']) {
    const w = await setup(); await w.activate(); w.queue();
    if (change === 'principal' || change === 'reset') {
      const c = loadConv(w.env, w.conversation);
      if (change === 'principal') c.actsFor = { owner: false, people: ['loren'], unknown: false };
      else c.actsFor.reset = 'new reset';
      saveConv(w.env, c);
    } else update(w.env, s => {
      if (change === 'owner') s.boxes.one.mayHost = [];
      if (change === 'identity') s.boxes.one.administration.identities.runner.uid = 2000;
      if (change === 'host') s.boxes.one.administration.host = 'another-machine';
    });
    assert.equal((await advanceAdministration(w.env, w.scope.id, w.approvals, w.o)).state, 'revoked', change);
    assert.throws(() => w.queue({ requestKey: 'new-command' }));
    assert.equal(Object.values(w.journal().operations)[0].state, 'cancelled');
  }
});

test('a same-principal native continuation can use its lease only with the new run proof', async () => {
  const w = await setup(); await w.activate(); const old = w.proof();
  w.runner.finish(loadConv(w.env, w.conversation).body, { worked: true, failed: false });
  await deliver(w.env, w.msg('dm:administration', 'Continue the same fixture', { from: { kind: 'person', slug: 'owner' } }), w.o);
  assert.notEqual(w.proof().key, old.key);
  assert.throws(() => queueAdministration(w.env, w.caller, { ...w.command(), key: old.key }, w.o), /current native body/);
  assert.equal(w.queue().state, 'queued');
});

test('clock rollback cannot extend a lease or admit a new command', async () => {
  const w = await setup(); await w.activate(); const until = w.journal().scopes[w.scope.id].activation.until;
  w.clock.advance(-1); assert.throws(() => w.queue(), /clock moved backwards/);
  w.clock.advance(60 * 60_000 + 2);
  assert.equal((await advanceAdministration(w.env, w.scope.id, w.approvals, w.o)).state, 'expired');
  assert.equal(w.journal().scopes[w.scope.id].activation.until, until);
  assert.throws(() => w.queue(), /not active/);
});

test('concurrent activation converges on one consumption and one original cutoff', async () => {
  const w = await setup(); w.bind();
  const results = await Promise.allSettled([advanceAdministration(w.env, w.scope.id, w.approvals, w.o), advanceAdministration(w.env, w.scope.id, w.approvals, w.o)]);
  assert.ok(results.some(r => r.status === 'fulfilled' && r.value.state === 'active'));
  assert.equal(w.uses(), 1);
  const until = w.journal().scopes[w.scope.id].activation.until;
  w.clock.advance(1000);
  assert.equal((await advanceAdministration(w.env, w.scope.id, w.approvals, w.o)).until, until);
  assert.equal(w.uses(), 1);
});

test('a lease cannot outlive an earlier approval expiry or sealing across its cutoff', async () => {
  const w = await setup(); const until = w.clock.now().getTime() + 1000;
  w.expiry(new Date(until).toISOString()); assert.equal((await w.activate()).until, until);
  const sealer = { seal(text) { w.clock.advance(1001); return w.o.sealer.seal(text); } };
  assert.throws(() => queueAdministration(w.env, w.caller, w.command(), { ...w.o, sealer }), /expired while sealing/);
  assert.equal(Object.keys(w.journal().operations).length, 0);
});

test('a named owner of another box cannot read or revoke this scope', async () => {
  const w = await setup(); await w.activate();
  const household = join(w.env.HOME, '.config/loom/household.json');
  mkdirSync(join(w.env.HOME, '.config/loom'), { recursive: true });
  writeFileSync(household, JSON.stringify({ members: [{ person: 'owner', agents: '*' }, { person: 'another-owner', agents: ['art'] }] }));
  const wrong = { kind: 'owner', who: 'another-owner', agents: ['art'] };
  assert.throws(() => administrationStatus(w.env, wrong, { scope: w.scope.id }, w.o), /only this box’s owner/);
  assert.throws(() => endAdministration(w.env, wrong, { scope: w.scope.id }, w.o), /only this box’s owner/);
  assert.equal(w.journal().scopes[w.scope.id].state, 'active');
  const owner = { kind: 'owner', who: 'owner' };
  assert.equal(endAdministration(w.env, owner, { scope: w.scope.id }, w.o).state, 'revoked');
});

test('an unreadable or malformed expiry journal never grants command access', async () => {
  const w = await setup(); await w.activate();
  const path = join(w.env.LOOM_BOX_DATA, 'administration/journal.json');
  chmodSync(path, 0o644); assert.throws(() => w.queue(), /bounded private file/); chmodSync(path, 0o600);
  const j = w.journal(); j.scopes[w.scope.id].activation.until = 'unbounded'; writeFileSync(path, JSON.stringify(j), { mode: 0o600 });
  assert.throws(() => w.queue(), /cannot be decoded/);
});

test('owner revocation during approval consumption cannot be undone by its late receipt', async () => {
  const w = await setup(); w.bind();
  w.approvals.use = async () => {
    w.state('used'); endAdministration(w.env, { kind: 'owner' }, { scope: w.scope.id }, w.o);
  };
  assert.equal((await advanceAdministration(w.env, w.scope.id, w.approvals, w.o)).state, 'revoked');
  assert.throws(() => w.queue(), /not active/);
});

test('only the named box owner can grant its administrative lease', async () => {
  const w = await setup(); w.bind();
  for (const decidedBy of [undefined, 'another-owner']) {
    await assert.rejects(advanceAdministration(w.env, w.scope.id, { check: async () => ({ ...w.card(), decidedBy }) }, w.o), /does not match/);
  }
  assert.equal(w.journal().scopes[w.scope.id].activation, undefined);
  assert.equal(w.uses(), 0);
});

test('status reports expiry and cancels queued work even before the next activation tick', async () => {
  const w = await setup(); await w.activate(); w.queue(); w.clock.advance(60 * 60_000);
  const status = administrationStatus(w.env, { kind: 'owner' }, { scope: w.scope.id }, w.o);
  assert.equal(status.state, 'expired'); assert.equal(status.operations[0].state, 'cancelled');
});

test('production approval adapter mints a fresh current principal and never substitutes owner', async () => {
  const w = await setup({ kind: 'agent', id: 'mark' });
  const c = loadConv(w.env, w.conversation);
  c.actsFor = { owner: false, people: ['dan', 'loren'], unknown: true };
  saveConv(w.env, c);
  const scope = w.request({ requestKey: 'unknown-adapter' });
  administrationApproval(w.env, scope.id, 'a-87654321', w.o);
  const calls = [];
  let used = false;
  const options = { ...w.o, approvalsRun: async argv => {
    calls.push(argv);
    if (argv[0] === 'check') return { status: 0, stdout: JSON.stringify({
      id: 'a-87654321', agent: 'art', for: '?', kind: ADMINISTRATION_KIND,
      target: w.journal().scopes[scope.id].target, state: used ? 'used' : 'allowed',
      decidedBy: 'owner', expires: new Date(w.clock.now().getTime() + 3600_000).toISOString(),
    }) };
    assert.equal(argv[0], 'use');
    assert.equal(argv.includes('--on-behalf'), false);
    const p = verify(deliveryDir(w.env), argv[argv.indexOf('--principal') + 1], w.clock.now().getTime());
    assert.equal(p.ok, true); assert.equal(p.owner, false); assert.equal(p.for, null);
    assert.deepEqual(p.people, ['dan', 'loren']);
    assert.equal(p.conversation, w.conversation); assert.equal(p.agent, 'art');
    used = true; return { status: 0, stdout: 'used' };
  } };
  // Owner waits longer than a signed principal's five minute TTL.
  w.clock.advance(10 * 60_000);
  const result = await advanceAdministration(w.env, scope.id, undefined, options);
  assert.equal(result.state, 'active');
  assert.equal(calls.filter(a => a[0] === 'use').length, 1);
});

test('production approval adapter refuses unavailable or malformed receipts', async () => {
  const w = await setup(); w.bind();
  for (const response of [{ status: 0, stdout: 'not JSON' }, { status: 0, stdout: 'null' },
    { status: 1, stderr: 'backend unavailable' }, { status: null, error: { code: 'ETIMEDOUT' } }]) {
    const options = { ...w.o, approvalsRun: async () => response };
    await assert.rejects(advanceAdministration(w.env, w.scope.id, undefined, options), /administration approval/);
    assert.equal(w.journal().scopes[w.scope.id].state, 'pending');
  }
  let calls = 0;
  const client = administrationApprovals(w.env, { ...w.o, approvalsRun: async () => { calls++; } });
  await assert.rejects(client.use('a-12345678', w.journal().scopes[w.scope.id]), /no longer eligible/);
  assert.equal(calls, 0);
});

test('the normal delivery tick reconciles a lost filing reply and activates without a model turn', async () => {
  const w = await setup();
  let lost = true, used = false, filings = 0, uses = 0;
  const warnings = [], starts = w.log.filter(a => a[0] === 'start').length;
  const options = { ...w.o, warn: message => warnings.push(message), approvalsRun: async args => {
    if (args[0] === 'request') {
      filings++;
      const details = JSON.parse(args[args.indexOf('--details') + 1]);
      assert.equal(details.work, w.scope.work); assert.equal(details.cwd, w.scope.cwd);
      assert.deepEqual(details.execution, w.scope.execution);
      assert.equal(args.includes('--on-behalf'), false);
      if (lost) { lost = false; return { status: null, error: { code: 'ETIMEDOUT' } }; }
      return { status: 0, stdout: 'a-12345678: same immutable card' };
    }
    if (args[0] === 'use') { uses++; used = true; return { status: 0, stdout: 'used' }; }
    const s = w.journal().scopes[w.scope.id];
    return { status: 0, stdout: JSON.stringify({ id: 'a-12345678', agent: s.agent, for: 'owner',
      kind: ADMINISTRATION_KIND, target: s.target, state: used ? 'used' : 'allowed', decidedBy: 'owner',
      expires: new Date(w.clock.now().getTime() + 3600_000).toISOString() }) };
  } };
  await tick(w.env, options);
  assert.equal(w.journal().scopes[w.scope.id].state, 'requested');
  assert.equal(warnings.length, 1);
  await tick(w.env, options);
  assert.equal(w.journal().scopes[w.scope.id].state, 'active');
  assert.equal(filings, 2); assert.equal(uses, 1);
  assert.equal(w.log.filter(a => a[0] === 'start').length, starts);
  assert.equal(w.queue().state, 'queued');
  w.clock.advance(3600_001);
  await tick(w.env, options);
  assert.equal(w.journal().scopes[w.scope.id].state, 'expired');
  assert.equal(Object.values(w.journal().operations)[0].state, 'cancelled');
});

test('requested scopes with changed authority never file and oversized owner cards refuse before save', async () => {
  const w = await setup();
  const before = Object.keys(w.journal().scopes).length;
  assert.throws(() => w.request({ requestKey: 'oversized-card', cwd: '/' + 'a'.repeat(2000) }), /approval card budget/);
  assert.equal(Object.keys(w.journal().scopes).length, before);
  const c = loadConv(w.env, w.conversation); c.actsFor.unknown = true; saveConv(w.env, c);
  let calls = 0;
  await tick(w.env, { ...w.o, approvalsRun: async () => { calls++; throw Error('must not file'); } });
  assert.equal(calls, 0);
  assert.equal(w.journal().scopes[w.scope.id].state, 'revoked');
});

test('the owner box panel shows scoped access without sealed inputs and revokes through the actual page action', async () => {
  const w = await setup(); await w.activate(); const op = w.queue();
  const owner = { kind: 'owner', who: 'owner' }, effects = { now: w.clock.now };
  const view = page(w.env, { path: 'box/one', caller: owner }, w.clock.now().getTime());
  const section = view.sections.find(s => s.id === 'administration');
  assert.ok(section);
  const row = section.blocks.find(b => b.type === 'panel').rows[0];
  assert.equal(row.value, 'Active');
  assert.equal(row.act.action, 'administration-revoke');
  assert.match(row.detail, /UID 1000/);
  const text = JSON.stringify(section);
  assert.equal(text.includes('private-command-input'), false);
  assert.equal(text.includes('private-stdin-input'), false);
  const request = { action: row.act.action, fields: row.act.fields };
  for (const caller of [undefined, { kind: 'agent', agent: 'art' }, { kind: 'owner', who: 'another-member' }]) {
    const result = act(w.env, effects, { ...request, caller });
    assert.equal(result.ok, false);
    assert.equal(w.journal().scopes[w.scope.id].state, 'active');
  }
  const result = act(w.env, effects, { ...request, caller: owner });
  assert.equal(result.ok, true); assert.equal(result.page, 'box/one');
  assert.equal(w.journal().scopes[w.scope.id].state, 'revoked');
  assert.equal(w.journal().operations[op.id].state, 'cancelled');
  const after = page(w.env, { path: result.page, caller: owner }, w.clock.now().getTime());
  const endedRow = after.sections.find(s => s.id === 'administration').blocks.find(b => b.type === 'panel').rows[0];
  assert.equal(endedRow.value, 'Revoked'); assert.equal(endedRow.act, undefined);
});

test('another member cannot inventory private scoped work and offline admitted work stays visibly outstanding', async () => {
  const w = await setup(); await w.activate(); const op = w.queue();
  const owner = { kind: 'owner', who: 'owner' };
  assert.deepEqual(listAdministration(w.env, { kind: 'owner', who: 'another-member' }, 'one', w.o), []);
  assert.deepEqual(listAdministration(w.env, { kind: 'owner' }, 'one', w.o), []);
  assert.deepEqual(listAdministration(w.env, { kind: 'agent', agent: 'art' }, 'one', w.o), []);
  const otherPage = page(w.env, { path: 'box/one', caller: { kind: 'owner', who: 'another-member' } }, w.clock.now().getTime());
  assert.equal(otherPage.sections.some(s => s.id === 'administration'), false);
  // Actual controller admission receipt, without starting a process.
  const q = { operation: op.id, worker: administrativeWorker() };
  const claim = claimAdministration(w.env, boxCaller, q, w.o);
  assert.equal(admitAdministration(w.env, boxCaller, { ...q, ticket: claim.ticket }, w.o).authorized, true);
  const result = act(w.env, { now: w.clock.now }, { caller: owner, action: 'administration-revoke', fields: { scope: w.scope.id } });
  assert.equal(result.ok, true); assert.match(result.message, /stop request/);
  assert.equal(w.journal().operations[op.id].state, 'stop-requested');
  const view = page(w.env, { path: 'box/one', caller: owner }, w.clock.now().getTime());
  const section = view.sections.find(s => s.id === 'administration');
  assert.match(JSON.stringify(section), /outcomes outstanding/);
  assert.match(JSON.stringify(section), /offline/);
});

const administrativeWorker = () => ({ host: 'fixture-machine', pid: 1234, birth: '5678',
  boot: '01234567-89ab-cdef-0123-456789abcdef', uid: 1000, gid: 1000 });
const boxCaller = { kind: 'piece', subject: 'one' };

test('administrative polling is not admission, and retry claims preserve the exact worker and secret ticket', async () => {
  const w = await setup(); await w.activate(); const op = w.queue(), worker = administrativeWorker();
  assert.equal(administrationWork(w.env, boxCaller, w.o)[0].state, 'queued');
  assert.equal(w.journal().operations[op.id].claim, undefined);
  const q = { operation: op.id, worker };
  const first = claimAdministration(w.env, boxCaller, q, w.o);
  assert.equal(first.claimed, true); assert.deepEqual(first.payload.argv, w.command().argv);
  const retry = claimAdministration(w.env, boxCaller, q, w.o);
  assert.equal(retry.ticket, first.ticket);
  assert.equal(JSON.stringify(w.journal()).includes(first.ticket), false);
  assert.throws(() => claimAdministration(w.env, boxCaller, { ...q, worker: { ...worker, birth: '5679' } }, w.o), /another worker/);
  for (const caller of [{ kind: 'agent', agent: 'art' }, { kind: 'owner', who: 'owner' }, { kind: 'piece', subject: 'unregistered' }]) {
    assert.throws(() => administrationWork(w.env, caller, w.o), /enrolled workload box/);
  }
  const receipt = admitAdministration(w.env, boxCaller, { ...q, ticket: first.ticket }, w.o);
  assert.equal(receipt.authorized, true); assert.equal(receipt.first, true);
  w.clock.advance(1000);
  const again = admitAdministration(w.env, boxCaller, { ...q, ticket: first.ticket }, w.o);
  assert.equal(again.first, false); assert.equal(again.receipt.admittedAt, receipt.receipt.admittedAt);
  assert.equal(again.receipt.until, receipt.receipt.until);
  assert.equal(again.receipt.remainingMs, receipt.receipt.remainingMs - 1000);
  assert.equal(claimAdministration(w.env, boxCaller, q, w.o).claimed, false);
});

test('administrative admission rechecks expiry, revocation, principal, and exact physical identity', async () => {
  for (const change of ['expiry', 'revoke', 'principal', 'host']) {
    const w = await setup(); await w.activate(); const op = w.queue(), worker = administrativeWorker();
    const q = { operation: op.id, worker };
    const claimed = claimAdministration(w.env, boxCaller, q, w.o);
    assert.throws(() => admitAdministration(w.env, boxCaller, { ...q, ticket: 'wrong' }, w.o), /durable claim/);
    if (change === 'expiry') w.clock.advance(3600_000);
    if (change === 'revoke') endAdministration(w.env, { kind: 'owner', who: 'owner' }, { scope: w.scope.id }, w.o);
    if (change === 'principal') { const c = loadConv(w.env, w.conversation); c.actsFor.unknown = true; saveConv(w.env, c); }
    if (change === 'host') update(w.env, s => { s.boxes.one.administration.host = 'another-machine'; });
    const result = admitAdministration(w.env, boxCaller, { ...q, ticket: claimed.ticket }, w.o);
    assert.equal(result.authorized, false, change);
    assert.equal(w.journal().operations[op.id].state, 'cancelled');
  }
  const w = await setup(); await w.activate(); const op = w.queue();
  for (const extra of [{ uid: 0 }, { host: 'another-machine' }, { birth: '' }, { pid: 0 }]) {
    assert.throws(() => claimAdministration(w.env, boxCaller, { operation: op.id, worker: { ...administrativeWorker(), ...extra } }, w.o), /OS identity/);
  }
});

test('expiry while decrypting a command prevents the claim from being returned', async () => {
  const w = await setup(); await w.activate(); const op = w.queue();
  let first = true;
  const options = { ...w.o, sealer: { ...w.o.sealer, open(value) {
    const result = w.o.sealer.open(value); if (first) { first = false; w.clock.advance(3600_000); } return result;
  } } };
  const result = claimAdministration(w.env, boxCaller, { operation: op.id, worker: administrativeWorker() }, options);
  assert.equal(result.claimed, false);
  assert.equal(result.payload, undefined); assert.equal(result.ticket, undefined);
  assert.equal(w.journal().operations[op.id].state, 'cancelled');
});

test('independent controllers serialize competing worker claims and never transfer ownership after elapsed time', async () => {
  const w = await setup(); await w.activate(); const op = w.queue();
  const script = `import{readFileSync}from'node:fs';import{claimAdministration}from${JSON.stringify(new URL('../src/administration.mjs',import.meta.url).href)};import{testSealer}from${JSON.stringify(new URL('./delivery-world.mjs',import.meta.url).href)};const q=JSON.parse(readFileSync(0,'utf8'));try{const r=claimAdministration(q.env,q.caller,q.request,{now:()=>new Date(q.at),sealer:testSealer});console.log(JSON.stringify({ok:true,ticket:r.ticket,worker:r.worker}));}catch{console.log(JSON.stringify({ok:false}));}`;
  const claim = worker => new Promise((resolve,reject) => {
    const child = spawn(process.execPath, ['--input-type=module','-e',script], { stdio: ['pipe','pipe','pipe'] });
    let output = ''; child.stdout.on('data',b=>{output+=b;});
    child.on('error',reject); child.on('close',code=>{ try { assert.equal(code,0); resolve(JSON.parse(output)); } catch(e){reject(e);} });
    child.stdin.end(JSON.stringify({env:w.env,caller:boxCaller,request:{operation:op.id,worker},at:w.clock.now().getTime()}));
  });
  const outcomes = await Promise.all([claim(administrativeWorker()),claim({...administrativeWorker(),pid:2345})]);
  assert.equal(outcomes.filter(r=>r.ok).length,1);
  const winner = outcomes.find(r=>r.ok);
  const resumed = await claim(winner.worker);
  assert.equal(resumed.ticket,winner.ticket);
  w.clock.advance(30*60_000);
  assert.throws(()=>claimAdministration(w.env,boxCaller,{operation:op.id,worker:{...winner.worker,pid:3456}},w.o),/another worker/);
  assert.equal(w.journal().operations[op.id].claim.worker.pid,winner.worker.pid);
});

test('broken claim or admission receipts fail closed on reload', async () => {
  for (const damage of ['missing-claim','worker','ticket','future']) {
    const w = await setup(); await w.activate(); const op = w.queue();
    const q = { operation:op.id,worker:administrativeWorker() };
    const claimed = claimAdministration(w.env,boxCaller,q,w.o);
    admitAdministration(w.env,boxCaller,{...q,ticket:claimed.ticket},w.o);
    const j = w.journal(), r = j.operations[op.id];
    if(damage==='missing-claim') delete r.claim;
    if(damage==='worker') r.admission.worker.pid++;
    if(damage==='ticket') r.admission.ticketHash='0'.repeat(64);
    if(damage==='future') r.admission.at=j.highWater+1;
    writeFileSync(join(w.env.LOOM_BOX_DATA,'administration/journal.json'),JSON.stringify(j),{mode:0o600});
    assert.throws(()=>administrationWork(w.env,boxCaller,w.o),/journal cannot be decoded/);
  }
});

test('late sealed results reconcile a lost acknowledgement without changing or replaying the command', async () => {
  const w = await setup(); await w.activate(); const op = w.queue();
  const request = { operation:op.id,worker:administrativeWorker() };
  const claimed = claimAdministration(w.env,boxCaller,request,w.o), q = {...request,ticket:claimed.ticket};
  admitAdministration(w.env,boxCaller,q,w.o);
  endAdministration(w.env,{kind:'owner',who:'owner'},{scope:w.scope.id},w.o);
  const result = {outcome:'exited',exitCode:0,stdout:'private-command-output',stderr:'',truncated:false};
  const first = completeAdministrationCommand(w.env,boxCaller,{...q,result},w.o);
  assert.equal(first.state,'finished');
  assert.equal(JSON.stringify(w.journal()).includes('private-command-output'),false);
  w.clock.advance(1000);
  const script = `import{readFileSync}from'node:fs';import{completeAdministrationCommand}from${JSON.stringify(new URL('../src/administration.mjs',import.meta.url).href)};import{testSealer}from${JSON.stringify(new URL('./delivery-world.mjs',import.meta.url).href)};const q=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify(completeAdministrationCommand(q.env,q.caller,q.request,{now:()=>new Date(q.at),sealer:testSealer})));`;
  const child = spawnSync(process.execPath,['--input-type=module','-e',script],{
    input:JSON.stringify({env:w.env,caller:boxCaller,request:{...q,result},at:w.clock.now().getTime()}),encoding:'utf8',
  });
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),first);
  assert.throws(()=>completeAdministrationCommand(w.env,boxCaller,{...q,result:{...result,stdout:'different'}},w.o),/another result/);
  const read = administrationResult(w.env,w.caller,{...w.proof(),operation:op.id},w.o);
  assert.equal(read.ready,true);assert.equal(read.result.stdout,result.stdout);
  assert.throws(()=>administrationResult(w.env,{kind:'owner',who:'another-member'},{operation:op.id},w.o),/box’s owner/);
  assert.equal(claimAdministration(w.env,boxCaller,request,w.o).claimed,false);
  assert.equal(w.journal().operations[op.id].admission.at,first.result.at);
});

test('results require their exact admitted worker and explicit bounded outcomes', async () => {
  const w = await setup(); await w.activate(); const op = w.queue();
  const request={operation:op.id,worker:administrativeWorker()};
  const claimed=claimAdministration(w.env,boxCaller,request,w.o),q={...request,ticket:claimed.ticket};
  const result={outcome:'exited',exitCode:0,stdout:'ok'};
  assert.throws(()=>completeAdministrationCommand(w.env,boxCaller,{...q,result},w.o),/match its admission/);
  admitAdministration(w.env,boxCaller,q,w.o);
  for(const bad of [{outcome:'exited'},{...result,signal:'SIGTERM'},{...result,stdout:'x'.repeat(256*1024+1)},
    {outcome:'unknown',exitCode:0},{...result,exitCode:-1}]) {
    assert.throws(()=>completeAdministrationCommand(w.env,boxCaller,{...q,result:bad},w.o),/bounded, explicit/);
  }
  assert.throws(()=>completeAdministrationCommand(w.env,boxCaller,{...q,ticket:'wrong',result},w.o),/match its admission/);
  assert.equal(administrationResult(w.env,w.caller,{...w.proof(),operation:op.id},w.o).ready,false);
  const unknown=completeAdministrationCommand(w.env,boxCaller,{...q,result:{outcome:'unknown',stderr:'worker outcome unavailable'}},w.o);
  assert.equal(unknown.state,'unknown');
  assert.equal(administrationWork(w.env,boxCaller,w.o)[0].state,'unknown');
  assert.equal(claimAdministration(w.env,boxCaller,request,w.o).claimed,false);
});

test('authenticated box HTTP transport rejects body/other-box callers and reconciles a lost result reply', async t => {
  const w = await setup(); await w.activate(); const op = w.queue();
  update(w.env, s => { s.boxes.two = { ...s.boxes.one }; });
  const roles = { 'fixture-box-one': boxCaller, 'fixture-box-two': { kind: 'piece', subject: 'two' },
    'fixture-body': { kind: 'agent', agent: 'art' }, 'fixture-owner': { kind: 'owner', who: 'owner' } };
  let loseCompletion = true, committed = 0;
  const server = createServer(async (req, res) => {
    try {
      let text = ''; for await (const b of req) { text += b; if (Buffer.byteLength(text) > 1024 * 1024) throw Error('fixture input budget'); }
      const caller = roles[String(req.headers.authorization ?? '').replace(/^Bearer /, '')];
      const path = new URL(req.url, 'http://fixture').pathname.split('/').at(-1);
      const answer = await api(w.env, w.o, { caller, path, body: JSON.parse(text || '{}') });
      if (path === 'administration-complete' && answer.status === 200) {
        committed++;
        if (loseCompletion) { loseCompletion = false; res.destroy(); return; }
      }
      res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer.body));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const client = credential => remoteClient(url, credential, (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(5000) }));
  const one = client('fixture-box-one'), two = client('fixture-box-two');
  const work = await one.call('administration-work');
  assert.equal(work[0].id, op.id); assert.equal(work[0].state, 'queued');
  assert.equal(JSON.stringify(work).includes('private-command-input'), false);
  for (const token of ['fixture-body', 'fixture-owner', 'unknown']) {
    await assert.rejects(client(token).call('administration-work', { caller: boxCaller }), /40[13]/);
    await assert.rejects(client(token).call('administration-claim', { operation: op.id, worker: administrativeWorker(), caller: boxCaller }), /40[13]/);
  }
  const request = { operation: op.id, worker: administrativeWorker() };
  await assert.rejects(two.call('administration-claim', request), /404/);
  const claim = await one.call('administration-claim', request);
  const q = { ...request, ticket: claim.ticket };
  assert.equal((await one.call('administration-command', q)).operation.state, 'claimed');
  assert.equal(w.journal().operations[op.id].admission, undefined);
  assert.equal((await one.call('administration-admit', q)).authorized, true);
  await assert.rejects(one.call('administration-command', { ...q, ticket: 'wrong' }), /403/);
  endAdministration(w.env, { kind: 'owner', who: 'owner' }, { scope: w.scope.id }, w.o);
  assert.equal((await one.call('administration-command', q)).stop, true);
  const result = { outcome: 'exited', exitCode: 0, stdout: 'private-http-result' };
  await assert.rejects(one.call('administration-complete', { ...q, result }));
  assert.equal(w.journal().operations[op.id].state, 'finished');
  const retry = await one.call('administration-complete', { ...q, result });
  assert.equal(retry.state, 'finished'); assert.equal(committed, 2);
  assert.equal(JSON.stringify(retry).includes('private-http-result'), false);
  assert.equal(JSON.stringify(w.journal()).includes('private-http-result'), false);
  assert.equal(administrationResult(w.env, w.caller, { ...w.proof(), operation: op.id }, w.o).result.stdout, result.stdout);
  assert.equal((await one.call('administration-claim', request)).claimed, false);
});
