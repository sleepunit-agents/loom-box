// t-1763: the runaway loop detector, which replaced the hourly start cap (t-1760's backstop). Jonathan's ruling
// (2026-11-03): a busy lane, two agents working something through or a burst of wakes is fine; a crash loop is what's
// caught, by its outcomes. Each pattern pauses its conversation (what comes waits, a note says why, the owner gets one
// ask with Resume and Dismiss); the negatives are never paused.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerLoop, deliver, deliveryNotices, loadConv, loopAsks, tick } from '../src/delivery.mjs';
import { CHURN_RUNS, FAIL_RUNS, REPEAT_RUNS, detectLoop, judge, pingPong, shapeOf } from '../src/loops.mjs';
import { GRANTS, KEY } from '../src/grants.mjs';
import { appendRelay, relay } from '../src/relay.mjs';
import { memStore } from '../src/store.mjs';
import { ClaudeRunner, CodexRunner } from '../src/runners.mjs';
import { bodyInHouse, cvOf, houseWorld, pkg, until, world } from './delivery-world.mjs';
import { runBodyHost } from '../src/bodyhost.mjs';
import { act, manifest } from '../src/ui.mjs';
import { scratch } from './scratch.mjs';

const MIN = 60_000;
const WORKED = { failed: false, worked: true };
const wake = (w, place, text) => w.msg(place, text, { from: { kind: 'schedule' }, kind: 'wake', venue: 'slack' });
const fromMark = (w, place, text) => w.msg(place, text, { from: { kind: 'agent', id: 'mark' } });

/** The delivery world with a fake venue send; helpers to run one body to the end of its turn. */
function setup() {
  const w = world();
  const S = scratch('rt-loops-');
  process.env.FAKE_SEND = S;
  const conv = (place) => loadConv(w.env, cvOf('art', 'slack', place));
  const keyOf = (c) => w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY;
  /** The body holding `place` posts `text` (and the post is waited for). */
  const say = async (place, text) => { let p; const c = conv(place); await w.send({ conversation: c.conversation, text, key: keyOf(c) }, { ...w.o, onSend: (x) => { p = x; } }); return p; };
  /** One run: a delivery, then (if a body took it) what it says, then its turn's end, then a tick. */
  const run = async (m, { reply, turn = WORKED, after = 0 } = {}) => {
    const a = await deliver(w.env, m, w.o);
    if (!['started', 'resumed'].includes(a.body)) return a;
    w.clock.advance(after);
    if (reply !== undefined) await say(m.place, reply);
    w.runner.finish(conv(m.place).body, turn);
    await tick(w.env, w.o);
    return a;
  };
  const bodies = () => w.log.filter((l) => l[0] === 'start' || l[0] === 'resume').length;
  return { w, S, conv, run, bodies, done: () => { delete process.env.FAKE_SEND; } };
}

describe('the patterns, as loops.mjs reads a conversation\'s runs', () => {
  const at = (i, len = 10_000, gap = 60_000) => ({ at: i * (len + gap), end: i * (len + gap) + len });
  test('judge: what a failed run is, and what a run that can\'t be described isn\'t', () => {
    assert.match(judge({ fail: 'it couldn\'t start: no house' }).failed, /couldn't start/);
    assert.match(judge({ turn: { failed: true, error: 'API Error: 500' } }).failed, /harness failed the turn: API Error: 500/);
    assert.match(judge({ sent: 1, posts: [{ ok: false, reason: 'shadow mode' }] }).failed, /post was refused: shadow mode/);
    assert.match(judge({ sent: 0, turn: { failed: false, worked: false } }).failed, /no reply and no tool work/);
    assert.equal(judge({ sent: 0, turn: { failed: false, worked: true } }).failed, null, 'tool work, no reply: a lane doing its job');
    assert.equal(judge({ sent: 0 }).failed, null, 'a harness that can\'t say is never called a failure');
    assert.equal(judge({ sent: 2, posts: [{ ok: false, reason: 'x' }, { ok: true, h: 'h1' }] }).failed, null, 'a post that went');
  });
  test('shapeOf: the same words, numbers and ids and case aside; new words are a new shape', () => {
    assert.equal(shapeOf('Thanks! Got it (3), see r-1234abcd'), shapeOf('thanks, got it (4) see r-99887766'));
    assert.notEqual(shapeOf('Thanks, got it'), shapeOf('Thanks, but what about the tests?'));
  });
  test('pingPong: round trips of near-identical relays, newest last; new words break it', () => {
    const rows = (n, shape = () => 'same') => Array.from({ length: n }, (_, i) => ({ from: i % 2 ? 'mark' : 'art', to: i % 2 ? 'art' : 'mark', at: i * 1000, shape: `${i % 2}${shape(i)}` }));
    assert.equal(pingPong(rows(10), 'art', 'mark', 20_000), 5);
    assert.equal(pingPong(rows(10, (i) => `${i}`), 'art', 'mark', 20_000), 0, 'each relay says something new');
    assert.equal(pingPong(rows(10), 'art', 'mark', 20_000 + 31 * MIN), 0, 'outside the window');
  });
  test('detectLoop: each pattern, and nothing from a person\'s runs but their outcomes', () => {
    const fails = Array.from({ length: FAIL_RUNS }, (_, i) => ({ ...at(i * 100), cause: 'schedule', fail: 'it couldn\'t start: quota' }));
    assert.equal(detectLoop({ runs: fails }).pattern, 'failures', 'however far apart');
    assert.equal(detectLoop({ runs: fails.slice(1) }), null, 'one fewer');
    const same = Array.from({ length: REPEAT_RUNS }, (_, i) => ({ ...at(i), cause: 'agent', sent: 1, posts: [{ ok: true, h: 'h' }], turn: WORKED }));
    assert.equal(detectLoop({ runs: same }).pattern, 'repeats');
    assert.equal(detectLoop({ runs: same.map((r) => ({ ...r, cause: 'person' })) }), null, 'a person asking the same thing is never a loop');
    const churn = Array.from({ length: CHURN_RUNS + 2 }, (_, i) => ({ ...at(i, 5_000, 2_000), cause: 'schedule', sent: 0, posts: [], turn: WORKED }));
    assert.equal(detectLoop({ runs: churn }).pattern, 'churn');
    assert.equal(detectLoop({ runs: churn.slice(1) }), null, 'K in a row is fine; more than K is churn');
  });
});

describe('each pattern pauses its conversation (live delivery, the fake runner and venue)', () => {
  test('a failure streak: 4 runs in a row whose harness failed, hours apart; the 5th waits, a note, one ask; Resume starts it', async () => {
    const { w, conv, run, bodies, done } = setup();
    const turn = { failed: true, worked: true, error: 'API Error: 529 overloaded' };
    for (let i = 1; i <= 4; i++) { assert.match((await run(wake(w, 'lane:knowledge', `wake ${i}`), { turn })).body, /^(started|resumed)$/); w.clock.advance(3 * 60 * MIN); }
    const fifth = await deliver(w.env, wake(w, 'lane:knowledge', 'wake 5'), w.o);
    assert.equal(fifth.body, 'queued');
    assert.match(fifth.reason, /^paused: it looks like a loop \(4 runs in a row failed with 'its harness failed the turn: API Error: 529 overloaded'\)/);
    assert.equal(bodies(), 4, 'no 5th body');
    const c = conv('lane:knowledge');
    assert.equal(c.paused.pattern, 'failures');
    // The note on the conversation: the agent's own note turn, deferred, its reason as the audit text.
    const note = w.core.turns.find((t) => t.kind === 'note' && t.conversation === c.conversation);
    assert.equal(note.outcome, 'deferred');
    assert.match(w.core.audits.find((a) => a.seq === note.seq && a.conversation === c.conversation).text, /^Paused: it looks like a loop \(4 runs in a row failed/);
    // One ask, with Resume and Dismiss; more deliveries and ticks wait, and don't add another.
    await deliver(w.env, wake(w, 'lane:knowledge', 'wake 6'), w.o);
    for (let i = 0; i < 3; i++) { w.clock.advance(10 * MIN); await tick(w.env, w.o); }
    assert.equal(bodies(), 4);
    const asks = loopAsks(w.env);
    assert.equal(asks.length, 1);
    assert.equal(asks[0].text, "Looks like a loop in Art's slack:Loren (lane:knowledge): 4 runs in a row failed with 'its harness failed the turn: API Error: 529 overloaded'. Paused.");
    assert.deepEqual(asks[0].actions.map((a) => [a.action, a.label, a.fields.conversation]), [['loop-resume', 'Resume', c.conversation], ['loop-dismiss', 'Dismiss', c.conversation]]);
    assert.equal(asks[0].meta, `2 waiting · ${c.conversation}`);
    assert.equal(w.core.turns.filter((t) => t.kind === 'note').length, 1, 'one note');
    // Resume: what waited starts now, in one body; the check starts over (the old failures don't pause it again).
    const r = await answerLoop(w.env, c.conversation, 'resume', w.o);
    assert.deepEqual([r.resumed, r.waiting], [true, 2]);
    assert.equal(bodies(), 5);
    assert.equal(loopAsks(w.env).length, 0);
    assert.equal(conv('lane:knowledge').queue.length, 0);
    w.runner.finish(conv('lane:knowledge').body, WORKED);
    await tick(w.env, w.o);
    assert.match((await run(wake(w, 'lane:knowledge', 'wake 7'))).body, /^(started|resumed)$/, 'it goes on');
    await assert.rejects(answerLoop(w.env, c.conversation, 'resume', w.o), /isn't paused/);
    done();
  });

  test('a failure streak of bodies that never started: each delivery\'s tries are one run; the 4th such run pauses it, its tries stop', async () => {
    const { w, conv, bodies, done } = setup();
    w.runner.failStart = 'the house won\'t come up';
    for (let i = 1; i <= 3; i++) {
      await deliver(w.env, wake(w, 'lane:tend', `wake ${i}`), w.o);
      // Its tries (60 s, 240 s, 600 s, then given up): one run, not four.
      for (let k = 0; k < 4; k++) { w.clock.advance(11 * MIN); await tick(w.env, w.o); }
      assert.equal(conv('lane:tend').paused, undefined, `${i}: not yet`);
    }
    assert.equal(conv('lane:tend').runLog.length, 3);
    const fourth = await deliver(w.env, wake(w, 'lane:tend', 'wake 4'), w.o);
    assert.equal(fourth.body, 'queued');
    // Its first try failed: 4 runs in a row. Its next try is paused, not made.
    w.clock.advance(2 * MIN);
    await tick(w.env, w.o);
    const c = conv('lane:tend');
    assert.match(c.paused?.reason ?? '', /^4 runs in a row failed with 'it couldn't start: the house won't come up'$/);
    assert.equal(c.queue.length, 1, 'the wake waits');
    w.runner.failStart = null;
    for (let k = 0; k < 4; k++) { w.clock.advance(11 * MIN); await tick(w.env, w.o); }
    assert.equal(bodies(), 0, 'nothing more tried until the owner says');
    await answerLoop(w.env, c.conversation, 'resume', w.o);
    assert.equal(bodies(), 1, 'resumed: it starts');
    done();
  });

  test('a refused post, run after run: the failure streak (and its reason) catches it', async () => {
    const { w, S, run, done } = setup();
    writeFileSync(join(S, 'refuse'), JSON.stringify({ ok: false, reason: 'loom-slack is in shadow mode', permanent: true }));
    for (let i = 1; i <= 4; i++) { await run(fromMark(w, 'dm:SH', `ask ${i}`), { reply: `answer ${i}` }); w.clock.advance(30 * MIN); }
    const a = await deliver(w.env, fromMark(w, 'dm:SH', 'ask 5'), w.o);
    assert.match(a.reason, /4 runs in a row failed with 'its post was refused: loom-slack is in shadow mode'/);
    done();
  });

  test('repeated output: 4 runs in a row, for an agent, each soon after the last, posting the same words', async () => {
    const { w, run, bodies, done } = setup();
    for (let i = 1; i <= 4; i++) { await run(fromMark(w, 'dm:REP', `status? ${i}`), { reply: 'I can\'t reach the repo.\n' }); w.clock.advance(2 * MIN); }
    const a = await deliver(w.env, fromMark(w, 'dm:REP', 'status? 5'), w.o);
    assert.equal(a.body, 'queued');
    assert.match(a.reason, /4 runs in a row posted the same words/);
    assert.equal(bodies(), 4);
    done();
  });

  test('relay ping-pong: Art and Mark relaying near-identical words back and forth; the receiving side pauses', async () => {
    const w = world();
    const store = memStore();
    store.put(GRANTS, KEY, { v: 1, pieces: {}, relay: { art: ['mark'], mark: ['art'] } });
    const d = (who) => ({
      core: { deliver: async (b) => { const r = await deliver(w.env, { ...b, source: 'runtime' }, w.o); if (r.status) throw new Error(r.error); return r; } },
      store: () => store, household: () => ({ v: 1, agents: ['art', 'mark'], owner: 'jonathan' }),
      approvals: { installed: () => false, spend: () => 'no' }, now: () => w.clock.now().getTime(),
      append: (row) => appendRelay(w.env, row, w.clock.now().getTime()), who,
    });
    let last = null;
    const outs = [];
    for (let i = 1; i <= 12; i++) {
      const [from, to] = i % 2 ? ['art', 'mark'] : ['mark', 'art'];
      // "Thanks! (n)", each one a shade different (an exact repeat within the hour is refused by relay.mjs itself).
      const r = await relay(w.env, { kind: 'agent', agent: from }, { to, say: `Thanks, got it! (${i})`, ...(last ? { reply_to: last } : {}) }, d(from));
      last = /^(r-[0-9a-f]{8})/.exec(r.text)[1];
      outs.push(r.text);
      const asker = loadConv(w.env, cvOf(from, 'relay', to));
      if (asker?.body) w.runner.finish(asker.body, WORKED);
      await tick(w.env, w.o);
      w.clock.advance(MIN);
    }
    const paused = [cvOf('art', 'relay', 'mark'), cvOf('mark', 'relay', 'art')].map((cv) => loadConv(w.env, cv)).filter((c) => c.paused);
    assert.ok(paused.length >= 1, outs.join('\n'));
    assert.equal(paused[0].paused.pattern, 'ping-pong');
    assert.match(paused[0].paused.reason, /relayed near-identical words back and forth \d+ times in 30 minutes/);
    assert.ok(outs.some((t) => /it waits for a body of theirs/.test(t)), 'a relay to a paused side waits');
  });

  test('start-stop churn: very short runs, each right after the last, no person, nothing said; Dismiss drops what waited', async () => {
    const { w, conv, run, bodies, done } = setup();
    for (let i = 1; i <= CHURN_RUNS + 2; i++) { await run(wake(w, 'lane:churn', `again ${i}`), { after: 5_000 }); w.clock.advance(10_000); }
    const a = await deliver(w.env, wake(w, 'lane:churn', 'again'), w.o);
    assert.match(a.reason, /paused: it looks like a loop \(5 very short runs in a row, each started right after the last/);
    assert.equal(bodies(), CHURN_RUNS + 2);
    const c = conv('lane:churn');
    // The owner's ask is on the runtime's manifest; Dismiss is its action.
    const ask = manifest(w.env).asks.find((x) => x.actions?.[0]?.action === 'loop-resume');
    assert.equal(ask.kind, 'decision');
    assert.match(ask.text, /^Looks like a loop in Art's slack:Loren \(lane:churn\): 5 very short runs/);
    const r = await act(w.env, {}, { action: 'loop-dismiss', fields: ask.actions[1].fields });
    assert.deepEqual(r, { ok: true, message: 'Dismissed: 1 waiting dropped; its next message starts it fresh.', page: '' });
    assert.equal((await act(w.env, {}, { action: 'loop-resume', fields: ask.actions[0].fields })).ok, false, 'not paused any more');
    assert.equal(conv('lane:churn').queue.length, 0, 'what waited is dropped');
    assert.equal(loopAsks(w.env).length, 0);
    await tick(w.env, w.o);
    assert.equal(bodies(), CHURN_RUNS + 2, 'nothing started for it');
    assert.match((await deliver(w.env, wake(w, 'lane:churn', 'later'), w.o)).body, /^(started|resumed)$/, 'its next message starts it fresh');
    done();
  });
});

describe('never a loop', () => {
  test('a long productive burst: 20 successful, varied runs back to back (agents and wakes) is never paused', async () => {
    const { w, conv, run, bodies, done } = setup();
    for (let i = 1; i <= 20; i++) {
      const m = i % 3 ? fromMark(w, 'dm:BUSY', `task ${i}`) : wake(w, 'dm:BUSY', `tick ${i}`);
      const a = await run(m, { reply: `Done with step ${i}: ${'x'.repeat(i)}`, after: 5_000 });
      assert.match(a.body, /^(started|resumed)$/, `run ${i}: ${JSON.stringify(a)}`);
      w.clock.advance(1_000);
    }
    assert.equal(bodies(), 20);
    const c = conv('dm:BUSY');
    assert.equal(c.paused, undefined);
    // What the check read: each run finished, each said something new.
    assert.equal(c.runLog.length, 12);
    assert.ok(c.runLog.slice(0, -1).every((r) => Number.isFinite(r.end) && r.sent === 1 && r.posts[0].ok), JSON.stringify(c.runLog));
    assert.equal(new Set(c.runLog.map((r) => r.posts[0]?.h)).size, 12);
    done();
  });

  test('two agents relaying with changing content, a dozen times in a few minutes, are never paused', async () => {
    const w = world();
    const store = memStore();
    store.put(GRANTS, KEY, { v: 1, pieces: {}, relay: { art: ['mark'], mark: ['art'] } });
    const d = {
      core: { deliver: async (b) => { const r = await deliver(w.env, { ...b, source: 'runtime' }, w.o); if (r.status) throw new Error(r.error); return r; } },
      store: () => store, household: () => ({ v: 1, agents: ['art', 'mark'], owner: 'jonathan' }),
      approvals: { installed: () => false, spend: () => 'no' }, now: () => w.clock.now().getTime(),
      append: (row) => appendRelay(w.env, row, w.clock.now().getTime()),
    };
    const topics = ['the schema', 'its migration', 'the failing test', 'a fix for it', 'CI on the PR', 'the review comments', 'the merge', 'the deploy', 'the smoke check', 'the docs', 'the follow-up issue', 'closing the task'];
    let last = null;
    for (let i = 0; i < topics.length; i++) {
      const [from, to] = i % 2 ? ['mark', 'art'] : ['art', 'mark'];
      // Each answer is relayed from the body that was asked, mid-turn; then its turn ends.
      const r = await relay(w.env, { kind: 'agent', agent: from }, { to, say: `Next: ${topics[i]}. What do you think?`, ...(last ? { reply_to: last } : {}) }, d);
      assert.doesNotMatch(r.text, /waits/, r.text);
      last = /^(r-[0-9a-f]{8})/.exec(r.text)[1];
      const asker = loadConv(w.env, cvOf(from, 'relay', to));
      if (asker?.body) w.runner.finish(asker.body, WORKED);
      await tick(w.env, w.o);
      w.clock.advance(20_000);
    }
    for (const cv of [cvOf('art', 'relay', 'mark'), cvOf('mark', 'relay', 'art')]) assert.equal(loadConv(w.env, cv).paused, undefined);
  });

  test('a lane whose wakes are spaced out (short runs, no reply, even the same words) is never paused', async () => {
    const { w, conv, run, bodies, done } = setup();
    for (let i = 1; i <= 12; i++) {
      // Even runs reply the same "nothing to do" each time: spaced out, that's a quiet lane, not a loop.
      await run(wake(w, 'lane:quiet', `wake ${i}`), i % 2 ? { after: 5_000 } : { reply: 'Nothing to do.', after: 5_000 });
      w.clock.advance(30 * MIN);
    }
    assert.equal(bodies(), 12);
    assert.equal(conv('lane:quiet').paused, undefined);
    assert.ok(conv('lane:quiet').runLog.every((r) => Number.isFinite(r.end) && r.end - r.at < 90_000), 'short runs, all of them');
    done();
  });

  test('a person chatting: the same answer to the same question, quickly, many times, is never a loop', async () => {
    const { w, conv, run, bodies, done } = setup();
    for (let i = 1; i <= 10; i++) { await run(w.msg('dm:PING', 'ping'), { reply: 'pong' }); w.clock.advance(5_000); }
    assert.equal(bodies(), 10);
    assert.equal(conv('dm:PING').paused, undefined);
    done();
  });
});

describe('never a loop, either', () => {
  test('another agent\'s quick messages, each answered with work and no reply, are that agent\'s pace: never churn', async () => {
    const { w, conv, run, bodies, done } = setup();
    for (let i = 1; i <= 10; i++) { assert.match((await run(fromMark(w, 'dm:FAST', `do step ${i}`))).body, /^(started|resumed)$/); w.clock.advance(30_000); }
    assert.equal(bodies(), 10);
    assert.equal(conv('dm:FAST').paused, undefined);
    done();
  });
});

describe('what the hourly cap left', () => {
  test('its setting is gone, and its state on a conversation is dropped by the tick', async () => {
    assert.ok(!pkg.loom.settings.some((s) => s.name === 'LOOM_RUNTIME_STARTS_PER_HOUR'));
    const { w, conv, run, done } = setup();
    await run(w.msg('dm:OLD', 'hi'));
    const c = conv('dm:OLD');
    const f = join(w.env.LOOM_BOX_DATA, 'delivery', 'conversations', `${c.conversation}.json`);
    writeFileSync(f, JSON.stringify({ ...c, bodyStarts: [1, 2, 3], capNoticeAt: 4 }));
    await tick(w.env, w.o);
    const after = JSON.parse(readFileSync(f, 'utf-8'));
    assert.deepEqual(['bodyStarts' in after, 'capNoticeAt' in after], [false, false]);
    // A machine-message burst that the cap would have held back (7 in an hour) goes.
    for (let i = 1; i <= 8; i++) assert.match((await run(fromMark(w, 'dm:OLD', `m${i}`), { reply: `r${i}` })).body, /^(started|resumed)$/);
    assert.equal(deliveryNotices(w.env, w.clock.now().getTime()).filter((n) => /in an hour/.test(n.text)).length, 0);
    done();
  });
});

describe('how a turn went, as each harness says it (runners.mjs, turn)', () => {
  test('Claude: its job\'s state and timeline; Codex: its events', () => {
    const D = scratch('rt-loops-turn-');
    const r = new ClaudeRunner({ jobsDir: join(D, 'jobs') });
    const job = (id, state, timeline, detail = '') => {
      mkdirSync(join(D, 'jobs', id), { recursive: true });
      writeFileSync(join(D, 'jobs', id, 'state.json'), JSON.stringify({ state, detail }));
      if (timeline) writeFileSync(join(D, 'jobs', id, 'timeline.jsonl'), timeline.map((x) => JSON.stringify({ state: 'working', detail: x })).join('\n') + '\n');
    };
    job('aaaa0001', 'working', ['Reading x']);
    assert.equal(r.turn({ id: 'aaaa0001' }), null, 'mid-turn: nothing yet');
    job('aaaa0002', 'done', ['', 'Running the miner']);
    assert.deepEqual(r.turn({ id: 'aaaa0002' }), { failed: false, worked: true });
    job('aaaa0003', 'failed', ['', ''], 'API Error: 500');
    assert.deepEqual(r.turn({ id: 'aaaa0003' }), { failed: true, worked: false, error: 'API Error: 500' });
    job('aaaa0004', 'done', null);
    assert.deepEqual(r.turn({ id: 'aaaa0004' }), { failed: false, worked: null }, 'no timeline: it doesn\'t say');
    const x = new CodexRunner({ runsDir: join(D, 'runs') });
    const run = (id, ev) => { mkdirSync(join(D, 'runs', id), { recursive: true }); writeFileSync(join(D, 'runs', id, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n'); };
    run('k1', [{ type: 'turn.started' }, { type: 'item.completed', item: { type: 'command_execution' } }, { type: 'turn.completed' }]);
    assert.deepEqual(x.turn({ id: 'k1' }), { failed: false, worked: true });
    run('k2', [{ type: 'turn.started' }, { type: 'item.completed', item: { type: 'agent_message' } }, { type: 'turn.failed', error: { message: 'stream disconnected' } }]);
    assert.deepEqual(x.turn({ id: 'k2' }), { failed: true, worked: false, error: 'stream disconnected' });
    run('k3', [{ type: 'turn.started' }]);
    assert.equal(x.turn({ id: 'k3' }), null);
    assert.ok(!existsSync(join(D, 'nothing')));
  });
});

describe('a house\'s body host says how a turn went, and the runtime keeps it', () => {
  test('the host reports turn once a body\'s turn is over (read once)', async () => {
    const reports = [];
    let beat = 0;
    let reads = 0;
    const turns = ['working', 'working', 'idle', 'idle'];
    const client = async (path, body) => {
      if (path === 'usage') return { ok: true };
      reports.push(body.report);
      return { req: { r1: { harness: 'claude', brief: 'hi', model: 'm' } } };
    };
    const runner = () => ({
      start: () => ({ id: 'b1', harness: 'claude' }),
      status: () => turns[Math.min(beat, turns.length - 1)],
      slotOf: () => null,
      turn: () => { reads += 1; return { failed: true, worked: false, error: 'API Error: 500' }; },
    });
    await runBodyHost({ client, runner, env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/run/loom/login/claude' }, hostKey: 'k', sleep: async () => { beat += 1; }, beats: turns.length + 1, idleS: 0 });
    const said = reports.map((r) => r.bodies.b1?.turn ?? null);
    assert.ok(said.some((t) => t === null), 'nothing while it works');
    assert.deepEqual(said.at(-1), { failed: true, worked: false, error: 'API Error: 500' });
    assert.equal(reads, 1, 'read once');
  });

  test('the house runner keeps a reported turn, checked, and hands it on', async () => {
    const w = houseWorld();
    const { body, host } = await bodyInHouse(w);
    w.local.turn = () => ({ failed: true, worked: 'yes', error: 'x'.repeat(500), extra: 1 });
    w.local.status = () => 'idle';
    await until(() => w.hr.turn(body) !== null);
    assert.deepEqual(w.hr.turn(body), { failed: true, worked: null, error: 'x'.repeat(200) });
    await w.kill();
    await host;
  });
});
