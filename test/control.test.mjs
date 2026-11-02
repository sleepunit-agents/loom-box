// The control plane (loom docs/specs/runtime.md, "What its tests must pin"):
//  - a box refuses a house for an agent it may not host; a need no permitted
//    box has fails and names the need; nothing else picks a box;
//  - a box's credential gets only the box calls, and a revoked box gets
//    nothing more, its houses' tokens revoked with it;
//  - secrets fetched for a house are that house's only: once, by its box;
//  - with nothing enrolled, every agent's primary is loom's own machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CLAIM_TRIES, api, meets } from '../src/control.mjs';
import { load } from '../src/state.mjs';
import { scratch } from './scratch.mjs';

let env, fx, minted, revoked;
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

beforeEach(() => {
  env = { HOME: scratch('loom-box-'), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.XDG_RUNTIME_DIR = join(env.HOME, 'run');
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

test('adding a box gives it an id of loom\'s and mints its credential (piece:box/<id>); its state file is private', () => {
  const r = ok(call(owner, 'add-box', { name: 'thor', mayHost: 'art' }));
  assert.match(r.token, /^loom_/);
  assert.match(r.box, /^[0-9a-f]{6}(-[0-9a-f]{6}){3}$/);
  assert.equal(r.name, 'thor');
  assert.deepEqual(minted[0], { role: ['--piece', `box/${r.box}`], label: `box · thor (${r.box})` });
  assert.equal(statSync(join(env.LOOM_BOX_HOME, 'state.json')).mode & 0o777, 0o600);
  assert.equal(call(owner, 'add-box', { name: 'Thor!' }).status, 400);
  const hi = ok(call({ kind: 'piece', subject: r.box }, 'hello', {}));
  assert.deepEqual([hi.box, hi.name], [r.box, 'thor']);
});

test('a name is only what a box is called: two may share it, and then the id says which', () => {
  const a = ok(call(owner, 'add-box', { name: 'thor', mayHost: 'art' }));
  const b = ok(call(owner, 'add-box', { name: 'thor', mayHost: 'art' }));
  assert.notEqual(a.box, b.box);
  const r = call(owner, 'up', { agent: 'art', box: 'thor', task: 'x' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /2 boxes are named thor/);
  assert.equal(ok(call(owner, 'up', { agent: 'art', box: b.box, task: 'x' })).box, b.box);
  ok(call(owner, 'revoke-box', { name: a.box }));
  assert.equal(ok(call(owner, 'up', { agent: 'art', box: 'thor', task: 'y' })).box, b.box, 'one live thor: the name is enough again');
  assert.equal(call(owner, 'revoke-box', { name: a.box }).status, 404, 'a revoked box is gone');
  // An id is exact: a box may be called what loom's own machine is keyed by, and that still means loom's own...
  const one = ok(call(owner, 'add-box', { name: 'one' })).box;
  assert.equal(ok(call(owner, 'up', { agent: 'art', box: 'one', task: 'z' })).box, 'one');
  assert.equal(ok(call(owner, 'up', { agent: 'art', box: one, task: 'z' })).box, one);
  // ...and no name may look like an id.
  assert.equal(call(owner, 'add-box', { name: b.box }).status, 400);
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
  const rig = ok(call(owner, 'add-box', { name: 'rig' })).box;
  ok(call(box('thor'), 'hello', { facts: ['gpu:nvidia-thor', 'arch:arm64'] }));
  ok(call(box('rig'), 'hello', { facts: ['gpu:nvidia-geforce-rtx-5090', 'arch:x86_64'] }));
  const none = call(art, 'up', { needs: ['gpu:h100'], task: 'x' });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /no box that may host art has gpu:h100/);
  assert.equal(ok(call(art, 'up', { needs: 'gpu:5090', task: 'x' })).box, rig);
  // Two fit: it won't choose between them...
  const two = call(art, 'up', { needs: ['gpu:nvidia'], task: 'x' });
  assert.equal(two.status, 409);
  assert.match(two.body.error, /several boxes .*rig, thor|several boxes .*thor, rig/);
  // ...unless one of them is the agent's primary.
  ok(call(owner, 'set-primary', { agent: 'art', box: 'thor' }));
  assert.equal(ok(call(art, 'up', { needs: ['gpu:nvidia'], task: 'x' })).box, idOf('thor'));
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
  assert.deepEqual(minted.at(-1), { role: ['--agent', 'art', '--house', h.id], label: `art · house ${h.id} on thor` });
  assert.equal(call(box('thor'), 'claim', { id: h.id }).status, 409);
  // The token's label never shows up in what anyone reads back.
  assert.equal(JSON.stringify(ok(call(owner, 'list'))).includes('tokenLabel'), false);
});

test('a token a killed mint left under the house\'s own label is revoked and minted again, once', () => {
  // 2026-10-30: \`loom token create\` for h-438 was killed on its timeout after writing the token, and every claim
  // after it failed "a live token is already labeled …" until someone revoked it by hand. The house is still
  // waiting to start, so nothing can be using that token.
  ok(call(owner, 'add-box', { name: 'thor' }));
  const h = ok(call(art, 'up', { box: 'thor', task: 'x' }));
  const label = `art · house ${h.id} on thor`;
  let live = new Set([label]);
  const left = {
    ...fx,
    mint: (role, l) => {
      if (live.has(l)) throw new Error(`minting a token: a live token is already labeled ${JSON.stringify(l)}`);
      live.add(l); return fx.mint(role, l);
    },
    revoke: (l) => { live.delete(l); fx.revoke(l); },
  };
  const c = ok(api(env, left, { caller: box('thor'), path: 'claim', body: { id: h.id } }));
  assert.match(c.token, /^loom_/);
  assert.deepEqual(revoked, [label]);
  // Some other failure isn't retried, and a second "already labeled" (the revoke didn't take) fails the claim.
  const h2 = ok(call(art, 'up', { box: 'thor', task: 'y' }));
  const stuck = { ...fx, mint: () => { throw new Error('minting a token: a live token is already labeled "x"'); }, revoke: () => {} };
  assert.equal(api(env, stuck, { caller: box('thor'), path: 'claim', body: { id: h2.id } }).status, 500);
  const other = { ...fx, mint: () => { throw new Error('minting a token: loom printed something other than a token'); } };
  revoked.length = 0;
  assert.equal(api(env, other, { caller: box('thor'), path: 'claim', body: { id: h2.id } }).status, 500);
  assert.deepEqual(revoked, []);
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

test('a revoke that fails is queued and retried until it goes; a new box of the same name is its own', () => {
  const thor = ok(call(owner, 'add-box', { name: 'thor' })).box;
  let down = true;
  fx.revoke = (label) => { if (down) throw new Error('the token file is locked'); revoked.push(label); };
  const h = ok(call(art, 'up', { box: 'thor', task: 'x' }));
  ok(call(box('thor'), 'claim', { id: h.id }));
  ok(call(box('thor'), 'report', { id: h.id, state: 'done', exit: 0 }));
  assert.deepEqual(revoked, []);
  ok(call(owner, 'revoke-box', { name: 'thor' }));
  // Another thor is another box: its own id and credential, nothing of the old one's.
  const again = ok(call(owner, 'add-box', { name: 'thor' })).box;
  assert.notEqual(again, thor);
  down = false;
  ok(call(box('one'), 'poll'));
  assert.deepEqual(revoked.sort(), [`art · house ${h.id} on thor`, `box · thor (${thor})`].sort());
  // "No live token" counts as gone.
  fx.revoke = () => { throw new Error('no live token labeled "x"'); };
  ok(call(owner, 'add-box', { name: 'thor' }));
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
  const thor = ok(call(owner, 'add-box', { name: 'thor' })).box;
  ok(call(owner, 'set-primary', { agent: 'art', box: 'thor' }));
  const h = ok(call(art, 'up', { task: 'x' }));
  assert.equal(h.box, thor);
  ok(call(box('thor'), 'claim', { id: h.id }));
  ok(call(owner, 'revoke-box', { name: 'thor' }));
  assert.deepEqual(revoked.sort(), ['art · house h-1 on thor', `box · thor (${thor})`].sort());
  assert.equal(ok(call(owner, 'list')).houses[0].state, 'lost');
  assert.equal(call(box('thor'), 'poll').status, 403);
  // art's primary falls back to loom's own machine.
  assert.equal(ok(call(art, 'up', { task: 'y' })).box, 'one');
  assert.equal(call(owner, 'revoke-box', { name: 'one' }).status, 409);
});

test('an agent\'s house config is checked: a repo URL, a house command inside the repo, store names', () => {
  for (const bad of [
    { agent: 'art', repo: 'file:///etc' },
    { agent: 'art', repo: 'https://x/y', houseFile: '../../etc/house.json' },
    { agent: 'art', repo: 'https://x/y', houseFile: '/etc/house.json' },
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

test('the runtime\'s part of the bundle comes back on another machine, as that machine\'s box', { skip: !process.env.PATH.split(':').some((d) => { try { return statSync(join(d, 'age')).isFile(); } catch { return false; } }) && 'no age' }, async () => {
  const { exportPart, importPart } = await import('../src/bundle.mjs');
  const { spawnSync } = await import('node:child_process');
  const key = join(env.HOME, 'owner.key');
  spawnSync('age-keygen', ['-o', key]);
  const recipient = spawnSync('age-keygen', ['-y', key], { encoding: 'utf-8' }).stdout.trim();
  ok(call(owner, 'add-box', { name: 'thor' }));
  ok(call(owner, 'set-primary', { agent: 'mark', box: 'one' }));
  ok(call(art, 'up', { task: 'x' }));
  const part = exportPart({ ...env, LOOM_EXPORT_RECIPIENTS: recipient, PATH: process.env.PATH });
  assert.match(part, /BEGIN AGE ENCRYPTED FILE/);
  assert.equal(part.includes('thor'), false);
  // A new machine, named differently.
  const there = { HOME: env.HOME, LOOM_BOX_HOME: join(env.HOME, 'elsewhere'), LOOM_BOX_LOCAL_NAME: 'two', PATH: process.env.PATH, LOOM_IMPORT_IDENTITY: key };
  assert.deepEqual(importPart(there, part), { boxes: 2, houses: 1 });
  const l = ok(api(there, fx, { caller: owner, path: 'list', body: {} }));
  assert.deepEqual(l.boxes.map((b) => [b.name, b.local]).sort(), [['thor', false], ['two', true]]);
  // The waiting house doesn't start again by itself on the new machine.
  assert.equal(l.houses[0].state, 'lost');
  assert.deepEqual(ok(api(there, fx, { caller: { kind: 'piece', subject: 'two' }, path: 'poll', body: {} })).start, []);
  assert.throws(() => importPart(there, part), /already has runtime state/);
  // Forced over a machine with its own box and a live house: their tokens are queued for revoking.
  const forced = { ...there, LOOM_BOX_HOME: join(env.HOME, 'forced') };
  ok(api(forced, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo: 'https://x/a.git' } }));
  ok(api(forced, fx, { caller: owner, path: 'add-box', body: { name: 'laptop' } }));
  ok(api(forced, fx, { caller: owner, path: 'add-box', body: { name: 'thor' } }));
  const live = ok(api(forced, fx, { caller: owner, path: 'up', body: { agent: 'art', task: 'x' } }));
  ok(api(forced, fx, { caller: { kind: 'piece', subject: 'two' }, path: 'claim', body: { id: live.id } }));
  revoked = [];
  importPart(forced, part, { force: true });
  ok(api(forced, fx, { caller: { kind: 'piece', subject: 'two' }, path: 'poll', body: {} }));
  // A box's credential label is `box · <name> (<id>)` since boxes had ids.
  const boxCred = (n) => revoked.some((l) => l === `box · ${n}` || l.startsWith(`box · ${n} (`));
  assert.ok(boxCred('laptop') && revoked.includes(`art · house ${live.id} on two`));
  // thor is in both: its credential here is queued too (a forced restore re-adds what should stay).
  assert.ok(boxCred('thor'));
  // Ids keep counting from the higher of the two, so no label repeats.
  // (both machines had used up to h-1)
  assert.equal(ok(api(forced, fx, { caller: owner, path: 'up', body: { agent: 'art', task: 'y' } })).id, 'h-2');
  // A remote box only named like this machine is its own box, by id: it can't speak for loom's own (whose key is
  // the machine's name), so it restores. (One from before ids, keyed by that name, is still refused: bundle.mjs.)
  const clash = { ...there, LOOM_BOX_HOME: join(env.HOME, 'clash'), LOOM_BOX_LOCAL_NAME: 'thor' };
  importPart(clash, part);
  const cl = ok(api(clash, fx, { caller: owner, path: 'list', body: {} })).boxes;
  assert.deepEqual(cl.filter((b) => b.local).map((b) => b.id), ['thor']);
  assert.equal(cl.filter((b) => b.name === 'thor' && !b.local).length, 1);
  assert.throws(() => importPart({ ...there, LOOM_BOX_HOME: join(env.HOME, 'x'), LOOM_IMPORT_IDENTITY: join(env.HOME, 'nokey') }, part), /doesn't decrypt/);
});

test('a session house needs no task, and its box is told it\'s one', () => {
  const h = ok(call(owner, 'up', { agent: 'art', session: true }));
  assert.equal(h.session, true);
  const p = ok(call(box(h.box), 'poll'));
  const s = p.start.find((x) => x.id === h.id);
  assert.equal(s.session, true);
  // An ordinary house still needs its task, and isn't a session.
  assert.equal(call(owner, 'up', { agent: 'art' }).status, 400);
  const t = ok(call(owner, 'up', { agent: 'art', task: 'x' }));
  assert.equal(ok(call(box(t.box), 'poll')).start.find((x) => x.id === t.id).session, false);
});

test('nothing issues a model credential: sub:<provider> is refused, an old one is skipped, and a claim says which logins the box has', () => {
  const r = call(owner, 'set-agent', { agent: 'art', repo: 'https://x/art.git', secrets: { 'claude-oauth': 'sub:anthropic' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /sub:<provider> is gone: a box logs in/);
  // An API key is a plain secret.
  ok(call(owner, 'set-agent', { agent: 'art', repo: 'https://x/art.git', secrets: { 'anthropic-api-key': 'art-anthropic-key', 'github-token': 'gh-art' } }));
  // A household whose state still maps sub:… (from before) gets nothing for it, and nothing fails.
  const p = join(env.LOOM_BOX_HOME, 'state.json');
  const s = JSON.parse(readFileSync(p, 'utf-8'));
  s.agents.art.secrets['claude-oauth'] = 'sub:anthropic';
  writeFileSync(p, JSON.stringify(s), { mode: 0o600 });
  ok(call(box('one'), 'poll', { harnesses: { claude: { installed: true, loggedIn: true, method: 'claude.ai', plan: 'max', account: 'claude-0123456789' }, codex: { installed: true, loggedIn: false } } }));
  const h = ok(call(art, 'up', { task: 't' }));
  ok(call(box(h.box), 'poll'));
  const c = ok(call(box(h.box), 'claim', { id: h.id }));
  assert.deepEqual(Object.keys(c.secrets).sort(), ['anthropic-api-key', 'github-token']);
  assert.deepEqual(c.logins, ['claude']);
});

test('a box reports its harnesses; the owner logs it in from its page: the box runs the CLI\'s login, the link comes back, the pasted code goes to the box once', async () => {
  // What a box says: states only. Anything else it sends (an email, a token) is dropped.
  ok(call(box('one'), 'poll', { harnesses: { claude: { installed: true, loggedIn: false, email: 'j@example.com', token: 'sk-x' }, codex: { installed: false, loggedIn: true } } }));
  const listed = ok(call(owner, 'list')).boxes.find((b) => b.id === 'one').harnesses;
  assert.deepEqual(listed, { claude: { installed: true, loggedIn: false, checked: '2026-10-25T03:00:00.000Z' }, codex: { installed: false, loggedIn: false, checked: '2026-10-25T03:00:00.000Z' } });
  assert.equal(JSON.stringify(load(env).boxes.one).includes('example.com'), false);
  // Codex isn't installed there: no login for it.
  assert.equal(call(owner, 'login-start', { box: 'one', harness: 'codex' }).status, 409);
  const l = ok(call(owner, 'login-start', { box: 'one', harness: 'claude' }));
  assert.match(l.id, /^l-[0-9a-f]{12}$/);
  // Asking again while one is under way is the same login.
  assert.equal(ok(call(owner, 'login-start', { box: 'one', harness: 'claude' })).id, l.id);
  // Only an owner starts one; a box only reports on its own.
  assert.equal(call(art, 'login-start', { box: 'one', harness: 'claude' }).status, 403);
  assert.deepEqual(ok(call(box('one'), 'poll')).logins, [{ id: l.id, harness: 'claude', state: 'wanted' }]);
  assert.deepEqual(ok(call(box('one'), 'poll')).logins, []);
  // A code before the link is up is refused; the link isn't any URL.
  assert.equal(call(owner, 'login-code', { id: l.id, code: 'abcdefgh#state123' }).status, 409);
  assert.equal(call(box('one'), 'login-report', { id: l.id, state: 'waiting', link: 'https://evil.example/x' }).status, 400);
  const link = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x';
  ok(call(box('one'), 'login-report', { id: l.id, state: 'waiting', link, kind: 'paste-code' }));
  assert.equal(call(owner, 'login-code', { id: l.id, code: 'no' }).status, 400);
  // The page shows the provider's link and asks for the code; it never shows one back.
  const { page } = await import('../src/ui.mjs');
  const lp = JSON.stringify(page(env, { path: `login/${l.id}` }));
  assert.match(lp, /Open Anthropic's sign-in page/);
  assert.equal(lp.includes(link), true);
  // Not for an agent's tab, nor an agent owner: 403, and no link.
  for (const [e2, c2] of [[{ ...env, LOOM_SCOPE: 'art' }, undefined], [env, { kind: 'owner', who: 'loren', agents: ['art'] }]]) {
    const p2 = page(e2, { path: `login/${l.id}`, caller: c2 });
    assert.equal(p2.status, 403);
    assert.equal(JSON.stringify(p2).includes(link), false);
  }
  ok(call(owner, 'login-code', { id: l.id, code: 'abcdefgh#state123' }));
  assert.equal(JSON.stringify(page(env, { path: `login/${l.id}` })).includes('abcdefgh#state123'), false);
  // The code never goes into state.json: it waits in the runtime dir (0600), reaches the box once, and is gone.
  assert.equal(readFileSync(join(env.LOOM_BOX_HOME, 'state.json'), 'utf-8').includes('abcdefgh#state123'), false);
  assert.equal(statSync(join(env.XDG_RUNTIME_DIR, 'loom-runtime-codes', l.id)).mode & 0o777, 0o600);
  assert.deepEqual(ok(call(box('one'), 'poll')).logins, [{ id: l.id, harness: 'claude', state: 'checking', code: 'abcdefgh#state123' }]);
  assert.equal(readFileSync(join(env.LOOM_BOX_HOME, 'state.json'), 'utf-8').includes('abcdefgh#state123'), false);
  assert.throws(() => statSync(join(env.XDG_RUNTIME_DIR, 'loom-runtime-codes', l.id)));
  assert.deepEqual(ok(call(box('one'), 'poll')).logins, []);
  ok(call(box('one'), 'login-report', { id: l.id, state: 'done', harnesses: { claude: { installed: true, loggedIn: true, method: 'claude.ai', plan: 'max', account: 'claude-0123456789' } } }));
  assert.equal(load(env).logins[l.id].state, 'done');
  assert.equal(load(env).logins[l.id].link, undefined);
  assert.equal(load(env).boxes.one.harnesses.claude.loggedIn, true);
});

test('usage comes from a house\'s own run output, onto its box\'s login; the accounts are a view of the boxes\' reports', async () => {
  const { stateAccounts } = await import('../src/accounts.mjs');
  const hs = { claude: { installed: true, loggedIn: true, method: 'claude.ai', plan: 'max', account: 'claude-0123456789' }, codex: { installed: true, loggedIn: true, method: 'chatgpt' } };
  // fx's clock is 2026-10-25T03:00:00Z, 1792897200.
  ok(call(box('one'), 'poll', { harnesses: hs, usage: { codex: { windows: { '7d': 0.25 }, resets: { '7d': 1793300000 }, checked: 1792890000, plan: 'pro' } } }));
  // art's houses may have the box's Claude login, not its Codex one (the owner's grant).
  ok(call(owner, 'set-agent', { agent: 'art', repo: 'https://github.com/x/art.git', secrets: { 'github-token': 'gh-art' }, logins: 'claude' }));
  const h = ok(call(art, 'up', { task: 't' }));
  // Only from a house, and only a running one.
  assert.equal(call(art, 'usage', { harness: 'claude', reading: { windows: { '7d': 0.5 } } }).status, 403);
  const house = { ...art, house: h.id };
  assert.equal(call(house, 'usage', { harness: 'claude', reading: { windows: { '7d': 0.5 } } }).status, 404);
  ok(call(box('one'), 'poll'));
  assert.deepEqual(ok(call(box('one'), 'claim', { id: h.id })).logins, ['claude']);
  // A house can't speak for a login it wasn't given.
  const notMine = call(house, 'usage', { harness: 'codex', reading: { windows: { '7d': 0.9 } } });
  assert.equal(notMine.status, 403);
  assert.match(notMine.body.error, /wasn't given the box's codex login/);
  assert.equal(call(house, 'usage', { harness: 'claude', reading: { windows: { '7d': 'x' } } }).status, 400);
  // Values are clamped: utilization to 0..1, a reset only within 8 days, a check time no later than now.
  ok(call(house, 'usage', { harness: 'claude', reading: { windows: { '7d': 0.63, '5h': 7 }, resets: { '7d': 1793300000, '5h': 1899999999 }, checked: 1999999999 } }));
  assert.deepEqual(load(env).boxes.one.usage.claude.house, { windows: { '7d': 0.63, '5h': 1 }, resets: { '7d': 1793300000 }, checked: 1792897200, source: 'house', house: h.id });
  const a = stateAccounts(env, { now: () => Date.parse('2026-10-25T03:00:00Z') }).list().accounts;
  // Keys are the box owner's, salted; the label is all a body sees. art was granted Claude only: Codex's account isn't offered to it.
  assert.deepEqual(a.map((x) => [x.harness, x.label, x.boxes, x.agents]), [
    ['claude', 'Claude Max (owner\'s)', ['one'], ['art', 'mark']],
    ['codex', 'Codex Pro (owner\'s)', ['one'], ['mark']],
  ]);
  assert.match(a[0].name, /^owner:claude-[0-9a-f]{10}$/);
  assert.equal(JSON.stringify(a).includes('0123456789'), false);
  // An agent caller sees no account hash in the list.
  assert.equal(JSON.stringify(ok(call(art, 'list')).boxes).includes('0123456789'), false);
  assert.equal(JSON.stringify(ok(call(owner, 'list')).boxes).includes('0123456789'), true);
  assert.deepEqual(a[0].usage, { '7d': 0.63, '5h': 1, reset_7d: 1793300000, checked: 1792897200 });
  assert.deepEqual([a[0].usageFrom, a[1].usageFrom], ['house', 'box']);
  // 5h is full: no room on that account.
  const { hasRoom } = await import('../src/accounts.mjs');
  assert.equal(hasRoom(a[0]), false);
  assert.equal(hasRoom(a[1]), true);
});

test('an agent\'s work runs only on its owner\'s boxes: member B\'s agent never lands on member A\'s box, and is offered no model when B has no logged-in box', async () => {
  const { writeFileSync: w, mkdirSync: md } = await import('node:fs');
  const { resolveFor } = await import('../src/models.mjs');
  const { stateAccounts } = await import('../src/accounts.mjs');
  env.LOOM_HOME = join(env.HOME, 'loom');
  md(env.LOOM_HOME, { recursive: true });
  w(join(env.LOOM_HOME, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark', 'pond-bot'], members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'loren', role: 'owner', agents: ['pond-bot'] }] }));
  ok(call(owner, 'set-agent', { agent: 'pond-bot', repo: 'https://x/pond-bot.git' }));
  // loom's own box (one) is jonathan's: the first household owner's. A box of loren's.
  const lb = ok(call(owner, 'add-box', { name: 'loren-rig' }));
  ok(call(owner, 'box-owner', { name: lb.box, owner: 'loren' }));
  assert.equal(call(owner, 'box-owner', { name: lb.box, owner: 'nobody' }).status, 400);
  // pond-bot is loren's: never on jonathan's box, named or not.
  const named = call(owner, 'up', { agent: 'pond-bot', box: 'one', task: 't' });
  assert.equal(named.status, 403);
  assert.match(named.body.error, /jonathan's box, and pond-bot isn't their agent/);
  assert.equal(call(owner, 'up', { agent: 'pond-bot', task: 't' }).status, 409);
  assert.equal(call(owner, 'set-primary', { agent: 'pond-bot', box: 'one' }).status, 200, 'loom\'s own box: setPrimary clears to it');
  ok(call(owner, 'set-primary', { agent: 'pond-bot', box: lb.box }));
  assert.equal(ok(call(owner, 'up', { agent: 'pond-bot', task: 't' })).box, lb.box);
  // art is jonathan's: never on loren's box.
  assert.equal(call(owner, 'up', { agent: 'art', box: 'loren-rig', task: 't' }).status, 403);
  // Models: jonathan's box is logged in to Claude; loren's to nothing. pond-bot is offered nothing.
  ok(call(box('one'), 'poll', { harnesses: { claude: { installed: true, loggedIn: true, plan: 'max', account: 'claude-0123456789' } } }));
  const accounts = stateAccounts(env, { now: () => Date.parse('2026-10-25T03:00:00Z') });
  const models = { ...env, LOOM_RUNTIME_SCORECARDS: 'off' };
  assert.equal((await resolveFor(models, { agent: 'art', venue: 'wake', accounts })).harness, 'claude');
  await assert.rejects(resolveFor(models, { agent: 'pond-bot', venue: 'wake', accounts }), (e) => e.status === 409 && /no box of pond-bot's owner is logged in to claude/.test(e.message));
  // Lent by name, jonathan's box takes pond-bot's work, but never on jonathan's login: nothing is offered for it,
  // as the claim won't mount it (one rule for both: owners.mjs, mayUseLogin).
  ok(call(owner, 'box-lend', { name: 'one', agents: 'pond-bot' }));
  assert.equal(ok(call(owner, 'up', { agent: 'pond-bot', box: 'one', task: 't' })).box, 'one');
  await assert.rejects(resolveFor(models, { agent: 'pond-bot', venue: 'wake', accounts }), (e) => e.status === 409);
  ok(call(owner, 'box-lend', { name: 'one', agents: '' }));
  assert.equal(call(owner, 'up', { agent: 'pond-bot', box: 'one', task: 't' }).status, 403);
});

test('a house that can\'t be claimed fails after a few tries, saying why, instead of waiting forever', () => {
  fx.secret = () => { throw new Error('the secrets store is down'); };
  const h = ok(call(art, 'up', { task: 't' }));
  for (let i = 0; i < MAX_CLAIM_TRIES; i++) {
    ok(call(box(h.box), 'poll'));
    assert.equal(call(box(h.box), 'claim', { id: h.id }).status, 500);
  }
  const after = ok(call(owner, 'list')).houses.find((x) => x.id === h.id);
  assert.equal(after.state, 'failed');
  assert.match(after.log, /couldn't claim it 5 times: .*secrets store is down/);
});

test('a part bigger than a pipe\'s default buffer exports (the saved states made it 1 MB+: ENOBUFS, and the bundle had no runtime part)', { skip: !process.env.PATH.split(':').some((d) => { try { return statSync(join(d, 'age')).isFile(); } catch { return false; } }) && 'no age' }, async () => {
  const { exportPart, importPart } = await import('../src/bundle.mjs');
  const { PART_RAW, partsOf } = await import('../src/blobs.mjs');
  const { spawnSync } = await import('node:child_process');
  const { randomBytes } = await import('node:crypto');
  const key = join(env.HOME, 'owner.key');
  spawnSync('age-keygen', ['-o', key]);
  const recipient = spawnSync('age-keygen', ['-y', key], { encoding: 'utf-8' }).stdout.trim();
  const state = randomBytes(3 * 1024 * 1024);
  const parts = partsOf(state.length);
  for (let part = 0; part < parts; part++) {
    ok(call(owner, 'seed-state', { agent: 'art', name: 'discord', part, parts, state: state.subarray(part * PART_RAW, (part + 1) * PART_RAW).toString('base64') }));
  }
  const part = exportPart({ ...env, LOOM_EXPORT_RECIPIENTS: recipient, PATH: process.env.PATH });
  assert.ok(part.length > 4 * 1024 * 1024);
  const there = { HOME: env.HOME, LOOM_BOX_HOME: join(env.HOME, 'big'), LOOM_BOX_LOCAL_NAME: 'two', PATH: process.env.PATH, LOOM_IMPORT_IDENTITY: key };
  importPart(there, part);
  const back = ok(api(there, fx, { caller: owner, path: 'saved-state', body: { agent: 'art', name: 'discord', part: 0 } }));
  assert.equal(back.bytes, state.length);
});

test('a restore comes up quiet: every service that was up is down, saying so, and nothing starts until the owner brings it up', { skip: !process.env.PATH.split(':').some((d) => { try { return statSync(join(d, 'age')).isFile(); } catch { return false; } }) && 'no age' }, async () => {
  const { exportPart, importPart } = await import('../src/bundle.mjs');
  const { spawnSync } = await import('node:child_process');
  const key = join(env.HOME, 'owner.key');
  spawnSync('age-keygen', ['-o', key]);
  const recipient = spawnSync('age-keygen', ['-y', key], { encoding: 'utf-8' }).stdout.trim();
  ok(call(art, 'service-up', { name: 'discord' }));
  const part = exportPart({ ...env, LOOM_EXPORT_RECIPIENTS: recipient, PATH: process.env.PATH });
  // Another machine: the bridge must not answer from both (the old one may still be up).
  const there = { HOME: env.HOME, LOOM_BOX_HOME: join(env.HOME, 'quiet'), LOOM_BOX_LOCAL_NAME: 'two', PATH: process.env.PATH, LOOM_IMPORT_IDENTITY: key };
  importPart(there, part);
  const l = ok(api(there, fx, { caller: owner, path: 'list', body: {} }));
  assert.equal(l.services[0].want, 'down');
  assert.deepEqual(ok(api(there, fx, { caller: { kind: 'piece', subject: 'two' }, path: 'poll', body: {} })).start, []);
  const raw = JSON.parse(readFileSync(join(env.HOME, 'quiet', 'state.json'), 'utf-8'));
  assert.match(raw.services['art/discord'].note, /restored/);
  ok(api(there, fx, { caller: owner, path: 'service-up', body: { agent: 'art', name: 'discord' } }));
  assert.equal(ok(api(there, fx, { caller: { kind: 'piece', subject: 'two' }, path: 'poll', body: {} })).start.length, 1);
});

test('adding a box that fails after the mint leaves no live credential behind (labels checked first; anything later revokes it)', () => {
  revoked = [];
  const before = minted.length;
  assert.equal(call(owner, 'add-box', { name: 'jonbox', labels: 'Windows rtx' }).status, 400);
  assert.equal(minted.length, before, 'bad labels are refused before a token is minted');
  // A failure after the mint (here the save): the token it just made is revoked.
  const saved = fx.now;
  let n = 0;
  fx.now = () => { if (++n === 1) throw new Error('disk full'); return saved(); };
  assert.equal(call(owner, 'add-box', { name: 'jonbox' }).status, 500);
  fx.now = saved;
  assert.equal(revoked.length, 1);
  assert.match(revoked[0], /^box · jonbox \([0-9a-f-]{27}\)$/);
  assert.equal(ok(call(owner, 'list')).boxes.some((b) => b.name === 'jonbox'), false);
});

test('an unexpected failure on the page says what failed and where the full error is (loom keeps no piece stderr)', async () => {
  const { act } = await import('../src/ui.mjs');
  const { readFileSync } = await import('node:fs');
  const boom = { ...fx, mint: () => { throw new Error('minting a token: loom printed something other than a token'); } };
  const r = act(env, boom, { action: 'add-box', fields: { name: 'jonbox2', may_host: 'anyone' } });
  assert.equal(r.ok, false);
  assert.match(r.message, /minting a token/);
  assert.match(r.message, /errors\.log/);
  assert.match(readFileSync(join(env.LOOM_BOX_HOME || join(env.HOME, '.config', 'loom-box'), 'errors.log'), 'utf-8'), /add-box: Error: minting a token/);
});

test("an agent owner (loom docs/specs/owners.md) sees and runs only their agents' houses; boxes and settings stay the household owner's", () => {
  const loren = { kind: 'owner', who: 'loren', agents: ['mark'] };
  const jonathan = { kind: 'owner', who: 'jonathan-barket', agents: '*' };
  const artHouse = ok(call(art, 'up', { task: 'art work' }));
  const markHouse = ok(call(loren, 'up', { agent: 'mark', task: 'mark work' }));
  assert.equal(load(env).houses[markHouse.id].by, 'loren');
  assert.equal(call(loren, 'up', { agent: 'art', task: 'x' }).status, 403);
  // Her list is mark's alone, and no box's grants.
  const mine = ok(call(loren, 'list'));
  assert.deepEqual(mine.houses.map((h) => h.agent), ['mark']);
  assert.ok(mine.boxes.every((b) => b.mayHost === undefined));
  assert.equal(call(loren, 'down', { id: artHouse.id }).status, 404);
  assert.equal(ok(call(loren, 'down', { id: markHouse.id })).state, 'stopped');
  // The household's calls are refused to her; a household owner (agents '*') still has them.
  assert.equal(call(loren, 'add-box', { name: 'sneak' }).status, 403);
  assert.equal(call(loren, 'set-agent', { agent: 'mark', repo: 'https://evil.example/x.git' }).status, 403);
  assert.equal(call(loren, 'service-up', { agent: 'art', name: 'discord' }).status, 403);
  ok(call(jonathan, 'add-box', { name: 'thor' }));
  assert.equal(ok(call(jonathan, 'list')).houses.length, 2);
});

test('a house gets the box\'s logins only on a box its agent\'s owner owns, and only those granted; a box\'s own usage reading beats a house\'s', async () => {
  const { writeFileSync: w, mkdirSync: md } = await import('node:fs');
  const { stateAccounts } = await import('../src/accounts.mjs');
  env.LOOM_HOME = join(env.HOME, 'loom');
  md(env.LOOM_HOME, { recursive: true });
  w(join(env.LOOM_HOME, 'household.json'), JSON.stringify({ v: 1, members: [{ person: 'jonathan', agents: '*' }, { person: 'loren', agents: ['pond-bot'] }] }));
  ok(call(owner, 'set-agent', { agent: 'pond-bot', repo: 'https://x/pond-bot.git' }));
  const hs = { claude: { installed: true, loggedIn: true, account: 'claude-0123456789' }, codex: { installed: true, loggedIn: true } };
  ok(call(box('one'), 'poll', { harnesses: hs }));
  const claimOf = (agent) => {
    const h = ok(call(owner, 'up', { agent, box: 'one', task: 't' }));
    ok(call(box('one'), 'poll'));
    return ok(call(box('one'), 'claim', { id: h.id }));
  };
  // jonathan's own agent, on jonathan's box: both logins, by default.
  assert.deepEqual(claimOf('art').logins, ['claude', 'codex']);
  // loren's agent, on jonathan's box lent to it: it may run there, but never on jonathan's login.
  ok(call(owner, 'box-lend', { name: 'one', agents: 'pond-bot' }));
  assert.deepEqual(claimOf('pond-bot').logins, []);
  // On loren's own box, loren's agent's logins are off until granted.
  const lb = ok(call(owner, 'add-box', { name: 'loren-rig' }));
  ok(call(owner, 'box-owner', { name: lb.box, owner: 'loren' }));
  const rig = { kind: 'piece', subject: lb.box };
  ok(call(rig, 'poll', { harnesses: hs }));
  const onRig = () => { const h = ok(call(owner, 'up', { agent: 'pond-bot', box: lb.box, task: 't' })); ok(call(rig, 'poll')); return ok(call(rig, 'claim', { id: h.id })).logins; };
  assert.deepEqual(onRig(), []);
  ok(call(owner, 'set-agent', { agent: 'pond-bot', repo: 'https://x/pond-bot.git', logins: 'codex' }));
  assert.deepEqual(onRig(), ['codex']);
  assert.equal(call(owner, 'set-agent', { agent: 'pond-bot', repo: 'https://x/pond-bot.git', logins: 'gemini' }).status, 400);
  // A house's reading and the box's own: the account shows the box's.
  const h = ok(call(owner, 'up', { agent: 'art', box: 'one', task: 't' }));
  ok(call(box('one'), 'poll'));
  ok(call(box('one'), 'claim', { id: h.id }));
  ok(call({ ...art, house: h.id }, 'usage', { harness: 'codex', reading: { windows: { '7d': 0.9 } } }));
  const codexOf = () => stateAccounts(env, { now: () => Date.parse('2026-10-25T03:00:00Z') }).list().accounts.find((x) => x.harness === 'codex' && x.boxes.includes('one'));
  assert.deepEqual([codexOf().usage['7d'], codexOf().usageFrom], [0.9, 'house']);
  ok(call(box('one'), 'poll', { usage: { codex: { windows: { '7d': 0.2 }, checked: 1792890000 } } }));
  assert.deepEqual([codexOf().usage['7d'], codexOf().usageFrom], [0.2, 'box']);
});

test('a pasted code expires after 10 minutes unclaimed, and isn\'t taken at all without a runtime dir', async () => {
  const { utimesSync } = await import('node:fs');
  ok(call(box('one'), 'poll', { harnesses: { claude: { installed: true, loggedIn: false } } }));
  const l = ok(call(owner, 'login-start', { box: 'one', harness: 'claude' }));
  ok(call(box('one'), 'poll'));
  ok(call(box('one'), 'login-report', { id: l.id, state: 'waiting', link: 'https://claude.com/cai/oauth/authorize?x=1', kind: 'paste-code' }));
  ok(call(owner, 'login-code', { id: l.id, code: 'abcdefgh#state123' }));
  const f = join(env.XDG_RUNTIME_DIR, 'loom-runtime-codes', l.id);
  // Written 11 minutes before loom's clock says now: past the code's 10, inside the sign-in's 16.
  const old = new Date(Date.parse('2026-10-25T03:00:00Z') - 11 * 60_000);
  utimesSync(f, old, old);
  assert.deepEqual(ok(call(box('one'), 'poll')).logins, [{ id: l.id, harness: 'claude', state: 'failed' }]);
  assert.match(load(env).logins[l.id].error, /expired/);
  // No runtime dir: no code is taken (it would have nowhere to wait but state.json).
  const l2 = ok(call(owner, 'login-start', { box: 'one', harness: 'claude' }));
  ok(call(box('one'), 'poll'));
  ok(call(box('one'), 'login-report', { id: l2.id, state: 'waiting', link: 'https://claude.com/cai/oauth/authorize?x=2', kind: 'paste-code' }));
  delete env.XDG_RUNTIME_DIR;
  assert.equal(call(owner, 'login-code', { id: l2.id, code: 'abcdefgh#state456' }).status, 409);
});

test('a box polling loom over plain HTTP outside the tailnet won\'t run a login', async () => {
  const { secureLoomUrl } = await import('../src/logins.mjs');
  for (const [u, yes] of [['https://loom.example.com', true], ['http://100.79.56.125:8787', true], ['http://loom.tail1234.ts.net:8787', true], ['http://127.0.0.1:8787', true],
    ['http://192.168.6.30:8787', false], ['http://100.200.1.1:8787', false], ['http://loom.example.com', false], ['ftp://x', false]]) assert.equal(secureLoomUrl(u), yes, u);
  const { runner } = await import('../src/box.mjs');
  const started = [];
  const client = { async call(path, body) { const r = api(env, fx, { caller: box('one'), path, body }); if (r.status !== 200) throw new Error(r.body.error); return r.body; } };
  const r = runner({ ...env, LOOM_BOX_DATA: join(env.HOME, 'data') }, client, { loomUrl: 'http://192.168.6.30:8787/mcp', log: () => {}, secureChannel: false,
    status: () => ({ claude: { installed: true, loggedIn: false } }), login: (h) => { started.push(h); return { code() {}, cancel() {} }; }, upgrade: () => null });
  const l = ok(call(owner, 'login-start', { box: 'one', harness: 'claude' }));
  await r.tick();
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(started, []);
  assert.equal(load(env).logins[l.id].state, 'failed');
  assert.match(load(env).logins[l.id].error, /plain HTTP, outside the tailnet/);
});
