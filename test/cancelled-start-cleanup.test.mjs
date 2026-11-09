import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, deliveryDir, loadConv, saveConv, tick } from '../src/delivery.mjs';
import { startBody, readBody } from '../src/bodies.mjs';
import { cvOf, world } from './delivery-world.mjs';

for (const endFails of [false, true]) test(`a discarded start keeps its files until native shutdown${endFails ? ', retrying a failed stop' : ''}`, async () => {
  const w = world();
  const cv = cvOf('art', 'slack', 'cancelled-start');
  const start = w.runner.start.bind(w.runner), end = w.runner.end.bind(w.runner);
  let native, stopped = false, allowStop = !endFails, endCalls = 0;
  w.runner.stopped = () => stopped;
  w.runner.end = body => { endCalls++; if (!allowStop) throw new Error('temporary stop failure'); return end(body); };
  w.runner.start = o => {
    native = start(o);
    const c = loadConv(w.env, cv);
    c.starting.op = 'a-newer-start-owns-this-conversation';
    saveConv(w.env, c);
    return native;
  };
  await deliver(w.env, w.msg('cancelled-start', 'first'), w.o);
  assert.equal(loadConv(w.env, cv).body, undefined, 'the late body never becomes the conversation’s body');
  const file = w.runner.transcript(native.slot.session);
  assert.equal(existsSync(file), true, 'a live native writer retains its files');
  appendFileSync(file, '\nWRITER-STILL-ACTIVE');
  await tick(w.env, { ...w.o });
  assert.equal(existsSync(file), true);
  if (!endFails) assert.equal(endCalls, 1, 'an acknowledged stop request is not repeated');
  allowStop = true;
  stopped = true;
  await tick(w.env, { ...w.o });
  assert.equal(existsSync(file), false, 'discarded session files are removed after shutdown, without making a slot');
  assert.equal(loadConv(w.env, cv).slot, undefined);
});

test('uncertain discarded writers do not starve a later confirmed shutdown', async () => {
  const w = world();
  const dir = join(deliveryDir(w.env), 'discarding');
  mkdirSync(dir, { recursive: true });
  const bodies = [];
  for (let i = 0; i < 5; i++) {
    const b = await startBody(w.env, { agent: 'art', venue: 'slack', brief: 'discard fixture' }, w.o);
    bodies.push(b);
    writeFileSync(join(dir, b.body.replace(':', '-') + '.json'), JSON.stringify({ body: b.body, instance: b.instance, started: b.started }));
  }
  const last = bodies.at(-1);
  w.runner.finish(last.body);
  w.runner.stopped = body => body.id === last.body.split(':')[1];
  const file = w.runner.transcript(last.slot.session);
  await tick(w.env, w.o);
  w.clock.advance(1000);
  await tick(w.env, w.o);
  assert.equal(existsSync(file), false, 'the later writer is collected even while earlier stops remain uncertain');
  for (const b of bodies.slice(0, 4)) assert.equal(existsSync(w.runner.transcript(b.slot.session)), true);
});

test('discarding an old incarnation never stops or deletes a reused native job', async () => {
  const w = world();
  const cv = cvOf('art', 'slack', 'reused-job');
  const start = w.runner.start.bind(w.runner);
  let native;
  w.runner.stopped = () => false;
  w.runner.start = o => {
    native = start(o);
    const c = loadConv(w.env, cv); c.starting.op = 'newer-op'; saveConv(w.env, c);
    return native;
  };
  await deliver(w.env, w.msg('reused-job', 'first'), w.o);
  const ref = `claude:${native.id}`;
  const old = readBody(w.env, ref);
  // A newer native resume reused the same job id, even within the same clock tick.
  const next = { ...old, instance: 'new-native-incarnation' }; delete next.ended;
  writeFileSync(join(w.env.LOOM_BOX_DATA, 'bodies', ref.replace(':', '-') + '.json'), JSON.stringify(next));
  w.runner.stopped = () => true;
  await tick(w.env, w.o);
  assert.equal(existsSync(w.runner.transcript(native.slot.session)), true, 'the newer owner keeps its resumable session');
  assert.equal(w.log.filter(x => x[0] === 'end').length, 1, 'the stale discard never stops the reused job');
  assert.equal(existsSync(join(deliveryDir(w.env), 'discarding', ref.replace(':', '-') + '.json')), false);
});
