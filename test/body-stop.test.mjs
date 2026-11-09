import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBodyHost } from '../src/bodyhost.mjs';
import { scratch } from './scratch.mjs';

for (const failFirstStop of [false, true]) test(`a requested stop waits for process exit before packing the final session${failFirstStop ? ', retrying a failed request' : ''}`, async () => {
  const home = scratch('rt-stop-');
  const file = join(home, 'session');
  writeFileSync(file, 'before stop');
  let beat = 0, ends = 0, packed;
  const native = {
    start: () => ({ id: 'b1' }), status: () => beat < 2 ? 'working' : 'idle',
    stopped: () => beat >= 4, end: () => { ends++; if (failFirstStop && ends === 1) throw new Error('temporary stop failure'); },
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
  assert.equal(ends, failFirstStop ? 2 : 1, 'only a failed stop request is retried');
  assert.equal(existsSync(file), false);
  const files = JSON.parse(Buffer.from(packed.data, 'base64').toString());
  assert.equal(Buffer.from(files[0].data, 'base64').toString(), 'final flush');
});

for (const persistent of [false, true]) test(`session read failure retains native files and ${persistent ? 'keeps retrying' : 'recovers the final transcript'}`, async () => {
  const home = scratch('rt-pack-retry-');
  const file = join(home, 'session');
  writeFileSync(file, 'only native transcript');
  let beat = 0, ends = 0, reads = 0, packed;
  const native = {
    start: () => ({ id: 'b1' }), status: () => 'idle', stopped: () => true,
    end: () => { ends++; }, slotOf: () => ({ harness: 'codex', session: 's1' }),
    roots: { sessions: home }, sessionFiles: () => {
      reads++;
      if (persistent || reads === 1) throw Object.assign(new Error('temporary native session read failure'), { code: 'EIO' });
      return { keep: [{ root: 'sessions', rel: 'session' }], drop: [] };
    },
  };
  await runBodyHost({ runner: () => native, env: { HOME: home, LOOM_LOGIN_CODEX: '/login' }, hostKey: 'boot', idleS: persistent ? 1 : 0, now: () => beat * 2000, beats: 6,
    sleep: async () => {
      beat++;
      if (persistent || beat === 2) assert.equal(readFileSync(file, 'utf8'), 'only native transcript');
    },
    client: async (path, body) => {
      if (path !== 'body-sync') return {};
      if (body.report.packed.b1) packed = body.report.packed.b1;
      return { req: beat === 0 ? { r1: { harness: 'codex', brief: 'work' } } : {}, ...(beat ? { stop: { b1: { at: 1, pack: true } } } : {}) };
    },
  });
  assert.equal(ends, 1, 'packing retries never repeat the native stop');
  if (persistent) {
    assert.equal(packed, undefined, 'no empty pack acknowledges an unreadable session');
    assert.equal(existsSync(file), true);
    assert.ok(reads >= 3, 'later beats retry collection');
  } else {
    assert.equal(existsSync(file), false);
    const files = JSON.parse(Buffer.from(packed.data, 'base64').toString());
    assert.equal(Buffer.from(files[0].data, 'base64').toString(), 'only native transcript');
  }
});

test('the explicit session size limit still permits an empty continuity pack', async () => {
  const home = scratch('rt-pack-limit-');
  const file = join(home, 'session');
  writeFileSync(file, Buffer.alloc(6 * 1024 * 1024 + 1));
  let beat = 0, packed;
  const native = {
    start: () => ({ id: 'b1' }), status: () => 'idle', stopped: () => true, end: () => {},
    slotOf: () => ({ harness: 'codex', session: 's1' }), roots: { sessions: home },
    sessionFiles: () => ({ keep: [{ root: 'sessions', rel: 'session' }], drop: [] }),
  };
  await runBodyHost({ runner: () => native, env: { HOME: home, LOOM_LOGIN_CODEX: '/login' }, hostKey: 'boot', idleS: 0, beats: 4,
    sleep: async () => { beat++; },
    client: async (path, body) => {
      if (path !== 'body-sync') return {};
      if (body.report.packed.b1) packed = body.report.packed.b1;
      return { req: beat === 0 ? { r1: { harness: 'codex', brief: 'work' } } : {}, ...(beat ? { stop: { b1: { at: 1, pack: true } } } : {}) };
    },
  });
  assert.deepEqual(JSON.parse(Buffer.from(packed.data, 'base64').toString()), []);
  assert.equal(existsSync(file), false);
});

for (const acknowledge of [false, true]) test(`a durable house ${acknowledge ? 'drops native files only after' : 'retains native files without'} the final pack acknowledgement`, async () => {
  const home = scratch('rt-durable-pack-'), history = join(home, 'native'); mkdirSync(history);
  const file = join(history, 'session'); writeFileSync(file, 'native context must survive host loss');
  let beat = 0, ends = 0, sent = false;
  const id = 'b0000000', native = {
    start: () => ({ id }), status: () => 'idle', stopped: () => true, end: () => { ends++; },
    slotOf: () => ({ harness: 'codex', session: 'known-session' }), roots: { sessions: history },
    sessionFiles: () => ({ keep: [{ root: 'sessions', rel: 'session' }], drop: [] }),
  };
  await runBodyHost({ runner: () => native, env: { HOME: home, HOUSE_ID: 'h-1', LOOM_RUNTIME_NATIVE_HISTORY: history, LOOM_LOGIN_CODEX: '/login' }, hostKey: 'boot', idleS: 0, beats: 6,
    sleep: async () => { beat++; },
    client: async (path, body) => {
      if (path !== 'body-sync') return {};
      assert.ok(body.report.caps.includes('native-history'));
      const packed = body.report.packed[id];
      if (packed) { sent = true; assert.equal(readFileSync(file, 'utf8'), 'native context must survive host loss', 'the only native copy remains until the receiver answers'); }
      return { req: beat === 0 ? { r1: { harness: 'codex', brief: 'work' } } : {}, ...(beat ? { stop: { [id]: { at: 1, pack: true } } } : {}), ...(packed && acknowledge ? { acked: [[id, packed.part]] } : {}) };
    },
  });
  assert.equal(sent, true); assert.equal(ends, 1); assert.equal(existsSync(file), !acknowledge);
});
