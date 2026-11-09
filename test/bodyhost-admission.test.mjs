import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runBodyHost } from '../src/bodyhost.mjs';
import { runnerFor } from '../src/runners.mjs';
import { readLaunch } from '../src/launch-journal.mjs';
import { scratch } from './scratch.mjs';

for (const harness of ['claude', 'codex']) test(`${harness}: a real native worker can remain pending while the host syncs and receives shutdown`, async () => {
  const home = scratch('bodyhost-native-admission-'), id = 'a'.repeat(64), rid = 'b'.repeat(16);
  const release = join(home, 'release'), marker = join(home, 'native-waiting');
  const native = new URL(harness === 'claude' ? './fake-claude.mjs' : './fake-codex.mjs', import.meta.url).href;
  const executable = join(home, 'gated-native.mjs');
  writeFileSync(executable, '#!/usr/bin/env node\nimport{existsSync,writeFileSync}from"node:fs";writeFileSync('+JSON.stringify(marker)+',"waiting");while(!existsSync('+JSON.stringify(release)+'))await new Promise(r=>setTimeout(r,10));await import('+JSON.stringify(native)+');\n');
  chmodSync(executable, 0o755);
  const codex = join(home, 'codex'); mkdirSync(codex); writeFileSync(join(codex, 'config.toml'), 'model="gpt"\n');
  const env = { ...process.env, HOME: home, PATH: dirname(process.execPath)+':'+process.env.PATH, FAKE_HARNESS: home, CODEX_HOME: codex,
    LOOM_BOX_DATA: join(home, 'data'), LOOM_RUNTIME_CLAUDE: executable, LOOM_RUNTIME_CODEX: executable, LOOM_RUNTIME_CODEX_PROFILE: '',
    LOOM_RUNTIME_CLAUDE_JOBS: join(home, 'jobs'), LOOM_RUNTIME_CODEX_RUNS: join(home, 'runs'), LOOM_RUNTIME_INBOX_DIR: join(home, 'inbox'),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/login', LOOM_LOGIN_CODEX: '/fixture/login', HOUSE_TASK: 'private-bootstrap-never-native-env' };
  const q = { attempt: id, harness, model: harness === 'codex' ? 'gpt' : 'opus', brief: 'harmless native host fixture' + (harness === 'codex' ? 'x'.repeat(1024 * 1024) : ''), key: 'fixture-body-key', conversation: 'cv-123456abcdef' };
  let pendingSyncs = 0, stopping = false, body, finished = false;
  try {
    await runBodyHost({ env, hostKey: 'private-fixture-bootstrap', runner: h => runnerFor(h, env), sleep: () => new Promise(r=>setTimeout(r,10)), beats: 1000,
      client: async (_path, { report }) => {
        if (report.starting.includes(rid) && !report.done[rid]) pendingSyncs++;
        if (existsSync(marker) && readLaunch(env, id)?.state === 'admitted' && pendingSyncs >= 2) {
          stopping = true; writeFileSync(release, 'continue');
        }
        if (report.done[rid]?.id) {
          body = report.done[rid].id;
          assert.equal(report.done[rid].inputConfirmed, true);
          assert.equal(report.done[rid].attempt, id);
        }
        if (body && (!report.bodies[body] || report.bodies[body].status === 'ended') && !report.starting.length) { finished = true; return { exit: true }; }
        return { req: body || stopping ? {} : { [rid]: q }, ...(stopping ? { stopping: true } : {}),
          stop: body ? { [body]: { at: 1, pack: false } } : {}, received: body ? [rid] : [] };
      } });
    assert.equal(finished, true);
    assert.ok(pendingSyncs >= 2, 'launching did not block authenticated sync');
    assert.equal(readLaunch(env, id).state, 'ready');
    const calls = readFileSync(join(home, 'argv.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(a => harness === 'claude' ? a.includes('--bg') : a.args?.[0] === 'exec').length, 1);
    if (harness === 'claude') assert.equal(JSON.parse(readFileSync(join(home, 'env.log'), 'utf8').trim()).names.includes('HOUSE_TASK'), false);
  } finally {
    writeFileSync(release, 'continue');
    const record = readLaunch(env, id);
    if (record?.body) runnerFor(harness, env).end(record.body, env);
  }
});
