import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { admitLaunch, completeLaunch, launchAttempt, readLaunch, reserveLaunch } from '../src/launch-journal.mjs';
import { superviseNativeLaunch } from '../src/native-launch.mjs';
import { configuredNativeRunner, nativeRecoveryConfiguration, nativeRunnerConfiguration, runnerFor } from '../src/runners.mjs';
import { scratch } from './scratch.mjs';
import { MAX_SESSION_BYTES } from '../src/sessions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const wait = async fn => {
  const end = Date.now() + 10_000;
  for (;;) { const result = fn(); if (result) return result; if (Date.now() > end) throw new Error('native supervisor fixture did not settle'); await new Promise(r => setTimeout(r, 10)); }
};
function setup(harness) {
  const home = scratch('native-supervisor-');
  const codex = join(home, 'codex');
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, 'config.toml'), 'model = "gpt"\n');
  const env = { ...process.env, HOME: home, PATH: dirname(process.execPath) + ':' + process.env.PATH,
    FAKE_HARNESS: home, CODEX_HOME: codex, LOOM_BOX_DATA: join(home, 'data'),
    LOOM_RUNTIME_CLAUDE: join(here, 'fake-claude.mjs'), LOOM_RUNTIME_CLAUDE_JOBS: join(home, 'jobs'),
    LOOM_RUNTIME_CODEX: join(here, 'fake-codex.mjs'), LOOM_RUNTIME_CODEX_RUNS: join(home, 'runs'),
    LOOM_RUNTIME_INBOX_DIR: join(home, 'inbox'), LOOM_RUNTIME_CODEX_PROFILE: '' };
  const request = { id: launchAttempt('cv-123456789abc', 'abcdef123456'), harness,
    options: { brief: 'Harmless fixture prompt', model: harness === 'codex' ? 'gpt' : 'opus', cwd: home, env } };
  const argv = () => existsSync(join(home, 'argv.log')) ? readFileSync(join(home, 'argv.log'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { home, env, request, argv };
}
function controller(w, pollMs = 10, program) {
  const code = program ?? `import{readFileSync}from'node:fs';import{superviseNativeLaunch}from${JSON.stringify(new URL('../src/native-launch.mjs', import.meta.url).href)};const q=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify(await superviseNativeLaunch(process.env,q,{pollMs:${pollMs}})));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: w.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stderr += b; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  child.stdin.end(JSON.stringify(w.request));
  return { child, done, output: () => stdout };
}
async function cleanup(w) {
  const record = readLaunch(w.env, w.request.id);
  if (record?.body && w.request.harness === 'codex') {
    const runner = configuredNativeRunner('codex', w.request.configuration, w.env);
    runner.end(record.body);
    await wait(() => runner.stopped(record.body));
  }
}

test('the worker uses the selected native configuration rather than silently rebuilding another one', async () => {
  const w = setup('claude');
  const config = nativeRunnerConfiguration(runnerFor('claude', w.env));
  config.args = ['--fixture-selected-native-option'];
  const observation = nativeRecoveryConfiguration(configuredNativeRunner('claude', config, w.env));
  assert.equal(observation.jobsDir, config.jobsDir);
  assert.equal(observation.args, undefined, 'observation metadata excludes private native arguments');
  w.request.configuration = config;
  const body = await superviseNativeLaunch(w.env, w.request, { pollMs: 10 });
  assert.equal(body.harness, 'claude');
  assert.ok(w.argv().find(a => a[0] === '--bg').includes('--fixture-selected-native-option'));
  const journal = JSON.stringify(readLaunch(w.env, w.request.id));
  assert.doesNotMatch(journal, /fixture-selected-native-option|Harmless fixture prompt/, 'private launch options never become journal metadata');
});

for (const harness of ['claude', 'codex']) {
  test(`${harness}: independent controllers receive one worker's committed native receipt`, async () => {
    const w = setup(harness), controllers = [controller(w), controller(w)];
    try {
      const results = await Promise.all(controllers.map(c => c.done));
      for (const result of results) assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(results[0].stdout), JSON.parse(results[1].stdout));
      assert.equal(readLaunch(w.env, w.request.id).state, 'ready');
      await wait(() => w.argv().some(a => harness === 'claude' ? a[0] === '--bg' : a.args?.[0] === 'exec'));
      const starts = w.argv().filter(a => harness === 'claude' ? a[0] === '--bg' : a.args?.[0] === 'exec');
      assert.equal(starts.length, 1, 'only one actual native executable launch');
    } finally { for (const c of controllers) if (c.child.exitCode === null) c.child.kill('SIGKILL'); await cleanup(w); }
  });
}

test('a registrar killed before receiving its body is replaced by observation of the same actual native process', async () => {
  const w = setup('codex'), original = controller(w, 1000);
  try {
    const record = await wait(() => { const r = readLaunch(w.env, w.request.id); return r?.state === 'ready' && r; });
    assert.equal(original.output(), '', 'registrar has not received the committed receipt');
    original.child.kill('SIGKILL');
    const ended = await original.done;
    assert.equal(ended.signal, 'SIGKILL');
    const replacement = await superviseNativeLaunch(w.env, w.request, { pollMs: 10 });
    assert.equal(replacement.id, record.body.id);
    await wait(() => w.argv().some(a => a.args?.[0] === 'exec'));
    assert.equal(w.argv().filter(a => a.args?.[0] === 'exec').length, 1);
    assert.equal(runnerFor('codex', w.env).alive(replacement.id), true);
  } finally { if (original.child.exitCode === null) original.child.kill('SIGKILL'); await cleanup(w); }
});

test('positive native exec failure is a durable refusal, with no indefinite uncertain admission', async () => {
  const w = setup('codex');
  w.env.LOOM_RUNTIME_CODEX = join(w.home, 'absent-native');
  w.request.options.env = w.env;
  await assert.rejects(superviseNativeLaunch(w.env, w.request, { pollMs: 10 }), e => e.nativeNotStarted === true);
  assert.equal(readLaunch(w.env, w.request.id).state, 'refused');
});

test('worker termination after real native admission recovers identity but preserves input uncertainty', async () => {
  const w = setup('codex');
  const { harness, options } = w.request;
  reserveLaunch(w.env, { id: w.request.id, harness, intentHash: createHash('sha256').update(JSON.stringify({ harness, options })).digest('hex') });
  const code = `import{readFileSync}from'node:fs';import{admitLaunch}from${JSON.stringify(new URL('../src/launch-journal.mjs', import.meta.url).href)};import{runnerFor}from${JSON.stringify(new URL('../src/runners.mjs', import.meta.url).href)};const q=JSON.parse(readFileSync(0,'utf8'));const a=admitLaunch(process.env,q.id);const b=runnerFor(q.harness,process.env).start({...q.options,launchToken:a.record.token});await b.inputReady;console.log(JSON.stringify({id:b.id}));`;
  const worker = controller(w, 10, code);
  try {
    const ended = await worker.done;
    assert.equal(ended.code, 0, ended.stderr);
    const original = JSON.parse(ended.stdout);
    assert.equal(readLaunch(w.env, w.request.id).state, 'admitted', 'worker ended before committing its receipt');
    const recovered = await superviseNativeLaunch(w.env, w.request, { pollMs: 10 });
    assert.equal(recovered.id, original.id);
    assert.equal(recovered.inputUncertain, true, 'no receipt proves prompt delivery after worker death');
    await wait(() => w.argv().some(a => a.args?.[0] === 'exec'));
    assert.equal(w.argv().filter(a => a.args?.[0] === 'exec').length, 1);
    assert.equal(runnerFor('codex', w.env).alive(recovered.id), true);
  } finally { if (worker.child.exitCode === null) worker.child.kill('SIGKILL'); await cleanup(w); }
});

for (const failure of ['fork-throws', 'helper-exits-before-admission']) test(`a ${failure} refuses its reservation without native work`, async () => {
  const w = setup('codex');
  const spawnWorker = failure === 'fork-throws'
    ? () => { throw Error('fixture fork failure'); }
    : (_exe, _argv, options) => spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(1));'], options);
  await assert.rejects(superviseNativeLaunch(w.env, w.request, { pollMs: 5, spawnWorker }), error => error.nativeNotStarted === true);
  assert.equal(readLaunch(w.env, w.request.id).state, 'refused');
  assert.equal(w.argv().length, 0);
});


test('a failed helper cannot cancel a worker already admitted by another registrar', async () => {
  const w = setup('codex');
  const native = { id: 'fixture1234', harness: 'codex', slot: { harness: 'codex', session: 'fixture-session' } };
  const result = await superviseNativeLaunch(w.env, w.request, { pollMs: 5, spawnWorker() {
    assert.equal(admitLaunch(w.env, w.request.id).admitted, true);
    setTimeout(() => completeLaunch(w.env, w.request.id, native, { inputConfirmed: true }), 20);
    throw Error('the losing registrar could not fork its helper');
  } });
  assert.equal(result.id, native.id);
  assert.equal(readLaunch(w.env, w.request.id).state, 'ready');
  assert.equal(w.argv().length, 0);
});


for (const harness of ['claude', 'codex']) test(`${harness}: only the admitted worker restores resume files; repeated observation preserves a live writer's edits`, async () => {
  const w = setup(harness);
  const root = harness === 'claude' ? 'projects' : 'sessions';
  const rel = 'restore-fixture/session.jsonl';
  const target = join(runnerFor(harness, w.env).roots[root], rel);
  const native = new URL(harness === 'claude' ? './fake-claude.mjs' : './fake-codex.mjs', import.meta.url).href;
  const executable = join(w.home, 'restore-check.mjs');
  writeFileSync(executable, '#!/usr/bin/env node\nimport{readFileSync}from"node:fs";if(readFileSync('+JSON.stringify(target)+',"utf8")!=="restored-native-context")process.exit(42);await new Promise(r=>setTimeout(r,60));await import('+JSON.stringify(native)+');\n');
  chmodSync(executable, 0o755);
  w.env[harness === 'claude' ? 'LOOM_RUNTIME_CLAUDE' : 'LOOM_RUNTIME_CODEX'] = executable;
  w.request.resume = { harness, session: 'restore-fixture-session' };
  w.request.files = [{ root, rel, data: Buffer.from('restored-native-context').toString('base64') }];
  try {
    const [one, two] = await Promise.all([superviseNativeLaunch(w.env, w.request, { pollMs: 5 }), superviseNativeLaunch(w.env, w.request, { pollMs: 5 })]);
    assert.equal(one.id, two.id);
    await wait(() => w.argv().some(a => harness === 'claude' ? a.includes('--bg') : a.args?.[0] === 'exec'));
    writeFileSync(target, 'native continued writing');
    const recovered = await superviseNativeLaunch(w.env, w.request, { pollMs: 5 });
    assert.equal(recovered.id, one.id);
    assert.equal(readFileSync(target, 'utf8'), 'native continued writing');
    assert.equal(w.argv().filter(a => harness === 'claude' ? a.includes('--bg') : a.args?.[0] === 'exec').length, 1);
  } finally { await cleanup(w); }
});

test('a restore error is a confirmed pre-native refusal, not an indefinitely admitted attempt', async () => {
  const w = setup('codex');
  w.request.resume = { harness: 'codex', session: 'restore-fixture-session' };
  w.request.files = [{ root: 'sessions', rel: '../outside', data: Buffer.from('invalid').toString('base64') }];
  await assert.rejects(superviseNativeLaunch(w.env, w.request, { pollMs: 5 }), error => error.nativeNotStarted === true);
  assert.equal(readLaunch(w.env, w.request.id).state, 'refused');
  assert.equal(w.argv().length, 0);
});

test('a worker killed during resumed native input keeps restored files and recovers the same writer as input-uncertain', async () => {
  const w = setup('codex');
  const rel = 'restore-fixture/session.jsonl';
  const target = join(runnerFor('codex', w.env).roots.sessions, rel);
  const marker = join(w.home, 'native-restored-and-writing');
  const release = join(w.home, 'release-native-input');
  const executable = join(w.home, 'delayed-native.mjs');
  const native = new URL('./fake-codex.mjs', import.meta.url).href;
  writeFileSync(executable, '#!/usr/bin/env node\nimport{existsSync,readFileSync,writeFileSync}from"node:fs";if(readFileSync('+JSON.stringify(target)+',"utf8")!=="restored-native-context")process.exit(42);writeFileSync('+JSON.stringify(target)+',"native writer updated its restored context");writeFileSync('+JSON.stringify(marker)+',"ready");while(!existsSync('+JSON.stringify(release)+'))await new Promise(r=>setTimeout(r,10));await import('+JSON.stringify(native)+');\n');
  chmodSync(executable, 0o755);
  w.env.LOOM_RUNTIME_CODEX = executable;
  w.request.resume = { harness: 'codex', session: 'restore-fixture-session' };
  w.request.files = [{ root: 'sessions', rel, data: Buffer.from('restored-native-context').toString('base64') }];
  // Backpressure keeps the worker before input confirmation until the native
  // fixture starts reading. Killing it in that window cannot prove delivery.
  w.request.options.brief = 'x'.repeat(1024 * 1024);
  const registrar = controller(w);
  try {
    await wait(() => existsSync(marker));
    const admitted = readLaunch(w.env, w.request.id);
    assert.equal(admitted.state, 'admitted');
    const originalPID = readFileSync(join(w.env.LOOM_RUNTIME_CODEX_RUNS, admitted.token, 'pid'), 'utf8');
    process.kill(admitted.worker.pid, 'SIGKILL');
    const result = await registrar.done;
    assert.equal(result.code, 0, result.stderr);
    const recovered = JSON.parse(result.stdout);
    assert.equal(recovered.inputUncertain, true);
    assert.equal(recovered.id, admitted.token);
    assert.equal(readFileSync(join(w.env.LOOM_RUNTIME_CODEX_RUNS, recovered.id, 'pid'), 'utf8'), originalPID);
    writeFileSync(release, 'continue');
    assert.equal(readFileSync(target, 'utf8'), 'native writer updated its restored context');
    await wait(() => w.argv().some(a => a.args?.[0] === 'exec'));
    assert.equal(w.argv().filter(a => a.args?.[0] === 'exec').length, 1);
    assert.equal(readLaunch(w.env, w.request.id).body.id, recovered.id);
  } finally {
    writeFileSync(release, 'continue');
    if (registrar.child.exitCode === null) registrar.child.kill('SIGKILL');
    const record = readLaunch(w.env, w.request.id);
    if (record && !record.body && existsSync(marker)) {
      const runner = runnerFor('codex', w.env), found = runner.recoverLaunch(record.token);
      if (found.state === 'ready') { runner.end(found.body); await wait(() => runner.stopped(found.body)); }
    }
    await cleanup(w);
  }
});


test('the private worker input accepts a full supported session pack plus its launch metadata', async () => {
  const w = setup('codex');
  const data = Buffer.alloc(MAX_SESSION_BYTES, 120);
  w.request.resume = { harness: 'codex', session: 'maximum-pack-session' };
  w.request.files = [{ root: 'sessions', rel: 'maximum-pack/session.jsonl', data: data.toString('base64') }];
  try {
    const body = await superviseNativeLaunch(w.env, w.request, { pollMs: 5 });
    const file = join(runnerFor('codex', w.env).roots.sessions, 'maximum-pack/session.jsonl');
    assert.equal(readFileSync(file).byteLength, MAX_SESSION_BYTES);
    assert.equal(body.harness, 'codex');
    assert.equal(readLaunch(w.env, w.request.id).state, 'ready');
  } finally { await cleanup(w); }
});
