import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBodyHost } from '../src/bodyhost.mjs';
import { scratch } from './scratch.mjs';

test('a requested stop waits for process exit before packing the final session', async () => {
  const home = scratch('rt-stop-');
  const file = join(home, 'session');
  writeFileSync(file, 'before stop');
  let beat = 0, ends = 0, packed;
  const native = {
    start: () => ({ id: 'b1' }), status: () => beat < 2 ? 'working' : 'idle',
    stopped: () => beat >= 4, end: () => { ends++; },
    slotOf: () => ({ harness: 'codex', session: 's1' }),
    roots: { sessions: home }, sessionFiles: () => ({ keep: [{ root: 'sessions', rel: 'session' }], drop: [] }),
  };
  await runBodyHost({ runner: () => native, env: { HOME: home, LOOM_LOGIN_CODEX: '/login' }, hostKey: 'boot', idleS: 0, beats: 7,
    sleep: async () => {
      beat++;
      if (beat <= 4) assert.equal(readFileSync(file, 'utf8'), 'before stop', 'a live process still owns its files');
      if (beat === 4) writeFileSync(file, 'final flush');
    },
    client: async (path, body) => {
      if (path !== 'body-sync') return {};
      if (body.report.packed.b1) packed = body.report.packed.b1;
      return { req: beat === 0 ? { r1: { harness: 'codex', brief: 'work' } } : {}, ...(beat ? { stop: { b1: { at: 1, pack: true } } } : {}) };
    },
  });
  assert.equal(ends, 1, 'the same stop is requested once');
  assert.equal(existsSync(file), false);
  const files = JSON.parse(Buffer.from(packed.data, 'base64').toString());
  assert.equal(Buffer.from(files[0].data, 'base64').toString(), 'final flush');
});
