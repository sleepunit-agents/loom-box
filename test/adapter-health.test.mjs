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
