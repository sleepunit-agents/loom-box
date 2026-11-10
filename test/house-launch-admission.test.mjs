import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HouseRunner, hostOf } from '../src/houserunner.mjs';
import { readHouseLaunch, writeHouseLaunch } from '../src/house-launch-journal.mjs';
import { load, update } from '../src/state.mjs';
import { down } from '../src/control.mjs';
import { hasAge, hostPath, houseWorld } from './delivery-world.mjs';
const wait = async fn => {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw Error('house admission fixture timed out'); await new Promise(r => setTimeout(r, 10)); }
};
const SEAT = 'owner.cv-abcdef123456';
async function prepared(harness, id) {
  const w = houseWorld({ harness });
  // A body holding a conversation runs in that conversation's own house (t-2061).
  const options = { agent: 'art', brief: 'private house admission fixture', model: harness === 'codex' ? 'gpt' : 'opus', seat: SEAT, env: { LOOM_BODY_KEY: 'private-fixture-key', LOOM_BODY_CONVERSATION: 'cv-abcdef123456' } };
  const preparation = w.hr.prepareLaunch(id, options);
  await wait(() => load(w.env).houses['h-1']);
  const host = w.host();
  const handle = await preparation;
  return { ...w, options, handle, async finish() { await w.kill(); await host; } };
}
for (const harness of ['claude', 'codex']) {
  test(`${harness}: reservation can be cancelled before publication; a late publisher cannot start work`, { skip: !hasAge }, async () => {
    const w = await prepared(harness, '1'.repeat(64));
    try {
      assert.equal(w.local.startsEntered ?? 0, 0);
      assert.equal(Object.keys(hostOf(w.env, 'art', SEAT).req ?? {}).length, 0);
      assert.doesNotMatch(JSON.stringify(w.handle), /private-fixture-key|private house admission fixture|sealed/);
      assert.deepEqual(await w.hr.prepareLaunch(w.handle.id, w.options), w.handle);
      await assert.rejects(w.hr.prepareLaunch(w.handle.id, { ...w.options, brief: 'another intent' }), /another intent/);
      const file = join(w.env.LOOM_BOX_DATA, 'delivery/house-launches', w.handle.id + '.json');
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.doesNotMatch(readFileSync(file, 'utf8'), /private-fixture-key|private house admission fixture/);
      assert.equal(w.hr.cancelPreparedLaunch(w.handle), true);
      assert.equal(w.hr.publishPreparedLaunch(w.handle), 'refused');
      assert.equal(w.hr.observePreparedLaunch(w.handle).state, 'refused');
      assert.equal(w.local.startsEntered ?? 0, 0);
    } finally { await w.finish(); }
  });
  test(`${harness}: publication and a fresh controller recover one durable native receipt`, { skip: !hasAge }, async () => {
    const w = await prepared(harness, '2'.repeat(64));
    try {
      assert.equal(w.hr.publishPreparedLaunch(w.handle), 'published');
      assert.equal(w.hr.publishPreparedLaunch(w.handle), 'published');
      const fresh = new HouseRunner(w.env, harness, { sealer: w.sealer });
      let result;
      await wait(() => (result = fresh.observePreparedLaunch(w.handle)).state === 'ready');
      assert.equal(result.body.id, 'h-1-b0000000');
      assert.equal(result.body.harness, harness);
      assert.equal(result.body.seat, w.handle.seat);
      assert.equal(w.local.startsEntered, 1);
      assert.throws(() => fresh.observePreparedLaunch({ ...w.handle, seat: 'u-cv-123456abcdef' }), /does not match/);
      const path = hostPath(w.env);
      const h = hostOf(w.env, 'art', SEAT); delete h.report.done[w.handle.rid]; writeFileSync(path, JSON.stringify(h));
      assert.deepEqual(fresh.observePreparedLaunch(w.handle), result, 'the receipt survives loss of the transient host report');
      assert.equal(readHouseLaunch(w.env, w.handle.id).state, 'ready');
      assert.equal(fresh.cancelPreparedLaunch(w.handle), false);
    } finally { await w.finish(); }
  });
  test(`${harness}: a crash between publication writes cannot turn published work into a safe cancellation`, { skip: !hasAge }, async () => {
    const w = await prepared(harness, '3'.repeat(64));
    try {
      const before = readHouseLaunch(w.env, w.handle.id);
      w.hr.publishPreparedLaunch(w.handle);
      writeHouseLaunch(w.env, before); // crash image: req rename committed, journal rename did not
      assert.equal(w.hr.cancelPreparedLaunch(w.handle), false);
      assert.equal(readHouseLaunch(w.env, w.handle.id).state, 'published');
      await wait(() => w.hr.observePreparedLaunch(w.handle).state === 'ready');
      assert.equal(w.local.startsEntered, 1);
    } finally { await w.finish(); }
  });
}

test('publication intent remains uncertain when its transient host request disappears', { skip: !hasAge }, async () => {
  const w = await prepared('codex', '4'.repeat(64));
  try {
    w.setRequestDrop(() => true);
    const intent = readHouseLaunch(w.env, w.handle.id);
    intent.state = 'publishing'; writeHouseLaunch(w.env, intent);
    assert.equal(w.hr.cancelPreparedLaunch(w.handle), false);
    assert.equal(w.hr.observePreparedLaunch(w.handle).state, 'pending');
    assert.equal(w.hr.publishPreparedLaunch(w.handle), 'published');
    assert.equal(hostOf(w.env, 'art', SEAT).req[w.handle.rid].launch, w.handle.id);
    assert.equal(w.local.startsEntered ?? 0, 0);
  } finally { w.setRequestDrop(() => false); await w.finish(); }
});

test('a host error string alone cannot authorize a replacement house request', { skip: !hasAge }, async () => {
  const w = await prepared('codex', '5'.repeat(64));
  try {
    w.setRequestDrop(() => true);
    w.hr.publishPreparedLaunch(w.handle);
    const h = hostOf(w.env, 'art', SEAT);
    h.report.done[w.handle.rid] = { error: 'cancelled before native admission' };
    writeFileSync(hostPath(w.env), JSON.stringify(h));
    assert.equal(w.hr.observePreparedLaunch(w.handle).state, 'pending');
    assert.equal(w.hr.cancelPreparedLaunch(w.handle), false);
    assert.equal(readHouseLaunch(w.env, w.handle.id).state, 'published');
  } finally { w.setRequestDrop(() => false); await w.finish(); }
});

for (const harness of ['claude', 'codex']) test(`${harness}: timeout retains the original request and host sync persists its receipt before any observer`, { skip: !hasAge }, async () => {
  const w = await prepared(harness, '6'.repeat(64));
  try {
    w.local.startDelay = 150;
    w.hr.publishPreparedLaunch(w.handle);
    await assert.rejects(w.hr.waitPreparedLaunch(w.handle, { claimMs: 20 }), error => error.nativePending === true && !error.nativeNotStarted);
    assert.equal(hostOf(w.env, 'art', SEAT).req[w.handle.rid].launch, w.handle.id);
    assert.equal(w.hr.cancelPreparedLaunch(w.handle), false);
    await wait(() => readHouseLaunch(w.env, w.handle.id).state === 'ready');
    const h = hostOf(w.env, 'art', SEAT); delete h.report.done[w.handle.rid];
    writeFileSync(hostPath(w.env), JSON.stringify(h));
    const fresh = new HouseRunner(w.env, harness, { sealer: w.sealer });
    const body = await fresh.waitPreparedLaunch(w.handle);
    assert.equal(body.id, 'h-1-b0000000');
    assert.equal(body.inputUncertain, undefined, 'the new host explicitly confirms its completed input handoff');
    assert.equal(fresh.acknowledgePreparedLaunch(w.handle), true);
    assert.equal(hostOf(w.env, 'art', SEAT).req[w.handle.rid], undefined);
    assert.equal(fresh.acknowledgePreparedLaunch(w.handle), true);
    assert.equal(fresh.observePreparedLaunch(w.handle).body.id, body.id);
    assert.equal(w.local.startsEntered, 1);
    assert.equal(w.local.status({ id: 'b0000000' }), 'working', 'acknowledging a receipt does not stop its bound writer');
  } finally { await w.finish(); }
});


test('an identity receipt without input confirmation stays input-uncertain', { skip: !hasAge }, async () => {
  const w = await prepared('codex', '7'.repeat(64));
  try {
    w.setRequestDrop(() => true);
    w.hr.publishPreparedLaunch(w.handle);
    const h = hostOf(w.env, 'art', SEAT);
    h.report.done[w.handle.rid] = { id: 'unconfirmed-native' };
    writeFileSync(hostPath(w.env), JSON.stringify(h));
    const observed = w.hr.observePreparedLaunch(w.handle);
    assert.equal(observed.state, 'ready');
    assert.equal(observed.body.inputUncertain, true);
    w.hr.acknowledgePreparedLaunch(w.handle);
  } finally { w.setRequestDrop(() => false); await w.finish(); }
});


for (const harness of ['claude', 'codex']) test(`${harness}: owner Down keeps syncing an in-flight request and collects its late native body`, { skip: !hasAge }, async () => {
  const w = await prepared(harness, '8'.repeat(64));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const start = w.local.start.bind(w.local);
  w.local.start = async options => { await gate; return start(options); };
  w.setRequestDrop((_path, body) => {
    if (body.report?.starting?.includes(w.handle.rid)) body.report.starting = [...Array.from({ length: 64 }, (_, n) => n.toString(16).padStart(16, '0')), w.handle.rid];
    return false;
  });
  try {
    w.hr.publishPreparedLaunch(w.handle);
    await wait(() => hostOf(w.env, 'art', SEAT).report.starting?.includes(w.handle.rid));
    update(w.env, state => { state.houses['h-1'].state = 'running'; });
    down(w.env, {}, { kind: 'owner' }, { id: 'h-1' });
    await wait(() => hostOf(w.env, 'art', SEAT).quiescing);
    assert.ok(hostOf(w.env, 'art', SEAT).report.starting.includes(w.handle.rid), 'pending identities beyond the receipt limit remain visible');
    assert.equal(hostOf(w.env, 'art', SEAT).report.done[w.handle.rid], undefined, 'pending native work was not falsely refused');
    assert.equal(readHouseLaunch(w.env, w.handle.id).state, 'published');
    assert.equal(w.left(), false, 'the host stays alive while its native identity is pending');
    release();
    await wait(() => w.left());
    assert.equal(w.local.startsEntered, 1);
    assert.equal(w.ended.length, 1);
    assert.equal(readHouseLaunch(w.env, w.handle.id).state, 'ready');
  } finally { release(); await w.finish(); }
});

test('a lost receipt acknowledgement remains retryable after the bound request was removed', { skip: !hasAge }, async () => {
  const w = await prepared('codex', '9'.repeat(64));
  let lost = false;
  w.setDrop(reply => { if (!lost && reply.received?.includes(w.handle.rid)) { lost = true; return true; } return false; });
  try {
    w.hr.publishPreparedLaunch(w.handle);
    await wait(() => lost);
    assert.equal(readHouseLaunch(w.env, w.handle.id).state, 'ready');
    w.hr.acknowledgePreparedLaunch(w.handle);
    assert.equal(hostOf(w.env, 'art', SEAT).req[w.handle.rid], undefined);
    await wait(() => !hostOf(w.env, 'art', SEAT).report.starting?.includes(w.handle.rid));
    assert.equal(w.local.startsEntered, 1);
  } finally { w.setDrop(() => false); await w.finish(); }
});

test('a completed receipt beyond the report limit stays held through Down until explicitly acknowledged', { skip: !hasAge }, async () => {
  const w = await prepared('codex', 'c'.repeat(64));
  let padded = false, allowReceipt = false;
  w.setRequestDrop((_path, body) => {
    const receipt = body.report?.done?.[w.handle.rid];
    if (receipt && !allowReceipt) {
      padded = true;
      body.report.done = Object.fromEntries([...Array.from({ length: 64 }, (_, i) => [i.toString(16).padStart(16, '0'), { id: `unrelated-native-${i}` }]), [w.handle.rid, receipt]]);
    }
    return false;
  });
  try {
    w.hr.publishPreparedLaunch(w.handle);
    await wait(() => padded && hostOf(w.env, 'art', SEAT).report.starting?.includes(w.handle.rid));
    update(w.env, state => { state.houses['h-1'].state = 'running'; });
    down(w.env, {}, { kind: 'owner' }, { id: 'h-1' });
    await wait(() => hostOf(w.env, 'art', SEAT).quiescing);
    assert.equal(hostOf(w.env, 'art', SEAT).report.done[w.handle.rid], undefined);
    assert.equal(readHouseLaunch(w.env, w.handle.id).state, 'published', 'report truncation is not proof of no native work');
    assert.equal(w.left(), false);
    allowReceipt = true;
    await wait(() => w.left());
    assert.equal(readHouseLaunch(w.env, w.handle.id).state, 'ready');
    assert.equal(w.local.startsEntered, 1);
    assert.equal(w.ended.length, 1);
  } finally { allowReceipt = true; w.setRequestDrop(() => false); await w.finish(); }
});

test('missing pending metadata cannot downgrade an established host into a pre-start refusal proof', { skip: !hasAge }, async () => {
  const w = await prepared('codex', 'd'.repeat(64));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const start = w.local.start.bind(w.local);
  w.local.start = async options => { await gate; return start(options); };
  try {
    w.hr.publishPreparedLaunch(w.handle);
    await wait(() => hostOf(w.env, 'art', SEAT).report.starting?.includes(w.handle.rid));
    w.setRequestDrop((_path, body) => { if (body.report) { body.report.caps = ['parts']; delete body.report.starting; } return false; });
    update(w.env, state => { state.houses['h-1'].state = 'running'; });
    down(w.env, {}, { kind: 'owner' }, { id: 'h-1' });
    await wait(() => hostOf(w.env, 'art', SEAT).report.startingUnknown === true);
    assert.equal(hostOf(w.env, 'art', SEAT).report.done[w.handle.rid], undefined);
    assert.equal(readHouseLaunch(w.env, w.handle.id).state, 'published');
    assert.equal(w.left(), false);
    w.setRequestDrop(() => false); release();
    await wait(() => w.left());
    assert.equal(w.local.startsEntered, 1);
  } finally { w.setRequestDrop(() => false); release(); await w.finish(); }
});
