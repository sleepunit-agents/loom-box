// t-2049 phase 3: LOOM_RUNTIME_LOCAL_BODIES "where": "house" moves a local wake's body off loom's machine into the
// agent's own owner-seat house, keeping every rule a local body has (the owner says which agents; only the clock
// delivers one; the owner's work only). The default ("here") is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { putWakeFor } from '../src/principal.mjs';
import { deliver, deliveryDir, loadConv, localBodiesOf } from '../src/delivery.mjs';
import { readBody } from '../src/bodies.mjs';
import { cvOf, fakeRunner, world } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';

const base = { agents: ['art'], cwd: '/home/art/Art', path: '/home/art/Art/bin:/usr/bin' };
function setup(where) {
  const w = world({ LOOM_RUNTIME_LOCAL_BODIES: JSON.stringify({ ...base, ...(where ? { where } : {}) }) });
  const localRunner = fakeRunner([], scratch('rt-local-'));
  const asked = [];
  w.o.runner = (h, local) => { asked.push(!!local); return local ? localRunner : w.runner; };
  const lwake = (place, text, { handOver = 'owner' } = {}) => {
    const m = w.msg(place, text, { venue: 'wake', from: { kind: 'schedule' }, kind: 'wake', source: 'clock', local: true });
    if (handOver) putWakeFor(deliveryDir(w.env), { agent: m.agent, place: m.place, id: m.id, for: handOver });
    return m;
  };
  return { w, asked, lwake, conv: (place) => loadConv(w.env, cvOf('art', 'wake', place)) };
}

test('the setting: "here" by default, "house" only when said', () => {
  assert.equal(localBodiesOf({ LOOM_RUNTIME_LOCAL_BODIES: JSON.stringify(base) }).where, 'here');
  assert.equal(localBodiesOf({ LOOM_RUNTIME_LOCAL_BODIES: JSON.stringify({ ...base, where: 'house' }) }).where, 'house');
  assert.equal(localBodiesOf({ LOOM_RUNTIME_LOCAL_BODIES: JSON.stringify({ ...base, where: 'elsewhere' }) }).where, 'here');
});

test('default: a local wake\'s body runs on loom\'s machine, as before', async () => {
  const { w, asked, lwake, conv } = setup();
  await deliver(w.env, lwake('lane:boot2', 'boot'), w.o);
  assert.ok(asked.includes(true));
  assert.equal(readBody(w.env, conv('lane:boot2').body).local, true);
});

test('"house": the owner\'s local wake runs in his own house, seated as the owner, its conversation still local', async () => {
  const { w, asked, lwake, conv } = setup('house');
  const r = await deliver(w.env, lwake('lane:boot', 'boot'), w.o);
  assert.equal(r.body, 'started');
  assert.ok(!asked.includes(true), 'never the local runner');
  const c = conv('lane:boot');
  assert.equal(c.local, true, 'still a local wake\'s conversation: its rules stand');
  assert.equal(c.bodyRules.seat, 'owner');
  assert.equal(readBody(w.env, c.body).local, undefined);
  const start = w.log.find((l) => l[0] === 'start');
  assert.ok(start, 'started by the house runner');
});

test('"house": a local wake nobody can say is the owner\'s still gets no body anywhere', async () => {
  const { w, asked, lwake, conv } = setup('house');
  const r = await deliver(w.env, lwake('lane:x', 'do it', { handOver: null }), w.o);
  assert.notEqual(r.body, 'started');
  assert.equal(conv('lane:x').body, undefined);
  assert.equal(asked.length, 0);
});

test('"house": still only the clock delivers one, and only for the agents the owner named', async () => {
  const { w, lwake } = setup('house');
  const m = lwake('lane:y', 'x');
  assert.equal((await deliver(w.env, { ...m, source: 'other' }, w.o)).status, 403);
  assert.equal((await deliver(w.env, { ...m, id: 'z', agent: 'mark' }, w.o)).status, 403);
});
