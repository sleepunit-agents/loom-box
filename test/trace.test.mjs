// A reply's trace (trace.mjs; loom docs/specs/comms.md, "Tracing a reply"; t-1895): one read, from the message in to
// the reply shown, joining the runtime's run record with core's thread facts. An agent reads its own; an owner theirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, loadConv, tick } from '../src/delivery.mjs';
import { trace, traceText, traceTool } from '../src/trace.mjs';
import { page } from '../src/ui.mjs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { world, cvOf } from './delivery-world.mjs';

// loom's own page validator (contract.test.mjs): a built loom, else the page test checks its shape alone.
const dist = process.env.LOOM_DIST || join(homedir(), 'Code', 'loom', 'dist');
const vocab = existsSync(join(dist, 'ui', 'vocab.js')) ? await import(join(dist, 'ui', 'vocab.js')) : null;

const thread = 'th:abcdefghij';

/** A Comms message to Art, a body for it, and core answering the trace op as loom's comms.ts does. */
async function comms() {
  const w = world();
  const shown = [];
  w.core.commsAnswer = (b) => {
    if (b.op === 'trace') return { ok: true, trace: { thread, conversation: cvOf('art', 'loom', thread), archived: null, working_since: null, queued_since: null, last_failed: false, messages: [{ seq: 1, at: w.clock.now().toISOString(), kind: 'message', from: 'jonathan', run: null, delivery: 'delivered' }, ...shown] } };
    if (b.op === 'post') { shown.push({ seq: 2, at: w.clock.now().toISOString(), kind: 'reply', from: 'art', run: b.run ?? null }); return { ok: true, id: '2' }; }
    return b.op === 'describe' ? { ok: true, readers: ['jonathan'], brief: ['A private thread.'] } : { ok: true };
  };
  await deliver(w.env, { source: 'loom', id: `comms:${thread}:aaaaaaaaaaaaaaaa`, agent: 'art', venue: 'loom', place: thread, from: { kind: 'person', slug: 'jonathan' }, kind: 'message', at: w.clock.now().toISOString(), text: 'is the build green?' }, w.o);
  const cv = cvOf('art', 'loom', thread);
  const c = loadConv(w.env, cv);
  return { w, cv, c, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY };
}

test('a run that ended without posting says so, and why: its send was refused (Mark\'s 2026-11-06 reply, t-1898)', async () => {
  const { w, cv, c, key } = await comms();
  // A send naming no session, as every Codex send did before t-1898: refused, on the run's record.
  const no = await w.send({ conversation: cv, text: 'All green.', key, session: '' }, w.o);
  assert.equal(no.ok, false);
  w.runner.finish(c.body, { failed: false, worked: true });
  await tick(w.env, w.o);
  const t = await trace(w.env, { agent: 'art' }, { thread }, { core: w.core });
  assert.equal(t.conversation, cv);
  assert.equal(t.run, c.run);
  const words = t.steps.map((s) => `${s.step}:${s.ok}`);
  assert.deepEqual(words, ['delivered:true', 'started:true', 'ended:true', 'posted:false', 'posted:false', 'shown:false']);
  assert.match(t.steps[3].words, /1 send was refused before posting: .*no session is named/);
  assert.match(traceText(t), /NO .*shown: The thread shows no reply from this run/);
  // Never a message's words.
  assert.ok(!JSON.stringify(t).includes('build green') && !JSON.stringify(t).includes('All green'));
});

test('a run whose reply posted and shows: every step ok, the reply by its run', async () => {
  const { w, cv, c, key } = await comms();
  let p;
  const ok = await w.send({ conversation: cv, text: 'All green.', key }, { ...w.o, onSend: (x) => { p = x; } });
  assert.equal(ok.accepted, true);
  await p;
  w.runner.finish(c.body, { failed: false, worked: true });
  await tick(w.env, w.o);
  const t = await trace(w.env, { agent: 'art' }, { run: c.run }, { core: w.core });
  assert.deepEqual(t.steps.map((s) => `${s.step}:${s.ok}`), ['delivered:true', 'started:true', 'ended:true', 'posted:true', 'accepted:true', 'shown:true']);
  assert.match(t.steps.at(-1).words, /shows 1 reply from this run \(seq 2\)/);
  assert.equal(t.runs.at(-1).body, c.body);
});

test('never across agents: Mark gets the same answer for Art\'s thread as for none; an owner reads the agents they own', async () => {
  const { w, cv } = await comms();
  for (const q of [{ thread }, { conversation: cv }, { thread: 'th:zzzzzzzzzz' }]) {
    await assert.rejects(trace(w.env, { agent: 'mark' }, q, { core: w.core }), /no conversation of yours here by that name/);
  }
  await assert.rejects(trace(w.env, { agents: ['mark'] }, { conversation: cv }, { core: w.core }), /no conversation of yours/);
  assert.equal((await trace(w.env, { agents: ['art'] }, { conversation: cv }, { core: w.core })).agent, 'art');
  // The tool core runs: as the session's agent (core's --agent), never from its arguments.
  const mine = await traceTool(w.env, ['--agent', 'art'], JSON.stringify({ thread }), { core: w.core });
  assert.equal(mine.exit, 0);
  const theirs = await traceTool(w.env, ['--agent', 'mark'], JSON.stringify({ thread, agent: 'art' }), { core: w.core });
  assert.deepEqual([theirs.exit, theirs.answer.isError], [1, true]);
});

test('from a house, only the conversation whose body it runs; from a service\'s house, none (t-2118)', async () => {
  const { w, cv, c } = await comms();
  // The body's record names its house, as a house runner's start does.
  const { join } = await import('node:path');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const house = 'h-41';
  const f = join(w.env.LOOM_BOX_DATA || join(w.env.HOME, '.local', 'share', 'loom-box'), 'bodies', `${c.body.replace(':', '-')}.json`);
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf-8')), house }));
  assert.equal((await trace(w.env, { agent: 'art', house }, { conversation: cv }, { core: w.core })).conversation, cv);
  for (const who of [{ agent: 'art', house: 'h-999999' }, { agent: 'art', house, service: 'discord' }, { agent: 'art', service: 'discord' }]) {
    await assert.rejects(trace(w.env, who, { conversation: cv }, { core: w.core }), /no conversation of yours here by that name/);
  }
  const other = await traceTool(w.env, ['--agent', 'art', '--house', 'h-999999'], JSON.stringify({ thread }), { core: w.core });
  assert.deepEqual([other.exit, other.answer.isError], [1, true]);
  const svc = await traceTool(w.env, ['--agent', 'art', '--house', house, '--service', 'discord'], JSON.stringify({ thread }), { core: w.core });
  assert.deepEqual([svc.exit, svc.answer.isError], [1, true]);
  assert.equal((await traceTool(w.env, ['--agent', 'art', '--house', house], JSON.stringify({ thread }), { core: w.core })).exit, 0);
});

test('core without the trace op (an older loom): the runtime\'s half still answers, and says what it couldn\'t see', async () => {
  const { w } = await comms();
  w.core.commsAnswer = (b) => (b.op === 'trace' ? (() => { throw new Error('core refused comms/adapter: bad-input: op is post, describe or status'); })() : { ok: true });
  const t = await trace(w.env, { agent: 'art' }, { thread }, { core: w.core });
  assert.equal(t.thread, undefined);
  assert.match(t.note, /core couldn't say what the thread shows/);
  assert.ok(t.steps.some((s) => s.step === 'started'));
});

test('the owner\'s trace page: the steps in the page vocabulary; not found for an agent they don\'t own', async () => {
  const { w, cv } = await comms();
  w.env.LOOM_RUNTIME_LOOM_URL = 'http://127.0.0.1:9/mcp';
  const own = await page(w.env, { path: `trace/${cv}`, caller: { kind: 'owner' } });
  if (vocab) { const v = vocab.parsePage(own); assert.notEqual(typeof v, 'string', `trace page: ${v}`); }
  assert.match(own.title, /What happened/);
  const not = await page(w.env, { path: `trace/${cv}`, caller: { kind: 'owner', agents: ['mark'] } });
  assert.equal(not.title, 'Not found');
});

test('steps belong to their run: a later run\'s error card isn\'t this one\'s; only a start-… run "couldn\'t start"', async () => {
  const { stepsOf } = await import('../src/trace.mjs');
  const c = { agent: 'art', outcomes: {}, queue: [] };
  const r1 = { run: 'run-aaaaaaaaaaaa', how: 'started', started: '2026-11-06T04:00:00.000Z', ended: '2026-11-06T04:01:00.000Z', sent: 1, posts: [{ ok: true }] };
  const r2 = { run: 'run-bbbbbbbbbbbb', started: '2026-11-06T05:00:00.000Z', ended: '2026-11-06T05:01:00.000Z', sent: 0, posts: [], fail: 'stopped: it waited 30 minutes on a permission prompt nobody can answer' };
  const thread = { messages: [{ seq: 2, at: '2026-11-06T04:00:30.000Z', kind: 'reply', run: r1.run }, { seq: 4, at: '2026-11-06T05:00:30.000Z', kind: 'error', error: { code: 'post-failed', words: 'Art\'s reply couldn\'t be shown.' } }] };
  assert.ok(!stepsOf(c, r1, thread, r2).some((s) => /error card/.test(s.words)), 'run 2\'s card isn\'t run 1\'s');
  // A run that posted nothing: said plainly, never that it didn't call send (a send can be turned away before it's
  // counted or refused on the record, t-1900).
  const quiet = stepsOf(c, r2, thread, null).find((s) => s.step === 'posted');
  assert.equal(quiet.words, 'Nothing was posted from this run.');
  assert.ok(!stepsOf(c, r2, thread, null).some((s) => /never called|No send reached/.test(s.words)));
  const two = stepsOf(c, r2, thread, null);
  assert.ok(two.some((s) => /error card/.test(s.words)));
  // A run from before runs carried their body, stopped later: stopped, never "couldn't start".
  assert.ok(two.some((s) => s.step === 'ended' && /was stopped/.test(s.words)));
  assert.ok(!two.some((s) => /couldn't start/.test(s.words)));
  assert.match(stepsOf(c, { run: 'start-abcd1234', started: r1.started, ended: r1.started, fail: 'it couldn\'t start: no login', sent: 0, posts: [] }, null).at(-1).words, /couldn't start: it couldn't start: no login|couldn't start/);
});
