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

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
const cvOf = (agent, venue, place) => `cv-${createHash('sha256').update(`${agent}\0${venue}\0${place}`).digest('hex').slice(0, 12)}`;
const hasAge = spawnSync('age', ['--version']).status === 0 && spawnSync('age-keygen', ['--help']).error === undefined;

/** A runner that records into `log`, keeps each session's "transcript" as a file under its root, and is told when a turn ends. */
function fakeRunner(log, root, harness = 'claude', { inboxDir } = {}) {
  let n = 0;
  const state = {};
  const session = {};
  const roots = { sess: join(root, 'sess') };
  mkdirSync(roots.sess, { recursive: true });
  const tfile = (s) => join(roots.sess, `${s}.jsonl`);
  const r = {
    harness, roots, inbox: inboxDir ? inbox(inboxDir) : null, failStart: null, failResume: null, envs: {}, dead: new Set(), delay: 0,
    start(o) {
      if (r.failStart) throw new RunnerError(r.failStart);
      if (r.delay) { const ms = r.delay; r.delay = 0; return new Promise((res) => setTimeout(res, ms)).then(() => r.start(o)); }
      const id = `${harness[0]}000000${n++}`;
      session[id] = `s-${id}`;
      writeFileSync(tfile(session[id]), `transcript of ${id}: ${o.brief}\n`);
      log.push(['start', id, o.brief]);
      r.envs[id] = o.env;
      state[id] = 'working';
      r.inbox?.open(id, {});
      return { id, harness, model: o.model, slot: { harness, session: session[id] } };
    },
    resume(slot, o) {
      if (r.failResume) throw new RunnerError(r.failResume);
      const id = `r000000${n++}`;
      session[id] = slot.session;
      log.push(['resume', id, slot.session, existsSync(tfile(slot.session)) ? readFileSync(tfile(slot.session), 'utf-8') : null, o.brief]);
      r.envs[id] = o.env;
      state[id] = 'working';
      r.inbox?.open(id, {});
      return { id, harness, model: o.model, slot };
    },
    feed(b, m) {
      if (state[b.id] !== 'working') return { fed: false, reason: 'its turn is over: resume it' };
      log.push(['feed', b.id, m.text]);
      if (r.inbox) r.inbox.put(b.id, [{ id: m.id, text: m.text, msg: m.id }]);
      return { fed: true };
    },
    end(b) { log.push(['end', b.id]); state[b.id] = 'idle'; },
    status: (b) => state[b.id] ?? 'unknown',
    alive: (b) => !r.dead.has(b.id),
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

function world(extra = {}, { inboxDir } = {}) {
  const HOME = scratch('rt-deliver-');
  const env = { HOME, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LOOM_RUNTIME_TOKEN_FILE: join(HOME, 'runtime-token'), LOOM_RUNTIME_LOOM_URL: 'http://127.0.0.1:1/mcp', ANTHROPIC_BASE_URL: 'http://proxy', SOMETHING_ELSE: 'x', LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(HOME, 'state'), LOOM_BOX_DATA: join(HOME, 'data'), LOOM_RUNTIME_SCORECARDS: 'off', ...extra };
  setModels(env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }], agent: 'art', prefer: ['opus'] });
  setModels(env, { agent: 'mark', prefer: ['opus'] });
  const log = [];
  const runner = fakeRunner(log, HOME, 'claude', { inboxDir: inboxDir ? join(HOME, 'inbox') : undefined });
  const core = fakeCore(log);
  let t = Date.parse('2026-11-02T12:00:00Z');
  const clock = { now: () => new Date(t), advance: (ms) => { t += ms; } };
  const o = {
    core, runner: () => runner, sealer: testSealer, now: clock.now, memAvailableMb: () => 8000, warn: () => {},
    accounts: staticAccounts({ accounts: [{ name: 'max', provider: 'anthropic', credentials: [{ kind: 'k', status: 'valid' }], usage: {} }] }),
    venues: () => ({ slack: { kind: 'live', send: [process.execPath, join(here, 'fake-send.mjs')] }, relay: { kind: 'agent' } }),
  };
  let n = 0;
  const msg = (place, text, more = {}) => ({ source: 'test-source', id: `m-${++n}`, agent: 'art', venue: 'slack', place, label: `Loren (${place})`, from: { kind: 'person', slug: 'loren' }, kind: 'message', at: clock.now().toISOString(), text, ...more });
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
  const r = await deliver(w.env, { source: 'runtime', id: 'relay-1', agent: 'art', venue: 'relay', place: 'mark', from: { kind: 'agent', id: 'mark' }, kind: 'message', at: w.clock.now().toISOString(), text: 'can you look at PR 12?' }, w.o);
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
  await deliver(w.env, { source: 'runtime', id: 'r-1', agent: 'art', venue: 'relay', place: 'mark', from: { kind: 'agent', id: 'mark' }, kind: 'message', at: w.clock.now().toISOString(), text: 'x' }, w.o);
  const turns = w.core.turns.length;
  const rc = loadConv(w.env, cvOf('art', 'relay', 'mark'));
  assert.match((await send(w.env, { conversation: rc.conversation, text: 'x', key: w.runner.envs[rc.body.split(':')[1]].LOOM_BODY_KEY }, w.o)).reason, /declares no send/);
  assert.equal(w.core.turns.length, turns);
  delete process.env.FAKE_SEND;
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
  assert.deepEqual(Object.keys(e).sort(), ['HOME', 'LANG', 'LOOM_BODY_KEY', 'PATH', 'SOMETHING_ELSE'], 'the basics, what BODY_ENV may name, and its run\'s key');
});

test('E. a warm body\'s inbox isn\'t lost to a resume that fails: what it held goes back on the queue', async () => {
  const w = world({}, { inboxDir: true });
  const A = cvOf('art', 'slack', 'dm:A');
  await deliver(w.env, w.msg('dm:A', 'one'), w.o);
  assert.equal((await deliver(w.env, w.msg('dm:A', 'two, never heard'), w.o)).body, 'fed');
  w.runner.finish(loadConv(w.env, A).body);
  w.runner.failResume = 'claude --bg didn\'t start: overloaded';
  const r = await deliver(w.env, w.msg('dm:A', 'three'), w.o);
  assert.deepEqual([r.body, r.reason], ['failed', 'claude --bg didn\'t start: overloaded']);
  // Back on the queue, and on to the next body (the same drain starts one): not lost with the failed resume.
  const next = w.log.at(-1);
  assert.equal(next[0], 'start');
  assert.ok(next[2].endsWith('loren: two, never heard'));
  assert.equal(next[2].includes('three'), false, 'the failed message itself isn\'t retried: its answer was failed');
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
  assert.equal(/loren: taken\b/.test(brief), false);
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

test('H. two plans at once start one body; an op that outlived its marker can\'t clear the next one\'s, and its messages aren\'t lost', async () => {
  const w = world();
  const A = cvOf('art', 'slack', 'dm:H');
  const d = depsOf(w.env, w.o);
  // Queue a message without draining it, then drain twice at once.
  w.runner.delay = 50;
  const first = deliver(w.env, w.msg('dm:H', 'one'), w.o);
  await Promise.all([first, drain(w.env, A, d), drain(w.env, A, d)]);
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 1);
  // A slow op: its marker expires (a fresh drain takes over with a new message), then it finishes.
  const B = cvOf('art', 'slack', 'dm:I');
  w.runner.delay = 300;
  const slow = deliver(w.env, w.msg('dm:I', 'slow one'), w.o);
  await new Promise((r) => setTimeout(r, 50));
  w.clock.advance(241_000);
  const fast = await deliver(w.env, w.msg('dm:I', 'fast one'), w.o);
  assert.equal(fast.body, 'started');
  const owner = loadConv(w.env, B).body;
  await slow;
  const c = loadConv(w.env, B);
  assert.equal(c.body, owner, 'the late op didn\'t take the conversation back');
  assert.equal(c.starting, undefined);
  const slowId = w.log.find((l) => l[0] === 'start' && l[2].endsWith('slow one'))[1];
  assert.ok(w.log.some((l) => l[0] === 'end' && l[1] === slowId), 'its body was ended');
  await tick(w.env, w.o);
  assert.ok(w.log.some((l) => l[0] === 'feed' && l[1] === owner.split(':')[1] && l[2] === 'loren: slow one'), 'its message went to the conversation\'s body');
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

test('B. placement: only a box owned by the agent\'s owner (or lent to it), that may host it, with the harness logged in', () => {
  const HOME = scratch('rt-place-');
  const env = { HOME, LOOM_HOME: join(HOME, 'loom'), LOOM_BOX_LOCAL_NAME: 'one' };
  mkdirSync(env.LOOM_HOME);
  writeFileSync(join(env.LOOM_HOME, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }, { person: 'loren', agents: ['pip'] }] }));
  const s = { primaries: {}, boxes: {
    one: { local: true, mayHost: '*', owner: 'jonathan', harnesses: { claude: { loggedIn: false } } },
    thor: { mayHost: '*', owner: 'jonathan', harnesses: { claude: { loggedIn: true }, codex: { loggedIn: false } } },
    lorens: { mayHost: '*', owner: 'loren', harnesses: { claude: { loggedIn: true } } },
  } };
  assert.deepEqual(bodyBox(s, 'art', 'claude', env), { box: 'thor' });
  assert.match(bodyBox(s, 'art', 'codex', env).reason, /no box owned by art's owner reports codex logged in/);
  assert.deepEqual(bodyBox(s, 'pip', 'claude', env), { box: 'lorens' }, 'loren\'s agent, on loren\'s box');
  s.boxes.lorens.harnesses.claude.loggedIn = false;
  assert.match(bodyBox(s, 'pip', 'claude', env).reason, /no box/, 'never on jonathan\'s box');
  s.boxes.thor.lentTo = ['pip'];
  assert.deepEqual(bodyBox(s, 'pip', 'claude', env), { box: 'thor' }, 'lent to it by name');
  s.boxes.thor.mayHost = ['art'];
  assert.match(bodyBox(s, 'pip', 'claude', env).reason, /no box/);
});

test('A+B. with no box placed for it, a delivery\'s body is failed (and says why); the turn stands', async () => {
  const w = world();
  const { runner: _r, memAvailableMb: _m, ...o } = w.o;
  const r = await deliver(w.env, w.msg('dm:P', 'hello'), o);
  assert.equal(r.body, 'failed');
  assert.match(r.reason, /no box owned by art's owner reports claude logged in/);
  assert.equal(w.core.turns.length, 1);
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
  assert.equal((await viaApi({ kind: 'agent', agent: 'art' }, { conversation: c.conversation, text: 'hi Loren', key })).ok, true);
  // api() itself: only an agent caller reaches send and body-sync.
  assert.equal((await api(w.env, fx, { caller: { kind: 'owner' }, path: 'send', body: {} })).status, 403);
  assert.equal((await api(w.env, fx, { caller: { kind: 'piece', subject: 'one' }, path: 'body-sync', body: {} })).status, 403);
  delete process.env.FAKE_SEND;
});
