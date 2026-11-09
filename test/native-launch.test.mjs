import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchAttempt, readLaunch } from '../src/launch-journal.mjs';
import { superviseNativeLaunch } from '../src/native-launch.mjs';
import { runnerFor } from '../src/runners.mjs';
import { scratch } from './scratch.mjs';

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
function controller(w, pollMs = 10) {
  const code = `import{readFileSync}from'node:fs';import{superviseNativeLaunch}from${JSON.stringify(new URL('../src/native-launch.mjs', import.meta.url).href)};const q=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify(await superviseNativeLaunch(process.env,q,{pollMs:${pollMs}})));`;
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
    const runner = runnerFor('codex', w.env);
    runner.end(record.body);
    await wait(() => runner.stopped(record.body));
  }
}

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
