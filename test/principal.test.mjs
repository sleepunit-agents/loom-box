// On whose behalf a body acts (principal.mjs, t-1943): what a conversation heard decides it, a signed statement says
// it, and the clock's word decides a wake's. Never the owner by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bodyPrincipal, deliver, deliveryDir, loadConv, verifyStatement } from '../src/delivery.mjs';
import { api } from '../src/control.mjs';
import { pieceName } from '../src/piece.mjs';
import { STATEMENT_TTL_S, mint, noteSender, principalOf, putWakeFor, resetActsFor, takeWakeFor, verify } from '../src/principal.mjs';
import { cvOf, here, world } from './delivery-world.mjs';

const ROOT = join(here, '..');

/** A household whose owner is jonathan (owners.mjs): his word is the owner's. */
function household(env) {
  const dir = join(env.HOME, '.config', 'loom');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }, { person: 'mark', agents: ['pip'] }, { person: 'dana', agents: ['pip'] }] }));
  return env;
}

const envOf = () => household({ HOME: mkdtempSync(join(tmpdir(), 'rt-principal-')) });
const at = '2026-11-07T12:00:00Z';
const person = (slug) => ({ agent: 'art', venue: 'slack', at, from: { kind: 'person', slug } });

test('a conversation\'s principal: the owner only when every voice was his; one other person is theirs; several, or anything unplaced, is unknown', () => {
  const env = envOf();
  const run = (...msgs) => { const c = { agent: 'art', conversation: 'cv-000000000001' }; for (const [m, o] of msgs) noteSender(env, c, m, o); return principalOf(env, c); };
  assert.deepEqual(run([person('jonathan')]), { for: 'jonathan', owner: true, people: [] });
  assert.deepEqual(run([person('loren')]), { for: 'loren', owner: false, people: ['loren'] });
  // The owner and someone else, in one conversation: the body heard Loren, so it's Loren's.
  assert.deepEqual(run([person('jonathan')], [person('loren')], [person('jonathan')]), { for: 'loren', owner: false, people: ['loren'] });
  assert.deepEqual(run([person('loren')], [person('daniel')]), { for: null, owner: false, people: ['loren', 'daniel'] });
  // A member who owns some other agent isn't this agent's owner.
  assert.equal(run([person('mark')]).owner, false);
  // An agent with two owners: the statement names the one who spoke.
  const pip = (slug) => ({ ...person(slug), agent: 'pip' });
  const c2 = { agent: 'pip' };
  noteSender(env, c2, pip('dana'));
  assert.deepEqual(principalOf(env, c2), { for: 'dana', owner: true, people: [] });
  noteSender(env, c2, pip('mark'));
  assert.deepEqual(principalOf(env, c2), { for: null, owner: true, people: [] }, 'both owners spoke: neither named');
  // Ownership is read now: dana stops owning pip, and what she steered is hers, a person's, not the owner's.
  writeFileSync(join(env.HOME, '.config', 'loom', 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }, { person: 'mark', agents: ['pip'] }, { person: 'dana', agents: [] }] }));
  assert.deepEqual(principalOf(env, c2), { for: 'dana', owner: false, people: ['dana'] });
  // A relay from another agent, or a sender no one names: it can't say.
  assert.deepEqual(run([person('jonathan')], [{ agent: 'art', at, from: { kind: 'agent', id: 'pip' } }]), { for: null, owner: false, people: [], unknown: true });
  assert.equal(run([{ agent: 'art', at, from: { kind: 'unknown' } }]).owner, false);
  // Nothing heard is never the owner.
  assert.deepEqual(principalOf(env, { agent: 'art' }), { for: null, owner: false, people: [] });
});

test('a wake is whoever the clock said; with no word from it, unknown', () => {
  const env = envOf();
  const wake = { agent: 'art', venue: 'wake', at, from: { kind: 'schedule' } };
  const run = (wakeFor) => { const c = { agent: 'art' }; noteSender(env, c, wake, { wakeFor }); return principalOf(env, c); };
  assert.equal(run('owner').owner, true);
  assert.deepEqual(run('loren'), { for: 'loren', owner: false, people: ['loren'] });
  assert.equal(run('jonathan').owner, true, 'the owner by name is the owner');
  assert.equal(run('-').owner, false);
  assert.equal(run(undefined).owner, false);
  assert.equal(run(undefined).unknown, true);
});

test('a conversation that ran before this was kept can\'t say who steered it, in any venue, until the owner vouches for it', () => {
  const env = envOf();
  const old = { agent: 'art', runs: 4 };
  noteSender(env, old, person('jonathan'));
  assert.equal(principalOf(env, old).owner, false, 'its earlier runs heard people this never saw');
  const comms = { agent: 'art', venue: 'loom', runs: 4 };
  noteSender(env, comms, { ...person('jonathan'), venue: 'loom' });
  assert.equal(principalOf(env, comms).owner, false, 'a Comms thread too: it resumes its session or its digests');
  // It only grows: the next owner message doesn't clear it. The owner's reset does.
  noteSender(env, old, person('jonathan'));
  assert.equal(principalOf(env, old).owner, false);
  resetActsFor(env, old, at);
  noteSender(env, old, person('jonathan'));
  assert.equal(principalOf(env, old).owner, true);
  // What still waits in the queue isn't set aside: the body hasn't heard it yet.
  const waiting = { agent: 'art', runs: 4, queue: [{ key: 'k', from: { kind: 'person', slug: 'loren' } }] };
  resetActsFor(env, waiting, at);
  assert.deepEqual(principalOf(env, waiting), { for: 'loren', owner: false, people: ['loren'] });
});

test('what already waits in the queue counts as heard: the body will hear it', () => {
  const env = envOf();
  // From before this was kept: Loren's message queued, no body has run yet.
  const c = { agent: 'art', runs: 0, queue: [{ key: 'k1', from: { kind: 'person', slug: 'loren' } }] };
  noteSender(env, c, person('jonathan'));
  assert.deepEqual(principalOf(env, c), { for: 'loren', owner: false, people: ['loren'] });
  const w = { agent: 'art', runs: 0, queue: [{ key: 'k2', from: { kind: 'schedule' }, kind: 'wake' }] };
  noteSender(env, w, person('jonathan'));
  assert.equal(principalOf(env, w).owner, false, 'a queued wake no one handed over for');
});

test('a statement verifies as minted, for its agent and conversation; a changed byte, another key, or age refuses it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-stmt-'));
  assert.deepEqual(verify(dir, 'x.y'), { ok: false, reason: 'not a statement' });
  const t = Date.parse(at);
  const s = mint(dir, { agent: 'art', conversation: 'cv-000000000001', principal: { for: 'loren', owner: false, people: ['loren'] } }, t);
  assert.equal(statSync(join(dir, 'principal.key')).mode & 0o777, 0o600);
  const v = verify(dir, s, t + 1000);
  assert.deepEqual({ ...v, exp: undefined }, { ok: true, agent: 'art', conversation: 'cv-000000000001', for: 'loren', owner: false, people: ['loren'], exp: undefined });
  // Claiming the owner: the payload changed, its mac didn't.
  const [p, mac] = s.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), for: 'jonathan', owner: true })).toString('base64url');
  assert.deepEqual(verify(dir, `${forged}.${mac}`, t), { ok: false, reason: 'its signature doesn\'t match' });
  // Another runtime's key (a house that minted its own) isn't this one's.
  const other = mkdtempSync(join(tmpdir(), 'rt-stmt-'));
  const theirs = mint(other, { agent: 'art', conversation: 'cv-000000000001', principal: { for: 'jonathan', owner: true } }, t);
  assert.equal(verify(dir, theirs, t).ok, false);
  assert.equal(STATEMENT_TTL_S, 300, 'five minutes');
  assert.equal(verify(dir, s, t + 299_000).ok, true);
  assert.deepEqual(verify(dir, s, t + STATEMENT_TTL_S * 1000), { ok: false, reason: 'it expired' });
  // A runtime that never minted has nothing to verify with, and makes no key by verifying.
  const none = mkdtempSync(join(tmpdir(), 'rt-stmt-'));
  assert.deepEqual(verify(none, s, t), { ok: false, reason: 'this runtime has made no statements' });
  assert.equal(spawnSync('ls', [none]).stdout.toString(), '');
});

test('the clock\'s word for a wake is taken once, and only for that agent and place; a stale one is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-wakefor-'));
  const t = Date.parse(at);
  assert.throws(() => putWakeFor(dir, { agent: 'art', place: 'wake:w-1', id: 'w-1', for: 'Not A Slug' }, t), /owner, a person's slug, or -/);
  assert.throws(() => putWakeFor(dir, { agent: 'art', place: 'wake:w-1', for: 'loren' }, t), /--id/);
  putWakeFor(dir, { agent: 'art', place: 'wake:w-1', id: 'w-1', for: 'loren' }, t);
  assert.equal(takeWakeFor(dir, 'pip', 'wake:w-1', 'w-1', t), undefined);
  assert.equal(takeWakeFor(dir, 'art', 'wake:w-2', 'w-1', t), undefined);
  assert.equal(takeWakeFor(dir, 'art', 'wake:w-1', 'w-1', t), 'loren');
  assert.equal(takeWakeFor(dir, 'art', 'wake:w-1', 'w-1', t), undefined, 'once');
  // A lane's place recurs: the owner's word for a firing that never arrived isn't the next firing's.
  putWakeFor(dir, { agent: 'art', place: 'lane:x', id: 'w-a', for: 'owner' }, t);
  assert.equal(takeWakeFor(dir, 'art', 'lane:x', 'w-b', t), undefined);
  assert.equal(takeWakeFor(dir, 'art', 'lane:x', 'w-a', t + 25 * 3600_000), undefined, 'stale');
});

test('a body asks on whose behalf it acts, proven as send is: its conversation\'s own agent, its run\'s key, its session', async () => {
  const w = world();
  household(w.env);
  // Its bodies are in a house, h-1 (t-1952): a body's call comes from there.
  w.runner.houses = new Proxy({}, { get: () => 'h-1' });
  await deliver(w.env, w.msg('dm:L', 'please merge on-pond 220'), w.o);
  const c = loadConv(w.env, cvOf('art', 'slack', 'dm:L'));
  let key = w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY;
  let session = w.sessionFor(c.conversation);
  const ask = (caller, b) => bodyPrincipal(w.env, { conversation: c.conversation, ...b }, { ...w.o, caller });
  const r = ask({ kind: 'agent', agent: 'art', house: 'h-1' }, { key, session });
  assert.deepEqual([r.ok, r.for, r.owner], [true, 'loren', false]);
  assert.equal(JSON.stringify(r).includes(key), false, 'the run\'s key is never in the answer');
  const v = verify(deliveryDir(w.env), r.statement, w.clock.now().getTime());
  assert.deepEqual([v.ok, v.agent, v.conversation, v.for, v.owner], [true, 'art', c.conversation, 'loren', false]);
  assert.equal(verifyStatement(w.env, r.statement, w.clock.now().getTime()).ok, true);
  // Several people: the names it gives are the conversation's now, not the statement's.
  await deliver(w.env, w.msg('dm:S', 'one', { from: { kind: 'person', slug: 'loren' } }), w.o);
  await deliver(w.env, w.msg('dm:S', 'two', { from: { kind: 'person', slug: 'daniel' } }), w.o);
  const S = loadConv(w.env, cvOf('art', 'slack', 'dm:S'));
  const sk = bodyPrincipal(w.env, { conversation: S.conversation, key: w.runner.envs[S.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(S.conversation) }, { ...w.o, caller: { kind: 'agent', agent: 'art', house: 'h-1' } });
  await deliver(w.env, w.msg('dm:S', 'three', { from: { kind: 'person', slug: 'eve' } }), w.o);
  assert.deepEqual(verifyStatement(w.env, sk.statement, w.clock.now().getTime()).people, ['loren', 'daniel', 'eve']);
  // Someone else speaks there after it was minted: the statement is stale.
  await deliver(w.env, w.msg('dm:L', 'me too', { from: { kind: 'person', slug: 'daniel' } }), w.o);
  assert.deepEqual(verifyStatement(w.env, r.statement, w.clock.now().getTime()), { ok: false, reason: 'its conversation has heard from someone since: ask for a new one' });
  // Two people steer it now: it moved to a house of its own (t-1952), as a new run, so Loren's run's key is spent.
  assert.match(ask({ kind: 'agent', agent: 'art', house: 'h-1' }, { key, session }).reason ?? '', /doesn't match/);
  const c2 = loadConv(w.env, c.conversation);
  key = w.runner.envs[c2.body.split(':')[1]].LOOM_BODY_KEY;
  session = w.sessionFor(c.conversation);
  assert.equal(ask({ kind: 'agent', agent: 'mark' }, { key, session }).ok, false, 'another agent, even with the key');
  assert.equal(ask({ kind: 'agent', agent: 'art', house: 'h-1' }, { session }).ok, false, 'no key');
  assert.match(ask({ kind: 'agent', agent: 'art', house: 'h-1' }, { key, session: 'someone-else' }).reason, /another session/);
  // Through the piece API, as a house's call arrives (its body is in h-1): the agent's own body answered, another
  // agent refused.
  const fx = { now: () => new Date() };
  const viaApi = await api(w.env, fx, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: 'principal', body: { conversation: c.conversation, key, session } });
  assert.equal(viaApi.status, 200, JSON.stringify(viaApi.body));
  // (Daniel spoke there too by now: several people.)
  assert.deepEqual([viaApi.body.ok, viaApi.body.for, viaApi.body.people, verifyStatement(w.env, viaApi.body.statement).ok], [true, null, ['loren', 'daniel'], true]);
  const other = await api(w.env, fx, { caller: { kind: 'agent', agent: 'mark', house: 'h-2' }, path: 'principal', body: { conversation: c.conversation, key, session } });
  assert.equal(other.status, 409);
  assert.equal((await api(w.env, fx, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: 'principal', body: { conversation: c.conversation, session } })).status, 409, 'no key');
  assert.equal((await api(w.env, fx, { caller: { kind: 'owner' }, path: 'principal', body: {} })).status, 403);
  // Nothing on the piece API sets a principal: no reset, no wake hand-over, under any name a body might try.
  for (const path of ['reset', 'principal/reset', 'principal-reset', 'wake-for', 'principal/wake']) {
    const r = await Promise.resolve().then(() => api(w.env, fx, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path, body: { conversation: c.conversation } })).catch((e) => ({ status: e.status ?? 500 }));
    assert.notEqual(r.status, 200, path);
  }
  // Nor the body's own remote CLI (path run, gates-api.mjs runFor): it has no principal verb.
  for (const argv of [['principal', '--reset', '--conversation', c.conversation], ['principal', '--wake', '--agent', 'art', '--place', 'p', '--id', 'i', '--for', 'owner']]) {
    const r = await Promise.resolve().then(() => api(w.env, fx, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: 'run', body: { argv } })).catch((e) => ({ status: e.status ?? 500, body: {} }));
    assert.notEqual(r.body?.exit ?? 1, 0, argv.join(' '));
  }
  assert.equal(loadConv(w.env, c.conversation).actsFor.people.includes('loren'), true, 'untouched');
});

test('the owner in a Comms thread is the owner\'s; a wake is what the clock handed over before it fired, else unknown', async () => {
  const w = world();
  household(w.env);
  const venues = { ...w.o.venues(), wake: { kind: 'scheduled', piece: 'loom' } };
  const o = { ...w.o, venues: () => venues };
  const of = (cv) => {
    const c = loadConv(w.env, cv);
    return bodyPrincipal(w.env, { conversation: cv, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(cv) }, { ...o, caller: { kind: 'agent', agent: 'art' } });
  };
  await deliver(w.env, { source: 'loom', id: 'c-1', agent: 'art', venue: 'loom', place: 'thread:1', from: { kind: 'person', slug: 'jonathan' }, kind: 'message', at: w.clock.now().toISOString(), text: 'merge it' }, o);
  assert.deepEqual([of(cvOf('art', 'loom', 'thread:1')).for, of(cvOf('art', 'loom', 'thread:1')).owner], ['jonathan', true]);
  // A member who owns some other agent, in this agent's Comms thread: not this agent's owner.
  await deliver(w.env, { source: 'loom', id: 'c-2', agent: 'art', venue: 'loom', place: 'thread:2', from: { kind: 'person', slug: 'mark' }, kind: 'message', at: w.clock.now().toISOString(), text: 'merge it' }, o);
  assert.deepEqual([of(cvOf('art', 'loom', 'thread:2')).for, of(cvOf('art', 'loom', 'thread:2')).owner], ['mark', false]);
  const wake = (id, place) => ({ source: 'clock', id, agent: 'art', venue: 'wake', place, label: id, from: { kind: 'schedule' }, kind: 'wake', at: w.clock.now().toISOString(), text: 'Your wake.' });
  putWakeFor(deliveryDir(w.env), { agent: 'art', place: 'wake:w-111111', id: 'w-111111', for: 'loren' });
  await deliver(w.env, wake('w-111111', 'wake:w-111111'), o);
  assert.deepEqual([of(cvOf('art', 'wake', 'wake:w-111111')).for, of(cvOf('art', 'wake', 'wake:w-111111')).owner], ['loren', false]);
  putWakeFor(deliveryDir(w.env), { agent: 'art', place: 'wake:w-222222', id: 'w-222222', for: 'owner' });
  await deliver(w.env, wake('w-222222', 'wake:w-222222'), o);
  assert.equal(of(cvOf('art', 'wake', 'wake:w-222222')).owner, true);
  await deliver(w.env, wake('w-333333', 'wake:w-333333'), o);
  assert.deepEqual([of(cvOf('art', 'wake', 'wake:w-333333')).for, of(cvOf('art', 'wake', 'wake:w-333333')).owner], [null, false]);
  // The runtime's own daily review (source: the runtime) is the owner's schedule; another piece's at that place isn't.
  await deliver(w.env, { ...wake('review-2026-11-02-art', 'review'), source: pieceName(w.env) }, o);
  const rv = loadConv(w.env, cvOf('art', 'wake', 'review'));
  assert.ok(rv, 'the review wake was queued');
  assert.equal(principalOf(w.env, rv).owner, true);
});

const cli = (env, args, input) => spawnSync(process.execPath, [join(ROOT, 'src/cli.mjs'), ...args], { env: { PATH: process.env.PATH, ...env }, input, encoding: 'utf-8' });

test('the CLI: --verify checks a statement on this machine; --wake takes the clock\'s word for a firing wake', () => {
  const HOME = mkdtempSync(join(tmpdir(), 'rt-pcli-'));
  const env = { HOME, LOOM_BOX_DATA: join(HOME, 'data') };
  const dir = join(HOME, 'data', 'delivery');
  // A conversation that heard only its owner (owners.mjs: no household file reads as one owner, "owner").
  mkdirSync(join(dir, 'conversations'), { recursive: true });
  writeFileSync(join(dir, 'conversations', 'cv-000000000001.json'), JSON.stringify({ conversation: 'cv-000000000001', agent: 'art', actsFor: { owner: true, people: [], unknown: false } }));
  const s = mint(dir, { agent: 'art', conversation: 'cv-000000000001', principal: { for: 'owner', owner: true, people: [] } });
  const ok = cli(env, ['principal', '--verify'], s);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual([JSON.parse(ok.stdout).for, JSON.parse(ok.stdout).owner], ['owner', true]);
  const gone = cli(env, ['principal', '--verify'], mint(dir, { agent: 'art', conversation: 'cv-000000000002', principal: { for: 'owner', owner: true, people: [] } }));
  assert.equal(gone.status, 1, 'a conversation this runtime has no record of');
  assert.equal(JSON.parse(gone.stdout).reason, 'this runtime has no record of its conversation');
  const bad = cli(env, ['principal', '--verify'], `${s.slice(0, -2)}${s.endsWith('AA') ? 'BA' : 'AA'}`);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  const put = cli(env, ['principal', '--wake', '--agent', 'art', '--place', 'wake:w-9', '--id', 'w-9', '--for', 'loren']);
  assert.equal(put.status, 0, put.stderr);
  assert.equal(takeWakeFor(dir, 'art', 'wake:w-9', 'w-9'), 'loren');
  assert.notEqual(cli(env, ['principal', '--wake', '--agent', 'art', '--place', 'wake:w-9', '--id', 'w-9', '--for', 'NOPE']).status, 0);
  assert.notEqual(cli(env, ['principal', '--wake', '--agent', 'art', '--place', 'wake:w-9', '--for', 'loren']).status, 0, 'no id');
  // --reset: the owner vouches for a conversation; its statement verifies again only once it's his.
  writeFileSync(join(dir, 'conversations', 'cv-000000000003.json'), JSON.stringify({ conversation: 'cv-000000000003', agent: 'art', actsFor: { owner: true, people: [], unknown: true } }));
  // Not from a process with no terminal (a body's), even with the id piped in: the owner types it at his (t-1952).
  const r0 = spawnSync(process.execPath, [join(ROOT, 'src/cli.mjs'), 'principal', '--reset', '--conversation', 'cv-000000000003'], { env: { PATH: process.env.PATH, ...env }, input: 'cv-000000000003\n', detached: true, encoding: 'utf-8' });
  assert.notEqual(r0.status, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'conversations', 'cv-000000000003.json'), 'utf-8')).actsFor.unknown, true);
  // At a terminal (here a pseudo-terminal, `script`), typing the id: reset.
  const hasScript = spawnSync('script', ['--version']).status === 0;
  if (!hasScript) return;
  const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;
  const r = spawnSync('script', ['-qec', `${q(process.execPath)} ${q(join(ROOT, 'src/cli.mjs'))} principal --reset --conversation cv-000000000003`, '/dev/null'], { env: { PATH: process.env.PATH, ...env }, input: 'cv-000000000003\n', encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'conversations', 'cv-000000000003.json'), 'utf-8')).actsFor.unknown, false);
  assert.notEqual(cli(env, ['principal', '--reset', '--conversation', 'cv-00000000000f']).status, 0, 'no such conversation');
  // In a house, --reset is refused (and would only touch the house's own copy).
  const inHouse = cli({ ...env, LOOM_URL: 'http://127.0.0.1:1/mcp', LOOM_TOKEN_FILE: join(HOME, 'tok'), HOUSE_ID: 'h-1' }, ['principal', '--reset', '--conversation', 'cv-000000000003']);
  assert.notEqual(inHouse.status, 0);
  assert.match(inHouse.stderr + inHouse.stdout, /owner's, on loom's machine/);
});

test('in a house the CLI asks the runtime\'s piece API, with its conversation, its run\'s key and its session', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  const server = createServer((req, res) => { let b = ''; req.on('data', (x) => { b += x; }); req.on('end', () => { seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, for: 'loren', owner: false, people: ['loren'], statement: 'a.b' })); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const H = mkdtempSync(join(tmpdir(), 'rt-pcli-house-'));
  writeFileSync(join(H, 'tok'), 'housetoken\n');
  try {
    const r = await new Promise((ok) => execFile(process.execPath, [join(ROOT, 'src/cli.mjs'), 'principal'], {
      env: { PATH: process.env.PATH, HOME: H, LOOM_URL: `http://127.0.0.1:${server.address().port}/mcp`, LOOM_TOKEN_FILE: join(H, 'tok'), LOOM_RUNTIME_PIECE: 'runtime',
        LOOM_BODY_CONVERSATION: 'cv-0123456789ab', LOOM_BODY_KEY: 'runkey', CLAUDE_CODE_SESSION_ID: 'sess-1234' } },
    (err, stdout, stderr) => ok({ code: err ? err.code : 0, stdout, stderr })));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(seen, [{ url: '/api/runtime/principal', auth: 'Bearer housetoken', body: { conversation: 'cv-0123456789ab', key: 'runkey', session: 'sess-1234' } }]);
    assert.equal(JSON.parse(r.stdout).statement, 'a.b');
  } finally { server.close(); }
});

function pieceCall(env, args) {
  return new Promise((ok) => {
    execFile(join(ROOT, 'house/piece-call'), args, { env }, (err, stdout, stderr) => ok({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('piece-call sends approvals and the clock the runtime\'s statement and never a typed one; other pieces get none', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  const server = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { seen.push({ url: req.url, argv: JSON.parse(b).argv }); res.end(JSON.stringify({ exit: 0, stdout: '' })); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const D = mkdtempSync(join(tmpdir(), 'pc-principal-'));
  writeFileSync(join(D, 'tok'), 'sekrit\n');
  // A stand-in runtime: what `loom-runtime principal` would answer, recording how it was asked.
  const fake = join(D, 'loom-runtime');
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${join(D, 'asked')}'\necho '{"ok":true,"for":"loren","owner":false,"statement":"eyJ2IjoxfQ.c2ln"}'\n`, { mode: 0o755 });
  const env = { PATH: '/usr/bin:/bin', LOOM_URL: `http://127.0.0.1:${server.address().port}/mcp`, LOOM_TOKEN_FILE: join(D, 'tok'), PIECE_CALL_RUNTIME: fake, LOOM_BODY_CONVERSATION: 'cv-0123456789ab' };
  try {
    await pieceCall(env, ['approvals', 'rule', 'merge', 'github:a/b#1@' + '0'.repeat(40), '--principal', 'typed.owner']);
    await pieceCall(env, ['clock', 'in', '4h']);
    await pieceCall(env, ['tasks', 'ready']);
    await pieceCall({ ...env, LOOM_BODY_CONVERSATION: '' }, ['approvals', 'check', 'a-12345678', '--principal=typed.owner']);
    assert.deepEqual(seen.map((s) => s.argv), [
      ['rule', 'merge', 'github:a/b#1@' + '0'.repeat(40), '--principal', 'eyJ2IjoxfQ.c2ln'],
      ['in', '4h', '--principal', 'eyJ2IjoxfQ.c2ln'],
      ['ready'],
      ['check', 'a-12345678'],
    ]);
    // The runtime's CLI tells the body's conversation itself (its house's session map, t-2053), never piece-call from env.
    assert.equal(readFileSync(join(D, 'asked'), 'utf-8'), 'principal\nprincipal\n');
    // A runtime that refuses (a body left in the shared house from before t-2061): no statement, and it says why
    // (t-2136), so a body reading "ask, for ?" knows it isn't the rules. Nothing it typed stands in.
    const refuses = join(D, 'refuses');
    writeFileSync(join(D, 'refusal'), JSON.stringify({ ok: false, reason: 'only the body holding cv-0123456789ab asks on whose behalf it acts (its conversation has moved to another principal\'s house)' }));
    writeFileSync(refuses, `#!/bin/sh\ncat '${join(D, 'refusal')}'\nexit 1\n`, { mode: 0o755 });
    seen.length = 0;
    const r = await pieceCall({ ...env, PIECE_CALL_RUNTIME: refuses }, ['approvals', 'rule', 'merge', 'x', '--principal', 'typed.owner']);
    assert.deepEqual(seen.map((s) => s.argv), [['rule', 'merge', 'x']]);
    assert.match(r.stderr, /^piece-call: no statement of whom this body works for \(only the body holding cv-0123456789ab .*moved to another principal's house\)\), so the piece treats it as someone loom can't name\n$/);
    // Out of a body there's nothing to prove, and nothing said.
    assert.equal((await pieceCall({ ...env, PIECE_CALL_RUNTIME: refuses, LOOM_BODY_CONVERSATION: '' }, ['approvals', 'list'])).stderr, '');
  } finally { server.close(); }
});

test('wake provenance follows same-agent continuations without widening their principal or exposing other agents', async () => {
  const w = world(); household(w.env);
  const venues = { ...w.o.venues(), wake: { kind: 'scheduled', piece: 'clock' } };
  const o = { ...w.o, venues: () => venues };
  const root = await deliver(w.env, w.msg('origin-root', 'owner work'), o);
  const wake = async (id, origin, who = 'owner') => {
    const place = `wake:${id}`;
    putWakeFor(deliveryDir(w.env), { agent: 'art', place, id, for: who, origin });
    return deliver(w.env, { source: 'clock', id, agent: 'art', venue: 'wake', place, from: { kind: 'schedule' }, kind: 'wake', at: w.clock.now().toISOString(), text: 'continue' }, o);
  };
  const one = await wake('w-origin-one', root.conversation);
  const two = await wake('w-origin-two', one.conversation, 'loren');
  assert.equal(loadConv(w.env, two.conversation).actsFor.owner, false, 'display ancestry never promotes authority');
  const call = (caller, body) => api(w.env, {}, { path: 'conversation-origins', caller, body });
  const body = { agent: 'art', conversations: [root.conversation, one.conversation, two.conversation] };
  const answer = await call({ kind: 'owner', agents: ['art'] }, body);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.origins, Object.fromEntries(body.conversations.map((cv) => [cv, root.conversation])));
  assert.equal((await call({ kind: 'agent', agent: 'art' }, body)).status, 403);
  assert.equal((await call({ kind: 'owner', agents: ['mark'] }, body)).status, 403);
  assert.deepEqual((await call({ kind: 'owner' }, { agent: 'mark', conversations: [root.conversation] })).body, { origins: {} });
  assert.equal((await call({ kind: 'owner' }, { agent: 'art', conversations: [[root.conversation]] })).status, 400);
});
