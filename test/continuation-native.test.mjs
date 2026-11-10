import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { continuationCall, deliver, handOverWake, loadConv, ownerConversationControl, saveConv, tick } from '../src/delivery.mjs';
import { HouseRunner } from '../src/houserunner.mjs';
import { readHouseLaunch } from '../src/house-launch-journal.mjs';
import { load } from '../src/state.mjs';
import { setModels } from '../src/models.mjs';
import { hostPath, cvOf, hasAge, houseWorld, world } from './delivery-world.mjs';
const wait = async fn => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw Error('continuation native fixture timed out'); await new Promise(r => setTimeout(r, 10)); } };

for (const harness of ['claude', 'codex']) for (const mode of ['lost-receipt', 'expires-during-prepare', 'source-reset-during-prepare', 'uncertain-held']) {
  test(`${harness}: continuation through completed native admission: ${mode}`, { skip: !hasAge }, async () => {
    const w = world(), h = houseWorld({ harness });
    setModels(h.env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }], agent: 'art', prefer: ['opus'] });
    const source = await deliver(h.env, w.msg('native-source', 'owner', { source: 'loom', venue: 'loom', from: { kind: 'person', slug: 'jonathan' } }), { ...w.o, sealer: h.sealer });
    const sc = loadConv(h.env, source.conversation);
    const grant = continuationCall(h.env, { action: 'issue', conversation: sc.conversation, key: w.runner.envs[sc.body.split(':')[1]].LOOM_BODY_KEY, session: w.runner.slotOf({ id: sc.body.split(':')[1] }).session }, { ...w.o, sealer: h.sealer });
    const model = harness === 'claude' ? 'opus' : 'gpt';
    setModels(h.env, { list: [{ id: model, harness, family: harness === 'claude' ? 'anthropic' : 'openai' }], agent: 'art', prefer: [model] });
    const firing = w.msg('wake:w-abcdef', 'continue', { source: 'clock', venue: 'wake', id: 'w-abcdef', kind: 'wake', from: { kind: 'schedule' }, continuation: { handle: grant.handle, expiresAt: grant.expiresAt, wake: 'w-abcdef' } });
    handOverWake(h.env, { agent: 'art', place: firing.place, id: firing.id, for: 'owner' });
    const prepare = h.hr.prepareLaunch.bind(h.hr), observe = h.hr.waitPreparedLaunch.bind(h.hr);
    h.hr.prepareLaunch = async (...args) => {
      const handle = await prepare(...args);
      if (mode === 'expires-during-prepare') w.clock.advance(w.o.continuationLifetimeMs);
      if (mode === 'source-reset-during-prepare') { const c = loadConv(h.env, sc.conversation); c.actsFor.reset = 'changed'; saveConv(h.env, c); }
      return handle;
    };
    h.hr.waitPreparedLaunch = async handle => {
      const body = await observe(handle);
      if (mode === 'uncertain-held') {
        await ownerConversationControl(h.env, { kind: 'owner' }, { conversation: cvOf('art', 'wake', firing.place), action: 'interrupt' }, { ...o, detach: true, spawnWorker() {} });
        return { ...body, inputUncertain: true };
      }
      throw Error('fixture registrar lost receipt');
    };
    const o = { ...w.o, runner: () => h.hr, accounts: h.accounts, sealer: h.sealer };
    let host, drained;
    const first = deliver(h.env, firing, { ...o, onDrain: p => { drained = p; } });
    try {
      await wait(() => load(h.env).houses['h-1']); host = h.host();
      const result = await first; await drained;
      let c = loadConv(h.env, result.conversation);
      if (mode === 'uncertain-held') {
        for (let i = 0; i < 5 && c.control?.state !== 'held'; i++) { w.clock.advance(1001); await tick(h.env, o, c.conversation); c = loadConv(h.env, c.conversation); }
        assert.equal(c.control.state, 'held');
        assert.equal(c.continuationAdmissions?.length ?? 0, 0, 'uncertain input never gains report authority');
        assert.equal(h.local.startsEntered, 1, 'owner hold prevents replacement');
        assert.ok(c.queue.some(x => x.clockContinuation), 'sealed firing survives retirement under owner hold');
        return;
      }
      if (mode !== 'lost-receipt') {
        assert.equal(h.local.startsEntered ?? 0, 0, 'no native publication after authority expires or resets during preparation');
        assert.equal(c.body, undefined);
        assert.equal(c.continuationAdmissions, undefined);
        return;
      }
      // Before either child enqueues, a different authenticated firing must not launch.
      const other = { ...firing, id: 'w-fedcba', place: 'wake:w-fedcba', continuation: { ...firing.continuation, wake: 'w-fedcba' } };
      handOverWake(h.env, { agent: 'art', place: other.place, id: other.id, for: 'owner' });
      const duplicate = await deliver(h.env, other, o);
      assert.equal(loadConv(h.env, duplicate.conversation).body, undefined);
      assert.equal(h.local.startsEntered, 1, 'one firing claimed before any report binding');
      const prepared = c.starting.prepared;
      assert.equal(c.body, undefined);
      assert.equal(c.continuationAdmissions, undefined);
      assert.equal(readHouseLaunch(h.env, prepared.id).state, 'ready');
      const fresh = new HouseRunner(h.env, harness, { sealer: h.sealer, poll: 10 });
      w.clock.advance(1001); await tick(h.env, { ...o, runner: () => fresh }, c.conversation);
      c = loadConv(h.env, c.conversation);
      assert.equal(c.run, prepared.snapshot.run);
      assert.equal(c.continuationAdmissions.length, 1);
      assert.equal(c.launchAcks, undefined);
      assert.equal(fresh.host('art', prepared.handle.seat).req[prepared.handle.rid], undefined);
      assert.equal(h.local.startsEntered, 1);
      assert.equal(c.actsFor.owner, true);
      const q = { action: 'enqueue', conversation: c.conversation, key: h.local.envs.b0000000.LOOM_BODY_KEY, session: 's-b0000000', handle: grant.handle, id: 'result', text: 'native continuation complete' };
      assert.equal(continuationCall(h.env, q, o).state, 'pending');
      await tick(h.env, { ...o, runner: () => fresh }, c.conversation);
      assert.equal(h.local.startsEntered, 1, 'recovery never launches a second child');
      const changed = loadConv(h.env, c.conversation); changed.actsFor.reset = 'changed'; saveConv(h.env, changed);
      assert.throws(() => continuationCall(h.env, { ...q, id: 'after-reset' }, o), /bound/);
    } finally {
      if (host) { const path = hostPath(h.env); const record = JSON.parse(readFileSync(path, 'utf8')); writeFileSync(path, JSON.stringify({ ...record, house: 'h-999' })); await host; }
      await first;
    }
  });
}
