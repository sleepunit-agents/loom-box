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
function setup(where, extra = {}) {
  const w = world({ LOOM_RUNTIME_LOCAL_BODIES: JSON.stringify({ ...base, ...(where ? { where } : {}), ...extra }) });
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
  assert.deepEqual(localBodiesOf({ LOOM_RUNTIME_LOCAL_BODIES: JSON.stringify({ ...base, house: ['lane:letters', 'lane:letters', 7, '', 'x'.repeat(201)] }) }).house, ['lane:letters']);
  assert.equal(localBodiesOf({ LOOM_RUNTIME_LOCAL_BODIES: JSON.stringify({ ...base, house: 'lane:letters' }) }).house, undefined);
});

test('"house": [places] moves only those lanes into his house, one at a time; the rest stay on loom\'s machine', async () => {
  const { w, asked, lwake, conv } = setup(undefined, { house: ['lane:letters'] });
  await deliver(w.env, lwake('lane:boot', 'boot'), w.o);
  assert.ok(asked.includes(true), 'a lane not named still runs here');
  assert.equal(readBody(w.env, conv('lane:boot').body).local, true);
  assert.equal(conv('lane:boot').bodyRules?.seat, undefined);
  const starts = w.log.filter((l) => l[0] === 'start').length;
  const r = await deliver(w.env, lwake('lane:letters', 'letters'), w.o);
  assert.equal(r.body, 'started');
  assert.equal(w.log.filter((l) => l[0] === 'start').length, starts + 1, 'started by the house runner');
  const c = conv('lane:letters');
  assert.equal(c.local, true);
  assert.equal(c.bodyRules.seat, `owner.${c.conversation}`);
  assert.equal(readBody(w.env, c.body).local, undefined);
});

test('"house": [places] keeps the owner\'s-work-only rule: a named lane\'s wake nobody can say is his gets no body', async () => {
  const { w, asked, lwake, conv } = setup(undefined, { house: ['lane:x'] });
  const r = await deliver(w.env, lwake('lane:x', 'do it', { handOver: null }), w.o);
  assert.notEqual(r.body, 'started');
  assert.equal(conv('lane:x').body, undefined);
  assert.equal(asked.length, 0);
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
  assert.equal(c.bodyRules.seat, `owner.${c.conversation}`, 'in a house of its own (t-2061)');
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

test('"house": its brief says it relays as a house body does, never as one on loom\'s machine', async () => {
  const { w, lwake } = setup('house');
  await deliver(w.env, lwake('lane:r', 'go'), w.o);
  const start = w.log.find((l) => l[0] === 'start');
  assert.match(JSON.stringify(start), /loom runtime relay --to/);
});

test('a session saved on loom\'s machine is not resumed in the owner\'s house after the switch: a fresh body', async () => {
  const s = setup();
  await deliver(s.w.env, s.lwake('lane:z', 'first'), s.w.o);
  const c = s.conv('lane:z');
  const ref = c.body;
  assert.ok(ref && s.asked.includes(true), 'started here first');
  // Its turn over and its body idled out: its session saved as a slot.
  s.w.o.runner('claude', true).finish(ref);
  const { tick } = await import('../src/delivery.mjs');
  await tick(s.w.env, s.w.o);
  s.w.clock.advance(601_000);
  await tick(s.w.env, s.w.o);
  assert.ok(s.conv('lane:z').slot, 'a slot to resume');
  // The owner moves local bodies into his house: the next wake starts fresh there, never resumes that session.
  s.w.env.LOOM_RUNTIME_LOCAL_BODIES = JSON.stringify({ ...base, where: 'house' });
  await deliver(s.w.env, s.lwake('lane:z', 'second'), s.w.o);
  const runs = s.w.log.filter((l) => l[0] === 'start' || l[0] === 'resume');
  assert.equal(runs.at(-1)[0], 'start');
  assert.equal(readBody(s.w.env, s.conv('lane:z').body).local, undefined);
});
