import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAdapters, bridgeStatus } from '../src/nowboard.mjs';
test('live adapter replaces down bridge once, and adds its other agents', () => {
  const bs = mergeAdapters({ art: [{ name: 'discord', stale: true }] }, { discord: { mode: 'live', agents: ['art', 'mark'] } }, 100);
  assert.equal(bs.art.length, 1);
  assert.equal(bs.mark.length, 1);
  assert.equal(bridgeStatus(bs.art[0], { want: 'down' }, null, 100).state, 'live');
});
test('both down and shadow leave legacy down state alone', () => {
  for (const adapters of [{}, { discord: { mode: 'shadow', agents: ['art'] } }]) {
    const bs = mergeAdapters({ art: [{ name: 'discord', stale: true }] }, adapters, 100);
    assert.equal(bridgeStatus(bs.art[0], { want: 'down' }, null, 100).state, 'down');
  }
});

import { agentReports } from '../src/ui.mjs';
test('cards read live adapters once per venue, even with old services stopped', () => {
  const s = {agents:{art:{}}, services:{'art/discord':{agent:'art',name:'discord',want:'down'}},houses:{}};
  const a = {discord:{mode:'live',agents:['art','mark']}};
  const r = agentReports(s, 100, {}, [], a);
  assert.deepEqual(r.art.readings, [{label:'Bridges', value:'discord ✓',tone:'ok'}]);
  assert.deepEqual(r.mark.readings, r.art.readings);
  assert.equal(agentReports(s,100,{},[],{discord:{mode:'shadow',agents:['art']}}).art, undefined);
  assert.equal(agentReports(s,100).art, undefined);
});
