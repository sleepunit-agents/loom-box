// A work role's needs (t-2092): a job of a role that needs something of its box (gpu:5090, a label) runs only on a box
// that has it, in a house of its own seat kept apart from the seat's plain house; or it's refused with what's missing,
// never placed blind. The seat boundary is unchanged: a needs house is one seat's, and the cap counts seats.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { api } from '../src/control.mjs';
import { bodyBox } from '../src/placement.mjs';
import { HouseRunner, hostOf, seatRoom } from '../src/houserunner.mjs';
import { HOST_KEY, hostKeyOf, needsKey, seatCapProblem, seatOfKey } from '../src/principal.mjs';
import { checkRole, setModels, setRole, roleOf } from '../src/models.mjs';
import { act, page } from '../src/ui.mjs';
import { load, update } from '../src/state.mjs';
import { scratch } from './scratch.mjs';

const T0 = Date.parse('2026-11-10T12:00:00Z');
let env, fx;
const owner = { kind: 'owner' };
const call = (path, body = {}) => api(env, fx, { caller: owner, path, body });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const idOf = (name) => Object.entries(load(env).boxes).find(([, b]) => (b.name ?? '') === name)?.[0];

beforeEach(() => {
  env = { HOME: scratch('rt-needs-'), LOOM_BOX_LOCAL_NAME: 'loom' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  mkdirSync(env.LOOM_BOX_DATA, { recursive: true });
  let n = 0;
  fx = { now: () => new Date(T0), mint: () => `loom_${'t'.repeat(30)}${n++}`, revoke: () => {}, secret: (x) => `v-${x}` };
  ok(call('set-agent', { agent: 'art', repo: 'https://github.com/x/art.git' }));
  for (const name of ['one', 'rig']) ok(call('add-box', { name, mayHost: '*' }));
  update(env, (s) => {
    for (const b of Object.values(s.boxes)) { b.harnesses = { claude: { loggedIn: true } }; b.lastSeen = new Date(T0).toISOString(); }
    s.boxes[idOf('rig')].facts = ['gpu:nvidia-geforce-rtx-5090', 'disk:2tb'];
  });
  ok(call('set-primary', { agent: 'art', boxes: ['one', 'rig'] }));
});

test('placement: with needs, only a box that has them all; none, and it says what is missing', () => {
  const s = load(env);
  assert.deepEqual(bodyBox(s, 'art', 'claude', env, T0), { box: idOf('one') });
  assert.deepEqual(bodyBox(s, 'art', 'claude', env, T0, ['gpu:5090']), { box: idOf('rig') });
  assert.match(bodyBox(s, 'art', 'claude', env, T0, ['gpu:h100']).reason, /no box that may run art's claude bodies has gpu:h100/);
  update(env, (st) => { st.boxes[idOf('one')].facts = ['tpu']; });
  assert.match(bodyBox(load(env), 'art', 'claude', env, T0, ['gpu:5090', 'tpu']).reason, /no one box .* has all of gpu:5090, tpu/);
});

test('host keys: a seat, or a seat and its needs; the needs never change whose seat it is', () => {
  assert.equal(hostKeyOf('owner', []), 'owner');
  const k = hostKeyOf('p-loren', ['gpu:5090', 'disk:2tb']);
  assert.equal(k, hostKeyOf('p-loren', ['disk:2tb', 'gpu:5090']), 'order does not matter');
  assert.match(k, /^p-loren~[0-9a-f]{10}$/);
  assert.equal(seatOfKey(k), 'p-loren');
  assert.ok(HOST_KEY.test(k));
  assert.ok(!HOST_KEY.test('p-loren~zz'), 'only a hash');
  assert.ok(!HOST_KEY.test('owner~abc/../x'));
  assert.equal(needsKey([]), '');
});

test('a job needing a GPU warms a house of its own on the box that has one; the seat\'s plain house is untouched', async () => {
  const asked = [];
  const upFn = (e, f, who, b, own) => {
    const id = `h-${asked.length + 1}`;
    asked.push({ box: b.box, needs: b.needs, seat: own.seat });
    update(env, (s) => { s.houses[id] = { id, agent: 'art', box: b.box, state: 'running', task: b.task, kind: 'body-host', seat: own.seat, ...(b.needs ? { needs: b.needs } : {}) }; });
    return { id };
  };
  const hr = new HouseRunner(env, 'claude', { poll: 5, warmMs: 40, up: upFn, now: () => new Date(T0) });
  await assert.rejects(hr.warm('art'), /didn't start its body host/);
  const key = hostKeyOf('owner', ['gpu:5090']);
  await assert.rejects(hr.warm('art', key, ['gpu:5090']), /didn't start its body host/);
  assert.deepEqual(asked, [{ box: idOf('one'), needs: undefined, seat: 'owner' }, { box: idOf('rig'), needs: ['gpu:5090'], seat: 'owner' }], 'the house\'s seat is the plain seat');
  assert.equal(hostOf(env, 'art').house, 'h-1');
  assert.equal(hostOf(env, 'art', key).house, 'h-2');
  assert.ok(existsSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts', `art@${key}.json`)));
  // A key whose needs don't match what's asked: refused, never a house for the wrong needs.
  await assert.rejects(hr.warm('art', key, ['gpu:h100']), /key and its needs disagree/);
  // Nowhere that has it: refused with what's missing, no house asked.
  await assert.rejects(hr.warm('art', hostKeyOf('owner', ['gpu:h100']), ['gpu:h100']), /has gpu:h100/);
  assert.equal(asked.length, 2);
});

test('the cap counts seats: a person\'s needs house and their plain house are one seat', () => {
  update(env, (s) => {
    s.houses['h-7'] = { id: 'h-7', agent: 'art', box: idOf('one'), state: 'running', task: 't', kind: 'body-host', seat: 'p-loren' };
    s.houses['h-8'] = { id: 'h-8', agent: 'art', box: idOf('rig'), state: 'running', task: 't', kind: 'body-host', seat: 'p-loren', needs: ['gpu:5090'] };
  });
  env.LOOM_RUNTIME_SEAT_HOUSES = '2';
  assert.equal(seatCapProblem(env, load(env), 'art', 'p-mark'), null, 'one other seat: room for a second');
  assert.equal(seatRoom(env, 'art', hostKeyOf('p-mark', ['gpu:5090'])), null);
  update(env, (s) => { s.houses['h-9'] = { id: 'h-9', agent: 'art', box: idOf('one'), state: 'running', task: 't', kind: 'body-host', seat: 'p-ann' }; });
  assert.match(seatRoom(env, 'art', hostKeyOf('p-mark', ['gpu:5090'])), /cap is 2/, 'a needs house is still a house for other people');
  assert.equal(seatRoom(env, 'art', hostKeyOf('owner', ['gpu:5090'])), null, 'the owner\'s never waits');
});

test('roles: needs are box facts; an older role\'s words are kept as its note; the page edits both', () => {
  setModels(env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }] });
  const list = [{ id: 'opus', harness: 'claude', family: 'anthropic' }];
  assert.deepEqual(checkRole(list, { id: 'gpu', description: 'x', models: ['opus'], needs: ['gpu:5090'] }).needs, ['gpu:5090']);
  const old = checkRole(list, { id: 'big', description: 'x', models: ['opus'], needs: 'a long context' });
  assert.equal(old.needs, undefined);
  assert.equal(old.note, 'a long context');
  assert.throws(() => checkRole(list, { id: 'bad', description: 'x', models: ['opus'], needs: ['GPU 5090!'] }), /isn't a box fact/);
  setRole(env, { role: { id: 'render', description: 'Render frames', models: ['opus'], needs: ['gpu:5090'] } });
  assert.deepEqual(roleOf(load(env), 'render').needs, ['gpu:5090']);
  const roles = () => page(env, { path: '' }).sections.find((s) => s.id === 'roles');
  const row = roles().blocks[0].rows.find((r) => r.label === 'render');
  assert.match(row.detail, /Runs on a box with gpu:5090/);
  assert.equal(row.edit.fields.find((f) => f.name === 'needs').value, 'gpu:5090');
  const r = act(env, fx, { action: 'role-set', fields: { ...row.edit.hidden, description: 'Render frames', models: 'opus', needs: 'gpu:5090, disk:2tb', note: 'big scenes', failover: 'no' } });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(roleOf(load(env), 'render').needs, ['gpu:5090', 'disk:2tb']);
  assert.equal(roleOf(load(env), 'render').note, 'big scenes');
});

test('a launch carries its needs: its house is the needs house, on the box that has them', async () => {
  const asked = [];
  const upFn = (e, f, who, b, own) => {
    const id = `h-${asked.length + 1}`;
    asked.push(b.box);
    update(env, (s) => { s.houses[id] = { id, agent: 'art', box: b.box, state: 'running', task: b.task, kind: 'body-host', seat: own.seat }; });
    return { id };
  };
  const hr = new HouseRunner(env, 'claude', { poll: 5, warmMs: 40, up: upFn, now: () => new Date(T0) });
  await assert.rejects(hr.launch({ agent: 'art', model: 'opus', brief: 'x', seat: 'p-loren', needs: ['gpu:5090'] }), /didn't start its body host/);
  assert.deepEqual(asked, [idOf('rig')]);
  assert.equal(hostOf(env, 'art', hostKeyOf('p-loren', ['gpu:5090'])).house, 'h-1');
  assert.equal(hostOf(env, 'art', 'p-loren').house, undefined, 'the person\'s plain house is not this one');
  assert.equal(load(env).houses['h-1'].seat, 'p-loren');
});
