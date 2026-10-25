// Services (loom docs/specs/runtime.md, "Decided 2026-10-25"): a long-lived
// house, kept up and restarted, and never two at once anywhere. Pins that
//  - a move is a hand-off: the new box gets nothing until the old box says
//    its house stopped, and then gets the state the old one saved;
//  - a crash restarts it, slower each time; a service taken down stays down;
//  - a forced move is the owner's call, and writes the old house off;
//  - a service's house can't be stopped as a plain house behind its back.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from '../src/control.mjs';

let env, fx, revoked, clock;
const owner = { kind: 'owner' };
const art = { kind: 'agent', agent: 'art' };
const box = (subject) => ({ kind: 'piece', subject });
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const live = () => ok(call(owner, 'list')).houses.filter((h) => ['wanted', 'starting', 'running', 'stopping'].includes(h.state));
const svc = () => ok(call(owner, 'list')).services[0];

beforeEach(() => {
  env = { HOME: mkdtempSync(join(tmpdir(), 'loom-box-svc-')), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  revoked = [];
  clock = Date.parse('2026-10-25T04:00:00Z');
  fx = { now: () => new Date(clock), mint: () => 'loom_' + 'x'.repeat(30), revoke: (l) => revoked.push(l), secret: (n) => `v:${n}` };
  ok(call(owner, 'set-agent', { agent: 'art', repo: 'https://x/art.git' }));
  ok(call(owner, 'add-box', { name: 'laptop' }));
});

function run(boxName) {
  const p = ok(call(box(boxName), 'poll'));
  assert.equal(p.start.length, 1, `${boxName} should have one to start: ${JSON.stringify(p)}`);
  const h = p.start[0];
  const c = ok(call(box(boxName), 'claim', { id: h.id }));
  ok(call(box(boxName), 'report', { id: h.id, state: 'running' }));
  return { h, c };
}

test('a move is a hand-off: nothing on the new box until the old one says it stopped, then the saved state', () => {
  ok(call(art, 'service-up', { name: 'discord' }));
  const { h, c } = run('one');
  assert.equal(h.service, 'discord');
  assert.equal(c.state, null);
  const m = ok(call(owner, 'service-move', { agent: 'art', name: 'discord', box: 'laptop' }));
  assert.deepEqual([m.moving, m.moveTo], [true, 'laptop']);
  // The old box is told to stop it; the new box has nothing yet.
  assert.deepEqual(ok(call(box('one'), 'poll')).stop, [h.id]);
  assert.deepEqual(ok(call(box('laptop'), 'poll')).start, []);
  assert.equal(live().length, 1);
  // It saves its state and says it stopped.
  ok(call(box('one'), 'save-state', { id: h.id, state: Buffer.from('cursor=42').toString('base64') }));
  ok(call(box('one'), 'report', { id: h.id, state: 'stopped' }));
  // Now, and only now, the laptop gets it, with that state.
  const next = run('laptop');
  assert.equal(Buffer.from(next.c.state, 'base64').toString(), 'cursor=42');
  assert.deepEqual([svc().box, svc().moveTo, live().length], ['laptop', null, 1]);
});

test('a crash restarts it on the same box, slower each time; down stays down', () => {
  ok(call(art, 'service-up', { name: 'discord' }));
  const a = run('one').h;
  ok(call(box('one'), 'report', { id: a.id, state: 'failed', exit: 1 }));
  // Back off: not offered again until the delay has passed.
  assert.deepEqual(ok(call(box('one'), 'poll')).start, []);
  clock += 6_000;
  const b = run('one').h;
  ok(call(box('one'), 'report', { id: b.id, state: 'failed', exit: 1 }));
  clock += 6_000;
  assert.deepEqual(ok(call(box('one'), 'poll')).start, [], 'the second restart waits longer');
  clock += 6_000;
  const c = run('one').h;
  assert.equal(svc().restarts, 2);
  ok(call(art, 'service-down', { name: 'discord' }));
  assert.deepEqual(ok(call(box('one'), 'poll')).stop, [c.id]);
  ok(call(box('one'), 'report', { id: c.id, state: 'stopped' }));
  clock += 600_000;
  assert.deepEqual(ok(call(box('one'), 'poll')).start, []);
  assert.equal(svc().want, 'down');
});

test('one live house per service, whatever is asked', () => {
  ok(call(art, 'service-up', { name: 'discord' }));
  ok(call(art, 'service-up', { name: 'discord' }));
  assert.equal(live().length, 1);
  const { h } = run('one');
  // A plain stop of the service's house is refused: it would just restart.
  assert.equal(call(owner, 'down', { id: h.id }).status, 409);
  ok(call(owner, 'service-move', { agent: 'art', name: 'discord', box: 'laptop' }));
  ok(call(owner, 'service-move', { agent: 'art', name: 'discord', box: 'laptop' }));
  assert.equal(live().length, 1);
  // Changing its mind mid-move still waits for the same stop.
  ok(call(owner, 'service-move', { agent: 'art', name: 'discord', box: 'one' }));
  assert.equal(live().length, 1);
});

test('a waiting service just moves; a forced move is the owner\'s and writes the old house off', () => {
  ok(call(art, 'service-up', { name: 'discord' }));
  const m = ok(call(art, 'service-move', { name: 'discord', box: 'laptop' }));
  assert.equal(m.moving, false);
  assert.deepEqual(ok(call(box('one'), 'poll')).start, []);
  const { h } = run('laptop');
  // The laptop goes dark mid-run.
  assert.equal(call(art, 'service-move', { name: 'discord', box: 'one', force: true }).status, 403);
  const f = ok(call(owner, 'service-move', { agent: 'art', name: 'discord', box: 'one', force: true }));
  assert.equal(f.forced, true);
  assert.deepEqual(revoked, [`art · house ${h.id} on laptop`]);
  assert.equal(ok(call(owner, 'list')).houses.find((x) => x.id === h.id).state, 'lost');
  run('one');
});

test('state is saved only by the house\'s own box, within loom\'s body cap', () => {
  ok(call(art, 'service-up', { name: 'discord' }));
  const { h } = run('one');
  assert.equal(call(box('laptop'), 'save-state', { id: h.id, state: 'AAAA' }).status, 404);
  assert.equal(call(box('one'), 'save-state', { id: h.id, state: 'A'.repeat(800_000) }).status, 413);
  assert.equal(call(box('one'), 'save-state', { id: h.id, state: 'not base64!' }).status, 413);
  ok(call(box('one'), 'save-state', { id: h.id, state: 'AAAA' }));
});
