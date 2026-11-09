// Runners (loom docs/specs/agent-runtime.md, section 3): one interface over the harnesses, here against stand-ins
// for Claude Code (`claude --bg`) and Codex (`codex exec --json`): start a body with a brief, feed it mid-turn, resume
// it from its slot, end it. And bodies (src/bodies.mjs): whoever needs a body asks the runtime, which picks the model
// and starts it through the runner interface (test obligation 1's runtime side, with a fake runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { staticAccounts } from '../src/accounts.mjs';
import { endBody, feedBody, forgetBody, listBodies, readBody, resumeBody, startBody } from '../src/bodies.mjs';
import { setModels } from '../src/models.mjs';
import { ClaudeRunner, CodexRunner, RunnerError, codexLayers, runnerFor } from '../src/runners.mjs';
import { dropSession, packSession, restoreFiles } from '../src/sessions.mjs';
import { parse as parseToml } from '../src/vendor/smol-toml/index.js';
import { scratch } from './scratch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const until = async (f, ms = 10_000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); } };

function harness() {
  const D = scratch('rt-harness-');
  const inbox = join(D, 'inbox');
  // Never the developer's own CODEX_HOME: a Codex runner reads a body env's as the real home.
  const { CODEX_HOME: _home, ...base } = process.env;
  const env = { ...base, FAKE_HARNESS: D };
  return { D, inbox, env, argv: () => lines(join(D, 'argv.log')) };
}

/** A path as a RegExp that matches it literally. */
const rx = (p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const BRIEF = 'You are Art, in a DM with Loren.\nSECRET-ISH MESSAGE TEXT: what did we decide?';

test('Claude Code: a body starts with its brief on stdin (never argv), is found by its spawn token, and has a slot', () => {
  const h = harness();
  const r = new ClaudeRunner({ claude: join(here, 'fake-claude.mjs'), jobsDir: join(h.D, 'jobs'), args: ['--dangerously-skip-permissions'], inboxDir: h.inbox, usageDir: join(h.D, 'usage'), sleep: () => {} });
  const b = r.start({ brief: BRIEF, model: 'claude-sonnet-5', cwd: h.D, env: h.env, deny: ['mcp__x__send'] });
  assert.equal(b.harness, 'claude');
  assert.match(b.id, /^[0-9a-f]{8}$/);
  assert.equal(b.slot.harness, 'claude');
  const bg = h.argv().find((a) => a[0] === '--bg');
  assert.deepEqual(bg, ['--bg', '--model', 'claude-sonnet-5', ...r.statusLine(), '--dangerously-skip-permissions', '--disallowedTools', 'mcp__x__send']);
  assert.equal(r.statusLine()[0], '--settings', 'its status line keeps its usage (t-1754)');
  assert.equal(JSON.stringify(h.argv()).includes('SECRET-ISH'), false);
  // Its brief, with the spawn token on line 2 so line 1 stays the brief's opening.
  const intent = JSON.parse(readFileSync(join(h.D, 'jobs', b.id, 'state.json'), 'utf-8')).intent.split('\n');
  assert.equal(intent[0], 'You are Art, in a DM with Loren.');
  assert.match(intent[1], /^\(bridge spawn token [0-9a-f]{8}: ignore this line\)$/);
  assert.equal(intent[2], 'SECRET-ISH MESSAGE TEXT: what did we decide?');
  assert.equal(r.status(b), 'working');
});

test('Claude Code: a turn that ended on "I\'ll check back" (state working, tempo idle, nothing in flight) is over; tempo active is mid-turn (t-1764)', () => {
  const h = harness();
  const r = new ClaudeRunner({ claude: join(here, 'fake-claude.mjs'), jobsDir: join(h.D, 'jobs'), inboxDir: h.inbox, sleep: () => {} });
  const b = r.start({ brief: 'hello', model: 'm', cwd: h.D, env: h.env });
  const job = join(h.D, 'jobs', b.id, 'state.json');
  const set = (x) => writeFileSync(job, JSON.stringify({ ...JSON.parse(readFileSync(job, 'utf-8')), ...x }));
  set({ state: 'working', tempo: 'active', inFlight: { tasks: 0, queued: 0 } });
  assert.equal(r.status(b), 'working');
  assert.equal(r.turn(b), null);
  // As h-876's body was left (2026-11-03): its last line said a check was armed, and it waits for nothing here.
  set({ state: 'working', tempo: 'idle', detail: 'PR #38 still untouched; round 23 check armed', inFlight: { tasks: 0, queued: 0, kinds: [], drainableMonitors: 0 } });
  assert.equal(r.status(b), 'idle');
  assert.equal(r.turn(b).failed, false);
  assert.equal(r.stopped(b), false, 'an idle turn still needs a stop acknowledgement');
  // Idle, but with a background task or a monitor of its own still going: not over.
  set({ inFlight: { tasks: 1, queued: 0 } });
  assert.equal(r.status(b), 'working');
  set({ inFlight: { tasks: 0, queued: 0, drainableMonitors: 1 } });
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
  // As Claude Code does it: the resumed session is back under its own job id (t-1881), claimed by this launch's token.
  assert.equal(again.id, b.id);
  // Its inbox is a new one: nothing of what the first run was fed, and it can be fed.
  assert.deepEqual(r.feed(again, { id: 'm2', text: 'and this' }), { fed: true });
  assert.deepEqual(lines(join(h.inbox, again.id, 'pending.jsonl')).map((p) => p.id), ['m2']);
  assert.deepEqual(again.slot, slot);
  assert.deepEqual(h.argv().filter((a) => a[0] === '--bg').at(-1).slice(-2), ['--resume', slot.session]);
  // End: stopped, and its inbox closed (the hook then hands over nothing).
  r.end(again, h.env);
  assert.equal(r.status(again), 'idle');
  assert.equal(r.stopped(again), true);
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

/** A simulated real Codex home: servers loom (allowed), handoff and gmail (denied), and a profile that turns handoff on. */
function realCodexHome(D, name = 'real') {
  const home = join(D, name);
  mkdirSync(join(home, 'skills', 'house-skill'), { recursive: true });
  mkdirSync(join(home, 'plugins', 'p'), { recursive: true });
  writeFileSync(join(home, 'config.toml'), [
    'model = "gpt-x"', 'profile = "work"', '',
    '[mcp_servers.loom]', 'url = "http://127.0.0.1:8787/mcp"', 'http_headers = { "Authorization" = "Bearer tok-1" }', '',
    '[mcp_servers.handoff]', 'command = "handoff-mcp"', 'args = ["--serve"]', '',
    "[mcp_servers.'claude_ai_Gmail']", 'url = "https://gmail.example/mcp"', '',
    '[profiles.work.mcp_servers.handoff]', 'command = "handoff-mcp"', 'enabled = true', '',
    `[projects."${D}"]`, 'trust_level = "trusted"', ''].join('\n'));
  // A profile's own file (`codex -p work` reads <home>/work.config.toml since codex 0.134; config-advanced docs).
  writeFileSync(join(home, 'work.config.toml'), '[mcp_servers.handoff]\ncommand = "handoff-mcp"\nenabled = true\n');
  writeFileSync(join(home, 'auth.json'), '{"tokens":"x"}');
  writeFileSync(join(home, 'AGENTS.md'), 'house rules\n');
  return home;
}

test('Codex: a body runs in a home the runner makes, whose config has only the servers it may use (t-1916)', async () => {
  const h = harness();
  const real = realCodexHome(h.D);
  const original = readFileSync(join(real, 'config.toml'), 'utf-8');
  const sessions = join(h.D, 'sessions');
  const mk = (o = {}) => new CodexRunner({ codex: join(here, 'fake-codex.mjs'), runsDir: join(h.D, 'runs'), codexHome: real, sessionsDir: sessions, systemDir: join(h.D, 'etc-codex'), ...o });
  mkdirSync(join(h.D, 'repo', '.git'), { recursive: true });
  const r = mk();
  const b = r.start({ brief: 'x', model: 'gpt-x', cwd: join(h.D, 'repo'), env: { ...h.env, FAKE_ROLLOUT: '1' }, deny: ['mcp__handoff', 'mcp__claude_ai_Gmail'] });
  await until(() => h.argv().length === 1);
  const [{ args, home }] = h.argv();
  assert.equal(dirname(home), join(h.D, 'codex-homes'), 'a home of its own, beside the run dirs');
  assert.notEqual(home, real);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'config.toml')).mode & 0o777, 0o600);
  // Its config: the allowed servers as the real config has them, and nothing else (no profile, no profiles, no model).
  const conf = parseToml(readFileSync(join(home, 'config.toml'), 'utf-8'));
  assert.deepEqual(JSON.parse(JSON.stringify(conf)), { mcp_servers: { loom: { url: 'http://127.0.0.1:8787/mcp', http_headers: { Authorization: 'Bearer tok-1' } } } });
  assert.equal(readdirSync(home).some((n) => n.endsWith('.config.toml')), false, 'no profile file');
  assert.equal(existsSync(join(home, 'plugins')), false, 'no plugins (one can bring its own servers)');
  // The real home's login and instructions, linked; its sessions are the runner's.
  for (const n of ['auth.json', 'AGENTS.md', 'skills']) assert.equal(readlinkSync(join(home, n)), join(real, n), n);
  assert.equal(readlinkSync(join(home, 'sessions')), sessions);
  // The second layer: each denied server off on the command line too; never a profile.
  assert.ok(args.includes('mcp_servers.handoff={enabled=false, command="false"}'));
  assert.ok(args.includes('mcp_servers.claude_ai_Gmail={enabled=false, command="false"}'));
  assert.equal(args.includes('-p') || args.includes('--profile'), false);
  // What Codex writes under its home's sessions is where the runner reads: session files, usage, resume.
  await until(() => r.slotOf(b));
  await until(() => r.sessionFiles(r.slotOf(b)).keep.length === 1);
  assert.deepEqual(r.usage(b).windows, { '5h': 0.42 });
  writeFileSync(join(h.D, 'finish'), '');
  await until(() => r.status(b) === 'idle');
  r.resume(r.slotOf(b), { brief: 'more', model: 'gpt-x', cwd: join(h.D, 'repo'), env: h.env, deny: ['mcp__handoff', 'mcp__claude_ai_Gmail'] });
  await until(() => h.argv().length === 2);
  assert.equal(h.argv()[1].home, home, 'the same deny list, the same home');
  // Its config is the real one's as it is at each start: a server changed or added there is in the next start's.
  writeFileSync(join(real, 'config.toml'), '[mcp_servers.loom]\nurl = "http://127.0.0.1:8787/v2"\n[mcp_servers.handoff]\ncommand = "h"\n');
  // A real dir where its sessions link goes (something ran with this home before the link): moved aside, never deleted.
  rmSync(join(home, 'sessions')); mkdirSync(join(home, 'sessions', 'kept'), { recursive: true });
  r.resume(r.slotOf(b), { brief: 'more', model: 'gpt-x', cwd: join(h.D, 'repo'), env: h.env, deny: ['mcp__handoff', 'mcp__claude_ai_Gmail'] });
  await until(() => h.argv().length === 3);
  assert.deepEqual(JSON.parse(JSON.stringify(parseToml(readFileSync(join(home, 'config.toml'), 'utf-8')))), { mcp_servers: { loom: { url: 'http://127.0.0.1:8787/v2' } } });
  assert.equal(readlinkSync(join(home, 'sessions')), sessions);
  assert.ok(readdirSync(home).some((n) => n.startsWith('sessions.aside-') && existsSync(join(home, n, 'kept'))));
  writeFileSync(join(real, 'config.toml'), original);
  // With no deny list every server is there; a body env's CODEX_HOME is the real home it reads.
  r.start({ brief: 'x', model: 'gpt-x', cwd: join(h.D, 'repo'), env: h.env });
  await until(() => h.argv().length === 4);
  assert.deepEqual(Object.keys(parseToml(readFileSync(join(h.argv()[3].home, 'config.toml'), 'utf-8')).mcp_servers).sort(), ['claude_ai_Gmail', 'handoff', 'loom']);
  const other = realCodexHome(h.D, 'other');
  writeFileSync(join(other, 'config.toml'), '[mcp_servers.only_here]\ncommand = "x"\n[mcp_servers.handoff]\ncommand = "h"\n');
  r.start({ brief: 'x', model: 'gpt-x', cwd: join(h.D, 'repo'), env: { ...h.env, CODEX_HOME: other }, deny: ['mcp__handoff'] });
  await until(() => h.argv().length === 5);
  assert.deepEqual(Object.keys(parseToml(readFileSync(join(h.argv()[4].home, 'config.toml'), 'utf-8')).mcp_servers), ['only_here']);
  assert.equal(readlinkSync(join(h.argv()[4].home, 'auth.json')), join(other, 'auth.json'));
  // A real config that isn't TOML: refused, never guessed.
  writeFileSync(join(other, 'config.toml'), '[mcp_servers.x\n');
  assert.throws(() => r.start({ brief: 'x', model: 'm', cwd: join(h.D, 'repo'), env: { ...h.env, CODEX_HOME: other }, deny: ['mcp__handoff'] }), /can't read .*config\.toml/);
  // LOOM_RUNTIME_CODEX_PROFILE set: refused, deny list or none.
  assert.throws(() => mk({ profile: 'work' }).start({ brief: 'x', model: 'm', cwd: join(h.D, 'repo'), env: h.env }), /LOOM_RUNTIME_CODEX_PROFILE is set \(work\)/);
  assert.match(mk({ profile: 'work' }).wontRun([], join(h.D, 'repo'), h.env), /LOOM_RUNTIME_CODEX_PROFILE/);
  assert.equal(h.argv().length, 5);
});

test('Codex: a made home goes once no live body uses it: at a body\'s end, and in a sweep; never one in use (t-1924)', async () => {
  const h = harness();
  const real = realCodexHome(h.D);
  const homes = join(h.D, 'codex-homes');
  const r = new CodexRunner({ codex: join(here, 'fake-codex.mjs'), runsDir: join(h.D, 'runs'), codexHome: real, sessionsDir: join(h.D, 'sessions'), systemDir: join(h.D, 'etc-codex') });
  mkdirSync(join(h.D, 'repo', '.git'), { recursive: true });
  const cwd = join(h.D, 'repo');
  const homeIds = () => readdirSync(homes).filter((n) => /^[0-9a-f]{16}$/.test(n)).sort();
  // Two bodies with the same deny list share a home; a third, with none, has its own.
  const a = r.start({ brief: 'x', model: 'm', cwd, env: { ...h.env, FAKE_ROLLOUT: '1' }, deny: ['mcp__handoff'] });
  const b = r.start({ brief: 'x', model: 'm', cwd, env: h.env, deny: ['mcp__handoff'] });
  const c = r.start({ brief: 'x', model: 'm', cwd, env: h.env });
  await until(() => h.argv().length === 3);
  // The fakes log in whatever order they start: each home by its body.
  const homeOf = (body) => h.argv().find((x) => x.body === body.id).home;
  const [ha, hb, hc] = [a, b, c].map(homeOf);
  assert.equal(ha, hb);
  assert.notEqual(ha, hc);
  assert.equal(statSync(ha).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(h.D, 'runs', a.id, 'home'), 'utf-8').trim(), ha.split('/').pop(), 'its run dir names its home');
  // A sweep while all three live: nothing goes.
  assert.deepEqual(r.sweepHomes(), []);
  assert.equal(homeIds().length, 2);
  // a ends, packed into a slot: its home stays while b uses it. Then b ends with nothing kept.
  await until(() => r.slotOf(a));
  const slot = r.slotOf(a);
  r.end(a);
  const files = packSession(r, slot, a);
  dropSession(r, slot, a);
  assert.ok(existsSync(ha), 'b still uses it');
  r.end(b);
  await until(() => !r.alive(b.id));
  dropSession(r, r.slotOf(b), b);
  assert.equal(existsSync(ha), false, 'no live body uses it: gone, with its copied credentials');
  assert.ok(existsSync(join(real, 'auth.json')), 'the login it linked is the real home\'s, untouched');
  assert.ok(existsSync(hc), 'c still runs in its own');
  // The slot resumes into a home made again, and its end leaves none.
  restoreFiles(r, files);
  const a2 = r.resume(slot, { brief: 'more', model: 'm', cwd, env: h.env, deny: ['mcp__handoff'] });
  await until(() => h.argv().length === 4);
  assert.equal(homeOf(a2), ha, 'the same home, made again');
  r.end(a2);
  await until(() => !r.alive(a2.id));
  dropSession(r, slot, a2);
  assert.equal(existsSync(ha), false, 'a slot\'s body gone: no home left');
  // A dead body whose run dir is still here (not yet retired) holds no home, once it's past its start.
  r.end(c);
  await until(() => !r.alive(c.id));
  assert.deepEqual(r.sweepHomes(), [], 'its run dir is new: a body may be starting there');
  assert.deepEqual(r.sweepHomes({ now: Date.now() + 11 * 60_000 }), [hc.split('/').pop()]);
  assert.deepEqual(homeIds(), []);
  // A live run dir that doesn't name its home (an older runtime's body): nothing is swept.
  const d = r.start({ brief: 'x', model: 'm', cwd, env: h.env });
  await until(() => h.argv().length === 5);
  rmSync(join(h.D, 'runs', d.id, 'home'));
  mkdirSync(join(homes, '0123456789abcdef'));
  assert.deepEqual(r.sweepHomes({ now: Date.now() + 11 * 60_000 }), []);
  writeFileSync(join(h.D, 'runs', d.id, 'home'), `${homeOf(d).split('/').pop()}\n`);
  assert.deepEqual(r.sweepHomes({ now: Date.now() + 11 * 60_000 }), ['0123456789abcdef'], 'the live one\'s stays');
  assert.ok(existsSync(homeOf(d)));
  // A home with something moved aside in it (homeFor) keeps that, and loses its config (the credentials' copy).
  mkdirSync(join(homes, 'fedcba9876543210', 'sessions.aside-1-ab', 'kept'), { recursive: true });
  writeFileSync(join(homes, 'fedcba9876543210', 'config.toml'), 'x');
  r.sweepHomes({ now: Date.now() + 11 * 60_000 });
  assert.equal(existsSync(join(homes, 'fedcba9876543210', 'config.toml')), false);
  assert.ok(existsSync(join(homes, 'fedcba9876543210', 'sessions.aside-1-ab', 'kept')));
  writeFileSync(join(h.D, 'finish'), '');
  r.end(d);
});

test('Codex: a config layer no CODEX_HOME replaces (a project\'s .codex, /etc/codex) refuses a body with a deny list (t-1916)', () => {
  const h = harness();
  const etc = join(h.D, 'etc-codex');
  // ~ with its real Codex home, a project in it (~/up/repo, a git repo), a dir inside it.
  const user = join(h.D, 'user');
  const real = realCodexHome(user, '.codex');
  const repo = join(user, 'up', 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'sub'), { recursive: true });
  const r = new CodexRunner({ codex: join(here, 'fake-codex.mjs'), runsDir: join(h.D, 'runs'), codexHome: real, sessionsDir: join(h.D, 'sessions'), systemDir: etc });
  const deny = ['mcp__handoff'];
  const why = (cwd, d = deny) => r.wontRun(d, cwd, h.env);
  // Nothing there: it runs. The real home's own config above the project root isn't a project's (Codex never reads it so).
  assert.equal(why(join(repo, 'sub')), null);
  assert.deepEqual(codexLayers(join(repo, 'sub'), { realHome: real, systemDir: etc }), []);
  // A project's .codex/config.toml at the cwd, in a parent inside the project, or above the project root: refused.
  for (const at of [join(repo, 'sub'), repo, join(user, 'up')]) {
    mkdirSync(join(at, '.codex'), { recursive: true });
    writeFileSync(join(at, '.codex', 'config.toml'), '');
    assert.match(why(join(repo, 'sub')), rx(`would read ${join(at, '.codex', 'config.toml')}`), at);
    assert.throws(() => r.start({ brief: 'x', model: 'm', cwd: join(repo, 'sub'), env: h.env, deny }), /a config the runtime can't replace/);
    // A body with no deny list has nothing a layer could undo.
    assert.equal(why(join(repo, 'sub'), []), null);
    rmSync(join(at, '.codex'), { recursive: true });
  }
  // Even one that isn't a file, or can't be read: only its being there counts.
  mkdirSync(join(repo, '.codex', 'config.toml'), { recursive: true });
  assert.match(why(repo), /would read/);
  rmSync(join(repo, '.codex'), { recursive: true });
  // The real home's own .codex is a project layer when the cwd is the project root it sits in (~, no .git): refused.
  assert.match(why(user), rx(`would read ${join(real, 'config.toml')}`));
  // The machine's: /etc/codex/config.toml, managed_config.toml, requirements.toml.
  mkdirSync(etc, { recursive: true });
  for (const n of ['config.toml', 'managed_config.toml', 'requirements.toml']) {
    writeFileSync(join(etc, n), '');
    assert.match(why(repo), rx(`would read ${join(etc, n)}`), n);
    rmSync(join(etc, n));
  }
  assert.equal(why(repo), null);
  assert.equal(h.argv().length, 0, 'nothing ran');
});

test('Codex: a body is one exec process, brief on stdin, keyed for its inbox; fed while it works, resumed by thread', async () => {
  const h = harness();
  const r = new CodexRunner({ codex: join(here, 'fake-codex.mjs'), runsDir: join(h.D, 'runs'), codexHome: join(h.D, 'codex'), inboxDir: h.inbox });
  const b = r.start({ brief: BRIEF, model: 'gpt-x', cwd: h.D, env: { ...h.env, CLAUDE_CODE_OAUTH_TOKEN: 'nope' } });
  assert.equal(b.harness, 'codex');
  await until(() => r.slotOf(b));
  const first = h.argv()[0];
  assert.equal(first.body, b.id);
  assert.equal(first.inbox, h.inbox);
  assert.deepEqual(first.claude, [], 'a Codex body never sees Claude Code\'s session keys');
  assert.deepEqual(first.args.slice(0, 7), ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-x']);
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
  // Codex can't deny a built-in tool by name: a body that would keep it isn't started (an MCP server's can: quota.test.mjs).
  assert.throws(() => r.start({ brief: 'x', model: 'm', cwd: h.D, env: h.env, deny: ['send'] }), /can't deny send/);
});

test('runnerFor builds each from the runtime\'s settings; an unknown harness is refused', () => {
  const c = runnerFor('claude', { LOOM_RUNTIME_CLAUDE: '/x/claude', LOOM_RUNTIME_CLAUDE_ARGS: '["--dangerously-skip-permissions"]', LOOM_RUNTIME_INBOX_DIR: '/i' });
  assert.deepEqual([c.claude, c.args, c.inbox.dir], ['/x/claude', ['--dangerously-skip-permissions'], '/i']);
  const x = runnerFor('codex', { CODEX_HOME: '/h/.codex', LOOM_RUNTIME_CODEX_RUNS: '/d/runs' });
  assert.deepEqual([x.codex, x.codexHome, x.roots.sessions, x.homesDir, x.inbox], ['codex', '/h/.codex', '/h/.codex/sessions', '/d/codex-homes', null]);
  // LOOM_RUNTIME_CODEX_PROFILE isn't supported: set, its runner refuses every body (above).
  assert.match(runnerFor('codex', { LOOM_RUNTIME_CODEX_PROFILE: 'shuttle' }).wontRun([], '/', {}), /LOOM_RUNTIME_CODEX_PROFILE is set \(shuttle\)/);
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
  const acct = (name, provider, usage = {}) => ({ name, provider, harness: provider === 'anthropic' ? 'claude' : 'codex', kind: 'login', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage });
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

test('a runner names its session\'s own local files: the transcript a slot keeps, and the job or run dir that goes', () => {
  const h = harness();
  assert.equal(new ClaudeRunner({ jobsDir: join(h.D, 'claude', 'jobs') }).roots.projects, join(h.D, 'claude', 'projects'), 'beside its jobs, in its config dir');
  const c = new ClaudeRunner({ claude: join(here, 'fake-claude.mjs'), jobsDir: join(h.D, 'jobs'), projectsDir: join(h.D, 'claude', 'projects'), inboxDir: h.inbox, sleep: () => {} });
  mkdirSync(join(c.roots.projects, '-home-art-Art', 'sess-1234'), { recursive: true });
  writeFileSync(join(c.roots.projects, '-home-art-Art', 'sess-1234.jsonl'), '{}\n');
  assert.deepEqual(c.sessionFiles({ harness: 'claude', session: 'sess-1234' }, { id: 'abcdef12' }), {
    keep: [{ root: 'projects', rel: join('-home-art-Art', 'sess-1234.jsonl') }, { root: 'projects', rel: join('-home-art-Art', 'sess-1234') }],
    drop: [join(h.D, 'jobs', 'abcdef12')],
  });
  assert.deepEqual(c.sessionFiles({ harness: 'claude', session: '../../etc' }).keep, [], 'a session id is never a path');
  const x = new CodexRunner({ runsDir: join(h.D, 'runs'), sessionsDir: join(h.D, 'codex', 'sessions') });
  mkdirSync(join(x.roots.sessions, '2026', '11', '02'), { recursive: true });
  writeFileSync(join(x.roots.sessions, '2026', '11', '02', 'rollout-2026-11-02T12-00-00-th-42ab.jsonl'), '{}\n');
  assert.deepEqual(x.sessionFiles({ harness: 'codex', session: 'th-42ab' }, { id: 'k1234567' }), {
    keep: [{ root: 'sessions', rel: join('2026', '11', '02', 'rollout-2026-11-02T12-00-00-th-42ab.jsonl') }],
    drop: [join(h.D, 'runs', 'k1234567')],
  });
  // The inbox: what it still held, once closed; then gone, its text with it.
  const b = c.start({ brief: 'hi', model: 'm', cwd: h.D, env: h.env });
  c.feed(b, { id: 'k1', text: 'unread' });
  c.inbox.close(b.id);
  assert.deepEqual(c.inbox.pending(b.id).map((p) => [p.id, p.text]), [['k1', 'unread']]);
  c.inbox.remove(b.id);
  assert.equal(existsSync(join(h.inbox, b.id)), false);
});

test('spawn reports use the final assistant text from Claude and Codex, not tool output', () => {
  const h = harness();
  const claude = new ClaudeRunner({ jobsDir: join(h.D, 'jobs') });
  const transcript = join(h.D, 'final.jsonl');
  writeFileSync(transcript, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Working' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'tool output' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
  ].map(JSON.stringify).join('\n'));
  claude.transcriptOf = () => transcript;
  assert.equal(claude.final({ id: 'one' }), 'ok');
  const codex = new CodexRunner({ runsDir: join(h.D, 'runs') });
  codex.events = () => [
    { type: 'item.completed', item: { type: 'agent_message', text: 'Working' } },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'tool output' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
    { type: 'turn.completed' },
  ];
  assert.equal(codex.final({ id: 'one' }), 'ok');
});
