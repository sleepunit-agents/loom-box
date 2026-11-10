// Worker capacity admission, shadow slice (t-2037): replayed situations, decided and explained.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admit, forecastBurn, logShadow, readShadow } from '../src/allocator.mjs';

const NOW = Date.parse('2026-11-10T12:00:00Z'), S = NOW / 1000;
const account = (used, resetInS, extra = {}) => ({ '7d': used, reset_7d: S + resetInS, checked: S, ...extra });

test('the same few percent left: lent 45 minutes before the reset, protected 3 days before it', () => {
  const burn = { '7d': 0.01 }; // conversations use 1% of the week an hour
  const near = admit({ usage: account(0.90, 45 * 60), kind: 'agent', estimate: 0.015, burn, now: NOW });
  assert.equal(near.allow, true, near.why);
  const far = admit({ usage: account(0.90, 3 * 86400), kind: 'agent', estimate: 0.02, burn, now: NOW });
  assert.equal(far.allow, false);
  assert.match(far.why, /kept for conversations over the 3 days to its reset/);
});

test('45 minutes is not unconditional: heavy conversation burn still protects the reserve', () => {
  const r = admit({ usage: account(0.85, 45 * 60), kind: 'agent', estimate: 0.05, burn: { '7d': 0.08 }, now: NOW });
  assert.equal(r.allow, false, r.why);
});

test('burst fanout: jobs already running (and their native subagents) count against the reserve', () => {
  const usage = account(0.70, 86400);
  assert.equal(admit({ usage, kind: 'agent', estimate: 0.05, now: NOW }).allow, true);
  // Three jobs in flight, each with about three native children, estimated at 0.06 each job.
  const burst = admit({ usage, kind: 'agent', estimate: 0.05, inFlight: 3 * 0.06, now: NOW });
  assert.equal(burst.allow, false, burst.why);
});

test('a live conversation is always admitted; no reading is not room; a passed reset is', () => {
  assert.equal(admit({ usage: account(0.99, 86400), kind: 'live', now: NOW }).allow, true);
  assert.equal(admit({ usage: {}, kind: 'scheduled', now: NOW }).allow, false);
  assert.match(admit({ usage: {}, kind: 'scheduled', now: NOW }).why, /unknown is not room/);
  assert.equal(admit({ usage: account(0.99, -60), kind: 'grading', estimate: 0.1, now: NOW }).allow, true);
  assert.throws(() => admit({ usage: account(0.1, 60), kind: 'whatever', now: NOW }), /kind/);
});

test('a stale reading is never read as empty: the forecast burn since it was taken is added', () => {
  const usage = account(0.80, 86400, { checked: S - 2 * 3600 });
  const r = admit({ usage, kind: 'agent', estimate: 0, burn: { '7d': 0.03 }, now: NOW });
  assert.equal(r.windows[0].used, 0.86);
});

test('several windows: the tightest decides; the floor stands alone without a forecast, and says so', () => {
  const usage = { '5h': 0.10, reset_5h: S + 3600, '7d': 0.93, reset_7d: S + 5 * 86400, checked: S };
  const r = admit({ usage, kind: 'agent', estimate: 0.01, now: NOW });
  assert.equal(r.allow, false);
  assert.match(r.why, /^7d: .*\(the floor: no forecast yet\)$/);
});

test('forecast: rises per hour across readings, resets skipped, too few samples is no forecast', () => {
  const at = (h) => NOW + h * 3_600_000;
  const readings = [0, 1, 2, 3, 4, 5, 6, 7].map((h) => ({ at: at(h), usage: { '5h': 0.1 * (h % 4), '7d': 0.02 * h } }));
  const f = forecastBurn(readings);
  assert.ok(Math.abs(f['7d'] - 0.02) < 1e-9);
  assert.ok(Math.abs(f['5h'] - 0.1) < 1e-9, 'the reset drop is skipped, the six rises count');
  assert.equal(forecastBurn(readings, { minSamples: 7 })['5h'], null, 'too few samples: no forecast');
});

test('the shadow log keeps decisions without briefs, and turns over when large', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alloc-'));
  try {
    logShadow(dir, { at: 'x', kind: 'agent', decision: 'allow', why: 'room', brief: 'SECRET brief text', text: 'SECRET' });
    assert.deepEqual(readShadow(dir), [{ at: 'x', kind: 'agent', decision: 'allow', why: 'room' }]);
    for (let i = 0; i < 5; i++) logShadow(dir, { at: String(i), why: 'y'.repeat(100) }, { maxBytes: 200 });
    assert.ok(readShadow(dir).length < 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
