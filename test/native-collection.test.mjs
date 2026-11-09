import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api } from '../src/control.mjs';
import { load, update } from '../src/state.mjs';
import { HouseRunner, sweepTransfers } from '../src/houserunner.mjs';
import { deliver, loadConv, ownerConversationControl, tick } from '../src/delivery.mjs';
import { readHouseLaunch } from '../src/house-launch-journal.mjs';
import { hasAge, houseWorld, world } from './delivery-world.mjs';
const wait = async fn => { const end = Date.now() + 10_000; while (!await fn()) { if (Date.now() > end) throw Error('native collection fixture timed out'); await new Promise(r => setTimeout(r, 10)); } };
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
function collection(w) {
  update(w.env, s => { const h = s.houses['h-1']; h.nativeHistory = { v: 1, complete: false }; h.state = 'running'; });
  const caller = { kind: 'piece', subject: load(w.env).houses['h-1'].box };
  const call = (body, who = caller) => api(w.env, { sealer: w.sealer }, { caller: who, path: 'native-collection', body: { id: 'h-1', ...body } });
  return { call, caller, report: state => api(w.env, {}, { caller, path: 'report', body: { id: 'h-1', state } }) };
}
function upload(entry, text = 'original native transcript', { omitted = false } = {}) {
  const files = omitted ? [] : [{ root: entry.harness === 'claude' ? 'projects' : 'sessions', rel: `project/${entry.session ?? 'recovered-session'}.jsonl`, data: Buffer.from(text).toString('base64') }];
  const whole = Buffer.from(JSON.stringify(files)), encoded = whole.toString('base64'), half = Math.floor(encoded.length / 2);
  const base = { phase: 'part', key: entry.key, bodyId: entry.bodyId ?? 'deadbeef', session: entry.session ?? 'recovered-session', sha256: createHash('sha256').update(whole).digest('hex'), parts: 2, ...(omitted ? { omitted: 'size-limit' } : {}) };
  return { files, first: { ...base, part: 0, data: encoded.slice(0, half) }, last: { ...base, part: 1, data: encoded.slice(half) } };
}
async function prepared(harness, ready = true) {
  const w = houseWorld({ harness }), id = (harness === 'claude' ? 'a' : 'b').repeat(64);
  let oldHostKey;
  w.setDrop(answer => { if (answer.hostKey) oldHostKey = answer.hostKey; return false; });
  const preparation = w.hr.prepareLaunch(id, { agent: 'art', brief: 'private native collection intent', model: harness === 'claude' ? 'opus' : 'gpt', env: { LOOM_BODY_KEY: 'private-fixture-sender', LOOM_BODY_CONVERSATION: 'cv-abcdef123456' } });
  await wait(() => load(w.env).houses['h-1']); const host = w.host();
  const handle = await preparation;
  if (ready) { w.hr.publishPreparedLaunch(handle); await w.hr.waitPreparedLaunch(handle); await wait(() => Object.keys(w.hr.host('art').report?.bodies ?? {}).length); }
  await w.kill(); await host;
  if (!ready) w.hr.publishPreparedLaunch(handle);
  return { ...w, handle, oldHostKey };
}

for (const harness of ['claude', 'codex']) test(`${harness}: only its allocated box completes a sealed, retryable offline collection`, { skip: !hasAge }, async () => {
  const w = await prepared(harness), c = collection(w);
  for (const who of [{ kind: 'agent', agent: 'art', house: 'h-1' }, { kind: 'owner' }, { kind: 'piece', subject: 'other-box' }]) assert.notEqual(c.call({ phase: 'plan', physical: 'gone' }, who).status, 200);
  assert.equal(c.call({ phase: 'plan', physical: 'running' }).status, 409);
  const plan = ok(c.call({ phase: 'plan', physical: 'gone' }));
  assert.deepEqual(ok(c.call({ phase: 'plan', physical: 'gone' })), plan, 'fresh registrars see the same plan');
  assert.doesNotMatch(JSON.stringify(plan), /private native collection intent|private-fixture-sender|sealed|hostKey/);
  assert.equal(plan.entries.length, 1);
  const late = await api(w.env, {}, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: 'body-sync', body: { hostKey: w.oldHostKey, report: { bodies: {}, done: {} } } });
  assert.equal(ok(late).exit, true, 'a late authenticated report cannot overwrite the box collection plan');
  assert.equal(c.report('failed').status, 409, 'terminal report cannot erase pending native collection');
  assert.equal(c.call({ phase: 'finish', plan: plan.plan }).status, 409);
  const entry = plan.entries[0], raw = entry.bodyId, transfer = upload(entry);
  const body = { id: `h-1-${raw}`, agent: 'art', house: 'h-1', harness };
  const fresh = new HouseRunner(w.env, harness, { sealer: w.sealer, claimMs: 20, poll: 5 });
  assert.equal(fresh.pending(body), true, 'collection is not permission to discard native history');
  await assert.rejects(fresh.pack(body), /session back|pending/);
  assert.equal(c.call({ ...transfer.first, plan: 'f'.repeat(32) }).status, 409);
  assert.equal(c.call({ ...transfer.first, plan: plan.plan, bodyId: 'foreign-body' }).status, 409);
  assert.equal(c.call({ ...transfer.first, plan: plan.plan, session: 'other-session' }).status, 409);
  assert.equal(c.call({ ...transfer.first, plan: plan.plan, omitted: 'read-error' }).status, 409, 'an arbitrary read failure cannot masquerade as a size limit');
  assert.equal(ok(c.call({ ...transfer.first, plan: plan.plan })).complete, false);
  const incoming = join(w.env.LOOM_BOX_DATA, 'delivery/hosts/parts/art/h-1');
  const partDir = join(incoming, readdirSync(incoming).find(name => name.startsWith('nc-')));
  const committedParts = readdirSync(partDir).map(name => [name, readFileSync(join(partDir, name))]);
  assert.equal(ok(c.call({ ...transfer.first, plan: plan.plan })).complete, false, 'lost part acknowledgements retry exactly');
  assert.equal(c.call({ ...transfer.first, plan: plan.plan, data: 'changed' }).status, 409);
  assert.equal(c.call({ ...transfer.last, plan: plan.plan, inputConfirmed: true }).status, 409, 'input receipt cannot change between parts');
  assert.equal(c.call({ ...transfer.last, plan: plan.plan, pending: ['changed-receipt'] }).status, 409, 'final inbox receipt cannot change between parts');
  assert.equal(c.call({ ...transfer.last, plan: plan.plan, omitted: 'size-limit' }).status, 409, 'session omission cannot change between parts');
  assert.equal(fresh.packReady(body), false);
  assert.equal(c.call({ phase: 'finish', plan: plan.plan }).status, 409);
  // Another conversation may need a new house while this physically stopped
  // one's collection is pending. Its host record must survive that handoff.
  const warming = fresh.warm('art');
  await wait(() => load(w.env).houses['h-2']);
  const boot = /--host-key ([0-9a-f]{48})/.exec(load(w.env).houses['h-2'].task)[1];
  ok(await api(w.env, {}, { caller: { kind: 'agent', agent: 'art', house: 'h-2' }, path: 'body-sync', body: { hostKey: boot, report: { bodies: {}, done: {}, caps: ['parts', 'native-admission'], starting: [] } } }));
  assert.equal(await warming, 'h-2');
  assert.equal(ok(c.call({ phase: 'plan', physical: 'gone' })).plan, plan.plan, 'replacement preserves the old plan and sealed parts');
  assert.equal(ok(c.call({ ...transfer.last, plan: plan.plan })).complete, true);
  const sealed = readFileSync(join(w.env.LOOM_BOX_DATA, 'delivery/hosts/packed/art/h-1', `${raw}.age`));
  assert.equal(sealed.toString().startsWith('age-encryption.org/v1'), true);
  assert.equal(sealed.includes(Buffer.from('original native transcript')), false);
  // Reproduce a worker lost after committing the receipt, before removing
  // duplicate encrypted parts. A final acknowledgement must clean those too.
  mkdirSync(partDir, { recursive: true, mode: 0o700 });
  for (const [name, data] of committedParts) writeFileSync(join(partDir, name), data, { mode: 0o600 });
  assert.deepEqual(await fresh.pack(body, { deferAck: true }), transfer.files);
  sweepTransfers(w.env, Date.now() + 7_200_000, Date.now() + 7_200_000);
  assert.equal(fresh.packReady(body), true, 'offline receipt protects the only copy beyond the ordinary transfer timeout');
  assert.equal(ok(c.call({ phase: 'finish', plan: plan.plan })).complete, true);
  assert.equal(existsSync(partDir), false);
  assert.equal(load(w.env).houses['h-1'].nativeHistory.complete, true);
  ok(c.report('failed'));
  assert.equal(fresh.pending(body), true, 'a sealed offline receipt remains pending until its consumer acknowledges it');
  assert.deepEqual(await fresh.pack(body, { deferAck: true }), transfer.files);
  fresh.ackPack(body); assert.equal(fresh.packReady(body), false); assert.equal(fresh.pending(body), false);
});

test('a box explicitly negotiates durable native history and can confirm a pre-container failure', { skip: !hasAge }, () => {
  const w = houseWorld();
  const created = ok(api(w.env, {}, { caller: { kind: 'owner' }, path: 'up', body: { agent: 'art', task: 'non-model task' } }));
  const caller = { kind: 'piece', subject: load(w.env).houses[created.id].box };
  const claimed = ok(api(w.env, { mint: () => 'fixture-house-token', revoke: () => {}, secret: () => '' }, { caller, path: 'claim', body: { id: created.id, nativeHistory: 1 } }));
  assert.deepEqual(claimed.nativeHistory, { v: 1 });
  assert.equal(api(w.env, {}, { caller, path: 'report', body: { id: created.id, state: 'failed' } }).status, 409);
  assert.equal(ok(api(w.env, {}, { caller, path: 'native-collection', body: { id: created.id, phase: 'not-started', physical: 'not-started' } })).complete, true);
  ok(api(w.env, { revoke: () => {} }, { caller, path: 'report', body: { id: created.id, state: 'failed' } }));
});

for (const refuse of [false, true]) test(`a stopped house reconciles a published attempt before its first receipt: ${refuse ? 'positive refusal' : 'original native session'}`, { skip: !hasAge }, async () => {
  const w = await prepared('codex', false), c = collection(w), plan = ok(c.call({ phase: 'plan', physical: 'stopped' }));
  assert.equal(plan.entries.length, 1); assert.equal(plan.entries[0].bodyId, undefined);
  const entry = plan.entries[0];
  if (refuse) {
    assert.equal(c.call({ phase: 'refuse', plan: plan.plan, key: entry.key }).status, 409);
    ok(c.call({ phase: 'refuse', plan: plan.plan, key: entry.key, nativeNotStarted: true }));
    assert.equal(readHouseLaunch(w.env, w.handle.id).state, 'refused');
    assert.equal(w.hr.publishPreparedLaunch(w.handle), 'refused');
  } else {
    const transfer = upload(entry);
    ok(c.call({ ...transfer.first, plan: plan.plan })); ok(c.call({ ...transfer.last, plan: plan.plan }));
    const result = new HouseRunner(w.env, 'codex', { sealer: w.sealer }).observePreparedLaunch(w.handle);
    assert.equal(result.state, 'ready'); assert.equal(result.body.id, 'h-1-deadbeef'); assert.equal(result.body.inputUncertain, true);
  }
  ok(c.call({ phase: 'finish', plan: plan.plan }));
  assert.equal(w.local.startsEntered ?? 0, 0, 'recovery never launches a native model');
});

test('a declared size-limit omission cannot contain files or complete a malformed collection', { skip: !hasAge }, async () => {
  const w = await prepared('codex'), c = collection(w), plan = ok(c.call({ phase: 'plan', physical: 'gone' }));
  const entry = plan.entries[0], transfer = upload(entry);
  ok(c.call({ ...transfer.first, plan: plan.plan, omitted: 'size-limit' }));
  const invalid = c.call({ ...transfer.last, plan: plan.plan, omitted: 'size-limit' });
  assert.equal(invalid.status, 409); assert.match(invalid.body.error, /cannot contain files/);
  assert.equal(c.call({ phase: 'finish', plan: plan.plan }).status, 409);
  assert.equal(w.hr.packReady({ id: `h-1-${entry.bodyId}`, agent: 'art', house: 'h-1' }), false);
  assert.equal(load(w.env).houses['h-1'].nativeHistory.complete, false);
});

for (const harness of ['claude', 'codex']) for (const oversized of [false, true]) test(`${harness}: delivery ticking during offline upload holds the original body until its ${oversized ? 'explicit size-limit disposition' : 'slot'} is committed`, { skip: !hasAge }, async () => {
  const local = world(), w = houseWorld({ harness });
  const warnings = [];
  const o = { ...local.o, runner: () => w.hr, accounts: w.accounts, sealer: w.sealer, warn: m => warnings.push(m) };
  let drained;
  const first = deliver(w.env, { ...local.msg('dm:offline-retirement', 'original native work'), from: { kind: 'person', slug: 'jonathan' } }, { ...o, onDrain: p => { drained = p; } });
  await wait(() => load(w.env).houses['h-1']); const host = w.host();
  const start = await first; await drained;
  const before = loadConv(w.env, start.conversation); assert.ok(before.body);
  for (const text of ['already heard correction', 'still pending correction']) {
    await deliver(w.env, { ...local.msg('dm:offline-retirement', text), from: { kind: 'person', slug: 'jonathan' } }, o);
  }
  const raw = before.body.split(':')[1].slice(4);
  await wait(() => w.fed.length === 2 && !(w.hr.host('art').inbox?.[raw] ?? []).length);
  const fed = loadConv(w.env, start.conversation).fed.map(x => x.key);
  assert.equal(fed.length, 2);
  w.hr.claimMs = 20;
  await w.kill(); await host;
  const c = collection(w), plan = ok(c.call({ phase: 'plan', physical: 'gone' }));
  const entry = plan.entries.find(e => e.bodyId === before.body.split(':')[1].slice(4));
  assert.ok(entry, JSON.stringify(plan));
  const transfer = upload(entry, 'original native history survives partial upload', { omitted: oversized });
  transfer.first.pending = transfer.last.pending = [fed[1]];
  await ownerConversationControl(w.env, { kind: 'owner' }, { conversation: start.conversation, action: 'interrupt' }, o);
  ok(c.call({ ...transfer.first, plan: plan.plan }));
  await tick(w.env, o);
  let current = loadConv(w.env, start.conversation);
  assert.equal(current.body, before.body); assert.equal(current.control.state, 'pending'); assert.equal(current.slot, undefined);
  assert.equal(current.nativeRetirement, undefined, 'no empty slot receipt may bypass collection');
  assert.deepEqual(current.actsFor, before.actsFor);
  assert.equal(w.local.startsEntered, 1);
  ok(c.call({ ...transfer.last, plan: plan.plan }));
  ok(c.call({ phase: 'finish', plan: plan.plan }));
  ok(c.report('failed'));
  w.hr.sealer = { seal: bytes => w.sealer.seal(bytes), open: () => { throw Error('fixture native pack key temporarily unavailable'); } };
  await tick(w.env, o);
  current = loadConv(w.env, start.conversation);
  assert.equal(current.control.state, 'pending'); assert.equal(current.body, before.body);
  assert.equal(current.nativeRetirement, undefined, 'a temporarily unreadable collected pack is never acknowledged as empty');
  w.hr.sealer = w.sealer;
  await tick(w.env, o);
  current = loadConv(w.env, start.conversation);
  assert.equal(current.control.state, 'held', JSON.stringify({ warnings, retiring: current.retiring?.type, starting: !!current.starting, receipt: current.nativeRetirement }));
  if (oversized) {
    assert.equal(current.slot, undefined, 'the shared size policy resumes from digests, never an empty native slot');
    assert.ok(warnings.some(m => /over 6 MB.*resumes from its digests/.test(m)), 'the shared retirement reports the explicit continuity loss');
  } else assert.equal(current.slot.session, entry.session);
  assert.equal(current.body, undefined); assert.deepEqual(current.actsFor, before.actsFor);
  assert.deepEqual(current.queue.map(x => x.key), [fed[1]], 'only the final unconsumed follow-up is requeued from sealed runtime copies');
  assert.equal(w.local.startsEntered, 1, 'collection never admits replacement native work');
});
