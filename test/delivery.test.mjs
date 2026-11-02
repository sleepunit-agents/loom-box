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
import { CoreError } from '../src/core.mjs';
import { deliver, deliveryDir, loadConv, send, tick } from '../src/delivery.mjs';
import { setModels } from '../src/models.mjs';
import { RunnerError } from '../src/runners.mjs';
import { ageSealer } from '../src/sealed.mjs';
import { scratch } from './scratch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
const cvOf = (agent, venue, place) => `cv-${createHash('sha256').update(`${agent}\0${venue}\0${place}`).digest('hex').slice(0, 12)}`;
const hasAge = spawnSync('age', ['--version']).status === 0 && spawnSync('age-keygen', ['--help']).error === undefined;

/** A runner that records into `log`, keeps each session's "transcript" as a file under its root, and is told when a turn ends. */
function fakeRunner(log, root, harness = 'claude') {
  let n = 0;
  const state = {};
  const session = {};
  const roots = { sess: join(root, 'sess') };
  mkdirSync(roots.sess, { recursive: true });
  const tfile = (s) => join(roots.sess, `${s}.jsonl`);
  const r = {
    harness, roots, inbox: null, failStart: null, envs: {},
    start(o) {
      if (r.failStart) throw new RunnerError(r.failStart);
      const id = `${harness[0]}000000${n++}`;
      session[id] = `s-${id}`;
      writeFileSync(tfile(session[id]), `transcript of ${id}: ${o.brief}\n`);
      log.push(['start', id, o.brief]);
      r.envs[id] = o.env;
      state[id] = 'working';
      return { id, harness, model: o.model, slot: { harness, session: session[id] } };
    },
    resume(slot, o) {
      const id = `r000000${n++}`;
      session[id] = slot.session;
      log.push(['resume', id, slot.session, existsSync(tfile(slot.session)) ? readFileSync(tfile(slot.session), 'utf-8') : null, o.brief]);
      r.envs[id] = o.env;
      state[id] = 'working';
      return { id, harness, model: o.model, slot };
    },
    feed(b, m) {
      if (state[b.id] !== 'working') return { fed: false, reason: 'its turn is over: resume it' };
      log.push(['feed', b.id, m.text]);
      return { fed: true };
    },
    end(b) { log.push(['end', b.id]); state[b.id] = 'idle'; },
    status: (b) => state[b.id] ?? 'unknown',
    slotOf: (b) => (session[b.id] ? { harness, session: session[b.id] } : null),
    sessionFiles(slot) { return { keep: slot && existsSync(tfile(slot.session)) ? [{ root: 'sess', rel: `${slot.session}.jsonl` }] : [], drop: [] }; },
    /** The test's hand: this body's turn is over. */
    finish(ref) { state[ref.split(':')[1]] = 'idle'; },
    transcript: tfile,
  };
  return r;
}

/** Core's conversation and audit writes, recorded into `log`: seq per conversation, as core assigns it. */
function fakeCore(log) {
  const seqs = {};
  const c = {
    turns: [], audits: [], down: false, auditDown: false,
    async turn(t) {
      if (c.down) throw new CoreError('core didn\'t answer conversations/turn: connect ECONNREFUSED', 503);
      const cv = cvOf(t.agent, t.venue, t.place);
      const seq = (seqs[cv] = (seqs[cv] ?? 0) + 1);
      c.turns.push({ ...t, conversation: cv, seq });
      log.push(['turn', cv, seq, t.kind]);
      return { conversation: cv, seq };
    },
    async audit(a) {
      if (c.auditDown) throw new CoreError('the audit log needs the age programs', 503);
      c.audits.push(a);
      log.push(['audit', a.conversation, a.seq]);
      return { conversation: a.conversation, seq: a.seq };
    },
  };
  return c;
}

/** Not encryption: a reversible stand-in, so a test can see that nothing's kept as it came (the age test is below). */
const testSealer = {
  seal: (b) => Buffer.from(`T1:${Buffer.from(b).toString('base64').split('').reverse().join('')}`),
  open: (b) => Buffer.from(b.toString().slice(3).split('').reverse().join(''), 'base64'),
};

function world(extra = {}) {
  const HOME = scratch('rt-deliver-');
  const env = { HOME, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LOOM_RUNTIME_TOKEN_FILE: join(HOME, 'runtime-token'), LOOM_RUNTIME_LOOM_URL: 'http://127.0.0.1:1/mcp', ANTHROPIC_BASE_URL: 'http://proxy', SOMETHING_ELSE: 'x', LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(HOME, 'state'), LOOM_BOX_DATA: join(HOME, 'data'), LOOM_RUNTIME_SCORECARDS: 'off', ...extra };
  setModels(env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }], agent: 'art', prefer: ['opus'] });
  setModels(env, { agent: 'mark', prefer: ['opus'] });
  const log = [];
  const runner = fakeRunner(log, HOME);
  const core = fakeCore(log);
  let t = Date.parse('2026-11-02T12:00:00Z');
  const clock = { now: () => new Date(t), advance: (ms) => { t += ms; } };
  const o = {
    core, runner: () => runner, sealer: testSealer, now: clock.now, memAvailableMb: () => 8000, warn: () => {},
    accounts: staticAccounts({ accounts: [{ name: 'max', provider: 'anthropic', credentials: [{ kind: 'k', status: 'valid' }], usage: {} }] }),
    venues: () => ({ slack: { kind: 'live', send: [process.execPath, join(here, 'fake-send.mjs')] }, relay: { kind: 'agent' } }),
  };
  let n = 0;
  const msg = (place, text, more = {}) => ({ id: `m-${++n}`, agent: 'art', venue: 'slack', place, label: `Loren (${place})`, from: { kind: 'person', slug: 'loren' }, kind: 'message', at: clock.now().toISOString(), text, ...more });
  return { env, log, runner, core, clock, o, msg, kinds: () => log.map((l) => l[0]) };
}

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
  assert.ok(brief.endsWith('loren: what did we decide about the pond?'));
  assert.equal(c.body, `claude:${id}`);
  assert.equal(readBody(w.env, c.body).venue, 'slack');
  // A relay: from another agent, on the runtime's own venue.
  const r = await deliver(w.env, { id: 'relay-1', agent: 'art', venue: 'relay', place: 'mark', from: { kind: 'agent', id: 'mark' }, kind: 'message', at: w.clock.now().toISOString(), text: 'can you look at PR 12?' }, w.o);
  assert.equal(r.body, 'started');
  const starts = w.log.filter((l) => l[0] === 'start');
  assert.equal(starts.length, 2);
  assert.ok(starts[1][2].endsWith('mark: can you look at PR 12?'));
  assert.equal(starts[1][2].includes('runtime send'), false, 'relay declares no send here');
  // Nothing of the message is kept as it came: the conversation's record holds no text.
  assert.equal(readFileSync(join(deliveryDir(w.env), 'conversations', `${cv}.json`), 'utf-8').includes('pond'), false);
});

test('2. delivery records first, and once; a body that fails to start leaves the turn standing', async () => {
  const w = world();
  await deliver(w.env, w.msg('dm:U1', 'hello'), w.o);
  assert.deepEqual(w.kinds(), ['turn', 'audit', 'start'], 'the turn and its text are in core before any body sees it');
  assert.deepEqual(w.core.turns[0], { agent: 'art', venue: 'slack', place: 'dm:U1', at: '2026-11-02T12:00:00.000Z', from: { kind: 'person', slug: 'loren' }, kind: 'message', label: 'Loren (dm:U1)', conversation: cvOf('art', 'slack', 'dm:U1'), seq: 1 });
  assert.deepEqual(w.core.audits[0], { conversation: cvOf('art', 'slack', 'dm:U1'), seq: 1, text: 'hello' });

  // Core can't take the turn: a 5xx, and nothing reaches a body.
  w.core.down = true;
  const down = await deliver(w.env, w.msg('dm:U2', 'are you there?'), w.o);
  assert.equal(down.status, 503);
  assert.match(down.error, /ECONNREFUSED/);
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 1);
  assert.equal(loadConv(w.env, cvOf('art', 'slack', 'dm:U2')), null);
  // ...and the same message, once core is back, is a new delivery (a failed one isn't remembered).
  w.core.down = false;
  const again = { ...w.msg('dm:U2', 'are you there?'), id: 'retry-me' };
  w.core.down = true;
  await deliver(w.env, again, w.o);
  w.core.down = false;
  assert.equal((await deliver(w.env, again, w.o)).body, 'started');

  // A body that fails to start: `failed`, with the reason; the turn stands.
  w.runner.failStart = 'claude --bg didn\'t start: Error: not logged in';
  const failed = await deliver(w.env, w.msg('dm:U3', 'ping'), w.o);
  assert.deepEqual(failed, { conversation: cvOf('art', 'slack', 'dm:U3'), seq: 1, body: 'failed', reason: 'claude --bg didn\'t start: Error: not logged in' });
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
  assert.deepEqual(w.log.at(-1), ['feed', aBody.split(':')[1], 'loren: two']);
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
  assert.match(resumed[4], /loren: three$/);
  assert.match(resumed[4], new RegExp(`run is ${loadConv(w.env, A).run}`));
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

test('short of memory, a new body waits; a message the runtime can\'t seal is delivered at once or not kept', async () => {
  const w = world();
  w.o.memAvailableMb = () => 900;
  const r = await deliver(w.env, w.msg('dm:M', 'hi'), w.o);
  assert.equal(r.body, 'queued');
  assert.match(r.reason, /short of memory/);
  w.o.memAvailableMb = () => 8000;
  const broken = { ...w.o, sealer: { seal() { throw new Error('no age'); }, open() { throw new Error('no age'); } } };
  assert.equal((await deliver(w.env, w.msg('dm:N', 'unsealed but deliverable'), broken)).body, 'started');
  broken.memAvailableMb = () => 900;
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
  assert.ok(w.log.some((l) => l[0] === 'start' && l[2].endsWith('THE SECOND SECRET')), 'opened again for its body');
  const slot = readFileSync(join(dir, 'slots', `${cvOf('art', 'slack', 'dm:A')}.age`));
  assert.equal(slot.subarray(0, 21).toString(), 'age-encryption.org/v1');
  assert.equal(slot.includes(Buffer.from('first secret')), false);
});

test('outbound: the venue\'s send (--place, --agent, the text on stdin), one retry, then the agent\'s turn', async () => {
  const w = world();
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
  const ok = await send(w.env, { conversation: cv, text: 'Hi Loren!', key }, w.o);
  w.core.turn = turn;
  assert.equal(sentBefore, 1);
  assert.equal(ok.ok, true);
  assert.match(ok.id, /^p-/);
  assert.deepEqual(calls()[0], { argv: ['--place', 'dm:U1', '--agent', 'art'], text: 'Hi Loren!' });
  const reply = w.core.turns.at(-1);
  assert.deepEqual({ ...reply, at: undefined }, { agent: 'art', venue: 'slack', place: 'dm:U1', at: undefined, from: { kind: 'agent', id: 'art' }, kind: 'reply', run: c.run, model: 'opus', harness: 'claude', outcome: 'answered', conversation: cv, seq: 2 });
  assert.deepEqual(w.core.audits.at(-1), { conversation: cv, seq: 2, text: 'Hi Loren!' });
  // One failure: retried once, and it went.
  writeFileSync(join(S, 'fail'), '1');
  assert.equal((await send(w.env, { conversation: cv, text: 'again', key }, w.o)).ok, true);
  assert.equal(calls().length, 3);
  assert.equal(w.core.turns.at(-1).outcome, 'answered');
  // Two: the body is told why, and the turn says failed.
  writeFileSync(join(S, 'fail'), '2');
  const no = await send(w.env, { conversation: cv, text: 'and again', key }, w.o);
  assert.deepEqual([no.ok, no.reason], [false, 'the bot has no access to that channel']);
  assert.equal(calls().length, 5);
  assert.equal(w.core.turns.at(-1).outcome, 'failed');
  // A venue with no send: nothing posts, nothing is recorded.
  await deliver(w.env, { id: 'r-1', agent: 'art', venue: 'relay', place: 'mark', from: { kind: 'agent', id: 'mark' }, kind: 'message', at: w.clock.now().toISOString(), text: 'x' }, w.o);
  const turns = w.core.turns.length;
  const rc = loadConv(w.env, cvOf('art', 'relay', 'mark'));
  assert.match((await send(w.env, { conversation: rc.conversation, text: 'x', key: w.runner.envs[rc.body.split(':')[1]].LOOM_BODY_KEY }, w.o)).reason, /declares no send/);
  assert.equal(w.core.turns.length, turns);
  delete process.env.FAKE_SEND;
});

/** A core that answers the two routes delivery writes, as loom does (src/conversations.ts, src/audit.ts), with a runtime token. */
async function coreServer() {
  const seen = [];
  const seqs = {};
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push({ path: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer loom_runtime_test_token_xxxxxxxx') { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
      if (req.url === '/api/loom/conversations/turn') {
        const cv = cvOf(body.agent, body.venue, body.place);
        return res.end(JSON.stringify({ conversation: cv, seq: (seqs[cv] = (seqs[cv] ?? 0) + 1) }));
      }
      if (req.url === '/api/loom/audit') return res.end(JSON.stringify({ conversation: body.conversation, seq: body.seq }));
      res.statusCode = 404;
      res.end('{"error":"not-found"}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((r) => server.close(r)) };
}

test('loom-runtime deliver: the offer\'s argv, end to end on a stand-in core and Claude Code, the body reached from a detached process', { skip: !hasAge && 'age isn\'t installed' }, async () => {
  const core = await coreServer();
  const D = scratch('rt-deliver-cli-');
  writeFileSync(join(D, 'token'), 'loom_runtime_test_token_xxxxxxxx\n');
  mkdirSync(join(D, 'work'));
  const env = { ...process.env, HOME: D, FAKE_HARNESS: D, LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_DATA: join(D, 'data'), LOOM_HOME: join(D, 'loom'),
    LOOM_RUNTIME_CLAUDE: join(here, 'fake-claude.mjs'), LOOM_RUNTIME_CLAUDE_JOBS: join(D, 'jobs'), LOOM_RUNTIME_ACCOUNTS: 'none', LOOM_RUNTIME_SCORECARDS: 'off',
    LOOM_RUNTIME_LOOM_URL: core.url, LOOM_RUNTIME_TOKEN_FILE: join(D, 'token'), LOOM_RUNTIME_BODY_CWD: join(D, 'work'), LOOM_RUNTIME_BODY_ENV: 'FAKE_HARNESS' };
  const cli = (args, input, e = env) => new Promise((resolve) => {
    const p = spawn(process.execPath, [join(here, '..', 'src', 'cli.mjs'), ...args], { env: e, cwd: join(D, 'work') });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
    p.stdin.end(input);
  });
  try {
    const body = { id: '1730550000.000100', agent: 'art', venue: 'slack', place: 'dm:U1', label: 'Loren (DM)', from: { kind: 'person', slug: 'loren' }, kind: 'message', at: new Date().toISOString(), text: 'are we still on for Thursday?' };
    const t0 = Date.now();
    const r = await cli(['deliver'], JSON.stringify(body));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Date.now() - t0 < 6000);
    const a = JSON.parse(r.stdout);
    assert.deepEqual([a.conversation, a.seq], [cvOf('art', 'slack', 'dm:U1'), 1]);
    assert.ok(['started', 'queued'].includes(a.body), JSON.stringify(a));
    assert.deepEqual(core.seen.map((s) => s.path), ['/api/loom/conversations/turn', '/api/loom/audit']);
    assert.equal(core.seen[0].body.text, undefined, 'a turn carries no text');
    assert.equal(core.seen[1].body.text, 'are we still on for Thursday?');
    // The detached process starts the body (here, within the 2 s): a `claude --bg` with the brief on stdin, never argv.
    const end = Date.now() + 15_000;
    while (!loadConv(env, a.conversation)?.body && Date.now() < end) await new Promise((res) => setTimeout(res, 100));
    const c = loadConv(env, a.conversation);
    assert.match(c.body ?? '', /^claude:[0-9a-f]{8}$/);
    const argv = readFileSync(join(D, 'argv.log'), 'utf-8');
    assert.ok(argv.includes('"--bg"'));
    assert.equal(argv.includes('Thursday'), false);
    // The same delivery again: the first answer, nothing written.
    const again = await cli(['deliver'], JSON.stringify(body));
    assert.deepEqual(JSON.parse(again.stdout), a);
    assert.equal(core.seen.length, 2);
    // Without a runtime token: a 503, and no body.
    const { LOOM_RUNTIME_TOKEN_FILE: _t, ...bare } = env;
    const no = await cli(['deliver'], JSON.stringify({ ...body, id: 'x-2', place: 'dm:U2' }), bare);
    assert.equal(no.status, 1);
    assert.equal(JSON.parse(no.stdout).status, 503);
    assert.equal(loadConv(env, cvOf('art', 'slack', 'dm:U2')), null);
    assert.equal(readdirSync(join(D, 'jobs')).length, 1);
  } finally {
    await core.close();
  }
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
  const r = await send(w.env, { conversation: B.conversation, text: 'posing as mark', key: keyOf(A) }, w.o);
  assert.equal(r.ok, false);
  assert.match(r.reason, /only the body holding/);
  assert.equal((await send(w.env, { conversation: B.conversation, text: 'no key' }, w.o)).ok, false);
  assert.equal(existsSync(join(S, 'calls.log')), false);
  assert.equal(w.core.turns.length, turns);
  // Its own conversation: it goes.
  assert.equal((await send(w.env, { conversation: B.conversation, text: 'hi', key: keyOf(B) }, w.o)).ok, true);
  // A resumed body has a new run and a new key: the old one no longer speaks.
  const old = keyOf(A);
  w.runner.finish(A.body);
  assert.equal((await deliver(w.env, w.msg('dm:A', 'again'), w.o)).body, 'resumed');
  const A2 = loadConv(w.env, A.conversation);
  assert.equal((await send(w.env, { conversation: A.conversation, text: 'stale', key: old }, w.o)).ok, false);
  assert.equal((await send(w.env, { conversation: A.conversation, text: 'fresh', key: keyOf(A2) }, w.o)).ok, true);
  delete process.env.FAKE_SEND;
});

test('a body\'s environment is scrubbed: no runtime token, none of the runtime\'s settings; its agent\'s own token', async () => {
  const w = world();
  const tokens = scratch('rt-agent-tokens-');
  writeFileSync(join(tokens, 'art'), 'loom_agent_art_xxxxxxxxxxxxxxxxxxxx\n');
  w.env.LOOM_RUNTIME_AGENT_TOKENS = tokens;
  w.env.LOOM_RUNTIME_BODY_ENV = 'SOMETHING_ELSE,LOOM_RUNTIME_TOKEN_FILE';
  await deliver(w.env, w.msg('dm:E', 'hi'), w.o);
  const e = w.runner.envs[loadConv(w.env, cvOf('art', 'slack', 'dm:E')).body.split(':')[1]];
  assert.equal(e.LOOM_RUNTIME_TOKEN_FILE, undefined, 'never the runtime token, even if BODY_ENV names it');
  assert.deepEqual(Object.keys(e).filter((k) => /^LOOM_(RUNTIME|BOX)_/.test(k)), []);
  assert.equal(e.LOOM_TOKEN_FILE, join(tokens, 'art'));
  assert.deepEqual([e.HOME, e.PATH, e.LANG, e.ANTHROPIC_BASE_URL, e.SOMETHING_ELSE], [w.env.HOME, '/usr/bin:/bin', 'C.UTF-8', 'http://proxy', 'x']);
  assert.match(e.LOOM_BODY_KEY, /^[0-9a-f]{48}$/);
});
