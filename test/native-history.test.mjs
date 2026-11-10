import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runnerFor } from '../src/runners.mjs';
import { nativeHistoryEnv } from '../src/native-history.mjs';
import { offlineNativeSession, snapshotNativeHistory } from '../src/native-history-collection.mjs';
import { launchAttempt, readLaunch, reserveLaunch } from '../src/launch-journal.mjs';
import { SessionHistoryMissing } from '../src/sessions.mjs';
import { scratch } from './scratch.mjs';

const put = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data); };
function world() {
  const root = scratch('native-history-'), home = join(root, 'container-home'), history = join(root, 'history');
  mkdirSync(home); mkdirSync(history);
  return { root, home, history, env: { HOME: home, HOUSE_ID: 'h-42', LOOM_RUNTIME_NATIVE_HISTORY: history } };
}

for (const harness of ['claude', 'codex']) test(`${harness} native history survives container home removal and packs with its existing adapter`, () => {
  const w = world(), session = '12345678-1234-1234-1234-123456789abc', id = 'aabbccddeeff123456789abc';
  put(join(w.home, '.claude', 'settings.json'), 'hooks/config stay here');
  put(join(w.home, '.codex', 'auth.json'), 'private credential stays here');
  w.env.LOOM_RUNTIME_INBOX_DIR = join(w.home, 'inbox');
  const runner = runnerFor(harness, w.env);
  runner.inbox.open(id, { venue: 'runtime', chan: id, bridge: 'runtime' });
  put(join(runner.inbox.dir, id.slice(0, 8), 'pending.jsonl'), JSON.stringify({ id: 'pending-followup', text: 'private follow-up text' }) + '\n');
  if (harness === 'claude') {
    assert.equal(lstatSync(join(w.home, '.claude/projects')).isSymbolicLink(), true);
    // The actual CLI writes at its config directory, through the runtime link.
    put(join(w.home, '.claude/jobs', id.slice(0, 8), 'state.json'), JSON.stringify({ sessionId: session }));
    put(join(w.home, '.claude/projects/project', `${session}.jsonl`), 'original Claude native history');
    put(join(w.home, '.claude/projects/project', 'other-session.jsonl'), 'another body must not be returned');
    assert.equal(readFileSync(join(w.home, '.claude/settings.json'), 'utf8'), 'hooks/config stay here');
    assert.deepEqual(runnerFor(harness, w.env).roots, runner.roots, 'preparation is idempotent');
  } else {
    assert.equal(runner.homesDir.startsWith(w.history), false, 'generated homes with credentials stay ephemeral');
    put(join(runner.runsDir, id, 'events.jsonl'), JSON.stringify({ type: 'thread.started', thread_id: session }) + '\n');
    put(join(runner.roots.sessions, '2026/11/09', `rollout-time-${session}.jsonl`), 'original Codex native history');
    put(join(runner.roots.sessions, '2026/11/09', 'rollout-time-other-session.jsonl'), 'another body must not be returned');
  }
  const attempt = launchAttempt('cv-123456789abc', '123456789abc');
  reserveLaunch(w.env, { id: attempt, harness, intentHash: 'a'.repeat(64) });
  assert.equal(existsSync(join(w.history, 'launches', `${attempt}.json`)), true);
  // Even unrelated credential/config-shaped content at the top is not copied.
  put(join(w.history, 'auth.json'), 'do not collect');
  put(join(w.history, 'codex-homes/private/auth.json'), 'do not collect');
  rmSync(w.home, { recursive: true });
  assert.equal(readLaunch(w.env, attempt).harness, harness);
  const snapshot = join(w.root, 'collected');
  snapshotNativeHistory(w.history, snapshot);
  assert.equal(existsSync(join(snapshot, 'auth.json')), false);
  assert.equal(existsSync(join(snapshot, 'codex-homes')), false);
  const got = offlineNativeSession(snapshot, { harness, id });
  assert.equal(got.session, session);
  assert.equal(got.files.length, 1);
  assert.deepEqual(got.pending, ['pending-followup'], 'the same native history mount retains inbox receipts after HOME disappears');
  assert.match(Buffer.from(got.files[0].data, 'base64').toString(), /original .* native history/);
  assert.equal(lstatSync(join(snapshot, got.files[0].root === 'projects' ? 'claude-projects' : 'codex-sessions', got.files[0].rel)).mode & 0o777, 0o600);
  assert.throws(() => offlineNativeSession(snapshot, { harness, id, session: 'different-session' }), /different session/);
});

test('a house whose Claude and Codex history are already plain folders has them adopted into native history, losing nothing (t-2073)', () => {
  const w = world();
  // The bad state: a CLI wrote its history before the host linked it, and native history already holds some.
  put(join(w.home, '.claude/projects/p/a.jsonl'), 'only in the house');
  put(join(w.home, '.claude/projects/p/same.jsonl'), 'the same bytes');
  put(join(w.history, 'claude-projects/p/same.jsonl'), 'the same bytes');
  put(join(w.home, '.claude/projects/p/clash.jsonl'), 'the house copy');
  put(join(w.history, 'claude-projects/p/clash.jsonl'), 'the native history copy');
  put(join(w.home, '.claude/jobs/aabbccdd/state.json'), 'job state');
  put(join(w.home, '.codex/sessions/2026/11/09/rollout-x.jsonl'), 'codex rollout');
  const claude = runnerFor('claude', w.env), codex = runnerFor('codex', w.env);
  for (const link of ['.claude/projects', '.claude/jobs', '.codex/sessions']) assert.equal(lstatSync(join(w.home, link)).isSymbolicLink(), true, link);
  assert.equal(readFileSync(join(w.history, 'claude-projects/p/a.jsonl'), 'utf8'), 'only in the house');
  assert.equal(readFileSync(join(w.history, 'claude-projects/p/same.jsonl'), 'utf8'), 'the same bytes');
  assert.equal(readFileSync(join(w.history, 'claude-jobs/aabbccdd/state.json'), 'utf8'), 'job state');
  assert.equal(readFileSync(join(w.history, 'codex-sessions/2026/11/09/rollout-x.jsonl'), 'utf8'), 'codex rollout');
  // A clash keeps native history's copy where it was and the house's beside it.
  assert.equal(readFileSync(join(w.history, 'claude-projects/p/clash.jsonl'), 'utf8'), 'the native history copy');
  const kept = readdirSync(join(w.history, 'claude-projects/p')).filter(f => f.startsWith('clash.jsonl.adopted-'));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(w.history, 'claude-projects/p', kept[0]), 'utf8'), 'the house copy');
  assert.equal(readdirSync(join(w.history, 'claude-projects/p')).length, 4, 'nothing else, and nothing duplicated');
  // Nothing is left behind beside the links, and a second start is a no-op.
  assert.deepEqual(readdirSync(join(w.home, '.claude')).sort(), ['jobs', 'projects']);
  assert.deepEqual(runnerFor('claude', w.env).roots, claude.roots);
  assert.deepEqual(runnerFor('codex', w.env).roots, codex.roots);
});

test('two body starts adopting the same folder at once both start and lose nothing', async () => {
  const w = world();
  for (let i = 0; i < 50; i++) put(join(w.home, `.claude/projects/p/s${i}.jsonl`), `session ${i}`);
  const { Worker } = await import('node:worker_threads');
  const src = new URL('../src/runners.mjs', import.meta.url).href;
  const start = () => new Promise((ok, bad) => {
    const worker = new Worker(`import(${JSON.stringify(src)}).then(m => { m.runnerFor('claude', ${JSON.stringify(w.env)}); })`, { eval: true });
    worker.on('error', bad); worker.on('exit', code => code ? bad(Error(`exit ${code}`)) : ok());
  });
  await Promise.all([start(), start(), start()]);
  assert.equal(lstatSync(join(w.home, '.claude/projects')).isSymbolicLink(), true);
  const got = readdirSync(join(w.history, 'claude-projects/p')).sort();
  assert.equal(got.length, 50);
  for (let i = 0; i < 50; i++) assert.equal(readFileSync(join(w.history, `claude-projects/p/s${i}.jsonl`), 'utf8'), `session ${i}`);
  assert.deepEqual(readdirSync(join(w.home, '.claude')).sort(), ['jobs', 'projects']);
});

test('native history never replaces a conflicting history link', () => {
  const other = world(); mkdirSync(join(other.home, '.claude'));
  symlinkSync(other.home, join(other.home, '.claude/jobs'));
  assert.throws(() => runnerFor('claude', other.env), /existing directory link/);
});

test('native history refuses unavailable mounts, non-house use, custom Claude selectors, and credential homes in history', () => {
  const w = world();
  assert.throws(() => runnerFor('codex', { ...w.env, HOUSE_ID: undefined }), /allocated house/);
  assert.throws(() => runnerFor('codex', { ...w.env, LOOM_RUNTIME_NATIVE_HISTORY: join(w.root, 'missing') }), /unavailable/);
  assert.throws(() => runnerFor('claude', { ...w.env, LOOM_RUNTIME_CLAUDE_JOBS: join(w.home, 'custom-jobs') }), /custom Claude/);
  assert.throws(() => runnerFor('codex', { ...w.env, CODEX_HOME: join(w.history, 'credentials') }), /login\/configuration/);
  assert.throws(() => runnerFor('codex', { ...w.env, LOOM_RUNTIME_CODEX_HOMES: join(w.history, 'homes') }), /login\/configuration/);
  assert.equal(nativeHistoryEnv('codex', { HOME: w.home }).HOME, w.home, 'unconfigured runtimes retain ordinary storage');
});

for (const failure of ['link', 'bytes', 'entries']) test(`offline snapshot ${failure} failure retains the original and publishes no partial copy`, () => {
  const w = world(); runnerFor('codex', w.env);
  const file = join(w.history, 'codex-sessions/original'); put(file, 'original history');
  if (failure === 'link') symlinkSync(w.home, join(w.history, 'codex-sessions/escape'));
  const target = join(w.root, 'snapshot');
  assert.throws(() => snapshotNativeHistory(w.history, target, failure === 'bytes' ? { maxBytes: 1 } : failure === 'entries' ? { maxEntries: 1 } : {}), /links|too large|too many/);
  assert.equal(readFileSync(file, 'utf8'), 'original history');
  assert.equal(existsSync(target), false);
  assert.equal(readdirSync(w.root).some(n => n.startsWith('.native-history-')), false);
});

test('offline absence has a distinct loss classification for a physically terminated caller', () => {
  const w = world(); runnerFor('codex', w.env);
  const snapshot = join(w.root, 'snapshot'); snapshotNativeHistory(w.history, snapshot);
  assert.throws(() => offlineNativeSession(snapshot, { harness: 'codex', id: 'aabbccdd' }), SessionHistoryMissing);
  assert.throws(() => offlineNativeSession(snapshot, { harness: 'codex', id: 'aabbccdd', session: 'known-session' }), SessionHistoryMissing);
  assert.throws(() => snapshotNativeHistory(w.history, snapshot), /new separate directory/);
});

for (const harness of ['claude', 'codex']) test(`${harness}: malformed existing identity metadata cannot be classified as missing history`, () => {
  const w = world(), id = 'aabbccdd'; runnerFor(harness, w.env);
  put(join(w.history, harness === 'claude' ? 'claude-jobs' : 'codex-runs', id, harness === 'claude' ? 'state.json' : 'events.jsonl'), '{partial native metadata');
  const snapshot = join(w.root, 'snapshot'); snapshotNativeHistory(w.history, snapshot);
  assert.throws(() => offlineNativeSession(snapshot, { harness, id }), error => !(error instanceof SessionHistoryMissing) && /could not be decoded/.test(error.message));
});

test('durable Codex history preserves custom runner selectors and generated-home placement', () => {
  const w = world();
  const env = { ...w.env, CODEX_HOME: join(w.home, 'custom-login'), LOOM_RUNTIME_CODEX_RUNS: join(w.home, 'custom-runs'), LOOM_RUNTIME_CODEX_SESSIONS: join(w.home, 'custom-sessions'), LOOM_RUNTIME_CODEX_HOMES: join(w.home, 'custom-homes') };
  const native = runnerFor('codex', env);
  assert.equal(native.codexHome, env.CODEX_HOME);
  assert.equal(native.runsDir, env.LOOM_RUNTIME_CODEX_RUNS);
  assert.equal(native.roots.sessions, env.LOOM_RUNTIME_CODEX_SESSIONS);
  assert.equal(native.homesDir, env.LOOM_RUNTIME_CODEX_HOMES);
  put(join(native.runsDir, 'deadbeef/events.jsonl'), 'native run');
  assert.equal(readFileSync(join(w.history, 'codex-runs/deadbeef/events.jsonl'), 'utf8'), 'native run');
  assert.deepEqual(runnerFor('codex', env).roots, native.roots);
});

test('credential-home aliases into the history mount are refused', () => {
  const w = world();
  mkdirSync(join(w.history, 'credentials'));
  const alias = join(w.home, 'login-alias'); symlinkSync(join(w.history, 'credentials'), alias);
  assert.throws(() => runnerFor('codex', { ...w.env, CODEX_HOME: alias }), /login\/configuration/);
  assert.throws(() => runnerFor('codex', { ...w.env, LOOM_RUNTIME_CODEX_RUNS: join(w.history, 'claude-jobs'), LOOM_RUNTIME_CODEX_HOMES: join(w.home, 'homes') }), /overlaps/);
});

test('the actual Codex adapter writes a stand-in native rollout through the durable session link', async () => {
  const w = world();
  const logs = join(w.root, 'native-cli'); mkdirSync(logs);
  const env = { ...w.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, FAKE_HARNESS: logs, FAKE_ROLLOUT: '1', LOOM_RUNTIME_CODEX: new URL('./fake-codex.mjs', import.meta.url).pathname };
  put(join(w.home, '.codex/config.toml'), '');
  put(join(w.home, '.codex/auth.json'), 'fixture credential');
  const native = runnerFor('codex', env, { systemDir: join(w.root, 'no-system-config') });
  const until = async fn => {
    const end = Date.now() + 10_000;
    while (!fn()) { if (Date.now() > end) throw Error('owned native fixture did not reach its boundary'); await new Promise(r => setTimeout(r, 25)); }
  };
  let body, session;
  try {
    body = native.start({ brief: 'model-free native history proof', cwd: w.home, env });
    await until(() => native.slotOf(body)?.session && existsSync(join(logs, 'argv.log')));
    session = native.slotOf(body).session;
    await until(() => existsSync(join(w.history, 'codex-sessions/2026/11/06', `rollout-2026-11-06T12-00-00-${session}.jsonl`)));
  } finally {
    if (body) { native.end(body, env); await until(() => native.stopped(body)); }
  }
  const argv = JSON.parse(readFileSync(join(logs, 'argv.log'), 'utf8').trim());
  assert.equal(argv.home.startsWith(w.history), false, 'the actual generated home with its auth link is outside the durable mount');
  rmSync(w.home, { recursive: true });
  const snapshot = join(w.root, 'offline'); snapshotNativeHistory(w.history, snapshot);
  const got = offlineNativeSession(snapshot, { harness: 'codex', id: body.id });
  assert.equal(got.session, session);
  assert.equal(got.files.length, 1);
  assert.match(Buffer.from(got.files[0].data, 'base64').toString(), /token_count/);
});

test('native constructor overrides cannot redirect durable history or persist generated credentials', () => {
  const w = world();
  assert.throws(() => runnerFor('codex', w.env, { runsDir: join(w.home, 'elsewhere') }), /override durable/);
  assert.throws(() => runnerFor('codex', w.env, { homesDir: join(w.history, 'credentials') }), /persist credential/);
  assert.throws(() => runnerFor('claude', w.env, { projectsDir: join(w.home, 'elsewhere') }), /override durable/);
  assert.deepEqual(runnerFor('claude', w.env, { args: ['--selected-fixture-option'] }).args, ['--selected-fixture-option']);
});
