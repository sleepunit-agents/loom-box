import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HouseRunner, hostOf } from '../src/houserunner.mjs';
import { readHouseLaunch, writeHouseLaunch } from '../src/house-launch-journal.mjs';
import { load } from '../src/state.mjs';
import { hasAge, houseWorld } from './delivery-world.mjs';
const wait = async fn => {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw Error('house admission fixture timed out'); await new Promise(r => setTimeout(r, 10)); }
};
async function prepared(harness, id) {
  const w = houseWorld({ harness });
  const options = { agent: 'art', brief: 'private house admission fixture', model: harness === 'codex' ? 'gpt' : 'opus', env: { LOOM_BODY_KEY: 'private-fixture-key', LOOM_BODY_CONVERSATION: 'cv-abcdef123456' } };
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
      assert.equal(Object.keys(hostOf(w.env, 'art').req ?? {}).length, 0);
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
      const path = join(w.env.LOOM_BOX_DATA, 'delivery/hosts/art.json');
      const h = hostOf(w.env, 'art'); delete h.report.done[w.handle.rid]; writeFileSync(path, JSON.stringify(h));
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
    assert.equal(hostOf(w.env, 'art').req[w.handle.rid].launch, w.handle.id);
    assert.equal(w.local.startsEntered ?? 0, 0);
  } finally { w.setRequestDrop(() => false); await w.finish(); }
});

test('a host error string alone cannot authorize a replacement house request', { skip: !hasAge }, async () => {
  const w = await prepared('codex', '5'.repeat(64));
  try {
    w.setRequestDrop(() => true);
    w.hr.publishPreparedLaunch(w.handle);
    const h = hostOf(w.env, 'art');
    h.report.done[w.handle.rid] = { error: 'cancelled before native admission' };
    writeFileSync(join(w.env.LOOM_BOX_DATA, 'delivery/hosts/art.json'), JSON.stringify(h));
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
    assert.equal(hostOf(w.env, 'art').req[w.handle.rid].launch, w.handle.id);
    assert.equal(w.hr.cancelPreparedLaunch(w.handle), false);
    await wait(() => readHouseLaunch(w.env, w.handle.id).state === 'ready');
    const h = hostOf(w.env, 'art'); delete h.report.done[w.handle.rid];
    writeFileSync(join(w.env.LOOM_BOX_DATA, 'delivery/hosts/art.json'), JSON.stringify(h));
    const fresh = new HouseRunner(w.env, harness, { sealer: w.sealer });
    const body = await fresh.waitPreparedLaunch(w.handle);
    assert.equal(body.id, 'h-1-b0000000');
    assert.equal(body.inputUncertain, true, 'a legacy identity receipt cannot claim full input confirmation');
    assert.equal(fresh.acknowledgePreparedLaunch(w.handle), true);
    assert.equal(hostOf(w.env, 'art').req[w.handle.rid], undefined);
    assert.equal(fresh.acknowledgePreparedLaunch(w.handle), true);
    assert.equal(fresh.observePreparedLaunch(w.handle).body.id, body.id);
    assert.equal(w.local.startsEntered, 1);
    assert.equal(w.local.status({ id: 'b0000000' }), 'working', 'acknowledging a receipt does not stop its bound writer');
  } finally { await w.finish(); }
});
