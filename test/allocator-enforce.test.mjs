// Worker capacity admission, slice 3 (t-2037): with the owner's switch on, a new worker job starts only on an account
// that leaves conversations their reserve until its reset, else it waits (queued, never failed, no alert); off, nothing
// changes; a live conversation is never held back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { staticAccounts } from '../src/accounts.mjs';
import { setAllocatorMode } from '../src/allocator.mjs';
import { loadConv, tick } from '../src/delivery.mjs';
import { setModels } from '../src/models.mjs';
import { spawnCall } from '../src/spawn.mjs';
import { update } from '../src/state.mjs';
import { cvOf, fakeRunner, world } from './delivery-world.mjs';

const OPUS = { id: 'opus', harness: 'claude', family: 'anthropic' };
const SOL = { id: 'sol', harness: 'codex', family: 'openai' };
const acct = (name, provider, usage = {}) => ({ name, label: name, provider, harness: provider === 'anthropic' ? 'claude' : 'codex', kind: 'login', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage });

function setup({ enforce, claude, codex }) {
  const w = world();
  setModels(w.env, { list: [OPUS, SOL], agent: 'art', prefer: ['opus'] });
  const cx = fakeRunner(w.log, join(w.env.HOME, 'cx'), 'codex');
  const S = Math.floor(w.clock.now().getTime() / 1000);
  const max = acct('max', 'anthropic', { '7d': claude, reset_7d: S + 3 * 86400, checked: S });
  const pro = acct('pro', 'openai', { '7d': codex, reset_7d: S + 3600, checked: S });
  w.o.runner = (h) => (h === 'codex' ? cx : w.runner);
  w.o.accounts = staticAccounts({ accounts: [max, pro] });
  const alerts = [];
  w.o.alert = (env, a) => { alerts.push(a); return true; };
  if (enforce) update(w.env, (s) => setAllocatorMode(s, { mode: 'enforce' }));
  const spawn = () => spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Do the job' }, w.o);
  const starts = () => w.log.filter((l) => l[0] === 'start');
  return { ...w, max, pro, S, spawn, starts, alerts };
}

test('switch off: a job takes the preferred model with any room, as before', async () => {
  const w = setup({ enforce: false, claude: 0.93, codex: 0.3 });
  const r = await w.spawn();
  assert.match(loadConv(w.env, r.handle).body, /^claude:/);
});

test('switch on: a job that would eat the conversations\' reserve goes to an eligible model with headroom', async () => {
  const w = setup({ enforce: true, claude: 0.93, codex: 0.3 });
  const r = await w.spawn();
  const c = loadConv(w.env, r.handle);
  assert.match(c.body, /^codex:/);
  assert.equal(c.spawn.assignment.model, 'sol', 'pinned where it was admitted');
});

test('switch on, no headroom anywhere: the job waits, queued, with no failure and no alert, and starts once there is room', async () => {
  const w = setup({ enforce: true, claude: 0.93, codex: 0.95 });
  const r = await w.spawn();
  let c = loadConv(w.env, r.handle);
  assert.equal(w.starts().length, 0, 'nothing started');
  assert.equal(c.body, undefined);
  assert.match(c.waiting, /waiting for capacity/);
  assert.ok(c.queue.some((m) => !m.note), 'its brief waits, not failed');
  assert.equal(c.allOut, undefined, 'not out of quota');
  assert.equal(w.alerts.length, 0, 'the owner is not alerted');
  assert.ok(c.retryAt > w.clock.now().getTime());
  // Within 15 minutes it is looked at again; Codex's window reset at the hour, so then it starts there.
  w.clock.advance(14 * 60_000);
  await tick(w.env, w.o);
  assert.equal(w.starts().length, 0, 'still waits before its time');
  w.pro.usage = { '7d': 0.1, reset_7d: w.S + 8 * 86400, checked: w.S + 3700 };
  w.clock.advance(2 * 60_000);
  await tick(w.env, w.o);
  c = loadConv(w.env, r.handle);
  assert.match(c.body ?? '', /^codex:/);
});

test('switch on: a live conversation is never held back', async () => {
  const w = setup({ enforce: true, claude: 0.93, codex: 0.95 });
  const { deliver } = await import('../src/delivery.mjs');
  await deliver(w.env, w.msg('d1', 'hi'), w.o);
  assert.match(loadConv(w.env, cvOf('art', 'slack', 'd1')).body ?? '', /^claude:/);
});

test('switch on: an account with no usage reading (an API key) is not held back', async () => {
  const w = setup({ enforce: true, claude: 0.93, codex: 0.95 });
  w.o.accounts = staticAccounts({ accounts: [acct('key', 'anthropic', {})] });
  const r = await w.spawn();
  assert.match(loadConv(w.env, r.handle).body ?? '', /^claude:/);
});

test('switch on: a job that ran before and fails over is never gated (its continuing is the next slice)', async () => {
  const { setRole } = await import('../src/models.mjs');
  const w = setup({ enforce: false, claude: 0.5, codex: 0.95 });
  setRole(w.env, { role: { id: 'coding', description: 'Write code', models: ['opus', 'sol'] } });
  const r = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Do the job', role: 'coding', failover: true }, w.o);
  let c = loadConv(w.env, r.handle);
  assert.equal(c.spawn.assignment.model, 'opus');
  w.runner.finish(c.body);
  update(w.env, (s) => setAllocatorMode(s, { mode: 'enforce' }));
  w.max.usage = { '7d': 0.99, reset_7d: w.S + 3600, checked: w.S };   // opus out of quota: failover to sol
  await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', action: 'say', handle: r.handle, text: 'continue' }, w.o);
  c = loadConv(w.env, r.handle);
  assert.match(c.body ?? '', /^codex:/, 'moved at once, though Codex is inside its reserve');
});

test('slice 4, switch on: a pinned job continuing waits when its account is kept for conversations, its session kept', async () => {
  const w = setup({ enforce: false, claude: 0.5, codex: 0.3 });
  const r = await w.spawn();
  let c = loadConv(w.env, r.handle);
  assert.equal(c.spawn.assignment.model, 'opus');
  w.runner.finish(c.body);
  update(w.env, (s) => setAllocatorMode(s, { mode: 'enforce' }));
  w.max.usage = { '7d': 0.93, reset_7d: w.S + 3 * 86400, checked: w.S };
  const before = w.log.filter((l) => l[0] === 'start' || l[0] === 'resume').length;
  await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', action: 'say', handle: r.handle, text: 'continue' }, w.o);
  c = loadConv(w.env, r.handle);
  assert.equal(w.log.filter((l) => l[0] === 'start' || l[0] === 'resume').length, before, 'no body: not moved, not resumed');
  assert.match(c.waiting, /waiting for capacity/);
  assert.ok(c.slot, 'its session stays');
  assert.ok(Date.parse(c.slot.until) >= w.clock.now().getTime() + 3 * 86400_000 - 1000, 'kept as long as it waits (a job\'s 3 days, from now)');
  assert.equal(c.spawn.assignment.model, 'opus', 'never moved without a failover');
  // Room comes back (the reading falls after a reset): it resumes its own session.
  w.max.usage = { '7d': 0.1, reset_7d: w.S + 7 * 86400, checked: w.S + 60 };
  w.clock.advance(16 * 60_000);
  await tick(w.env, w.o);
  assert.equal(w.log.filter((l) => l[0] === 'start' || l[0] === 'resume').at(-1)[0], 'resume');
});

test('slice 4, switch on: with a failover allowed, a pinned job kept from its account moves once to a model with headroom', async () => {
  const { setRole } = await import('../src/models.mjs');
  const w = setup({ enforce: false, claude: 0.5, codex: 0.3 });
  setRole(w.env, { role: { id: 'coding', description: 'Write code', models: ['opus', 'sol'] } });
  const r = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Do the job', role: 'coding', failover: true }, w.o);
  let c = loadConv(w.env, r.handle);
  w.runner.finish(c.body);
  update(w.env, (s) => setAllocatorMode(s, { mode: 'enforce' }));
  w.max.usage = { '7d': 0.93, reset_7d: w.S + 3 * 86400, checked: w.S };
  await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', action: 'say', handle: r.handle, text: 'continue' }, w.o);
  c = loadConv(w.env, r.handle);
  assert.match(c.body ?? '', /^codex:/);
  assert.equal(c.spawn.lineage.at(-1).why, 'kept for conversations; failover allowed');
});

test('slice 4: a capacity failover starts gated, never on a model whose account is the one being protected', async () => {
  const { setRole } = await import('../src/models.mjs');
  const w = setup({ enforce: false, claude: 0.5, codex: 0.3 });
  const SOL1 = { id: 'sol', harness: 'codex', family: 'openai', window: '7d_sol' };
  const SOL2 = { id: 'sol-mini', harness: 'codex', family: 'openai' };
  setModels(w.env, { list: [OPUS, SOL1, SOL2], agent: 'art', prefer: ['opus'] });
  setRole(w.env, { role: { id: 'coding', description: 'Write code', models: ['opus', 'sol', 'sol-mini'] } });
  const r = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Do the job', role: 'coding', failover: true }, w.o);
  let c = loadConv(w.env, r.handle);
  assert.equal(c.spawn.assignment.model, 'opus');
  w.runner.finish(c.body);
  update(w.env, (s) => setAllocatorMode(s, { mode: 'enforce' }));
  w.max.usage = { '7d': 0.93, reset_7d: w.S + 3 * 86400, checked: w.S };
  // sol's own window has room under the quota line but not past the reserve; sol-mini has headroom.
  w.pro.usage = { '7d': 0.3, '7d_sol': 0.95, reset_7d_sol: w.S + 3 * 86400, reset_7d: w.S + 3 * 86400, checked: w.S };
  await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', action: 'say', handle: r.handle, text: 'continue' }, w.o);
  c = loadConv(w.env, r.handle);
  assert.equal(c.spawn.assignment.model, 'sol-mini');
});
