import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { continuationCall, deliver, deliveryDir, drainContinuations, loadConv, tick } from '../src/delivery.mjs';
import { world } from './delivery-world.mjs';

test('continuation holder boundary refuses borrowed keys, sessions, houses and unknown principals', async () => {
  const w = world();
  const r = await deliver(w.env, w.msg('holder', 'hello'), w.o);
  const c = loadConv(w.env, r.conversation);
  const key = w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY;
  const args = { action: 'issue', conversation: c.conversation, key, session: w.sessionFor(c.conversation) };
  assert.throws(() => continuationCall(w.env, { ...args, key: 'borrowed' }, w.o), /holding/);
  assert.throws(() => continuationCall(w.env, { ...args, session: 'another' }, w.o), /session/);
  assert.throws(() => continuationCall(w.env, args, { ...w.o, caller: { kind: 'agent', agent: 'mark' } }), /own agent/);
  assert.throws(() => continuationCall(w.env, args, { ...w.o, caller: { kind: 'agent', agent: 'art', house: 'foreign' } }), /machine|house/);
  c.actsFor = { owner: true, people: [], unknown: false };
  c.bodyRules = { ...c.bodyRules, seat: `owner.${c.conversation}` };
  writeFileSync(join(deliveryDir(w.env), 'conversations', `${c.conversation}.json`), JSON.stringify(c));
  const grant = continuationCall(w.env, { ...args, principal: { unknown: true }, target: { place: 'forged' } }, w.o);
  assert.match(grant.handle, /^cont-/);
  assert.throws(() => continuationCall(w.env, { ...args, action: 'enqueue', handle: grant.handle, id: 'final', text: 'x' }, w.o), /bound/);
  c.actsFor.unknown = true;
  writeFileSync(join(deliveryDir(w.env), 'conversations', `${c.conversation}.json`), JSON.stringify(c));
  assert.throws(() => continuationCall(w.env, { ...args, principal: { owner: true } }, w.o), /snapshot|moved/);
});

test('only an admitted clock child binds; queued, forged and warm-fed handles grant nothing', async () => {
  const w = world();
  w.env.LOOM_HOME = join(w.env.HOME, 'loom');
  mkdirSync(w.env.LOOM_HOME, { recursive: true });
  writeFileSync(join(w.env.LOOM_HOME, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }] }));
  const source = await deliver(w.env, w.msg('source', 'owner', { source: 'loom', venue: 'loom', from: { kind: 'person', slug: 'jonathan' } }), w.o);
  const argsFor = (conversation) => {
    const c = loadConv(w.env, conversation);
    return { conversation, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(conversation) };
  };
  const grant = continuationCall(w.env, { ...argsFor(source.conversation), action: 'issue' }, w.o);
  const firing = w.msg('wake:w-abcdef', 'follow up', { source: 'clock', venue: 'wake', id: 'w-abcdef', kind: 'wake', from: { kind: 'schedule' }, continuation: { handle: grant.handle, expiresAt: grant.expiresAt, wake: 'w-abcdef' } });
  assert.equal((await deliver(w.env, { ...firing, source: 'test-source' }, w.o)).status, 403);
  assert.equal((await deliver(w.env, { ...firing, continuation: { ...firing.continuation, target: 'forged' } }, w.o)).status, 400);
  // The principal hand-over is separate: the capability never widens it.
  const { handOverWake, tick } = await import('../src/delivery.mjs');
  handOverWake(w.env, { agent: 'art', place: firing.place, id: firing.id, for: 'owner' });
  const queued = await deliver(w.env, firing, { ...w.o, detach: true, spawnWorker: () => {} });
  assert.equal(queued.body, 'queued');
  assert.equal(loadConv(w.env, queued.conversation).continuationAdmissions, undefined);
  await tick(w.env, w.o, queued.conversation);
  const child = loadConv(w.env, queued.conversation);
  assert.equal(child.continuationAdmissions.length, 1);
  const report = { ...argsFor(child.conversation), action: 'enqueue', handle: grant.handle, id: 'final', text: 'done' };
  assert.equal(continuationCall(w.env, report, w.o).state, 'pending');
  assert.equal(continuationCall(w.env, report, w.o).state, 'pending');
  const extra = continuationCall(w.env, { ...argsFor(source.conversation), action: 'issue' }, w.o);
  handOverWake(w.env, { agent: 'art', place: firing.place, id: 'second', for: 'owner' });
  const fed = await deliver(w.env, { ...firing, id: 'second', continuation: { handle: extra.handle, expiresAt: extra.expiresAt, wake: 'w-123456' } }, w.o);
  assert.equal(fed.body, 'fed');
  assert.throws(() => continuationCall(w.env, { ...report, handle: extra.handle }, w.o), /bound/);
  handOverWake(w.env, { agent: 'art', place: 'wake:w-654321', id: 'third', for: 'owner' });
  const other = await deliver(w.env, { ...firing, place: 'wake:w-654321', id: 'third', continuation: { handle: grant.handle, expiresAt: grant.expiresAt, wake: 'w-654321' } }, w.o);
  assert.ok(['queued', 'failed'].includes(other.body));
  assert.equal(loadConv(w.env, other.conversation).body, undefined);
  const changed = loadConv(w.env, child.conversation);
  changed.actsFor.reset = 'reset-after-admission';
  writeFileSync(join(deliveryDir(w.env), 'conversations', `${child.conversation}.json`), JSON.stringify(changed));
  assert.throws(() => continuationCall(w.env, { ...report, id: 'after-reset' }, w.o), /bound/);
});

test('delivery tick drains admitted reports only through core and seals run/on payload', async () => {
  const { handOverWake, tick } = await import('../src/delivery.mjs');
  const w = world();
  w.env.LOOM_HOME = join(w.env.HOME, 'loom');
  mkdirSync(w.env.LOOM_HOME, { recursive: true });
  writeFileSync(join(w.env.LOOM_HOME, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }] }));
  const source = await deliver(w.env, w.msg('drain-source', 'owner', { source: 'loom', venue: 'loom', from: { kind: 'person', slug: 'jonathan' } }), w.o);
  const args = (cv) => { const c = loadConv(w.env, cv); return { conversation: cv, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(cv) }; };
  const grant = continuationCall(w.env, { ...args(source.conversation), action: 'issue' }, w.o);
  const firing = w.msg('wake:w-abcdef', 'follow up', { source: 'clock', venue: 'wake', id: 'w-abcdef', kind: 'wake', from: { kind: 'schedule' }, continuation: { handle: grant.handle, expiresAt: grant.expiresAt, wake: 'w-abcdef' } });
  handOverWake(w.env, { agent: 'art', place: firing.place, id: firing.id, for: 'owner' });
  const child = await deliver(w.env, firing, w.o);
  const q = { ...args(child.conversation), handle: grant.handle, id: 'final' };
  const enqueued = continuationCall(w.env, { ...q, action: 'enqueue', text: 'actual tick report' }, w.o);
  const calls = [];
  const o = { ...w.o, venues: async () => ({ loom: { adapter: 'core', kind: 'live' }, wake: { kind: 'scheduled' } }), core: { ...w.o.core, comms: async (p) => { calls.push(p); return { ok: true, id: '1' }; } } };
  await tick(w.env, o);
  const sent = calls.filter(p => p.ref === enqueued.ref);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { op: 'post', place: loadConv(w.env, source.conversation).place, agent: 'art', ref: enqueued.ref, text: 'actual tick report', run: loadConv(w.env, child.conversation).run, expiresAt: grant.expiresAt });
  assert.equal(continuationCall(w.env, { ...q, action: 'status' }, w.o).state, 'delivered');
  await tick(w.env, o);
  assert.equal(calls.filter(p => p.ref === enqueued.ref).length, 1);
  continuationCall(w.env, { ...q, action: 'enqueue', id: 'non-core', text: 'must stay private' }, w.o);
  await tick(w.env, { ...o, venues: () => { throw new Error('registry offline'); } });
  assert.equal(continuationCall(w.env, { ...q, action: 'status', id: 'non-core' }, w.o).state, 'pending');
  w.clock.advance(3600001);
  await tick(w.env, { ...o, venues: () => ({ loom: { kind: 'live', send: ['must-not-run'] } }) });
  assert.equal(continuationCall(w.env, { ...q, action: 'status', id: 'non-core' }, w.o).state, 'indeterminate');
  assert.equal(calls.filter(p => p.ref?.startsWith('continuation-')).length, 1);
});

test('local clock inspection verifies a signed source statement and refuses bodies and borrowed issuers', async () => {
  const w = world();
  const { bodyPrincipal, inspectClockContinuation } = await import('../src/delivery.mjs');
  const r = await deliver(w.env, w.msg('inspect', 'hello'), w.o);
  const c = loadConv(w.env, r.conversation);
  c.actsFor = { owner: true, people: [], unknown: false };
  c.bodyRules = { ...c.bodyRules, seat: `owner.${c.conversation}` };
  writeFileSync(join(deliveryDir(w.env), 'conversations', `${c.conversation}.json`), JSON.stringify(c));
  const args = { conversation: c.conversation, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(c.conversation) };
  const grant = continuationCall(w.env, { ...args, action: 'issue' }, w.o);
  const statement = bodyPrincipal(w.env, args, w.o).statement;
  const query = { handle: grant.handle, statement, agent: 'art', scheduledAt: grant.expiresAt - 1 };
  assert.throws(() => inspectClockContinuation(w.env, query, w.o), /local clock/);
  const clockEnv = { ...w.env, LOOM_PIECE_NAME: 'clock' }; delete clockEnv.HOUSE_ID;
  assert.deepEqual(inspectClockContinuation(clockEnv, query, w.o), grant);
  assert.throws(() => inspectClockContinuation(clockEnv, { ...query, statement: 'forged' }, w.o), /authenticated/);
  assert.throws(() => inspectClockContinuation(clockEnv, { ...query, agent: 'mark' }, w.o), /authenticated/);
  // t-2137: from the clock's API, the caller's house goes with it; a statement shown to another house's body is no issuer.
  assert.throws(() => inspectClockContinuation(clockEnv, { ...query, house: 'h-elsewhere' }, w.o), /authenticated/);
  assert.throws(() => inspectClockContinuation({ ...clockEnv, HOUSE_ID: 'body' }, query, w.o), /local clock/);
  assert.throws(() => inspectClockContinuation(clockEnv, { ...query, scheduledAt: grant.expiresAt }, w.o), /before its deadline/);
});

for (const change of ['cutoff', 'deadline']) test(`queued continuation rechecks ${change} before the runner starts`, async () => {
  const w = world();
  const { handOverWake, tick } = await import('../src/delivery.mjs');
  const r = await deliver(w.env, w.msg('queued-cutoff', 'hello'), w.o);
  const c = loadConv(w.env, r.conversation);
  c.actsFor = { owner: true, people: [], unknown: false };
  c.bodyRules = { ...c.bodyRules, seat: `owner.${c.conversation}` };
  writeFileSync(join(deliveryDir(w.env), 'conversations', `${c.conversation}.json`), JSON.stringify(c));
  const grant = continuationCall(w.env, { action: 'issue', conversation: c.conversation, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(c.conversation) }, w.o);
  const firing = w.msg('wake:w-abcdef', 'continue', { source: 'clock', venue: 'wake', id: 'w-abcdef', kind: 'wake', from: { kind: 'schedule' }, continuation: { handle: grant.handle, wake: 'w-abcdef', expiresAt: grant.expiresAt + (change === 'deadline' ? 1 : 0) } });
  handOverWake(w.env, { agent: 'art', place: firing.place, id: firing.id, for: 'owner' });
  const queued = await deliver(w.env, firing, { ...w.o, detach: true, spawnWorker: () => {} });
  assert.equal(queued.body, 'queued');
  if (change === 'cutoff') w.clock.advance(w.o.continuationLifetimeMs);
  const starts = w.kinds().filter((x) => x === 'start' || x === 'resume').length;
  await tick(w.env, w.o, queued.conversation);
  assert.equal(w.kinds().filter((x) => x === 'start' || x === 'resume').length, starts);
  assert.equal(loadConv(w.env, queued.conversation).body, undefined);
  assert.equal(loadConv(w.env, queued.conversation).continuationAdmissions, undefined);
});

test('issuance lifetime comes from the runtime policy: 7 days by default, refused when out of range', async () => {
  const w = world();
  const r = await deliver(w.env, w.msg('policy', 'hello'), w.o);
  const c = loadConv(w.env, r.conversation);
  c.actsFor = { owner: true, people: [], unknown: false };
  c.bodyRules = { ...c.bodyRules, seat: `owner.${c.conversation}` };
  writeFileSync(join(deliveryDir(w.env), 'conversations', `${c.conversation}.json`), JSON.stringify(c));
  const args = { action: 'issue', conversation: c.conversation, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(c.conversation) };
  const { continuationLifetimeMs: _, ...o } = w.o;
  const now = w.o.now().getTime();
  const stale = loadConv(w.env, c.conversation); stale.last = '2000-01-01T00:00:00.000Z';
  writeFileSync(join(deliveryDir(w.env), 'conversations', `${c.conversation}.json`), JSON.stringify(stale));
  assert.equal(continuationCall(w.env, args, o).expiresAt, now + 7 * 86400000);
  assert.equal(Date.parse(loadConv(w.env, c.conversation).last), now, 'issuing keeps the record (and its reset) past the deadline');
  w.env.LOOM_RUNTIME_CONTINUATION_DAYS = '2';
  assert.equal(continuationCall(w.env, args, o).expiresAt, now + 2 * 86400000);
  for (const bad of ['0', '14', '31', '1.5', 'week']) {
    w.env.LOOM_RUNTIME_CONTINUATION_DAYS = bad;
    assert.throws(() => continuationCall(w.env, args, o), /policy is not configured/);
  }
});

test("once the runtime's tick has run, its policy is the one used: a body's own environment can't choose its deadline", async () => {
  const w = world();
  const r = await deliver(w.env, w.msg('policy2', 'hello'), w.o);
  const c = loadConv(w.env, r.conversation);
  c.actsFor = { owner: true, people: [], unknown: false };
  c.bodyRules = { ...c.bodyRules, seat: `owner.${c.conversation}` };
  writeFileSync(join(deliveryDir(w.env), 'conversations', `${c.conversation}.json`), JSON.stringify(c));
  const args = { action: 'issue', conversation: c.conversation, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(c.conversation) };
  const { continuationLifetimeMs: _, ...o } = w.o;
  const now = w.o.now().getTime();
  await drainContinuations({ ...w.env, LOOM_RUNTIME_CONTINUATION_DAYS: '3' }, { ...o, service: true }); // the service's settings
  await drainContinuations({ ...w.env, LOOM_RUNTIME_CONTINUATION_DAYS: '30' }, o); // a body's own tick writes nothing
  assert.equal(continuationCall({ ...w.env, LOOM_RUNTIME_CONTINUATION_DAYS: '30' }, args, o).expiresAt, now + 3 * 86400000);
  await drainContinuations({ ...w.env, LOOM_RUNTIME_CONTINUATION_DAYS: 'week' }, { ...o, service: true }); // misconfigured service: fails closed
  assert.throws(() => continuationCall({ ...w.env, LOOM_RUNTIME_CONTINUATION_DAYS: '7' }, args, o), /policy is not configured/);
});

test("a broken continuation outbox never stops the rest of the tick", async () => {
  const w = world();
  const r = await deliver(w.env, w.msg('outbox-broken', 'hello'), w.o);
  const { rmSync } = await import('node:fs');
  rmSync(join(deliveryDir(w.env), 'continuations'), { recursive: true, force: true });
  writeFileSync(join(deliveryDir(w.env), 'continuations'), 'a file where the outbox should be');
  const said = [];
  await tick(w.env, { ...w.o, warn: (m) => said.push(m) });
  assert.ok(said.some((m) => m.startsWith('continuations:')), said.join('\n'));
  assert.ok(loadConv(w.env, r.conversation));
});

// t-2004 live proof: a reused `claude --bg` spare keeps the environment of the body it was first started for, so a
// body can hold its sibling conversation's LOOM_BODY_CONVERSATION and LOOM_BODY_KEY while running in its own session.
// Neither that key nor the env-claimed conversation is proof: the grant needs the holder's own session too.
test("a sibling conversation's key with this body's own session issues nothing for the sibling", async () => {
  const w = world();
  const a = loadConv(w.env, (await deliver(w.env, w.msg('sibling-a', 'hello'), w.o)).conversation);
  const b = loadConv(w.env, (await deliver(w.env, w.msg('sibling-b', 'hello'), w.o)).conversation);
  assert.notEqual(a.conversation, b.conversation);
  const keyOf = (c) => w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY;
  const ownSession = w.sessionFor(b.conversation);
  assert.ok(ownSession && ownSession !== w.sessionFor(a.conversation));
  for (const action of ['issue', 'status', 'enqueue']) {
    assert.throws(() => continuationCall(w.env, { action, conversation: a.conversation, key: keyOf(a), session: ownSession, handle: 'cont-' + '0'.repeat(64), id: 'final', text: 'x' }, { ...w.o, caller: { kind: 'agent', agent: 'art' } }),
      /only the body holding .*another session is/);
  }
  // Its own conversation, proven with its own key and session, is the one it gets.
  b.actsFor = { owner: true, people: [], unknown: false };
  b.bodyRules = { ...b.bodyRules, seat: `owner.${b.conversation}` };
  writeFileSync(join(deliveryDir(w.env), 'conversations', `${b.conversation}.json`), JSON.stringify(b));
  const grant = continuationCall(w.env, { action: 'issue', conversation: b.conversation, key: keyOf(b), session: ownSession }, w.o);
  assert.match(grant.handle, /^cont-/);
});

test("a spawn's continuation report lands in the spawn's own Comms thread through core (t-2004)", async () => {
  const { handOverWake, tick } = await import('../src/delivery.mjs');
  const w = world();
  w.env.LOOM_HOME = join(w.env.HOME, 'loom');
  mkdirSync(w.env.LOOM_HOME, { recursive: true });
  writeFileSync(join(w.env.LOOM_HOME, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }] }));
  const source = await deliver(w.env, w.msg('spawn-source', 'owner', { source: 'loom', venue: 'loom', from: { kind: 'person', slug: 'jonathan' } }), w.o);
  // The source as a spawn's conversation: venue spawn, its place the spawn's id, its Comms thread not opened yet.
  const write = (c) => writeFileSync(join(deliveryDir(w.env), 'conversations', `${c.conversation}.json`), JSON.stringify(c));
  const s0 = loadConv(w.env, source.conversation);
  write({ ...s0, venue: 'spawn', place: 'sp-0123456789abcdef01234567', spawn: { depth: 1, principal: { owner: true } } });
  const args = (cv) => { const c = loadConv(w.env, cv); return { conversation: cv, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(cv) }; };
  const grant = continuationCall(w.env, { ...args(source.conversation), action: 'issue' }, w.o);
  const firing = w.msg('wake:w-abcdef', 'follow up', { source: 'clock', venue: 'wake', id: 'w-abcdef', kind: 'wake', from: { kind: 'schedule' }, continuation: { handle: grant.handle, expiresAt: grant.expiresAt, wake: 'w-abcdef' } });
  handOverWake(w.env, { agent: 'art', place: firing.place, id: firing.id, for: 'owner' });
  const child = await deliver(w.env, firing, w.o);
  const q = { ...args(child.conversation), handle: grant.handle, id: 'final' };
  const enqueued = continuationCall(w.env, { ...q, action: 'enqueue', text: 'spawn follow-up report' }, w.o);
  const calls = [];
  // No `spawn` venue in the registry, as live: only core carries it.
  const o = { ...w.o, venues: async () => ({ loom: { adapter: 'core', kind: 'live' }, wake: { kind: 'scheduled' } }), core: { ...w.o.core, comms: async (p) => { calls.push(p); return { ok: true, id: '7' }; } } };
  // Thread not open yet: nothing posted, the row still waits (not refused).
  await tick(w.env, o);
  assert.equal(calls.filter((p) => p.ref === enqueued.ref).length, 0);
  assert.deepEqual([continuationCall(w.env, { ...q, action: 'status' }, w.o).state, continuationCall(w.env, { ...q, action: 'status' }, w.o).attempts], ['pending', 0], 'a wait is not an attempt');
  const s1 = loadConv(w.env, source.conversation);
  write({ ...s1, spawn: { ...s1.spawn, thread: 'th:abcdefghij' } });
  w.clock.advance(3600001);
  await tick(w.env, o);
  const sent = calls.filter((p) => p.ref === enqueued.ref);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { op: 'post', place: 'th:abcdefghij', agent: 'art', ref: enqueued.ref, text: 'spawn follow-up report', run: loadConv(w.env, child.conversation).run, expiresAt: grant.expiresAt });
  assert.equal(continuationCall(w.env, { ...q, action: 'status' }, w.o).state, 'delivered');
  // A registry venue named spawn with its own send never runs it: still only core, or nothing.
  continuationCall(w.env, { ...q, action: 'enqueue', id: 'other', text: 'second' }, w.o);
  w.clock.advance(3600001);
  await tick(w.env, { ...o, venues: async () => ({ spawn: { kind: 'live', send: ['must-not-run'] } }) });
  assert.equal(continuationCall(w.env, { ...q, action: 'status', id: 'other' }, w.o).state, 'indeterminate');
  assert.equal(calls.filter((p) => p.ref?.startsWith('continuation-')).length, 1);
});

test("a spawn's report whose thread never opens expires as never attempted (t-2004)", async () => {
  const { handOverWake, tick } = await import('../src/delivery.mjs');
  const w = world();
  w.env.LOOM_HOME = join(w.env.HOME, 'loom');
  mkdirSync(w.env.LOOM_HOME, { recursive: true });
  writeFileSync(join(w.env.LOOM_HOME, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }] }));
  const source = await deliver(w.env, w.msg('spawn-never', 'owner', { source: 'loom', venue: 'loom', from: { kind: 'person', slug: 'jonathan' } }), w.o);
  const write = (c) => writeFileSync(join(deliveryDir(w.env), 'conversations', `${c.conversation}.json`), JSON.stringify(c));
  write({ ...loadConv(w.env, source.conversation), venue: 'spawn', place: 'sp-89abcdef0123456789abcdef', spawn: { depth: 1, principal: { owner: true }, thread: 'th:NOT-VALID' } });
  const args = (cv) => { const c = loadConv(w.env, cv); return { conversation: cv, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(cv) }; };
  const grant = continuationCall(w.env, { ...args(source.conversation), action: 'issue' }, w.o);
  const firing = w.msg('wake:w-abcdef', 'follow up', { source: 'clock', venue: 'wake', id: 'w-abcdef', kind: 'wake', from: { kind: 'schedule' }, continuation: { handle: grant.handle, expiresAt: grant.expiresAt, wake: 'w-abcdef' } });
  handOverWake(w.env, { agent: 'art', place: firing.place, id: firing.id, for: 'owner' });
  const child = await deliver(w.env, firing, w.o);
  const q = { ...args(child.conversation), handle: grant.handle, id: 'final' };
  continuationCall(w.env, { ...q, action: 'enqueue', text: 'never lands' }, w.o);
  const calls = [];
  const o = { ...w.o, venues: async () => ({ loom: { adapter: 'core', kind: 'live' } }), core: { ...w.o.core, comms: async (p) => { calls.push(p); return { ok: true, id: '7' }; } } };
  // A malformed thread on the record is no thread: it waits, several ticks, and posts nothing.
  for (let i = 0; i < 4; i++) { await tick(w.env, o); w.clock.advance(3600001); }
  assert.equal(calls.filter((p) => p.ref?.startsWith('continuation-')).length, 0);
  w.clock.advance(w.o.continuationLifetimeMs);
  await tick(w.env, o);
  const st = continuationCall(w.env, { ...q, action: 'status' }, w.o);
  assert.deepEqual([st.state, st.attempts], ['expired', 0]);
});

test("a spawn's report goes only to that spawn: a record no longer the sealed spawn is refused (t-2004)", async () => {
  const { handOverWake, tick } = await import('../src/delivery.mjs');
  const w = world();
  w.env.LOOM_HOME = join(w.env.HOME, 'loom');
  mkdirSync(w.env.LOOM_HOME, { recursive: true });
  writeFileSync(join(w.env.LOOM_HOME, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }] }));
  const source = await deliver(w.env, w.msg('spawn-moved', 'owner', { source: 'loom', venue: 'loom', from: { kind: 'person', slug: 'jonathan' } }), w.o);
  const write = (c) => writeFileSync(join(deliveryDir(w.env), 'conversations', `${c.conversation}.json`), JSON.stringify(c));
  write({ ...loadConv(w.env, source.conversation), venue: 'spawn', place: 'sp-111111111111111111111111', spawn: { depth: 1, principal: { owner: true }, thread: 'th:abcdefghij' } });
  const args = (cv) => { const c = loadConv(w.env, cv); return { conversation: cv, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(cv) }; };
  const grant = continuationCall(w.env, { ...args(source.conversation), action: 'issue' }, w.o);
  const firing = w.msg('wake:w-abcdef', 'follow up', { source: 'clock', venue: 'wake', id: 'w-abcdef', kind: 'wake', from: { kind: 'schedule' }, continuation: { handle: grant.handle, expiresAt: grant.expiresAt, wake: 'w-abcdef' } });
  handOverWake(w.env, { agent: 'art', place: firing.place, id: firing.id, for: 'owner' });
  const child = await deliver(w.env, firing, w.o);
  const q = { ...args(child.conversation), handle: grant.handle, id: 'final' };
  continuationCall(w.env, { ...q, action: 'enqueue', text: 'only to the sealed spawn' }, w.o);
  const calls = [];
  const o = { ...w.o, venues: async () => ({ loom: { adapter: 'core', kind: 'live' } }), core: { ...w.o.core, comms: async (p) => { calls.push(p); return { ok: true, id: '7' }; } } };
  // Its record now names another place (and another thread): nothing goes anywhere.
  write({ ...loadConv(w.env, source.conversation), place: 'sp-222222222222222222222222', spawn: { ...loadConv(w.env, source.conversation).spawn, thread: 'th:zzzzzzzzzz' } });
  await tick(w.env, o);
  assert.equal(calls.filter((p) => p.ref?.startsWith('continuation-')).length, 0);
  // The runtime's snapshot check fences it first: the source isn't the conversation the grant was sealed for.
  assert.throws(() => continuationCall(w.env, { ...q, action: 'status' }, w.o), /reset or changed/);
  // And spawnPlace on its own: only the sealed spawn's record, with a well-formed thread, names a place.
  const { spawnPlace } = await import('../src/delivery.mjs');
  const sealed = { conversation: source.conversation, agent: 'art', target: { venue: 'spawn', place: 'sp-111111111111111111111111' } };
  assert.equal(spawnPlace(w.env, sealed), null, 'the record now names another place');
  write({ ...loadConv(w.env, source.conversation), place: 'sp-111111111111111111111111' });
  assert.equal(spawnPlace(w.env, sealed), 'th:zzzzzzzzzz');
  assert.equal(spawnPlace(w.env, { ...sealed, agent: 'mark' }), null, 'another agent');
  write({ ...loadConv(w.env, source.conversation), venue: 'loom' });
  assert.equal(spawnPlace(w.env, sealed), null, 'no longer a spawn');
  assert.equal(spawnPlace(w.env, { ...sealed, conversation: 'cv-000000000000' }), null, 'no record');
});

test("a spawn report that may have reached core reconciles at its kept thread, even once the spawn's record is gone (t-2004)", async () => {
  const { handOverWake, tick } = await import('../src/delivery.mjs');
  const { rmSync } = await import('node:fs');
  const w = world();
  w.env.LOOM_HOME = join(w.env.HOME, 'loom');
  mkdirSync(w.env.LOOM_HOME, { recursive: true });
  writeFileSync(join(w.env.LOOM_HOME, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }] }));
  const source = await deliver(w.env, w.msg('spawn-gone', 'owner', { source: 'loom', venue: 'loom', from: { kind: 'person', slug: 'jonathan' } }), w.o);
  const file = join(deliveryDir(w.env), 'conversations', `${source.conversation}.json`);
  writeFileSync(file, JSON.stringify({ ...loadConv(w.env, source.conversation), venue: 'spawn', place: 'sp-333333333333333333333333', spawn: { depth: 1, principal: { owner: true }, thread: 'th:qqqqqqqqqq' } }));
  const args = (cv) => { const c = loadConv(w.env, cv); return { conversation: cv, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(cv) }; };
  const grant = continuationCall(w.env, { ...args(source.conversation), action: 'issue' }, w.o);
  const firing = w.msg('wake:w-abcdef', 'follow up', { source: 'clock', venue: 'wake', id: 'w-abcdef', kind: 'wake', from: { kind: 'schedule' }, continuation: { handle: grant.handle, expiresAt: grant.expiresAt, wake: 'w-abcdef' } });
  handOverWake(w.env, { agent: 'art', place: firing.place, id: firing.id, for: 'owner' });
  const child = await deliver(w.env, firing, w.o);
  const q = { ...args(child.conversation), handle: grant.handle, id: 'final' };
  continuationCall(w.env, { ...q, action: 'enqueue', text: 'maybe landed' }, w.o);
  const calls = [];
  // The post's answer is lost (core may have taken it): a 503, so it's retried, not refused.
  const lost = { ...w.o, venues: async () => ({}), core: { ...w.o.core, comms: async (p) => { calls.push(p); throw Object.assign(new Error('unavailable'), { status: 503 }); } } };
  await tick(w.env, lost);
  const mine = () => calls.filter((p) => p.ref?.startsWith('continuation-'));
  assert.equal(mine().length, 1);
  assert.equal(mine()[0].place, 'th:qqqqqqqqqq');
  // The spawn's record goes (pruned); the deadline passes: the row is uncertain, and reconciles at the kept thread.
  rmSync(file);
  w.clock.advance(w.o.continuationLifetimeMs + 1);
  const ok = { ...lost, core: { ...w.o.core, comms: async (p) => { calls.push(p); return p.op === 'reconcile' ? { ok: true, state: 'delivered', id: '9' } : { ok: false }; } } };
  await tick(w.env, ok);
  w.clock.advance(3600001);
  await tick(w.env, ok);
  const rec = mine().filter((p) => p.op === 'reconcile');
  assert.ok(rec.length >= 1, 'reconciled');
  assert.equal(rec[0].place, 'th:qqqqqqqqqq');
  assert.equal(mine().filter((p) => p.op === 'post').length, 1, 'never posted again');
});
