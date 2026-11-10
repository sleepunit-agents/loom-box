// Worker capacity admission, shadow slice (t-2037): replayed situations, decided and explained.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admit, forecastBurn, logShadow, readReadings, readShadow, recordReadings } from '../src/allocator.mjs';

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

test('readings history (slice 1b): one line per newer reading, bounded, read back per account, worker time skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alloc-readings-'));
  try {
    const acct = (name, checked, used) => ({ name, usage: { '7d': used, reset_7d: checked + 86400, checked, held: true } });
    assert.equal(recordReadings(dir, [acct('a', 100, 0.1), acct('b', 100, 0.5), { name: 'c', usage: {} }]), 2);
    assert.equal(recordReadings(dir, [acct('a', 100, 0.1)]), 0, 'the same reading is not recorded twice');
    const t0 = S;
    for (let i = 0; i < 8; i++) recordReadings(dir, [acct('a', t0 + i * 3600, 0.2 + i * 0.01)], { jobs: 0 });
    const a = readReadings(dir, 'a');
    assert.equal(a.length, 9);
    assert.deepEqual(Object.keys(a[1]).sort(), ['account', 'at', 'jobs', 'usage']);
    assert.deepEqual(a[1].usage, { '7d': 0.2 }, 'fractions only: no reset or other fields');
    // Forecast from the recorded history (past the first, much older reading): 1% an hour.
    assert.ok(Math.abs(forecastBurn(a.slice(1))['7d'] - 0.01) < 1e-9);
    // Hours when worker bodies were held don't count as conversations' burn.
    const busy = a.slice(1).map((r, i) => (i >= 3 ? { ...r, jobs: 2 } : r));
    assert.equal(forecastBurn(busy)['7d'], null);
    // Bounded: it turns over, and both files are read back.
    for (let i = 0; i < 20; i++) recordReadings(dir, [acct('b', t0 + i * 60, 0.5)], { maxBytes: 300 });
    assert.equal(readReadings(dir, 'b').length <= 21, true);
    assert.ok(readReadings(dir, 'b').length >= 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Slice 3: the gate a new worker start passes through, and the resolver with it ----
import { capacityGate, allocatorOf, setAllocatorMode, startKind } from '../src/allocator.mjs';
import { resolveModel } from '../src/models.mjs';
import { StateError } from '../src/state.mjs';

const login = (name, provider, usage) => ({ name, label: name, provider, harness: provider === 'anthropic' ? 'claude' : 'codex', kind: 'login', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage });
const CLAUDE = { id: 'opus', harness: 'claude', family: 'anthropic' };
const CODEX = { id: 'sol', harness: 'codex', family: 'openai' };

test('the switch: shadow until the owner turns it on, and only shadow or enforce', () => {
  const s = {};
  assert.equal(allocatorOf(s).mode, 'shadow');
  assert.equal(setAllocatorMode(s, { mode: 'enforce', by: 'jonathan-barket', at: '2026-11-10T00:00:00Z' }).mode, 'enforce');
  assert.deepEqual(allocatorOf(s).changed, { at: '2026-11-10T00:00:00Z', by: 'jonathan-barket' });
  assert.throws(() => setAllocatorMode(s, { mode: 'on' }), /shadow or enforce/);
  assert.equal(allocatorOf({ allocator: { mode: 'bogus' } }).mode, 'shadow');
  assert.equal(startKind({ spawn: {} }), 'agent');
  assert.equal(startKind({ venue: 'wake' }), 'scheduled');
  assert.equal(startKind({ venue: 'discord' }), 'live');
});

test('a live start has no gate; a job counts the jobs already on its account', () => {
  assert.equal(capacityGate({ kind: 'live' }), null);
  const usage = { '5h': 0.80, reset_5h: S + 3 * 3600, checked: S };
  const g0 = capacityGate({ kind: 'agent', now: NOW });
  assert.equal(g0(login('max', 'anthropic', usage)).allow, true);
  // Five jobs already on it at the 3% guess each: 0.80 + 0.15 + 0.03 + 0.05 floor > 0.97.
  const g5 = capacityGate({ kind: 'agent', jobsOn: { max: 5 }, now: NOW });
  const v = g5(login('max', 'anthropic', usage));
  assert.equal(v.allow, false);
  assert.equal(v.until, S + 3 * 3600);
});

test('a model is gated only on its own windows: another model\'s full window does not hold it back', () => {
  const usage = { '7d': 0.2, '7d_opus': 0.99, reset_7d_opus: S + 86400, checked: S };
  const g = capacityGate({ kind: 'agent', now: NOW });
  assert.equal(g(login('max', 'anthropic', usage)).allow, true);              // a model with no window of its own
  assert.equal(g(login('max', 'anthropic', usage), '7d_opus').allow, false);  // opus itself
});

test('enforced: a job goes to the eligible model with headroom, Codex as an ordinary pick', () => {
  const accounts = { accounts: [login('max', 'anthropic', { '7d': 0.93, reset_7d: S + 3 * 86400, checked: S }), login('pro', 'openai', { '7d': 0.3, reset_7d: S + 3 * 86400, checked: S })] };
  const gate = capacityGate({ kind: 'agent', now: NOW });
  const r = resolveModel({ agent: 'art', kind: 'spawn', models: [CLAUDE, CODEX], settings: { prefer: ['opus'] }, accounts, gate, now: NOW });
  assert.equal(r.model, 'sol');
  assert.match(r.admission, /room in every window/);
  // Without the gate (shadow, or a live conversation), opus still has room and is chosen: nothing changes.
  assert.equal(resolveModel({ agent: 'art', kind: 'spawn', models: [CLAUDE, CODEX], settings: { prefer: ['opus'] }, accounts, now: NOW }).model, 'opus');
});

test('enforced: every model with room kept for conversations is a wait, not out of quota', () => {
  const accounts = { accounts: [login('max', 'anthropic', { '7d': 0.93, reset_7d: S + 3 * 86400, checked: S }), login('pro', 'openai', { '7d': 0.95, reset_7d: S + 86400, checked: S })] };
  const gate = capacityGate({ kind: 'scheduled', now: NOW });
  let e;
  try { resolveModel({ agent: 'art', kind: 'wake', models: [CLAUDE, CODEX], accounts, gate, now: NOW }); } catch (x) { e = x; }
  assert.ok(e instanceof StateError);
  assert.equal(e.reserved, true);
  assert.equal(e.until, S + 86400);
  assert.match(e.message, /kept for conversations/);
  // Truly out of quota everywhere (no room before the gate) stays the quota answer.
  const full = { accounts: [login('max', 'anthropic', { '7d': 0.99, reset_7d: S + 3600, checked: S })] };
  try { resolveModel({ agent: 'art', kind: 'wake', models: [CLAUDE], accounts: full, gate, now: NOW }); } catch (x) { e = x; }
  assert.equal(e.reserved, undefined);
  assert.match(e.message, /no model is left/);
});
