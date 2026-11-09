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
  const options = { dir, sealer, now: () => clock };
  const source = { agent: 'art', conversation: 'cv-aaaaaaaaaaaa', run: 'run-aaaaaaaaaaaa', reset: null, principal: { for: ['jonathan'], owner: true }, target: { venue: 'comms', place: 'th:aaaaaaaaaa' } };
  const child = { ...structuredClone(source), conversation: 'cv-bbbbbbbbbbbb', run: 'run-bbbbbbbbbbbb', target: { venue: 'wake', place: 'w-123456' } };
  const current = (cv) => cv === source.conversation ? source : cv === child.conversation ? child : null;
  const binding = { wake: 'w-123456', delivery: 'clock:w-123456:one' };
  const out = continuationOutbox(options), { handle } = out.issue(source);
  return { dir, source, child, current, binding, out, handle, reload: () => continuationOutbox(options), advance: () => { clock += 3600001; } };
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
  const missing = { ...w.source }; delete missing.reset;
  assert.throws(() => w.out.issue(missing), /snapshot/);
  assert.throws(() => w.out.bind(w.handle, w.binding, w.source, { ...w.child, agent: 'mark' }), /principal/);
  assert.throws(() => w.out.bind(w.handle, w.binding, w.source, { ...w.child, principal: { for: ['other'] } }), /principal/);
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
    if (change === 'principal') w.child.principal = { owner: false, for: ['other'] };
    if (change === 'pending reset') w.source.resetPending = true;
    await w.out.drain({ current: change === 'deleted child' ? (id) => id === w.child.conversation ? null : w.current(id) : w.current,
      post: () => assert.fail('must not call adapter') });
    // Status authentication still requires the originally bound snapshot.
    const original = { ...w.child, run: 'run-bbbbbbbbbbbb', reset: null, principal: { for: ['jonathan'], owner: true } };
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
  assert.equal(w.out.status(w.handle, w.child, 'final').state, 'failed');
  w.advance();
  await w.reload().drain({ current: w.current, post: () => assert.fail('permanent failure retried') });
});
