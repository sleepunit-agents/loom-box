// A house file asks for the box's own logins (house.json "logins"); only the box reads it, at claim. On 2026-11-18
// Claude went logged-out on box one and Mark's relay built 34 houses there in half an hour, every one failing "this
// box has no Claude login for mark's houses", none falling back to loom, the next box of his list (t-2318). The box now
// says which logins the house file asked for when it reports the house; placement passes over a box without them,
// to the next allowed box, or says at once, naming the login, that there's none.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { api, houseLoginsOf } from '../src/control.mjs';
import { bodyBox } from '../src/placement.mjs';
import { load, update } from '../src/state.mjs';
import { scratch } from './scratch.mjs';

const T0 = Date.parse('2026-11-18T19:43:00Z');
let env, fx;
const owner = { kind: 'owner' };
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const idOf = (name) => Object.entries(load(env).boxes).find(([, b]) => (b.name ?? '') === name || (b.local && name === 'loom'))?.[0];
const box = (name) => ({ kind: 'piece', subject: idOf(name) });
const logins = (name, { claude, codex }) => update(env, (s) => {
  const b = s.boxes[idOf(name)];
  b.lastSeen = new Date(T0).toISOString();
  b.harnesses = { claude: { installed: true, loggedIn: claude }, codex: { installed: true, loggedIn: codex } };
});

beforeEach(() => {
  env = { HOME: scratch('rt-hl-'), LOOM_BOX_LOCAL_NAME: 'loom' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  let n = 0;
  fx = { now: () => new Date(T0), mint: () => `loom_${'t'.repeat(30)}${n++}`, revoke: () => {}, secret: (x) => `v-${x}` };
  ok(call(owner, 'set-agent', { agent: 'mark', repo: 'https://github.com/x/mark.git' }));
  ok(call(owner, 'add-box', { name: 'one', mayHost: '*' }));
  // loom's own box, as the runtime there reports it.
  update(env, (s) => { s.boxes.loom ??= { local: true, mayHost: '*' }; });
  ok(call(owner, 'set-primary', { agent: 'mark', boxes: ['one', 'loom'] }));
  // one: Claude logged out, Codex in (2026-11-18). loom: both in.
  logins('one', { claude: false, codex: true });
  logins('loom', { claude: true, codex: true });
});

/** A house of mark's on one that the box claims, then fails for want of Claude: what box.mjs reports. */
function failOnOne() {
  const h = ok(call(owner, 'up', { agent: 'mark', task: 'relay' }));
  ok(call(box('one'), 'claim', { id: h.id }));
  ok(call(box('one'), 'report', { id: h.id, state: 'failed', logins: ['claude'], log: "the box couldn't start it: this box has no Claude login for mark's houses" }));
  return h;
}

test('before any box has read the house file, a house goes to the first box of the list, as it always did', () => {
  assert.deepEqual(houseLoginsOf(load(env), 'mark'), []);
  assert.equal(ok(call(owner, 'up', { agent: 'mark', task: 'a' })).box, idOf('one'));
});

test('once a box says the house file wants Claude, the next house passes over the logged-out box to the next allowed one', () => {
  const first = failOnOne();
  assert.equal(first.box, idOf('one'));
  assert.deepEqual(houseLoginsOf(load(env), 'mark'), ['claude']);
  // The second house, and every one after: loom, not one again.
  for (const task of ['b', 'c', 'd']) assert.equal(ok(call(owner, 'up', { agent: 'mark', task })).box, 'loom');
  // A body host (delivery's path, houserunner.mjs): the body's harness is Codex, which one has; the house still wants Claude.
  assert.equal(bodyBox(load(env), 'mark', 'codex', env, T0).box, 'loom');
  // Claude logged back in on one: one is first again.
  logins('one', { claude: true, codex: true });
  assert.equal(ok(call(owner, 'up', { agent: 'mark', task: 'e' })).box, idOf('one'));
  assert.equal(bodyBox(load(env), 'mark', 'codex', env, T0).box, idOf('one'));
});

test('with no allowed box logged in to it, placement fails at once and names the login', () => {
  failOnOne();
  logins('loom', { claude: false, codex: true });
  const r = call(owner, 'up', { agent: 'mark', task: 'b' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no box that may host mark has a Claude login mark may use, which its house file asks for/);
  const at = bodyBox(load(env), 'mark', 'codex', env, T0);
  assert.equal(at.box, undefined);
  assert.match(at.reason, /has a Claude login mark may use, which its house file asks for/);
  // No house was made for the refused start.
  assert.equal(Object.values(load(env).houses).filter((h) => h.agent === 'mark').length, 1);
});

test('a house file that stops asking for a login is taken at its word on the next report; a box named outright is not second-guessed', () => {
  failOnOne();
  const h = ok(call(owner, 'up', { agent: 'mark', box: 'one', task: 'named' }));
  assert.equal(h.box, idOf('one'));
  ok(call(box('one'), 'claim', { id: h.id }));
  ok(call(box('one'), 'report', { id: h.id, state: 'running', logins: [] }));
  assert.deepEqual(houseLoginsOf(load(env), 'mark'), []);
  assert.equal(ok(call(owner, 'up', { agent: 'mark', task: 'after' })).box, idOf('one'));
});

test('a report\'s logins are only logins loom knows; anything else leaves what it had', () => {
  const h2 = ok(call(owner, 'up', { agent: 'mark', task: 'b' }));
  ok(call(box('one'), 'claim', { id: h2.id }));
  ok(call(box('one'), 'report', { id: h2.id, state: 'failed', logins: ['claude', 'nonsense'] }));
  assert.deepEqual(houseLoginsOf(load(env), 'mark'), []);
});
