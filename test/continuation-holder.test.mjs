import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { continuationCall, deliver, deliveryDir, loadConv } from '../src/delivery.mjs';
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
  c.bodyRules = { ...c.bodyRules, seat: "owner" };
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
  const firing = w.msg('wake:w-abcdef', 'follow up', { source: 'clock', venue: 'wake', id: 'w-abcdef', kind: 'wake', from: { kind: 'schedule' }, continuation: { handle: grant.handle, wake: 'w-abcdef' } });
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
  const fed = await deliver(w.env, { ...firing, id: 'second', continuation: { handle: extra.handle, wake: 'w-123456' } }, w.o);
  assert.equal(fed.body, 'fed');
  assert.throws(() => continuationCall(w.env, { ...report, handle: extra.handle }, w.o), /bound/);
  handOverWake(w.env, { agent: 'art', place: 'wake:w-654321', id: 'third', for: 'owner' });
  const other = await deliver(w.env, { ...firing, place: 'wake:w-654321', id: 'third', continuation: { handle: grant.handle, wake: 'w-654321' } }, w.o);
  assert.throws(() => continuationCall(w.env, { ...argsFor(other.conversation), action: 'enqueue', handle: grant.handle, id: 'final', text: 'stolen' }, w.o), /already bound/);
  const changed = loadConv(w.env, child.conversation);
  changed.actsFor.reset = 'reset-after-admission';
  writeFileSync(join(deliveryDir(w.env), 'conversations', `${child.conversation}.json`), JSON.stringify(changed));
  assert.throws(() => continuationCall(w.env, { ...report, id: 'after-reset' }, w.o), /bound/);
});
