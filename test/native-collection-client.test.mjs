import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { api } from '../src/control.mjs';
import { load, update } from '../src/state.mjs';
import { HouseRunner, sweepSeats } from '../src/houserunner.mjs';
import { collectNativeHistory } from '../src/native-collection-client.mjs';
import { offlineNativeAttempt } from '../src/native-history-collection.mjs';
import { ClaudeRunner } from '../src/runners.mjs';
import { reserveLaunch, admitLaunch } from '../src/launch-journal.mjs';
import { MAX_SESSION_BYTES, SessionSizeError, SessionHistoryMissing } from '../src/sessions.mjs';
import { hasAge, houseWorld } from './delivery-world.mjs';
const put = (file, data) => { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, data, { mode: 0o600 }); };
const wait = async fn => { const end = Date.now() + 10_000; while (!fn()) { if (Date.now() > end) throw Error('native client fixture timed out'); await new Promise(r => setTimeout(r, 10)); } };
const session = '12345678-1234-1234-1234-123456789abc';

test('a negotiated native-history host survives authenticated report sanitizing and accepts publication', { skip: !hasAge }, async () => {
  const w = houseWorld({ harness: 'codex' });
  const preparing = w.hr.prepareLaunch('e'.repeat(64), { agent: 'art', brief: 'native-history handshake regression', model: 'gpt' });
  await wait(() => load(w.env).houses['h-1']);
  update(w.env, s => { s.houses['h-1'].nativeHistory = { v: 1, complete: false }; });
  w.houseEnv.HOUSE_ID = 'h-1';
  w.houseEnv.LOOM_RUNTIME_NATIVE_HISTORY = join(w.D, 'native'); mkdirSync(w.houseEnv.LOOM_RUNTIME_NATIVE_HISTORY);
  const host = w.host();
  try {
    const handle = await preparing;
    assert.ok(w.hr.host('art').report.caps.includes('native-history'), 'core must retain the host\'s negotiated capability');
    w.hr.publishPreparedLaunch(handle);
    assert.equal((await w.hr.waitPreparedLaunch(handle)).harness, 'codex');
    assert.equal(w.local.startsEntered, 1);
  } finally { await w.kill(); await host; }
});

function transcript(root, harness, value, identity = session) {
  const path = harness === 'claude' ? join(root, 'claude-projects/project', `${identity}.jsonl`) : join(root, 'codex-sessions/2026/11/09', `rollout-time-${identity}.jsonl`);
  put(path, value); return path;
}
async function setup(harness, known = true) {
  const w = houseWorld({ harness }), attempt = (harness === 'claude' ? 'c' : 'd').repeat(64);
  let hostKey;
  w.setDrop(got => { if (got.hostKey) hostKey = got.hostKey; return false; });
  const pending = w.hr.prepareLaunch(attempt, { agent: 'art', brief: 'model-free native collection client proof', model: harness === 'claude' ? 'opus' : 'gpt', env: { LOOM_BODY_KEY: 'fixture-sender' } });
  await wait(() => load(w.env).houses['h-1']); const host = w.host(); const handle = await pending;
  if (known) { w.hr.publishPreparedLaunch(handle); await w.hr.waitPreparedLaunch(handle); await wait(() => Object.keys(w.hr.host('art').report?.bodies ?? {}).length); }
  await w.kill(); await host;
  if (!known) w.hr.publishPreparedLaunch(handle);
  update(w.env, s => { s.houses['h-1'].state = 'running'; s.houses['h-1'].nativeHistory = { v: 1, complete: false }; });
  const caller = { kind: 'piece', subject: load(w.env).houses['h-1'].box };
  const calls = [];
  const client = { async call(path, body) {
    calls.push({ path, phase: body.phase, part: body.part });
    const result = await api(w.env, { sealer: w.sealer }, { caller, path, body });
    if (result.status !== 200) throw Error(result.body.error); return result.body;
  } };
  const root = join(w.D, 'native-history'), snapshot = join(w.D, 'native-snapshot'); mkdirSync(root);
  return { ...w, attempt, handle, client, calls, root, snapshot, hostKey, options: { client, id: 'h-1', root, snapshot, physical: 'gone' } };
}

for (const harness of ['claude', 'codex']) test(`${harness}: the box client seals the original native session before acknowledging collection`, { skip: !hasAge }, async () => {
  const w = await setup(harness), id = 'b0000000', identity = `s-${id}`;
  const file = transcript(w.root, harness, 'original native context', identity);
  const done = await collectNativeHistory(w.options);
  assert.equal(done.complete, true); assert.equal(load(w.env).houses['h-1'].nativeHistory.complete, true);
  assert.equal(readFileSync(file, 'utf8'), 'original native context', 'the client never deletes original history');
  const fresh = new HouseRunner(w.env, harness, { sealer: w.sealer });
  const files = await fresh.pack({ id: `h-1-${id}`, house: 'h-1', agent: 'art', harness }, { deferAck: true });
  assert.equal(Buffer.from(files[0].data, 'base64').toString(), 'original native context');
  assert.deepEqual(w.calls.map(c => c.phase), ['plan', 'part', 'finish']);
});

for (const harness of ['claude', 'codex']) test(`${harness}: an explicit offline size-limit receipt uses the same typed retirement fallback`, { skip: !hasAge }, async () => {
  const w = await setup(harness), body = { id: 'h-1-b0000000', house: 'h-1', agent: 'art', harness };
  const source = transcript(w.root, harness, Buffer.alloc(MAX_SESSION_BYTES + 1), 's-b0000000');
  await collectNativeHistory(w.options);
  assert.equal(load(w.env).houses['h-1'].nativeHistory.complete, true);
  assert.equal(readFileSync(source).length, MAX_SESSION_BYTES + 1, 'the client never discards its original before box cleanup');
  assert.equal(w.hr.packReady(body), true, 'the omission is a durable acknowledgement, not absent storage');
  await assert.rejects(w.hr.pack(body, { deferAck: true }), SessionSizeError);
  assert.equal(w.hr.packReady(body), true, 'only the committed retirement may acknowledge this receipt');
  w.hr.ackPack(body); assert.equal(w.hr.packReady(body), false);
});

for (const harness of ['claude', 'codex']) test(`${harness}: offline recovery reads an admitted token without interpreting its worker PID on the box`, { skip: !hasAge }, async () => {
  const w = await setup(harness, false), env = { HOUSE_ID: 'h-1', LOOM_RUNTIME_NATIVE_HISTORY: w.root };
  const ledger = reserveLaunch(env, { id: w.attempt, harness, intentHash: 'a'.repeat(64) });
  admitLaunch(env, w.attempt); // Its witness deliberately names this still-live test process.
  const id = harness === 'claude' ? 'deadbeef' : ledger.token;
  if (harness === 'claude') put(join(w.root, 'claude-jobs', id, 'state.json'), JSON.stringify({ sessionId: session, intent: 'first line\n' + ClaudeRunner.TOKEN_LINE.replace('{token}', ledger.token) + '\nwork' }));
  else put(join(w.root, 'codex-runs', id, 'events.jsonl'), JSON.stringify({ type: 'thread.started', thread_id: session }) + '\n');
  transcript(w.root, harness, 'context written before the host died');
  await collectNativeHistory(w.options);
  const recovered = w.hr.observePreparedLaunch(w.handle);
  assert.equal(recovered.state, 'ready'); assert.equal(recovered.body.inputUncertain, true);
  assert.equal(recovered.body.id, `h-1-${id}`);
  assert.equal(w.local.startsEntered ?? 0, 0, 'the box never starts another native process');
});

test('a reserved native admission becomes a positive refusal only through its physical-stop collection plan', { skip: !hasAge }, async () => {
  const w = await setup('codex', false);
  reserveLaunch({ HOUSE_ID: 'h-1', LOOM_RUNTIME_NATIVE_HISTORY: w.root }, { id: w.attempt, harness: 'codex', intentHash: 'a'.repeat(64) });
  await collectNativeHistory(w.options);
  assert.equal(w.hr.observePreparedLaunch(w.handle).state, 'refused');
  assert.deepEqual(w.calls.map(c => c.phase), ['plan', 'refuse', 'finish']);
});

for (const lost of ['part', 'finish']) for (const oversized of [false, true]) test(`a lost ${lost} acknowledgement recovers the same ${oversized ? 'size-limit receipt' : 'native files'} without rereading vanished history`, { skip: !hasAge }, async () => {
  const w = await setup('codex'); transcript(w.root, 'codex', oversized ? Buffer.alloc(MAX_SESSION_BYTES + 1) : 'recover exactly this context', 's-b0000000');
  let dropped = false;
  const client = { async call(path, body) { const result = await w.client.call(path, body); if (!dropped && body.phase === lost) { dropped = true; throw Error('fixture response lost'); } return result; } };
  await assert.rejects(collectNativeHistory({ ...w.options, client }), /response lost/);
  rmSync(w.root, { recursive: true }); rmSync(w.snapshot, { recursive: true });
  await collectNativeHistory(w.options);
  assert.equal(load(w.env).houses['h-1'].nativeHistory.complete, true);
  assert.equal(w.calls.filter(c => c.phase === 'part').length, 1, 'the already received context is never uploaded or launched again');
  if (oversized) await assert.rejects(w.hr.pack({ id: 'h-1-b0000000', house: 'h-1', agent: 'art', harness: 'codex' }, { deferAck: true }), SessionSizeError);
});

for (const oversized of [false, true]) test(`an existing live-host ${oversized ? 'size-limit' : 'native context'} receipt is adopted if the host exits after its final upload`, { skip: !hasAge }, async () => {
  const w = await setup('codex');
  const body = { id: 'h-1-b0000000', house: 'h-1', agent: 'art', harness: 'codex' };
  w.hr.requestPack(body);
  const files = oversized ? [] : [{ root: 'sessions', rel: '2026/11/09/rollout-time-s-b0000000.jsonl', data: Buffer.from('already sealed by the live host').toString('base64') }];
  const result = await api(w.env, {}, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: 'body-sync', body: { hostKey: w.hostKey,
    report: { bodies: { b0000000: { harness: 'codex', status: 'working', session: 's-b0000000', pending: [] } }, done: {}, caps: ['parts', 'native-admission', 'native-history'], starting: [], packed: { b0000000: { part: 0, parts: 1, pending: ['sealed-pending'], ...(oversized ? { omitted: 'size-limit' } : {}), data: Buffer.from(JSON.stringify(files)).toString('base64') } } } } });
  assert.equal(result.status, 200);
  await collectNativeHistory(w.options); // The original transcript has already been dropped locally.
  assert.deepEqual(w.calls.map(c => c.phase), ['plan', 'finish']);
  if (oversized) await assert.rejects(w.hr.pack(body, { deferAck: true }), SessionSizeError);
  else assert.deepEqual(await w.hr.pack(body, { deferAck: true }), files);
  assert.deepEqual(w.hr.unheard(body), ['sealed-pending'], 'the sealed final inbox receipt wins over the last report');
  assert.equal(w.hr.alive(body), false, 'physical-stop collection supersedes even a previously working report');
});

for (const harness of ['claude', 'codex']) test(`${harness}: offline inbox receipts recover follow-ups newer than the last host report`, { skip: !hasAge }, async () => {
  const w = await setup(harness), id = 'b0000000';
  transcript(w.root, harness, 'native context', `s-${id}`);
  const dir = join(w.root, 'inboxes', id);
  put(join(dir, 'meta.json'), JSON.stringify({ venue: 'runtime', chan: id, bridge: 'runtime' }));
  put(join(dir, 'pending.jsonl'), [{ id: 'heard', text: 'private inbox text' }, { id: 'unheard', text: 'private inbox text' }].map(x => JSON.stringify(x)).join('\n') + '\n');
  put(join(dir, 'delivered.jsonl'), JSON.stringify({ id: 'heard' }) + '\n');
  let leaked = false;
  const client = { async call(path, body) { leaked ||= JSON.stringify(body).includes('private inbox text'); return w.client.call(path, body); } };
  const body = { id: `h-1-${id}`, house: 'h-1', agent: 'art', harness };
  await collectNativeHistory({ ...w.options, client });
  const fresh = new HouseRunner(w.env, harness, { sealer: w.sealer, now: () => new Date(Date.now() + 3600_000) });
  assert.deepEqual(fresh.unheard(body), ['unheard'], 'final receipts survive a new controller and stale host report');
  assert.equal(leaked, false, 'replay selects delivery\'s sealed copies; inbox text never crosses the collection protocol');
});

test('an offline body without a final inbox receipt replays conservatively instead of trusting its stale empty report', { skip: !hasAge }, async () => {
  const w = await setup('codex'); transcript(w.root, 'codex', 'native context', 's-b0000000');
  await collectNativeHistory(w.options);
  assert.equal(w.hr.unheard({ id: 'h-1-b0000000', house: 'h-1', agent: 'art', harness: 'codex' }), null);
});

test('a final collected native body remains positively ended after its last live report expires', { skip: !hasAge }, async () => {
  const w = await setup('codex'); transcript(w.root, 'codex', 'native context', 's-b0000000');
  await collectNativeHistory(w.options);
  await w.client.call('report', { id: 'h-1', state: 'failed' });
  const body = { id: 'h-1-b0000000', house: 'h-1', agent: 'art', harness: 'codex' };
  const fresh = new HouseRunner(w.env, 'codex', { sealer: w.sealer, now: () => new Date(Date.now() + 3600_000) });
  assert.equal(fresh.packReady(body), true);
  assert.equal(fresh.alive(body), false, 'the durable physical-stop collection receipt outlives the host heartbeat');
});

test('missing offline pack files cannot impersonate a committed consumer acknowledgement', { skip: !hasAge }, async () => {
  const w = await setup('codex'); transcript(w.root, 'codex', 'only native context', 's-b0000000');
  await collectNativeHistory(w.options); await w.client.call('report', { id: 'h-1', state: 'failed' });
  const body = { id: 'h-1-b0000000', house: 'h-1', agent: 'art', harness: 'codex' };
  const file = join(w.env.LOOM_BOX_DATA, 'delivery/hosts/packed/art/h-1/b0000000.age');
  rmSync(file); rmSync(file + '.offline.json');
  w.hr.acknowledgePreparedLaunch(w.handle);
  assert.equal(Object.keys(w.hr.host('art').req).length, 0);
  sweepSeats(w.env);
  assert.ok(w.hr.host('art').offlineCollection, 'the unconsumed receipt also survives ordinary host-record pruning');
  assert.equal(w.hr.pending(body), true, 'only a durable consumer acknowledgement can release the received native history');
  await assert.rejects(w.hr.pack(body), /pack is unavailable; ownership remains held/);
});

test('malformed native admission history and malformed completion responses cannot authorize cleanup', { skip: !hasAge }, async () => {
  const w = await setup('codex', false);
  put(join(w.root, 'launches', `${w.attempt}.json`), 'malformed native admission JSON');
  await assert.rejects(collectNativeHistory(w.options), /could not be decoded/);
  assert.equal(load(w.env).houses['h-1'].nativeHistory.complete, false);
  assert.equal(existsSync(w.root), true);
  await assert.rejects(collectNativeHistory({ ...w.options, physical: 'running' }), /physical/);
  assert.throws(() => offlineNativeAttempt(w.snapshot, { house: 'h-1', harness: 'codex', attempt: 'invalid' }), /invalid/);
  await assert.rejects(collectNativeHistory({ ...w.options, client: { call: async () => ({ complete: true }) } }), /invalid native collection plan/);
});

for (const harness of ['claude', 'codex']) for (const bound of [false, true]) test(`${harness}: verified missing history records ${bound ? 'a bound loss receipt' : 'termination without fabricating a native body'}`, { skip: !hasAge }, async () => {
  const w = await setup(harness, bound);
  assert.equal(load(w.env).houses['h-1'].nativeHistory.complete, false);
  await assert.rejects(collectNativeHistory({ ...w.options, physical: 'running' }), /physical/);
  assert.equal(load(w.env).houses['h-1'].nativeHistory.complete, false);
  await collectNativeHistory(w.options);
  assert.equal(load(w.env).houses['h-1'].nativeHistory.complete, true);
  assert.equal(existsSync(w.root), true, 'the client does not delete evidence before box cleanup');
  assert.deepEqual(w.calls.map(c => c.phase), ['plan', 'loss', 'finish']);
  if (bound) {
    await assert.rejects(w.hr.pack({ id: 'h-1-b0000000', house: 'h-1', agent: 'art', harness }, { deferAck: true }), SessionHistoryMissing);
    assert.equal(w.hr.observePreparedLaunch(w.handle).state, 'ready', 'the established native identity is never rewritten as unstarted');
  } else {
    const observed = w.hr.observePreparedLaunch(w.handle);
    assert.equal(observed.state, 'terminated'); assert.equal(observed.termination.reason, 'missing-history');
    assert.equal(w.hr.publishPreparedLaunch(w.handle), 'terminated', 'late publication cannot restart a terminated admission');
    assert.equal(w.local.startsEntered ?? 0, 0);
    w.hr.acknowledgePreparedLaunch(w.handle);
    assert.equal(w.hr.observePreparedLaunch(w.handle).termination.consumed, true);
  }
});

for (const phase of ['loss', 'finish']) test(`lost ${phase} acknowledgement retains the same explicit loss after source removal`, { skip: !hasAge }, async () => {
  const w = await setup('codex', false); let lost = false;
  const client = { async call(path, body) { const result = await w.client.call(path, body); if (!lost && body.phase === phase) { lost = true; throw Error('fixture lost loss acknowledgement'); } return result; } };
  await assert.rejects(collectNativeHistory({ ...w.options, client }), /lost loss acknowledgement/);
  rmSync(w.root, { recursive: true, force: true }); rmSync(w.snapshot, { recursive: true, force: true });
  await collectNativeHistory(w.options);
  assert.equal(w.hr.observePreparedLaunch(w.handle).state, 'terminated');
  assert.equal(w.calls.filter(c => c.phase === 'loss').length, 1);
});

test('a missing original mount after physical termination is a loss, not proof of an unstarted attempt', { skip: !hasAge }, async () => {
  const w = await setup('codex', false); rmSync(w.root, { recursive: true });
  await collectNativeHistory(w.options);
  assert.equal(w.hr.observePreparedLaunch(w.handle).state, 'terminated');
});

test('a box retries a partial upload from its immutable snapshot after losing an early part acknowledgement', { skip: !hasAge }, async () => {
  const w = await setup('codex');
  const text = 'original native context '.repeat(25_000);
  const source = transcript(w.root, 'codex', text, 's-b0000000'); let dropped = false;
  const client = { async call(path, body) {
    const result = await w.client.call(path, body);
    if (!dropped && body.phase === 'part' && body.part === 0) { dropped = true; assert.equal(result.complete, false); throw Error('fixture early part response lost'); }
    return result;
  } };
  await assert.rejects(collectNativeHistory({ ...w.options, client }), /early part response lost/);
  writeFileSync(source, 'a changed source cannot mix with the admitted snapshot');
  await collectNativeHistory(w.options);
  const files = await w.hr.pack({ id: 'h-1-b0000000', house: 'h-1', agent: 'art', harness: 'codex' }, { deferAck: true });
  assert.equal(Buffer.from(files[0].data, 'base64').toString(), text);
  assert.equal(w.calls.filter(c => c.phase === 'part' && c.part === 0).length, 2);
});

test('an opted-in house with an older host cannot admit a model without durable-history capability', { skip: !hasAge }, async () => {
  const w = houseWorld({ harness: 'codex' });
  const preparation = w.hr.prepareLaunch('f'.repeat(64), { agent: 'art', brief: 'must not be admitted', model: 'gpt', env: {} });
  await wait(() => load(w.env).houses['h-1']);
  update(w.env, s => { s.houses['h-1'].nativeHistory = { v: 1, complete: false }; });
  const host = w.host();
  try {
    await assert.rejects(preparation, error => error.nativeNotStarted === true && error.hostUpgradeRequired === true && /durable native history/.test(error.message));
    assert.equal(Object.keys(w.hr.host('art').req).length, 0);
    assert.equal(w.local.startsEntered ?? 0, 0);
  } finally { await w.kill(); await host; }
});

test('a stopped house awaiting box collection does not spend the normal live-host wait budget', { skip: !hasAge }, async () => {
  const w = await setup('codex');
  await w.client.call('native-collection', { id: 'h-1', phase: 'plan', physical: 'gone' });
  const hr = new HouseRunner(w.env, 'codex', { sealer: w.sealer, claimMs: 100, poll: 5 });
  let refused;
  const result = hr.pack({ id: 'h-1-b0000000', house: 'h-1', agent: 'art', harness: 'codex' });
  result.catch(error => { refused = error; });
  await Promise.resolve();
  assert.match(refused?.message ?? '', /pending on its box/, 'offline collection yields without waiting for another host heartbeat');
  await assert.rejects(result, /pending on its box/);
});

test('missing house metadata does not prove that a native writer or its session is gone', { skip: !hasAge }, async () => {
  const w = await setup('codex');
  update(w.env, s => { delete s.houses['h-1']; });
  const body = { id: 'h-1-b0000000', house: 'h-1', agent: 'art', harness: 'codex' };
  assert.equal(w.hr.pending(body), true);
  await assert.rejects(w.hr.pack(body), /metadata is unavailable/);
});
