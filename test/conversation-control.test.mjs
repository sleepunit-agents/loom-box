import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, loadConv, ownerConversationControl, tick } from '../src/delivery.mjs';
import { detectLoop, judge } from '../src/loops.mjs';
import { hasAge, houseWorld, until, world } from './delivery-world.mjs';
import { load } from '../src/state.mjs';
import { hostOf } from '../src/houserunner.mjs';

const owner = { kind: 'owner', agents: ['art'], who: 'owner' };

test('an owner interrupts, holds queued work, and resumes the saved session', async () => {
  const w = world();
  const { conversation } = await deliver(w.env, w.msg('control', 'work'), w.o);
  const first = loadConv(w.env, conversation).body;
  assert.equal((await ownerConversationControl(w.env, owner, { conversation, action: 'interrupt' }, w.o)).state, 'pending');
  await deliver(w.env, w.msg('control', 'queued during interruption'), w.o);
  assert.equal(w.log.filter(x => x[0] === 'feed').length, 0);
  await tick(w.env, w.o);
  const held = loadConv(w.env, conversation);
  assert.equal(held.control.state, 'held');
  assert.equal(held.body, undefined);
  assert.ok(held.slot);
  assert.equal(held.runLog.at(-1).interrupted, true);
  await tick(w.env, w.o);
  assert.equal(loadConv(w.env, conversation).body, undefined);
  await ownerConversationControl(w.env, owner, { conversation, action: 'resume' }, w.o);
  await tick(w.env, w.o);
  assert.notEqual(loadConv(w.env, conversation).body, first);
  assert.ok(w.log.some(x => x[0] === 'resume'));
});

test('an uncertain stop stays pending without destroying the body or starting another', async () => {
  const w = world();
  const { conversation } = await deliver(w.env, w.msg('slow-stop', 'work'), w.o);
  const body = loadConv(w.env, conversation).body;
  let stopped = false;
  w.runner.stopped = () => stopped;
  await ownerConversationControl(w.env, owner, { conversation, action: 'interrupt' }, w.o);
  await tick(w.env, w.o);
  await tick(w.env, w.o);
  assert.equal(loadConv(w.env, conversation).body, body);
  assert.equal(loadConv(w.env, conversation).control.state, 'pending');
  assert.equal(w.log.filter(x => x[0] === 'end').length, 1);
  await assert.rejects(ownerConversationControl(w.env, owner, { conversation, action: 'resume' }, w.o), /still stopping/);
  stopped = true;
  await tick(w.env, w.o);
  assert.equal(loadConv(w.env, conversation).control.state, 'held');
  const principal = loadConv(w.env, conversation).actsFor;
  await ownerConversationControl(w.env, owner, { conversation, action: 'resume' }, w.o);
  assert.ok(loadConv(w.env, conversation).body);
  assert.deepEqual(loadConv(w.env, conversation).actsFor, principal, 'resume does not upgrade the original principal');
  assert.ok(w.log.some(x => x[0] === 'resume'));
});

test('an owner’s new message resumes after the pending stop has saved the session', async () => {
  const w = world();
  const msg = text => w.msg('owner-control', text, { source: 'loom', venue: 'loom', from: { kind: 'person', slug: 'owner' } });
  const { conversation } = await deliver(w.env, msg('work'), w.o);
  let stopped = false;
  w.runner.stopped = () => stopped;
  await ownerConversationControl(w.env, owner, { conversation, action: 'interrupt' }, w.o);
  await tick(w.env, w.o);
  await deliver(w.env, msg('continue with this correction'), w.o);
  assert.equal(w.log.filter(x => x[0] === 'resume').length, 0);
  stopped = true;
  await tick(w.env, w.o);
  assert.equal(loadConv(w.env, conversation).control, undefined);
  assert.ok(w.log.some(x => x[0] === 'resume'));
});

test('manual interruption breaks failure and churn streaks', () => {
  const failed = i => ({ at: i * 1000, end: i * 1000 + 1, fail: 'failure', cause: 'schedule' });
  const interrupted = { ...failed(4), interrupted: true };
  assert.deepEqual(judge(interrupted), { failed: null, sig: null });
  assert.equal(detectLoop({ agent: 'art', runs: [failed(1), failed(2), failed(3), interrupted, failed(5)] }), null);
});

test('conversation control refuses bodies and unrelated owners before any change', async () => {
  const w = world();
  const { conversation } = await deliver(w.env, w.msg('scope', 'work'), w.o);
  for (const caller of [{ kind: 'agent', agent: 'art' }, { kind: 'owner', agents: ['mark'] }]) {
    await assert.rejects(ownerConversationControl(w.env, caller, { conversation, action: 'interrupt' }, w.o), /owner|another agent/);
  }
  await assert.rejects(ownerConversationControl(w.env, owner, { agent: 'mark', conversation, action: 'interrupt' }, w.o), /another agent/);
  assert.equal(loadConv(w.env, conversation).control, undefined);
});

test('a disconnected house keeps its interrupt pending and later returns its packed session', { skip: !hasAge }, async () => {
  const w = houseWorld();
  const base = world();
  const o = { ...base.o, runner: () => w.hr, sealer: w.sealer, accounts: w.accounts, now: () => new Date() };
  const first = deliver(w.env, base.msg('remote-control', 'work', { from: { kind: 'person', slug: 'jonathan' } }), o);
  await until(() => load(w.env).houses['h-1']);
  const host = w.host();
  try {
    const { conversation } = await first;
    const ref = loadConv(w.env, conversation).body;
    w.setDrop(() => true);
    const oldNow = w.hr.now;
    w.hr.now = () => new Date(Date.now() + 60000);
    await ownerConversationControl(w.env, owner, { conversation, action: 'interrupt' }, o);
    await tick(w.env, o);
    const stop = structuredClone(hostOf(w.env, 'art').stop);
    await tick(w.env, o);
    assert.deepEqual(hostOf(w.env, 'art').stop, stop, 'retries preserve the same stop nonce');
    assert.equal(loadConv(w.env, conversation).body, ref);
    assert.equal(loadConv(w.env, conversation).control.state, 'pending');
    assert.equal(w.ended.length, 0);
    w.hr.now = oldNow;
    w.setDrop(() => false);
    await until(() => w.ended.length > 0);
    await until(async () => { await tick(w.env, o); return loadConv(w.env, conversation).control.state === 'held'; });
    assert.ok(loadConv(w.env, conversation).slot);
    assert.equal(loadConv(w.env, conversation).body, undefined);
  } finally { w.setDrop(() => false); await w.kill(); await host; }
});
