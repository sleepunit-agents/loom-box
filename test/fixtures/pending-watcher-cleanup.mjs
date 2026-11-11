import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import * as watchers from '../../src/house-watchers.mjs';

test('default cleanup gates adoption until death is confirmed, including after a failed attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pending-cleanup-'));
  const podman = join(dir, 'podman'), waits = join(dir, 'waits');
  // Inspection sees an existing container; a real guardian launches its wait.
  writeFileSync(podman, '#!/bin/sh\ncase "$1" in\ninspect) echo true;;\nwait) echo "$2" >> "' + waits + '"; exec sleep 300;;\nesac\n', { mode: 0o755 });
  const attempts = [], logs = [];
  const stale = [12345];
  mock.module('../../src/house-watchers.mjs', { namedExports: {
    ...watchers,
    reapHouseWaits(command, names) {
      assert.equal(command, podman);
      assert.deepEqual([...names], ['loom-house-h-123']);
      return stale;
    },
    waitForHouseWaits(pids) {
      assert.equal(pids, stale, 'default hook waits for the PIDs it reaped');
      return new Promise((resolve, reject) => attempts.push({ resolve, reject }));
    },
  } });
  const { runner } = await import('../../src/box.mjs');
  const r = runner({ HOME: dir, PATH: process.env.PATH, LOOM_BOX_DATA: join(dir, 'data'), LOOM_BOX_PODMAN: podman },
    { async call(path) { return path === 'poll' ? { active: ['h-123'] } : {}; } },
    { loomUrl: 'http://loom.test/mcp', log: m => logs.push(m), sweep: () => [], status: () => null,
      sampleHealth: () => null, bootInfo: () => null, sampleUnits: () => null });
  const pause = () => new Promise(resolve => setTimeout(resolve, 10));
  const until = async fn => {
    for (let n = 0; n < 200; n++) { if (fn()) return; await pause(); }
    throw Error('timed out');
  };
  const blocked = () => {
    assert.equal(r.houses.size, 0, 'no house adopted while cleanup is pending');
    assert.equal(existsSync(waits), false, 'no successor wait launched');
    assert.equal(logs.some(m => m.startsWith('adopted ')), false);
  };
  let tick;
  try {
    tick = r.tick();
    await until(() => attempts.length === 1);
    await pause(); blocked();
    attempts[0].reject(Error('SIGKILL still pending'));
    await tick;
    blocked();
    assert.ok(logs.some(m => m.includes('SIGKILL still pending')));
    tick = r.tick();
    await until(() => attempts.length === 2);
    await pause(); blocked();
    attempts[1].resolve();
    await tick;
    assert.equal(r.houses.get('h-123')?.adopted, true);
    await until(() => existsSync(waits));
    assert.equal(readFileSync(waits, 'utf8'), 'loom-house-h-123\n');
    await r.tick();
    assert.equal(attempts.length, 2, 'successful cleanup completes startup once');
  } finally {
    for (const attempt of attempts) attempt.resolve();
    await tick;
    const child = r.houses.get('h-123')?.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.removeAllListeners('exit');
      const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    }
    mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
