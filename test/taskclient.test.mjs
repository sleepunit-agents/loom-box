import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runTaskClient } from '../src/taskclient.mjs';

for (const early of [false, true]) test(`task client ${early ? 'interrupted during bootstrap' : 'interrupted during work'} retains the host through a failed cancellation call and pending session collection`, async () => {
  const signals = new EventEmitter(); let tries = 0, collected = false, ended = false;
  const paths = [];
  const call = async (path, body) => {
    paths.push(path);
    if (path === 'script-bootstrap') { if (early) signals.emit('SIGINT'); assert.equal(body.brief, 'exact\nmodel brief'); return { hostKey: 'private-host-key' }; }
    if (path === 'task-cancel') { if (++tries === 1) throw Error('temporary outage'); return { accepted: true, state: 'pending' }; }
    if (path === 'task-status') return collected ? { done: true, ok: false, reason: 'cancelled after collection' } : { done: false };
    return {};
  };
  const result = await runTaskClient({ call, signals, brief: 'exact\nmodel brief', env: {}, runner() {}, host: async ({ client, hostKey }) => {
    assert.equal(hostKey, 'private-host-key');
    if (!early) signals.emit('SIGTERM');
    await assert.rejects(client('body-sync', {}), /outage/);
    assert.equal((await client('body-sync', {})).exit, undefined, 'accepted stop is not a saved session');
    collected = true;
    assert.equal((await client('body-sync', {})).exit, true);
    ended = true;
  } });
  assert.equal(tries, 2, 'retry cancellation after lost acknowledgement');
  assert.equal(result.ok, false); assert.equal(ended, true);
  assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.ok(paths.includes('task-status'));
});

test('ordinary task client returns the collected report and cleans listeners on failed bootstrap', async () => {
  const signals = new EventEmitter();
  const call = async path => path === 'task-bootstrap' ? { hostKey: 'key' } : path === 'task-status' ? { done: true, ok: true, report: 'FINAL' } : {};
  const result = await runTaskClient({ call, signals, env: {}, runner() {}, host: async ({ client }) => { assert.equal((await client('body-sync', {})).exit, true); } });
  assert.equal(result.report, 'FINAL');
  await assert.rejects(runTaskClient({ call: async () => { throw Error('bootstrap failed'); }, signals }), /bootstrap/);
  assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
});
