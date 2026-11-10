// An agent's boxes, in order (t-2048): the owner sets an ordered list per agent (art: one, then wunder, then loom).
// Houses and bodies go to the first box of it that's up (heard from in PLACE_UP_MS) and may run them; when that box
// goes quiet, new bodies go to the next one, and the agent's warm house on the quiet box drains (its own bodies are
// held, never written off). A single primary set before the list is a list of one, and behaves as it always did.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLACE_UP_MS, api, boxUp, preferenceOf, primaryOf, setAgent } from '../src/control.mjs';
import { bodyBox } from '../src/placement.mjs';
import { HouseRunner, hostOf } from '../src/houserunner.mjs';
import { act } from '../src/ui.mjs';
import { load, update } from '../src/state.mjs';
import { scratch } from './scratch.mjs';

const T0 = Date.parse('2026-11-09T20:00:00Z');
let env, fx, clock;
const owner = { kind: 'owner' };
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const idOf = (name) => Object.entries(load(env).boxes).find(([, b]) => (b.name ?? '') === name || (b.local && name === 'loom'))?.[0];
const seen = (name, ms = 0) => update(env, (s) => { s.boxes[idOf(name)].lastSeen = new Date(T0 - ms).toISOString(); });

beforeEach(() => {
  env = { HOME: scratch('rt-pref-'), LOOM_BOX_LOCAL_NAME: 'loom' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  clock = T0;
  let n = 0;
  fx = { now: () => new Date(clock), mint: () => `loom_${'t'.repeat(30)}${n++}`, revoke: () => {}, secret: (x) => `v-${x}` };
  ok(call(owner, 'set-agent', { agent: 'art', repo: 'https://github.com/x/art.git' }));
  ok(call(owner, 'set-agent', { agent: 'mark', repo: 'https://github.com/x/mark.git' }));
  for (const name of ['one', 'wunder']) ok(call(owner, 'add-box', { name, mayHost: '*' }));
});

test('the owner sets an ordered list; the CLI and API take it as a list or as text, and one box as before', () => {
  const r = ok(call(owner, 'set-primary', { agent: 'art', boxes: ['one', 'wunder', 'loom'] }));
  assert.deepEqual(r.boxes, [idOf('one'), idOf('wunder'), 'loom']);
  assert.deepEqual(preferenceOf(load(env), 'art', env), [idOf('one'), idOf('wunder'), 'loom']);
  ok(call(owner, 'set-primary', { agent: 'mark', boxes: 'one, wunder loom' }));
  assert.deepEqual(preferenceOf(load(env), 'mark', env), [idOf('one'), idOf('wunder'), 'loom']);
  // One box, as before: stored as it always was, a name not a list.
  ok(call(owner, 'set-primary', { agent: 'mark', box: 'wunder' }));
  assert.equal(load(env).primaries.mark, idOf('wunder'));
  // Nothing, or just loom's own box: cleared.
  ok(call(owner, 'set-primary', { agent: 'mark', boxes: [] }));
  assert.equal(load(env).primaries.mark, undefined);
  assert.equal(call(owner, 'set-primary', { agent: 'art', boxes: ['one', 'one'] }).status, 400, 'a box twice');
  assert.equal(call(owner, 'set-primary', { agent: 'art', boxes: ['one', 'nowhere'] }).status, 404);
  assert.equal(call({ kind: 'agent', agent: 'art' }, 'set-primary', { agent: 'art', boxes: ['wunder'] }).status, 403, 'the owner\'s only');
  ok(call(owner, 'may-host', { name: 'wunder', mayHost: 'mark' }));
  assert.equal(call(owner, 'set-primary', { agent: 'art', boxes: ['one', 'wunder'] }).status, 409, 'a box that may not host it');
});

test('a house goes to the first box of the list that\'s up; a quiet box is passed by, and taken again when it\'s back', () => {
  ok(call(owner, 'set-primary', { agent: 'art', boxes: ['one', 'wunder', 'loom'] }));
  seen('one'); seen('wunder');
  assert.equal(ok(call(owner, 'up', { agent: 'art', task: 'a' })).box, idOf('one'));
  // one goes quiet: past PLACE_UP_MS, the next house goes to wunder.
  seen('one', PLACE_UP_MS + 1000);
  assert.equal(boxUp(load(env).boxes[idOf('one')], T0), false);
  assert.equal(ok(call(owner, 'up', { agent: 'art', task: 'b' })).box, idOf('wunder'));
  // Both quiet: loom's own box, which is always up.
  seen('wunder', PLACE_UP_MS + 1000);
  assert.equal(ok(call(owner, 'up', { agent: 'art', task: 'c' })).box, 'loom');
  // one is back.
  seen('one');
  assert.equal(ok(call(owner, 'up', { agent: 'art', task: 'd' })).box, idOf('one'));
  // A box named outright is never second-guessed.
  assert.equal(ok(call(owner, 'up', { agent: 'art', box: 'wunder', task: 'e' })).box, idOf('wunder'));
});

test('a primary set before the list: a list of one, used even before its box is heard from (it waits for it)', () => {
  ok(call(owner, 'set-primary', { agent: 'art', box: 'one' }));
  assert.equal(ok(call(owner, 'up', { agent: 'art', task: 'a' })).box, idOf('one'));
  assert.equal(primaryOf(load(env), 'art', env, T0), idOf('one'));
});

test('revoking a box takes it out of every list', () => {
  ok(call(owner, 'set-primary', { agent: 'art', boxes: ['one', 'wunder', 'loom'] }));
  ok(call(owner, 'set-primary', { agent: 'mark', boxes: ['one', 'wunder'] }));
  ok(call(owner, 'revoke-box', { name: 'one' }));
  assert.deepEqual(load(env).primaries.art, [idOf('wunder'), 'loom']);
  assert.equal(load(env).primaries.mark, idOf('wunder'));
});

test('a body goes to the first box of the list that\'s up and logged in to its harness', () => {
  ok(call(owner, 'set-primary', { agent: 'art', boxes: ['one', 'wunder', 'loom'] }));
  update(env, (s) => { for (const b of Object.values(s.boxes)) b.harnesses = { claude: { loggedIn: true } }; });
  seen('one'); seen('wunder');
  const s = () => load(env);
  assert.deepEqual(bodyBox(s(), 'art', 'claude', env, T0), { box: idOf('one') });
  seen('one', PLACE_UP_MS + 1000);
  assert.deepEqual(bodyBox(s(), 'art', 'claude', env, T0), { box: idOf('wunder') });
  // wunder isn't logged in to codex: a codex body skips it.
  update(env, (st) => { st.boxes[idOf('wunder')].harnesses = { claude: { loggedIn: true } }; for (const id of [idOf('one'), 'loom']) st.boxes[id].harnesses.codex = { loggedIn: true }; });
  assert.deepEqual(bodyBox(s(), 'art', 'codex', env, T0), { box: 'loom' });
  // Nothing up that may run it: the first that may, which it waits for.
  update(env, (st) => { st.boxes.loom.harnesses = {}; });
  assert.deepEqual(bodyBox(s(), 'art', 'codex', env, T0), { box: idOf('one') });
});

test('the agent\'s warm house on a box gone quiet drains, and the next body asks for a house on the next box', async () => {
  mkdirSync(env.LOOM_BOX_DATA, { recursive: true });
  ok(call(owner, 'set-primary', { agent: 'art', boxes: ['one', 'wunder', 'loom'] }));
  update(env, (s) => { for (const b of Object.values(s.boxes)) b.harnesses = { claude: { loggedIn: true } }; });
  seen('one'); seen('wunder');
  const asked = [];
  const upFn = (e, f, who, b) => {
    const id = `h-${asked.length + 1}`;
    asked.push(b.box);
    update(env, (s) => { s.houses[id] = { id, agent: 'art', box: b.box, state: 'running', task: b.task, kind: 'body-host', seat: 'owner' }; });
    return { id };
  };
  const hr = new HouseRunner(env, 'claude', { poll: 5, warmMs: 60, up: upFn, now: () => new Date(clock) });
  await assert.rejects(hr.warm('art'), /didn't start its body host/);
  assert.deepEqual(asked, [idOf('one')], 'its first house: on one');
  // While one is heard from, its house keeps the agent's record, reporting or not.
  await assert.rejects(hr.warm('art'), /didn't start/);
  assert.deepEqual(asked, [idOf('one')]);
  assert.equal(hostOf(env, 'art').house, 'h-1');
  // one goes quiet: its house drains (kept, with whatever it holds), and a fresh one is asked for on wunder.
  seen('one', PLACE_UP_MS + 1000);
  await assert.rejects(hr.warm('art'), /didn't start/);
  assert.deepEqual(asked, [idOf('one'), idOf('wunder')]);
  assert.equal(hostOf(env, 'art').house, 'h-2');
  assert.match(load(env).houses['h-1'].draining.reason, /its box one went quiet; new bodies go to wunder/);
  assert.equal(load(env).houses['h-1'].state, 'running', 'never written off: the box may come back');
});

test('the agent page shows its boxes in order and where it runs; the owner saves a new order there', () => {
  ok(call(owner, 'set-primary', { agent: 'art', boxes: ['one', 'wunder', 'loom'] }));
  const r = act(env, fx, { action: 'set-primary', fields: { agent: 'art', first: idOf('wunder'), second: idOf('one'), third: '' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.message, /art runs on wunder, then one: the first that's up/);
  assert.deepEqual(load(env).primaries.art, [idOf('wunder'), idOf('one')]);
});

test('an agent with one primary keeps its house when that box goes quiet: no drain to a box it never listed', async () => {
  mkdirSync(env.LOOM_BOX_DATA, { recursive: true });
  ok(call(owner, 'set-primary', { agent: 'art', box: 'one' }));
  update(env, (s) => { for (const b of Object.values(s.boxes)) b.harnesses = { claude: { loggedIn: true } }; });
  seen('one'); seen('wunder');
  const asked = [];
  const upFn = (e, f, who, b) => {
    const id = `h-${asked.length + 1}`;
    asked.push(b.box);
    update(env, (s) => { s.houses[id] = { id, agent: 'art', box: b.box, state: 'running', task: b.task, kind: 'body-host', seat: 'owner' }; });
    return { id };
  };
  const hr = new HouseRunner(env, 'claude', { poll: 5, warmMs: 60, up: upFn, now: () => new Date(clock) });
  await assert.rejects(hr.warm('art'), /didn't start/);
  seen('one', PLACE_UP_MS + 1000);
  await assert.rejects(hr.warm('art'), /didn't start/);
  assert.deepEqual(asked, [idOf('one')], 'wunder is up, but art never listed it');
  assert.equal(load(env).houses['h-1'].draining, undefined);
});

test('a warm house on a box behind the first one up drains, even while its own box is up, and new bodies go first (t-2070)', async () => {
  mkdirSync(env.LOOM_BOX_DATA, { recursive: true });
  ok(call(owner, 'set-primary', { agent: 'art', boxes: ['one', 'loom'] }));
  update(env, (s) => { for (const b of Object.values(s.boxes)) b.harnesses = { claude: { loggedIn: true } }; });
  seen('one', PLACE_UP_MS + 1000); seen('wunder');
  const asked = [];
  const upFn = (e, f, who, b) => {
    const id = `h-${asked.length + 1}`;
    asked.push(b.box);
    update(env, (s) => { s.houses[id] = { id, agent: 'art', box: b.box, state: 'running', task: b.task, kind: 'body-host', seat: 'owner' }; });
    return { id };
  };
  const hr = new HouseRunner(env, 'claude', { poll: 5, warmMs: 60, up: upFn, now: () => new Date(clock) });
  await assert.rejects(hr.warm('art'), /didn't start/);
  assert.deepEqual(asked, ['loom'], 'one is quiet: its house goes to loom');
  // one is back: loom's house takes no new body, and the next asks for a house on one.
  seen('one');
  await assert.rejects(hr.warm('art'), /didn't start/);
  assert.deepEqual(asked, ['loom', idOf('one')]);
  assert.equal(hostOf(env, 'art').house, 'h-2');
  assert.match(load(env).houses['h-1'].draining.reason, /one is ahead of loom in art's boxes; new bodies go there/);
  assert.equal(load(env).houses['h-1'].state, 'running', 'its bodies finish there; it idles out the usual way');
  // Once on the first box, it stays: nothing ahead of it.
  await assert.rejects(hr.warm('art'), /didn't start/);
  assert.deepEqual(asked, ['loom', idOf('one')]);
});

test('an order changed while a warm house runs on the old first box: the next body goes to the new first (t-2070)', async () => {
  mkdirSync(env.LOOM_BOX_DATA, { recursive: true });
  update(env, (s) => { for (const b of Object.values(s.boxes)) b.harnesses = { claude: { loggedIn: true } }; });
  seen('one'); seen('wunder');
  ok(call(owner, 'set-primary', { agent: 'art', boxes: ['wunder', 'one'] }));
  const asked = [];
  const upFn = (e, f, who, b) => {
    const id = `h-${asked.length + 1}`;
    asked.push(b.box);
    update(env, (s) => { s.houses[id] = { id, agent: 'art', box: b.box, state: 'running', task: b.task, kind: 'body-host', seat: 'owner' }; });
    return { id };
  };
  const hr = new HouseRunner(env, 'claude', { poll: 5, warmMs: 60, up: upFn, now: () => new Date(clock) });
  await assert.rejects(hr.warm('art'), /didn't start/);
  assert.deepEqual(asked, [idOf('wunder')]);
  ok(call(owner, 'set-primary', { agent: 'art', boxes: ['one', 'wunder'] }));
  await assert.rejects(hr.warm('art'), /didn't start/);
  assert.deepEqual(asked, [idOf('wunder'), idOf('one')]);
  // A box the agent's body can't run on (no login) is never a reason to leave.
  ok(call(owner, 'set-primary', { agent: 'art', boxes: ['wunder', 'one'] }));
  update(env, (s) => { s.boxes[idOf('wunder')].harnesses = {}; });
  await assert.rejects(hr.warm('art'), /didn't start/);
  assert.deepEqual(asked, [idOf('wunder'), idOf('one')]);
});
