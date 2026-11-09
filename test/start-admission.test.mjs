// t-535's exclusion contract. These initially fail on143; cleanup of a late
// body is deliberately insufficient. Nothing here starts a real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, deliveryDir, loadConv, tick } from '../src/delivery.mjs';
import { cvOf, world } from './delivery-world.mjs';

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
