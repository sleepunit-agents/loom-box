// Enrollment by request (t-1617): a box asks, the owner lets it in or blocks it on
// the page, and the credential goes only to the box holding the proof, once.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from '../src/control.mjs';
import { act, manifest } from '../src/ui.mjs';
import { codeOf, netOf } from '../src/enroll.mjs';
import { askToJoin } from '../src/box.mjs';
import { scratch } from './scratch.mjs';

let env, fx, clock, minted;
const owner = { kind: 'owner' };
const stranger = (address = '192.168.6.77') => ({ kind: 'stranger', address });
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const sha = (s) => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  env = { HOME: scratch('loom-box-enroll-'), LOOM_BOX_LOCAL_NAME: 'loom' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  clock = Date.now(); // the page reads the wall clock for what's still waiting, so the test's clock starts there
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
  assert.equal(ask.kind, 'permission', "loom's Inbox files it under Permissions");
  assert.match(ask.text, /one-loom/);
  assert.match(ask.meta, new RegExp(`192\\.168\\.6\\.77, code ${r.body.code}`));
  assert.deepEqual(ask.actions.map((a) => a.action), ['allow-join', 'block-join']);
  assert.equal(call(stranger(), 'join-poll', { id: r.body.id, proof }).body.state, 'pending');
  assert.equal(minted.length, 0, 'nothing is minted until the owner says');
  assert.equal(act(env, fx, { action: 'allow-join', fields: ask.actions[0].fields }).ok, true);
  assert.equal(call(stranger(), 'join-poll', { id: r.body.id, proof: 'q'.repeat(64) }).status, 403, 'not without the proof');
  const got = call(stranger(), 'join-poll', { id: r.body.id, proof });
  assert.match(got.body.box, /^[0-9a-f]{6}(-[0-9a-f]{6}){3}$/, 'loom\'s own id for it');
  assert.deepEqual(got.body, { state: 'allowed', box: got.body.box, name: 'one-loom', credential: 'loom_' + 'c'.repeat(40) });
  assert.equal(call(stranger(), 'join-poll', { id: r.body.id, proof }).body.state, 'gone', 'once');
  assert.ok(call(owner, 'list').body.boxes.some((b) => b.name === 'one-loom'));
  assert.deepEqual(manifest(env).asks, []);
});

test('blocked, expired, capped per network, no address refused, block all, and strangers reach only these two calls', () => {
  const ask = (name, address, p = name + address) => call(stranger(address), 'join-request', { name, proof_hash: sha(p) });
  const a = ask('evil', '10.0.9.9');
  act(env, fx, { action: 'block-join', fields: { id: a.body.id } });
  assert.equal(call(stranger(), 'join-poll', { id: a.body.id, proof: 'evil10.0.9.9' }).body.state, 'blocked');
  // Two per network (/24 here), not per address; asking doesn't hold a name (only a box does).
  assert.equal(ask('x1', '10.0.0.1').status, 200);
  assert.equal(ask('x1', '10.0.0.2').body.name, 'x1');
  assert.equal(ask('x2', '10.0.0.3').status, 429, 'that /24 is full');
  assert.equal(ask('x2', '10.0.1.3').status, 200, 'another network is not');
  assert.equal(call({ kind: 'stranger' }, 'join-request', { name: 'n', proof_hash: sha('n') }).status, 400, 'no address, no request');
  // A flood is cleared in one go.
  assert.equal(act(env, fx, { action: 'block-all-joins', fields: {} }).message, 'Blocked 3 waiting requests.');
  assert.deepEqual(manifest(env).asks, []);
  // Fifteen minutes on, the old ones no longer count.
  ask('y1', '10.0.5.1'); ask('y2', '10.0.5.2');
  clock += 16 * 60_000;
  assert.equal(ask('y3', '10.0.5.3').status, 200);
  for (const path of ['list', 'up', 'hello', 'add-box']) assert.equal(call(stranger(), path).status, 403, path);
  assert.equal(call({ kind: 'agent', agent: 'art' }, 'join-request', { name: 'y', proof_hash: sha('y') }).status, 404, 'with a token, there is no such call');
});

test('a name another box has is fine: the new box is its own, by id, and joins as that name', async () => {
  const first = call(owner, 'add-box', { name: 'one' }).body.box;
  let asked;
  const fetchImpl = async (url, init) => {
    const path = url.split('/api/box/')[1];
    const body = JSON.parse(init.body);
    // hello as the box the credential is: the one just let in, not the first one.
    if (path === 'hello') return new Response(JSON.stringify(call({ kind: 'piece', subject: allowed }, 'hello', body).body), { status: 200 });
    const r = call(stranger(), path, body);
    if (path === 'join-request') asked = r.body;
    if (path === 'join-poll' && r.body.state === 'pending') act(env, fx, { action: 'allow-join', fields: { id: asked.id } });
    if (path === 'join-poll' && r.body.state === 'allowed') allowed = r.body.box;
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  let allowed;
  const there = { HOME: scratch('loom-box-joiner-') };
  there.LOOM_BOX_HOME = join(there.HOME, 'state');
  const hi = await askToJoin(there, { url: 'http://loom.test:8787', name: 'one' }, { fetchImpl, say: () => {}, every: 1 });
  assert.equal(asked.name, 'one', 'asked as one, and stays one');
  assert.notEqual(hi.box, first);
  assert.equal(hi.name, 'one');
  const cfg = JSON.parse(readFileSync(join(there.LOOM_BOX_HOME, 'box.json'), 'utf-8'));
  assert.deepEqual([cfg.name, cfg.id], ['one', hi.box]);
  assert.equal(call(owner, 'list').body.boxes.filter((b) => b.name === 'one').length, 2);
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
  const there = { HOME: scratch('loom-box-joiner-') };
  there.LOOM_BOX_HOME = join(there.HOME, 'state');
  const hi = await askToJoin(there, { url: 'http://loom.test:8787', name: 'one-loom' }, { fetchImpl, say: (m) => said.push(m), every: 1 });
  assert.equal(hi.box, 'one-loom');
  assert.match(said[0], new RegExp(`code ${asked.code}`));
});

test('the network an address is in is the same however the address is written', () => {
  const nets = ['2001:db8:1:2::1', '2001:db8:1:2:a:b:c:d', '2001:0db8:0001:0002::9', '[2001:DB8:1:2::1]', 'fe80::1%eth0'.replace('fe80::1', '2001:db8:1:2::1')].map(netOf);
  assert.ok(nets.every((n) => n === '2001:db8:1:2::/64'), JSON.stringify(nets));
  assert.equal(netOf('2001:db8::1:2'), '2001:db8:0:0::/64');
  assert.equal(netOf('::ffff:192.168.6.77'), '192.168.6.0/24');
  assert.equal(netOf('192.168.6.77'), '192.168.6.0/24');
});

test('a box waiting to be let in rides out loom restarting (a 5xx or no answer), and still joins', async () => {
  let asked, polls = 0;
  const fetchImpl = async (url, init) => {
    const path = url.split('/api/box/')[1];
    const body = JSON.parse(init.body);
    if (path === 'hello') return new Response(JSON.stringify(call({ kind: 'piece', subject: allowed }, 'hello', body).body), { status: 200 });
    if (path === 'join-poll' && ++polls === 1) return new Response('{"error":"piece api failed"}', { status: 502 });
    if (path === 'join-poll' && polls === 2) throw new TypeError('fetch failed');
    const r = call(stranger(), path, body);
    if (path === 'join-request') asked = r.body;
    if (path === 'join-poll' && r.body.state === 'pending') act(env, fx, { action: 'allow-join', fields: { id: asked.id } });
    if (path === 'join-poll' && r.body.state === 'allowed') allowed = r.body.box;
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  let allowed;
  const there = { HOME: scratch('loom-box-joiner-') };
  there.LOOM_BOX_HOME = join(there.HOME, 'state');
  const hi = await askToJoin(there, { url: 'http://loom.test:8787', name: 'one' }, { fetchImpl, say: () => {}, every: 1 });
  assert.equal(hi.name, 'one');
  assert.ok(polls >= 3, 'it kept asking past the 502 and the dropped connection');
});
