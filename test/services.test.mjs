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
import { MAX_PARTS, PART_RAW, joinParts, partsOf } from '../src/blobs.mjs';
import { load, update } from '../src/state.mjs';
import { scratch } from './scratch.mjs';

let env, fx, revoked, clock;
const owner = { kind: 'owner' };
const art = { kind: 'agent', agent: 'art' };
// A box is called by its name here; loom knows it by its id (a live one first, else the revoked one).
const idOf = (name) => {
  const all = Object.entries(load(env).boxes).filter(([id, b]) => (b.name ?? id) === name);
  return (all.find(([, b]) => !b.revoked) ?? all[0])?.[0] ?? name;
};
const box = (name) => ({ kind: 'piece', subject: idOf(name) });
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const live = () => ok(call(owner, 'list')).houses.filter((h) => ['wanted', 'starting', 'running', 'stopping'].includes(h.state));
const svc = () => ok(call(owner, 'list')).services[0];

beforeEach(() => {
  env = { HOME: scratch('loom-box-svc-'), LOOM_BOX_LOCAL_NAME: 'one' };
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
  assert.deepEqual([m.moving, m.moveTo], [true, idOf('laptop')]);
  // The old box is told to stop it; the new box has nothing yet.
  assert.deepEqual(ok(call(box('one'), 'poll')).stop, [h.id]);
  assert.deepEqual(ok(call(box('laptop'), 'poll')).start, []);
  assert.equal(live().length, 1);
  // It saves its state and says it stopped.
  ok(call(box('one'), 'save-state', { id: h.id, state: Buffer.from('cursor=42').toString('base64') }));
  ok(call(box('one'), 'report', { id: h.id, state: 'stopped' }));
  // Now, and only now, the laptop gets it, with that state (a part at a time, between claim and start).
  const p = ok(call(box('laptop'), 'poll')).start[0];
  const c2 = ok(call(box('laptop'), 'claim', { id: p.id }));
  assert.deepEqual([c2.state.bytes, c2.state.parts], [9, 1]);
  assert.equal(call(box('one'), 'state-part', { id: p.id, part: 0 }).status, 404, 'only the box that claimed it');
  assert.equal(Buffer.from(ok(call(box('laptop'), 'state-part', { id: p.id, part: 0 })).data, 'base64').toString(), 'cursor=42');
  ok(call(box('laptop'), 'report', { id: p.id, state: 'running' }));
  assert.equal(call(box('laptop'), 'state-part', { id: p.id, part: 0 }).status, 409, 'once it runs, its starting state is no longer handed out');
  const next = { h: p };
  assert.deepEqual([svc().box, svc().moveTo, live().length], [idOf('laptop'), null, 1]);
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

test('a big state travels in parts, and only a complete one replaces the last', () => {
  ok(call(art, 'service-up', { name: 'slack' }));
  const { h } = run('one');
  ok(call(box('one'), 'save-state', { id: h.id, state: Buffer.from('old').toString('base64') }));
  // 1 MB of history, in parts that each fit loom's body cap.
  const big = Buffer.alloc(1024 * 1024 + 7, 'x');
  const parts = partsOf(big.length);
  assert.ok(parts > 2);
  for (let part = 0; part < parts; part++) {
    const r = ok(call(box('one'), 'save-state', { id: h.id, part, parts, state: big.subarray(part * PART_RAW, (part + 1) * PART_RAW).toString('base64') }));
    assert.equal(r.saved, part === parts - 1);
    // Until the last part is in, the next house would still get the old one.
    if (part < parts - 1) assert.equal(ok(call(owner, 'saved-state', { agent: 'art', name: 'slack' })).bytes, 3);
  }
  const back = ok(call(owner, 'saved-state', { agent: 'art', name: 'slack' }));
  assert.deepEqual([back.bytes, back.parts], [big.length, parts]);
  const chunks = [Buffer.from(back.state, 'base64')];
  for (let part = 1; part < parts; part++) chunks.push(Buffer.from(ok(call(owner, 'saved-state', { agent: 'art', name: 'slack', part })).state, 'base64'));
  assert.ok(joinParts(chunks, back).equals(big));
  // It isn't in state.json, only its size and hash.
  assert.ok(!JSON.stringify(load(env).serviceState).includes('xxxx'));
  assert.equal(call(box('one'), 'save-state', { id: h.id, part: 0, parts: MAX_PARTS + 1, state: 'AAAA' }).status, 413);
  assert.equal(call(box('one'), 'save-state', { id: h.id, part: 3, parts: 2, state: 'AAAA' }).status, 400);
});

test('an old inline state moves out of state.json the first time it\'s read', () => {
  ok(call(art, 'service-up', { name: 'discord' }));
  update(env, (s) => { s.serviceState = { 'art/discord': { from: 'h-0', box: 'one', at: 'x', data: Buffer.from('cursor=7').toString('base64') } }; });
  const r = ok(call(owner, 'saved-state', { agent: 'art', name: 'discord' }));
  assert.equal(Buffer.from(r.state, 'base64').toString(), 'cursor=7');
  assert.equal(load(env).serviceState['art/discord'].data, undefined);
});

test('state is saved only by the house\'s own box, within loom\'s body cap', () => {
  ok(call(art, 'service-up', { name: 'discord' }));
  const { h } = run('one');
  assert.equal(call(box('laptop'), 'save-state', { id: h.id, state: 'AAAA' }).status, 404);
  assert.equal(call(box('one'), 'save-state', { id: h.id, state: 'A'.repeat(800_000) }).status, 413);
  assert.equal(call(box('one'), 'save-state', { id: h.id, state: 'not base64!' }).status, 413);
  ok(call(box('one'), 'save-state', { id: h.id, state: 'AAAA' }));
  // Once it's written off (a forced move), it can't overwrite the state the next house gets.
  ok(call(owner, 'service-move', { agent: 'art', name: 'discord', box: 'laptop', force: true }));
  assert.equal(call(box('one'), 'save-state', { id: h.id, state: 'BBBB' }).status, 409);
});

test('a slot is held by one house at a time, and its state goes from one to the next', () => {
  const a = ok(call(art, 'up', { task: 'tend', slot: 'tending' }));
  assert.equal(a.slot, 'tending');
  assert.equal(call(art, 'up', { task: 'tend again', slot: 'tending' }).status, 409, 'one holder');
  ok(call(art, 'up', { task: 'something else', slot: 'groom' }));
  const p = ok(call(box('one'), 'poll')).start.find((h) => h.id === a.id);
  assert.equal(p.slot, 'tending');
  const c = ok(call(box('one'), 'claim', { id: a.id }));
  assert.equal(c.state, null, 'a new slot starts empty');
  ok(call(box('one'), 'report', { id: a.id, state: 'running' }));
  ok(call(box('one'), 'save-state', { id: a.id, state: Buffer.from('last-run=1').toString('base64') }));
  ok(call(box('one'), 'report', { id: a.id, state: 'done', exit: 0 }));
  // Over: a late save from it isn't kept, and the next holder gets what it left.
  assert.equal(call(box('one'), 'save-state', { id: a.id, state: 'AAAA' }).status, 409);
  const b = ok(call(art, 'up', { task: 'tend', slot: 'tending' }));
  ok(call(box('one'), 'poll'));
  const cb = ok(call(box('one'), 'claim', { id: b.id }));
  assert.equal(cb.state.bytes, 10);
  assert.equal(Buffer.from(ok(call(box('one'), 'state-part', { id: b.id, part: 0 })).data, 'base64').toString(), 'last-run=1');
  // The owner can read and seed it, but not while it's held.
  assert.equal(Buffer.from(ok(call(owner, 'saved-state', { agent: 'art', name: 'tending', slot: true })).state, 'base64').toString(), 'last-run=1');
  assert.equal(call(owner, 'seed-state', { agent: 'art', name: 'tending', slot: true, state: 'AAAA' }).status, 409);
  // A slot and a service of the same name don't share state.
  assert.equal(call(owner, 'saved-state', { agent: 'art', name: 'tending' }).status, 404);
  assert.equal(call(art, 'up', { task: 'x', slot: 'Bad Name' }).status, 400);
});

test('a service house\'s token is minted as that service (agent:art/discord), so a piece can tell it from art\'s other bodies (t-1591)', () => {
  const minted = [];
  fx.mint = (role, label) => { minted.push(role); return 'loom_' + 'x'.repeat(30); };
  ok(call(art, 'service-up', { name: 'discord' }));
  run('one');
  ok(call(art, 'up', { task: 'a one-off' }));
  run('one');
  // And every house's token names its house, so a piece can grant that house alone (secret requests).
  assert.deepEqual(minted.map((r) => r.slice(0, -2)), [['--agent', 'art', '--service', 'discord'], ['--agent', 'art']]);
  assert.deepEqual(minted.map((r) => r.slice(-2)[0]), ['--house', '--house']);
  assert.ok(minted.every((r) => /^h-\d+$/.test(r.at(-1))));
});
