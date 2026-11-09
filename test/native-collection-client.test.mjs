import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { api } from '../src/control.mjs';
import { load, update } from '../src/state.mjs';
import { HouseRunner } from '../src/houserunner.mjs';
import { collectNativeHistory } from '../src/native-collection-client.mjs';
import { offlineNativeAttempt } from '../src/native-history-collection.mjs';
import { ClaudeRunner } from '../src/runners.mjs';
import { reserveLaunch, admitLaunch } from '../src/launch-journal.mjs';
import { hasAge, houseWorld } from './delivery-world.mjs';
const put = (file, data) => { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, data, { mode: 0o600 }); };
const wait = async fn => { const end = Date.now() + 10_000; while (!fn()) { if (Date.now() > end) throw Error('native client fixture timed out'); await new Promise(r => setTimeout(r, 10)); } };
const session = '12345678-1234-1234-1234-123456789abc';
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

for (const lost of ['part', 'finish']) test(`a lost ${lost} acknowledgement recovers from the same durable plan without rereading vanished native files`, { skip: !hasAge }, async () => {
  const w = await setup('codex'); transcript(w.root, 'codex', 'recover exactly this context', 's-b0000000');
  let dropped = false;
  const client = { async call(path, body) { const result = await w.client.call(path, body); if (!dropped && body.phase === lost) { dropped = true; throw Error('fixture response lost'); } return result; } };
  await assert.rejects(collectNativeHistory({ ...w.options, client }), /response lost/);
  rmSync(w.root, { recursive: true }); rmSync(w.snapshot, { recursive: true });
  await collectNativeHistory(w.options);
  assert.equal(load(w.env).houses['h-1'].nativeHistory.complete, true);
  assert.equal(w.calls.filter(c => c.phase === 'part').length, 1, 'the already received context is never uploaded or launched again');
});

test('an existing live-host core receipt is adopted if the host exits after its final upload', { skip: !hasAge }, async () => {
  const w = await setup('codex');
  const body = { id: 'h-1-b0000000', house: 'h-1', agent: 'art', harness: 'codex' };
  w.hr.requestPack(body);
  const files = [{ root: 'sessions', rel: '2026/11/09/rollout-time-s-b0000000.jsonl', data: Buffer.from('already sealed by the live host').toString('base64') }];
  const result = await api(w.env, {}, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: 'body-sync', body: { hostKey: w.hostKey,
    report: { bodies: { b0000000: { harness: 'codex', status: 'ended', session: 's-b0000000' } }, done: {}, caps: ['parts', 'native-admission', 'native-history'], starting: [], packed: { b0000000: { part: 0, parts: 1, data: Buffer.from(JSON.stringify(files)).toString('base64') } } } } });
  assert.equal(result.status, 200);
  await collectNativeHistory(w.options); // The original transcript has already been dropped locally.
  assert.deepEqual(w.calls.map(c => c.phase), ['plan', 'finish']);
  assert.deepEqual(await w.hr.pack(body, { deferAck: true }), files);
});

test('missing native history and malformed completion responses cannot authorize cleanup', { skip: !hasAge }, async () => {
  const w = await setup('codex', false);
  await assert.rejects(collectNativeHistory(w.options), /admission history/);
  assert.equal(load(w.env).houses['h-1'].nativeHistory.complete, false);
  assert.equal(existsSync(w.root), true);
  await assert.rejects(collectNativeHistory({ ...w.options, physical: 'running' }), /physical/);
  assert.throws(() => offlineNativeAttempt(w.snapshot, { house: 'h-1', harness: 'codex', attempt: 'invalid' }), /invalid/);
  await assert.rejects(collectNativeHistory({ ...w.options, client: { call: async () => ({ complete: true }) } }), /invalid native collection plan/);
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
