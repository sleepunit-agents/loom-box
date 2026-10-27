// Enrollment by request (t-1617): a box asks, the owner lets it in or blocks it on
// the page, and the credential goes only to the box holding the proof, once.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from '../src/control.mjs';
import { act, manifest } from '../src/ui.mjs';
import { codeOf } from '../src/enroll.mjs';
import { askToJoin } from '../src/box.mjs';

let env, fx, clock, minted;
const owner = { kind: 'owner' };
const stranger = (address = '192.168.6.77') => ({ kind: 'stranger', address });
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const sha = (s) => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  env = { HOME: mkdtempSync(join(tmpdir(), 'loom-box-enroll-')), LOOM_BOX_LOCAL_NAME: 'loom' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  clock = Date.parse('2026-10-27T18:00:00Z');
  minted = [];
  fx = { now: () => new Date(clock), mint: (role, label) => { minted.push(label); return 'loom_' + 'c'.repeat(40); }, revoke: () => {}, secret: () => '' };
  call(owner, 'list');
});

test('a box asks, the owner lets it in on the page, and only the box with the proof gets the credential, once', () => {
  const proof = 'p'.repeat(64);
  const r = call(stranger(), 'join-request', { name: 'one-loom', facts: ['cpus:8', 'runtime:podman'], proof_hash: sha(proof) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.code, codeOf(sha(proof)));
  // The card: name, where it's from, the code to match.
  const [ask] = manifest(env).asks;
  assert.match(ask.text, /one-loom/);
  assert.match(ask.meta, new RegExp(`192\\.168\\.6\\.77, code ${r.body.code}`));
  assert.deepEqual(ask.actions.map((a) => a.action), ['allow-join', 'block-join']);
  assert.equal(call(stranger(), 'join-poll', { id: r.body.id, proof }).body.state, 'pending');
  assert.equal(minted.length, 0, 'nothing is minted until the owner says');
  assert.equal(act(env, fx, { action: 'allow-join', fields: ask.actions[0].fields }).ok, true);
  assert.equal(call(stranger(), 'join-poll', { id: r.body.id, proof: 'q'.repeat(64) }).status, 403, 'not without the proof');
  const got = call(stranger(), 'join-poll', { id: r.body.id, proof });
  assert.deepEqual(got.body, { state: 'allowed', name: 'one-loom', credential: 'loom_' + 'c'.repeat(40) });
  assert.equal(call(stranger(), 'join-poll', { id: r.body.id, proof }).body.state, 'gone', 'once');
  assert.ok(call(owner, 'list').body.boxes.some((b) => b.name === 'one-loom'));
  assert.deepEqual(manifest(env).asks, []);
});

test('blocked, expired, capped, and strangers reach only these two calls', () => {
  const ask = (name, address, p = name) => call(stranger(address), 'join-request', { name, proof_hash: sha(p) });
  const a = ask('evil', '10.0.0.9');
  act(env, fx, { action: 'block-join', fields: { id: a.body.id } });
  assert.equal(call(stranger(), 'join-poll', { id: a.body.id, proof: 'evil' }).body.state, 'blocked');
  // Two from one address at most, five in all; the same name only once at a time.
  assert.equal(ask('x1', '10.0.0.1').status, 200);
  // A taken name gets the next free one, and the box is told.
  const twin = ask('x1', '10.0.0.2');
  assert.equal(twin.body.name, 'x1-2');
  assert.equal(ask('x2', '10.0.0.1').status, 200);
  assert.equal(ask('x3', '10.0.0.1').status, 429);
  for (const n of ['x4', 'x5']) ask(n, `10.0.1.${n}`);
  assert.equal(ask('x7', '10.0.2.1').status, 429);
  // Fifteen minutes on, they're gone.
  clock += 16 * 60_000;
  assert.equal(ask('x8', '10.0.0.1').status, 200, 'the expired ones no longer count against the address or the cap');
  for (const path of ['list', 'up', 'hello', 'add-box']) assert.equal(call(stranger(), path).status, 403, path);
  assert.equal(call({ kind: 'agent', agent: 'art' }, 'join-request', { name: 'y', proof_hash: sha('y') }).status, 404, 'with a token, there is no such call');
});

test('a name a box already has comes back as the next free one, and the box joins under it', async () => {
  call(owner, 'add-box', { name: 'one' });
  let asked;
  const fetchImpl = async (url, init) => {
    const path = url.split('/api/box/')[1];
    const body = JSON.parse(init.body);
    if (path === 'hello') return new Response(JSON.stringify({ box: 'one-2' }), { status: 200 });
    const r = call(stranger(), path, body);
    if (path === 'join-request') asked = r.body;
    if (path === 'join-poll' && r.body.state === 'pending') act(env, fx, { action: 'allow-join', fields: { id: asked.id } });
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  const said = [];
  const there = { HOME: mkdtempSync(join(tmpdir(), 'loom-box-joiner-')) };
  there.LOOM_BOX_HOME = join(there.HOME, 'state');
  const hi = await askToJoin(there, { url: 'http://loom.test:8787', name: 'one' }, { fetchImpl, say: (m) => said.push(m), every: 1 });
  assert.equal(hi.box, 'one-2');
  assert.match(said[0], /one is taken on this loom, so it'll be one-2/);
});

test('loom box join at a terminal asks, waits for the owner, and joins with what it was given', async () => {
  // A fake loom: the stranger calls go to the API above; hello answers as that box.
  let asked;
  const fetchImpl = async (url, init) => {
    const path = url.split('/api/box/')[1];
    const body = JSON.parse(init.body);
    if (path === 'hello') return new Response(JSON.stringify({ box: 'one-loom' }), { status: 200 });
    const r = call(stranger(), path, body);
    if (path === 'join-request') asked = r.body;
    if (path === 'join-poll' && r.body.state === 'pending') act(env, fx, { action: 'allow-join', fields: { id: asked.id } });
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  const said = [];
  const there = { HOME: mkdtempSync(join(tmpdir(), 'loom-box-joiner-')) };
  there.LOOM_BOX_HOME = join(there.HOME, 'state');
  const hi = await askToJoin(there, { url: 'http://loom.test:8787', name: 'one-loom' }, { fetchImpl, say: (m) => said.push(m), every: 1 });
  assert.equal(hi.box, 'one-loom');
  assert.match(said[0], new RegExp(`code ${asked.code}`));
});
