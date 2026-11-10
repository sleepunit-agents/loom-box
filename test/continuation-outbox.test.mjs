import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { continuationOutbox } from '../src/continuation-outbox.mjs';

function world(t) {
  const dir = mkdtempSync(join(tmpdir(), 'continuation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(32);
  const sealer = {
    seal(b) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([c.update(b), c.final()]); return Buffer.concat([iv, c.getAuthTag(), encrypted]); },
    open(b) { const c = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); c.setAuthTag(b.subarray(12, 28)); return Buffer.concat([c.update(b.subarray(28)), c.final()]); },
  };
  let clock = 1000;
  const options = { dir, sealer, lifetimeMs: 86400000, now: () => clock };
  const source = { agent: 'art', conversation: 'cv-aaaaaaaaaaaa', run: 'run-aaaaaaaaaaaa', reset: null, principal: { for: 'jonathan', owner: true, people: [] }, target: { venue: 'comms', place: 'th:aaaaaaaaaa' } };
  const child = { ...structuredClone(source), conversation: 'cv-bbbbbbbbbbbb', run: 'run-bbbbbbbbbbbb', target: { venue: 'wake', place: 'w-123456' } };
  const current = (cv) => cv === source.conversation ? source : cv === child.conversation ? child : null;
  const binding = { wake: 'w-123456', delivery: 'clock:w-123456:one', expiresAt: 1000 + options.lifetimeMs };
  const out = continuationOutbox(options), { handle } = out.issue(source);
  return { options, setTime: (value) => { clock = value; }, dir, source, child, current, binding, out, handle, reload: () => continuationOutbox(options), advance: () => { clock += 3600001; } };
}
const bind = (w) => w.out.bind(w.handle, w.binding, w.source, w.child);
const queue = (w, text = 'private result') => w.out.enqueue(w.handle, w.child, w.source, { id: 'final', text });

test('no origin provenance or unbound handle grants a send; fixed child and firing cannot be replaced', (t) => {
  const w = world(t);
  assert.throws(() => queue(w), /bound/);
  assert.throws(() => w.out.bind('cv-aaaaaaaaaaaa', w.binding, w.source, w.child), /unknown/);
  bind(w); bind(w);
  assert.throws(() => w.out.bind(w.handle, { ...w.binding, wake: 'w-654321' }, w.source, w.child), /already bound/);
  assert.throws(() => w.out.bind(w.handle, { ...w.binding, delivery: 'clock:other' }, w.source, w.child), /already bound/);
  assert.throws(() => w.out.enqueue(w.handle, { ...w.child, run: 'run-cccccccccccc' }, w.source, { id: 'final', text: 'forged' }), /bound/);
  assert.throws(() => w.out.enqueue(w.handle, { ...w.child, target: w.source.target }, w.source, { id: 'final', text: 'redirect' }), /bound/);
});

test('principal, agent, missing reset and pending reset are refused at binding', (t) => {
  const w = world(t);
  assert.throws(() => w.out.issue({ ...w.source, resetPending: true }), /snapshot/);
  assert.throws(() => w.out.issue({ ...w.source, principal: { for: null, owner: false, people: [], unknown: true } }), /snapshot/);
  const missing = { ...w.source }; delete missing.reset;
  assert.throws(() => w.out.issue(missing), /snapshot/);
  assert.throws(() => w.out.bind(w.handle, w.binding, w.source, { ...w.child, agent: 'mark' }), /principal/);
  assert.throws(() => w.out.bind(w.handle, w.binding, w.source, { ...w.child, principal: { for: 'other' } }), /principal/);
  assert.throws(() => w.out.bind(w.handle, w.binding, { ...w.source, reset: 1 }, w.child), /reset/);
});

test('sealed durable queue retries identical id and rejects differing payload, with fixed target', async (t) => {
  const w = world(t); bind(w);
  const first = queue(w);
  assert.deepEqual(queue(w), first);
  assert.throws(() => queue(w, 'different'), /different text/);
  for (const n of readdirSync(w.dir)) assert.equal(readFileSync(join(w.dir, n)).includes(Buffer.from('private result')), false);
  let posted;
  await w.reload().drain({ current: w.current, post: async (p) => { posted = p; return { ok: true, posted: true }; } });
  assert.deepEqual(posted.target, w.source.target);
  assert.equal(posted.conversation, w.source.conversation);
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'delivered');
  assert.equal(w.out.status(w.handle, w.child, 'final').attempts, 1);
});

test('crash after adapter acceptance retries stable ref and core dedup keeps one visible report', async (t) => {
  const w = world(t); bind(w); queue(w);
  const visible = new Map(); let crash = true, attempts = 0;
  const post = async (p) => {
    attempts++;
    const old = visible.get(p.ref);
    if (old) assert.deepEqual(old, p); else visible.set(p.ref, p);
    if (crash) { crash = false; throw new Error('process lost receipt after acceptance'); }
    return { ok: true, posted: true };
  };
  await w.out.drain({ current: w.current, post });
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'pending');
  w.advance();
  await w.reload().drain({ current: w.current, post });
  assert.equal(attempts, 2); assert.equal(visible.size, 1);
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'delivered');
});

for (const change of ['source reset', 'child reset', 'child run', 'target', 'principal', 'pending reset', 'deleted child']) {
  test(`${change} after enqueue prevents any adapter call`, async (t) => {
    const w = world(t); bind(w); queue(w);
    if (change === 'source reset') w.source.reset = 1;
    if (change === 'child reset') w.child.reset = 1;
    if (change === 'child run') w.child.run = 'run-cccccccccccc';
    if (change === 'target') w.source.target.place = 'th:elsewhere';
    if (change === 'principal') w.child.principal = { owner: false, for: 'other' };
    if (change === 'pending reset') w.source.resetPending = true;
    await w.out.drain({ current: change === 'deleted child' ? (id) => id === w.child.conversation ? null : w.current(id) : w.current,
      post: () => assert.fail('must not call adapter') });
    // Status authentication still requires the originally bound snapshot.
    const original = { ...w.child, run: 'run-bbbbbbbbbbbb', reset: null, principal: { for: 'jonathan', owner: true, people: [] } };
    assert.equal(w.out.status(w.handle, original, 'final').state, 'failed');
  });
}

test('new source holder is allowed; accepted alone stays pending; permanent refusal never retries', async (t) => {
  const w = world(t); bind(w); queue(w);
  w.source.run = 'run-cccccccccccc';
  await w.out.drain({ current: w.current, post: async () => ({ accepted: true }) });
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'pending');
  w.advance();
  await w.reload().drain({ current: w.current, post: async () => ({ ok: false, permanent: true, reason: 'shadow' }) });
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'indeterminate');
  w.advance();
  await w.reload().drain({ current: w.current, post: () => assert.fail('permanent failure retried') });
});

for (const status of [400, 401, 403, 404, 409, 422, 408, 425, 429, 503]) {
  test(`HTTP ${status} is classified durably across restart`, async (t) => {
    const w = world(t); bind(w); queue(w);
    await w.out.drain({ current: w.current, post: async () => { throw Object.assign(new Error(`refused ${status}`), { status }); } });
    const permanent = status < 500 && ![408, 425, 429].includes(status);
    assert.equal(w.reload().status(w.handle, w.child, 'final').state, permanent ? 'indeterminate' : 'pending');
    w.advance(); let calls = 0;
    await w.reload().drain({ current: w.current, post: async () => { calls++; return { ok: true, posted: true }; } });
    assert.equal(calls, permanent ? 0 : 1);
  });
}

test('run and harness annotation are sealed at enqueue across holder and harness changes', async (t) => {
  const w = world(t); bind(w);
  w.out.enqueue(w.handle, w.child, w.source, { id: 'final', text: 'done' }, { on: 'Codex' });
  let first;
  await w.out.drain({ current: w.current, post: async (p) => { first = p; throw new Error('receipt lost'); } });
  w.source.run = 'run-cccccccccccc';
  w.out.enqueue(w.handle, w.child, w.source, { id: 'final', text: 'done' }, { on: 'Claude' });
  w.advance();
  await w.reload().drain({ current: w.current, post: async (p) => { assert.deepEqual(p, first); assert.equal(p.run, w.child.run); assert.equal(p.on, 'Codex'); return { ok: true, posted: true }; } });
});

for (const offset of [-1, 0, 1]) test(`deadline boundary ${offset}: bind, new enqueue and drain`, async (t) => {
  const w = world(t), deadline = 1000 + 86400000;
  w.setTime(deadline + offset);
  if (offset >= 0) {
    assert.throws(() => bind(w), /expired/);
  } else {
    bind(w); queue(w);
    let calls = 0;
    await w.out.drain({ current: w.current, post: async () => { calls++; return { ok: true, posted: true }; } });
    assert.equal(calls, 1);
  }
  const v = world(t); bind(v); queue(v); v.setTime(deadline + offset);
  if (offset >= 0) assert.throws(() => v.out.enqueue(v.handle, v.child, v.source, { id: 'new', text: 'late' }), /expired/);
  let calls = 0;
  await v.reload().drain({ current: v.current, post: async () => { calls++; return { ok: true, posted: true }; } });
  assert.equal(calls, offset < 0 ? 1 : 0);
  assert.equal(v.reload().status(v.handle, v.child, 'final').state, offset < 0 ? 'delivered' : 'expired');
});

test('persisted highwater holds rollback across restart and observed expiry cannot reactivate', async (t) => {
  const w = world(t); bind(w); queue(w);
  w.setTime(999);
  assert.throws(() => w.reload().issue(w.source), /backwards/);
  await w.reload().drain({ current: w.current, post: () => assert.fail('rollback send') });
  assert.equal(w.out.status(w.handle, w.child, 'final').attempts, 0);
  w.setTime(86401000);
  await w.reload().drain({ current: w.current, post: () => assert.fail('expired send') });
  w.setTime(1000);
  assert.throws(() => w.reload().enqueue(w.handle, w.child, w.source, { id: 'new', text: 'no' }), /backwards|expired/);
  assert.equal(w.reload().enqueue(w.handle, w.child, w.source, { id: 'final', text: 'private result' }).state, 'expired');
  assert.throws(() => queue(w, 'changed'), /different text/);
});

test('lost receipt crosses cutoff without another write; late in-flight receipt upgrades indeterminate', async (t) => {
  const w = world(t); bind(w); queue(w);
  let finish, entered;
  const started = new Promise(r => { entered = r; });
  const draining = w.out.drain({ current: w.current, post: () => { entered(); return new Promise(r => { finish = r; }); } });
  await started;
  w.setTime(86401000);
  await w.reload().drain({ current: w.current, post: () => assert.fail('write past cutoff') });
  assert.equal(w.reload().status(w.handle, w.child, 'final').state, 'indeterminate');
  finish({ ok: true, posted: true }); await draining;
  assert.equal(w.reload().status(w.handle, w.child, 'final').state, 'delivered');
  assert.equal(queue(w).state, 'delivered');
  bind(w); // receipt-recovery binding is idempotent beyond cutoff
});

test('legacy unbound, bound, pending and delivered records do not gain a deadline', async (t) => {
  for (const state of ['unbound', 'bound', 'pending', 'delivered']) {
    const w = world(t);
    if (state !== 'unbound') bind(w);
    if (['pending', 'delivered'].includes(state)) queue(w);
    if (state === 'delivered') await w.out.drain({ current: w.current, post: async () => ({ ok: true, posted: true }) });
    // Recreate an old sealed fixture, without modifying its commitment or identity.
    const { writeFileSync } = await import('node:fs');
    for (const file of readdirSync(w.dir).filter(n => n.endsWith('.sealed') && n !== 'clock.sealed')) {
      const path = join(w.dir, file), record = JSON.parse(w.options.sealer.open(readFileSync(path)));
      delete record.version; delete record.expiresAt;
      writeFileSync(path, w.options.sealer.seal(Buffer.from(JSON.stringify(record))));
    }
    if (state === 'unbound') assert.throws(() => bind(w), /legacy/);
    else assert.throws(() => w.out.enqueue(w.handle, w.child, w.source, { id: 'new', text: 'no' }), /legacy/);
    await w.reload().drain({ current: w.current, post: () => assert.fail('legacy send') });
    if (state === 'pending') assert.equal(queue(w).state, 'expired');
    if (state === 'delivered') assert.equal(queue(w).state, 'delivered');
  }
});

test('issuance requires an explicit trusted policy; unsafe policy cannot mint a capability', (t) => {
  const w = world(t);
  for (const lifetimeMs of [null, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => continuationOutbox({ ...w.options, lifetimeMs }).issue(w.source), /policy/);
});

test('reset after a lost receipt preserves uncertainty rather than claiming non-delivery', async (t) => {
  const w = world(t); bind(w); queue(w);
  await w.out.drain({ current: w.current, post: async () => { throw new Error('receipt lost'); } });
  w.source.reset = 1; w.advance();
  await w.reload().drain({ current: w.current, post: () => assert.fail('reset retry') });
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'indeterminate');
});

test('legacy attempted report remains indeterminate, never expired or renewed', async (t) => {
  const w = world(t); bind(w); queue(w);
  await w.out.drain({ current: w.current, post: async () => { throw new Error('unknown acceptance'); } });
  const { writeFileSync } = await import('node:fs');
  for (const file of readdirSync(w.dir).filter(n => /^(grant|report)-/.test(n))) {
    const path = join(w.dir, file), record = JSON.parse(w.options.sealer.open(readFileSync(path)));
    delete record.version; delete record.expiresAt;
    writeFileSync(path, w.options.sealer.seal(Buffer.from(JSON.stringify(record))));
  }
  await w.reload().drain({ current: w.current, post: () => assert.fail('legacy attempted send') });
  assert.equal(queue(w).state, 'indeterminate');
});

test('clock inspection authenticates the exact issuer and reads the sealed cutoff without renewal', (t) => {
  const w = world(t);
  const issuer = { agent: w.source.agent, conversation: w.source.conversation, ...w.source.principal };
  const deadline = 1000 + w.options.lifetimeMs;
  assert.deepEqual(w.out.inspect(w.handle, w.source, issuer, deadline - 1), { handle: w.handle, expiresAt: deadline });
  assert.throws(() => w.out.inspect(w.handle, w.source, issuer, deadline), /before its deadline/);
  assert.throws(() => w.out.inspect(w.handle, w.source, issuer, String(deadline - 1)), /before its deadline/);
  assert.throws(() => w.out.inspect(w.handle, w.source, { ...issuer, conversation: w.child.conversation }, 1001), /issuer differs/);
  assert.throws(() => w.out.inspect(w.handle, { ...w.source, reset: 'changed' }, issuer, 1001), /reset or changed/);
  w.setTime(deadline);
  assert.throws(() => w.out.inspect(w.handle, w.source, issuer, deadline - 1), /expired/);
  w.setTime(deadline - 1);
  assert.throws(() => w.reload().inspect(w.handle, w.source, issuer, deadline - 1), /backwards|expired/);
});

test('runner preflight requires exact sealed deadline, current principal and active grant', (t) => {
  const w = world(t), expiresAt = 1000 + w.options.lifetimeMs;
  const firing = { ...w.binding, expiresAt };
  assert.deepEqual(w.out.checkFiring(w.handle, firing, w.source, w.child), { expiresAt });
  for (const value of [undefined, String(expiresAt), expiresAt + 1])
    assert.throws(() => w.out.checkFiring(w.handle, { ...firing, expiresAt: value }, w.source, w.child), /deadline differs/);
  assert.throws(() => w.out.checkFiring(w.handle, firing, w.source, { ...w.child, principal: { owner: false, for: 'other' } }), /principal differs/);
  w.setTime(expiresAt);
  assert.throws(() => w.reload().checkFiring(w.handle, firing, w.source, w.child), /expired/);
});

for (const answer of [
  { ok: true, state: 'delivered', id: '42' },
  { ok: true, state: 'not-accepted' },
  { ok: true, state: 'unresolved' },
  { ok: true, state: 'deleted' },
  { ok: false, permanent: true, reason: 'payload conflict' },
]) test(`fenced recovery after cutoff: ${answer.state ?? answer.reason}`, async (t) => {
  const w = world(t); bind(w); queue(w);
  let original;
  await w.out.drain({ current: w.current, post: async p => { original = p; throw Error('lost receipt'); } });
  w.setTime(w.binding.expiresAt);
  let calls = 0;
  await w.reload().drain({ current: w.current, post: () => assert.fail('post after cutoff'), reconcile: async p => {
    calls++; assert.deepEqual(p, original); return answer;
  } });
  assert.equal(calls, 1);
  const status = w.reload().status(w.handle, w.child, 'final', w.source);
  assert.equal(status.state, answer.state === 'delivered' ? 'delivered' : answer.state === 'not-accepted' ? 'expired' : answer.state === 'deleted' ? 'withdrawn' : 'indeterminate');
  assert.equal(status.attempts, 1);
});

test('reconciliation transport loss retains indeterminate across restart and retries lookup only', async t => {
  const w = world(t); bind(w); queue(w);
  await w.out.drain({ current: w.current, post: async () => { throw Error('lost'); } });
  w.setTime(w.binding.expiresAt);
  await w.reload().drain({ current: w.current, post: () => assert.fail('late post'), reconcile: async () => { throw Error('busy'); } });
  assert.equal(w.reload().status(w.handle, w.child, 'final', w.source).state, 'indeterminate');
  w.setTime(w.binding.expiresAt + 3600000); // past its reconciliation backoff
  await w.reload().drain({ current: w.current, post: () => assert.fail('late post'), reconcile: async () => ({ ok: true, state: 'delivered', id: '42' }) });
  assert.equal(w.reload().status(w.handle, w.child, 'final', w.source).posted, true);
});

test('collection waits for the deadline plus retention and a final outcome, then removes grant and report', async (t) => {
  const w = world(t), deadline = 1000 + w.options.lifetimeMs, keep = 7 * 86400000;
  bind(w); queue(w);
  // Unbound sibling grant with no reports: collected on the same schedule.
  const other = w.out.issue(w.source).handle;
  await w.out.drain({ current: w.current, post: async () => ({ ok: true, posted: true }) });
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'delivered');
  w.setTime(deadline + keep - 1);
  assert.deepEqual(w.reload().collect(), { reports: 0, grants: 0 });
  w.setTime(deadline + keep);
  assert.deepEqual(w.reload().collect(), { reports: 1, grants: 2 });
  assert.deepEqual(readdirSync(w.dir).filter(n => /^(grant|report)-/.test(n)), []);
  // A collected capability grants nothing: not a status, a new report, a bind or a firing.
  for (const f of [() => w.out.status(w.handle, w.child, 'final'), () => queue(w, 'again'), () => bind(w),
    () => w.out.bind(other, { ...w.binding }, w.source, w.child), () => w.out.checkFiring(other, w.binding, w.source, w.child)])
    assert.throws(f, /bound|unknown|reset or changed/);
});

test('unresolved and attempted reports keep their grant past retention until reconciled', async (t) => {
  const w = world(t), deadline = 1000 + w.options.lifetimeMs, keep = 7 * 86400000;
  bind(w); queue(w);
  await w.out.drain({ current: w.current, post: async () => { throw new Error('receipt lost'); } });
  w.setTime(deadline + keep + 1);
  await w.reload().drain({ current: w.current, post: () => assert.fail('late post'), reconcile: async () => ({ ok: true, state: 'unresolved' }) });
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'indeterminate');
  assert.deepEqual(w.reload().collect(), { reports: 0, grants: 0 });
  w.setTime(deadline + keep + 1 + 3600000);
  await w.reload().drain({ current: w.current, post: () => assert.fail('late post'), reconcile: async () => ({ ok: true, state: 'delivered', id: '7' }) });
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'delivered');
  assert.deepEqual(w.reload().collect(), { reports: 1, grants: 1 });
});

test('a deleted destination ends reconciliation; legacy and uncertain-clock records are never collected', async (t) => {
  const w = world(t), deadline = 1000 + w.options.lifetimeMs, keep = 7 * 86400000;
  bind(w); queue(w);
  await w.out.drain({ current: w.current, post: async () => { throw new Error('receipt lost'); } });
  w.setTime(deadline);
  let calls = 0;
  const reconcile = async () => { calls += 1; return { ok: true, state: 'deleted' }; };
  await w.reload().drain({ current: w.current, post: () => assert.fail('late post'), reconcile });
  await w.reload().drain({ current: w.current, post: () => assert.fail('late post'), reconcile });
  assert.equal(calls, 1);
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'withdrawn');
  // Clock moved backwards: hold, collect nothing.
  w.setTime(deadline - 5);
  assert.deepEqual(w.reload().collect(), { reports: 0, grants: 0 });
  // Legacy (no version) records are held whatever their age.
  const { writeFileSync } = await import('node:fs');
  for (const file of readdirSync(w.dir).filter(n => /^(grant|report)-/.test(n))) {
    const path = join(w.dir, file), record = JSON.parse(w.options.sealer.open(readFileSync(path)));
    delete record.version;
    writeFileSync(path, w.options.sealer.seal(Buffer.from(JSON.stringify(record))));
  }
  w.setTime(deadline + 100 * keep);
  assert.deepEqual(w.reload().collect(), { reports: 0, grants: 0 });
});

test('reconciliation backs off instead of calling core every tick', async (t) => {
  const w = world(t); bind(w); queue(w);
  await w.out.drain({ current: w.current, post: async () => { throw new Error('receipt lost'); } });
  w.setTime(w.binding.expiresAt);
  let calls = 0;
  const reconcile = async () => { calls += 1; return { ok: true, state: 'unresolved' }; };
  for (let i = 0; i < 5; i++) await w.reload().drain({ current: w.current, post: () => assert.fail('late post'), reconcile });
  assert.equal(calls, 1);
  w.setTime(w.binding.expiresAt + 10000);
  await w.reload().drain({ current: w.current, post: () => assert.fail('late post'), reconcile });
  assert.equal(calls, 2);
});

test("core's clock-rollback hold (503) keeps the report pending and posts it later", async (t) => {
  const w = world(t); bind(w); queue(w);
  await w.out.drain({ current: w.current, post: async () => { throw Object.assign(new Error('continuation clock moved backwards'), { status: 503 }); } });
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'pending');
  w.advance();
  let posted = 0;
  await w.reload().drain({ current: w.current, post: async () => { posted += 1; return { ok: true, posted: true }; } });
  assert.equal(posted, 1);
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'delivered');
});

test("the bound child's own conversation may start again on the same firing, with no new authority", (t) => {
  const w = world(t), firing = { ...w.binding };
  w.out.checkFiring(w.handle, firing, w.source, w.child);
  bind(w);
  const next = { ...w.child, run: 'run-cccccccccccc' };
  assert.deepEqual(w.out.checkFiring(w.handle, firing, w.source, next), { expiresAt: firing.expiresAt, bound: true });
  assert.throws(() => w.out.checkFiring(w.handle, firing, w.source, { ...next, conversation: 'cv-cccccccccccc' }), /already bound/);
  assert.throws(() => w.out.bind(w.handle, firing, w.source, next), /already bound/);
  assert.throws(() => w.out.enqueue(w.handle, next, w.source, { id: 'x', text: 'y' }), /bound/);
});

test('an answer arriving after another tick resolved and collected the row is ignored, not a crash', async (t) => {
  const w = world(t); bind(w); queue(w);
  const { unlinkSync } = await import('node:fs');
  await w.out.drain({ current: w.current, post: async () => {
    for (const n of readdirSync(w.dir).filter((x) => x.startsWith('report-'))) unlinkSync(join(w.dir, n));
    return { ok: true, posted: true };
  } });
  assert.equal(w.out.status(w.handle, w.child, 'final'), null);
});

test('a report whose authority was reset is rechecked after a backoff, not resealed every tick', async (t) => {
  const w = world(t); bind(w); queue(w);
  await w.out.drain({ current: w.current, post: async () => { throw new Error('receipt lost'); } });
  w.source.reset = 1; w.advance();
  await w.reload().drain({ current: w.current, post: () => assert.fail('reset post') });
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'indeterminate');
  const file = readdirSync(w.dir).find((n) => n.startsWith('report-'));
  const before = readFileSync(join(w.dir, file));
  await w.reload().drain({ current: w.current, post: () => assert.fail('reset post') });
  assert.deepEqual(readFileSync(join(w.dir, file)), before);
});

test('one record that will not open is skipped and said; the rest still drain and collect', async (t) => {
  const w = world(t); bind(w); queue(w, 'good one');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(w.dir, `report-${'0'.repeat(64)}.sealed`), Buffer.from('not sealed'));
  writeFileSync(join(w.dir, `grant-${'0'.repeat(64)}.sealed`), Buffer.from('not sealed'));
  const said = [];
  const out = continuationOutbox({ ...w.options, warn: (m) => said.push(m) });
  let posted = 0;
  await out.drain({ current: w.current, post: async () => { posted += 1; return { ok: true, posted: true }; } });
  assert.equal(posted, 1);
  assert.ok(said.some((m) => m.includes(`report-${'0'.repeat(64)}`)));
  w.setTime(1000 + w.options.lifetimeMs + 7 * 86400000);
  assert.deepEqual(out.collect(), { reports: 1, grants: 1 });
});

test('collection asked hourly runs at most once an hour', (t) => {
  const w = world(t);
  assert.equal(w.out.collect({ every: 3600000 }).skipped, undefined);
  assert.equal(w.out.collect({ every: 3600000 }).skipped, true);
  w.setTime(1000 + 3600000);
  assert.equal(w.out.collect({ every: 3600000 }).skipped, undefined);
});

test('a source conversation has at most a bounded number of live continuations', (t) => {
  const w = world(t);
  const out = continuationOutbox({ ...w.options, maxLive: 3 });
  out.issue(w.source); out.issue(w.source); // the world issued one already
  assert.throws(() => out.issue(w.source), /3 live continuations/);
  assert.ok(out.issue({ ...w.source, conversation: 'cv-cccccccccccc' }).handle, 'another conversation is its own count');
  w.setTime(1000 + w.options.lifetimeMs);
  assert.ok(out.issue(w.source).handle, 'room again once they reach their deadline');
});

test('an uncertain report is still reconciled after its source was reset', async (t) => {
  const w = world(t); bind(w); queue(w);
  await w.out.drain({ current: w.current, post: async () => { throw new Error('receipt lost'); } });
  w.setTime(w.binding.expiresAt);
  await w.reload().drain({ current: w.current, post: () => assert.fail('late post'), reconcile: async () => ({ ok: true, state: 'unresolved' }) });
  w.source.reset = 1; w.setTime(w.binding.expiresAt + 3600000);
  let asked = 0;
  await w.reload().drain({ current: w.current, post: () => assert.fail('post after reset'), reconcile: async () => { asked += 1; return { ok: true, state: 'delivered', id: '9' }; } });
  assert.equal(asked, 1);
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'delivered');
});
