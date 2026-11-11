// Work shown in full for the owner's Watching view (t-2109; Jonathan, 2026-11-10): a step's whole command, its whole
// diff (each line redacted, controls stripped, at most MAX_BODY), a fixed result phrase, the plan as
// a checklist, the body's own words between steps, and a helper's steps under it. Reads and shell output never show.
// Built to the shapes Claude Code writes (`toolUseResult`, subagents/) and codex exec --json writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual([s.summary, s.detail, s.limit, s.result, s.body, s.end], ['Ran a command', undefined, 600, '2 lines of output', undefined, '2026-11-10T10:00:05.000Z']);
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
  const [updated] = codexCards([
    {type:'item.started',item:{id:'p',type:'todo_list',items:[{text:'A',completed:false},{text:'B',completed:false}]}},
    {type:'item.updated',item:{id:'p',type:'todo_list',items:[{text:'A',completed:true},{text:'B revised',completed:true}]}},
  ], 'b:');
  assert.deepEqual(updated.items, [{text:'A',state:'done'},{text:'B revised',state:'done'}]);
  assert.equal(updated.fixed,'Plan (2/2)');
  assert.equal(updated.state,'done');
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
  const replacement = f + '.new';
  writeFileSync(replacement, a('replacement', 2) + '\n' + ' '.repeat(2000));
  renameSync(replacement, f);
  assert.equal(r.signOfLife(body).tokens, 2, 'replacement larger than previous transcript starts its own total');
  writeFileSync(f,a('short',3)+'\n');
  assert.equal(r.signOfLife(body).tokens,3,'same file shortened starts at zero');
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
  assert.equal(commandLine("cat > f <<'EOF'\nbody\nEOF"), "");
});

test('tests counts from node, jest, vitest and pytest', () => {
  assert.equal(testsLine('ℹ tests 3\nℹ pass 3\nℹ fail 0'), '3 tests passed');
  assert.equal(testsLine('Tests:       1 failed, 12 passed, 13 total'), '12 passed, 1 failed');
  assert.equal(testsLine('      Tests  2 failed | 40 passed (42)'), '40 passed, 2 failed');
  assert.equal(testsLine('==== 5 passed, 1 failed in 0.12s ===='), '5 passed, 1 failed');
  for(const summary of ['==== 5 passed, 2 skipped, 1 failed in 0.12s ====', '==== 1 failed, 2 skipped, 5 passed in 0.12s ====']) assert.equal(testsLine(summary),'5 passed, 1 failed');
  assert.equal(testsLine('nothing here'), null);
});

test('any part that moves is sent again: its label, fixed label, target, result, body, exit, end, plan items, parent', () => {
  const base = { id: 'x', tool: 'Bash', summary: 's', fixed: 'Ran a command', state: 'done', at: 'x', detail: 'd', result: 'no output', body: 'a', exit: 0, end: '2026-11-10T10:00:00.000Z', items: [{ text: 'a', state: 'now' }], parent: 'p' };
  const a = changed([base], {});
  for (const [k, v] of Object.entries({ summary: 's2', fixed: 'Ran a command — exit 1', detail: 'd2', result: '1 line of output', body: 'b', exit: 1, limit: 600, end: '2026-11-10T10:00:01.000Z', items: [{ text: 'a', state: 'done' }], parent: 'q' })) {
    const updated = { ...base, [k]: v };
    const sent = changed([updated], a.next);
    assert.equal(sent.out.length, 1, k);
    assert.equal(changed([updated], sent.next).out.length, 0, `${k} stays told`);
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
  assert.equal(c.detail, undefined);
  const words = Array.from({ length: 4000 }, (_, i) => `word ${i}`).join('\n');
  const [t] = claudeCards([{ type: 'assistant', timestamp: '2026-11-10T10:00:00.000Z', message: { id: 'm', content: [{ type: 'text', text: words }] } }]);
  assert.ok(t.body.length <= MAX_TEXT);
  assert.equal(stepParts({ tool: 'text', body: words }).body.length <= MAX_TEXT, true);
  assert.equal(stepParts({ tool: 'Bash', detail: cmd }).detail, undefined);
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
  assert.equal(d('Bash', 'npm test'), undefined);
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

test('a fixed label never holds a token; an exit code comes only from a shell step', () => {
  assert.equal(stepParts({ fixed: `Read ${GH}` }).fixed, undefined);
  const [c] = claudeCards([use('t', 'Read', { file_path: `/home/art/Code/${GH}` })]);
  assert.equal(c.fixed, 'Read a file');
  const [r] = claudeCards([use('r', 'Read', { file_path: '/home/art/Code/x/a.txt' }), res('r', 'Exit code 42\nmore', { type: 'text', file: { numLines: 2 } })]);
  assert.equal(r.exit, undefined);
});

test('a house\'s card words are sealed on loom\'s disk, and opened again for the runtime', async () => {
  const { bodySync, HouseRunner } = await import('../src/houserunner.mjs');
  const { testSealer, everything } = await import('./delivery-world.mjs');
  const { createHash } = await import('node:crypto');
  const D = scratch('steps-seal-');
  const env = { HOME: D, LOOM_BOX_DATA: join(D, 'data'), LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_LOCAL_NAME: 'one' };
  const hosts = join(env.LOOM_BOX_DATA, 'delivery', 'hosts');
  mkdirSync(hosts, { recursive: true });
  writeFileSync(join(hosts, 'art.json'), JSON.stringify({ agent: 'art', house: 'h-1', hostHash: createHash('sha256').update('the-host-key').digest('hex'), req: {}, stop: {}, inbox: {} }));
  const card = { id: 'c1', at: '2026-11-10T10:00:00.000Z', tool: 'Edit', summary: 'THE-SEARCH-OR-SHELL-DESCRIPTION', fixed: 'Edited a.ts', state: 'done', detail: 'a.ts', body: '+THE-DIFF-WORDS' };
  const said = { id: 'w1', at: '2026-11-10T10:00:01.000Z', tool: 'text', summary: 'THE-OWN-WORDS first line', fixed: 'Wrote its words', state: 'done', body: 'THE-OWN-WORDS first line' };
  const plan = { id: 'p1', at: '2026-11-10T10:00:02.000Z', tool: 'TodoWrite', summary: 'Plan (1/2): THE-PLAN-WORDS', fixed: 'Plan (1/2)', state: 'done', items: [{ text: 'THE-PLAN-WORDS', state: 'now' }] };
  bodySync(env, { kind: 'agent', agent: 'art', house: 'h-1' }, { hostKey: 'the-host-key', report: { bodies: { b0000001: { harness: 'claude', status: 'working', cards: [card, said, plan] } }, done: {} } }, { sealer: testSealer });
  assert.equal(everything(hosts).includes(Buffer.from('THE-DIFF-WORDS')), false, 'never in the clear on disk');
  assert.equal(everything(hosts).includes(Buffer.from('THE-OWN-WORDS')), false, 'a text card\'s label is its words: sealed too');
  assert.equal(everything(hosts).includes(Buffer.from('THE-PLAN-WORDS')), false, 'a plan\'s label too');
  const hr = new HouseRunner(env, 'claude', { sealer: testSealer });
  const got = hr.activity({ id: 'h-1-b0000001', house: 'h-1', agent: 'art' });
  assert.equal(got[0]?.body, '+THE-DIFF-WORDS');
  assert.equal(got[0]?.summary, 'THE-SEARCH-OR-SHELL-DESCRIPTION');
  assert.equal(everything(hosts).includes(Buffer.from('THE-SEARCH-OR-SHELL-DESCRIPTION')), false);
  assert.deepEqual([got[1]?.summary, got[1]?.body], ['THE-OWN-WORDS first line', 'THE-OWN-WORDS first line'], 'opened again whole');
  // Sealed once a body, and again only when its words move; opened once a blob.
  let seals = 0, opens = 0;
  // A sealer made anew each call, as a sync makes one.
  const counting = () => ({ seal: (b) => { seals++; return testSealer.seal(b); }, open: (b) => { opens++; return testSealer.open(b); } });
  const sync = (cards) => bodySync(env, { kind: 'agent', agent: 'art', house: 'h-1' }, { hostKey: 'the-host-key', report: { bodies: { b0000001: { harness: 'claude', status: 'working', cards } }, done: {} } }, { sealer: counting() });
  sync([card, said, plan]); sync([card, said, plan]);
  assert.equal(seals, 0, 'unchanged words aren\'t sealed again (sealed by the first sync above)');
  sync([card, { ...said, body: 'THE-OWN-WORDS moved' }, plan]);
  assert.equal(seals, 1);
  const hr2 = new HouseRunner(env, 'claude', { sealer: counting() });
  for (let k = 0; k < 3; k++) hr2.activity({ id: 'h-1-b0000001', house: 'h-1', agent: 'art' });
  assert.equal(opens, 1, 'one blob opened once');
});

test('a sign of life read in slices never cuts a character in two', () => {
  const root = scratch('steps-utf8');
  const proj = join(root, 'projects', '-x');
  const session = '11111111-2222-3333-4444-999999999999';
  mkdirSync(proj, { recursive: true });
  const f = join(proj, `${session}.jsonl`);
  const a = (id, n, pad) => JSON.stringify({ type: 'assistant', pad, message: { id, usage: { output_tokens: n }, content: [] } });
  // A slice boundary that lands inside a three-byte character.
  writeFileSync(f, `${a('m1', 5, '界'.repeat(40))}\n${a('m2', 7, '界'.repeat(40))}\n`);
  const r = new ClaudeRunner({ projectsDir: join(root, 'projects'), jobsDir: join(root, 'jobs'), readMax: { sign: 101 } });
  let t;
  for (let k = 0; k < 20; k++) t = r.signOfLife({ id: 'b', slot: { harness: 'claude', session } }).tokens;
  assert.equal(t, 12);
});

test('two text blocks of one message, each a line of its own, are two cards (t-2109)', () => {
  const line = (uuid, text) => ({ type: 'assistant', uuid, timestamp: '2026-11-10T10:00:00.000Z', message: { id: 'msg_same', content: [{ type: 'text', text }] } });
  const cards = claudeCards([line('u-1', 'First thought.'), line('u-2', 'Second thought.')]);
  assert.deepEqual(cards.map((c) => c.body), ['First thought.', 'Second thought.']);
});

test('a house\'s report carries at most CARDS_MAX of cards, the newest, so large diffs never push it past core\'s cap (t-2109)', async () => {
  const { CARDS_MAX, newestWithin } = await import('../src/bodyhost.mjs');
  const { cleanReport } = await import('../src/houserunner.mjs');
  const big = (i) => ({ id: `e${i}`, at: '2026-11-10T10:00:00.000Z', tool: 'Edit', summary: `Edited f${i}.ts`, fixed: `Edited f${i}.ts`, state: 'done', detail: `f${i}.ts`, body: `+${'x'.repeat(31_000)}` });
  const all = Array.from({ length: 40 }, (_, i) => big(i));
  const kept = newestWithin(all, CARDS_MAX);
  assert.equal(kept.length, 8, 'all eight newest cards fit, a ninth exceeds the budget');
  assert.deepEqual(kept.map(c => c.id), all.slice(-8).map(c => c.id));
  assert.ok(all.slice(-9).reduce((n,c) => n + Buffer.byteLength(JSON.stringify(c)) + 1,0) > CARDS_MAX);
  assert.equal(kept.at(-1).id, 'e39', 'the newest kept');
  assert.deepEqual(kept.map((c) => c.id), all.slice(40 - kept.length).map((c) => c.id), 'none dropped from the middle');
  const report = cleanReport({ bodies: { b0000001: { harness: 'claude', status: 'working', cards: kept } } });
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= CARDS_MAX + 4096);
  assert.deepEqual(newestWithin([], CARDS_MAX), []);
});

test('a whole report fits core\'s cap: several threads in one house share one budget, the newest cards kept (t-2109)', async () => {
  const { CARDS_MAX, REPORT_MAX, fitCards, newestWithin } = await import('../src/bodyhost.mjs');
  const big = (b, i) => ({ id: `${b}${i}`, at: new Date(Date.UTC(2026, 10, 10, 10, i, b === 'x' ? 0 : b === 'y' ? 20 : 40)).toISOString(), tool: 'Edit', summary: 'Edited f.ts', state: 'done', detail: 'f.ts', body: `+${'界'.repeat(10_000)}` });
  const bodies = Object.fromEntries(['x', 'y', 'z'].map((b) => [`b000000${b}`, { status: 'working', cards: newestWithin(Array.from({ length: 12 }, (_, i) => big(b, i)), CARDS_MAX), final: 'w'.repeat(40_000) }]));
  const report = { bodies, done: {}, packed: { b0000009: { part: 0, parts: 2, data: 'p'.repeat(360 * 1024) } } };
  assert.ok(Buffer.byteLength(JSON.stringify(report)) > 1024 * 1024, 'over core\'s cap before');
  fitCards(report, REPORT_MAX);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= REPORT_MAX, 'within it after');
  assert.equal(report.packed.b0000009.data.length, 360 * 1024, 'a packed part is never trimmed');
  assert.deepEqual(Object.fromEntries(Object.entries(report.bodies).map(([id,b])=>[id,b.cards.map(c=>c.id)])), {
    b000000x:['x8','x9','x10','x11'],b000000y:['y7','y8','y9','y10','y11'],b000000z:['z7','z8','z9','z10','z11'],
  },'every retained card is the complete newest-first selection across bodies');
  const kept = Object.values(report.bodies).flatMap((b) => b.cards);
  assert.ok(kept.length > 0);
  const ids = new Set(kept.map((c) => c.id));
  assert.ok(ids.has('z11') && !ids.has('x0'), 'the newest across bodies kept, the oldest dropped');
  assert.ok(Object.values(report.bodies).every((b) => b.cards.every((c, i, a) => i === 0 || a[i - 1].at <= c.at)), 'each body\'s in order');
  const small = { bodies: { b0000001: { cards: [big('x', 0)] } } };
  assert.deepEqual(fitCards(small, REPORT_MAX).bodies.b0000001.cards.length, 1, 'a report that fits is left as it is');
});

test('a key block in a diff goes whole, every line from BEGIN to END, its last short line too (t-2109)', async () => {
  const { diffText } = await import('../src/activity.mjs');
  const key = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW', 'QyNTUxOQAAACBx', '-----END OPENSSH PRIVATE KEY-----'];
  const out = diffText(['+echo hi', ...key.map((l) => `+${l}`), '+done'].join('\n'));
  assert.ok(!out.includes('QyNTUxOQAAACBx') && !out.includes('b3BlbnNzaC1'));
  assert.ok(out.startsWith('+echo hi') && out.endsWith('+done'));
});

test('where words won\'t go they aren\'t read: a lazy diff isn\'t worked out (t-2109)', () => {
  let reads = 0;
  const c = { id: 'e', at: '2026-11-10T10:00:00.000Z', tool: 'Edit', summary: 'Edited a.ts', fixed: 'Edited a.ts', state: 'done', detail: 'a.ts' };
  Object.defineProperty(c, 'body', { enumerable: true, get() { reads++; return '+x'; } });
  assert.deepEqual(stepParts(c, undefined, { words: false }), { fixed: 'Edited a.ts' });
  assert.equal(reads, 0);
  const r = { id: 'r', at: c.at, tool: 'Read', summary: 'Read a.ts', state: 'done', detail: 'a.ts' };
  Object.defineProperty(r, 'body', { enumerable: true, get() { reads++; return 'contents'; } });
  stepParts(r);
  assert.equal(reads, 0, 'nor on a tool that never keeps one');
});

test('a long diff is worked out at its head and tail only, says how many lines it left out, and a key block across the cut still goes whole (t-2109)', async () => {
  const { diffText } = await import('../src/activity.mjs');
  // Under the 2,000,000 characters a diff is read to.
  const lines = Array.from({ length: 30_000 }, (_, i) => `+line ${i} ${'x'.repeat(40)}`);
  // A key whose BEGIN is in the middle (not worked out) and whose last lines are in the tail.
  lines.splice(29_000, 0, '+-----BEGIN OPENSSH PRIVATE KEY-----');
  lines.splice(29_998, 0, '+QyNTUxOQAAACBx', '+-----END OPENSSH PRIVATE KEY-----');
  lines.splice(15_000, 0, '+-----BEGIN RSA PRIVATE KEY-----', '+MIIEowIBAAKCAQEA', '+-----END RSA PRIVATE KEY-----');
  const t0 = Date.now();
  const out = diffText(lines.join('\n'));
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(out.length <= MAX_BODY);
  assert.ok(!out.includes('QyNTUxOQAAACBx') && !out.includes('MIIEowIBAAKCAQEA'));
  const n = Number(/… (\d+) lines not kept …/.exec(out)?.[1]);
  assert.equal(n + out.split('\n').length - 1, lines.length, 'every line counted, kept or not');
  assert.ok(out.startsWith('+line 0 ') && out.endsWith(`+line 29999 ${'x'.repeat(40)}`));
});

test('a report carries at most PACKED_MAX of session parts, the longest waiting first, at least one (t-2109)', async () => {
  const { PACKED_MAX, packedParts } = await import('../src/bodyhost.mjs');
  const part = 'p'.repeat(360 * 1024);
  const packing = new Map([['b1', { parts: [part, part], next: 0, since: 3 }], ['b2', { parts: [part], next: 0, since: 1 }], ['b3', { parts: [part], next: 0, since: 2 }]]);
  const one = packedParts(packing, false);
  assert.deepEqual(Object.keys(one), ['b2'], 'the longest waiting');
  assert.ok(Object.values(one).reduce((k, p) => k + p.data.length, 0) <= PACKED_MAX);
  assert.deepEqual(Object.keys(packedParts(new Map([['b9', { parts: ['x'.repeat(PACKED_MAX + 1)], next: 0, since: 0 }]]), false)), ['b9'], 'at least one');
});

test('finals beside a packed part keep a report under core\'s cap: cut evenly past FINALS_MAX, and say so (t-2109)', async () => {
  const { REPORT_MAX, FINALS_MAX, fitCards, packedParts } = await import('../src/bodyhost.mjs');
  const packing = new Map([['b9', { parts: ['p'.repeat(360 * 1024)], next: 0, since: 0 }]]);
  const bodies = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`b000000${i}`, { status: 'idle', final: '界'.repeat(40_000), cards: [] }]));
  const report = { bodies, done: {}, packed: packedParts(packing, false) };
  assert.ok(Buffer.byteLength(JSON.stringify(report)) > 1024 * 1024);
  fitCards(report, REPORT_MAX);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= REPORT_MAX);
  assert.ok(Object.values(report.bodies).reduce((k, b) => k + Buffer.byteLength(b.final), 0) <= FINALS_MAX);
  assert.ok(Object.values(report.bodies).every((b) => b.final.startsWith('界') && b.final.endsWith('(cut to fit: 6 finals in one report)')));
  const one = { bodies: { b1: { final: 'short' } } };
  assert.equal(fitCards(one, REPORT_MAX).bodies.b1.final, 'short', 'under the cap, untouched');
});

test('a helper\'s meta that isn\'t a plain file (a FIFO, a link) is never waited on or followed (t-2109)', async () => {
  const { symlinkSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const root = scratch('steps-fifo');
  const session = '11111111-2222-3333-4444-555555555555';
  const proj = join(root, 'projects', '-x');
  const sub = join(proj, session, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(proj, `${session}.jsonl`), `${JSON.stringify(use('t1', 'Bash', { command: 'ls' }))}\n`);
  assert.equal(spawnSync('mkfifo', [join(sub, 'agent-fifo.meta.json')]).status, 0);
  symlinkSync('/dev/zero', join(sub, 'agent-zero.meta.json'));
  const r = new ClaudeRunner({ projectsDir: join(root, 'projects'), jobsDir: join(root, 'jobs') });
  const t0 = Date.now();
  const cards = r.activity({ id: 'b', slot: { harness: 'claude', session } });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(cards.map((c) => c.id), ['t1']);
});

test('a PGP private key block goes whole too (t-2109)', async () => {
  const { diffText } = await import('../src/activity.mjs');
  const key = ['-----BEGIN PGP PRIVATE KEY BLOCK-----', '', 'lQOYBF0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV', 'ZieSrY/uAZd804E8', '=Ab3x', '-----END PGP PRIVATE KEY BLOCK-----'];
  for (const out of [diffText(key.map((l) => `+${l}`).join('\n')), shownText(key.join('\n'))]) for (const bit of ['ZieSrY', '=Ab3x', 'lQOYBF0']) assert.ok(!out.includes(bit), bit);
});

test('finals are measured as sent (JSON): finals of control characters still fit (t-2109)', async () => {
  const { REPORT_MAX, FINALS_MAX, fitCards, packedParts } = await import('../src/bodyhost.mjs');
  const bodies = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`b000000${i}`, { status: 'idle', final: '\x1b'.repeat(40_000), cards: [] }]));
  const report = { bodies, done: {}, packed: packedParts(new Map([['b9', { parts: ['p'.repeat(360 * 1024)], next: 0, since: 0 }]]), false) };
  assert.ok(Buffer.byteLength(JSON.stringify(report)) > 1024 * 1024);
  fitCards(report, REPORT_MAX);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= REPORT_MAX);
  assert.ok(Object.values(report.bodies).reduce((k, b) => k + Buffer.byteLength(JSON.stringify(b.final)), 0) <= FINALS_MAX);
});

test('a diff is worked out once for the process, not again each pass (t-2109)', () => {
  const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'y'.repeat(40)}`);
  const lines = [use('w1', 'Write', { file_path: '/home/art/Code/x/a.txt', content: big.join('\n') }), { type: 'user', timestamp: '2026-11-10T10:00:05.000Z', toolUseResult: { type: 'create', content: big.join('\n') }, message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] } }];
  const first = stepParts(claudeCards(lines)[0]);
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 20; k++) assert.equal(stepParts(claudeCards(lines)[0]).body, first.body);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200, 'twenty passes from what was made once');
});

test('a house\'s fixed label naming a private file isn\'t kept (t-2109)', () => {
  assert.equal(stepParts({ id: 'x', tool: 'Read', summary: 's', state: 'done', fixed: 'Read .env' }).fixed, undefined);
  assert.equal(stepParts({ id: 'x', tool: 'Read', summary: 's', state: 'done', fixed: 'Read delivery.ts' }).fixed, 'Read delivery.ts');
});

test('a command that takes a secret in shows no command, only its label: logins, secrets stores, sudo -S, a private file written, a flag continued on the next line (t-2109)', () => {
  const S = 'hunter2xyz';
  for (const cmd of [`gh secret set FOO --body ${S}`, `echo ${S} | docker login -u me --password-stdin`, `echo '${S}' | sudo -S apt install x`,
    `printf '%s' ${S} > ~/.config/gh/token`, `echo ${S} | tee -a .env`, `echo ${S} | gh auth login --with-token`, `kubectl create secret generic x --from-literal=k=${S}`,
    `vault kv put secret/x v=${S}`]) {
    assert.equal(commandLine(cmd), '', cmd);
    const [c] = claudeCards([use('b', 'Bash', { command: cmd })]);
    assert.ok(!JSON.stringify(c).includes(S), cmd);
    assert.equal(c.detail, undefined, cmd);
  }
  // A flag and its value on two lines are read as one.
  const two = commandLine(`mysql --password \\\n  ${S} db`);
  assert.ok(!two.includes(S), two);
  // A house's command that takes a secret in is dropped at the gate too.
  assert.equal(stepParts({ id: 'h', tool: 'Bash', summary: 's', state: 'done', detail: `gh secret set FOO --body ${S}` }).detail, undefined);
  // An ordinary command still shows whole.
  assert.equal(commandLine('npm test -- deploy'), '');
  assert.equal(commandLine('ls > out.txt'), '');
});

test('padding and sudo forms remain unclassified, in bounded time', () => {
  const t0 = Date.now();
  for (const command of ['sudo '.repeat(12_000), '> '.repeat(30_000), 'tee '.repeat(15_000),
    'echo pw | sudo -Sk apt install x', 'echo pw | sudo -kSv ls', 'sudo --stdin apt', 'sudo ls']) assert.equal(commandLine(command), '');
  assert.ok(Date.now() - t0 < 1000);
});

test('a window of many shell steps: commands worked out only for the cards read, and a second pass makes none again (t-2109)', () => {
  const lines = [];
  for (let i = 0; i < 1500; i++) lines.push(use(`b${i}`, 'Bash', { command: `cat <<'EOF'\n${'line '.repeat(200)}${i}\nEOF` }));
  const t0 = Date.now();
  const cards = claudeCards(lines);
  assert.ok(Date.now() - t0 < 1500, 'no command worked out while the cards are made');
  for (const c of cards.slice(-200)) stepParts(c);
  const t1 = Date.now();
  for (const c of claudeCards(lines).slice(-200)) stepParts(c);
  assert.ok(Date.now() - t1 < 1500, 'the second pass from what was made');
});

test('a colour code inside a key\'s BEGIN line can\'t hide the block (t-2109)', async () => {
  const { diffText } = await import('../src/activity.mjs');
  const out = diffText(['+-----BEGIN RSA PRIVATE \x1b[0mKEY-----', '+MIIEowIBAAKCAQEAsecretbase64lineXYZ', '+QyNTUxOQ', '+-----END RSA PRIVATE KEY-----'].join('\n'));
  assert.ok(!out.includes('QyNTUxOQ') && !out.includes('MIIEowIBAAK'));
});

 test('plain text key delimiters are normalised before block removal, including house words and Codex commentary', () => {
  const text = 'before\n-----BEGIN PRIVATE \x1b[0mKEY-----\nQyNTUxOQ\n-----END PRIVATE KEY-----\nafter';
  for (const out of [shownText(text), stepParts({tool: 'text', body: text}).body,
    codexCards([{type: 'item.completed', item: {id: 'words', type: 'agent_message', text}}])[0].body]) {
    assert.ok(!out.includes('QyNTUxOQ'));
    assert.ok(out.includes('before') && out.includes('after'));
  }
});

 test('unchanged Codex runner cards keep first observation times so newer Claude work wins a report budget', async () => {
  const { CodexRunner } = await import('../src/runners.mjs');
  const { fitCards } = await import('../src/bodyhost.mjs');
  const dir = scratch('codex-times-'); mkdirSync(join(dir, 'run'), {recursive: true});
  writeFileSync(join(dir, 'run', 'events.jsonl'), JSON.stringify({type: 'item.completed', item: {id: 'own', type: 'agent_message', text: 'old words'}}) + '\n');
  const runner = new CodexRunner({runsDir: dir});
  const old = runner.activity({id: 'run'})[0];
  await new Promise(resolve => setTimeout(resolve, 10));
  const newer = {id: 'newer', at: new Date().toISOString(), tool: 'Bash', summary: 'Ran a command', state: 'done'};
  await new Promise(resolve => setTimeout(resolve, 10));
  const again = runner.activity({id: 'run'})[0];
  assert.equal(again.at, old.at);
  const report = {bodies: {codex: {cards: [again]}, claude: {cards: [newer]}}};
  fitCards(report, Buffer.byteLength(JSON.stringify(newer)) + Buffer.byteLength(JSON.stringify({bodies: {codex: {cards: []}, claude: {cards: []}}})) + 2);
  assert.deepEqual(report.bodies.claude.cards.map(c => c.id), ['newer']);
  assert.deepEqual(report.bodies.codex.cards, []);
});

 test('helper selection prefers a recently written transcript over newer metadata when more than 20 helpers exist', async () => {
  const {utimesSync} = await import('node:fs');
  const root = scratch('helpers-many-'), file = join(root, 'main.jsonl'), dir = join(root, 'main', 'subagents');
  mkdirSync(dir, {recursive: true}); writeFileSync(file, '');
  for (let i = 0; i < 21; i++) {
    const meta = join(dir, `agent-${i}.meta.json`), log = join(dir, `agent-${i}.jsonl`);
    writeFileSync(meta, '{}'); writeFileSync(log, JSON.stringify(use(`tool-${i}`, 'Bash', {command: 'ls'})));
    utimesSync(meta, 2000-i, 2000-i); utimesSync(log, i === 20 ? 3000 : 1000+i, i === 20 ? 3000 : 1000+i);
  }
  const runner = new ClaudeRunner(); runner.transcriptOf = () => file;
  const cards = runner.activity({});
  assert.equal(cards.length, 20);
  assert.ok(cards.some(c => c.id === '20:tool-20'));
  assert.ok(!cards.some(c => c.id === '0:tool-0'));
});

 test('report budgets compare instants across timezone offsets', async () => {
  const {fitCards} = await import('../src/bodyhost.mjs');
  const newer = {id: 'newer', at: '2026-11-10T09:00:00+00:00', tool: 'Bash', summary: 'Ran a command', state: 'done'};
  const older = {...newer, id: 'older', at: '2026-11-10T10:00:00+03:00'};
  const report = {bodies: {one: {cards: [newer]}, two: {cards: [older]}}};
  const max = Buffer.byteLength(JSON.stringify({bodies: {one: {cards: [newer]}, two: {cards: []}}}));
  fitCards(report, max);
  assert.deepEqual(report.bodies.one.cards.map(c => c.id), ['newer']);
  assert.deepEqual(report.bodies.two.cards, []);
});


test('a key delimiter hidden in the omitted window still hides retained key lines', async () => {
  const { diffText, shownText } = await import('../src/activity.mjs');
  const hidden = '--\x1b[0m---BEGIN RSA PRIVATE KEY--\x1b[0m---';
  for (const mark of ['', '+']) {
    const lines = [...Array(15000).fill(mark + 'ordinary padding'), mark + hidden,
      ...Array(15000).fill(mark + 'key padding'), mark + 'SHORTKEYMATERIAL', mark + '-----END RSA PRIVATE KEY-----'];
    const out = mark ? diffText(lines.join('\n')) : shownText(lines.join('\n'));
    assert.ok(!out.includes('SHORTKEYMATERIAL'), out.slice(-100));
  }
});

test('report card budgets count empty-array separators exactly', async () => {
  const { fitCards } = await import('../src/bodyhost.mjs');
  const original = { bodies: { a: {cards: [{at: '2026-11-10T10:00:00Z', id:'a'}]}, b: {cards: [{at:'2026-11-10T11:00:00Z', id:'b'}]} } };
  const baseline = Buffer.byteLength(JSON.stringify({bodies:{a:{cards:[]},b:{cards:[]}}}));
  for (let max = baseline; max <= Buffer.byteLength(JSON.stringify(original)); max++) {
    const result = fitCards(structuredClone(original), max);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= max, String(max));
  }
});

test('the actual body-host sync applies count, per-body and shared card budgets', async () => {
  const {runBodyHost,CARDS_MAX,REPORT_MAX} = await import('../src/bodyhost.mjs');
  let started=0, syncs=0, transmitted;
  const runner={
    start:()=>({id:`b${++started}`}),status:()=> 'working',
    activity:({id})=>Array.from({length:200},(_,i)=>({id:`${id}-${i}`,at:`2026-11-10T${id==='b5'?'12':'10'}:00:00Z`,tool:'Edit',state:'done',summary:'Edited a.ts',detail:'a.ts',body:id==='b5'?'+small':'+'.repeat(31_000)})),
  };
  await runBodyHost({runner:()=>runner,hostKey:'test-key',beats:2,sleep:async()=>{},idleS:0,
    env:{HOME:scratch('sync-budget'),CLAUDE_SECURESTORAGE_CONFIG_DIR:'/login'},
    client:async(path,{report})=>{
      assert.equal(path,'body-sync');
      if(++syncs===1)return {req:Object.fromEntries(Array.from({length:5},(_,i)=>[`r${i}`,{harness:'claude',brief:'test',activity:true}]))};
      transmitted=structuredClone(report);return {exit:true};
    },
  });
  assert.equal(started,5);
  assert.equal(Object.keys(transmitted.bodies).length,5);
  assert.ok(Buffer.byteLength(JSON.stringify(transmitted))<=REPORT_MAX);
  for(const body of Object.values(transmitted.bodies)) {
    assert.ok(body.cards.length<=100);
    assert.ok(Buffer.byteLength(JSON.stringify(body.cards))<=CARDS_MAX+2);
  }
  assert.deepEqual(transmitted.bodies.b5.cards.map(c=>c.id),Array.from({length:100},(_,i)=>`b5-${100+i}`));
  assert.ok(Object.values(transmitted.bodies).slice(0,4).reduce((n,b)=>n+b.cards.length,0)<32,'shared budget trimmed the four full per-body snapshots');
});


test('helper discovery considers only the first 500 directory entries, including nonmetadata', async () => {
  const fs=(await import('node:fs')).default;
  const {syncBuiltinESMExports}=await import('node:module');
  const root=scratch('helper-window'),proj=join(root,'projects','-x'),session='11111111-2222-3333-4444-999999999999';
  const dir=join(proj,session,'subagents');mkdirSync(dir,{recursive:true});
  const own=join(proj,session+'.jsonl');writeFileSync(own,JSON.stringify(use('own','Bash',{command:'true'}))+'\n');
  const names=['agent-inside.meta.json','agent-outside.meta.json'];
  for(const name of names){writeFileSync(join(dir,name),'{}');writeFileSync(join(dir,name.replace('.meta.json','.jsonl')),JSON.stringify(use(name,'Bash',{command:'true'}))+'\n');}
  const read=fs.readdirSync;
  fs.readdirSync=(path,...args)=>String(path)===dir?[...Array.from({length:499},(_,i)=>`padding-${i}`),names[0],names[1]]:read(path,...args);
  syncBuiltinESMExports();
  try{
    const runner=new ClaudeRunner({projectsDir:join(root,'projects'),jobsDir:join(root,'jobs')});
    const cards=runner.activity({slot:{session}});
    assert.equal(cards.length,2,'own card and helper in entry 500 only');
    assert.ok(cards.some(c=>c.id.startsWith('inside:')));
    assert.ok(!cards.some(c=>c.id.startsWith('outside:')));
  }finally{fs.readdirSync=read;syncBuiltinESMExports();}
});


test('Codex commentary normalizes split tokens before redacting the complete card', () => {
  for(const control of ['\x1b[0m','\x1b(B','\u200b']) {
    const text=GH.slice(0,12)+control+GH.slice(12);
    const [card]=codexCards([{type:'item.completed',item:{id:'split-token',type:'agent_message',text}}]);
    const out=JSON.stringify(card);
    assert.ok(!out.includes(GH.slice(0,12)) && !out.includes(GH.slice(12)),out);
  }
});


test('Claude summaries normalize the whole text before projecting a line or truncating', () => {
  for (const split of ['\u2028', '\x1b[31m']) {
    const text = GH.slice(0, 12) + split + GH.slice(12);
    const cards = claudeCards([{ type: 'assistant', uuid: 'summary', message: { content: [{ type: 'text', text }] } }]);
    assert.ok(!leak(JSON.stringify(cards)), 'no fragment in any serialized Claude field');
  }
});

test('command details fail closed for unrecognized shell shapes in delivered Claude and Codex cards', async () => {
  const { shownCards } = await import('../src/delivery.mjs');
  const { world } = await import('./delivery-world.mjs');
  const o = world();
  const S = 'review-canary-value';
  for (const command of [`gh -R owner/repo secret set API_KEY --body '${S}'`, `export TOKEN='first\n${S}'`,
    `X=${S} git status`, `git -c x=${S} status`, `ls --password ${S}`, `cat < ~/.ssh/id_ed25519`,
    `git status; echo ${S}`, `echo ${S}`, `ls > out.txt`, `npm test -- ${S}`, 'git status\n', 'git status\r\n']) {
    const c = claudeCards([use('b', 'Bash', { command })]);
    const x = codexCards([{ type: 'item.completed', item: { id: 'i', type: 'command_execution', command, status: 'completed', exit_code: 0 } }]);
    const delivered = shownCards(o.env, { agent: 'art', actsFor: { owner: true, owners: [], people: [], unknown: false } }, [...c, ...x]);
    assert.equal(commandLine(command), '', command);
    for (const card of delivered) { assert.equal(card.detail, undefined); assert.equal(card.summary, 'Ran a command'); }
    assert.ok(!JSON.stringify(delivered).includes(S));
  }
  for (const command of ['git status', 'git diff --stat', 'git log --oneline', 'ls', 'pwd']) {
    assert.equal(commandLine(command), command);
    const [card] = shownCards(o.env, { agent: 'art', actsFor: { owner: true, owners: [], people: [], unknown: false } }, claudeCards([use('safe', 'Bash', { command })]));
    assert.equal(card.detail, command, 'owner-alone delivery keeps recognized detail');
  }
});


test('assistant prose retains multiline secret assignment context before projection', () => {
  const S = 'review-canary-value';
  for (const text of [`password:\n${S}`, `-----BEGIN\nPRIVATE KEY-----\n${S}\nsecond-canary-line\n-----END PRIVATE KEY-----`]) {
    const cards = claudeCards([{ type: 'assistant', uuid: 'private', message: { content: [{ type: 'text', text }] } }]);
    assert.ok(!JSON.stringify(cards).includes(S));
    assert.ok(!JSON.stringify(cards).includes('second-canary-line'));
  }
});

test('command descriptions are never projected, even for an allowlisted command', () => {
  for (const split of ['\u2028', '\x1b[31m']) {
    const cards = claudeCards([use('description', 'Bash', { command: 'git status', description: GH.slice(0, 12) + split + GH.slice(12) })]);
    assert.equal(cards[0].summary, 'Ran a command');
    assert.equal(cards[0].detail, 'git status');
    assert.ok(!leak(JSON.stringify(cards)));
  }
});


test('house command detail is allowlisted before any normalization', async () => {
  const { shownCards } = await import('../src/delivery.mjs');
  const { world } = await import('./delivery-world.mjs');
  const o = world();
  for (const detail of ['git\u200b status', 'git\x1b[31m status', 'git status\n', 'git status; echo private']) {
    const raw = { id: 'house', tool: 'Bash', at: 'x', state: 'done', summary: 'private-command-description', detail };
    assert.equal(stepParts(raw).detail, undefined, 'unrecognized raw detail fails closed');
    const [card] = shownCards(o.env, { agent: 'art', actsFor: { owner: true, owners: [], people: [] } }, [raw]);
    assert.equal(card.detail, undefined);
    assert.equal(card.summary, 'Ran a command');
  }
});
