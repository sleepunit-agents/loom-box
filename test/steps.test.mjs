// Work shown in full for the owner's Watching view (t-2109; Jonathan, 2026-11-10): a step's whole command, its whole
// output or diff (each line redacted, ANSI colours kept, at most MAX_BODY), a result line in fixed phrases, the plan as
// a checklist, the body's own words between steps, and a helper's steps under it. A read never shows what it read.
// Built to the shapes Claude Code writes (`toolUseResult`, subagents/) and codex exec --json writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCards, claudeTokens, codexCards, commandLine, shownText, testsLine, changed, stepParts, MAX_BODY } from '../src/activity.mjs';
import { cleanCards } from '../src/houserunner.mjs';
import { ClaudeRunner } from '../src/runners.mjs';
import { scratch } from './scratch.mjs';

const j = (...p) => p.join('');
const GH = j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
const leak = (s) => { for (let i = 0; i + 8 <= GH.length; i++) if (String(s).includes(GH.slice(i, i + 8))) return true; return false; };
const use = (id, name, input, at = '2026-11-10T10:00:00.000Z') => ({ type: 'assistant', timestamp: at, message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, content, toolUseResult, is_error = false) => ({ type: 'user', timestamp: '2026-11-10T10:00:05.000Z', toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });

test('a long output keeps its head and tail and says how many lines it left out', () => {
  const t = shownText(Array.from({ length: 20000 }, (_, i) => `row ${i}`).join('\n'));
  assert.ok(t.length <= MAX_BODY);
  assert.ok(t.startsWith('row 0\n') && t.endsWith('row 19999'));
  assert.match(t, /… \d+ lines not kept …/);
});

test('a shell step: its whole command (redacted), its result and exit code, when it ended; its output never, from here or a house', () => {
  const out = `\x1b[32mline 1\x1b[0m\nOUTPUT-NEVER-KEPT ${GH}`;
  const [s] = claudeCards([use('u1', 'Bash', { command: `GH_TOKEN=${GH} gh pr list\necho second`, description: 'List PRs', timeout: 600000 }), res('u1', out, { stdout: out, stderr: '' })]);
  assert.deepEqual([s.summary, s.detail, s.limit, s.result, s.body, s.end], ['List PRs', 'GH_TOKEN=… gh pr list\necho second', 600, '2 lines of output', undefined, '2026-11-10T10:00:05.000Z']);
  assert.ok(!JSON.stringify(s).includes('OUTPUT-NEVER-KEPT') && !leak(JSON.stringify(s)));
  const [x] = codexCards([{ type: 'item.completed', item: { id: 'i', type: 'command_execution', command: "/usr/bin/bash -lc 'git status'", aggregated_output: 'OUTPUT-NEVER-KEPT\n', exit_code: 0, status: 'completed' } }], 'b:');
  assert.deepEqual([x.detail, x.body], ['git status', undefined]);
  assert.ok(!JSON.stringify(x).includes('OUTPUT-NEVER-KEPT'));
  // A house that sends a shell step's output: dropped at the boundary.
  for (const tool of ['Bash', 'command_execution']) assert.equal(cleanCards([{ id: 'c', at: 'x', tool, summary: 's', state: 'done', detail: 'npm test', body: 'OUTPUT' }])[0].body, undefined);
});

test('shown text (a diff, the body\'s words): a token, a key block and a token split by a colour code go; other controls go; private paths are named', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2EAAAADAQABAAABAQC\n-----END OPENSSH PRIVATE KEY-----';
  const split = `${GH.slice(0, 10)}\x1b[1m${GH.slice(10)}`;
  const t = shownText(`a ${GH}\n${pem}\n${split}\nbell\x07 and \x1b]0;title\x07\ncat /home/art/.config/gh/hosts.yml`);
  assert.ok(!leak(t), t);
  assert.ok(!t.includes('AAAAB3NzaC1yc2E'), 'key block gone');
  assert.ok(!/[\x07]/.test(t) && !t.includes(']0;'), 'only colour codes survive');
  assert.ok(t.includes('cat a private file'));
});

test('a failed shell step: its exit code and a test run\'s counts', () => {
  const [c] = claudeCards([use('u2', 'Bash', { command: 'npm test' }), res('u2', 'Exit code 1\nℹ pass 12\nℹ fail 1', undefined, true)]);
  assert.deepEqual([c.state, c.exit, c.result], ['failed', 1, 'exit 1: 12 passed, 1 failed']);
});

test('a read says how many lines, never what; an edit shows its diff and counts; a write its lines', () => {
  const cards = claudeCards([
    use('r', 'Read', { file_path: '/home/art/Code/x/src/a.ts' }), res('r', 'SECRET FILE BODY', { type: 'text', file: { filePath: 'x', content: 'SECRET FILE BODY', numLines: 120 } }),
    use('e', 'Edit', { file_path: '/home/art/Code/x/src/a.ts', old_string: 'old', new_string: 'new' }),
    res('e', 'ok', { structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 4, lines: [' a', '-old', '+new', `+token ${GH}`, '+again'] }] }),
    use('w', 'Write', { file_path: '/home/art/Code/x/b.md', content: 'x\ny' }), res('w', 'ok', { type: 'create', content: 'x\ny' }),
  ]);
  assert.deepEqual(cards.map((c) => [c.detail, c.result]), [['a.ts', 'Read 120 lines'], ['a.ts', '3 additions, 1 removal'], ['b.md', 'Wrote 2 lines']]);
  assert.equal(cards[0].body, undefined);
  assert.ok(!JSON.stringify(cards).includes('SECRET FILE BODY'));
  assert.ok(cards[1].body.startsWith('@@ -3,2 +3,4 @@\n a\n-old\n+new\n+token '), cards[1].body);
  assert.ok(!leak(cards[1].body));
  assert.equal(cards[2].body, '+x\n+y');
});

test('the body\'s own words between steps are a text card; thinking never', () => {
  const cards = claudeCards([{ type: 'assistant', timestamp: '2026-11-10T10:00:00.000Z', message: { id: 'msg_a', content: [
    { type: 'thinking', thinking: 'PRIVATE REASONING' }, { type: 'text', text: `Found it.\nThe id check drops them. ${GH}` }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/a.ts' } }] } }]);
  assert.deepEqual(cards.map((c) => [c.tool, c.summary]), [['text', 'Found it.'], ['Read', 'Read a.ts']]);
  assert.ok(cards[0].body.startsWith('Found it.\nThe id check drops them. '));
  assert.ok(!JSON.stringify(cards).includes('PRIVATE REASONING') && !leak(JSON.stringify(cards)));
});

test('the plan is a checklist: each item done, now or todo', () => {
  const [c] = claudeCards([use('t', 'TodoWrite', { todos: [{ content: 'Find it', status: 'completed' }, { content: 'Fix it', activeForm: 'Fixing it', status: 'in_progress' }, { content: 'Ship it', status: 'pending' }] })]);
  assert.equal(c.summary, 'Plan (1/3): Fixing it');
  assert.deepEqual(c.items, [{ text: 'Find it', state: 'done' }, { text: 'Fixing it', state: 'now' }, { text: 'Ship it', state: 'todo' }]);
  const [x] = codexCards([{ type: 'item.updated', item: { id: 'p', type: 'todo_list', items: [{ text: 'A', completed: true }, { text: 'B', completed: false }] } }], 'b:');
  assert.deepEqual(x.items, [{ text: 'A', state: 'done' }, { text: 'B', state: 'now' }]);
});

test('a helper\'s steps nest under the step that started it (Claude Code\'s subagents/ beside the session)', () => {
  const root = scratch('steps-helpers');
  const proj = join(root, 'projects', '-x');
  const session = '11111111-2222-3333-4444-555555555555';
  mkdirSync(join(proj, session, 'subagents'), { recursive: true });
  const l = (o) => JSON.stringify(o);
  writeFileSync(join(proj, `${session}.jsonl`), [l(use('toolu_A', 'Agent', { description: 'Look around' })), l(res('toolu_A', 'done', { totalToolUseCount: 1 }))].join('\n'));
  writeFileSync(join(proj, session, 'subagents', 'agent-abc123.meta.json'), l({ toolUseId: 'toolu_A' }));
  writeFileSync(join(proj, session, 'subagents', 'agent-abc123.jsonl'), [l(use('toolu_B', 'Bash', { command: 'ls' })), l(res('toolu_B', 'a', { stdout: 'a', stderr: '' }))].join('\n'));
  // A helper whose step isn't in what was read stands on its own, never dropped.
  writeFileSync(join(proj, session, 'subagents', 'agent-zzz.meta.json'), l({ toolUseId: 'toolu_OTHER' }));
  writeFileSync(join(proj, session, 'subagents', 'agent-zzz.jsonl'), l(use('toolu_C', 'Bash', { command: 'pwd' }, '2026-11-10T10:00:09.000Z')));
  const r = new ClaudeRunner({ projectsDir: join(root, 'projects'), jobsDir: join(root, 'jobs') });
  const cards = r.activity({ id: 'b', slot: { harness: 'claude', session } });
  assert.deepEqual(cards.map((c) => [c.id, c.tool, c.result, c.parent]), [['toolu_A', 'Agent', '1 tool use', undefined], ['abc123:toolu_B', 'Bash', '1 line of output', 'toolu_A'], ['zzz:toolu_C', 'Bash', undefined, undefined]]);
});

test('a sign of life: when its transcript last moved, and its tokens, each message once at its largest, read as the file grows', () => {
  const root = scratch('steps-sign');
  const proj = join(root, 'projects', '-x');
  const session = '11111111-2222-3333-4444-666666666666';
  mkdirSync(proj, { recursive: true });
  const f = join(proj, `${session}.jsonl`);
  const a = (id, n) => JSON.stringify({ type: 'assistant', message: { id, usage: { output_tokens: n }, content: [] } });
  writeFileSync(f, [a('m1', 10), a('m1', 40), a('m1', 3), a('m2', 5), JSON.stringify({ type: 'user', message: { content: [] } })].join('\n') + '\n');
  const r = new ClaudeRunner({ projectsDir: join(root, 'projects'), jobsDir: join(root, 'jobs') });
  const body = { id: 'b', slot: { harness: 'claude', session } };
  const one = r.signOfLife(body);
  assert.equal(one.tokens, 45, 'm1 streamed twice counts once, at 40');
  assert.ok(Date.parse(one.at) > 0);
  // It grows, with a line cut in two across writes: only the new bytes are read, and the cut line is read whole.
  const next = a('m3', 7);
  appendFileSync(f, next.slice(0, 20));
  assert.equal(r.signOfLife(body).tokens, 45);
  appendFileSync(f, `${next.slice(20)}\n${a('m2', 9)}\n`);
  assert.equal(r.signOfLife(body).tokens, 56, '40 + 9 + 7');
  // A body host makes a runner each beat: a new one carries on from where the last read stopped.
  appendFileSync(f, `${a('m4', 4)}\n`);
  assert.equal(new ClaudeRunner({ projectsDir: join(root, 'projects'), jobsDir: join(root, 'jobs') }).signOfLife(body).tokens, 60);
  assert.equal(claudeTokens([]), null);
});

test('a house\'s parts pass the same gate, and a parent id is renamed as its card\'s id is', () => {
  const card = { id: 'abc:toolu_01RkDcxWJbXrN5EuYQ8sWmTe', at: 'x', tool: 'Bash', summary: 'Ran ls', state: 'done', parent: 'toolu_01RkDcxWJbXrN5EuYQ8sWmTa', body: `x ${GH}\ny`, detail: `ls ${GH}`, result: 'exit 1', exit: 1, end: '2026-11-10T10:00:05.000Z', bogus: 'x', items: [{ text: 'a', state: 'weird' }] };
  const [parent] = cleanCards([{ ...card, id: card.parent, parent: undefined }]);
  const [c] = cleanCards([card]);
  assert.equal(c.parent, parent.id);
  assert.ok(!leak(JSON.stringify(c)));
  assert.equal(c.bogus, undefined);
  assert.deepEqual(c.items, [{ text: 'a', state: 'todo' }]);
  assert.deepEqual(stepParts({ exit: 1.5, limit: 0, end: 'nope', body: '' }), {});
});

test('a Codex command is unwrapped from its shell', () => {
  const [c] = codexCards([{ type: 'item.completed', item: { id: 'i', type: 'command_execution', command: "/usr/bin/bash -lc 'git status'", aggregated_output: 'clean\n', exit_code: 0, status: 'completed' } }], 'b:');
  assert.deepEqual([c.detail, c.body], ['git status', undefined]);
  assert.equal(commandLine("cat > f <<'EOF'\nbody\nEOF"), "cat > f <<'EOF'\nbody\nEOF");
});

test('tests counts from node, jest, vitest and pytest', () => {
  assert.equal(testsLine('ℹ tests 3\nℹ pass 3\nℹ fail 0'), '3 tests passed');
  assert.equal(testsLine('Tests:       1 failed, 12 passed, 13 total'), '12 passed, 1 failed');
  assert.equal(testsLine('      Tests  2 failed | 40 passed (42)'), '40 passed, 2 failed');
  assert.equal(testsLine('==== 5 passed, 1 failed in 0.12s ===='), '5 passed, 1 failed');
  assert.equal(testsLine('nothing here'), null);
});

test('any part that moves is sent again: its label, fixed label, target, result, body, exit, end, plan items, parent', () => {
  const base = { id: 'x', tool: 'Bash', summary: 's', fixed: 'Ran a command', state: 'done', at: 'x', detail: 'd', result: 'no output', body: 'a', exit: 0, end: '2026-11-10T10:00:00.000Z', items: [{ text: 'a', state: 'now' }], parent: 'p' };
  const a = changed([base], {});
  for (const [k, v] of Object.entries({ summary: 's2', fixed: 'Ran a command — exit 1', detail: 'd2', result: '1 line of output', body: 'b', exit: 1, end: '2026-11-10T10:00:01.000Z', items: [{ text: 'a', state: 'done' }], parent: 'q' })) {
    assert.equal(changed([{ ...base, [k]: v }], a.next).out.length, 1, k);
  }
  assert.equal(changed([base], a.next).out.length, 0);
});

test('a private file\'s contents never show: an edit of .env, a write of a key, loom\'s stores show counts only', () => {
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-A=PRIVATEVALUE1', '+A=PRIVATEVALUE2'] }];
  const cards = claudeCards([
    use('e1', 'Edit', { file_path: '/home/art/Code/x/.env' }), res('e1', 'ok', { structuredPatch: patch }),
    use('e2', 'MultiEdit', { file_path: '/home/art/.ssh/id_ed25519' }), res('e2', 'ok', { structuredPatch: patch }),
    use('w1', 'Write', { file_path: '/home/art/.config/loom/secrets.json' }), res('w1', 'ok', { type: 'create', content: 'PRIVATEVALUE3' }),
    use('w2', 'Write', { file_path: '/home/art/Code/x/deploy.key' }), res('w2', 'ok', { type: 'update', structuredPatch: patch }),
    use('w3', 'Write', {}), res('w3', 'ok', { type: 'create', content: 'PRIVATEVALUE4' }),
  ]);
  assert.equal(cards.length, 5);
  for (const c of cards) assert.equal(c.body, undefined, c.id);
  assert.ok(!JSON.stringify(cards).includes('PRIVATEVALUE'));
  assert.deepEqual(cards.map((c) => c.result), ['1 addition, 1 removal', '1 addition, 1 removal', 'Wrote 1 line', '1 addition, 1 removal', 'Wrote 1 line']);
});

test('a token split by a backspace, a carriage return or a lone escape is still caught: controls go before redaction, nothing after', () => {
  for (const sep of ['\b', '\r', '\x1b', '\x1b[1m', '\x00', '​']) {
    const t = shownText(`x ${GH.slice(0, 12)}${sep}${GH.slice(12)} y`);
    assert.ok(!leak(t), JSON.stringify([sep, t]));
  }
  // A colour around a clean word stays; around a token, the token goes and so do the colours.
  assert.equal(shownText('\x1b[31merror\x1b[0m: bad'), '\x1b[31merror\x1b[0m: bad');
  assert.ok(!shownText(`\x1b[31m${GH}\x1b[0m`).includes('\x1b'));
});

test('a line or paragraph separator, a lone surrogate or a private-use character inside a token can\'t save it', () => {
  for (const sep of ['\u2028', '\u2029', '\ud800', '\ue000', '\u{10ffff}']) {
    const t = shownText(`x ${GH.slice(0, 12)}${sep}${GH.slice(12)} y`);
    assert.ok(!leak(t), JSON.stringify([sep, t]));
  }
  // A long line is cut at a word before redaction and says so.
  assert.match(shownText(`${'word '.repeat(600)}end`), /… \(line cut\)$/);
});

test('a file whose shown name isn\'t plain (a token in its path) shows no diff; a diff\'s +NAME=value is redacted', () => {
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-A=1', `+API_KEY=${GH}`, '+SECRET_PASSWORD=hunter2hunter2'] }];
  const [odd, plain] = claudeCards([
    use('g1', 'Edit', { file_path: `/home/art/Code/${GH}/notes.md` }), res('g1', 'ok', { structuredPatch: patch }),
    use('g2', 'Edit', { file_path: '/home/art/Code/x/config.ts' }), res('g2', 'ok', { structuredPatch: patch }),
  ]);
  assert.equal(odd.body, undefined);
  assert.ok(plain.body && !leak(plain.body) && !plain.body.includes('hunter2hunter2'), plain.body);
});

test('a house\'s body passes only where one is made here: never on a read, a private file\'s edit, or an unplain target', () => {
  const base = { id: 'c', at: 'x', summary: 's', state: 'done' };
  const keep = (c) => cleanCards([{ ...base, ...c }])[0]?.body;
  assert.equal(keep({ tool: 'Read', detail: 'a.ts', body: 'FILE CONTENTS' }), undefined);
  assert.equal(keep({ tool: 'Edit', detail: 'a private file', body: '+A=PRIVATEVALUE2' }), undefined);
  assert.equal(keep({ tool: 'Edit', body: '+x' }), undefined, 'no target');
  assert.equal(keep({ tool: 'Edit', detail: '.env', body: '+x' }), undefined);
  assert.equal(keep({ tool: 'Bash', detail: 'cat ~/.ssh/id_ed25519', body: 'KEY' }), undefined);
  assert.equal(keep({ tool: 'mcp__loom__recall', detail: 'x', body: 'MEMORY' }), undefined);
  assert.equal(keep({ tool: 'Edit', detail: 'a.ts', body: '+x' }), '+x');
  assert.equal(keep({ tool: 'Bash', detail: 'npm test', body: 'ok' }), undefined, 'a shell step\'s output never');
});


test('terminal codes go whole, whatever their form, so none can hide a token: charset, private CSI, long colour, long OSC, short escapes', () => {
  for (const sep of ['\x1b(B', '\x1b[>4;2m', '\x1b[0;1;38;2;255;255;255;48;2;128;128;128m', `\x1b]8;;${'x'.repeat(2500)}\x07`, '\x1b7', '\x1b=', '\x1b[2K', '\x1b[?25l']) {
    const t = shownText(`x ${GH.slice(0, 12)}${sep}${GH.slice(12)} y`);
    assert.ok(!leak(t) && !t.includes('\x1b'), JSON.stringify([sep.slice(0, 12), t]));
  }
  assert.equal(shownText('\x1b[1;32mok\x1b[0m'), '\x1b[1;32mok\x1b[0m', 'a short colour stays');
});

test('a house\'s result line is one of the fixed phrases made here, never its prose', () => {
  const r = (result) => stepParts({ result }).result;
  for (const ok of ['exit 1: 11 passed, 1 failed', 'failed', '3 tests passed', '12 lines of output', 'no output', 'Read 120 lines', '2 additions, 1 removal', 'Wrote 2 lines', 'Found 3 files', '7 tool uses', '1 file changed']) assert.equal(r(ok), ok);
  for (const bad of ['Loren asked about the party', 'exit 1: see you at 5', `exit 1: ${GH}`, 'Read the notes']) assert.equal(r(bad), undefined, bad);
});

test('shown text keeps to its bounds: a command to MAX_DETAIL, the body\'s words to MAX_TEXT', async () => {
  const { MAX_DETAIL, MAX_TEXT } = await import('../src/activity.mjs');
  const cmd = Array.from({ length: 2000 }, (_, i) => `echo ${i}`).join('\n');
  const [c] = claudeCards([use('d', 'Bash', { command: cmd })]);
  assert.ok(c.detail.length <= MAX_DETAIL && c.detail.includes('lines not kept'));
  const words = Array.from({ length: 4000 }, (_, i) => `word ${i}`).join('\n');
  const [t] = claudeCards([{ type: 'assistant', timestamp: '2026-11-10T10:00:00.000Z', message: { id: 'm', content: [{ type: 'text', text: words }] } }]);
  assert.ok(t.body.length <= MAX_TEXT);
  assert.equal(stepParts({ tool: 'text', body: words }).body.length <= MAX_TEXT, true);
  assert.equal(stepParts({ tool: 'Bash', detail: cmd }).detail.length <= MAX_DETAIL, true);
});

test('a sign of life is when the record last moved: Claude\'s transcript, Codex\'s events; a house\'s report of it is checked', async () => {
  const { statSync, utimesSync } = await import('node:fs');
  const { CodexRunner } = await import('../src/runners.mjs');
  const { cleanReport } = await import('../src/houserunner.mjs');
  const root = scratch('steps-at');
  const proj = join(root, 'projects', '-x');
  const session = '11111111-2222-3333-4444-777777777777';
  mkdirSync(proj, { recursive: true });
  const f = join(proj, `${session}.jsonl`);
  writeFileSync(f, '{}\n');
  const when = new Date('2026-11-10T08:00:00.000Z');
  utimesSync(f, when, when);
  const r = new ClaudeRunner({ projectsDir: join(root, 'projects'), jobsDir: join(root, 'jobs') });
  assert.equal(r.signOfLife({ id: 'b', slot: { harness: 'claude', session } }).at, when.toISOString());
  mkdirSync(join(root, 'runs', 'k1'), { recursive: true });
  writeFileSync(join(root, 'runs', 'k1', 'events.jsonl'), '{}\n');
  utimesSync(join(root, 'runs', 'k1', 'events.jsonl'), when, when);
  assert.deepEqual(new CodexRunner({ runsDir: join(root, 'runs') }).signOfLife({ id: 'k1' }), { at: when.toISOString() });
  assert.equal(new CodexRunner({ runsDir: join(root, 'runs') }).signOfLife({ id: 'nope' }), null);
  // From a house: an ISO time and whole tokens only.
  const rep = (alive) => cleanReport({ bodies: { abcd1234: { harness: 'claude', status: 'working', alive } } }).bodies.abcd1234.alive;
  assert.deepEqual(rep({ at: '2026-11-10T08:00:00.000Z', tokens: 12 }), { at: '2026-11-10T08:00:00.000Z', tokens: 12 });
  assert.deepEqual(rep({ at: '2026-11-10T08:00:00.000Z', tokens: -1 }), { at: '2026-11-10T08:00:00.000Z' });
  assert.equal(rep({ at: 'soon\x1b[2J' }), undefined);
  assert.equal(rep('x'), undefined);
  void statSync;
});

test('a removed line that starts like a flag keeps its words; a diff is redacted once, apart from its marks', () => {
  const patch = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: ['-print("hello world")', '-pkg install x', '+keep()'] }];
  const [c] = claudeCards([use('e', 'Edit', { file_path: '/home/art/Code/x/a.py' }), res('e', 'ok', { structuredPatch: patch })]);
  assert.equal(c.body, '@@ -1,2 +1,1 @@\n-print("hello world")\n-pkg install x\n+keep()');
  assert.equal(stepParts(c).body, c.body, 'and the gate leaves it as it is');
});

test('a house\'s target is only the shape made here for its tool: a file\'s base name, a search, a command; a private store\'s never', () => {
  const d = (tool, detail) => stepParts({ tool, detail }).detail;
  assert.equal(d('Read', '/home/art/Code/private-client/plans/q4.md'), undefined);
  assert.equal(d('Read', 'q4.md'), 'q4.md');
  assert.equal(d('Edit', '.env'), 'a private file', 'named, as made here');
  assert.equal(d('mcp__loom__recall', 'what Art remembered about Loren'), undefined);
  assert.equal(d('Grep', '"sleep(" in test'), '"sleep(" in test');
  assert.equal(d('Grep', 'anything at all'), undefined);
  assert.equal(d('Bash', 'npm test'), 'npm test');
});

test('two results in one line: neither reads the line\'s structured result, so no diff lands on the wrong card', () => {
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-A=PRIVATEVALUE1', '+A=PRIVATEVALUE2'] }];
  const both = { type: 'user', timestamp: '2026-11-10T10:00:05.000Z', toolUseResult: { structuredPatch: patch }, message: { content: [
    { type: 'tool_result', tool_use_id: 'e1', content: 'ok' }, { type: 'tool_result', tool_use_id: 'e2', content: 'ok' }] } };
  const cards = claudeCards([use('e1', 'Edit', { file_path: '/home/art/Code/x/.env' }), use('e2', 'Edit', { file_path: '/home/art/Code/x/a.ts' }), both]);
  assert.deepEqual(cards.map((c) => [c.state, c.body]), [['done', undefined], ['done', undefined]]);
  assert.ok(!JSON.stringify(cards).includes('PRIVATEVALUE'));
});

test('runners read at most their limits a pass: a transcript\'s tail, a helper\'s tail, a sign of life in slices', async () => {
  const root = scratch('steps-bounds');
  const proj = join(root, 'projects', '-x');
  const session = '11111111-2222-3333-4444-888888888888';
  mkdirSync(join(proj, session, 'subagents'), { recursive: true });
  const l = (o) => JSON.stringify(o);
  const filler = l({ type: 'user', message: { content: [] }, pad: 'x'.repeat(2000) });
  // An old step far back, then filler past the window, then a new step.
  writeFileSync(join(proj, `${session}.jsonl`), [l(use('old', 'Bash', { command: 'ls' })), ...Array(20).fill(filler), l(use('new', 'Bash', { command: 'pwd' }))].join('\n') + '\n');
  writeFileSync(join(proj, session, 'subagents', 'agent-h1.meta.json'), l({ toolUseId: 'new' }));
  writeFileSync(join(proj, session, 'subagents', 'agent-h1.jsonl'), [l(use('hold', 'Bash', { command: 'ls' })), ...Array(20).fill(filler), l(use('hnew', 'Bash', { command: 'date' }))].join('\n') + '\n');
  const r = new ClaudeRunner({ projectsDir: join(root, 'projects'), jobsDir: join(root, 'jobs'), readMax: { activity: 10_000, helper: 10_000, sign: 10_000 } });
  const body = { id: 'b', slot: { harness: 'claude', session } };
  assert.deepEqual(r.activity(body).map((c) => c.id), ['new', 'h1:hnew']);
  // The sign of life reads the file in slices: no tokens until it has caught up.
  const a = (id, n) => l({ type: 'assistant', message: { id, usage: { output_tokens: n }, content: [] } });
  writeFileSync(join(proj, `${session}.jsonl`), [a('m1', 5), ...Array(20).fill(filler), a('m2', 7)].join('\n') + '\n');
  const firsts = [];
  for (let k = 0; k < 6; k++) firsts.push(r.signOfLife(body).tokens);
  assert.equal(firsts[0], undefined, 'not caught up after one slice');
  assert.equal(firsts.at(-1), 12);
});

test('every card carries a fixed label made where it\'s made: fixed words, a plain base name, counts, a plain name; never a quote', async () => {
  const { claudeFixed, FIXED } = await import('../src/activity.mjs');
  const quoting = [
    ['Bash', { command: 'echo hi', description: 'Tell Loren "the rent is late"' }, 'Ran a command'],
    ['Grep', { pattern: 'Loren: "rent"', path: '/x' }, 'Searched files'],
    ['Glob', { pattern: '**/loren-notes*.md' }, 'Looked for files'],
    ['WebSearch', { query: 'what Loren asked' }, 'Searched the web'],
    ['WebFetch', { url: 'https://example.com/loren' }, 'Read a web page'],
    ['Agent', { description: 'Answer Loren about rent' }, 'Started a helper'],
    ['Task', { description: 'Answer Loren' }, 'Started a helper'],
    ['SendMessage', { to: 'x', message: 'Loren says hi' }, 'Messaged a helper'],
    ['TodoWrite', { todos: [{ content: 'Reply to Loren', status: 'in_progress' }, { content: 'x', status: 'completed' }] }, 'Plan (1/2)'],
    ['mcp__loom__relay', { to: 'mark', say: 'Loren wants the rent' }, 'Messaged mark'],
    ['mcp__loom__relay', { to: 'mark: "x', say: 'hi' }, 'Messaged someone'],
    ['mcp__loom__relay', { to: 'Mark ": evil', say: 'hi' }, 'Messaged someone'],
    ['mcp__loom__recall', { query: 'Loren' }, 'Searched memory'],
    ['Read', { file_path: '/home/art/notes/loren: "rent".md' }, 'Read a file'],
    ['Read', { file_path: '/home/art/Code/x/a.ts' }, 'Read a.ts'],
    ['Edit', { file_path: '/home/art/.env' }, 'Edited a file'],
    ['Skill', { skill: 'brainstorming' }, 'Used a skill'],
    ['SomethingNew', { any: 'Loren' }, 'Used a tool'],
  ];
  for (const [name, input, want] of quoting) {
    assert.equal(claudeFixed(name, input), want, name);
    assert.ok(FIXED.test(want), want);
    const [c] = claudeCards([use(`u-${name}`, name, input)]);
    assert.equal(c.fixed, want);
  }
  // A failure adds its exit code and fixed phrase only.
  const [f] = claudeCards([use('ff', 'Bash', { command: 'npm test', description: 'Loren\'s tests' }), res('ff', 'Exit code 1\nℹ fail 3', undefined, true)]);
  assert.equal(f.fixed, 'Ran a command — exit 1: 3 tests failed');
  // A house's fixed label is kept only in a shape made here.
  for (const bad of ['Messaged mark: "Loren wants rent"', 'Searched for "x"', 'Read notes/loren.md', 'Ran a command — Loren', 'Ran a command — exit 2: Loren is here', 'Plan (1/2): Reply to Loren']) assert.equal(stepParts({ fixed: bad }).fixed, undefined, bad);
  for (const ok of ['Messaged mark', 'Read a.ts', 'Plan (1/2)', 'Ran a command — exit 2: no such file', 'Ran a command — Python error', 'Ran a command — exit 1: 3 tests failed', 'Searched memory']) assert.equal(stepParts({ fixed: ok }).fixed, ok);
  const [x] = codexCards([{ type: 'item.completed', item: { id: 'i', type: 'mcp_tool_call', tool: 'relay', arguments: { to: 'loren', say: 'rent?' }, status: 'completed' } }], 'b:');
  assert.equal(x.fixed, 'Messaged loren');
});

test('a diff line\'s mark is read after it\'s normalised: an invisible character before it can\'t make a secret look like a flag', () => {
  for (const pre of ['​', '­', '\x00', '﻿']) {
    const out = stepParts({ tool: 'Edit', detail: 'a.ts', body: `${pre}+FOO=${GH}` }).body;
    assert.ok(out && !leak(out) && out.startsWith('+'), JSON.stringify([pre, out]));
  }
});
