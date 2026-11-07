import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, loadConv, tick } from '../src/delivery.mjs';
import { CoreError } from '../src/core.mjs';
import { world, sleep } from './delivery-world.mjs';

const message = (w) => w.msg('th:startup', 'hello', { venue: 'loom', source: 'loom' });
const statuses = (w) => w.core.commsCalls.filter((b) => /^start-/.test(b.status ?? ''));

test('a timeout after the initial queued response pushes its reason and retry time to Comms', async () => {
  const w = world();
  w.runner.start = async () => { await sleep(2150); throw new Error('body host did not start in 60 s'); };
  let drain;
  const out = await deliver(w.env, message(w), { ...w.o, onDrain: (p) => { drain = p; } });
  assert.equal(out.body, 'queued');
  assert.equal(statuses(w).length, 0, 'failure is not yet known at response time');
  await drain;
  const note = statuses(w)[0];
  assert.equal(note.status, 'start-retry');
  assert.equal(note.attempt, 1);
  assert.match(note.run, /^start-/);
  assert.match(note.reason, /body host did not start/);
  assert.ok(Date.parse(note.retry_at) > w.clock.now().getTime());
  assert.deepEqual(note.messages, [w.core.turns[0].key.slice('loom:'.length)]);
  assert.equal(loadConv(w.env, out.conversation).startStatus, undefined);
});

test('a transport failure is retried with the same identity; terminal failure advances its attempt', async () => {
  const w = world({ LOOM_RUNTIME_RETRY_S: '[1]' });
  w.runner.failStart = 'host unavailable';
  let down = true;
  w.core.commsAnswer = () => { if (down) throw new CoreError('offline'); return { ok: true }; };
  const out = await deliver(w.env, message(w), w.o);
  const pending = loadConv(w.env, out.conversation).startStatus;
  assert.ok(pending);
  down = false;
  await tick(w.env, w.o);
  assert.deepEqual(statuses(w)[0], statuses(w)[1], 'retry is safe to deduplicate');
  assert.equal(loadConv(w.env, out.conversation).startStatus, undefined);
  w.clock.advance(1001);
  await tick(w.env, w.o);
  const terminal = statuses(w).at(-1);
  assert.equal(terminal.status, 'start-failed');
  assert.equal(terminal.attempt, 2);
  assert.equal(terminal.run, pending.run);
  assert.equal(terminal.retry_at, undefined);
});

test('successful startup cancels unsent failure status and an older core rejection is not retried', async () => {
  for (const rejection of [503, 400]) {
    const w = world({ LOOM_RUNTIME_RETRY_S: '[1]' });
    w.runner.failStart = 'host unavailable';
    w.core.commsAnswer = () => { throw new CoreError('unsupported or offline', rejection); };
    const out = await deliver(w.env, message(w), w.o);
    assert.equal(!!loadConv(w.env, out.conversation).startStatus, rejection === 503);
    const attempts = statuses(w).length;
    w.runner.failStart = null;
    w.core.commsAnswer = null;
    w.clock.advance(1001);
    await tick(w.env, w.o);
    assert.ok(loadConv(w.env, out.conversation).body);
    assert.equal(loadConv(w.env, out.conversation).startStatus, undefined);
    assert.equal(statuses(w).length, attempts, 'never send stale status after working');
  }
});
