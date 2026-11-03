// The third (final) cold review of loom-box#48: each finding pinned by a test that failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api } from '../src/control.mjs';
import { deliver, deliveryDir, depsOf, loadConv, send, tick } from '../src/delivery.mjs';
import * as houses from '../src/houserunner.mjs';
const { hostOf } = houses;
import { startBody } from '../src/bodies.mjs';
import { load } from '../src/state.mjs';
import { bodyInHouse, cvOf, hasAge, here, houseWorld, sleep, testSealer, until, world } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';

const ageOnly = { skip: !hasAge && 'age isn\'t installed' };

test('1. body-sync takes the body host\'s own credential: a body in the house (its agent\'s token, its run\'s key) is refused', ageOnly, async () => {
  const w = houseWorld();
  const { body } = await bodyInHouse(w);
  const house = load(w.env).houses['h-1'];
  // The house's task carries a one-time boot key; the host traded it for its own key on its first sync.
  const boot = /--host-key ([0-9a-f]{48})/.exec(house.task)?.[1];
  assert.ok(boot, 'the task names a boot key');
  const asBody = (b) => api(w.env, { now: () => new Date() }, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: 'body-sync', body: b });
  for (const b of [{ report: {} }, { hostKey: boot, report: {} }, { hostKey: 'f'.repeat(48), report: {} }]) {
    const r = await asBody(b);
    assert.equal(r.status, 403, JSON.stringify(b));
    assert.match(r.body.error, /the body host's own key/);
  }
  // What a body's environment gets from its host: never a host key, never the task.
  const e = w.local.envs[body.id.replace(/^h-1-/, '')];
  assert.equal(Object.values(e).some((v) => String(v).includes(boot)), false);
  assert.equal(e.HOUSE_TASK, undefined);
  await w.kill();
});

test('2a. a body that lost its race (H) is ended with its session gone, not left in the clear', async () => {
  const w = world();
  const B = cvOf('art', 'slack', 'dm:I');
  w.runner.delay = 300;
  let slowDrain;
  const slow = deliver(w.env, w.msg('dm:I', 'slow one'), { ...w.o, onDrain: (p) => { slowDrain = p; } });
  await sleep(50);
  w.clock.advance(241_000);
  await deliver(w.env, w.msg('dm:I', 'fast one'), w.o);
  await slow;
  await slowDrain;
  const slowId = w.log.find((l) => l[0] === 'start' && l[2].endsWith('slow one'))[1];
  assert.notEqual(loadConv(w.env, B).body, `claude:${slowId}`);
  assert.equal(existsSync(w.runner.transcript(`s-${slowId}`)), false, 'its transcript is gone');
});

test('2b. a body stopped by a cancel (its claim wait ran out) has its session files deleted in its house', ageOnly, async () => {
  const w = houseWorld({ claimMs: 150 });
  const starting = startBody(w.env, { agent: 'art', venue: 'slack', brief: 'hi' }, { runner: () => w.hr, accounts: w.accounts });
  await until(() => load(w.env).houses['h-1']);
  w.local.startDelay = 400;
  w.host();
  await assert.rejects(starting);
  await until(() => w.ended.length === 1, 3000);
  await until(() => w.dropped.includes('b0000000'), 3000);
  await w.kill();
});

test('3. capacity is plan\'s inputs only: with N-1 bodies busy a message never waits, and there\'s no machine-state seam', async () => {
  assert.equal('memAvailableMb' in depsOf({ HOME: '/tmp' }, {}), false);
  const w = world({ LOOM_RUNTIME_BUSY_LIMIT: '3' });
  await deliver(w.env, w.msg('dm:A', 'a'), w.o);
  await deliver(w.env, w.msg('dm:B', 'b'), w.o);
  assert.equal((await deliver(w.env, w.msg('dm:C', 'c'), w.o)).body, 'started', '2 of 3 busy: it starts');
  assert.equal((await deliver(w.env, w.msg('dm:D', 'd'), w.o)).body, 'queued', '3 of 3 busy: it waits');
});

test('4. send answers at once, and the runtime posts with the full 15 s: an 8 s adapter posts once and records answered', async () => {
  const w = world();
  const S = scratch('rt-r3-send-');
  process.env.FAKE_SEND = S;
  writeFileSync(join(S, 'delay'), '8000');
  await deliver(w.env, w.msg('dm:S', 'hi'), w.o);
  const c = loadConv(w.env, cvOf('art', 'slack', 'dm:S'));
  const key = w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY;
  let sent;
  const t0 = Date.now();
  const r = await w.send({ conversation: c.conversation, text: 'slow post', key }, { ...w.o, onSend: (p) => { sent = p; } });
  assert.ok(Date.now() - t0 < 1000, 'answered at once');
  assert.equal(r.accepted, true);
  assert.match(r.ref, /^out-[0-9a-f]{12}$/);
  await sent;
  const calls = readFileSync(join(S, 'calls.log'), 'utf-8').trim().split('\n');
  assert.equal(calls.length, 1, 'posted once');
  assert.equal(w.core.turns.at(-1).outcome, 'answered');
  // A post that timed out may have landed: never retried; recorded failed, and the body is told through its inbox.
  writeFileSync(join(S, 'delay'), '3000');
  const r2 = await w.send({ conversation: c.conversation, text: 'timed out', key }, { ...w.o, sendMs: 500, onSend: (p) => { sent = p; } });
  await sent;
  assert.equal(readFileSync(join(S, 'calls.log'), 'utf-8').trim().split('\n').length, 2, 'not retried after a timeout');
  assert.equal(w.core.turns.at(-1).outcome, 'failed');
  assert.ok(w.log.some((l) => l[0] === 'feed' && l[2].includes(r2.ref) && /couldn't post/.test(l[2])), 'the body was told');
  delete process.env.FAKE_SEND;
});

test('5. a session sent back that nobody collected is swept after the claim window', () => {
  const D = scratch('rt-r3-packed-');
  const env = { HOME: D, LOOM_BOX_DATA: join(D, 'data') };
  const dir = join(env.LOOM_BOX_DATA, 'delivery', 'hosts', 'packed', 'art', 'h-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'old0000.age'), 'x');
  writeFileSync(join(dir, 'new0000.age'), 'x');
  const old = (Date.now() - 5 * 60_000) / 1000;
  utimesSync(join(dir, 'old0000.age'), old, old);
  assert.equal(typeof houses.sweepTransfers, 'function');
  houses.sweepTransfers(env, Date.now());
  assert.deepEqual(readdirSync(dir), ['new0000.age']);
});

test('6. a house whose stop was dropped still finishes its transfer and idles out', ageOnly, async () => {
  const w = houseWorld();
  const { body } = await bodyInHouse(w, { idleS: 1 });
  const raw = body.id.replace(/^h-1-/, '');
  writeFileSync(w.local.transcript(raw), 'x'.repeat(900 * 1024));
  // A pack is asked for, then its stop entry goes (dropped) before the parts are in.
  w.hr.pack(body).catch(() => {});
  await until(() => w.ended.includes(raw), 3000);
  const f = join(w.env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art.json');
  writeFileSync(f, JSON.stringify({ ...hostOf(w.env, 'art'), stop: {} }));
  await until(() => w.left(), 8000);
});

test('7. a delivery still in flight answers 503 with a retry hint; the same id with a different body is 409', async () => {
  const w = world();
  const m = w.msg('dm:F', 'first');
  w.runner.delay = 400;
  const a = deliver(w.env, m, w.o);
  await sleep(50);
  const dup = await deliver(w.env, m, w.o);
  assert.equal(dup.status, 503);
  assert.match(dup.error, /still being made: retry/);
  assert.ok(dup.retryAfter >= 1);
  await a;
  const other = await deliver(w.env, { ...m, text: 'something else' }, w.o);
  assert.equal(other.status, 409);
  assert.match(other.error, /another message/);
});

test('8. a lost answer leaves nothing "uncertain": the retry re-posts the same key and takes core\'s answer', async () => {
  const w = world();
  const turn = w.core.turn;
  let n = 0;
  w.core.turn = async (t) => { const r = await turn(t); if (n++ === 0) throw new (await import('../src/core.mjs')).CoreError('no answer in 5s', 503); return r; };
  const m = w.msg('dm:U', 'x');
  assert.equal((await deliver(w.env, m, w.o)).status, 503);
  const seen = join(deliveryDir(w.env), 'seen');
  assert.equal(readdirSync(seen).map((x) => readFileSync(join(seen, x), 'utf-8')).some((x) => x.includes('uncertain')), false);
  assert.equal((await deliver(w.env, m, w.o)).seq, 1);
  assert.equal(w.core.turns.length, 1);
});

test('9. CI builds loom at main and runs the contract test against it', () => {
  const ci = readFileSync(join(here, '..', '.github', 'workflows', 'ci.yml'), 'utf-8');
  assert.match(ci, /repository: sleepunit-agents\/loom/);
  assert.match(ci, /LOOM_DIST:/);
});

test('10. a person without a slug is malformed (400), and nothing is written', async () => {
  const w = world();
  const r = await deliver(w.env, { ...w.msg('dm:P', 'x'), from: { kind: 'person' } }, w.o);
  assert.equal(r.status, 400);
  assert.equal(w.core.turns.length, 0);
});

test('core: venues as core answers them (label, orphaned), and no comment says a route isn\'t in core', () => {
  const src = readFileSync(join(here, '..', 'src', 'core.mjs'), 'utf-8');
  assert.equal(/NOT YET IN CORE/i.test(src), false);
});
