// A failover drill (t-2057): the owner rehearses a box going dark for one agent without stopping it. For that agent
// only, placement passes the box by and its warm house there drains; the drill's houses, and only they, are asked about
// on a write-off card that says it's a drill; his Allow writes them off and the box, still polling, is told to stop them.
// The drill ends by itself, or on `drill end`, and the box is taken as it is again.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DRILL_MAX_MS, api, boxUp, endDrill, setDrill } from '../src/control.mjs';
import { bodyBox } from '../src/placement.mjs';
import { HouseRunner, hostOf } from '../src/houserunner.mjs';
import { load, update } from '../src/state.mjs';
import { scratch } from './scratch.mjs';
import { houseWorld } from './delivery-world.mjs';

const T0 = Date.parse('2026-11-09T20:00:00Z');
let env, fx, clock;
const owner = { kind: 'owner' };
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const idOf = (name) => Object.entries(load(env).boxes).find(([, b]) => (b.name ?? '') === name || (b.local && name === 'loom'))?.[0];
const seen = (name, ms = 0) => update(env, (s) => { s.boxes[idOf(name)].lastSeen = new Date(clock - ms).toISOString(); });

beforeEach(() => {
  env = { HOME: scratch('rt-drill-'), LOOM_BOX_LOCAL_NAME: 'loom' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  clock = T0;
  let n = 0;
  fx = { now: () => new Date(clock), mint: () => `loom_${'t'.repeat(30)}${n++}`, revoke: () => {}, secret: (x) => `v-${x}` };
  ok(call(owner, 'set-agent', { agent: 'art', repo: 'https://github.com/x/art.git' }));
  ok(call(owner, 'set-agent', { agent: 'mark', repo: 'https://github.com/x/mark.git' }));
  for (const name of ['one', 'wunder']) ok(call(owner, 'add-box', { name, mayHost: '*' }));
  ok(call(owner, 'set-primary', { agent: 'art', boxes: ['one', 'wunder', 'loom'] }));
  ok(call(owner, 'set-primary', { agent: 'mark', boxes: ['one', 'loom'] }));
  update(env, (s) => { for (const b of Object.values(s.boxes)) b.harnesses = { claude: { loggedIn: true } }; });
  seen('one'); seen('wunder');
});

test('a drill is the owner\'s, from loom\'s machine: never loom\'s own box, only the agent\'s live houses there, and it ends', () => {
  update(env, (s) => {
    s.houses['h-1'] = { id: 'h-1', agent: 'art', box: idOf('one'), state: 'running' };
    s.houses['h-2'] = { id: 'h-2', agent: 'mark', box: idOf('one'), state: 'running' };
    s.houses['h-3'] = { id: 'h-3', agent: 'art', box: idOf('one'), state: 'running', service: 'bridge' };
    s.houses['h-4'] = { id: 'h-4', agent: 'art', box: idOf('wunder'), state: 'running' };
    s.houses['h-5'] = { id: 'h-5', agent: 'art', box: idOf('one'), state: 'done' };
  });
  assert.throws(() => setDrill(env, fx, { name: 'loom', agent: 'art' }), /loom's own machine/);
  assert.throws(() => setDrill(env, fx, { name: 'one', agent: 'nobody' }), /isn't an agent here/);
  for (const h of ['h-2', 'h-3', 'h-4', 'h-5', 'h-99']) assert.throws(() => setDrill(env, fx, { name: 'one', agent: 'art', houses: [h] }), /isn't a live house of art's/, h);
  assert.throws(() => setDrill(env, fx, { name: 'one', agent: 'art', forMs: DRILL_MAX_MS + 60_000 }), /1 to 60 minutes/);
  assert.throws(() => setDrill(env, fx, { name: 'one', agent: 'art', forMs: 0 }), /1 to 60 minutes/);
  assert.equal(load(env).boxes[idOf('one')].drill, undefined, 'nothing set by a refused one');
  const d = setDrill(env, fx, { name: 'one', agent: 'art', houses: ['h-1'], forMs: 15 * 60_000 }).drill;
  assert.deepEqual(d.houses, ['h-1']);
  assert.equal(d.until, new Date(T0 + 15 * 60_000).toISOString());
  assert.equal(boxUp(load(env).boxes[idOf('one')], T0, 'art'), false);
  assert.equal(boxUp(load(env).boxes[idOf('one')], T0, 'mark'), true, 'another agent\'s placement doesn\'t see it');
  clock = T0 + 15 * 60_000 + 1; seen('one');
  assert.equal(boxUp(load(env).boxes[idOf('one')], clock, 'art'), true, 'over by itself');
  clock = T0;
  assert.equal(endDrill(env, fx, { name: 'one' }).ended, true);
  assert.equal(boxUp(load(env).boxes[idOf('one')], T0, 'art'), true);
});

test('during a drill the agent\'s new bodies and houses go to the next box that\'s up; another agent\'s don\'t move', async () => {
  mkdirSync(env.LOOM_BOX_DATA, { recursive: true });
  const s = () => load(env);
  assert.deepEqual(bodyBox(s(), 'art', 'claude', env, T0), { box: idOf('one') });
  setDrill(env, fx, { name: 'one', agent: 'art' });
  setDrill(env, fx, { name: 'wunder', agent: 'art' });
  assert.deepEqual(bodyBox(s(), 'art', 'claude', env, T0), { box: 'loom' }, 'one and wunder drilled: loom\'s own');
  assert.deepEqual(bodyBox(s(), 'mark', 'claude', env, T0), { box: idOf('one') });
  assert.equal(ok(call(owner, 'up', { agent: 'art', task: 'a' })).box, 'loom');
  endDrill(env, fx, { name: 'wunder' });
  assert.deepEqual(bodyBox(s(), 'art', 'claude', env, T0), { box: idOf('wunder') });
  endDrill(env, fx, { name: 'one' });
  assert.deepEqual(bodyBox(s(), 'art', 'claude', env, T0), { box: idOf('one') }, 'restored');
});

test('the agent\'s warm house on a drilled box drains though its host still reports, and the next body\'s house goes to the next box', async () => {
  mkdirSync(env.LOOM_BOX_DATA, { recursive: true });
  const asked = [];
  const upFn = (e, f, who, b) => {
    const id = `h-${asked.length + 1}`;
    asked.push(b.box);
    update(env, (s) => { s.houses[id] = { id, agent: 'art', box: b.box, state: 'running', task: b.task, kind: 'body-host', seat: 'owner' }; });
    return { id };
  };
  const hr = new HouseRunner(env, 'claude', { poll: 5, warmMs: 60, up: upFn, now: () => new Date(clock) });
  await assert.rejects(hr.warm('art'), /didn't start its body host/);
  assert.deepEqual(asked, [idOf('one')]);
  setDrill(env, fx, { name: 'one', agent: 'art' });
  setDrill(env, fx, { name: 'wunder', agent: 'art' });
  await assert.rejects(hr.warm('art'), /didn't start/);
  assert.deepEqual(asked, [idOf('one'), 'loom']);
  assert.equal(hostOf(env, 'art').house, 'h-2');
  assert.match(load(env).houses['h-1'].draining.reason, /its box one went quiet; new bodies go to loom/);
  assert.equal(load(env).houses['h-1'].state, 'running', 'drained, never written off by the drill itself');
});

test('a drill\'s card says it\'s a drill and names only its houses; his Allow writes them off and the box is told to stop them', async () => {
  const { askDarkBoxes, writeOffApproved, writeOffAsk } = await import('../src/dark-box.mjs');
  const h = houseWorld();
  const asked = [], spent = [], withdrawn = [], states = {};
  h.env.LOOM_RUNTIME_TEST_APPROVALS = { request: (target, x) => { asked.push([target, x]); const id = `a-0000000${asked.length}`; states[id] = 'pending'; return id; },
    withdraw: (id) => { withdrawn.push(id); states[id] = 'withdrawn'; }, state: (id) => states[id] ?? 'gone' };
  const spend = (e, id, kind, target, agent, o) => { spent.push([id, kind, target, agent, o?.onBehalf]); states[id] = 'used'; return ''; };
  const hfx = { now: () => new Date(), mint: () => 'loom_' + 't'.repeat(31), revoke: () => {} };
  assert.equal(api(h.env, hfx, { caller: owner, path: 'add-box', body: { name: 'far', mayHost: '*' } }).status, 200);
  const far = Object.entries(load(h.env).boxes).find(([, b]) => b.name === 'far')[0];
  update(h.env, (s) => {
    (s.agents ??= {}).art ??= { repo: 'https://github.com/x/art.git' };
    s.boxes[far].lastSeen = new Date().toISOString();
    for (const [id, agent] of [['h-7', 'art'], ['h-9', 'mark'], ['h-11', 'art']]) s.houses[id] = { id, agent, box: far, state: 'running' };
  });
  // Every house's own body host still reports: the box is in fact up.
  const hosts = join(h.env.LOOM_BOX_DATA, 'delivery', 'hosts');
  mkdirSync(hosts, { recursive: true });
  for (const [seat, house] of [['art@p-a', 'h-7'], ['mark@p-b', 'h-9'], ['art@p-c', 'h-11']]) writeFileSync(join(hosts, `${seat}.json`), JSON.stringify({ house, report: { at: Date.now(), house, bodies: {} } }));
  const convs = [{ conversation: 'cv-00000000000a', agent: 'art', body: 'claude:h-7-b0000001' }, { conversation: 'cv-00000000000c', agent: 'mark', body: 'claude:h-9-b0000003' },
    { conversation: 'cv-00000000000e', agent: 'art', body: 'claude:h-11-b0000005' }];
  // Before: an up box is never asked about.
  await askDarkBoxes(h.env, { convs });
  assert.equal(asked.length, 0);
  setDrill(h.env, hfx, { name: 'far', agent: 'art', houses: ['h-7'] });
  await askDarkBoxes(h.env, { convs });
  await askDarkBoxes(h.env, { convs });
  assert.equal(asked.length, 1, 'one card, once; mark\'s house and the house not in the drill aren\'t on it');
  const [target, card] = asked[0];
  assert.match(card.ask, /^Drill: pretend the box “far” went dark\. Carry on Art's conversation from there on another box\?$/);
  assert.ok(card.ask.length <= 140);
  assert.match(card.why, /failover test/);
  assert.match(card.details, /in a drill.*houses there: h-7;/);
  const aid = load(h.env).writeOffAsks[`art:${far}`].approval;
  const fields = { id: aid, agent: 'art', target };
  // Still only the household owner's Allow, never a body's.
  assert.equal(writeOffApproved({ ...h.env, HOUSE_ID: 'h-3' }, hfx, owner, fields, spend).ok, false);
  assert.equal(writeOffApproved(h.env, hfx, { kind: 'owner', agents: ['art'] }, fields, spend).ok, false);
  states[aid] = 'allowed';
  const r = writeOffApproved(h.env, hfx, owner, fields, spend);
  assert.equal(r.ok, true, r.message);
  assert.equal(spent.length, 1);
  const st = load(h.env);
  assert.equal(st.houses['h-7'].state, 'lost');
  assert.equal(st.houses['h-11'].state, 'running');
  assert.equal(st.houses['h-9'].state, 'running');
  // The box, still polling, is told to stop it at once.
  const polled = api(h.env, hfx, { caller: { kind: 'piece', subject: far }, path: 'poll', body: {} }).body;
  assert.ok(polled.stop.includes('h-7'));
  assert.ok(!polled.stop.includes('h-11'));
  assert.deepEqual(withdrawn, []);
  // A drill ended before he answers: the card no longer applies, and is taken back.
  update(h.env, (s) => { s.houses['h-15'] = { id: 'h-15', agent: 'art', box: far, state: 'running' }; });
  writeFileSync(join(hosts, 'art@p-d.json'), JSON.stringify({ house: 'h-15', report: { at: Date.now(), house: 'h-15', bodies: {} } }));
  const convs2 = [...convs, { conversation: 'cv-00000000000f', agent: 'art', body: 'claude:h-15-b0000006' }];
  await askDarkBoxes(h.env, { convs: convs2 });
  setDrill(h.env, hfx, { name: 'far', agent: 'art', houses: ['h-15'] });
  await askDarkBoxes(h.env, { convs: convs2 });
  await askDarkBoxes(h.env, { convs: convs2 });
  const second = load(h.env).writeOffAsks[`art:${far}`];
  assert.deepEqual(second.houses, ['h-15']);
  endDrill(h.env, hfx, { name: 'far' });
  assert.match(writeOffAsk(h.env, { agent: 'art', box: far, target: second.target, approval: second.approval }).why, /heard from/);
  await askDarkBoxes(h.env, { convs: convs2 });
  assert.ok(withdrawn.includes(second.approval));
  assert.equal(load(h.env).houses['h-15'].state, 'running');
});
