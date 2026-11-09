import test from 'node:test';
import assert from 'node:assert/strict';
import { readBody } from '../src/bodies.mjs';
import { commitStartedConversation, deliver, loadConv } from '../src/delivery.mjs';
import { world } from './delivery-world.mjs';

test('a recovered receipt for an already bound run is idempotent, not a stale body to terminate', async () => {
  const w = world();
  const first = await deliver(w.env, w.msg('dm:prepared-commit', 'fixture work'), w.o);
  const c = loadConv(w.env, first.conversation), body = readBody(w.env, c.body);
  const snapshot = { run: c.run, senderHash: c.sendKey, bodyRules: c.bodyRules, way: { how: 'start', home: false } };
  const late = { cv: c.conversation, mark: 'abcdef123456', msgs: [] };
  assert.equal(c.starting, undefined, 'the registrar already committed before its replacement observed the receipt');
  const accepted = commitStartedConversation(w.env, late, snapshot, body, [], w.clock.now().getTime() + 1000);
  assert.equal(accepted, true, 'the normal caller must not end the conversation-owned body as a stale launch');
  assert.deepEqual(loadConv(w.env, c.conversation), c, 'no repeated acknowledgements, counters, or run replacement');
  assert.equal(w.log.filter(row => row[0] === 'start').length, 1);
  assert.equal(w.runner.status({ id: body.body.split(':')[1] }), 'working');
});
