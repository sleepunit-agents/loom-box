// No administrative command or real approval is executed by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestAdministration, administrationApproval, advanceAdministration, administrationStatus, queueAdministration, endAdministration, administrationApprovals, ADMINISTRATION_KIND } from '../src/administration.mjs';
import { deliver, loadConv, saveConv } from '../src/delivery.mjs';
import { load, update } from '../src/state.mjs';
import { world } from './delivery-world.mjs';
import { verify } from '../src/principal.mjs';
import { deliveryDir } from '../src/delivery.mjs';

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
