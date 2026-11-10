import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { world } from './delivery-world.mjs';
import { api, inProcessBoxClient } from '../src/control.mjs';
import { update, load } from '../src/state.mjs';
import { runner } from '../src/box.mjs';
import { boxAdministration, administrationNamespace, administrationJob } from '../src/administration-box.mjs';
import { administrativeHost } from '../src/administration-worker.mjs';
import { deliver, loadConv } from '../src/delivery.mjs';
import { requestAdministration, administrationApproval, advanceAdministration, queueAdministration, administrationResult } from '../src/administration.mjs';
import { realSupervisor } from './administration-fixture.mjs';

const box = { kind: 'piece', subject: 'one' }, host = 'linux-' + 'a'.repeat(64);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end = Date.now() + 20_000; while (!fn()) { if (Date.now() > end) throw Error('box administration integration boundary not reached'); await delay(25); } }
const options = { loomUrl: 'http://fixture', status: () => null, codexUsage: () => null, sweep: () => [], upgrade: () => null,
  sampleUnits: () => null, bootInfo: () => null, sampleHealth: () => null, log: () => {} };

test('box poll accepts only valid capabilities and clears invalid, unsupported and report-only profiles', () => {
  const w = world(), cap = { v: 1, host, identities: { runner: { uid: 1000, gid: 1000 }, root: { uid: 0, gid: 0 } } };
  const call = body => api(w.env, w.o, { caller: box, path: 'poll', body });
  assert.equal(call({ administration: cap }).status, 200); assert.deepEqual(load(w.env).boxes.one.administration, cap);
  assert.equal(call({ harnesses: {} }).status, 200); assert.deepEqual(load(w.env).boxes.one.administration, cap);
  assert.equal(api(w.env, w.o, { caller: { kind: 'agent', agent: 'art' }, path: 'poll', body: { administration: null } }).status, 403);
  assert.equal(call({ administration: { ...cap, identities: { runner: { uid: 0, gid: 0 } } } }).status, 400);
  assert.equal(load(w.env).boxes.one.administration, undefined);
  call({ administration: cap }); call({ runtime: {} }); assert.equal(load(w.env).boxes.one.administration, undefined);
  call({ administration: cap }); update(w.env, s => { s.boxes.one.reportOnly = true; });
  call({ administration: cap }); assert.equal(load(w.env).boxes.one.administration, undefined);
});

test('the normal box tick reports capability, reconciles without blocking houses and closes the adapter', async () => {
  const w = world(), calls = [], cap = { v: 1, host, identities: { runner: { uid: 1000, gid: 1000 } } };
  const admin = { async capabilities() { calls.push('capabilities'); return cap; }, async tick(value) { calls.push(value); }, close() { calls.push('close'); } };
  let packet;
  const client = { async call(path, body) { if (path === 'poll') { packet = body; return { start: [], stop: [], logins: [], bodyHosts: [], remotes: [], active: [] }; } throw Error('unexpected fixture call'); } };
  const r = runner(w.env, client, { ...options, administration: admin });
  await r.tick(true); assert.deepEqual(packet.administration, cap); assert.equal(calls[0], 'capabilities');
  assert.deepEqual(calls[1], { reportOnly: false }); await r.shutdown(); assert.ok(calls.includes('close'));
  calls.length = 0;
  const report = runner(w.env, client, { ...options, administration: admin, reportOnly: true });
  await report.tick(true); assert.equal(packet.administration, null); assert.equal(calls.includes('capabilities'), false); await report.shutdown();
});

test('fresh report-only and insecure adapters perform no worker probes or dispatches', async () => {
  const w = world(); let jobs = 0;
  const job = () => { jobs++; throw Error('must not launch'); };
  const cfg = { namespace: administrationNamespace(w.env.HOME), base: join(w.env.HOME, 'admin'), job };
  const ro = boxAdministration(w.env, {}, cfg); await ro.tick({ reportOnly: true }); assert.equal(jobs, 0); ro.close();
  const unsafe = boxAdministration(w.env, {}, { ...cfg, secure: false });
  assert.equal(await unsafe.capabilities(), null); await unsafe.tick(); assert.equal(jobs, 0); unsafe.close();
});

test('the private helper uses operation-bound parent RPC without needing an OS manager', async () => {
  const w = world(), id = 'ado-' + 'd'.repeat(32), identity = process.getuid() === 0 ? 'root' : 'runner';
  const calls = [];
  const job = administrationJob({ env: { PATH: process.env.PATH, HOME: w.env.HOME }, namespace: administrationNamespace(w.env.HOME, 'ipc'), identity,
    mode: 'work', id, base: join(w.env.HOME, 'admin'), client: { async call(path, body) { calls.push({ path, body }); return { claimed: false, operation: { id, state: 'cancelled' } }; } } });
  assert.equal((await job.promise).state, 'cancelled');
  assert.equal(calls.length, 1); assert.equal(calls[0].path, 'administration-claim'); assert.equal(calls[0].body.operation, id);
  assert.equal(calls[0].body.worker.uid, process.getuid());
});

for (const root of [false, true]) test('normal box loop ' + (root ? 'root' : 'runner') + ' provisioning recovers a lost upload across daemon restart', async t => {
  const w = world(), env = { ...w.env, PATH: process.env.PATH, LOOM_FIXTURE_BOX_SECRET: 'private-fixture-token' };
  const namespace = administrationNamespace(w.env.HOME, root ? 'root' : 'runner'), base = join(w.env.HOME, 'admin');
  const local = inProcessBoxClient(w.env, w.o, box);
  let lost = false, uploads = 0;
  const client = { async call(path, body, opt) {
    const answer = await local.call(path, body, opt);
    if (path === 'administration-complete') uploads++;
    if (!lost && path === 'administration-complete') { lost = true; throw Error('fixture lost committed upload acknowledgement'); }
    return answer;
  } };
  const admin = boxAdministration(env, client, { namespace, base, secure: true });
  const r = runner(env, client, { ...options, administration: admin }); t.after(() => r.shutdown());
  await r.tick(true);
  const identity = root ? 'root' : 'runner', cap = load(w.env).boxes.one.administration;
  // The physical loop runs production administration jobs, which start real units: only in the systemd suite.
  if (!cap?.identities[identity] || !realSupervisor) {
    if (realSupervisor && (root || process.getuid() !== 0)) assert.fail('required real manager provisioning is unavailable');
    t.diagnostic(cap?.identities[identity] ? 'Physical loop runs only in the systemd suite; not exercised for ' + identity + '.'
      : 'Unsupported OS identity refused before approval; physical loop not exercised for ' + identity + '.');
    return;
  }
  assert.equal(cap.host, administrativeHost());
  update(w.env, s => { s.agents.art = {}; });
  const { conversation } = await deliver(w.env, w.msg('dm:box-admin-' + identity, 'Isolated box loop', { from: { kind: 'person', slug: 'owner' } }), w.o);
  const c = loadConv(w.env, conversation), raw = c.body.split(':')[1], caller = { kind: 'agent', agent: 'art' };
  const proof = { conversation, key: w.runner.envs[raw].LOOM_BODY_KEY, session: w.sessionFor(conversation) };
  const scope = requestAdministration(w.env, caller, { ...proof, requestKey: 'box-loop', box: 'one', identity, cwd: w.env.HOME, work: 'Inspect the isolated box loop', why: 'Verify daemon recovery', minutes: 1 }, w.o);
  administrationApproval(w.env, scope.id, 'a-12345678', w.o);
  const journal = () => JSON.parse(readFileSync(join(w.env.LOOM_BOX_DATA, 'administration/journal.json'), 'utf8')); let used = false;
  await advanceAdministration(w.env, scope.id, { check: async () => ({ id: 'a-12345678', agent: 'art', for: 'owner', kind: 'box-administration', target: journal().scopes[scope.id].target,
    state: used ? 'used' : 'allowed', decidedBy: 'owner', expires: new Date(w.clock.now().getTime() + 60000).toISOString() }), use: async () => { used = true; } }, w.o);
  const marker = join(w.env.HOME, 'effect-' + identity);
  const op = queueAdministration(w.env, caller, { ...proof, scope: scope.id, requestKey: 'command', intent: 'Inspect the isolated fixture',
    argv: ['node', '-e', 'require("fs").appendFileSync(' + JSON.stringify(marker) + ',"one\\n");process.stdout.write(process.getuid()+":"+typeof process.env.LOOM_FIXTURE_BOX_SECRET+":"+process.execPath+":"+process.env.APPROVALS_LOCAL_PRINCIPAL)'], stdin: '', timeoutMs: 10000 }, w.o);
  await r.tick(true); await until(() => journal().operations[op.id].state === 'finished' && admin.active.size === 0);
  assert.equal(lost, true); assert.equal(readFileSync(marker, 'utf8'), 'one\n');
  await r.shutdown();
  const replacement = boxAdministration(env, client, { namespace, base, secure: true });
  const second = runner(env, client, { ...options, administration: replacement }); t.after(() => second.shutdown());
  await second.tick(true); await until(() => uploads === 2 && replacement.active.size === 0);
  assert.equal(readFileSync(marker, 'utf8'), 'one\n');
  assert.equal(administrationResult(w.env, caller, { ...proof, operation: op.id }, w.o).result.stdout, cap.identities[identity].uid + ':undefined:' + process.execPath + ':owner');
  t.diagnostic('Actual ' + identity + ' provisioning, async local API, one effect and restart upload recovery verified; namespace=' + namespace);
});
