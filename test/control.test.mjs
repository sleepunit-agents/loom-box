// The control plane (loom docs/specs/runtime.md, "What its tests must pin"):
//  - a box refuses a house for an agent it may not host; a need no permitted
//    box has fails and names the need; nothing else picks a box;
//  - a box's credential gets only the box calls, and a revoked box gets
//    nothing more, its houses' tokens revoked with it;
//  - secrets fetched for a house are that house's only: once, by its box;
//  - with nothing enrolled, every agent's primary is loom's own machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, meets } from '../src/control.mjs';

let env, fx, minted, revoked;
const owner = { kind: 'owner' };
const art = { kind: 'agent', agent: 'art' };
const box = (subject) => ({ kind: 'piece', subject });
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

beforeEach(() => {
  env = { HOME: mkdtempSync(join(tmpdir(), 'loom-box-')), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  minted = []; revoked = [];
  let n = 0;
  fx = {
    now: () => new Date('2026-10-25T03:00:00Z'),
    mint: (role, label) => { minted.push({ role, label }); return `loom_${'t'.repeat(30)}${n++}`; },
    revoke: (label) => { revoked.push(label); },
    secret: (name) => `value-of-${name}`,
  };
  ok(call(owner, 'set-agent', { agent: 'art', repo: 'https://github.com/x/art.git', secrets: { 'github-token': 'gh-art' }, repoSecret: 'gh-art' }));
  ok(call(owner, 'set-agent', { agent: 'mark', repo: 'https://github.com/x/mark.git' }));
});

test('with nothing enrolled, every agent\'s primary is loom\'s own machine, and a house goes there', () => {
  const h = ok(call(art, 'up', { task: 'write a haiku' }));
  assert.deepEqual([h.box, h.state], ['one', 'wanted']);
  assert.equal(ok(call(art, 'list')).primary, 'one');
});

test('adding a box mints its credential (piece:box/<name>) and its state file is private', () => {
  const r = ok(call(owner, 'add-box', { name: 'thor', mayHost: 'art' }));
  assert.match(r.token, /^loom_/);
  assert.deepEqual(minted[0], { role: ['--piece', 'box/thor'], label: 'box · thor' });
  assert.equal(statSync(join(env.LOOM_BOX_HOME, 'state.json')).mode & 0o777, 0o600);
  assert.equal(call(owner, 'add-box', { name: 'thor' }).status, 409);
  assert.equal(call(owner, 'add-box', { name: 'Thor!' }).status, 400);
});

test('a box refuses a house for an agent it may not host', () => {
  ok(call(owner, 'add-box', { name: 'thor', mayHost: 'art' }));
  ok(call(box('thor'), 'hello', { facts: ['gpu:nvidia-geforce-rtx-5090'] }));
  const r = call(owner, 'up', { agent: 'mark', box: 'thor', task: 'x' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /thor may not host mark/);
  // And a house already placed there stops being offered once mark is taken off the list.
  const h = ok(call(owner, 'up', { agent: 'art', box: 'thor', task: 'x' }));
  ok(call(owner, 'may-host', { name: 'thor', mayHost: 'mark' }));
  assert.deepEqual(ok(call(box('thor'), 'poll')).start, []);
  assert.equal(call(box('thor'), 'claim', { id: h.id }).status, 403);
});

test('a need no permitted box has fails and names the need; nothing else picks a box', () => {
  ok(call(owner, 'add-box', { name: 'thor' }));
  ok(call(owner, 'add-box', { name: 'rig' }));
  ok(call(box('thor'), 'hello', { facts: ['gpu:nvidia-thor', 'arch:arm64'] }));
  ok(call(box('rig'), 'hello', { facts: ['gpu:nvidia-geforce-rtx-5090', 'arch:x86_64'] }));
  const none = call(art, 'up', { needs: ['gpu:h100'], task: 'x' });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /no box that may host art has gpu:h100/);
  assert.equal(ok(call(art, 'up', { needs: 'gpu:5090', task: 'x' })).box, 'rig');
  // Two fit: it won't choose between them...
  const two = call(art, 'up', { needs: ['gpu:nvidia'], task: 'x' });
  assert.equal(two.status, 409);
  assert.match(two.body.error, /several boxes .*rig, thor|several boxes .*thor, rig/);
  // ...unless one of them is the agent's primary.
  ok(call(owner, 'set-primary', { agent: 'art', box: 'thor' }));
  assert.equal(ok(call(art, 'up', { needs: ['gpu:nvidia'], task: 'x' })).box, 'thor');
  // Naming a box that lacks the need says what's missing.
  assert.match(call(art, 'up', { box: 'thor', needs: ['gpu:5090'], task: 'x' }).body.error, /thor doesn't have gpu:5090/);
});

test('an agent asks only for its own house, and sees only its own', () => {
  assert.equal(call(art, 'up', { agent: 'mark', task: 'x' }).status, 403);
  ok(call(owner, 'up', { agent: 'mark', task: 'mark\'s' }));
  ok(call(art, 'up', { task: 'art\'s' }));
  assert.deepEqual(ok(call(art, 'list')).houses.map((h) => h.agent), ['art']);
  const marks = ok(call(owner, 'list')).houses.find((h) => h.agent === 'mark');
  assert.equal(call(art, 'down', { id: marks.id }).status, 404);
});

test('a box credential gets only the box calls; agents and the owner don\'t get them', () => {
  ok(call(owner, 'add-box', { name: 'thor' }));
  for (const p of ['up', 'list', 'down', 'add-box', 'revoke-box', 'set-agent', 'set-primary', 'may-host']) {
    assert.equal(call(box('thor'), p, { agent: 'art', task: 'x' }).status, 403, p);
  }
  for (const p of ['hello', 'poll', 'claim', 'report']) {
    assert.equal(call(art, p).status, 403, p);
    assert.equal(call(owner, p).status, 403, p);
  }
  assert.equal(call(art, 'add-box', { name: 'evil' }).status, 403);
  assert.equal(call(box('nobody'), 'poll').status, 403);
});

test('secrets for a house go once, to its box, and the house token is the agent\'s, for that house', () => {
  ok(call(owner, 'add-box', { name: 'thor' }));
  ok(call(owner, 'add-box', { name: 'rig' }));
  const h = ok(call(art, 'up', { box: 'thor', task: 'x' }));
  assert.equal(call(box('rig'), 'claim', { id: h.id }).status, 404);
  const c = ok(call(box('thor'), 'claim', { id: h.id }));
  assert.deepEqual(c.secrets, { 'github-token': 'value-of-gh-art' });
  assert.equal(c.repoAuth, 'value-of-gh-art');
  assert.deepEqual(minted.at(-1), { role: ['--agent', 'art'], label: `art · house ${h.id} on thor` });
  assert.equal(call(box('thor'), 'claim', { id: h.id }).status, 409);
  // The token's label never shows up in what anyone reads back.
  assert.equal(JSON.stringify(ok(call(owner, 'list'))).includes('tokenLabel'), false);
});

test('a secret that can\'t be read fails the claim and revokes the token it minted', () => {
  fx.secret = () => { throw new Error('store locked'); };
  const h = ok(call(art, 'up', { task: 'x' }));
  const r = call(box('one'), 'claim', { id: h.id });
  assert.equal(r.status, 500);
  assert.deepEqual(revoked, [`art · house ${h.id} on one`]);
  // Still waiting, so the box can try again.
  assert.equal(ok(call(owner, 'list')).houses[0].state, 'wanted');
});

test('a house ends: its token is revoked; reports go only forward', () => {
  const h = ok(call(art, 'up', { task: 'x' }));
  ok(call(box('one'), 'claim', { id: h.id }));
  ok(call(box('one'), 'report', { id: h.id, state: 'running' }));
  assert.equal(call(box('one'), 'report', { id: h.id, state: 'wanted' }).status, 409);
  const done = ok(call(box('one'), 'report', { id: h.id, state: 'done', exit: 0, log: 'ok\n'.repeat(5000) }));
  assert.equal(done.state, 'done');
  assert.ok(done.log.length <= 4000);
  assert.deepEqual(revoked, [`art · house ${h.id} on one`]);
  assert.equal(call(box('one'), 'report', { id: h.id, state: 'running' }).status, 409);
});

test('stopping: a waiting house just stops; a running one is handed to its box to stop', () => {
  const a = ok(call(art, 'up', { task: 'x' }));
  assert.equal(ok(call(art, 'down', { id: a.id })).state, 'stopped');
  const b = ok(call(art, 'up', { task: 'y' }));
  ok(call(box('one'), 'claim', { id: b.id }));
  ok(call(box('one'), 'report', { id: b.id, state: 'running' }));
  assert.equal(ok(call(art, 'down', { id: b.id })).state, 'stopping');
  const p = ok(call(box('one'), 'poll'));
  assert.deepEqual([p.stop, p.active], [[b.id], [b.id]]);
  // Still up while it stops; then stopped.
  assert.equal(ok(call(box('one'), 'report', { id: b.id, state: 'running' })).state, 'stopping');
  assert.equal(ok(call(box('one'), 'report', { id: b.id, state: 'stopped' })).state, 'stopped');
});

test('revoking a box: its credential and its houses\' tokens go, its houses are lost, and it gets nothing more', () => {
  ok(call(owner, 'add-box', { name: 'thor' }));
  ok(call(owner, 'set-primary', { agent: 'art', box: 'thor' }));
  const h = ok(call(art, 'up', { task: 'x' }));
  assert.equal(h.box, 'thor');
  ok(call(box('thor'), 'claim', { id: h.id }));
  ok(call(owner, 'revoke-box', { name: 'thor' }));
  assert.deepEqual(revoked.sort(), ['art · house h-1 on thor', 'box · thor'].sort());
  assert.equal(ok(call(owner, 'list')).houses[0].state, 'lost');
  assert.equal(call(box('thor'), 'poll').status, 403);
  // art's primary falls back to loom's own machine.
  assert.equal(ok(call(art, 'up', { task: 'y' })).box, 'one');
  assert.equal(call(owner, 'revoke-box', { name: 'one' }).status, 409);
});

test('an agent\'s house config is checked: a repo URL, a house command inside the repo, store names', () => {
  for (const bad of [
    { agent: 'art', repo: 'file:///etc' },
    { agent: 'art', repo: 'https://x/y', houseCmd: '../../bin/sh' },
    { agent: 'art', repo: 'https://x/y', houseCmd: '/bin/sh' },
    { agent: 'art', repo: 'https://x/y', secrets: { 'a/b': 'c' } },
    { agent: 'Art', repo: 'https://x/y' },
  ]) assert.equal(call(owner, 'set-agent', bad).status, 400, JSON.stringify(bad));
  assert.equal(call(art, 'up', { task: '' }).status, 400);
  assert.equal(call(owner, 'up', { agent: 'nobody', task: 'x' }).status, 409);
});

test('needs match a fact\'s key and part of its value; a bare need is a label', () => {
  assert.ok(meets(['gpu:nvidia-geforce-rtx-5090'], 'gpu:5090'));
  assert.ok(meets(['gpu:NVIDIA-thor'], 'gpu:thor'));
  assert.ok(!meets(['label:gpu-5090'], 'gpu:5090'));
  assert.ok(meets(['jonathan-rig'], 'jonathan-rig'));
  assert.ok(!meets(['arch:x86_64'], 'arch:arm64'));
});
