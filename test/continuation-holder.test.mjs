import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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
