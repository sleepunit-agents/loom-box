// Delivery (loom docs/specs/agent-runtime.md, section 5), against a fake runner and a fake core: what the spec's tests
// pin for the runtime ("What the tests must pin", 1-3):
//   1. one way to start a body: a delivery from a test source, and a relay, each start a body through the runner
//      interface;
//   2. delivery records first, and once: the turn is in core before any body sees it; a body that fails to start
//      still leaves the turn, and answers `failed`; a repeated (source, id) within 24 h writes no second turn;
//   3. capacity and continuity (bridges.md): the same key reaches the same body; capacity counts busy bodies; over
//      the limit a new conversation takes a warm idle body's place; only busy bodies make a message wait; a resumed
//      body restores its slot.
// And outbound: a venue's `send`, one retry, the agent's turn answered or failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticAccounts } from '../src/accounts.mjs';
import { readBody } from '../src/bodies.mjs';
import { CoreError, venuesOf } from '../src/core.mjs';
import { deliver, deliveryDir, depsOf, drain, loadConv, send, tick, windowMs } from '../src/delivery.mjs';
import { api, setAgent } from '../src/control.mjs';
import { bodyBox } from '../src/placement.mjs';
import { runtimeKey } from '../src/sealed.mjs';
import { load, update } from '../src/state.mjs';
import { setModels } from '../src/models.mjs';
import { RunnerError, inbox } from '../src/runners.mjs';
import { ageSealer } from '../src/sealed.mjs';
import { scratch } from './scratch.mjs';
import { StoreError } from '../src/store.mjs';

import { here, pkg, cvOf, hasAge, fakeRunner, fakeCore, testSealer, world, plain } from './delivery-world.mjs';

test('the piece offers delivery: an argv of its own bin, which core runs with the deliver body on stdin', () => {
  assert.deepEqual(pkg.loom.delivery, ['loom-runtime', 'deliver']);
  assert.ok(Object.keys(pkg.bin).includes(pkg.loom.delivery[0]));
  assert.ok(pkg.loom.services.some((s) => s.name === 'delivery' && s.argv.join(' ') === 'loom-runtime deliver run'));
});

test('1. one way to start a body: a delivery from a source, and a relay, each start one through the runner interface', async () => {
  const w = world();
  const a = await deliver(w.env, w.msg('dm:U1', 'what did we decide about the pond?'), w.o);
  const cv = cvOf('art', 'slack', 'dm:U1');
  assert.deepEqual(a, { conversation: cv, seq: 1, body: 'started' });
  const [, id, brief] = w.log.find((l) => l[0] === 'start');
  const c = loadConv(w.env, cv);
  // Line 1 is the brief's opening (the Claude runner puts its spawn token on line 2); its conversation and run, for identity.
  assert.equal(brief.split('\n')[0], 'You are art, in a conversation on slack: Loren (dm:U1).');
  assert.ok(brief.includes(`identity with {conversation: "${cv}", run: "${c.run}"}`));
  assert.ok(brief.includes(`loom runtime send --conversation ${cv}`), 'slack declares a send: the body is told how to answer');
  assert.match(brief, /final response alone does not send a reply/);
  assert.match(brief, /arrange a concrete continuation/);
  assert.ok(plain(brief).endsWith('loren: what did we decide about the pond?'));
  assert.equal(c.body, `claude:${id}`);
  assert.equal(readBody(w.env, c.body).venue, 'slack');
  // A relay: from another agent, on the runtime's own venue.
  const r = await deliver(w.env, { source: 'runtime', id: 'relay-1', agent: 'art', venue: 'relay', place: 'mark', from: { kind: 'agent', id: 'mark' }, kind: 'message', at: w.clock.now().toISOString(), text: 'can you look at PR 12?' }, w.o);
  assert.equal(r.body, 'started');
  const starts = w.log.filter((l) => l[0] === 'start');
  assert.equal(starts.length, 2);
  assert.ok(plain(starts[1][2]).endsWith('mark: can you look at PR 12?'));
  assert.equal(starts[1][2].includes('runtime send'), false, 'relay declares no send here');
  // Nothing of the message is kept as it came: the conversation's record holds no text.
  assert.equal(readFileSync(join(deliveryDir(w.env), 'conversations', `${cv}.json`), 'utf-8').includes('pond'), false);
});

test('2. delivery records first, and once; a body that fails to start leaves the turn standing', async () => {
  const w = world();
  await deliver(w.env, w.msg('dm:U1', 'hello'), w.o);
  assert.deepEqual(w.kinds(), ['turn', 'audit', 'start'], 'the turn and its text are in core before any body sees it');
  assert.deepEqual(w.core.turns[0], { key: 'test-source:m-1', agent: 'art', venue: 'slack', place: 'dm:U1', at: '2026-11-02T12:00:00.000Z', from: { kind: 'person', slug: 'loren' }, kind: 'message', label: 'Loren (dm:U1)', conversation: cvOf('art', 'slack', 'dm:U1'), seq: 1 });
  assert.deepEqual(w.core.audits[0], { conversation: cvOf('art', 'slack', 'dm:U1'), seq: 1, text: 'hello' });

  // Core can't take the turn: a 5xx, and nothing reaches a body.
  w.core.down = true;
  const down = await deliver(w.env, w.msg('dm:U2', 'are you there?'), w.o);
  assert.equal(down.status, 503);
  assert.match(down.error, /ECONNREFUSED/);
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 1);
  assert.equal(loadConv(w.env, cvOf('art', 'slack', 'dm:U2')), null);
  // A turn core didn't answer may have landed: nothing's kept of the attempt, and the retry posts the same turn with
  // the same key (core answers the first write if it landed). This one never landed: written once.
  w.core.down = false;
  const again = { ...w.msg('dm:U2', 'are you there?'), id: 'retry-me' };
  w.core.down = true;
  assert.equal((await deliver(w.env, again, w.o)).status, 503);
  const seenDir = join(deliveryDir(w.env), 'seen');
  assert.equal(readdirSync(seenDir).map((n) => readFileSync(join(seenDir, n), 'utf-8')).some((x) => x.includes('uncertain')), false);
  w.core.down = false;
  const turnsBefore = w.core.turns.length;
  assert.equal((await deliver(w.env, again, w.o)).body, 'started');
  assert.equal(w.core.turns.length, turnsBefore + 1);

  // A body that fails to start: the turn stands, and the runtime will try again (queued, saying why).
  w.runner.failStart = 'claude --bg didn\'t start: Error: not logged in';
  const failed = await deliver(w.env, w.msg('dm:U3', 'ping'), w.o);
  assert.deepEqual(failed, { conversation: cvOf('art', 'slack', 'dm:U3'), seq: 1, body: 'queued', reason: 'no body could start (claude --bg didn\'t start: Error: not logged in): trying again in 60 s' });
  assert.ok(w.core.turns.some((t) => t.place === 'dm:U3'));
  w.runner.failStart = null;

  // The same (source, id) within 24 h: the first answer, and nothing written.
  const m = w.msg('dm:U4', 'once', { source: 'slack' });
  const first = await deliver(w.env, m, w.o);
  const turns = w.core.turns.length;
  const starts = w.log.filter((l) => l[0] === 'start').length;
  w.clock.advance(23 * 3600_000);
  assert.deepEqual(await deliver(w.env, m, w.o), first);
  assert.equal(w.core.turns.length, turns);
  assert.equal(w.log.filter((l) => l[0] === 'start').length, starts);
  // Another source's message with the same id is its own.
  assert.equal((await deliver(w.env, { ...m, source: 'discord' }, w.o)).seq, 2);
  // Past 24 h it's a new delivery.
  w.clock.advance(2 * 3600_000);
  await tick(w.env, w.o);
  assert.equal((await deliver(w.env, m, w.o)).seq, 3);

  // An audit write that fails leaves the turn standing without its text, and the body still gets the message.
  w.core.auditDown = true;
  assert.equal((await deliver(w.env, w.msg('dm:U5', 'no audit'), w.o)).body, 'started');
  // A malformed delivery is refused whole, before anything is written.
  const before = w.core.turns.length;
  assert.equal((await deliver(w.env, { ...w.msg('dm:U6', 'x'), text: '' }, w.o)).status, 400);
  assert.equal((await deliver(w.env, { ...w.msg('dm:U6', 'x'), extra: 1 }, w.o)).status, 400);
  assert.equal((await deliver(w.env, { ...w.msg('dm:U6', 'x'), kind: 'reply' }, w.o)).status, 400);
  // core refuses `note` on deliver, and adds `source` as it forwards: a body without one isn't core's.
  assert.equal((await deliver(w.env, { ...w.msg('dm:U6', 'x'), kind: 'note' }, w.o)).status, 400);
  const { source: _s, ...unsourced } = w.msg('dm:U6', 'x');
  assert.match((await deliver(w.env, unsourced, w.o)).error, /source is the calling piece/);
  assert.equal(w.core.turns.length, before);
});

test('3. capacity and continuity: same body, busy-only capacity, a warm idle body makes room, a slot resumes', async () => {
  const w = world({ LOOM_RUNTIME_BUSY_LIMIT: '2', LOOM_RUNTIME_CONTINUITY: '{"slack": 7}' });
  const A = cvOf('art', 'slack', 'dm:A');
  const B = cvOf('art', 'slack', 'dm:B');
  const C = cvOf('art', 'slack', 'dm:C');
  // The same key reaches the same body: the second message is fed into it mid-turn.
  assert.equal((await deliver(w.env, w.msg('dm:A', 'one'), w.o)).body, 'started');
  const aBody = loadConv(w.env, A).body;
  assert.equal((await deliver(w.env, w.msg('dm:A', 'two'), w.o)).body, 'fed');
  assert.deepEqual([...w.log.at(-1).slice(0, 2), plain(w.log.at(-1)[2])], ['feed', aBody.split(':')[1], 'loren: two']);
  assert.equal((await deliver(w.env, w.msg('dm:B', 'b one'), w.o)).body, 'started');

  // Capacity counts busy bodies: two mid-turn, so a third conversation's message waits.
  const c1 = await deliver(w.env, w.msg('dm:C', 'c one'), w.o);
  assert.equal(c1.body, 'queued');
  assert.match(c1.reason, /every body is busy \(2 of 2 mid-turn\)/);
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 2);
  // Waiting, its text is sealed, never kept as it came.
  assert.equal(readFileSync(join(deliveryDir(w.env), 'conversations', `${C}.json`), 'utf-8').includes('c one'), false);

  // A's turn ends: A is warm and idle, and holds no slot. Over the limit (2 warm), C takes A's place:
  // A is ended, its session sealed into its slot (its local transcript gone), and C starts.
  w.runner.finish(aBody);
  await tick(w.env, w.o);
  const cStart = w.log.findIndex((l) => l[0] === 'start' && l[2].includes('c one'));
  const aEnd = w.log.findIndex((l) => l[0] === 'end' && l[1] === aBody.split(':')[1]);
  assert.ok(aEnd >= 0 && aEnd < cStart, 'the idle body is ended first, then the new conversation starts in its place');
  assert.equal(loadConv(w.env, C).outcomes[Object.keys(loadConv(w.env, C).outcomes)[0]].body, 'started');
  const a = loadConv(w.env, A);
  assert.equal(a.body, undefined);
  assert.deepEqual([a.slot.harness, a.slot.session], ['claude', `s-${aBody.split(':')[1]}`]);
  assert.equal(a.slot.until, '2026-11-09T12:00:00.000Z', 'kept for slack\'s window, 7 days');
  const slotPath = join(deliveryDir(w.env), 'slots', `${A}.age`);
  assert.equal(statSync(slotPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(slotPath, 'utf-8').includes('transcript'), false);
  assert.equal(existsSync(w.runner.transcript(a.slot.session)), false, 'the harness\'s own transcript is in the slot now, not on disk');

  // Only busy bodies make a message wait: B and C are mid-turn, so A's next message waits.
  const a3 = await deliver(w.env, w.msg('dm:A', 'three'), w.o);
  assert.equal(a3.body, 'queued');
  // B's turn ends; on the tick, B makes room and A is resumed from its slot: its session files are back where its
  // harness looks before the resume, and the resume continues A's own session.
  w.runner.finish(loadConv(w.env, B).body);
  await tick(w.env, w.o);
  const resumed = w.log.find((l) => l[0] === 'resume');
  assert.equal(resumed[2], a.slot.session);
  assert.match(resumed[3], /^transcript of c0000000: You are art/, 'the slot restored the session before the resume');
  assert.match(plain(resumed[4]), /loren: three$/);
  assert.match(resumed[4], new RegExp(`run is ${loadConv(w.env, A).run}`));
  assert.ok(resumed[4].includes(`loom runtime send --conversation ${A}`));
  assert.match(resumed[4], /final response alone does not send a reply/);
  assert.match(resumed[4], /arrange a concrete continuation/);
  assert.equal(existsSync(slotPath), false, 'restored: the session is the live body\'s again');
  assert.equal(loadConv(w.env, B).slot.session.startsWith('s-c'), true);

  // A conversation whose own body is warm and idle is resumed in the same session (its turn is over: no inbox hears it).
  w.runner.finish(loadConv(w.env, C).body);
  const cSession = w.runner.slotOf({ id: loadConv(w.env, C).body.split(':')[1] }).session;
  const c2 = await deliver(w.env, w.msg('dm:C', 'c two'), w.o);
  assert.equal(c2.body, 'resumed');
  assert.equal(w.log.at(-1)[2], cSession);

  // A warm body idle past its time is ended on the tick, its slot saved (its idle time counts from the tick that saw it).
  w.runner.finish(loadConv(w.env, C).body);
  await tick(w.env, w.o);
  w.clock.advance(599_000);
  await tick(w.env, w.o);
  assert.ok(loadConv(w.env, C).body, 'still warm at 599 s');
  w.clock.advance(2_000);
  await tick(w.env, w.o);
  assert.equal(loadConv(w.env, C).body, undefined);
  assert.ok(loadConv(w.env, C).slot);

  // Past its window a slot is deleted, with the harness's own local transcript files for that session; the
  // conversation then starts afresh, told where its history is (its digests).
  const bSlot = loadConv(w.env, B).slot;
  writeFileSync(w.runner.transcript(bSlot.session), 'a stray local copy\n');
  w.clock.advance(8 * 86400_000);
  await tick(w.env, w.o);
  assert.equal(loadConv(w.env, B).slot, undefined);
  assert.equal(existsSync(join(deliveryDir(w.env), 'slots', `${B}.age`)), false);
  assert.equal(existsSync(w.runner.transcript(bSlot.session)), false);
  w.runner.finish(loadConv(w.env, A).body);
  const b2 = await deliver(w.env, w.msg('dm:B', 'b two'), w.o);
  assert.equal(b2.body, 'started');
  assert.ok(w.log.at(-1)[2].includes(`read it with conversation({id: "${B}"})`));
});

test('a message the runtime can\'t seal is delivered at once, or (when it would have to wait) not kept', async () => {
  const w = world({ LOOM_RUNTIME_BUSY_LIMIT: '1' });
  const broken = { ...w.o, sealer: { seal() { throw new Error('no age'); }, open() { throw new Error('no age'); } } };
  assert.equal((await deliver(w.env, w.msg('dm:N', 'unsealed but deliverable'), broken)).body, 'started');
  // Its one slot is busy: this one would have to wait, and can't be kept.
  const lost = await deliver(w.env, w.msg('dm:O', 'would have to wait'), broken);
  assert.equal(lost.body, 'failed');
  assert.match(lost.reason, /can't keep its text/);
});

test('slots and waiting messages are sealed with age to the runtime\'s own key', { skip: !hasAge && 'age isn\'t installed' }, async () => {
  const w = world({ LOOM_RUNTIME_BUSY_LIMIT: '1' });
  const o = { ...w.o, sealer: ageSealer(w.env, deliveryDir(w.env)) };
  await deliver(w.env, w.msg('dm:A', 'the first secret'), o);
  const q = await deliver(w.env, w.msg('dm:B', 'THE SECOND SECRET'), o);
  assert.equal(q.body, 'queued');
  const dir = deliveryDir(w.env);
  assert.equal(statSync(join(dir, 'runtime.key')).mode & 0o777, 0o600);
  assert.match(readFileSync(join(dir, 'runtime.pub'), 'utf-8'), /^age1/);
  assert.equal(readFileSync(join(dir, 'conversations', `${cvOf('art', 'slack', 'dm:B')}.json`), 'utf-8').includes('SECOND SECRET'), false);
  // A's turn ends; B takes its place, so A's session goes into its slot: an age file, not its text.
  w.runner.finish(loadConv(w.env, cvOf('art', 'slack', 'dm:A')).body);
  await tick(w.env, o);
  assert.ok(w.log.some((l) => l[0] === 'start' && plain(l[2]).endsWith('THE SECOND SECRET')), 'opened again for its body');
  const slot = readFileSync(join(dir, 'slots', `${cvOf('art', 'slack', 'dm:A')}.age`));
  assert.equal(slot.subarray(0, 21).toString(), 'age-encryption.org/v1');
  assert.equal(slot.includes(Buffer.from('first secret')), false);
});

test('outbound: accepted at once; the venue\'s send (--place, --agent, the text on stdin), retried once if it says no, then the agent\'s turn', async () => {
  const w = world();
  // send() accepts; the post it starts is what this test waits on.
  const sendNow = async (b) => { let p; const r = await w.send(b, { ...w.o, onSend: (x) => { p = x; } }); return { ...r, post: p ? await p : null }; };
  const S = scratch('rt-send-');
  process.env.FAKE_SEND = S;
  const calls = () => (existsSync(join(S, 'calls.log')) ? readFileSync(join(S, 'calls.log'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  await deliver(w.env, w.msg('dm:U1', 'hi'), w.o);
  const cv = cvOf('art', 'slack', 'dm:U1');
  const c = loadConv(w.env, cv);
  // Sent first, then recorded: when the reply's turn is written, the venue has already been called.
  const turn = w.core.turn;
  let sentBefore;
  w.core.turn = (t) => { sentBefore = calls().length; return turn(t); };
  const key = w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY;
  const ok = await sendNow({ conversation: cv, text: 'Hi Loren!', key });
  w.core.turn = turn;
  assert.equal(sentBefore, 1);
  assert.equal(ok.accepted, true);
  assert.equal(ok.post.ok, true);
  assert.match(ok.post.id, /^p-/);
  assert.deepEqual(calls()[0], { argv: ['--place', 'dm:U1', '--agent', 'art'], text: 'Hi Loren!' });
  const reply = w.core.turns.at(-1);
  assert.deepEqual({ ...reply, at: undefined }, { agent: 'art', venue: 'slack', place: 'dm:U1', at: undefined, from: { kind: 'agent', id: 'art' }, kind: 'reply', run: c.run, model: 'opus', harness: 'claude', outcome: 'answered', conversation: cv, seq: 2 });
  assert.deepEqual(w.core.audits.at(-1), { conversation: cv, seq: 2, text: 'Hi Loren!' });
  // One failure: retried once, and it went.
  writeFileSync(join(S, 'fail'), '1');
  assert.equal((await sendNow({ conversation: cv, text: 'again', key })).post.ok, true);
  assert.equal(calls().length, 3);
  assert.equal(w.core.turns.at(-1).outcome, 'answered');
  // Two: the turn says failed, and the body is told why, through its inbox.
  writeFileSync(join(S, 'fail'), '2');
  const no = await sendNow({ conversation: cv, text: 'and again', key });
  assert.deepEqual([no.accepted, no.post.ok, no.post.reason], [true, false, 'the bot has no access to that channel']);
  assert.equal(calls().length, 5);
  assert.equal(w.core.turns.at(-1).outcome, 'failed');
  assert.ok(w.log.some((l) => l[0] === 'feed' && l[2] === `(couldn't post your message ${no.ref} in slack: the bot has no access to that channel)`));
  // A venue with no send: nothing posts, nothing is recorded.
  await deliver(w.env, { source: 'runtime', id: 'r-1', agent: 'art', venue: 'relay', place: 'mark', from: { kind: 'agent', id: 'mark' }, kind: 'message', at: w.clock.now().toISOString(), text: 'x' }, w.o);
  const turns = w.core.turns.length;
  const rc = loadConv(w.env, cvOf('art', 'relay', 'mark'));
  assert.match((await w.send({ conversation: rc.conversation, text: 'x', key: w.runner.envs[rc.body.split(':')[1]].LOOM_BODY_KEY }, w.o)).reason, /declares no send/);
  assert.equal(w.core.turns.length, turns);
  delete process.env.FAKE_SEND;
});

test('a wake (core\'s scheduled venue, no send): the body is told to record its reply, and it\'s recorded, posted nowhere', async () => {
  const w = world();
  const venues = { ...w.o.venues(), wake: { kind: 'scheduled', piece: 'loom' } };
  const o = { ...w.o, venues: () => venues };
  const a = await deliver(w.env, { source: 'clock', id: 'w-abc123', agent: 'art', venue: 'wake', place: 'lane:nightly', label: 'nightly', from: { kind: 'schedule' }, kind: 'wake', at: w.clock.now().toISOString(), text: 'Your lane is routines/nightly.md.' }, o);
  const cv = cvOf('art', 'wake', 'lane:nightly');
  assert.deepEqual(a, { conversation: cv, seq: 1, body: 'started' });
  const brief = w.log.find((l) => l[0] === 'start')[2];
  assert.ok(brief.includes(`loom runtime send --conversation ${cv}\`: on wake nothing is posted; it's recorded as this run's reply`), brief);
  assert.ok(brief.endsWith('Your lane is routines/nightly.md.'), 'a wake\'s text is the brief\'s message, as it came');
  const c = loadConv(w.env, cv);
  let p;
  const r = await w.send({ conversation: cv, text: 'Ran nightly: 3 pages verified.', key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY }, { ...o, onSend: (x) => { p = x; } });
  assert.equal(r.accepted, true);
  const posted = await p;
  assert.deepEqual([posted.ok, posted.recorded], [true, true]);
  const reply = w.core.turns.at(-1);
  assert.deepEqual([reply.kind, reply.venue, reply.place, reply.outcome, reply.run, reply.from], ['reply', 'wake', 'lane:nightly', 'answered', c.run, { kind: 'agent', id: 'art' }]);
  assert.deepEqual(w.core.audits.at(-1), { conversation: cv, seq: reply.seq, text: 'Ran nightly: 3 pages verified.' });
  // A live or agent venue with no send still posts and records nothing (relay, above); an orphaned scheduled one too.
  venues.wake = { kind: 'scheduled', orphaned: true };
  assert.match((await w.send({ conversation: cv, text: 'x', key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY }, o)).reason, /declares no send/);
});

test('send answers only the body holding the conversation: another body, no key, or a past run\'s key is refused', async () => {
  const w = world();
  const S = scratch('rt-send-bind-');
  process.env.FAKE_SEND = S;
  await deliver(w.env, w.msg('dm:A', 'for art, from loren'), w.o);
  await deliver(w.env, { ...w.msg('dm:B', 'for mark'), agent: 'mark' }, w.o);
  const A = loadConv(w.env, cvOf('art', 'slack', 'dm:A'));
  const B = loadConv(w.env, cvOf('mark', 'slack', 'dm:B'));
  const keyOf = (c) => w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY;
  assert.match(keyOf(A), /^[0-9a-f]{48}$/);
  assert.notEqual(keyOf(A), keyOf(B));
  // Body A, on body B's conversation: refused, nothing posted, nothing recorded.
  const turns = w.core.turns.length;
  const r = await w.send({ conversation: B.conversation, text: 'posing as mark', key: keyOf(A) }, w.o);
  assert.equal(r.ok, false);
  assert.match(r.reason, /only the body holding/);
  assert.equal((await w.send({ conversation: B.conversation, text: 'no key' }, w.o)).ok, false);
  assert.equal(existsSync(join(S, 'calls.log')), false);
  assert.equal(w.core.turns.length, turns);
  // Its own conversation: it goes.
  assert.equal((await w.send({ conversation: B.conversation, text: 'hi', key: keyOf(B) }, w.o)).accepted, true);
  // A resumed body has a new run and a new key: the old one no longer speaks.
  const old = keyOf(A);
  w.runner.finish(A.body);
  assert.equal((await deliver(w.env, w.msg('dm:A', 'again'), w.o)).body, 'resumed');
  const A2 = loadConv(w.env, A.conversation);
  assert.equal((await w.send({ conversation: A.conversation, text: 'stale', key: old }, w.o)).ok, false);
  assert.equal((await w.send({ conversation: A.conversation, text: 'fresh', key: keyOf(A2) }, w.o)).accepted, true);
  delete process.env.FAKE_SEND;
});

test('venues are core\'s answer (GET /api/loom/venues), checked: a row that doesn\'t fit is left out', () => {
  assert.deepEqual(venuesOf({ venues: [
    { name: 'slack', kind: 'live', piece: 'slack', send: ['loom-slack', 'send', '--json'] },
    { name: 'wake', kind: 'scheduled', piece: 'loom' },
    { name: 'Bad Name', kind: 'live' }, { name: 'odd', kind: 'weekly' }, { name: 'nosend', kind: 'agent', send: [1] },
  ] }), {
    slack: { kind: 'live', piece: 'slack', send: ['loom-slack', 'send', '--json'] },
    wake: { kind: 'scheduled', piece: 'loom' },
    nosend: { kind: 'agent' },
  });
  assert.deepEqual(venuesOf(null), {});
});

test('D. nothing of the runtime\'s environment reaches a body: no token, no key path, no harness login or setting', async () => {
  const w = world({ FOO_SECRET: 'hunter2', ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x', CLAUDE_CONFIG_DIR: '/home/loom/.claude', CODEX_HOME: '/home/loom/.codex', LOOM_RUNTIME_BODY_ENV: 'ANTHROPIC_API_KEY,LOOM_RUNTIME_TOKEN_FILE,SOMETHING_ELSE' });
  await deliver(w.env, w.msg('dm:E', 'hi'), w.o);
  const e = w.runner.envs[loadConv(w.env, cvOf('art', 'slack', 'dm:E')).body.split(':')[1]];
  for (const k of ['FOO_SECRET', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_BASE_URL', 'LOOM_RUNTIME_TOKEN_FILE', 'LOOM_RUNTIME_LOOM_URL', 'LOOM_BOX_DATA', 'LOOM_BOX_HOME']) assert.equal(e[k], undefined, k);
  assert.deepEqual(Object.keys(e).sort(), ['HOME', 'LANG', 'LOOM_BODY_CONVERSATION', 'LOOM_BODY_KEY', 'PATH', 'SOMETHING_ELSE'], 'the basics, what BODY_ENV may name, and its run\'s key and conversation');
  assert.equal(e.LOOM_BODY_CONVERSATION, cvOf('art', 'slack', 'dm:E'));
});

test('E. a warm body\'s inbox isn\'t lost to a resume that fails: what it held goes back on the queue', async () => {
  const w = world({}, { inboxDir: true });
  const A = cvOf('art', 'slack', 'dm:A');
  await deliver(w.env, w.msg('dm:A', 'one'), w.o);
  assert.equal((await deliver(w.env, w.msg('dm:A', 'two, never heard'), w.o)).body, 'fed');
  w.runner.finish(loadConv(w.env, A).body);
  w.runner.failResume = 'claude --bg didn\'t start: overloaded';
  const r = await deliver(w.env, w.msg('dm:A', 'three'), w.o);
  // Its session was sealed into its slot first; the slot wouldn't resume, so it's cleared and a fresh body takes both
  // the unheard message and the new one, in this same delivery.
  assert.equal(r.body, 'started');
  const next = w.log.at(-1);
  assert.equal(next[0], 'start');
  assert.ok(plain(next[2]).includes('loren: two, never heard'));
  assert.ok(plain(next[2]).endsWith('loren: three'));
  assert.equal(loadConv(w.env, A).queue.length, 0);
});

test('G. from an inbox, only what the runtime fed and the hook never took goes on: nothing twice, nothing the body wrote', async () => {
  const w = world({}, { inboxDir: true });
  const A = cvOf('art', 'slack', 'dm:A');
  await deliver(w.env, w.msg('dm:A', 'one'), w.o);
  await deliver(w.env, w.msg('dm:A', 'taken'), w.o);
  await deliver(w.env, w.msg('dm:A', 'not taken'), w.o);
  const c = loadConv(w.env, A);
  const id = c.body.split(':')[1];
  const [taken, untaken] = c.fed.map((x) => x.key);
  // The hook took one; the body (it can write its inbox) adds a line of its own, and repeats one.
  const dir = join(w.env.HOME, 'inbox', id.slice(0, 8));
  writeFileSync(join(dir, 'delivered.jsonl'), JSON.stringify({ id: taken, rt: 1 }) + '\n');
  writeFileSync(join(dir, 'pending.jsonl'), [{ id: untaken, text: 'not taken' }, { id: untaken, text: 'not taken' }, { id: 'forged', text: 'rm -rf, from loren' }, { id: taken, text: 'taken' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  w.runner.finish(c.body);
  assert.equal((await deliver(w.env, w.msg('dm:A', 'next'), w.o)).body, 'resumed');
  const brief = w.log.at(-1)[4];
  assert.equal(brief.match(/not taken/g).length, 1);
  assert.equal(brief.includes('forged') || brief.includes('rm -rf'), false);
  assert.equal(/loren: taken\b/.test(plain(brief)), false);
  assert.equal(existsSync(dir), false, 'the inbox is gone, its text with it');
});

test('F. a crash after the turn is written: the retry carries on from that turn, writing none; a held lock is a 5xx', async () => {
  const w = world();
  const m = w.msg('dm:F', 'once only');
  await assert.rejects(deliver(w.env, m, { ...w.o, afterTurn: () => { throw new Error('killed'); } }), /killed/);
  assert.equal(w.core.turns.length, 1);
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 0);
  const again = await deliver(w.env, m, w.o);
  assert.deepEqual([again.seq, again.body], [1, 'started']);
  assert.equal(w.core.turns.length, 1, 'no second turn');
  // A lock held by a live process past the wait: a 503, never an uncaught throw.
  const w2 = world({ LOOM_RUNTIME_LOCK_WAIT_MS: '200' });
  const hold = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  mkdirSync(deliveryDir(w2.env), { recursive: true });
  writeFileSync(join(deliveryDir(w2.env), 'lock'), String(hold.pid));
  try {
    const r = await deliver(w2.env, w2.msg('dm:G', 'x'), w2.o);
    assert.equal(r.status, 503);
    assert.match(r.error, /locked/);
  } finally { hold.kill(); }
});

test('H. concurrent plans and elapsed markers retain one native admission without losing follow-ups', async () => {
  const w = world();
  const A = cvOf('art', 'slack', 'dm:H');
  const d = depsOf(w.env, w.o);
  // Queue a message without draining it, then drain twice at once.
  w.runner.delay = 50;
  let drained;
  const first = deliver(w.env, w.msg('dm:H', 'one'), { ...w.o, onDrain: (p) => { drained = p; } });
  await Promise.all([first, drain(w.env, A, d), drain(w.env, A, d)]);
  await drained;
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 1);
  // Elapsed time cannot grant another native admission while the first lives.
  const B = cvOf('art', 'slack', 'dm:I');
  w.runner.delay = 300;
  let slowDrain;
  const slow = deliver(w.env, w.msg('dm:I', 'slow one'), { ...w.o, onDrain: (p) => { slowDrain = p; } });
  await new Promise((r) => setTimeout(r, 50));
  w.clock.advance(241_000);
  const fast = await deliver(w.env, w.msg('dm:I', 'fast one'), w.o);
  assert.equal(fast.body, 'queued');
  await slow;
  await slowDrain;
  await tick(w.env, w.o);
  const c = loadConv(w.env, B);
  const starts = w.log.filter((l) => l[0] === 'start' && plain(l[2]).endsWith('slow one'));
  assert.equal(starts.length, 1);
  assert.equal(c.body, `claude:${starts[0][1]}`);
  assert.equal(c.starting, undefined);
  assert.equal(c.queue.length, 0);
  assert.equal(w.log.filter((l) => l[0] === 'end').length, 0);
  const feeds = w.log.filter((l) => l[0] === 'feed');
  assert.equal(feeds.length, 1, 'the follow-up reaches the original body exactly once');
  assert.match(plain(feeds[0][2]), /fast one/);

});

test('I. a conversation id from core is checked before it names any path', async () => {
  const w = world();
  w.core.turn = async () => ({ conversation: '../../evil', seq: 1 });
  const r = await deliver(w.env, w.msg('dm:X', 'x'), w.o);
  assert.equal(r.status, 503);
  assert.equal(existsSync(join(deliveryDir(w.env), 'conversations')), false);
});

test('J. a body still "working" with its harness gone is retired on the tick, its transcript sealed, not left in the clear', async () => {
  const w = world();
  const J = cvOf('art', 'slack', 'dm:J');
  await deliver(w.env, w.msg('dm:J', 'hi'), w.o);
  const c = loadConv(w.env, J);
  const id = c.body.split(':')[1];
  const tr = w.runner.transcript(`s-${id}`);
  assert.ok(existsSync(tr));
  await tick(w.env, w.o);
  assert.equal(loadConv(w.env, J).body, c.body, 'alive and working: left alone');
  w.runner.dead.add(id);
  await tick(w.env, w.o);
  const after = loadConv(w.env, J);
  assert.equal(after.body, undefined);
  assert.equal(after.slot.session, `s-${id}`);
  assert.equal(existsSync(tr), false);
  assert.equal(readFileSync(join(deliveryDir(w.env), 'slots', `${J}.age`), 'utf-8').includes('transcript'), false);
});

test('K. a continuity window is capped at 14 days, whatever it\'s set to', () => {
  const env = { LOOM_RUNTIME_CONTINUITY: '{"slack": 365, "scheduled": 2}' };
  assert.equal(windowMs(env, 'slack', 'live'), 14 * 86_400_000);
  assert.equal(windowMs(env, 'wake', 'scheduled'), 2 * 86_400_000);
  assert.equal(windowMs({}, 'relay', 'agent'), 3 * 86_400_000);
});

test('L. the runtime key: its pub is derived again from it, a first use can\'t race, a non-plain key is refused, another identity can\'t open a slot', { skip: !hasAge && 'age isn\'t installed' }, async () => {
  const dir = scratch('rt-key-');
  const k = runtimeKey(process.env, dir);
  writeFileSync(join(dir, 'runtime.pub'), 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq\n');
  assert.equal(runtimeKey(process.env, dir).recipient, k.recipient);
  assert.equal(readFileSync(join(dir, 'runtime.pub'), 'utf-8').trim(), k.recipient, 'a swapped pub file is put right');
  // Eight first uses at once, in eight processes: one key.
  const race = scratch('rt-key-race-');
  const src = join(here, '..', 'src', 'sealed.mjs');
  const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise((res) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `import { runtimeKey } from ${JSON.stringify(src)}; console.log(runtimeKey(process.env, ${JSON.stringify(race)}).recipient)`]);
    let o = '';
    p.stdout.on('data', (x) => { o += x; });
    p.on('close', () => res(o.trim()));
  })));
  assert.equal(new Set(runs).size, 1);
  assert.match(runs[0], /^age1/);
  // A key that's a symlink is refused.
  const link = scratch('rt-key-link-');
  const { symlinkSync } = await import('node:fs');
  symlinkSync(join(dir, 'runtime.key'), join(link, 'runtime.key'));
  assert.throws(() => runtimeKey(process.env, link), /isn't a plain file/);
  // Sealed to one runtime's key, another's can't open it.
  const blob = ageSealer(process.env, dir).seal(Buffer.from('a slot'));
  assert.equal(ageSealer(process.env, dir).open(blob).toString(), 'a slot');
  assert.throws(() => ageSealer(process.env, race).open(blob), /didn't decrypt/);
});

test('B. placement is #49\'s rule: the agent\'s owner\'s box, may host it, logged in to the harness, with the login granted', () => {
  const HOME = scratch('rt-place-');
  const env = { HOME, LOOM_HOME: join(HOME, 'loom'), LOOM_BOX_LOCAL_NAME: 'one' };
  mkdirSync(env.LOOM_HOME);
  writeFileSync(join(env.LOOM_HOME, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }, { person: 'loren', agents: ['pip'] }] }));
  const s = { primaries: {}, agents: { art: {}, pip: { logins: ['claude'] } }, boxes: {
    one: { local: true, mayHost: '*', owner: 'jonathan', harnesses: { claude: { loggedIn: false } } },
    thor: { mayHost: '*', owner: 'jonathan', harnesses: { claude: { loggedIn: true }, codex: { loggedIn: false } } },
    lorens: { mayHost: '*', owner: 'loren', harnesses: { claude: { loggedIn: true } } },
  } };
  assert.deepEqual(bodyBox(s, 'art', 'claude', env), { box: 'thor' });
  assert.match(bodyBox(s, 'art', 'codex', env).reason, /no box owned by art's owner reports codex logged in/);
  assert.deepEqual(bodyBox(s, 'pip', 'claude', env), { box: 'lorens' }, 'loren\'s agent, on loren\'s box, with the login loren granted it');
  s.agents.pip.logins = [];
  assert.match(bodyBox(s, 'pip', 'claude', env).reason, /no box/, 'no grant, no login, no body');
  s.agents.pip.logins = ['claude'];
  s.boxes.lorens.harnesses.claude.unhealthy = 'its refresh failed';
  assert.match(bodyBox(s, 'pip', 'claude', env).reason, /no box/, 'an unhealthy login runs nothing');
  delete s.boxes.lorens.harnesses.claude.unhealthy;
  s.boxes.lorens.harnesses.claude.loggedIn = false;
  s.boxes.thor.lentTo = ['pip'];
  assert.match(bodyBox(s, 'pip', 'claude', env).reason, /no box/, 'a box lent to it hosts it, but its owner\'s login isn\'t lent with it');
  s.boxes.thor.mayHost = ['pip'];
  assert.match(bodyBox(s, 'art', 'claude', env).reason, /no box/, 'thor may host only pip now');
});

test('A+B. with no box placed for it, a delivery\'s body is failed (and says why); the turn stands', async () => {
  const w = world();
  const { runner: _r, ...o } = w.o;
  const r = await deliver(w.env, w.msg('dm:P', 'hello'), o);
  assert.equal(r.body, 'queued', 'the runtime tries again');
  assert.match(r.reason, /no box owned by art's owner reports claude logged in/);
  assert.equal(w.core.turns.length, 1);
});

test('a body sending on a sibling conversation is refused, even holding that conversation\'s key (its house\'s key file): it\'s another session', async () => {
  const w = world();
  await deliver(w.env, w.msg('dm:A', 'one'), w.o);
  await deliver(w.env, w.msg('dm:B', 'two'), w.o);
  const A = loadConv(w.env, cvOf('art', 'slack', 'dm:A'));
  const B = loadConv(w.env, cvOf('art', 'slack', 'dm:B'));
  const keyB = w.runner.envs[B.body.split(':')[1]].LOOM_BODY_KEY;
  const turns = w.core.turns.length;
  // Body A, in the same house, read B's key file: it sends on B with B's key, as its own session.
  const r = await send(w.env, { conversation: B.conversation, text: 'not mine', key: keyB, session: w.sessionFor(A.conversation) }, w.o);
  assert.deepEqual([r.ok, r.accepted], [false, undefined]);
  assert.match(r.reason, /another session/);
  const none = await send(w.env, { conversation: B.conversation, text: 'whose?', key: keyB }, w.o);
  assert.match(none.reason, /no session is named/);
  assert.equal(w.core.turns.length, turns, 'nothing recorded, nothing posted');
  // B's own body, its own session: it speaks.
  assert.equal((await send(w.env, { conversation: B.conversation, text: 'mine', key: keyB, session: w.sessionFor(B.conversation) }, w.o)).accepted, true);
});

test('C. send as the piece API: only the conversation\'s own agent, with its body\'s key', async () => {
  const w = world();
  const S = scratch('rt-send-api-');
  process.env.FAKE_SEND = S;
  w.o.venues = () => ({ slack: { kind: 'live', send: [process.execPath, join(here, 'fake-send.mjs')] } });
  await deliver(w.env, w.msg('dm:C', 'hi'), w.o);
  const c = loadConv(w.env, cvOf('art', 'slack', 'dm:C'));
  const key = w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY;
  const fx = { now: () => new Date() };
  // send() through api() uses core and the venues as depsOf builds them; here the test's.
  const { send: sendFn } = await import('../src/delivery.mjs');
  const viaApi = (caller, body) => sendFn(w.env, body, { ...w.o, caller });
  assert.equal((await viaApi({ kind: 'agent', agent: 'mark' }, { conversation: c.conversation, text: 'x', key })).ok, false, 'another agent, even with the key');
  assert.equal((await viaApi({ kind: 'agent', agent: 'art' }, { conversation: c.conversation, text: 'x' })).ok, false, 'no key');
  assert.equal((await viaApi({ kind: 'agent', agent: 'art' }, { conversation: c.conversation, text: 'hi Loren', key, session: w.sessionFor(c.conversation) })).accepted, true);
  // api() itself: only an agent caller reaches send and body-sync.
  assert.equal((await api(w.env, fx, { caller: { kind: 'owner' }, path: 'send', body: {} })).status, 403);
  assert.equal((await api(w.env, fx, { caller: { kind: 'piece', subject: 'one' }, path: 'body-sync', body: {} })).status, 403);
  delete process.env.FAKE_SEND;
});

test('a body that fails to start is the runtime\'s to retry, on its tick, with backoff; then it\'s started, and the source never asked again (t-1744)', async () => {
  const w = world();
  const venues = { ...w.o.venues(), wake: { kind: 'scheduled', piece: 'loom' } };
  const o = { ...w.o, venues: () => venues };
  const wake = { source: 'clock', id: 'w-aaa111', agent: 'art', venue: 'wake', place: 'lane:knowledge', label: 'knowledge', from: { kind: 'schedule' }, kind: 'wake', at: w.clock.now().toISOString(), text: 'Your lane is routines/knowledge.md.' };
  w.runner.failStart = 'art\'s house h-9 didn\'t start its body host in 150 s';
  const a = await deliver(w.env, wake, o);
  assert.equal(a.body, 'queued');
  const cv = cvOf('art', 'wake', 'lane:knowledge');
  const starts = () => w.log.filter((l) => l[0] === 'start').length;
  // Before its time: the tick doesn't try.
  w.clock.advance(30_000);
  await tick(w.env, o);
  assert.equal(loadConv(w.env, cv).startFails, 1);
  // At it: tried again, fails again, waits longer (4 min).
  w.clock.advance(31_000);
  await tick(w.env, o);
  let c = loadConv(w.env, cv);
  assert.equal(c.startFails, 2);
  assert.equal(c.retryAt - w.clock.now().getTime(), 240_000);
  assert.match(Object.values(c.outcomes)[0].reason, /trying again in 240 s/);
  // The house comes back: the next try starts the body, with the wake as it came.
  w.runner.failStart = null;
  w.clock.advance(240_000);
  await tick(w.env, o);
  c = loadConv(w.env, cv);
  assert.equal(starts(), 1);
  assert.ok(w.log.find((l) => l[0] === 'start')[2].endsWith('Your lane is routines/knowledge.md.'));
  assert.deepEqual([Object.values(c.outcomes)[0].body, c.startFails, c.retryAt, c.queue.length], ['started', undefined, undefined, 0]);
  assert.equal(w.core.turns.filter((t) => t.conversation === cv).length, 1, 'one wake turn: retrying wrote nothing more');
});

test('a start that fails only while loom is restarting is retried quietly each minute, never counted toward the alert (t-2106)', async () => {
  const w = world({ LOOM_RUNTIME_RETRY_S: '[60, 120]' });
  const venues = { ...w.o.venues(), wake: { kind: 'scheduled', piece: 'loom' } };
  const alerts = [];
  // A deploy: loom store answers nothing (core 28b7f56, 2026-11-10 02:27: "Unexpected end of JSON input").
  let deploying = true;
  const policy = () => { if (deploying) throw new StoreError('loom store: its answer can\'t be read (Unexpected end of JSON input) (loom may be restarting)', 503, true); return null; };
  const o = { ...w.o, venues: () => venues, policy, alert: (_env, a) => alerts.push(a) };
  const wake = { source: 'clock', id: 'w-e7b1f4', agent: 'art', venue: 'wake', place: 'wake:w-e7b1f4', label: 'wake', from: { kind: 'schedule' }, kind: 'wake', at: w.clock.now().toISOString(), text: 'Check on t-1971.' };
  assert.equal((await deliver(w.env, wake, o)).body, 'queued');
  const cv = cvOf('art', 'wake', 'wake:w-e7b1f4');
  // Five failed minutes: more than its two tries, and still no try counted, no give-up, no alert.
  for (let i = 0; i < 5; i++) { w.clock.advance(60_000); await tick(w.env, o); }
  let c = loadConv(w.env, cv);
  assert.deepEqual([c.startFails, c.queue.length, alerts.length], [undefined, 1, 0]);
  assert.equal(c.retryAt - w.clock.now().getTime(), 60_000);
  assert.match(Object.values(c.outcomes)[0].reason, /loom couldn't be read .*trying again in 60 s/);
  // The deploy ends: the next minute's try starts the body.
  deploying = false;
  w.clock.advance(60_000);
  await tick(w.env, o);
  c = loadConv(w.env, cv);
  assert.deepEqual([Object.values(c.outcomes)[0].body, c.transientSince, alerts.length], ['started', undefined, 0]);
});

test('loom unreadable for longer than a deploy: past half an hour the tries count again, and the owner is told (t-2106)', async () => {
  const w = world({ LOOM_RUNTIME_RETRY_S: '[60, 120]' });
  const venues = { ...w.o.venues(), wake: { kind: 'scheduled', piece: 'loom' } };
  const alerts = [];
  const policy = () => { throw new StoreError('loom store: can\'t run loom: spawnSync loom ETIMEDOUT (loom may be restarting)', 503, true); };
  const o = { ...w.o, venues: () => venues, policy, alert: (_env, a) => alerts.push(a) };
  const wake = { source: 'clock', id: 'w-ccc333', agent: 'art', venue: 'wake', place: 'lane:knowledge', label: 'knowledge', from: { kind: 'schedule' }, kind: 'wake', at: w.clock.now().toISOString(), text: 'the lane' };
  await deliver(w.env, wake, o);
  const cv = cvOf('art', 'wake', 'lane:knowledge');
  for (let i = 0; i < 40 && loadConv(w.env, cv).queue.length; i++) { w.clock.advance(120_000); await tick(w.env, o); }
  const c = loadConv(w.env, cv);
  assert.deepEqual([Object.values(c.outcomes)[0].body, c.queue.length], ['failed', 0]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].source, 'runtime-start');
  assert.match(alerts[0].facts.reason, /policy can't be read/);
});

test('a dead registrar cannot replay an admitted native attempt (t-1853)', async () => {
  const w = world();
  const venues = { ...w.o.venues(), wake: { kind: 'scheduled', piece: 'loom' } };
  // The house is slow to come up: the start is still waiting on it when its process is killed.
  let finish, drained;
  const hung = { ...w.runner, start: (options) => new Promise((resolve) => { finish = () => resolve(w.runner.start(options)); }) };
  const o = { ...w.o, venues: () => venues };
  const wake = { source: 'clock', id: 'w-a4a8ed', agent: 'art', venue: 'wake', place: 'lane:backup', label: 'backup', from: { kind: 'schedule' }, kind: 'wake', at: w.clock.now().toISOString(), text: 'Resume the Drive backup: it was approved.' };
  const a = await deliver(w.env, wake, { ...o, runner: () => hung, onDrain: (promise) => { drained = promise; } });
  assert.deepEqual([a.body, a.reason], ['queued', 'its body is still starting']);
  const cv = cvOf('art', 'wake', 'lane:backup');
  // The worker is gone (loom-http-local restarted at 12:10:45, h-971 was 2 s old): its marker names a dead process.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const path = join(deliveryDir(w.env), 'conversations', `${cv}.json`);
  const c0 = JSON.parse(readFileSync(path, 'utf-8'));
  writeFileSync(path, JSON.stringify({ ...c0, starting: { ...c0.starting, pid: dead } }));
  // Registrar death is not native-worker death: hold the original admission.
  w.clock.advance(60_000);
  await tick(w.env, o);
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 0);
  assert.ok(loadConv(w.env, cv).starting.prepared);
  finish();
  await drained;
  await tick(w.env, o);
  const starts = w.log.filter((l) => l[0] === 'start');
  assert.equal(starts.length, 1, 'the original native attempt completed exactly once');
  assert.ok(starts[0][2].endsWith('Resume the Drive backup: it was approved.'));
  const c = loadConv(w.env, cv);
  assert.deepEqual([Object.values(c.outcomes)[0].body, c.queue.length, c.starting], ['started', 0, undefined]);
  w.clock.advance(60_000);
  await tick(w.env, o);
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 1, 'once');
  assert.equal(w.core.turns.filter((t) => t.conversation === cv).length, 1, 'one wake turn: nothing written again');
});

test('a slow scheduled start retains its admission after the observer timeout (t-1853)', async () => {
  const w = world();
  const venues = { ...w.o.venues(), wake: { kind: 'scheduled', piece: 'loom' } };
  const o = { ...w.o, venues: () => venues };
  let finish;
  const slow = { ...w.runner, start: (oo) => new Promise((res) => { finish = () => res(w.runner.start(oo)); }) };
  const wake = { source: 'clock', id: 'w-5be092', agent: 'art', venue: 'wake', place: 'lane:backup', label: 'backup', from: { kind: 'schedule' }, kind: 'wake', at: w.clock.now().toISOString(), text: 'Resume the Drive backup.' };
  let drained;
  await deliver(w.env, wake, { ...o, runner: () => slow, onDrain: (p) => { drained = p; } });
  const cv = cvOf('art', 'wake', 'lane:backup');
  // A four-minute observer timeout cannot replay a still-running native call.
  w.clock.advance(241_000);
  await tick(w.env, o);
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 0);
  assert.ok(loadConv(w.env, cv).starting.prepared);
  finish();
  await drained;
  await tick(w.env, o);
  const c = loadConv(w.env, cv);
  const starts = w.log.filter((l) => l[0] === 'start');
  assert.equal(starts.length, 1);
  assert.deepEqual(w.log.filter((l) => l[0] === 'feed'), []);
  assert.deepEqual([c.body, c.queue.length], [`claude:${starts[0][1]}`, 0]);
  assert.equal(w.log.filter((l) => l[0] === 'end').length, 0);

});

test('a body that never starts: given up after its tries, with a failed note on the conversation and a notice for the owner (t-1744)', async () => {
  const w = world({ LOOM_RUNTIME_RETRY_S: '[60, 120]' });
  const venues = { ...w.o.venues(), wake: { kind: 'scheduled', piece: 'loom' } };
  const o = { ...w.o, venues: () => venues };
  const wake = { source: 'clock', id: 'w-bbb222', agent: 'art', venue: 'wake', place: 'lane:knowledge', label: 'knowledge', from: { kind: 'schedule' }, kind: 'wake', at: w.clock.now().toISOString(), text: 'the lane' };
  w.runner.failStart = 'no box owned by art\'s owner reports claude logged in';
  await deliver(w.env, wake, o);
  const cv = cvOf('art', 'wake', 'lane:knowledge');
  for (const ms of [60_000, 120_000]) { w.clock.advance(ms); await tick(w.env, o); }
  const c = loadConv(w.env, cv);
  assert.deepEqual([Object.values(c.outcomes)[0].body, c.queue.length, c.startFails, c.retryAt], ['failed', 0, undefined, undefined]);
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 0);
  const note = w.core.turns.at(-1);
  assert.deepEqual([note.conversation, note.kind, note.outcome, note.from], [cv, 'note', 'failed', { kind: 'agent', id: 'art' }]);
  assert.match(note.run, /^run-[0-9a-f]{12}$/);
  assert.deepEqual(w.core.audits.at(-1), { conversation: cv, seq: note.seq, text: 'couldn\'t start a body after 3 tries: no box owned by art\'s owner reports claude logged in' });
  // The owner hears of it, on the runtime's page.
  const { deliveryNotices } = await import('../src/delivery.mjs');
  const [kept] = deliveryNotices(w.env, w.clock.now().getTime());
  assert.equal(deliveryNotices(w.env, w.clock.now().getTime() + 86_400_000).length, 0, 'a day, then gone');
  // The page reads them as of now: the same notice, written now, is in its manifest.
  writeFileSync(join(deliveryDir(w.env), 'notices.json'), JSON.stringify([{ ...kept, at: new Date().toISOString() }]));
  const { manifest } = await import('../src/ui.mjs');
  const n = manifest(w.env).notices.find((x) => x.agent === 'art');
  assert.equal(n.text, 'Art\'s wake lane:knowledge couldn\'t start a body: no box owned by art\'s owner reports claude logged in');
  assert.equal(n.tone, 'warn');
  // Nothing more is tried: the tick is quiet now.
  w.clock.advance(3600_000);
  await tick(w.env, o);
  assert.equal(w.core.turns.length, 2);
});
