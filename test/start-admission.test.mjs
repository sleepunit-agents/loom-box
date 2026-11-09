// t-535's exclusion contract. These initially fail on143; cleanup of a late
// body is deliberately insufficient. Nothing here starts a real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, deliveryDir, loadConv, ownerConversationControl, saveConv, tick } from '../src/delivery.mjs';
import { cvOf, world } from './delivery-world.mjs';
import { completeLaunch } from '../src/launch-journal.mjs';

for (const marker of ['legacy', 'untracked']) test(`${marker} start cannot expire into duplicate work during a controller upgrade`, async () => {
  const w = world(), place = `dm:upgrade-${marker}`;
  const first = await deliver(w.env, w.msg(place, 'original unresolved work'), { ...w.o, detach: true, spawnWorker() {} });
  const c = loadConv(w.env, first.conversation), original = c.queue;
  c.starting = { pid: 2147483647, since: 1, op: 'a'.repeat(12), msgs: original,
    ...(marker === 'untracked' ? { protocol: 2, untracked: true } : {}) };
  c.queue = []; saveConv(w.env, c);
  w.clock.advance(8 * 24 * 3600_000);
  await deliver(w.env, w.msg(place, 'later queued work'), w.o);
  await tick(w.env, w.o);
  await ownerConversationControl(w.env, { kind: 'owner' }, { conversation: c.conversation, action: 'interrupt' }, w.o);
  const held = loadConv(w.env, c.conversation);
  assert.equal(held.starting.op, c.starting.op);
  assert.deepEqual(held.starting.msgs, original);
  assert.equal(held.control.state, 'pending', 'unknown native work is not falsely declared collected');
  assert.equal(held.queue.length, 1);
  assert.equal(w.log.filter(x => x[0] === 'start').length, 0);
});

for (const owner of ['slow-live', 'registrar-gone']) {
  test(`one native admission while the prior start is unresolved: ${owner}`, async () => {
    const w = world();
    const cv = cvOf('art', 'slack', 'dm:admission-' + owner);
    let entered;
    const admitted = new Promise(resolve => { entered = resolve; });
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    let admissions = 0;
    const nativeStart = w.runner.start.bind(w.runner);
    const runner = { ...w.runner, async start(o) {
      admissions++;
      if (admissions === 1) { entered(); await hold; }
      return nativeStart(o);
    } };
    const o = { ...w.o, runner: () => runner };
    let worker;
    const first = deliver(w.env, w.msg('dm:admission-' + owner, 'first work'), {
      ...o, onDrain: p => { worker = p; },
    });
    await admitted;
    const original = loadConv(w.env, cv).starting;
    try {
      if (owner === 'slow-live') w.clock.advance(241_000);
      else {
        // The native side has admitted work, but its controller registrar died
        // before receiving the body identity. A dead pid proves no native stop.
        const c = loadConv(w.env, cv);
        c.starting.pid = 2147483647;
        writeFileSync(join(deliveryDir(w.env), 'conversations', cv + '.json'), JSON.stringify(c));
      }
      await deliver(w.env, w.msg('dm:admission-' + owner, 'later work'), o);
      await tick(w.env, o);
      assert.equal(admissions, 1, 'no replacement native work before the previous admission is reconciled');
      assert.equal(loadConv(w.env, cv).starting.op, original.op, 'same durable attempt remains owned');
    } finally {
      release();
      await first;
      await worker;
    }
  });
}


test('delivery recovers the prepared native receipt after a lost handoff without replaying work', async () => {
  const w = world();
  const cv = cvOf('art', 'slack', 'dm:lost-handoff');
  let native, admissions = 0;
  const runner = { ...w.runner, async start(options) {
    admissions++;
    native = await w.runner.start(options);
    throw Error('registrar lost the native handoff');
  } };
  const warnings = [];
  const o = { ...w.o, runner: () => runner, warn: text => warnings.push(text) };
  const first = await deliver(w.env, w.msg('dm:lost-handoff', 'original work'), o);
  assert.equal(first.body, 'queued');
  const prepared = loadConv(w.env, cv).starting.prepared;
  assert.ok(prepared);
  assert.equal(loadConv(w.env, cv).body, undefined);
  completeLaunch(w.env, prepared.id, native, { inputConfirmed: true });
  w.clock.advance(1001);
  await tick(w.env, o);
  const recovered = loadConv(w.env, cv);
  assert.equal(recovered.body, `${native.harness}:${native.id}`, JSON.stringify({ warnings, starting: recovered.starting, waiting: recovered.waiting }));
  assert.equal(recovered.run, prepared.snapshot.run);
  assert.equal(recovered.sendKey, prepared.snapshot.senderHash);
  assert.equal(recovered.runs, 1);
  assert.equal(recovered.starting, undefined);
  assert.equal(admissions, 1);
  assert.equal(Object.values(recovered.outcomes)[0].body, 'started');
  await tick(w.env, o);
  assert.equal(loadConv(w.env, cv).runs, 1);
  assert.equal(admissions, 1);
});
