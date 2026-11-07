// Step labels and their redaction (t-1944; loom docs/specs/comms.md, section 3): a label says what a step did, and never
// carries a secret. Every secret below is made up, in the shape of the real thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandLabel, commands, failWhy, fileName, GONE, part, PRIVATE_FILE, redact, UNPRINTABLE_ONE } from '../src/redact.mjs';
import { claudeCards, claudeSummary, clean, codexCards, MAX_SUMMARY } from '../src/activity.mjs';
import { cleanCards } from '../src/houserunner.mjs';

// Built from pieces, so no whole token sits in this file for a secret scanner to stop a push on.
const j = (...p) => p.join('');
const SECRETS = {
  github: j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  githubPat: j('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL'),
  anthropic: j('sk-', 'ant-api03-', 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe-abcdEFGH'),
  openai: j('sk-', 'proj-', 'abcdefghijklmnopqrstuvwxyz012345'),
  slack: j('xo', 'xb-', '1234567890-0987654321-', 'AbCdEfGhIjKlMnOpQrStUvWx'),
  aws: j('AK', 'IA', 'IOSFODNN7EXAMPLE'),
  google: j('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  jwt: j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
  age: j('AGE-', 'SECRET-KEY-1', 'QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQS'),
  generic: j('f3a9c1d27b8e4f60', 'a5c3d9e1b7f20c4a8d6e3b1f'),
  password: j('hunter2', '-correct-horse'),
  awsSecret: j('wJalrXUtnFEMI/', 'K7MDENG/bPxRfiCYEXAMPLEKEY'),
  awsLower: j('wjalrxutnfemi/', 'k7mdeng/bpxrficyexamplekey'),
  uuidKey: j('3ffccc73-649e-', '45a9-a076-522c2961bda7'),
  dashHex: j('e5b2c9a1d3f4-', 'e6a7b8c9d0e1-f2a3b4c5'),
};
const ALL = Object.values(SECRETS);
/** Which secrets show in `s`, whole or as any 8 characters of one in a row. */
const leaks = (s) => ALL.filter((x) => { for (let i = 0; i + 8 <= x.length; i++) if (String(s).includes(x.slice(i, i + 8))) return true; return false; });

test('redact: known token shapes go, wherever they sit in a line', () => {
  for (const [name, x] of Object.entries(SECRETS)) {
    if (name === 'password') continue; // a plain word: only a flag, an assignment or a URL marks it (below)
    const out = redact(`use ${x} now`);
    assert.deepEqual(leaks(out), [], `${name}: ${out}`);
    assert.match(out, /^use … now$/, name);
  }
});

test('redact: env assignments keep the name and lose the value', () => {
  assert.equal(redact('GH_TOKEN=abc123 gh pr list'), 'GH_TOKEN=… gh pr list');
  assert.equal(redact('export API_KEY="two words"'), 'export API_KEY=…');
  assert.equal(redact("PASSWORD='hunter2' run"), 'PASSWORD=… run');
  assert.equal(redact('--token=abc123 --format=json'), '--token=… --format=…');
});

test('redact: Authorization and cookie headers, Bearer values, secret-named flags and query values', () => {
  assert.equal(redact('curl -H "Authorization: Bearer abcdef123456" https://x.io'), 'curl -H "Authorization: …" https://x.io');
  assert.equal(redact("curl -H 'authorization: token abcdef123456'"), "curl -H 'authorization: …'");
  assert.equal(redact('Cookie: session=abcdef; other=1'), 'Cookie: …');
  assert.equal(redact('sent Bearer abcdefgh12345678'), 'sent Bearer …');
  assert.equal(redact('tool --password hunter2 --api-key "k k" --verbose'), 'tool --password … --api-key … --verbose');
  assert.equal(redact('curl -u bob:hunter2 https://x.io'), 'curl -u … https://x.io');
  assert.equal(redact('https://x.io/cb?code=abc&state=1&access_token=zzz'), 'https://x.io/cb?code=…&state=…&access_token=…');
});

test('redact: a URL\'s user and password go, its host stays', () => {
  assert.equal(redact('git clone https://x-access-token:abc@github.com/o/r.git'), 'git clone https://…@github.com/o/r.git');
  assert.equal(redact('postgres://app:hunter2@db.local:5432/x'), 'postgres://…@db.local:5432/x');
});

test('redact: a PEM private key goes whole', () => {
  // Its body here is short plain parts nothing but the PEM rule would take.
  const out = redact(j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\n', 'keymaterial/oneline\nmorekey/twoline', '\n-----END OPENSSH ', 'PRIVATE KEY-----'));
  assert.equal(out, '…');
  assert.equal(redact(j('x -----BEGIN RSA ', 'PRIVATE KEY-----\nkeymaterial/oneline')), 'x …', 'an unclosed key goes to the end');
});

test('redact: ordinary words stay (task ids, branch names, paths, PR numbers); a UUID goes (it can be a key)', () => {
  for (const s of ['taskstore close t-1929', 'git switch t-1382-recorder-health-component-ledger', 'gh pr checks 603', 'Read src/ui/comms-band.integration.test.ts', 'cv-a9d66284bc9b']) assert.equal(redact(s), s);
  assert.equal(redact('key 3ffccc73-649e-45a9-a076-522c2961bda7 here'), 'key … here');
});

test('commandLabel: a closed vocabulary, `Ran <program>` and for a known one its subcommand and an id; nothing else of the line', () => {
  const cases = [
    ['/bin/bash -lc "cd /home/mark/Code/loom && npm test"', 'Ran npm test'],
    ['deploy-loom steps', 'Ran deploy-loom'],
    ['./bin/check-everything --fast', null],
    ["/bin/bash -lc 'gh pr checks 603 --watch'", 'Ran gh pr checks 603'],
    ['git -C /x/y status --short', 'Ran git status'],
    ['git add -A && git commit -m "fix: the secret thing" && git push origin HEAD', 'Ran git add, git commit, git push'],
    ['npm --prefix web run build', 'Ran npm run build'],
    ['systemctl --user restart loom-http', 'Ran systemctl restart'],
    ['flock /tmp/x.lock mytool steps now', null],
    ['cat .env', 'Ran cat'],
    ['nice -n 19 node --test test/activity.test.mjs 2>&1 | tail -30', 'Ran node'],
    ["sed -n '120,180p' src/delivery.mjs", 'Ran sed'],
    ['rg -n "deliverAsOwner" src', 'Ran rg'],
    ['curl -s https://api.github.com/repos/o/r/pulls', 'Ran curl'],
    ["python3 - <<'EOF'\nimport os\nprint(os.environ['GH_TOKEN'])\nEOF", 'Ran python3'],
    ['taskstore close t-1929 --reason "done, see PR"', 'Ran taskstore close t-1929'],
    ['gh pr view owner/repo#12', 'Ran gh pr view'],
    ['ls -la ~/Code', 'Ran ls'],
    ['cd ~/x', null],
    [['bash', '-lc', 'mysql -pX'], 'Ran bash'],
    [['/usr/bin/git', 'push'], 'Ran git'],
    [['mysql,-pX'], null],
  ];
  for (const [cmd, want] of cases) assert.equal(commandLabel(cmd), want, String(cmd));
});

test('commandLabel: secrets on the command line never reach the label', () => {
  const lines = [
    [`GH_TOKEN=${SECRETS.github} gh pr merge 12 --auto`, 'Ran gh pr merge 12'],
    [`curl -H "Authorization: Bearer ${SECRETS.jwt}" https://user:${SECRETS.password}@api.example.com/x?api_key=${SECRETS.generic}`, 'Ran curl'],
    [`export ANTHROPIC_API_KEY=${SECRETS.anthropic}; claude -p hi`, 'Ran claude'],
    [`echo ${SECRETS.slack} > ~/.config/loom/slack.token`, null],
    [`cat > .env <<EOF\nOPENAI_API_KEY=${SECRETS.openai}\nEOF`, 'Ran cat'],
    [`mytool --password ${SECRETS.password} --key ${SECRETS.generic}`, null],
    [`git push https://x-access-token:${SECRETS.github}@github.com/o/r.git`, 'Ran git push'],
    [`loom secret set CI_TOKEN ${SECRETS.password}`, 'Ran loom'],
    [`gh auth login --with-token ${SECRETS.password}`, 'Ran gh'],
    [`taskstore comment t-12 ${SECRETS.password}`, 'Ran taskstore comment t-12'],
    [`taskstore comment ${SECRETS.password}`, 'Ran taskstore comment'],
    [`git commit ${SECRETS.password}`, 'Ran git commit'],
    [`npm config set //registry.npmjs.org/:_authToken ${SECRETS.password}`, 'Ran npm'],
  ];
  for (const [l, want] of lines) {
    const out = commandLabel(l);
    assert.equal(out, want, l);
    assert.deepEqual(leaks(out ?? ''), [], `${l} → ${out}`);
  }
});

test('redact: base64 secrets with slashes, key: value pairs, any case of bearer', () => {
  for (const s of [`the key is ${SECRETS.awsSecret}`, `Searched for "${SECRETS.awsSecret}"`, `password: ${SECRETS.password}`, `api_key: "${SECRETS.password}"`, `bearer ${SECRETS.password}`]) assert.deepEqual(leaks(redact(s)), [], s);
  for (const ok of ['Read src/ui/Comms2Panel/index.tsx', 'Read useComms2ThreadActivity.ts', 'Edited AuthorizationHeader2.ts', 'Read web/src/components/ui/AgentChatProgress2/IndexPage.tsx']) assert.equal(redact(ok), ok);
});

test('a short mixed key (20 to 31 characters) is redacted; a CamelCase name that reads as words isn\'t', () => {
  const key24 = j('k3Yq9Zt', 'R2mWx8Lp', 'A5vN7cJdQ'); // 24, letters and digits, nothing scattered about it
  assert.equal(key24.length, 24);
  assert.equal(redact(`key ${key24} here`), 'key … here');
  assert.ok(!redact(`token-${j('a7Bc9De1Fg3', 'Hi5Jk7Lm9Np')}-x`).includes('Hi5Jk7'), 'a 22-character key between dashes');
  assert.equal(redact(`Read ${j('a1B2c3D4e5', 'F6g7H8i9J0')}`), 'Read …', 'a lone 20-character key');
  for (const ok of ['useComms2ThreadActivity', 'AuthorizationHeader2Test', 'renderAgentChatProgressList']) assert.equal(redact(`Read ${ok}.ts`), `Read ${ok}.ts`);
});

test('round 3: a relay to a token-shaped name, bare key/pass flags, a flag first, a fragment, other heredoc forms', () => {
  assert.equal(claudeSummary('mcp__loom__relay', { to: SECRETS.github.slice(0, 40), say: 'x' }), 'Messaged another agent: "x"');
  for (const s of [`tool --key ${SECRETS.password}`, `the deploy key: ${SECRETS.password}`, `--token ${SECRETS.password} then push`, `tool --pass ${SECRETS.password}`, `https://x/cb#session=${SECRETS.password}`]) assert.deepEqual(leaks(redact(s)), [], s);
  assert.equal(redact('--token abc then push'), '--token … then push');
  for (const h of [`cat <<\\EOF > x\n${SECRETS.password}\nEOF\nls`, `cat <<'EOF-1' > x\n${SECRETS.password}\nEOF-1\nls`, `cat <<-EOF\n${SECRETS.password}\nEOF\nls`]) assert.deepEqual(commands(h).map((c) => c.words[0]), ['cat', 'ls'], h);
  assert.deepEqual(commands('grep x <<< "$v"\nls').map((c) => c.words[0]), ['grep', 'ls'], 'a here-string has no body');
});

test('a repeated result line doesn\'t add a second why', () => {
  const use = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } };
  const res = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u', is_error: true, content: 'Exit code 1\n# fail 3' }] } };
  assert.equal(claudeCards([use, res, res])[0].summary, 'Run the tests — exit 1: 3 tests failed');
});

test('a content-hashed file name is redacted: the accepted cost of catching keys', () => {
  assert.equal(redact('Read main.a1b2c3d4e5f6a7b8c9d0.js'), 'Read …');
});

test('files: the base name only, never the folders above it; a private file shows as "a private file"', () => {
  // Read, edit and search tools (Claude), file changes (Codex), and a command's reader, search or listing.
  assert.equal(claudeSummary('Read', { file_path: '/home/art/Code/loom/src/delivery.mjs', offset: 120, limit: 61 }, '/home/art/Code/loom'), 'Read delivery.mjs (lines 120–180)');
  assert.equal(claudeSummary('Edit', { file_path: '/home/mark/Code/x/web/src/comms.tsx' }), 'Edited comms.tsx');
  assert.equal(claudeSummary('Read', { file_path: '~/notes/plan.md' }), 'Read plan.md');
  assert.equal(claudeSummary('Grep', { pattern: 'relay', path: '/home/art/Code/loom-box/src' }), 'Searched for "relay" in src');
  assert.equal(claudeSummary('Grep', { pattern: 'token=abc123' }), 'Searched for "token=…"', 'a pattern goes through redact');
  const privates = ['/home/art/.config/loom/tokens.json', '~/.config/loom/comms.key', '/home/mark/.config/gh/hosts.yml', '/srv/app/.env', '.env.local', '/tmp/x/slack.token', 'deploy.key', '/home/art/.config'];
  for (const p of privates) {
    assert.equal(fileName(p), PRIVATE_FILE, p);
    for (const out of [claudeSummary('Read', { file_path: p }), claudeSummary('Write', { file_path: p, content: 'SECRET-CONTENT' }), claudeSummary('Edit', { file_path: p, old_string: 'a', new_string: 'SECRET-CONTENT' }), claudeSummary('Grep', { pattern: 'x', path: p }), claudeSummary('NotebookEdit', { notebook_path: p }), claudeSummary('Bash', { command: 'x', description: `Read ${p}` }), codexCards([{ type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [{ path: p, kind: 'update', diff: 'SECRET-CONTENT' }], status: 'completed' } }])[0].summary]) {
      assert.ok(out.includes(PRIVATE_FILE), `${p} → ${out}`);
      const name = p.split('/').pop();
      assert.ok(!out.includes(name) && !out.includes('.config') && !out.includes('SECRET-CONTENT') && !out.includes('/home'), `${p} → ${out}`);
    }
  }
  for (const p of ['/home/art/.config/loom/tokens.json', '/srv/app/.env']) assert.equal(commandLabel(`cat ${p}`), 'Ran cat', 'a raw command never names a file');
  for (const p of ['src/environment.ts', 'docs/keys.md', 'keyboard.ts', 'config/app.json']) assert.notEqual(fileName(p), PRIVATE_FILE, p);
  for (const p of ['.envrc', 'prod.env', '.env-prod', 'server.pem', 'id_rsa', 'id_ed25519.pub', '.netrc', '.pgpass', 'credentials.json']) assert.equal(fileName(`/x/${p}`), PRIVATE_FILE, p);
});

test('security review 2: a flag\'s value far off, a heredoc after a here-string, a long token with no digits', () => {
  assert.equal(redact(`tool --token          ${SECRETS.password} next`), 'tool --token … next', 'ten spaces before the value');
  assert.equal(redact(`api_key   :   ${SECRETS.password}`), 'api_key   :   …');
  assert.deepEqual(commands(`grep x <<< "$v"; cat <<EOF > out\n${SECRETS.password}\nEOF\nls`).map((c) => c.words[0]), ['grep', 'cat', 'ls'], 'a here-string first hides no heredoc');
  assert.deepEqual(commands(`paste <<A <<'B'\none ${SECRETS.password}\nA\ntwo ${SECRETS.password}\nB\nls`).map((c) => c.words), [['paste'], ['ls']], 'two heredocs on one line, bodies in order');
  assert.deepEqual(leaks(commandLabel(`grep x <<< "$v"; cat <<EOF\n${SECRETS.password}\nEOF`) ?? ''), []);
  const noDigits = j('qWeRtYuIoPaSdFgH', 'jKlZxCvBnMqWeRtY'); // 32, both cases, no digit
  assert.equal(redact(`key ${noDigits}`), 'key …');
  assert.ok(!redact(`a/${noDigits}/b`).includes(noDigits.slice(0, 8)), 'inside a path too');
  for (const ok of ['renderAgentChatProgressListItemComponent', 'useCommsThreadActivityWithAllTheThings']) assert.equal(redact(`Read ${ok}.tsx`), `Read ${ok}.tsx`);
});

test('a label is one printable line of at most 120: no controls, no separators, no bidi or zero-width characters', () => {
  const nasty = 'a\x00b\x07c\x1bd\x7fe\x85f\u2028g\u2029h\u202ei\u200bj\ufeffk\u2066l';
  for (const out of [clean(nasty), claudeSummary('Bash', { description: nasty }), claudeSummary('Read', { file_path: `/x/${nasty}` }), claudeSummary('mcp__loom__relay', { to: 'mark', say: nasty }), codexCards([{ type: 'item.completed', item: { id: 'i', type: 'command_execution', command: `ls ${nasty}`, exit_code: 0, status: 'completed' } }])[0].summary]) {
    assert.ok(!/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(out), JSON.stringify(out));
    assert.ok(out.length <= MAX_SUMMARY);
  }
  assert.equal(clean('x'.repeat(500)).length, MAX_SUMMARY);
  assert.equal(clean('abc', -5), '…', 'a cap below 1 is 1, never a label longer than asked');
});

test('a failure\'s why can\'t push a label past 120, however long its output\'s numbers', () => {
  const out = codexCards([{ type: 'item.completed', item: { id: 'i', type: 'command_execution', command: "/bin/bash -lc 'npm test'", aggregated_output: `${'9'.repeat(200)} failed`, exit_code: 1, status: 'failed' } }])[0].summary;
  assert.ok(out.length <= MAX_SUMMARY, out);
  assert.match(out, /^Ran npm test — exit 1/);
  assert.equal(failWhy({ exit: 1, output: `${'9'.repeat(200)} failed` }), 'exit 1');
});

test('a Bash description is the label, redacted too; a missing one falls back to the short form', () => {
  assert.equal(claudeSummary('Bash', { command: 'npm test', description: 'Run the approvals tests' }), 'Run the approvals tests');
  assert.equal(claudeSummary('Bash', { command: 'gh pr checks 603' }), 'Ran gh pr checks 603');
  assert.deepEqual(leaks(claudeSummary('Bash', { command: 'x', description: `Set GH_TOKEN=${SECRETS.github} and push` })), []);
  assert.ok(claudeSummary('Bash', { description: 'y'.repeat(300) }).length <= MAX_SUMMARY);
});

test('MCP tools: a private store\'s tool in fixed words, never its arguments; a public tool\'s id; a relay\'s who and first line', () => {
  const words = 'PRIVATE-WORDS what Jonathan said about Sam';
  const cases = [
    ['mcp__loom__recall', { query: words }, 'Searched memory'],
    ['mcp__loom__remember', { title: words, content: words }, 'Saved a memory'],
    ['mcp__loom__note_write', { path: `notes/${words}`, body: words }, 'Wrote a note'],
    ['mcp__loom__note_read', { path: words }, 'Read a note'],
    ['mcp__loom__knowledge_write', { page: words }, 'Wrote down a fact'],
    ['mcp__loom__knowledge_recall', { query: words }, 'Looked up what it knows'],
    ['mcp__loom__person', { slug: words }, 'Read a person card'],
    ['mcp__loom__person_merge', { slug: words }, 'Worked on a person card'],
    ['mcp__loom__memory_merge', { target_ref: words }, 'Tended its memory'],
    ['mcp__loom__comms_title', { title: words }, 'Named the thread'],
    ['mcp__loom__comms_whatever', { thread: words }, 'Used its thread'],
    ['mcp__loom__conversation', { id: words }, 'Read a conversation'],
    ['mcp__loom__conversation_digest', { summary: words }, 'Wrote its digest'],
    ['mcp__other__do_thing', { query: words, title: words, path: words }, 'Used a tool'],
    ['mcp__tasks__task_close', { id: 't-1929', reason: words }, 'Used a task tool t-1929'],
    ['mcp__tasks__task_close', { id: words }, 'Used a task tool'],
    ['mcp__tasks__task_hunter2secret', { id: 't-1' }, 'Used a tool'],
    ['mcp__github__pull_request_read', { pullNumber: 612, owner: words }, 'Used a GitHub tool #612'],
  ];
  for (const [tool, input, want] of cases) assert.equal(claudeSummary(tool, input), want, tool);
  const codex = codexCards([{ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'loom', tool: 'remember', arguments: { title: words }, status: 'completed' } }]);
  assert.equal(codex[0].summary, 'Saved a memory');
  assert.equal(claudeSummary('mcp__loom__relay', { to: 'mark', say: 'Can you review loom#612?\nMore words here.' }), 'Messaged mark: "Can you review loom#612?"');
  assert.deepEqual(leaks(claudeSummary('mcp__loom__relay', { to: 'mark', say: `the key is ${SECRETS.anthropic}` })), []);
  assert.equal(claudeSummary('WebFetch', { url: `https://user:${SECRETS.password}@docs.example.com/a?token=x` }), 'Read a web page', 'a host only when the whole URL passes');
  assert.equal(claudeSummary('WebFetch', { url: 'https://docs.example.com/a' }), 'Read a page on docs.example.com');
});

test('a failed MCP call says why by phrase, never its error\'s words', () => {
  const cards = codexCards([{ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'loom', tool: 'note_read', arguments: {}, error: { message: 'ERROR-WORDS: Permission denied for note x' }, status: 'failed' } }]);
  assert.deepEqual(cards.map((c) => [c.summary, c.state]), [['Read a note — not allowed', 'failed']]);
});

test('a plan: the item it\'s on now and how far along', () => {
  const todos = [{ content: 'Read the code', status: 'completed', activeForm: 'Reading the code' }, { content: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests' }, { content: 'Open a PR', status: 'pending' }];
  assert.equal(claudeSummary('TodoWrite', { todos }), 'Plan (1/3): Running the tests');
  const cards = codexCards([
    { type: 'item.started', item: { id: 't', type: 'todo_list', items: [{ text: 'Find the source', completed: false }, { text: 'Write it', completed: false }] } },
    { type: 'item.updated', item: { id: 't', type: 'todo_list', items: [{ text: 'Find the source', completed: true }, { text: 'Write it', completed: false }] } },
  ]);
  assert.deepEqual(cards.map((c) => [c.summary, c.state]), [['Plan (1/2): Write it', 'done']]);
});

test('a failure says why from fixed phrases, never from its output\'s words', () => {
  assert.equal(failWhy({ exit: 1, output: 'ℹ tests 12\nℹ pass 9\nℹ fail 3' }), 'exit 1: 3 tests failed');
  assert.equal(failWhy({ exit: 127, output: 'bash: foo: command not found' }), 'exit 127: command not found');
  assert.equal(failWhy({ exit: 2 }), 'exit 2');
  assert.equal(failWhy({ exit: 1, output: `error: ${SECRETS.github} is bad` }), 'exit 1');
  const codex = codexCards([{ type: 'item.completed', item: { id: 'i', type: 'command_execution', command: "/bin/bash -lc 'npm test'", aggregated_output: `SECRET-OUTPUT ${SECRETS.github}\nTests: 2 failed, 5 passed`, exit_code: 1, status: 'failed' } }]);
  assert.deepEqual(codex.map((c) => [c.summary, c.state]), [['Ran npm test — exit 1: 2 tests failed', 'failed']]);
  const claude = claudeCards([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'npm test', description: 'Run the approvals tests' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: [{ type: 'text', text: `Exit code 1\nSECRET-OUTPUT\n# fail 3` }] }] } },
  ]);
  assert.equal(claude[0].summary, 'Run the approvals tests — exit 1: 3 tests failed');
  assert.ok(!JSON.stringify([codex, claude]).includes('SECRET-OUTPUT'));
});

test('commands: quotes, pipes, chains and heredocs', () => {
  assert.deepEqual(commands('a "b c" | d; e && f').map((c) => [c.words, c.pipe]), [[['a', 'b c'], false], [['d'], true], [['e'], false], [['f'], false]]);
  assert.deepEqual(commands("cat <<'EOF' > x\nsecret\nEOF\nls").map((c) => c.words), [['cat'], ['ls']]);
});

// ─── The gate (coordinator's decision after round 4, t-1944) ───────────────────

test('the gate: each kind keeps its own shape, and anything else is …', () => {
  assert.equal(part('file', 'delivery.mjs'), 'delivery.mjs');
  assert.equal(part('file', 'a'.repeat(61)), GONE, 'too long');
  assert.equal(part('file', 'a"b.ts'), GONE, 'a quote');
  assert.equal(part('file', SECRETS.github), GONE, 'a token is never a file name');
  assert.equal(part('host', 'api.github.com'), 'api.github.com');
  assert.equal(part('host', 'evil.com/x'), GONE);
  assert.equal(part('id', 't-1929'), 't-1929');
  assert.equal(part('id', 'hunter2'), GONE);
  assert.equal(part('count', '40'), '40');
  assert.equal(part('count', 'forty'), GONE);
  assert.equal(part('count', '9'.repeat(10)), GONE);
  assert.equal(part('word', 'checks'), 'checks');
  assert.equal(part('word', 'a b'), GONE);
  assert.equal(part('word', `x=${SECRETS.password}`), GONE);
  assert.equal(part('who', 'mark'), 'mark');
  assert.equal(part('who', SECRETS.github.slice(0, 40)), GONE);
  assert.equal(part('text', `the key is ${SECRETS.anthropic}`), 'the key is …');
  assert.equal(part('text', 'x'.repeat(300), 20).length, 20);
  assert.equal(part('text', `😀${'x'.repeat(10)}`, 3), '😀…', 'never cut inside a surrogate pair');
  assert.equal(part('text', `😀${'x'.repeat(10)}`, 2), '…', 'counted in UTF-16 units, as core counts');
  assert.equal(part('word', 'home/art/.config/x'), GONE, 'a word holds no path');
  assert.equal(part('id', 'hunter2hunter2/x#1'), GONE, 'an id is a number, #N or t-N only');
  assert.equal(part('text', ' ‮\x85'), GONE, 'nothing printable is nothing');
  assert.equal(part('word', ''), GONE);
});

/** Every shape of argument a label is built from, each holding one secret. */
function* corpus() {
  // A plain word (the made-up password) can't be told from a file name or a subcommand where one is shown, so it goes
  // only where something marks it as a secret; every secret with a shape goes everywhere.
  const marked = (x) => [`FOO=${x} make test`, `mytool --token ${x}`, `mytool --password=${x}`, `curl https://u:${x}@h.io/`, `curl -H "Authorization: ${x}" h.io`, `loom secret set NAME ${x}`, `cat <<EOF\n${x}\nEOF`, `gh pr checks 12 ${x}`, `taskstore close ${x}`];
  for (const c of marked(SECRETS.password)) yield [`password: ${c}`, () => commandLabel(c) ?? ''];
  for (const t of [['WebFetch', { url: `https://u:${SECRETS.password}@h.io/?token=${SECRETS.password}` }], ['mcp__loom__remember', { title: SECRETS.password }], ['mcp__tasks__task_close', { id: SECRETS.password }], ['Bash', { command: 'x', description: `password: ${SECRETS.password}` }]]) yield [`password: ${t[0]}`, () => claudeSummary(...t)];
  // Shell commands: a closed vocabulary shows no argument at all, so every secret, the plain password too, goes in every
  // position, the reviewer's cases (2026-11-07) among them.
  for (const [name, x] of Object.entries(SECRETS)) {
    for (const cmd of [
      `cat <<! > ~/.pgpass\n${x}\n!`, `cat <<'' > f\n${x}\n\necho`, `cat > f <<EOF\n EOF\n${x}\nEOF`, `bash -lc 'cat > f <<'"'"'EOF'"'"'\n${x}\nEOF\n'`,
      `cd /x && sh -ec 'mysql -h db -p${x} prod'`, `bash -ilc 'psql -W ${x}'`, `python3 -Bc '${x}(1)'`, `perl -pe 's/old/${x}/' f`, `perl -ne 'print if /${x}/' f`,
      `jq --arg pw '${x}' '.x' f.json`, `yq e '.token = ${x}' -i f.yaml`, `wget --password ${x}.io https://example.com/x`, `curl --oauth2-bearer ${x}.io https://a.io`,
      `xargs -a /home/art/.config/${x}.txt curl`, `find / -path '/home/art/.config/${x}/*'`, `fd /home/art/.config/${x}`, `diff <(echo ${x}) f`,
      `sudo -g ${x} cmd`, `timeout 2.5 ${x}`, `curl -o ${x}.json https://a.io`, `ftp -n host <<!\nuser art ${x}\n!`, `${'cd a; '.repeat(332)}${x}`,
      `sshpass -p ${x} ssh h`, `mysql -p${x} db`, `/home/art/.config/${x}.sh`, `~/.config/${x}`,
    ]) yield [`${name}: ${cmd.slice(0, 80)}`, () => commandLabel(cmd) ?? ''];
    for (const argv of [[x], ['mysql', `-p${x}`], [`/x/${x}`], [`mysql,-p${x}`], ['bash', '-lc', `echo ${x}`]]) yield [`${name}: argv ${argv[0].slice(0, 30)}`, () => commandLabel(argv) ?? ''];
    // The house boundary: a card a house sends is redacted there too.
    if (name !== 'password') yield [`${name}: cleanCards`, () => cleanCards([{ id: 'c', at: 'x', tool: 'Bash', summary: `Ran ${x}`.slice(0, 120), state: 'done' }])[0]?.summary ?? ''];
    // Text parts with something marking the secret: a description, a pattern, a first line, a plan's item.
    for (const t of [`password = ${x}`, `machine github.com login art password ${x}`, `sshpass -p ${x} ssh h`, `mysql -p${x} db`, `"token" => "${x}"`, `Read /home/art/.config/${x}`, `PASSWORD: ${x}`]) {
      yield [`${name}: description ${t.slice(0, 40)}`, () => claudeSummary('Bash', { command: 'x', description: t })];
      yield [`${name}: relay ${t.slice(0, 40)}`, () => claudeSummary('mcp__loom__relay', { to: 'mark', say: t })];
      yield [`${name}: grep ${t.slice(0, 40)}`, () => claudeSummary('Grep', { pattern: t })];
    }
    yield [`${name}: long path`, () => claudeSummary('Read', { file_path: `/${'a'.repeat(2000)}/${x}` })];
  }
  for (const [name, x] of Object.entries(SECRETS).filter(([k]) => k !== 'password')) {
    // Shell commands: every position a short form used to read.
    for (const cmd of [
      `cat ${x}`, `cat /tmp/${x}/a.ts`, `sed -n 1,${x}p f`, `head -n ${x} f`, `tail -n 5 ${x}`, `wc -l ${x}`, `jq . ${x}`, `diff a ${x}`,
      `rg ${x} src`, `rg -e ${x} -e y src`, `rg -f ${x} src`, `rg -f${x} src`, `rg x ${x}`, `grep -r "${x}" .`, `git grep ${x}`,
      `find . -name ${x}`, `fd ${x}`, `ls ${x}`, `curl https://${x}.example.com/`, `curl https://u:${x}@h.io/`, `curl -H "Authorization: ${x}" h.io`,
      `python3 -m ${x}`, `python3 ${x}`, `python3 /x/${x}.py`, `node --test ${x}`, `node ${x}`, `node -e "${x}"`,
      `git ${x}`, `git push ${x}`, `gh pr view ${x}`, `gh pr checks 12 ${x}`, `npm run ${x}`, `taskstore close ${x}`, `loom secret set NAME ${x}`,
      `${x} --help`, `./bin/${x}`, `FOO=${x} make test`, `env TOKEN=${x} npm test`, `mytool --token ${x}`, `mytool --password=${x}`,
      `cat <<EOF\n${x}\nEOF`, `cat <<\\EOF\n${x}\nEOF`, `x <<< "${x}"; cat <<'E'\n${x}\nE`, `echo ${x} | tee f`, `/bin/bash -lc "rg '${x}' src"`,
    ]) yield [`${name}: ${cmd}`, () => commandLabel(cmd) ?? ''];
    // Claude tools: every argument a label reads.
    const tools = [
      ['Bash', { command: `npm test ${x}` }], ['Bash', { command: 'x', description: `Push with ${x}` }],
      ['Read', { file_path: `/home/art/${x}` }], ['Read', { file_path: `/x/${x}.ts`, offset: x, limit: x }], ['Edit', { file_path: x }],
      ['Write', { file_path: `/tmp/${x}`, content: x }], ['NotebookEdit', { notebook_path: `/x/${x}.ipynb` }],
      ['Grep', { pattern: x, path: `/x/${x}` }], ['Glob', { pattern: `**/${x}` }], ['Glob', { pattern: `${x}/**` }],
      ['WebSearch', { query: x }], ['WebFetch', { url: `https://${x}.io/` }], ['WebFetch', { url: `https://u:${x}@h.io/?token=${x}` }],
      ['Task', { description: x }], ['SendMessage', { to: x, message: x }], ['TodoWrite', { todos: [{ content: x, status: 'in_progress', activeForm: x }] }],
      ['Skill', { skill: x }], [x, { a: x }], [`mcp__x__${x}`, { q: x }],
      ['mcp__loom__relay', { to: x, say: x }], ['mcp__loom__remember', { title: x }], ['mcp__tasks__task_close', { id: x }],
      ['mcp__github__pull_request_read', { pullNumber: x }],
    ];
    for (const [tool, input] of tools) yield [`${name}: ${tool} ${JSON.stringify(input).slice(0, 60)}`, () => claudeSummary(tool, input)];
    // Codex items.
    for (const item of [
      { type: 'command_execution', command: `/bin/bash -lc 'rg ${x} src'`, aggregated_output: `${x}\n3 failed`, exit_code: 1, status: 'failed' },
      { type: 'file_change', changes: [{ path: `/a/${x}`, diff: x }, { path: x }] },
      { type: 'mcp_tool_call', tool: `t_${x}`, arguments: { id: x }, error: { message: x }, status: 'failed' },
      { type: 'web_search', query: x },
      { type: 'todo_list', items: [{ text: x, completed: false }] },
    ]) yield [`${name}: codex ${item.type}`, () => codexCards([{ type: 'item.completed', item: { id: 'i', ...item } }])[0]?.summary ?? ''];
  }
}

test('property: a secret in any argument position never survives into a label, and every label is one line of 120 or less', () => {
  let n = 0;
  for (const [what, make] of corpus()) {
    const out = make();
    assert.deepEqual(leaks(out), [], `${what} → ${out}`);
    assert.ok(out.length <= MAX_SUMMARY, `${what} → ${out.length}`);
    assert.ok(!UNPRINTABLE_ONE.test(out), `${what} → unprintable`);
    n++;
  }
  assert.ok(n >= 800, `${n} labels checked`);
});

test('round 4: a raw search never shows its pattern, its places or a pattern file', () => {
  for (const c of ['rg -f /home/art/.config/loom/pat.txt src', 'rg -f/home/art/.config/loom/pat.txt src', 'rg --ignore-file /home/art/.config/ig relay src', 'rg --pre /usr/local/bin/pre relay src', 'rg -e foo -e bar src']) assert.equal(commandLabel(c), 'Ran rg', c);
  assert.equal(commandLabel('grep --file=/srv/pats.txt -r .'), 'Ran grep');
});

test('round 4: NotebookEdit and Glob labels show a base name or a last part, never a folder; unknown tools are "Used a tool"', () => {
  assert.equal(claudeSummary('NotebookEdit', { notebook_path: '/home/art/Code/x/analysis.ipynb' }), 'Edited analysis.ipynb');
  assert.equal(claudeSummary('NotebookEdit', { notebook_path: '/home/art/.config/loom/x.ipynb' }), 'Edited a private file');
  assert.equal(claudeSummary('Glob', { pattern: 'src/**/*.test.mjs' }), 'Looked for files: *.test.mjs');
  assert.equal(claudeSummary('Glob', { pattern: '/home/art/.config/**/*.json' }), 'Looked for files: a private file');
  assert.equal(claudeSummary('Glob', { pattern: '**/*.key' }), 'Looked for files: a private file');
  assert.equal(claudeSummary('SomeNewTool', { a: 'x' }), 'Used a tool');
  assert.equal(claudeSummary('mcp__x__brand_new', { a: 'x' }), 'Used a tool');
  assert.equal(claudeSummary('SendMessage', { to: SECRETS.github.slice(0, 40), message: 'hi' }), 'Messaged a helper: "hi"');
});

test('contract, decided (closed vocabulary): a raw fetch, test run, module or script is `Ran <program>` alone', () => {
  assert.equal(commandLabel('curl -s https://api.github.com/repos/o/r'), 'Ran curl');
  assert.equal(commandLabel('node --test /home/art/Code/x/test/activity.test.mjs'), 'Ran node');
  assert.equal(commandLabel('python3 -m pytest -q'), 'Ran python3');
  assert.equal(commandLabel('python3 /home/art/Code/x/scripts/build_index.py --all'), 'Ran python3');
  assert.equal(commandLabel('/home/art/.config/loom/hook.sh'), null, 'a script run by its own path names no program');
  // A Claude Bash description is the label: through the gate as a whole, a private path in it named "a private file".
  assert.equal(claudeSummary('Bash', { command: 'x', description: 'Read /home/art/.config/gh/hosts.yml' }), 'Read a private file');
  assert.equal(claudeSummary('Bash', { command: 'x', description: 'Check the .env and deploy.key files' }), 'Check the a private file and a private file files');
  // A tool's structured arguments keep their detail: a page's host, a file's base name.
  assert.equal(claudeSummary('WebFetch', { url: 'https://api.github.com/x' }), 'Read a page on api.github.com');
});

test('cleanCards, the house boundary: a card over 120, with any unprintable character, or with a bad id or state is dropped, every time', () => {
  const ok = { id: 'c1', at: 'x', tool: 'Bash', summary: 'Ran npm test', state: 'done' };
  const bad = ['a b', 'a‮b', 'a\x85b', 'a​b', 'a\x00b', 'x'.repeat(121)].map((summary, i) => ({ ...ok, id: `b${i}`, summary }));
  // Twice in a row each, so a stateful (/g) check would let the second through.
  const out = cleanCards([ok, ...bad, ...bad, { ...ok, id: 'bad id!' }, { ...ok, id: 'c2', state: 'weird' }, { ...ok, id: 'c3' }]);
  assert.deepEqual(out.map((c) => c.id), ['c1', 'c3']);
});

test('invisible format characters, tag characters and lone surrogates never reach a label; cleanCards drops them', () => {
  const invisibles = ['\u{E0041}', '⁪', '⁯', '᠎', '￹', '￻', '͏', 'ㅤ', '\ud800', '\udc00', '­', '؜', '️'];
  for (const ch of invisibles) {
    const out = claudeSummary('Bash', { command: 'x', description: `a${ch}b` });
    assert.ok(!UNPRINTABLE_ONE.test(out), `${JSON.stringify(ch)} → ${JSON.stringify(out)}`);
    assert.deepEqual(cleanCards([{ id: 'c', at: 'x', tool: 'Bash', summary: `a${ch}b`, state: 'done' }]), [], JSON.stringify(ch));
  }
  // A label of 60 emoji is 120 UTF-16 units: kept whole, as core counts; one more and it's cut, never mid-pair.
  assert.equal(clean('😀'.repeat(60)).length, 120);
  assert.ok(clean('😀'.repeat(61)).length <= 120 && !/[\ud800-\udbff]…/.test(clean('😀'.repeat(61))));
});

test('the input cut drops a trailing partial word: it never leaves half a token', () => {
  const tok = j('gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  const long = `${'word '.repeat(399)}xx ${tok}`; // the token straddles the 2000-character cut
  assert.ok(!redact(long).includes('ghp_ABCD'));
  assert.ok(!part('text', long).includes('ghp_'));
});

// ─── The second independent read (2026-11-07): every input it reported, as found ──────────────────────────────────

const READ2 = [
  // Tokens split into short pieces, and provider shapes, each built from pieces so the file holds none whole.
  j('S', 'G.WZ1SkSx3dESbhhmB-uc78c.', 'KwfiE_h5fLqjV7rFiCr-k2G6F08GxmPeWrVMkFk_PXq'), j('g2Vcw7F7-', '28JNCb7u-dsuqsWNx-m7OqmaZb'), j('6pYVVtA5i7.', 'PEF6NuEObn.tg82auNuTl'),
  j('cPXysLcvta/', 'NBQhIOUiST/mufBvlXblU'), j('cikckuts1b4f_', 'fbr5xw7ocs50_4vlax6snlxes'), j('HfbHfFVPamN4L/', 'v/a318kmc7=='), j('eyJ', 'hbGci.eyJzdWIi.sig'),
  j('sk_', 'live_', 'dfvRdkNPgkpqgpdBAWlhQCZY'), j('rk_', 'test_', 'dfvRdkNPgkpqgpdBAWlhQCZY'), j('pk_', 'live_', 'dfvRdkNPgkpqgpdBAWlhQCZY'),
  j('ya', '29.', 'a0AfH6SMBx-kq3_xJ9'), j('py', 'pi-', 'AgEIcHlwaS5vcmcCJGFh'),
];
const MARKED = ['Zx9qWerty', 'Zx9q Werty', 'correct horse battery staple', 'S3cretPw', '482913'];

test('read 2: split and provider-shaped tokens never show, in any free-text place or from a house', () => {
  for (const x of READ2) {
    const outs = [
      claudeSummary('Bash', { command: 'x', description: `Rotate ${x} now` }), claudeSummary('mcp__loom__relay', { to: 'x', say: `key ${x}` }),
      claudeSummary('Grep', { pattern: x }), claudeSummary('WebSearch', { query: x }), claudeSummary('Task', { description: x }),
      claudeSummary('TodoWrite', { todos: [{ content: `Rotate ${x}`, status: 'in_progress', activeForm: `Rotating ${x}` }] }),
      codexCards([{ type: 'item.completed', item: { id: 'p', type: 'todo_list', items: [{ text: `Rotate ${x}`, completed: false }] } }])[0].summary,
      cleanCards([{ id: 'c', at: 'x', tool: 'Bash', summary: `Ran ${x}`.slice(0, 120), state: 'done' }])[0]?.summary ?? '',
    ];
    for (const out of outs) assert.ok(!out.includes(x.slice(4, 14)), `${x} → ${out}`);
  }
});

test('read 2: a secret-named word, a joining word, then a value; quoted, flagged or scheme-less passwords', () => {
  const phrasings = (v) => [`access_token ${v}`, `client_secret ${v}`, `clientSecret ${v}`, `PGPASSWORD ${v}`, `export AWS_SECRET_ACCESS_KEY ${v}`,
    `Set GITHUB_TOKEN ${v}`, `password is ${v}`, `token was ${v}`, `token→${v}`, `TOKEN := ${v}`, `password "${v}"`, `password '${v}'`, `passphrase "${v}"`,
    `pw: ${v}`, `passcode ${v}`, `PIN ${v}`, `authorization header ${v}`, `Set cookie to ${v}`, `mysql -u root -p'${v}'`, `mysql -u root -p"${v}"`,
    `-p${v}`, `zip -P ${v} f`, `openssl enc -k ${v}`, `x --cred ${v}`, `x --pat ${v}`, `curl -uuser:${v} h`, `smbclient -U user%${v}`,
    `htpasswd -b f user ${v}`, `use //user:${v}@host`, `user:${v}@host:repo`, `ftp user:${v}@host`];
  // A value with a space in it, unquoted, has no end anyone can find: only quoted phrasings carry one.
  const cases = MARKED.flatMap((v) => phrasings(v).filter((t) => !/\s/.test(v) || t.includes(`"${v}"`) || t.includes(`'${v}'`)).map((t) => [v, t]));
  assert.ok(cases.length > 100);
  for (const [v, t] of cases) {
    for (const out of [redact(t), claudeSummary('Bash', { command: 'x', description: t }), claudeSummary('mcp__loom__relay', { to: 'x', say: t }), cleanCards([{ id: 'c', at: 'x', tool: 'B', summary: t.slice(0, 120), state: 'done' }])[0]?.summary ?? '']) {
      assert.ok(!out.includes(v), `${t} → ${out}`);
    }
  }
});

test('read 2: heredocs with $\'EOF\', "$D" or ~ delimiters; the house boundary; Glob\'s private check; skills; addresses; invisibles', () => {
  assert.equal(commandLabel("cat <<$'EOF' > f\ngh pr view 482913\nEOF"), 'Ran cat');
  assert.equal(commandLabel('cat <<"$D" > f\ngit log 482913\n$D'), 'Ran cat');
  assert.equal(commandLabel('cat <<~EOF\n  gh pr view 1\n  EOF\nls'), 'Ran cat, ls');
  assert.ok(!commandLabel('cat <<~EOF\n  gh pr view 482913\n  EOF').includes('482913'));
  // cleanCards: a private path named; a token-shaped id or tool dropped; a time that isn't one replaced.
  assert.equal(cleanCards([{ id: 'c', at: 'x', tool: 'B', summary: 'Read /home/art/.config/gh/hosts.yml', state: 'done' }])[0].summary, 'Read a private file');
  assert.deepEqual(cleanCards([{ id: j('gh', 'p_abcdefghijklmnopqrstuvwxyz0123'), at: 'x', tool: 'B', summary: 's', state: 'done' }]), []);
  assert.deepEqual(cleanCards([{ id: 'c', at: 'x', tool: j('sk-', 'ant-api03-abcdefghijklmnopqrstuvwxyz'), summary: 's', state: 'done' }]), []);
  assert.notEqual(cleanCards([{ id: 'c', at: '12345678901234567890', tool: 'B', summary: 's', state: 'done' }])[0].at, '12345678901234567890');
  const cards = claudeCards([{ type: 'assistant', timestamp: j('gh', 'p_abcdefghijklmnopqrstuvwxyz0123'), message: { content: [{ type: 'tool_use', id: 'u', name: j('mcp__x__gh', 'p_abcdefghijklmnopqrstuvwxyz0123'), input: {} }] } }]);
  assert.ok(!JSON.stringify(cards).includes('abcdefghijklmnop'), JSON.stringify(cards));
  // Glob: the same private check as Read, on any part, with \\ too.
  for (const g of ['C:\\Users\\art\\.config\\gh\\hosts.yml', '/x/credentials', '/x/id_rsa', '**/.kube/config', 'secrets.json']) assert.equal(claudeSummary('Glob', { pattern: g }), 'Looked for files: a private file', g);
  for (const p of ['.credentials.json', '/x/.codex/auth.json', '~/.docker/config.json', '~/.kube/config', 'kubeconfig', '.vault-token', '.dockercfg', '_netrc', '.htpasswd', '.ENV', 'prod.ENV', 'ID_RSA', 'Credentials', 'credentials.yml', 'application_default_credentials.json', 'client_secret_123.json', 'secrets.json', 'token.txt', 'password.txt', 'secring.gpg']) assert.equal(claudeSummary('Read', { file_path: p }), 'Read a private file', p);
  assert.equal(claudeSummary('Task', { description: 'Read ~/.kube/config and fix' }), 'Started a helper: Read a private file and fix');
  assert.equal(claudeSummary('mcp__loom__relay', { to: 'jonathan@sleepunit.com', say: 'hi' }), 'Messaged another agent: "hi"');
  assert.equal(claudeSummary('Skill', { skill: 'hunter2:S3cr3t' }), 'Used a skill');
  assert.equal(claudeSummary('Skill', { skill: 'superpowers:brainstorming' }), 'Used the superpowers:brainstorming skill');
  const split = j('ghp_abcdefghijkl', '\u200bmnopqrstuvwx\u200byz0123456789');
  assert.ok(!claudeSummary('Bash', { command: 'x', description: `use ${split}` }).includes('abcdefghijkl'));
  assert.equal(claudeSummary('WebFetch', { url: 'https://example.com/x?token=abc' }), 'Read a web page');
});

test('read 2: every invisible it found is gone from a label and refused at the house boundary', () => {
  const found = ['\u0600', '\u0605', '\u06dd', '\u070f', '\u0890', '\u08e2', '\u{110BD}', '\u{110CD}', '\u{13430}', '\u{1BCA0}', '\u{1D173}', '\u{E0100}', '\u{E01EF}', '\u2800', '\uffff', '\ue000', 'e\u0301\u0302\u0303\u0304'];
  for (const ch of found) {
    const out = claudeSummary('Bash', { command: 'x', description: `a${ch}b` });
    assert.ok(!UNPRINTABLE_ONE.test(out), `${JSON.stringify(ch)} → ${JSON.stringify(out)}`);
    assert.deepEqual(cleanCards([{ id: 'c', at: 'x', tool: 'B', summary: `a${ch}b`, state: 'done' }]).filter((c) => UNPRINTABLE_ONE.test(c.summary)), [], JSON.stringify(ch));
  }
});
