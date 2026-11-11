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

test('Codex events without native process identity do not prove its writer is absent', () => {
  const h = harness(), key = 'd'.repeat(24), runsDir = join(h.D, 'runs');
  const dir = join(runsDir, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ type: 'thread.started', thread_id: 'thread-1234' }) + '\n');
  const runner = new CodexRunner({ runsDir, codexHome: realCodexHome(h.D) });
  assert.deepEqual(runner.recoverLaunch(key), { state: 'pending' }, 'no PID receipt and no observed process remains uncertain');
});

test('Claude durable token recovers the original job without another daemon submission or lost inbox', () => {
  const h = harness(), launchToken = 'a'.repeat(24);
  const options = { claude: join(here, 'fake-claude.mjs'), jobsDir: join(h.D, 'jobs'), inboxDir: h.inbox, sleep: () => {} };
  const original = new ClaudeRunner(options).start({ brief: BRIEF, cwd: h.D, env: h.env, launchToken });
  const pending = join(h.inbox, original.id.slice(0, 8), 'pending.jsonl');
  writeFileSync(pending, 'unread steering must survive\n');
  const fresh = new ClaudeRunner(options);
  assert.deepEqual(fresh.recoverLaunch(launchToken, { env: h.env }), { state: 'ready', body: original });
  assert.equal(h.argv().filter(a => a[0] === '--bg').length, 1);
  assert.equal(readFileSync(pending, 'utf8'), 'unread steering must survive\n');
  assert.deepEqual(fresh.recoverLaunch('b'.repeat(24), { env: h.env }), { state: 'pending' }, 'missing job is uncertainty, not permission to submit');
});

test('Codex durable token recovers the same actual native process after missing PID registration', async () => {
  const h = harness(), launchToken = 'c'.repeat(24);
  const options = { codex: join(here, 'fake-codex.mjs'), runsDir: join(h.D, 'runs'), codexHome: realCodexHome(h.D), systemDir: join(h.D, 'etc-codex'), inboxDir: h.inbox };
  const r = new CodexRunner(options);
  const body = r.start({ brief: BRIEF, cwd: h.D, env: h.env, launchToken });
  const pidFile = join(options.runsDir, launchToken, 'pid');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    await until(() => r.slotOf(body));
    const pending = join(h.inbox, launchToken.slice(0, 8), 'pending.jsonl');
    writeFileSync(pending, 'unread steering must survive\n');
    rmSync(pidFile);
    const fresh = new CodexRunner(options);
    const recovered = fresh.recoverLaunch(launchToken);
    assert.equal(recovered.state, 'ready');
    assert.equal(recovered.body.id, body.id);
    assert.equal(recovered.body.slot.session, r.slotOf(body).session);
    assert.equal(Number(readFileSync(pidFile, 'utf8')), pid);
    assert.equal(fresh.alive(launchToken), true);
    assert.equal(readFileSync(pending, 'utf8'), 'unread steering must survive\n');
    assert.throws(() => fresh.start({ brief: 'another launch', cwd: h.D, env: h.env, launchToken }), /already exists/);
    assert.equal(h.argv().length, 1);
  } finally {
    try { process.kill(-pid, 'SIGINT'); } catch { /* diagnostic already ended */ }
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  }
});

test('Codex interruption lets the harness cancel a detached tool and flush its state', async () => {
  const h = harness();
  const r = new CodexRunner({ codex: join(here, 'fake-codex.mjs'), runsDir: join(h.D, 'runs'), codexHome: realCodexHome(h.D), systemDir: join(h.D, 'etc-codex') });
  const b = r.start({ brief: 'diagnostic', model: 'm', cwd: h.D, env: { ...h.env, FAKE_DETACHED_TOOL: '1' } });
  await until(() => existsSync(join(h.D, 'tool-started')));
  r.end(b);
  await until(() => r.stopped(b));
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.equal(existsSync(join(h.D, 'orphan-finished')), false, 'the interrupted tool must not keep doing work');
  assert.equal(existsSync(join(h.D, 'interrupt-flushed')), true, 'the harness completed graceful cancellation');
});

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
  const b = await startBody(env, { agent: 'art', brief: 'the wake', venue: 'wake', place: 'schedule:reflect', deny:['mcp__github'] }, o);
  assert.deepEqual([b.body, b.model, b.harness, b.family, b.kind, b.account], ['codex:x0000000', 'gpt', 'codex', 'openai', 'scheduled', 'pro']);
  assert.deepEqual(seen[0].slice(0, 3), ['start', 'codex', 'gpt']);
  assert.match(seen[0][3], /^JOB PROFILE PROBLEM:[\s\S]*\n\nthe wake$/);
  // The record has no brief.
  const rec = readBody(env, b.body);
  assert.equal(JSON.stringify(rec).includes('the wake'), false);
  assert.equal(rec.place, 'schedule:reflect');
  assert.deepEqual(feedBody(env, b.body, { text: 'also' }, o), { fed: true });
  assert.deepEqual(listBodies(env, o).map((x) => [x.body, x.status]), [['codex:x0000000', 'working']]);
  endBody(env, b.body, o);
  assert.equal(feedBody(env, b.body, { text: 'x' }, o).fed, false);
  // Resumed by its id: the same harness (its slot is a Codex thread), the model chosen again.
  const r = await resumeBody(env, { body: b.body, brief: 'next', deny:['Read(private)'] }, o);
  assert.deepEqual([r.harness, r.model, r.resumed, r.slot.session], ['codex', 'gpt', 'codex:x0000000', 's-x0000000']);
  const continued=await resumeBody(env,{slot:r.slot,agent:'art',venue:'wake',brief:'slotnext',deny:['Write(other)']},o);
  assert.deepEqual(continued.deny,['mcp__github','Read(private)','Write(other)']);
  // Resumed from a slot another machine kept. Its unproved deny floor stays minimal.
  env.LOOM_RUNTIME_JOB_PROFILES=join(env.HOME,'unknown-profiles.json');
  writeFileSync(env.LOOM_RUNTIME_JOB_PROFILES,JSON.stringify({v:1,jobs:{[JSON.stringify(['art','session','live',null])]:{v:1,mcp:[],tools:['Read'],skills:[],secrets:[]}}}));
  const s = await resumeBody(env, { slot: { harness: 'claude', session: 'abc' }, agent: 'art', venue: 'session', brief: 'hi' }, { ...o, accounts: staticAccounts({ accounts: [acct('max', 'anthropic')] }) });
  assert.deepEqual([s.harness, s.model, s.kind], ['claude', 'opus', 'live']);
  assert.deepEqual(seen.at(-1), ['resume', 'claude', 'opus', 'abc']);
  assert.equal(s.restrictionUnknown,true);assert.deepEqual(JSON.parse(s.profile).tools,[]);
  const again=await resumeBody(env,{body:s.body,brief:'again'},{...o,accounts:staticAccounts({accounts:[acct('max','anthropic')]})});
  assert.equal(again.restrictionUnknown,true);assert.deepEqual(JSON.parse(again.profile).tools,[]);
  forgetBody(env, b.body);
  assert.throws(() => readBody(env, b.body), /no body/);
  await assert.rejects(startBody(env, { agent: 'art', brief: ' ', venue: 'wake' }, o), /needs a brief/);
  await assert.rejects(startBody(env, { agent: 'art', brief: 'x', venue: 'Bad' }, o), /which venue/);
  await assert.rejects(resumeBody(env, { brief: 'x' }, o), /resume takes a body, or a slot/);
});

test('loom-runtime body start: the CLI a source calls, end to end on a stand-in Claude Code', () => {
  const h = harness();
  const env = { ...h.env, HOME: h.D, LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(h.D, 'state'), LOOM_BOX_DATA: join(h.D, 'data'),
    LOOM_RUNTIME_CLAUDE: join(here, 'fake-claude.mjs'), LOOM_RUNTIME_CLAUDE_JOBS: join(h.D, 'jobs'), LOOM_RUNTIME_ACCOUNTS: 'none', LOOM_RUNTIME_SCORECARDS: 'off',
    LOOM_RUNTIME_BODY_ENV: 'FAKE_HARNESS', LOOM_RUNTIME_JOB_PROFILES: join(h.D, 'profiles.json') };
  writeFileSync(env.LOOM_RUNTIME_JOB_PROFILES, JSON.stringify({ v: 1, jobs: { [JSON.stringify(['art', 'wake', 'scheduled', null])]: { v: 1, mcp: [], tools: [], skills: [], secrets: ['FAKE_HARNESS'] } } }));
  mkdirSync(join(h.D, 'work'));
  const cli = (args, input) => spawnSync(process.execPath, [join(here, '..', 'src', 'cli.mjs'), ...args], { env, input, encoding: 'utf-8', cwd: join(h.D, 'work') });
  const r = cli(['body', 'start', '--agent', 'art', '--venue', 'wake', '--prefer', 'claude-sonnet-5', '--model-need', 'coordinator: test Claude runner integration', '--brief', '-', '--json'], 'run the knowledge lane\nnow');
  assert.equal(r.status, 0, r.stderr);
  const b = JSON.parse(r.stdout);
  assert.deepEqual([b.agent, b.venue, b.kind, b.model, b.harness, b.family], ['art', 'wake', 'scheduled', 'claude-sonnet-5', 'claude', 'anthropic']);
  assert.match(b.body, /^claude:[0-9a-f]{8}$/);
  assert.equal(cli(['body', 'list'], '').stdout.trim(), `${b.body} art wake on claude-sonnet-5: working`);
  const fed = cli(['body', 'feed', b.body, '--text', 'x'], '');
  assert.equal(fed.status, 3, 'not fed: no inbox dir');
  assert.equal(cli(['body', 'end', b.body], '').status, 0);
  assert.equal(cli(['models', 'resolve', '--agent', 'art', '--venue', 'relay'], '').stdout.split('\n')[0], 'gpt-6.1-sol (codex, openai)');
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

test('a Claude job\'s last words are read as its transcript grows, never whole each beat (t-2138)', async () => {
  const { appendFileSync, openSync, writeSync, closeSync, renameSync } = await import('node:fs');
  const h = harness();
  const a = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const u = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'tool output' }] } });
  const transcript = join(h.D, 'grow.jsonl');
  writeFileSync(transcript, `${a('first 界')}\n${u}\n`);
  // Slices of 7 bytes: a line and a character are cut across reads, and read whole.
  const claude = new ClaudeRunner({ jobsDir: join(h.D, 'jobs'), readMax: { final: 7 } });
  claude.transcriptOf = () => transcript;
  assert.equal(claude.final({ id: 'one' }), 'first 界');
  // What it has read isn't read again: spoil its start in place (same file, same size); a whole read would lose it.
  const fd = openSync(transcript, 'r+');
  writeSync(fd, 'X', 0); closeSync(fd);
  appendFileSync(transcript, `${u}\n`);
  assert.throws(() => JSON.parse(readFileSync(transcript, 'utf-8').split('\n')[0]), 'its start no longer reads');
  assert.equal(claude.final({ id: 'one' }), 'first 界', 'the kept words, from the new bytes only');
  // A line not yet ended counts once it's whole; then the next one.
  appendFileSync(transcript, a('second'));
  assert.equal(claude.final({ id: 'one' }), 'second');
  appendFileSync(transcript, `\n${u}\n${a('third')}\n`);
  assert.equal(claude.final({ id: 'one' }), 'third');
  // Another file in its place is read from its start.
  const other = join(h.D, 'other.jsonl');
  writeFileSync(other, `${a('fresh')}\n${u}\n${u}\n${u}\n${u}\n${u}\n${u}\n`);
  renameSync(other, transcript);
  assert.equal(claude.final({ id: 'one' }), 'fresh');
  // A FIFO a body put in its place is never waited on.
  const fifo = join(h.D, 'fifo.jsonl');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  claude.transcriptOf = () => fifo;
  const t0 = Date.now();
  assert.equal(claude.final({ id: 'one' }), null);
  assert.ok(Date.now() - t0 < 2000);
});

 test('final reads retain a UTF-8 character split across appends and join text parts; shortening and links reset safely', async () => {
  const { appendFileSync, symlinkSync, unlinkSync } = await import('node:fs');
  const h = harness(), transcript = join(h.D, 'split.jsonl');
  const runner = new ClaudeRunner({readMax: {final: 7}});
  runner.transcriptOf = () => transcript;
  const event = (words) => JSON.stringify({type: 'assistant', message: {content: words.map(text => ({type: 'text', text}))}});
  writeFileSync(transcript, event(['old']) + '\n');
  assert.equal(runner.final({}), 'old');
  const bytes = Buffer.from(event(['first 界', 'second']) + '\n');
  const cut = bytes.indexOf(Buffer.from('界')) + 1;
  appendFileSync(transcript, bytes.subarray(0, cut));
  assert.equal(runner.final({}), 'old');
  appendFileSync(transcript, bytes.subarray(cut));
  assert.equal(runner.final({}), 'first 界\nsecond');
  writeFileSync(transcript, event(['short']) + '\n');
  assert.equal(runner.final({}), 'short');
  const link = join(h.D, 'link.jsonl');
  symlinkSync(transcript, link);
  runner.transcriptOf = () => link;
  assert.equal(runner.final({}), null);
  unlinkSync(link);
});

 test('final memo holds 64 transcripts and explicitly reports an oversized line instead of silently returning stale words', async () => {
  const { openSync, writeSync, closeSync } = await import('node:fs');
  const h = harness(), runner = new ClaudeRunner();
  const event = (text) => JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text}]}}) + '\n';
  const files = Array.from({length: 64}, (_, i) => join(h.D, `memo-${i}.jsonl`));
  for (const file of files) { writeFileSync(file, event('kept')); runner.transcriptOf = () => file; assert.equal(runner.final({}), 'kept'); }
  for (const file of files) {
    const fd = openSync(file, 'r+'); writeSync(fd, 'X', 0); closeSync(fd);
    runner.transcriptOf = () => file;
    assert.equal(runner.final({}), 'kept');
  }
  const big = join(h.D, 'big.jsonl');
  writeFileSync(big, event('last') + event('x'.repeat(17 * 1024 * 1024)));
  runner.transcriptOf = () => big;
  assert.match(runner.final({}), /transcript line exceeded 16 MiB; last readable words follow\)\nlast$/);
  const {appendFileSync} = await import('node:fs');
  appendFileSync(big, event('after').trimEnd());
  assert.equal(runner.final({}), 'after');
  writeFileSync(big, event('new'));
  assert.equal(runner.final({}), 'new');
});

 test('final reads allocate bounded slices and measure the oversized-line bound in UTF-8 bytes', async () => {
  const fs = (await import('node:fs')).default;
  const {syncBuiltinESMExports} = await import('node:module');
  const h = harness(), file = join(h.D, 'sliced.jsonl');
  const event = text => JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text}]}}) + '\n';
  writeFileSync(file, event('hello 界'));
  const runner = new ClaudeRunner({readMax: {final: 7}}); runner.transcriptOf = () => file;
  const read = fs.readSync, sizes = [];
  fs.readSync = (fd, buffer, ...args) => { sizes.push(buffer.length); return read(fd, buffer, ...args); };
  syncBuiltinESMExports();
  try { assert.equal(runner.final({}), 'hello 界'); }
  finally { fs.readSync = read; syncBuiltinESMExports(); }
  assert.ok(sizes.length > 1);
  assert.ok(sizes.every(n => n <= 7));
  writeFileSync(file, event('old') + event('界'.repeat(6_000_000)));
  const wide = new ClaudeRunner(); wide.transcriptOf = () => file;
  assert.match(wide.final({}), /transcript line exceeded 16 MiB/);
});

 test('final memo refreshes recency, evicts beyond 64, and rejects a link replacing a cached file', async () => {
  const {openSync, writeSync, closeSync, renameSync, symlinkSync} = await import('node:fs');
  const h = harness(), runner = new ClaudeRunner();
  const event = text => JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text}]}}) + '\n';
  const paths = Array.from({length: 65}, (_, i) => join(h.D, `recency-${i}.jsonl`));
  const get = file => {runner.transcriptOf = () => file; return runner.final({});};
  for (const file of paths) writeFileSync(file, event('kept'));
  for (const file of paths.slice(0, 64)) assert.equal(get(file), 'kept');
  assert.equal(get(paths[0]), 'kept');
  assert.equal(get(paths[64]), 'kept');
  for (const file of paths.slice(0, 2)) {const fd = openSync(file, 'r+'); writeSync(fd, 'X', 0); closeSync(fd);}
  assert.equal(get(paths[0]), 'kept', 'recently accessed entry survives');
  assert.equal(get(paths[1]), null, 'least recently used entry was evicted and now reads invalid JSON');
  const file = paths[64], moved = file + '.moved';
  renameSync(file, moved); symlinkSync(moved, file);
  assert.equal(get(file), null, 'a cached path replaced with a symlink is refused before memo lookup');
});

 test('final skips an oversized unfinished line through a later newline and bounds every large-file allocation', async () => {
  const fs = (await import('node:fs')).default;
  const {syncBuiltinESMExports} = await import('node:module');
  const h = harness(), file = join(h.D, 'unfinished.jsonl');
  const event = text => JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text}]}}) + '\n';
  writeFileSync(file, event('old') + event('界'.repeat(6_000_000)).slice(0, -10));
  const runner = new ClaudeRunner({readMax: {final: 1024 * 1024}}); runner.transcriptOf = () => file;
  const read = fs.readSync, sizes = [];
  fs.readSync = (fd, buffer, ...args) => {sizes.push(buffer.length); return read(fd, buffer, ...args);};
  syncBuiltinESMExports();
  try {assert.match(runner.final({}), /transcript line exceeded 16 MiB; last readable words follow\)\nold$/);}
  finally {fs.readSync = read; syncBuiltinESMExports();}
  assert.ok(sizes.length > 16 && sizes.every(n => n <= 1024 * 1024));
  fs.appendFileSync(file, 'remainder without newline');
  assert.match(runner.final({}), /transcript line exceeded 16 MiB/);
  fs.appendFileSync(file, '\n' + event('recovered').trimEnd());
  assert.equal(runner.final({}), 'recovered');
});


test('final uses a stable descriptor and restarts for replacement or shrink during a scan', async () => {
  const fs = (await import('node:fs')).default;
  const {syncBuiltinESMExports} = await import('node:module');
  const h = harness();
  const event = text => JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}}) + '\n';
  for (const mode of ['replace','shrink']) {
    const file = join(h.D, mode+'.jsonl');
    writeFileSync(file,event('old')+' '.repeat(200));
    const runner = new ClaudeRunner({readMax:{final:7}}); runner.transcriptOf = () => file;
    const read = fs.readSync; let count=0;
    fs.readSync = (...args) => {
      const n = read(...args);
      if (++count === 15) {
        if(mode === 'replace') {writeFileSync(file+'.new',event('new'));fs.renameSync(file+'.new',file);}
        else writeFileSync(file,event('new'));
      }
      return n;
    };
    syncBuiltinESMExports();
    try {assert.equal(runner.final({}),'new', mode);}
    finally {fs.readSync=read;syncBuiltinESMExports();}
  }
});

test('final tiny configured slices still make progress through four-byte UTF-8', () => {
  const h = harness(), file = join(h.D,'tiny.jsonl');
  writeFileSync(file,JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'界 🐟'}]}}));
  const runner = new ClaudeRunner({readMax:{final:1}});runner.transcriptOf=()=>file;
  assert.equal(runner.final({}),'界 🐟');
  assert.equal(runner.readMax.final,4);
});

test('final drops oversized unfinished storage under a constrained heap', () => {
  const script = `
    import {writeFileSync,appendFileSync,mkdtempSync,rmSync} from 'node:fs';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    import {ClaudeRunner} from ${JSON.stringify(new URL('../src/runners.mjs',import.meta.url).href)};
    const dir=mkdtempSync(join(tmpdir(),'final-heap-')),file=join(dir,'stream');
    try {
      writeFileSync(file,'{"type":"user","padding":"');
      const chunk='x'.repeat(1024*1024);
      for(let i=0;i<192;i++) appendFileSync(file,chunk);
      const r=new ClaudeRunner({readMax:{final:1024*1024}});r.transcriptOf=()=>file;
      if(!r.final({}).includes('transcript line exceeded')) process.exitCode=1;
    } finally {rmSync(dir,{recursive:true,force:true});}
  `;
  const result=spawnSync(process.execPath,['--max-old-space-size=128','--input-type=module','-e',script],{encoding:'utf8',timeout:30_000});
  assert.equal(result.status,0,result.stderr);
});


test('final shortening is compared to observed size even behind an unfinished UTF-8 byte', () => {
  const h=harness(),file=join(h.D,'short-partial.jsonl');
  const event=text=>JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}})+'\n';
  writeFileSync(file,Buffer.concat([Buffer.from(event('old')),Buffer.from([0xe7])]));
  const runner=new ClaudeRunner();runner.transcriptOf=()=>file;
  assert.equal(runner.final({}),'old');
  writeFileSync(file,event('new'));
  assert.equal(runner.final({}),'new');
});

test('final retries a changing snapshot once and then returns no words', async () => {
  const fs=(await import('node:fs')).default;
  const {syncBuiltinESMExports}=await import('node:module');
  const h=harness(),file=join(h.D,'unstable.jsonl');
  const event=text=>JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}})+'\n';
  writeFileSync(file,event('old'));
  const runner=new ClaudeRunner();runner.transcriptOf=()=>file;
  const read=fs.readSync;let reads=0;
  fs.readSync=(...args)=>{const n=read(...args);writeFileSync(file+'.new',event(`new ${++reads}`));fs.renameSync(file+'.new',file);return n;};
  syncBuiltinESMExports();
  try{assert.equal(runner.final({}),null);assert.equal(reads,2,'one original scan and one retry');}
  finally{fs.readSync=read;syncBuiltinESMExports();}
});


test('final keeps readable unterminated words when that line later exceeds the bound', () => {
  const h=harness(),file=join(h.D,'tail-oversize.jsonl');
  writeFileSync(file,JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'latest'}]}}));
  const runner=new ClaudeRunner();runner.transcriptOf=()=>file;
  assert.equal(runner.final({}),'latest');
  const fsChunk=spawnSync(process.execPath,['--input-type=module','-e',`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(file)},' '.repeat(17*1024*1024));`]);
  assert.equal(fsChunk.status,0);
  assert.match(runner.final({}),/transcript line exceeded 16 MiB; last readable words follow\)\nlatest$/);
});

test('final snapshot excludes mid-scan appends and drops them after intermediate truncation', async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const h = harness();
  for (const slice of [256, 1024]) for (const truncate of [false, true]) {
  const file = join(h.D, `append-truncate-${slice}-${truncate}.jsonl`);
  const event = text => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';
  const initial = event('first');
  // At 256 bytes, the second slice has room for both appended messages if remaining bytes are not subtracted.
  const first = initial + (slice === 256 ? ' '.repeat(256 - Buffer.byteLength(initial)) + '\n' : '');
  const surviving = first + event('surviving');
  writeFileSync(file, first);
  const runner = new ClaudeRunner({ readMax: { final: slice } });
  runner.transcriptOf = () => file;
  const fstat = fs.fstatSync;
  let appended = false;
  fs.fstatSync = (...args) => {
    const st = fstat(...args);
    if (!appended) { appended = true; fs.appendFileSync(file, event('surviving') + event('removed')); }
    return st;
  };
  syncBuiltinESMExports();
  let snapshot;
  try { snapshot = runner.final({}); }
  finally { fs.fstatSync = fstat; syncBuiltinESMExports(); }
  if (truncate) fs.truncateSync(file, Buffer.byteLength(surviving));
  assert.equal(runner.final({}), truncate ? 'surviving' : 'removed',
    truncate ? 'truncation above initial size never keeps removed words' : 'the next scan reads deferred appends without further writes');
  assert.equal(snapshot, 'first', 'one scan is bounded to its initial descriptor snapshot');
  }
});
