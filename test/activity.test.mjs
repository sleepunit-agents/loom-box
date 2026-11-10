// Activity cards (loom docs/specs/comms.md, section 3; criterion 16): a Comms thread's body's tool steps, from its
// harness's own record, by a fixed table. The fixtures are real records: a Claude Code session transcript's lines
// (their tool inputs and outputs replaced, their shape kept) and a real `codex exec --json` run's events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changed, claudeCards, claudeSummary, codexCards, shownPath } from '../src/activity.mjs';
import { ClaudeRunner, CodexRunner } from '../src/runners.mjs';
import { deliver, loadConv, saveConv, tick } from '../src/delivery.mjs';
import { here, world, cvOf } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';

const read = (f) => readFileSync(join(here, 'fixtures', f), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('a Claude transcript: tool_use makes a running card, its result done or failed; thinking makes none', () => {
  const cards = claudeCards(read('claude-transcript.jsonl'));
  assert.deepEqual(cards.map((c) => [c.tool, c.summary, c.state]), [
    ['Bash', 'Run the test suite', 'failed'],
    ['text', 'Thinking aloud: the secret plan is here.', 'done'],
    ['Read', 'Read delivery.ts', 'done'],
    ['Grep', 'Searched for "deliverAsOwner" in src', 'running'],
  ]);
  // Each carries its fixed label, made where it's made (t-2109): fixed words and a plain base name, never its words.
  assert.deepEqual(cards.map((c) => c.fixed), ['Ran a command', 'Wrote its words', 'Read delivery.ts', 'Searched files']);
  // Its own words between steps are a text card (t-2109; delivery shows them only for the owner alone); thinking never.
  assert.equal(cards[1].body, 'Thinking aloud: the secret plan is here.');
  const all = JSON.stringify(cards);
  for (const never of ['s3cr3t', 'private reasoning', '/home/art']) assert.ok(!all.includes(never), never);
  cards.splice(1, 1);
  // A label is never a command line (t-1944); the owner's Watching view gets the whole command, redacted, in its own
  // field (t-2109). Output and a read's contents never, anywhere.
  for (const c of cards) for (const never of ['npm test', 'OUTPUT-THAT-MUST-NOT-SHOW']) assert.ok(!c.summary.includes(never), never);
  assert.equal(cards[0].detail, 'export TOKEN=…; npm test');
  assert.deepEqual([cards[0].result, cards[0].body, cards[0].limit], ['failed', undefined, 120]);
  assert.ok(!all.includes('OUTPUT-THAT-MUST-NOT-SHOW'), 'a step\'s output is never kept or sent (t-2109)');
  assert.ok(!JSON.stringify(cards[1]).includes('OUTPUT-THAT-MUST-NOT-SHOW'), 'a file read never shows what it read');
  assert.equal(cards[1].detail, 'delivery.ts');
});

test('a Codex run: item.started makes a card, item.completed finishes it; failed stays failed; own words make text cards', () => {
  const all = codexCards(read('codex-events.jsonl'), 'b1:');
  assert.deepEqual(all.filter(c => c.tool === 'text').map(c => [c.id, c.fixed, c.body]), [['b1:item_0', 'Wrote its words', 'I’ll run the two commands in order.'], ['b1:item_3', 'Wrote its words', 'done']]);
  const cards = all.filter(c => c.tool !== 'text');
  assert.deepEqual(cards.map((c) => [c.id, c.tool, c.summary, c.state]), [
    ['b1:item_1', 'command_execution', 'Ran a command', 'done'], // echo says nothing of what it's for
    ['b1:item_2', 'command_execution', 'Ran ls — exit 2: no such file', 'failed'], // a raw command names no file
  ]);
  assert.ok(!cards.some((c) => c.summary.includes('cannot access')), 'never the output in a label');
  assert.deepEqual(cards.map((c) => c.fixed), ['Ran a command', 'Ran a command — exit 2: no such file']);
  assert.deepEqual(cards.map((c) => [c.detail, c.exit, c.result, c.body]), [
    ['echo hi', 0, '1 line of output', undefined],
    ['ls /nonexistent-dir', 2, 'exit 2', undefined],
  ]);
  assert.ok(!JSON.stringify(cards).includes('cannot access'), 'never the output (t-2109: on demand is its own task)');
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
  assert.equal(cr.activity({ id: 'abcd1234', slot: { harness: 'claude', session: 'sess-1234' } }).length, 4);
  const runs = join(dir, 'runs');
  mkdirSync(join(runs, 'k1'), { recursive: true });
  writeFileSync(join(runs, 'k1', 'events.jsonl'), readFileSync(join(here, 'fixtures', 'codex-events.jsonl')));
  const xr = new CodexRunner({ runsDir: runs });
  assert.deepEqual(xr.activity({ id: 'k1' }).map((c) => c.id), ['k1:item_0', 'k1:item_1', 'k1:item_2', 'k1:item_3']);
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
  w.runner.activity = () => [{ id: 'wake1', at: 'x', tool: 'Read', summary: 'Read a file', fixed: 'Read a file', state: 'done' }];
  const r = await deliver(w.env, w.msg('lane:watch', 'check the work', { venue: 'wake', kind: 'wake', from: { kind: 'schedule' } }), w.o);
  await tick(w.env, w.o);
  assert.equal(options[0].activity, true, 'the remote bodyhost must collect cards too');
  assert.equal(w.core.activityCalls[0].conversation, r.conversation);
  assert.deepEqual(w.core.activityCalls[0].cards.map((c) => c.summary), ['Read a file']);
});

test('the body\'s own words go only where it works for the owner alone; its sign of life goes with them; an older core gets plain cards (t-2109)', async () => {
  const w = world();
  w.core.commsAnswer = (b) => (b.op === 'spawn' ? { ok: true, id: 'th:abcdefghij' } : { ok: true });
  const cards = [{ id: 'w1', at: 'x', tool: 'text', summary: 'Found it.', state: 'done', body: 'Found it.' }, { id: 't1', at: 'x', tool: 'Bash', summary: 'Ran the tests', state: 'done', detail: 'npm test', body: 'ok', result: '1 line of output' }];
  w.runner.activity = () => cards;
  w.runner.signOfLife = () => ({ at: '2026-11-10T10:00:00.000Z', tokens: 4100 });
  const { spawnCall } = await import('../src/spawn.mjs');
  const r = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Run the tests' }, w.o);
  await tick(w.env, w.o); await tick(w.env, w.o);
  const [sent] = w.core.activityCalls.filter((a) => a.conversation === r.handle);
  assert.deepEqual(sent.cards.map((c) => c.tool), ['text', 'Bash'], 'a spawn acts for the owner alone: its words show');
  assert.deepEqual(sent.alive, { at: '2026-11-10T10:00:00.000Z', tokens: 4100 });
  // A bridge conversation with someone in it: its words never, its steps still.
  const b = world();
  b.runner.activity = () => cards;
  await deliver(b.env, b.msg('dm:U1', 'hi'), b.o);
  await tick(b.env, b.o);
  assert.ok(b.core.activityCalls.length >= 1);
  for (const call of b.core.activityCalls) assert.ok(!call.cards.some((c) => c.tool === 'text'), 'no words where someone else is');
  // A core from before t-2109 refuses the further parts: told the plain cards again, without them.
  const o = world();
  o.core.commsAnswer = (x) => (x.op === 'spawn' ? { ok: true, id: 'th:abcdefghij' } : { ok: true });
  o.runner.activity = () => cards;
  o.runner.signOfLife = () => ({ at: '2026-11-10T10:00:00.000Z' });
  o.core.activity = async (x) => { o.core.activityCalls.push(x); if (x.alive || x.cards.some((c) => Object.keys(c).some((k) => !['id', 'at', 'tool', 'summary', 'state'].includes(k)))) throw Object.assign(new Error('bad-input: card 0 has unknown keys'), { status: 400 }); return { ok: true }; };
  const r2 = await spawnCall(o.env, { kind: 'owner' }, { agent: 'art', brief: 'x' }, o.o);
  await tick(o.env, o.o); await tick(o.env, o.o);
  const calls = o.core.activityCalls.filter((a) => a.conversation === r2.handle);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].cards, [{ id: 't1', at: 'x', tool: 'Bash', summary: 'Ran the tests', state: 'done' }]);
  assert.equal(calls[1].alive, undefined);
});

test('whose words show: only a conversation for the owner alone, read from its principal now (t-2109)', async () => {
  const { wordsShown } = await import('../src/principal.mjs');
  const { mkdtempSync, writeFileSync: write } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  // A household with two owners of every agent.
  const home = mkdtempSync(join(tmpdir(), 'words-'));
  write(join(home, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }, { person: 'amelia', agents: '*' }] }));
  const env = { LOOM_HOME: home };
  const c = (actsFor) => ({ agent: 'art', conversation: 'cv-000000000001', actsFor });
  assert.equal(wordsShown(env, c({ owner: true, people: [], unknown: false, owners: ['jonathan'] })), true);
  assert.equal(wordsShown(env, c({ owner: true, people: [], unknown: false })), true, 'a wake the clock called the owner\'s');
  assert.equal(wordsShown(env, c({ owner: true, people: [], unknown: false, owners: ['jonathan', 'amelia'] })), false, 'two owners spoke: each other\'s words');
  assert.equal(wordsShown(env, c({ owner: true, people: [], unknown: true })), false, 'unknown');
  assert.equal(wordsShown(env, c({ owner: true, people: ['loren'], unknown: false })), false, 'a person in it');
  assert.equal(wordsShown(env, c({ owner: false, people: [], unknown: false })), false, 'not the owner');
  assert.equal(wordsShown(env, c({ owner: true, people: [], unknown: false, owners: ['someone-gone'] })), false, 'a former owner is a person now');
  assert.equal(wordsShown(env, c({ owner: true, people: [], unknown: false, owners: ['Not A Slug'] })), false, 'a word it can\'t read');
  assert.equal(wordsShown(env, { agent: 'art' }), false, 'no record');
});
test('an older core: after its first refusal, plain cards go straight to it; a 409 holds the thread; another 400 is only a warning (t-2109)', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const rich = (n) => ({ id: `t${n}`, at: 'x', tool: 'Edit', summary: `Step ${n}`, state: 'done', detail: 'a.ts', body: '+ok' });
  const run = async (answer) => {
    const o = world();
    o.core.commsAnswer = (x) => (x.op === 'spawn' ? { ok: true, id: 'th:abcdefghij' } : { ok: true });
    const cards = [rich(1)];
    let at = 0;
    o.runner.activity = () => cards;
    o.runner.signOfLife = () => ({ at: new Date(Date.UTC(2026, 10, 10, 10, 0, at)).toISOString() });
    o.core.activity = async (x) => { o.core.activityCalls.push(x); const e = answer(x); if (e) throw e; return { ok: true }; };
    const r = await spawnCall(o.env, { kind: 'owner' }, { agent: 'art', brief: 'x' }, o.o);
    await tick(o.env, o.o); await tick(o.env, o.o);
    cards.push(rich(2)); at += 30;
    await tick(o.env, o.o);
    at += 30;
    o.clock.advance(60_000);
    await tick(o.env, o.o);
    return o.core.activityCalls.filter((a) => a.conversation === r.handle);
  };
  const extra = (x) => !!x.alive || x.cards.some((c) => Object.keys(c).some((k) => !['id', 'at', 'tool', 'summary', 'state'].includes(k)));
  const old = await run((x) => (extra(x) ? Object.assign(new Error('bad-input: card 0 has unknown keys: body'), { status: 400 }) : null));
  // First batch: refused rich, then told plain. Second batch: plain at once, no second refusal; no sign of life.
  assert.deepEqual(old.map((x) => [x.cards.map((c) => c.id), extra(x)]), [[['t1'], true], [['t1'], false], [['t2'], false]]);
  const gone = await run(() => Object.assign(new Error('conflict: that conversation has no live thread'), { status: 409 }));
  assert.deepEqual(gone.map((x) => x.cards.map((c) => c.id)), [['t1']], 'after a 409 nothing more is tried, cards or a sign of life');
  const other = await run((x) => (x.cards.some((c) => c.id === 't1') ? Object.assign(new Error('bad-input: run is the body run'), { status: 400 }) : null));
  const t2 = other.find((x) => x.cards.some((c) => c.id === 't2'));
  assert.ok(t2 && t2.cards[0].body === '+ok', 'a 400 for another reason isn\'t taken for an older core: later cards go whole');
});

test('a sign of life alone goes at most every 20 seconds, and only when it moved (t-2109)', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const o = world();
  o.core.commsAnswer = (x) => (x.op === 'spawn' ? { ok: true, id: 'th:abcdefghij' } : { ok: true });
  let at = 0;
  o.runner.activity = () => [{ id: 't1', at: 'x', tool: 'Bash', summary: 'Step', state: 'running' }];
  o.runner.signOfLife = () => ({ at: new Date(Date.UTC(2026, 10, 10, 10, 0, at)).toISOString() });
  const r = await spawnCall(o.env, { kind: 'owner' }, { agent: 'art', brief: 'x' }, o.o);
  await tick(o.env, o.o); await tick(o.env, o.o);
  const alone = () => o.core.activityCalls.filter((a) => a.conversation === r.handle && !a.cards.length).length;
  assert.equal(alone(), 0, 'it went with the card');
  at += 5; o.clock.advance(5_000); await tick(o.env, o.o);
  assert.equal(alone(), 0, 'moved, but within 20 s');
  o.clock.advance(20_000); await tick(o.env, o.o);
  assert.equal(alone(), 1, 'moved, past 20 s');
  o.clock.advance(30_000); await tick(o.env, o.o);
  assert.equal(alone(), 1, 'past 20 s, but it didn\'t move');
});

test('where someone else is, or a former owner spoke, no words and no command, output or diff go: label, state and result only (t-2109)', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const o = world();
  o.core.commsAnswer = (x) => (x.op === 'spawn' ? { ok: true, id: 'th:abcdefghij' } : { ok: true });
  o.runner.activity = () => [{ id: 'w', at: 'x', tool: 'text', summary: 'Loren said hi', state: 'done', body: 'Loren said hi' },
    { id: 't1', at: 'x', tool: 'Bash', summary: 'Saved the note', fixed: 'Ran a command', state: 'done', detail: 'npm test', body: 'what Loren said', result: '1 line of output' },
    { id: 'p', at: 'x', tool: 'TodoWrite', summary: 'Plan (1/2): Reply to Loren about the rent', fixed: 'Plan (0/2)', state: 'done', items: [{ text: 'Reply to Loren about the rent', state: 'now' }, { text: 'x', state: 'todo' }] },
    { id: 'm', at: 'x', tool: 'mcp__loom__relay', summary: 'Messaged mark: "Loren wants the rent by Friday"', fixed: 'Messaged mark', state: 'done' },
    // A label the house made up, or none at all: never its words.
    { id: 'f', at: 'x', tool: 'Grep', summary: 'Searched for "Loren rent"', fixed: 'Searched for "Loren rent"', state: 'done' },
    { id: 'n', at: 'x', tool: 'WebSearch', summary: 'Searched the web for "Loren rent"', state: 'done' }];
  const r = await spawnCall(o.env, { kind: 'owner' }, { agent: 'art', brief: 'x' }, o.o);
  // Its stored actsFor still says the owner; its principal now holds a former owner, a person.
  const c = loadConv(o.env, r.handle);
  c.actsFor = { ...c.actsFor, owner: true, people: [], unknown: false, owners: ['someone-gone'] };
  saveConv(o.env, c);
  await tick(o.env, o.o); await tick(o.env, o.o);
  const sent = o.core.activityCalls.filter((a) => a.conversation === r.handle).flatMap((a) => a.cards);
  assert.deepEqual(sent.map((x) => [x.tool, x.summary, x.detail, x.body, x.items, x.result]), [
    ['Bash', 'Ran a command', undefined, undefined, undefined, '1 line of output'],
    ['TodoWrite', 'Plan (0/2)', undefined, undefined, undefined, undefined],
    ['mcp__loom__relay', 'Messaged mark', undefined, undefined, undefined, undefined],
    ['Grep', 'Did a step', undefined, undefined, undefined, undefined],
    ['WebSearch', 'Did a step', undefined, undefined, undefined, undefined]]);
  assert.ok(sent.every((x) => !('fixed' in x)), 'core never gets a field it doesn\'t know');
  assert.ok(!JSON.stringify(sent).includes('Loren'));
  // A bridge chat with a person: the same.
  const b = world();
  b.runner.activity = o.runner.activity;
  await deliver(b.env, b.msg('dm:U1', 'hi'), b.o);
  await tick(b.env, b.o);
  for (const x of b.core.activityCalls.flatMap((a) => a.cards)) { assert.equal(x.detail, undefined); assert.equal(x.body, undefined); assert.equal(x.items, undefined); }
  assert.ok(!JSON.stringify(b.core.activityCalls).includes('Loren'));
});

test('every card goes through the one gate where the owner is alone too: no shell output, no field core doesn\'t know (t-2109)', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const o = world();
  o.core.commsAnswer = (x) => (x.op === 'spawn' ? { ok: true, id: 'th:abcdefghij' } : { ok: true });
  o.runner.activity = () => [{ id: 't1', at: 'x', tool: 'Bash', summary: 'Ran npm test', fixed: 'Ran a command', state: 'done', detail: 'npm test', body: 'OUTPUT', result: 'Loren says hi', bogus: 1 }];
  const r = await spawnCall(o.env, { kind: 'owner' }, { agent: 'art', brief: 'x' }, o.o);
  await tick(o.env, o.o); await tick(o.env, o.o);
  const [card] = o.core.activityCalls.filter((a) => a.conversation === r.handle).flatMap((a) => a.cards);
  assert.deepEqual(card, { id: 't1', at: 'x', tool: 'Bash', summary: 'Ran npm test', state: 'done', detail: 'npm test' });
});

test('told marks are kept for every card still read, so a long run\'s steps aren\'t told again (t-2109)', () => {
  const cards = Array.from({ length: 600 }, (_, i) => ({ id: `c${i}`, at: 'x', tool: 'Bash', summary: 's', state: 'done' }));
  let sent = {}, told = 0;
  for (let k = 0; k < 20; k++) { const x = changed(cards, sent); told += x.out.length; sent = x.next; }
  assert.equal(told, 600, 'each told once, 50 a pass');
  assert.equal(Object.keys(sent).length, 600);
  let again = 0;
  for (let k = 0; k < 3; k++) { const x = changed(cards, sent); again += x.out.length; sent = x.next; }
  assert.equal(again, 0, 'and never again');
  // Ids no longer read go first once it's past 400.
  const later = changed(cards.slice(300), sent);
  assert.equal(Object.keys(later.next).length, 400);
});

test('a 409\'s hold is kept on the record, so another delivery process keeps it (t-2109)', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const o = world();
  o.core.commsAnswer = (x) => (x.op === 'spawn' ? { ok: true, id: 'th:abcdefghij' } : { ok: true });
  o.runner.activity = () => [{ id: 't1', at: 'x', tool: 'Bash', summary: 's', state: 'done' }];
  o.core.activity = async (x) => { o.core.activityCalls.push(x); throw Object.assign(new Error('core refused comms/activity: conflict: that conversation has no live thread'), { status: 409 }); };
  const r = await spawnCall(o.env, { kind: 'owner' }, { agent: 'art', brief: 'x' }, o.o);
  await tick(o.env, o.o); await tick(o.env, o.o);
  assert.ok(Number.isFinite(loadConv(o.env, r.handle).activityHeld?.noThread));
});

test('a sign of life a core refuses isn\'t posted again until it moves; an older core\'s "cards is a list" refusal is one too; a pending reset shows no words (t-2109)', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const mk = async (answer, cards = [{ id: 't1', at: 'x', tool: 'Bash', summary: 's', state: 'done' }]) => {
    const o = world();
    o.core.commsAnswer = (x) => (x.op === 'spawn' ? { ok: true, id: 'th:abcdefghij' } : { ok: true });
    o.runner.activity = () => cards;
    o.runner.signOfLife = () => ({ at: '2026-11-10T10:00:00.000Z' });
    o.core.activity = async (x) => { o.core.activityCalls.push(x); const e = answer(x); if (e) throw e; return { ok: true }; };
    const r = await spawnCall(o.env, { kind: 'owner' }, { agent: 'art', brief: 'x' }, o.o);
    return { o, r, calls: () => o.core.activityCalls.filter((a) => a.conversation === r.handle) };
  };
  // A sign of life alone, refused for another reason: told once, not again while it doesn't move.
  const a = await mk((x) => (!x.cards.length ? Object.assign(new Error('core refused comms/activity: bad-input: run is the body run'), { status: 400 }) : null));
  for (let k = 0; k < 4; k++) { await tick(a.o.env, a.o.o); a.o.clock.advance(30_000); }
  assert.ok(a.calls().filter((x) => !x.cards.length).length <= 1);
  // An older core's refusal of a sign of life alone: held as an older core (no more of it).
  const b = await mk((x) => (!x.cards.length ? Object.assign(new Error('core refused comms/activity: bad-input: cards is a list of 1-50'), { status: 400 }) : x.alive ? Object.assign(new Error('core refused comms/activity: bad-input: card 0 has unknown keys: x'), { status: 400 }) : null), []);
  for (let k = 0; k < 4; k++) { await tick(b.o.env, b.o.o); b.o.clock.advance(30_000); }
  assert.equal(b.calls().filter((x) => !x.cards.length).length, 1);
  assert.ok(Number.isFinite(loadConv(b.o.env, b.r.handle).activityHeld?.oldCore));
  // A reset pending: its words don't show, though the owner spoke since.
  const c = await mk(() => null, [{ id: 'w', at: 'x', tool: 'text', summary: 'Loren said hi', state: 'done', body: 'Loren said hi' }, { id: 't1', at: 'x', tool: 'Bash', summary: 's', state: 'done', detail: 'npm test' }]);
  const rec = loadConv(c.o.env, c.r.handle); rec.resetPending = true; saveConv(c.o.env, rec);
  await tick(c.o.env, c.o.o); await tick(c.o.env, c.o.o);
  const cs = c.calls().flatMap((x) => x.cards);
  assert.deepEqual(cs.map((x) => [x.tool, x.detail]), [['Bash', undefined]]);
});

test('large cards go in posts of at most 512 KB; a 413 is an older core\'s cap: plain cards then (t-2109)', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const o = world();
  o.core.commsAnswer = (x) => (x.op === 'spawn' ? { ok: true, id: 'th:abcdefghij' } : { ok: true });
  const big = (n) => ({ id: `e${n}`, at: 'x', tool: 'Edit', summary: `Edited f${n}.ts`, fixed: `Edited f${n}.ts`, state: 'done', detail: `f${n}.ts`, body: `+${'界'.repeat(1900)}\n`.repeat(15) });
  o.runner.activity = () => Array.from({ length: 30 }, (_, i) => big(i));
  const r = await spawnCall(o.env, { kind: 'owner' }, { agent: 'art', brief: 'x' }, o.o);
  await tick(o.env, o.o); await tick(o.env, o.o);
  const calls = o.core.activityCalls.filter((a) => a.conversation === r.handle);
  assert.ok(calls.length >= 2, 'split');
  assert.ok(calls.every((c) => Buffer.byteLength(JSON.stringify(c.cards)) <= 512 * 1024 + 100), 'in bytes as sent');
  assert.equal(calls.flatMap((c) => c.cards).length, 30);
  const q = world();
  q.core.commsAnswer = o.core.commsAnswer;
  q.runner.activity = () => [big(1)];
  q.core.activity = async (x) => { q.core.activityCalls.push(x); if (JSON.stringify(x).length > 20_000) throw Object.assign(new Error('core refused comms/activity: too large'), { status: 413 }); return { ok: true }; };
  const r2 = await spawnCall(q.env, { kind: 'owner' }, { agent: 'art', brief: 'x' }, q.o);
  await tick(q.env, q.o); await tick(q.env, q.o);
  const qc = q.core.activityCalls.filter((a) => a.conversation === r2.handle);
  assert.deepEqual(qc.at(-1).cards, [{ id: 'e1', at: 'x', tool: 'Edit', summary: 'Edited f1.ts', state: 'done' }]);
});

test('cards a 409 answered, and those made while the thread was held as gone, wait untold and go once the hold is over (t-2109)', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const o = world();
  o.core.commsAnswer = (x) => (x.op === 'spawn' ? { ok: true, id: 'th:abcdefghij' } : { ok: true });
  const cards = [{ id: 't1', at: 'x', tool: 'Bash', summary: 's', state: 'done' }];
  o.runner.activity = () => cards;
  let gone = true;
  o.core.activity = async (x) => { o.core.activityCalls.push(x); if (gone) throw Object.assign(new Error('core refused comms/activity: conflict: that conversation has no live thread'), { status: 409 }); return { ok: true }; };
  const r = await spawnCall(o.env, { kind: 'owner' }, { agent: 'art', brief: 'x' }, o.o);
  await tick(o.env, o.o); await tick(o.env, o.o);
  cards.push({ id: 't2', at: 'x', tool: 'Bash', summary: 's2', state: 'done' });
  await tick(o.env, o.o);
  gone = false;
  o.clock.advance(11 * 60_000);
  await tick(o.env, o.o);
  const sent = o.core.activityCalls.filter((a) => a.conversation === r.handle);
  // A 409 refuses no card: those it answered and those made during the hold all go once it's over.
  assert.deepEqual(sent.at(-1).cards.map((c) => c.id), ['t1', 't2'], 'every card the 409 left untold is told after it');
});

test('a job\'s own house is trusted for a step\'s command line and its own words only where the conversation is the owner\'s alone; else fixed labels only (t-2109, coordinator 2026-11-10)', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const { bodySync, HouseRunner } = await import('../src/houserunner.mjs');
  const { testSealer } = await import('./delivery-world.mjs');
  const { createHash } = await import('node:crypto');
  // Whatever a house says in a command line or its words passes on shape alone: a body could post it as a message too.
  const cards = [{ id: 'c1', at: '2026-11-10T10:00:00.000Z', tool: 'Bash', summary: 'Ran a command', fixed: 'Ran a command', state: 'done', detail: 'echo HOUSE-COMMAND-WORDS' },
    { id: 'w1', at: '2026-11-10T10:00:01.000Z', tool: 'text', summary: 'HOUSE-OWN-WORDS', fixed: 'Wrote its words', state: 'done', body: 'HOUSE-OWN-WORDS' }];
  const run = async (person) => {
    const o = world();
    o.core.commsAnswer = (x) => (x.op === 'spawn' ? { ok: true, id: 'th:abcdefghij' } : { ok: true });
    const hosts = join(o.env.LOOM_BOX_DATA, 'delivery', 'hosts');
    mkdirSync(hosts, { recursive: true });
    writeFileSync(join(hosts, 'art.json'), JSON.stringify({ agent: 'art', house: 'h-1', hostHash: createHash('sha256').update('the-host-key').digest('hex'), req: {}, stop: {}, inbox: {} }));
    bodySync(o.env, { kind: 'agent', agent: 'art', house: 'h-1' }, { hostKey: 'the-host-key', report: { bodies: { b0000001: { harness: 'claude', status: 'working', cards }, }, done: {} } }, { sealer: testSealer });
    const hr = new HouseRunner(o.env, 'claude', { sealer: testSealer });
    o.runner.activity = () => hr.activity({ id: 'h-1-b0000001', house: 'h-1', agent: 'art' });
    const r = await spawnCall(o.env, { kind: 'owner' }, { agent: 'art', brief: 'x' }, o.o);
    if (person) { const c = loadConv(o.env, r.handle); c.actsFor = { ...c.actsFor, owner: true, people: ['loren'], unknown: false }; saveConv(o.env, c); }
    await tick(o.env, o.o); await tick(o.env, o.o);
    return o.core.activityCalls.filter((a) => a.conversation === r.handle).flatMap((a) => a.cards);
  };
  const alone = await run(false);
  assert.deepEqual(alone.map((x) => [x.tool, x.summary, x.detail, x.body]), [
    ['Bash', 'Ran a command', 'echo HOUSE-COMMAND-WORDS', undefined],
    ['text', 'HOUSE-OWN-WORDS', undefined, 'HOUSE-OWN-WORDS']]);
  const withPerson = await run(true);
  assert.deepEqual(withPerson.map((x) => [x.tool, x.summary, x.detail, x.body]), [['Bash', 'Ran a command', undefined, undefined]]);
  assert.ok(!JSON.stringify(withPerson).includes('HOUSE-'), 'where someone else is: fixed labels only');
});

test('where someone else is, a parent is only one of the cards\' own ids (t-2109)', async () => {
  const { shownCards } = await import('../src/delivery.mjs');
  const w = world();
  const cards = [{ id: 'a', at: 'x', tool: 'Agent', summary: 's', fixed: 'Ran a command', state: 'done' },
    { id: 'b', at: 'x', tool: 'Bash', summary: 's', state: 'done', parent: 'a' },
    { id: 'c', at: 'x', tool: 'Bash', summary: 's', state: 'done', parent: 'Loren-wants-rent' }];
  const shown = shownCards(w.env, { agent: 'art' }, cards);
  assert.deepEqual(shown.map((x) => x.parent), [undefined, 'a', undefined]);
});
