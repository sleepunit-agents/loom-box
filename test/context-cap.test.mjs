import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { contextCapOf, lastContext, handoffText, HANDOFF_MARKER } from '../src/context-cap.mjs';
import { world } from './delivery-world.mjs';
import { deliver, tick, loadConv, saveConv } from '../src/delivery.mjs';
test('cap defaults only to scheduled and agent work, explicit off; usage is current input not cumulative', () => {
  assert.equal(contextCapOf({}, { kind: 'scheduled' }), 150000);
  assert.equal(contextCapOf({}, { kind: 'agent' }), 150000);
  assert.equal(contextCapOf({}, { kind: 'live' }), null);
  for (const raw of ['-1', '19999', '2000001', '1.5', 'bad']) assert.equal(contextCapOf({ LOOM_RUNTIME_CONTEXT_CAP: raw }, { kind: 'agent' }), null);
  for (const raw of ['20000', '2000000']) assert.equal(contextCapOf({ LOOM_RUNTIME_CONTEXT_CAP: raw }, { kind: 'agent' }), Number(raw));
  assert.equal(contextCapOf({ LOOM_RUNTIME_CONTEXT_CAP: 'off' }, { kind: 'agent' }), null);
  assert.equal(contextCapOf({ LOOM_RUNTIME_CONTEXT_CAP: '175000' }, { kind: 'agent' }), 175000);
  assert.equal(lastContext('codex', JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 160000 }, total_token_usage: { input_tokens: 9000000 } } } })), 160000);
  assert.equal(lastContext('claude', JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 140000, cache_creation_input_tokens: 15000 } } })), 155010);
  assert.equal(handoffText('normal completion'), null);
  assert.equal(handoffText(HANDOFF_MARKER + 'Real handoff'), 'Real handoff');
});
test('one request, durable note, archived transcript and fresh start instead of resume', async () => {
  const w = world({}, { inboxDir: true });
  const models = [], originalStart = w.runner.start;
  w.runner.start = options => { models.push(options.model); return originalStart(options); };

  // world uses a live venue: provide an agent venue for the same trusted test source.
  w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('context', 'Complete the work'), w.o);
  let c = loadConv(w.env, first.conversation);
  assert.ok(c.body);
  w.runner.context = () => 160000;
  w.runner.final = () => HANDOFF_MARKER + 'Goal: complete work. Done: report. Left: deploy. HEAD abc; PR 1.';
  await tick(w.env, w.o);
  c = loadConv(w.env, first.conversation);
  const originalPrincipal = structuredClone(c.actsFor);
  assert.ok(c.contextCap, JSON.stringify({ kind: c.kind, log: w.log }));
  await tick(w.env, w.o);
  assert.equal(w.log.filter(x => x[0] === 'feed').length, 1);
  const oldBody = c.body;
  await deliver(w.env, w.msg('context', 'Pending follow-up survives rotation'), w.o);
  w.runner.finish(oldBody);
  await tick(w.env, w.o);
  c = loadConv(w.env, first.conversation);
  assert.equal(c.contextHandoffs.length, 1);
  assert.deepEqual(c.actsFor, originalPrincipal);
  assert.equal(c.contextModel.model, 'opus');
  assert.equal(models.at(-1), 'opus');
  assert.ok(existsSync(c.contextHandoffs[0].archive));
  assert.notEqual(c.body, oldBody);
  assert.equal(w.log.filter(x => x[0] === 'resume').length, 0);
  assert.equal(w.log.filter(x => x[0] === 'start').length, 2, JSON.stringify(c));
  assert.match(w.log.filter(x => x[0] === 'start')[1][2], /Goal: complete work/);
  assert.match(w.log.filter(x => x[0] === 'start')[1][2], /Pending follow-up survives rotation/);
});
test('spawned handoff never becomes its final report; fresh job returns the actual result', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const w = world();
  const r = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Do the work' }, w.o);
  let c = loadConv(w.env, r.handle);
  const old = c.body;
  w.runner.context = () => 160000;
  w.runner.final = () => HANDOFF_MARKER + 'Done report; remaining deploy; PR 1, HEAD abc.';
  await tick(w.env, w.o);
  w.runner.finish(old);
  await tick(w.env, w.o);
  c = loadConv(w.env, r.handle);
  assert.equal(c.spawn.report, undefined);
  assert.notEqual(c.body, old);
  assert.equal((await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', action: 'result', handle: r.handle }, w.o)).state, 'pending');
  w.runner.context = () => 1000;
  w.runner.final = () => 'Deployed successfully';
  w.runner.finish(c.body);
  await tick(w.env, w.o);
  const result = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', action: 'result', handle: r.handle }, w.o);
  assert.equal(result.report, 'Deployed successfully');
});

test('saved handoff rotates after native final is gone (controller restart)', async () => {
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('restart-cap', 'Do job'), w.o);
  let c = loadConv(w.env, first.conversation);
  w.runner.context = () => 160000;
  await tick(w.env, w.o);
  c = loadConv(w.env, first.conversation);
  c.contextCap.note = w.o.sealer.seal(Buffer.from('Saved durable handoff; finish job from HEAD abc')).toString('base64');
  saveConv(w.env, c);
  w.runner.final = () => null;
  w.runner.finish(c.body);
  await tick(w.env, w.o);
  c = loadConv(w.env, first.conversation);
  assert.equal(c.contextHandoffs.length, 1);
  assert.ok(c.body);
  assert.match(w.log.filter(x => x[0] === 'start').at(-1)[2], /Saved durable handoff/);
});

test('request intent is durable before inbox accepts the handoff (restart window)', async () => {
  const w = world({}, { inboxDir: true }); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('request-crash', 'Do job'), w.o);
  w.runner.context = () => 160000;
  const originalFeed = w.runner.feed;
  w.runner.feed = (body, message) => {
    originalFeed(body, message);
    const c = loadConv(w.env, first.conversation);
    assert.equal(c.contextCap.body, c.body);
    assert.equal(c.contextCap.requested, false);
    throw Error('controller died after inbox acceptance');
  };
  await tick(w.env, w.o);
  let c = loadConv(w.env, first.conversation);
  assert.equal(c.starting, undefined, 'a transient feed exception cannot strand the live controller marker');
  w.runner.final = () => HANDOFF_MARKER + 'Continue the job from saved branch';
  w.runner.finish(c.body);
  await tick(w.env, w.o);
  c = loadConv(w.env, first.conversation);
  assert.equal(c.contextHandoffs.length, 1);
  assert.ok(c.body);
});

test('two rotations retain sender-derived guest denies and standing restrictions', async () => {
  const w = world();
  w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  w.o.gates = () => ({ people: { loren: { tier: 1, restrict: 'Never publish anything' } } });
  w.o.policy = () => ({ guest_deny: ['mcp__secret'], briefs: { guest: 'house/guest.md' } });
  w.o.card = () => 'Guest card'; w.o.cwd = w.env.HOME;
  mkdirSync(join(w.env.HOME, 'house'), { recursive: true });
  writeFileSync(join(w.env.HOME, 'house/guest.md'), 'Guest floor');
  const first = await deliver(w.env, w.msg('guest-cap', 'Do permitted work'), w.o);
  assert.equal(first.body, 'started');
  w.runner.context = () => 160000;
  w.runner.final = () => HANDOFF_MARKER + 'Continue permitted job at HEAD abc';
  for (let i = 0; i < 2; i++) {
    let c = loadConv(w.env, first.conversation);
    await tick(w.env, w.o);
    w.runner.finish(c.body);
    await tick(w.env, w.o);
    c = loadConv(w.env, first.conversation);
    assert.ok(c.body);
    assert.equal(c.bodyRules.guest, true);
    assert.ok(w.runner.denies[c.body.split(':')[1]].includes('mcp__secret'));
    assert.match(w.log.filter(x => x[0] === 'start').at(-1)[2].map ? JSON.stringify(w.log.filter(x => x[0] === 'start').at(-1)[2]) : w.log.filter(x => x[0] === 'start').at(-1)[2], /Never publish anything/);
  }
});
