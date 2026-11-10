// Activity cards (loom docs/specs/comms.md, section 3; criterion 16): a Comms thread's body's tool steps, from its
// harness's own record, by a fixed table. The fixtures are real records: a Claude Code session transcript's lines
// (their tool inputs and outputs replaced, their shape kept) and a real `codex exec --json` run's events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changed, claudeCards, claudeSummary, codexCards, shownPath } from '../src/activity.mjs';
import { ClaudeRunner, CodexRunner } from '../src/runners.mjs';
import { deliver, loadConv, tick } from '../src/delivery.mjs';
import { here, world, cvOf } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';

const read = (f) => readFileSync(join(here, 'fixtures', f), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('a Claude transcript: tool_use makes a running card, its result done or failed; text and thinking make none', () => {
  const cards = claudeCards(read('claude-transcript.jsonl'));
  assert.deepEqual(cards.map((c) => [c.tool, c.summary, c.state]), [
    ['Bash', 'Run the test suite', 'failed'],
    ['Read', 'Read delivery.ts', 'done'],
    ['Grep', 'Searched for "deliverAsOwner" in src', 'running'],
  ]);
  const all = JSON.stringify(cards);
  for (const never of ['s3cr3t', 'npm test', 'OUTPUT-THAT-MUST-NOT-SHOW', 'secret plan', 'private reasoning', '/home/art']) assert.ok(!all.includes(never), never);
});

test('a Codex run: item.started makes a card, item.completed finishes it; failed stays failed; messages make none', () => {
  const cards = codexCards(read('codex-events.jsonl'), 'b1:');
  assert.deepEqual(cards.map((c) => [c.id, c.tool, c.summary, c.state]), [
    ['b1:item_1', 'command_execution', 'Ran a command', 'done'], // echo says nothing of what it's for
    ['b1:item_2', 'command_execution', 'Ran ls — exit 2: no such file', 'failed'], // a raw command names no file
  ]);
  assert.ok(!JSON.stringify(cards).includes('cannot access'), 'never the output');
});

test('Codex\'s other tool items: an MCP call in words, a file change by its path, a search by its words; never a result, a diff or reasoning', () => {
  // Built to the shapes codex exec --json writes for these items (the recorded run above has commands only).
  const cards = codexCards(read('codex-tools.jsonl'), 'b2:');
  assert.deepEqual(cards.map((c) => [c.tool, c.summary, c.state]), [
    ['mcp_tool_call', 'Searched memory', 'done'],
    ['file_change', 'Changed a.ts', 'done'],
    ['web_search', 'Searched the web for "how comm screens look"', 'done'],
  ]);
  const all = JSON.stringify(cards);
  for (const never of ['RESULT-THAT', 'DIFF-THAT', 'REASONING-THAT', 'secret plans', '/home/art']) assert.ok(!all.includes(never), never);
});

test('the fixed table: a command\'s short form, a file\'s base name, searches cut at 60, MCP tools in words', () => {
  assert.equal(claudeSummary('Bash', { command: 'curl -H "Authorization: x" ...' }), 'Ran curl');
  assert.equal(claudeSummary('Bash', { command: 'echo hi' }), 'Ran a command');
  assert.equal(claudeSummary('Read', { file_path: '/etc/shadow' }, '/home/art/repo'), 'Read shadow');
  assert.ok(!claudeSummary('Read', { file_path: '/home/art/repo/a/b.ts' }, '/home/art/repo').includes('/home'));
  assert.equal(shownPath('/home/art/repo/a/b.ts', '/home/art/repo'), 'b.ts');
  assert.equal(claudeSummary('Grep', { pattern: 'x'.repeat(100) }).length, 'Searched for ""'.length + 60);
  assert.equal(claudeSummary('mcp__loom__recall', { query: 'what Jonathan said' }), 'Searched memory');
  assert.equal(claudeSummary('Read', { file_path: '/home/art/repo/a.ts', offset: 40, limit: 20 }, '/home/art/repo'), 'Read a.ts (lines 40–59)');
  assert.equal(claudeSummary('mcp__other__do_thing', { query: 'private words' }), 'Used a tool');
  assert.ok(claudeSummary('Bash', { description: 'two\nlines' }).indexOf('\n') === -1);
});

test('changed: only new cards and moved states, at most 50', () => {
  const cards = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, tool: 'Bash', summary: 's', state: 'running', at: 'x' }));
  const a = changed(cards, {});
  assert.equal(a.out.length, 50);
  const b = changed(cards, a.next);
  assert.deepEqual(b.out.map((c) => c.id), Array.from({ length: 10 }, (_, i) => `c${i + 50}`));
  const c = changed([{ ...cards[0], state: 'done' }], b.next);
  assert.deepEqual(c.out.map((x) => [x.id, x.state]), [['c0', 'done']]);
});

test('changed: a label that moved (a plan, a failure\'s why) is sent again; the record keeps a hash, never the label', () => {
  const a = changed([{ id: 'p', tool: 'todo_list', summary: 'Plan (0/2): Find it', state: 'done', at: 'x' }], {});
  assert.equal(a.out.length, 1);
  assert.ok(!JSON.stringify(a.next).includes('Find it'), 'no words in the record');
  const b = changed([{ id: 'p', tool: 'todo_list', summary: 'Plan (1/2): Write it', state: 'done', at: 'x' }], a.next);
  assert.deepEqual(b.out.map((c) => c.summary), ['Plan (1/2): Write it']);
  assert.equal(changed([{ id: 'p', tool: 'todo_list', summary: 'Plan (1/2): Write it', state: 'done', at: 'x' }], b.next).out.length, 0);
  // A record from before labels moved holds the bare state: a card whose state still matches isn't sent again.
  const legacy = changed([{ id: 'old', tool: 'Bash', summary: 'Ran npm test', state: 'done', at: 'x' }], { old: 'done' });
  assert.equal(legacy.out.length, 0);
  assert.notEqual(legacy.next.old, 'done', 'the old record moves to the mark');
  assert.equal(changed([{ id: 'old', tool: 'Bash', summary: 'Ran npm test — exit 1', state: 'done', at: 'x' }], legacy.next).out.length, 1, 'so a later label move is sent');
});

test('the runners read their own records: a Claude session\'s transcript, a Codex run\'s events', () => {
  const dir = scratch('rt-activity-');
  const projects = join(dir, 'projects');
  mkdirSync(join(projects, '-home-art-Code-repo'), { recursive: true });
  writeFileSync(join(projects, '-home-art-Code-repo', 'sess-1234.jsonl'), readFileSync(join(here, 'fixtures', 'claude-transcript.jsonl')));
  const cr = new ClaudeRunner({ jobsDir: join(dir, 'jobs'), projectsDir: projects, usageDir: null });
  assert.equal(cr.activity({ id: 'abcd1234', slot: { harness: 'claude', session: 'sess-1234' } }).length, 3);
  const runs = join(dir, 'runs');
  mkdirSync(join(runs, 'k1'), { recursive: true });
  writeFileSync(join(runs, 'k1', 'events.jsonl'), readFileSync(join(here, 'fixtures', 'codex-events.jsonl')));
  const xr = new CodexRunner({ runsDir: runs });
  assert.deepEqual(xr.activity({ id: 'k1' }).map((c) => c.id), ['k1:item_1', 'k1:item_2']);
});

test('the tick posts loom and bridge bodies\' new and moved cards to core', async () => {
  const w = world();
  const cards = [{ id: 't1', at: 'x', tool: 'Bash', summary: 'Ran the tests', state: 'running' }];
  w.runner.activity = () => cards;
  const thread = 'th:abcdefghij';
  await deliver(w.env, { source: 'loom', id: `comms:${thread}:aaaaaaaaaaaaaaaa`, agent: 'art', venue: 'loom', place: thread, from: { kind: 'person', slug: 'jonathan' }, kind: 'message', at: w.clock.now().toISOString(), text: 'go' }, w.o);
  await deliver(w.env, w.msg('dm:U1', 'hi'), w.o);
  await tick(w.env, w.o);
  assert.equal(w.core.activityCalls.length, 2);
  assert.equal(w.core.activityCalls[0].conversation, cvOf('art', 'loom', thread));
  assert.equal(w.core.activityCalls[0].run, loadConv(w.env, cvOf('art', 'loom', thread)).run);
  await tick(w.env, w.o);
  assert.equal(w.core.activityCalls.length, 2, 'nothing new, nothing sent');
  cards[0] = { ...cards[0], state: 'done' };
  await tick(w.env, w.o);
  assert.equal(w.core.activityCalls.length, 4);
  assert.deepEqual(w.core.activityCalls[2].cards.map((c) => c.state), ['done']);
});

test('a spawned job\'s body posts its steps to the job\'s own thread once it has one, so it can be watched (t-2043)', async () => {
  const w = world();
  w.core.commsAnswer = (b) => (b.op === 'spawn' ? { ok: true, id: 'th:abcdefghij' } : { ok: true });
  const cards = [{ id: 't1', at: 'x', tool: 'Bash', summary: 'Ran the tests', state: 'running' }];
  w.runner.activity = () => cards;
  const { spawnCall } = await import('../src/spawn.mjs');
  const r = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Run the tests' }, w.o);
  await tick(w.env, w.o);
  assert.equal(w.core.activityCalls.filter((a) => a.conversation === r.handle).length, 0, 'no thread yet: nothing told, so nothing is lost');
  assert.equal(loadConv(w.env, r.handle).spawn.thread, 'th:abcdefghij');
  await tick(w.env, w.o);
  const sent = w.core.activityCalls.filter((a) => a.conversation === r.handle);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].cards.map((c) => [c.summary, c.state]), [['Ran the tests', 'running']]);
  assert.equal(sent[0].run, loadConv(w.env, r.handle).run);
});


test('a wake enables remote activity capture and posts live steps without a Comms thread', async () => {
  const w = world();
  const options = [];
  const start = w.runner.start.bind(w.runner);
  w.runner.start = (o) => { options.push(o); return start(o); };
  w.runner.activity = () => [{ id: 'wake1', at: 'x', tool: 'Read', summary: 'Read a file', state: 'done' }];
  const r = await deliver(w.env, w.msg('lane:watch', 'check the work', { venue: 'wake', kind: 'wake', from: { kind: 'schedule' } }), w.o);
  await tick(w.env, w.o);
  assert.equal(options[0].activity, true, 'the remote bodyhost must collect cards too');
  assert.equal(w.core.activityCalls[0].conversation, r.conversation);
  assert.deepEqual(w.core.activityCalls[0].cards.map((c) => c.summary), ['Read a file']);
});
