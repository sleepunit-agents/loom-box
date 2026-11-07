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
import { STATEMENT_TTL_S, mint, noteSender, principalOf, putWakeFor, takeWakeFor, verify } from '../src/principal.mjs';
import { cvOf, here, world } from './delivery-world.mjs';

const ROOT = join(here, '..');

/** A household whose owner is jonathan (owners.mjs): his word is the owner's. */
function household(env) {
  const dir = join(env.HOME, '.config', 'loom');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }, { person: 'mark', agents: ['pip'] }] }));
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
  // A relay from another agent, or a sender no one names: it can't say.
  assert.deepEqual(run([person('jonathan')], [{ agent: 'art', at, from: { kind: 'agent', id: 'pip' } }]), { for: null, owner: false, people: [], unknown: true });
  assert.equal(run([{ agent: 'art', at, from: { kind: 'unknown' } }]).owner, false);
  // Nothing heard is never the owner.
  assert.deepEqual(principalOf(env, { agent: 'art' }), { for: null, owner: false, people: [] });
});

test('a wake is whoever the clock said; with no word from it, unknown', () => {
  const env = envOf();
  const wake = { agent: 'art', venue: 'wake', at, from: { kind: 'schedule' } };
  const run = (wakeFor) => { const c = { agent: 'art' }; noteSender(env, c, wake, { wakeFor, historyFree: true }); return principalOf(env, c); };
  assert.equal(run('owner').owner, true);
  assert.deepEqual(run('loren'), { for: 'loren', owner: false, people: ['loren'] });
  assert.equal(run('jonathan').owner, true, 'the owner by name is the owner');
  assert.equal(run('-').owner, false);
  assert.equal(run(undefined).owner, false);
  assert.equal(run(undefined).unknown, true);
});

test('a conversation that ran before this was kept can\'t say who steered it, unless only the owner or the clock speak there', () => {
  const env = envOf();
  const old = { agent: 'art', runs: 4 };
  noteSender(env, old, person('jonathan'));
  assert.equal(principalOf(env, old).owner, false, 'its earlier runs heard people this never saw');
  const comms = { agent: 'art', runs: 4 };
  noteSender(env, comms, person('jonathan'), { historyFree: true });
  assert.equal(principalOf(env, comms).owner, true);
  // It only grows: the next owner message doesn't clear it.
  noteSender(env, old, person('jonathan'));
  assert.equal(principalOf(env, old).owner, false);
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
  assert.deepEqual(verify(dir, s, t + STATEMENT_TTL_S * 1000), { ok: false, reason: 'it expired' });
  // A runtime that never minted has nothing to verify with, and makes no key by verifying.
  const none = mkdtempSync(join(tmpdir(), 'rt-stmt-'));
  assert.deepEqual(verify(none, s, t), { ok: false, reason: 'this runtime has made no statements' });
  assert.equal(spawnSync('ls', [none]).stdout.toString(), '');
});

test('the clock\'s word for a wake is taken once, and only for that agent and place; a stale one is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-wakefor-'));
  const t = Date.parse(at);
  assert.throws(() => putWakeFor(dir, { agent: 'art', place: 'wake:w-1', for: 'Not A Slug' }, t), /owner, a person's slug, or -/);
  putWakeFor(dir, { agent: 'art', place: 'wake:w-1', for: 'loren' }, t);
  assert.equal(takeWakeFor(dir, 'pip', 'wake:w-1', t), undefined);
  assert.equal(takeWakeFor(dir, 'art', 'wake:w-2', t), undefined);
  assert.equal(takeWakeFor(dir, 'art', 'wake:w-1', t), 'loren');
  assert.equal(takeWakeFor(dir, 'art', 'wake:w-1', t), undefined, 'once');
  putWakeFor(dir, { agent: 'art', place: 'lane:x', for: 'owner' }, t);
  assert.equal(takeWakeFor(dir, 'art', 'lane:x', t + 25 * 3600_000), undefined);
});

test('a body asks on whose behalf it acts, proven as send is: its conversation\'s own agent, its run\'s key, its session', async () => {
  const w = world();
  household(w.env);
  await deliver(w.env, w.msg('dm:L', 'please merge on-pond 220'), w.o);
  const c = loadConv(w.env, cvOf('art', 'slack', 'dm:L'));
  const key = w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY;
  const session = w.sessionFor(c.conversation);
  const ask = (caller, b) => bodyPrincipal(w.env, { conversation: c.conversation, ...b }, { ...w.o, caller });
  const r = ask({ kind: 'agent', agent: 'art' }, { key, session });
  assert.deepEqual([r.ok, r.for, r.owner], [true, 'loren', false]);
  assert.equal(JSON.stringify(r).includes(key), false, 'the run\'s key is never in the answer');
  const v = verify(deliveryDir(w.env), r.statement, w.clock.now().getTime());
  assert.deepEqual([v.ok, v.agent, v.conversation, v.for, v.owner], [true, 'art', c.conversation, 'loren', false]);
  assert.equal(verifyStatement(w.env, r.statement, w.clock.now().getTime()).ok, true);
  // Someone else speaks there after it was minted: the statement is stale.
  await deliver(w.env, w.msg('dm:L', 'me too', { from: { kind: 'person', slug: 'daniel' } }), w.o);
  assert.deepEqual(verifyStatement(w.env, r.statement, w.clock.now().getTime()), { ok: false, reason: 'its conversation has heard from someone since: ask for a new one' });
  assert.equal(ask({ kind: 'agent', agent: 'mark' }, { key, session }).ok, false, 'another agent, even with the key');
  assert.equal(ask({ kind: 'agent', agent: 'art' }, { session }).ok, false, 'no key');
  assert.match(ask({ kind: 'agent', agent: 'art' }, { key, session: 'someone-else' }).reason, /another session/);
  // Through the piece API: only an agent's body.
  assert.equal((await api(w.env, { now: () => new Date() }, { caller: { kind: 'owner' }, path: 'principal', body: {} })).status, 403);
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
  const wake = (id, place) => ({ source: 'clock', id, agent: 'art', venue: 'wake', place, label: id, from: { kind: 'schedule' }, kind: 'wake', at: w.clock.now().toISOString(), text: 'Your wake.' });
  putWakeFor(deliveryDir(w.env), { agent: 'art', place: 'wake:w-111111', for: 'loren' });
  await deliver(w.env, wake('w-111111', 'wake:w-111111'), o);
  assert.deepEqual([of(cvOf('art', 'wake', 'wake:w-111111')).for, of(cvOf('art', 'wake', 'wake:w-111111')).owner], ['loren', false]);
  putWakeFor(deliveryDir(w.env), { agent: 'art', place: 'wake:w-222222', for: 'owner' });
  await deliver(w.env, wake('w-222222', 'wake:w-222222'), o);
  assert.equal(of(cvOf('art', 'wake', 'wake:w-222222')).owner, true);
  await deliver(w.env, wake('w-333333', 'wake:w-333333'), o);
  assert.deepEqual([of(cvOf('art', 'wake', 'wake:w-333333')).for, of(cvOf('art', 'wake', 'wake:w-333333')).owner], [null, false]);
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
  const bad = cli(env, ['principal', '--verify'], `${s.slice(0, -2)}AA`);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  const put = cli(env, ['principal', '--wake', '--agent', 'art', '--place', 'wake:w-9', '--for', 'loren']);
  assert.equal(put.status, 0, put.stderr);
  assert.equal(takeWakeFor(dir, 'art', 'wake:w-9'), 'loren');
  assert.notEqual(cli(env, ['principal', '--wake', '--agent', 'art', '--place', 'wake:w-9', '--for', 'NOPE']).status, 0);
});

function pieceCall(env, args) {
  return new Promise((ok) => {
    execFile(join(ROOT, 'house/piece-call'), args, { env }, (err, stdout, stderr) => ok({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('piece-call sends approvals and the clock the runtime\'s statement, never a typed one; other pieces get none', async () => {
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
    await pieceCall({ ...env, LOOM_BODY_CONVERSATION: '' }, ['approvals', 'check', 'a-12345678']);
    assert.deepEqual(seen.map((s) => s.argv), [
      ['rule', 'merge', 'github:a/b#1@' + '0'.repeat(40), '--principal', 'eyJ2IjoxfQ.c2ln'],
      ['in', '4h', '--principal', 'eyJ2IjoxfQ.c2ln'],
      ['ready'],
      ['check', 'a-12345678'],
    ]);
    assert.equal(readFileSync(join(D, 'asked'), 'utf-8'), 'principal --conversation cv-0123456789ab\nprincipal --conversation cv-0123456789ab\n');
  } finally { server.close(); }
});
