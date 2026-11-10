import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandFlags, checkArgs } from '../src/cli-args.mjs';
import { scratch } from './scratch.mjs';

function snapshot(dir) {
  return readdirSync(dir).sort().map(name => {
    const path = join(dir, name), st = statSync(path);
    return [name, st.ino, st.mtimeMs, st.isDirectory() ? snapshot(path) : readFileSync(path, 'utf8')];
  });
}

test('every verb answers either help flag before stdin, remote requests, services or saved state', () => {
  const home = scratch('help-safe-');
  mkdirSync(join(home, 'piece'));
  writeFileSync(join(home, 'piece', 'state.json'), '{"marker":"unchanged"}');
  const env = { ...process.env, HOME: home, LOOM_HOME: home, LOOM_BOX_HOME: join(home, 'piece'), LOOM_BOX_DATA: home,
    LOOM_RUNTIME_KEYS_DIR: home, LOOM_URL: 'http://127.0.0.1:1', LOOM_TOKEN_FILE: join(home, 'must-not-read'),
    HOUSE_ID: 'h-1', LOOM_BODY_CONVERSATION: 'cv-test' };
  const before = snapshot(home);
  const paths = Object.keys(commandFlags).map(cmd => [cmd]);
  for (const path of [['deliver', 'tick'], ['deliver', 'run'], ['usage', 'statusline'], ['models', 'set'], ['gates', 'import'], ['grants', 'seed'], ['body', 'start'], ['service', 'up']]) paths.push(path);
  for (const path of paths) for (const help of ['-h', '--help']) {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '../src/cli.mjs'), ...path, '--invalid', help], { env, encoding: 'utf8', input: '{invalid', timeout: 3000 });
    assert.equal(r.status, 0, `${path} ${help}: ${r.stderr} ${r.error ?? ''}`);
    assert.match(r.stdout, /loom runtime/);
    assert.deepEqual(snapshot(home), before, `${path} ${help}`);
  }
});

test('all verbs reject unknown flags before dispatch; values are checked and action flags stay usable', () => {
  for (const cmd of Object.keys(commandFlags).filter(c => c !== 'help')) {
    assert.throws(() => checkArgs([cmd, '--typo']), /unknown flag/);
    assert.throws(() => checkArgs([cmd, '-x']), /unknown flag/);
    for (const f of commandFlags[cmd].split(' ').filter(f => f.endsWith('='))) {
      assert.throws(() => checkArgs([cmd, `--${f.slice(0, -1)}`]), /needs a value/);
    }
  }
  for (const [cmd, flag] of [['send', '--text'], ['up', '--task'], ['spawn', '--brief']]) {
    for (const text of ['-hello', '- fix the bug', '--this is literal prose']) {
      assert.deepEqual(checkArgs([cmd, flag, text]), { help: false });
    }
  }
  assert.deepEqual(checkArgs(['run', '--local']), { help: false });
  assert.deepEqual(checkArgs(['deliver', 'run', '--once']), { help: false });
  assert.deepEqual(checkArgs(['up', '--task', '-']), { help: false });
  assert.deepEqual(checkArgs(['send', '--text', 'a message with --flags inside']), { help: false });
});
