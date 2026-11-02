// Runners (loom docs/specs/agent-runtime.md, section 3): one interface over the harnesses, here against stand-ins
// for Claude Code (`claude --bg`) and Codex (`codex exec --json`): start a body with a brief, feed it mid-turn, resume
// it from its slot, end it. And bodies (src/bodies.mjs): whoever needs a body asks the runtime, which picks the model
// and starts it through the runner interface (test obligation 1's runtime side, with a fake runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { staticAccounts } from '../src/accounts.mjs';
import { endBody, feedBody, forgetBody, listBodies, readBody, resumeBody, startBody } from '../src/bodies.mjs';
import { setModels } from '../src/models.mjs';
import { ClaudeRunner, CodexRunner, RunnerError, runnerFor } from '../src/runners.mjs';
import { scratch } from './scratch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const until = async (f, ms = 10_000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); } };

function harness() {
  const D = scratch('rt-harness-');
  const inbox = join(D, 'inbox');
  const env = { ...process.env, FAKE_HARNESS: D };
  return { D, inbox, env, argv: () => lines(join(D, 'argv.log')) };
}

const BRIEF = 'You are Art, in a DM with Loren.\nSECRET-ISH MESSAGE TEXT: what did we decide?';

test('Claude Code: a body starts with its brief on stdin (never argv), is found by its spawn token, and has a slot', () => {
  const h = harness();
  const r = new ClaudeRunner({ claude: join(here, 'fake-claude.mjs'), jobsDir: join(h.D, 'jobs'), args: ['--dangerously-skip-permissions'], inboxDir: h.inbox, sleep: () => {} });
  const b = r.start({ brief: BRIEF, model: 'claude-sonnet-5', cwd: h.D, env: h.env, deny: ['mcp__x__send'] });
  assert.equal(b.harness, 'claude');
  assert.match(b.id, /^[0-9a-f]{8}$/);
  assert.equal(b.slot.harness, 'claude');
  const bg = h.argv().find((a) => a[0] === '--bg');
  assert.deepEqual(bg, ['--bg', '--model', 'claude-sonnet-5', '--dangerously-skip-permissions', '--disallowedTools', 'mcp__x__send']);
  assert.equal(JSON.stringify(h.argv()).includes('SECRET-ISH'), false);
  // Its brief, with the spawn token on line 2 so line 1 stays the brief's opening.
  const intent = JSON.parse(readFileSync(join(h.D, 'jobs', b.id, 'state.json'), 'utf-8')).intent.split('\n');
  assert.equal(intent[0], 'You are Art, in a DM with Loren.');
  assert.match(intent[1], /^\(bridge spawn token [0-9a-f]{8}: ignore this line\)$/);
  assert.equal(intent[2], 'SECRET-ISH MESSAGE TEXT: what did we decide?');
  assert.equal(r.status(b), 'working');
});

test('Claude Code: fed mid-turn through its inbox (the hook\'s layout and lock); a turn that\'s over is resumed from its slot', () => {
  const h = harness();
  const r = new ClaudeRunner({ claude: join(here, 'fake-claude.mjs'), jobsDir: join(h.D, 'jobs'), inboxDir: h.inbox, sleep: () => {} });
  const b = r.start({ brief: 'hello', model: 'm', cwd: h.D, env: h.env });
  assert.deepEqual(JSON.parse(readFileSync(join(h.inbox, b.id, 'meta.json'), 'utf-8')).bridge, 'runtime');
  assert.deepEqual(r.feed(b, { id: 'm1', text: 'one more thing' }), { fed: true });
  const pending = lines(join(h.inbox, b.id, 'pending.jsonl'));
  assert.deepEqual(pending.map((p) => [p.id, p.text, p.msg]), [['m1', 'one more thing', 'm1']]);
  assert.equal(typeof pending[0].t, 'number');
  // Its turn ends: feeding says to resume.
  const job = join(h.D, 'jobs', b.id, 'state.json');
  writeFileSync(job, JSON.stringify({ ...JSON.parse(readFileSync(job, 'utf-8')), state: 'done' }));
  assert.equal(r.status(b), 'idle');
  assert.deepEqual(r.feed(b, { text: 'later' }), { fed: false, reason: 'its turn is over: resume it' });
  const slot = r.slotOf(b);
  const again = r.resume(slot, { brief: 'later', model: 'm', cwd: h.D, env: h.env });
  assert.notEqual(again.id, b.id);
  assert.deepEqual(again.slot, slot);
  assert.deepEqual(h.argv().filter((a) => a[0] === '--bg').at(-1).slice(-2), ['--resume', slot.session]);
  // End: stopped, and its inbox closed (the hook then hands over nothing).
  r.end(again, h.env);
  assert.equal(r.status(again), 'idle');
  assert.ok(existsSync(join(h.inbox, again.id, 'closed')));
  assert.equal(r.feed(again, { text: 'x' }).fed, false);
  assert.throws(() => r.resume({ harness: 'codex', session: 'x' }, {}), RunnerError);
});

test('Claude Code: no inbox dir, no feeding; a launch that fails or claims nothing says so', () => {
  const h = harness();
  const r = new ClaudeRunner({ claude: join(here, 'fake-claude.mjs'), jobsDir: join(h.D, 'jobs'), sleep: () => {}, claimPolls: 2 });
  const b = r.start({ brief: 'x', model: 'm', cwd: h.D, env: h.env });
  assert.match(r.feed(b, { text: 'y' }).reason, /no inbox dir/);
  writeFileSync(join(h.D, 'refuse'), '');
  assert.throws(() => r.start({ brief: 'x', model: 'm', cwd: h.D, env: h.env }), /claude --bg didn't start: Error: not logged in/);
  const quiet = new ClaudeRunner({ claude: join(here, 'fake-claude.mjs'), jobsDir: join(h.D, 'elsewhere'), sleep: () => {}, claimPolls: 2 });
  spawnSync('rm', [join(h.D, 'refuse')]);
  assert.throws(() => quiet.start({ brief: 'x', model: 'm', cwd: h.D, env: h.env }), /started nothing this runner could find/);
});

test('Codex: a body is one exec process, brief on stdin, keyed for its inbox; fed while it works, resumed by thread', async () => {
  const h = harness();
  const r = new CodexRunner({ codex: join(here, 'fake-codex.mjs'), profile: 'shuttle', runsDir: join(h.D, 'runs'), inboxDir: h.inbox });
  const b = r.start({ brief: BRIEF, model: 'gpt-x', cwd: h.D, env: { ...h.env, CLAUDE_CODE_OAUTH_TOKEN: 'nope' } });
  assert.equal(b.harness, 'codex');
  await until(() => r.slotOf(b));
  const first = h.argv()[0];
  assert.equal(first.body, b.id);
  assert.equal(first.inbox, h.inbox);
  assert.deepEqual(first.claude, [], 'a Codex body never sees Claude Code\'s session keys');
  assert.deepEqual(first.args.slice(0, 9), ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', '-p', 'shuttle', '-m', 'gpt-x']);
  assert.equal(JSON.stringify(first.args).includes('SECRET-ISH'), false);
  assert.equal(lines(join(h.D, 'briefs.log'))[0], BRIEF);
  assert.equal(r.status(b), 'working');
  assert.deepEqual(r.feed(b, { text: 'and this' }), { fed: true });
  assert.equal(lines(join(h.inbox, b.id, 'pending.jsonl'))[0].text, 'and this');
  writeFileSync(join(h.D, 'finish'), '');
  await until(() => r.status(b) === 'idle');
  assert.equal(r.feed(b, { text: 'x' }).fed, false);
  const slot = r.slotOf(b);
  assert.match(slot.session, /^th-\d+$/);
  spawnSync('rm', [join(h.D, 'finish')]);
  const again = r.resume(slot, { brief: 'continue', model: 'gpt-x', cwd: h.D, env: h.env });
  await until(() => h.argv().length === 2);
  const args = h.argv()[1].args;
  assert.deepEqual(args.slice(args.indexOf('resume'), args.indexOf('resume') + 2), ['resume', slot.session]);
  await until(() => r.status(again) === 'working');
  r.end(again);
  await until(() => r.status(again) !== 'working');
  assert.ok(existsSync(join(h.inbox, again.id, 'closed')));
  // Codex can't deny tools by name: a body that would keep them isn't started.
  assert.throws(() => r.start({ brief: 'x', model: 'm', cwd: h.D, env: h.env, deny: ['send'] }), /can't deny tools/);
});

test('runnerFor builds each from the runtime\'s settings; an unknown harness is refused', () => {
  const c = runnerFor('claude', { LOOM_RUNTIME_CLAUDE: '/x/claude', LOOM_RUNTIME_CLAUDE_ARGS: '["--dangerously-skip-permissions"]', LOOM_RUNTIME_INBOX_DIR: '/i' });
  assert.deepEqual([c.claude, c.args, c.inbox.dir], ['/x/claude', ['--dangerously-skip-permissions'], '/i']);
  const x = runnerFor('codex', { LOOM_RUNTIME_CODEX_PROFILE: 'shuttle' });
  assert.deepEqual([x.codex, x.profile, x.inbox], ['codex', 'shuttle', null]);
  assert.throws(() => runnerFor('gemini'), /no runner for harness/);
});

/** A runner that only records: bodies.mjs's view of the runner interface. */
function fakeRunner(harness, seen) {
  let n = 0;
  const state = {};
  return {
    harness,
    start(o) { const id = `${harness === 'claude' ? 'c' : 'x'}000000${n++}`; seen.push(['start', harness, o.model, o.brief]); state[id] = 'working'; return { id, harness, model: o.model, slot: { harness, session: `s-${id}` } }; },
    resume(slot, o) { const id = `r000000${n++}`; seen.push(['resume', harness, o.model, slot.session]); state[id] = 'working'; return { id, harness, model: o.model, slot }; },
    feed(b, m) { seen.push(['feed', b.id, m.text]); return state[b.id] === 'working' ? { fed: true } : { fed: false, reason: 'its turn is over: resume it' }; },
    end(b) { seen.push(['end', b.id]); state[b.id] = 'idle'; },
    status: (b) => state[b.id] ?? 'unknown',
    slotOf: (b) => ({ harness, session: `s-${b.id}` }),
  };
}

test('a body is asked of the runtime: it picks the model, starts it through the runner, and keeps a record by id', async () => {
  const env = { HOME: scratch('rt-bodies-'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_RUNTIME_SCORECARDS: 'off' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  setModels(env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }, { id: 'gpt', harness: 'codex', family: 'openai' }], agent: 'art', prefer: ['opus'] });
  const seen = [];
  const runners = { claude: fakeRunner('claude', seen), codex: fakeRunner('codex', seen) };
  const acct = (name, provider, usage = {}) => ({ name, provider, credentials: [{ kind: 'k', status: 'valid' }], usage });
  const o = { runner: (h) => runners[h], accounts: staticAccounts({ accounts: [acct('max', 'anthropic', { '7d': 0.99 }), acct('pro', 'openai')] }), now: () => new Date('2026-11-02T12:00:00Z') };
  // opus is preferred but out of quota: the body runs on gpt, through the codex runner.
  const b = await startBody(env, { agent: 'art', brief: 'the wake', venue: 'wake', place: 'schedule:reflect' }, o);
  assert.deepEqual([b.body, b.model, b.harness, b.family, b.kind, b.account], ['codex:x0000000', 'gpt', 'codex', 'openai', 'scheduled', 'pro']);
  assert.deepEqual(seen[0], ['start', 'codex', 'gpt', 'the wake']);
  // The record has no brief.
  const rec = readBody(env, b.body);
  assert.equal(JSON.stringify(rec).includes('the wake'), false);
  assert.equal(rec.place, 'schedule:reflect');
  assert.deepEqual(feedBody(env, b.body, { text: 'also' }, o), { fed: true });
  assert.deepEqual(listBodies(env, o).map((x) => [x.body, x.status]), [['codex:x0000000', 'working']]);
  endBody(env, b.body, o);
  assert.equal(feedBody(env, b.body, { text: 'x' }, o).fed, false);
  // Resumed by its id: the same harness (its slot is a Codex thread), the model chosen again.
  const r = await resumeBody(env, { body: b.body, brief: 'next' }, o);
  assert.deepEqual([r.harness, r.model, r.resumed, r.slot.session], ['codex', 'gpt', 'codex:x0000000', 's-x0000000']);
  // Resumed from a slot another machine kept.
  const s = await resumeBody(env, { slot: { harness: 'claude', session: 'abc' }, agent: 'art', venue: 'session', brief: 'hi' }, { ...o, accounts: staticAccounts({ accounts: [acct('max', 'anthropic')] }) });
  assert.deepEqual([s.harness, s.model, s.kind], ['claude', 'opus', 'live']);
  assert.deepEqual(seen.at(-1), ['resume', 'claude', 'opus', 'abc']);
  forgetBody(env, b.body);
  assert.throws(() => readBody(env, b.body), /no body/);
  await assert.rejects(startBody(env, { agent: 'art', brief: ' ', venue: 'wake' }, o), /needs a brief/);
  await assert.rejects(startBody(env, { agent: 'art', brief: 'x', venue: 'Bad' }, o), /which venue/);
  await assert.rejects(resumeBody(env, { brief: 'x' }, o), /resume takes a body, or a slot/);
});

test('loom-runtime body start: the CLI a source calls, end to end on a stand-in Claude Code', () => {
  const h = harness();
  const env = { ...h.env, HOME: h.D, LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(h.D, 'state'), LOOM_BOX_DATA: join(h.D, 'data'),
    LOOM_RUNTIME_CLAUDE: join(here, 'fake-claude.mjs'), LOOM_RUNTIME_CLAUDE_JOBS: join(h.D, 'jobs'), LOOM_RUNTIME_ACCOUNTS: 'none', LOOM_RUNTIME_SCORECARDS: 'off' };
  mkdirSync(join(h.D, 'work'));
  const cli = (args, input) => spawnSync(process.execPath, [join(here, '..', 'src', 'cli.mjs'), ...args], { env, input, encoding: 'utf-8', cwd: join(h.D, 'work') });
  const r = cli(['body', 'start', '--agent', 'art', '--venue', 'wake', '--prefer', 'claude-sonnet-5', '--brief', '-', '--json'], 'run the knowledge lane\nnow');
  assert.equal(r.status, 0, r.stderr);
  const b = JSON.parse(r.stdout);
  assert.deepEqual([b.agent, b.venue, b.kind, b.model, b.harness, b.family], ['art', 'wake', 'scheduled', 'claude-sonnet-5', 'claude', 'anthropic']);
  assert.match(b.body, /^claude:[0-9a-f]{8}$/);
  assert.equal(cli(['body', 'list'], '').stdout.trim(), `${b.body} art wake on claude-sonnet-5: working`);
  const fed = cli(['body', 'feed', b.body, '--text', 'x'], '');
  assert.equal(fed.status, 3, 'not fed: no inbox dir');
  assert.equal(cli(['body', 'end', b.body], '').status, 0);
  assert.equal(cli(['models', 'resolve', '--agent', 'art', '--venue', 'relay'], '').stdout.split('\n')[0], 'claude-opus-5-5 (claude, anthropic)');
  assert.match(cli(['body', 'start', '--agent', 'art', '--venue', 'wake', '--brief', ''], '').stderr, /^loom runtime: a body needs a brief/);
});
