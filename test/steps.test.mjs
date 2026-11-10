// Work shown in full for the owner's Watching view (t-2109; Jonathan, 2026-11-10): a step's whole command, its whole
// output or diff (each line redacted, ANSI colours kept, at most MAX_BODY), a result line in fixed phrases, the plan as
// a checklist, the body's own words between steps, and a helper's steps under it. A read never shows what it read.
// Built to the shapes Claude Code writes (`toolUseResult`, subagents/) and codex exec --json writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCards, codexCards, commandLine, shownText, testsLine, changed, stepParts, MAX_BODY } from '../src/activity.mjs';
import { cleanCards } from '../src/houserunner.mjs';
import { ClaudeRunner } from '../src/runners.mjs';
import { scratch } from './scratch.mjs';

const j = (...p) => p.join('');
const GH = j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
const leak = (s) => { for (let i = 0; i + 8 <= GH.length; i++) if (String(s).includes(GH.slice(i, i + 8))) return true; return false; };
const use = (id, name, input, at = '2026-11-10T10:00:00.000Z') => ({ type: 'assistant', timestamp: at, message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, content, toolUseResult, is_error = false) => ({ type: 'user', timestamp: '2026-11-10T10:00:05.000Z', toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });

test('a shell step: its whole command and whole output, redacted; colours kept; when it ended', () => {
  const out = Array.from({ length: 10 }, (_, i) => `\x1b[32mline ${i + 1}\x1b[0m`).join('\n');
  const [c] = claudeCards([use('u1', 'Bash', { command: `GH_TOKEN=${GH} gh pr list\necho second`, description: 'List PRs', timeout: 600000 }), res('u1', out, { stdout: out, stderr: '' })]);
  assert.equal(c.summary, 'List PRs');
  assert.equal(c.detail, 'GH_TOKEN=… gh pr list\necho second');
  assert.equal(c.limit, 600);
  assert.equal(c.result, '10 lines of output');
  assert.equal(c.body.split('\n').length, 10);
  assert.ok(c.body.startsWith('\x1b[32mline 1\x1b[0m'), 'ANSI colour codes kept for a terminal look');
  assert.equal(c.end, '2026-11-10T10:00:05.000Z');
  assert.ok(!leak(JSON.stringify(c)));
});

test('output: a token, a key block and a token split by a colour code all go; other controls go; private paths are named', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2EAAAADAQABAAABAQC\n-----END OPENSSH PRIVATE KEY-----';
  const split = `${GH.slice(0, 10)}\x1b[1m${GH.slice(10)}`;
  const t = shownText(`a ${GH}\n${pem}\n${split}\nbell\x07 and \x1b]0;title\x07\ncat /home/art/.config/gh/hosts.yml`);
  assert.ok(!leak(t), t);
  assert.ok(!t.includes('AAAAB3NzaC1yc2E'), 'key block gone');
  assert.ok(!/[\x07]/.test(t) && !t.includes(']0;'), 'only colour codes survive');
  assert.ok(t.includes('cat a private file'));
});

test('a long output keeps its head and tail and says how many lines it left out', () => {
  const t = shownText(Array.from({ length: 20000 }, (_, i) => `row ${i}`).join('\n'));
  assert.ok(t.length <= MAX_BODY);
  assert.ok(t.startsWith('row 0\n') && t.endsWith('row 19999'));
  assert.match(t, /… \d+ lines not kept …/);
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
  // A helper whose step isn't in this session is left out.
  writeFileSync(join(proj, session, 'subagents', 'agent-zzz.meta.json'), l({ toolUseId: 'toolu_OTHER' }));
  writeFileSync(join(proj, session, 'subagents', 'agent-zzz.jsonl'), l(use('toolu_C', 'Bash', { command: 'pwd' })));
  const r = new ClaudeRunner({ projectsDir: join(root, 'projects'), jobsDir: join(root, 'jobs') });
  const cards = r.activity({ id: 'b', slot: { harness: 'claude', session } });
  assert.deepEqual(cards.map((c) => [c.id, c.tool, c.result, c.parent]), [['toolu_A', 'Agent', '1 tool use', undefined], ['abc123:toolu_B', 'Bash', '1 line of output', 'toolu_A']]);
  const alive = r.alive({ id: 'b', slot: { harness: 'claude', session } });
  assert.ok(Date.parse(alive.at) > 0);
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
  assert.deepEqual([c.detail, c.body], ['git status', 'clean']);
  assert.equal(commandLine("cat > f <<'EOF'\nbody\nEOF"), "cat > f <<'EOF'\nbody\nEOF");
});

test('tests counts from node, jest, vitest and pytest', () => {
  assert.equal(testsLine('ℹ tests 3\nℹ pass 3\nℹ fail 0'), '3 tests passed');
  assert.equal(testsLine('Tests:       1 failed, 12 passed, 13 total'), '12 passed, 1 failed');
  assert.equal(testsLine('      Tests  2 failed | 40 passed (42)'), '40 passed, 2 failed');
  assert.equal(testsLine('==== 5 passed, 1 failed in 0.12s ===='), '5 passed, 1 failed');
  assert.equal(testsLine('nothing here'), null);
});

test('a result or body that moves is sent again', () => {
  const a = changed([{ id: 'x', tool: 'Bash', summary: 's', state: 'done', at: 'x', body: 'a' }], {});
  assert.equal(changed([{ id: 'x', tool: 'Bash', summary: 's', state: 'done', at: 'x', body: 'b' }], a.next).out.length, 1);
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
