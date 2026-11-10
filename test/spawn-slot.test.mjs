// A spawn whose house is gone or stuck stops holding a spawn slot (t-2079): the cap counts only bodies whose house is
// still at work, `body end` lets the conversation go, and the cap is a setting the owner can change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCall, spawnCap } from '../src/spawn.mjs';
import { houseLetGo, loadConv, releaseBody, saveConv, tick } from '../src/delivery.mjs';
import { update } from '../src/state.mjs';
import { here, world } from './delivery-world.mjs';

const owner = { kind: 'owner' };
const start = (w, q = {}) => spawnCall(w.env, owner, { agent: 'art', brief: 'Reply ok', ...q }, w.o);
const house = (w, h) => update(w.env, (s) => { if (h) s.houses['h-7'] = { id: 'h-7', agent: 'art', box: 'one', kind: 'body-host', seat: 'owner', ...h }; else delete s.houses['h-7']; });

/** One spawn at work in house h-7, a second queued behind it at a cap of one. */
async function capped() {
  const w = world({ LOOM_RUNTIME_SPAWN_LIMIT: '1' });
  w.runner.houses = { owner: 'h-7' };
  house(w, { state: 'running' });
  const a = await start(w);
  const b = await start(w);
  assert.equal(a.body, 'started');
  assert.equal(b.body, 'queued');
  assert.match(b.reason, /spawn cap/);
  return { w, a, b };
}

test('a spawn whose house is still running holds its slot', async () => {
  const { w, b } = await capped();
  await tick(w.env, w.o);
  assert.equal(loadConv(w.env, b.handle).body, undefined, 'the queued spawn still waits');
});

for (const [why, h] of [
  ['draining', { state: 'running', draining: { at: '2026-11-02T12:00:00Z', reason: 'outdated image' } }],
  ['saving its history', { state: 'running', collection: { phase: 'native', at: '2026-11-02T12:00:00Z' } }],
  ['stopping', { state: 'stopping' }],
  ['done', { state: 'done' }],
  ['missing', null],
]) test(`a spawn whose house is ${why} holds no slot: the queued spawn starts`, async () => {
  const { w, a, b } = await capped();
  house(w, h);
  // Still working, as far as its conversation knows (a body stuck saving its history says so for hours).
  assert.ok(loadConv(w.env, a.handle).body);
  await tick(w.env, w.o);
  assert.ok(loadConv(w.env, b.handle).body, 'the queued spawn started');
});

test('a body on loom\'s own machine (no house) is never let go by house', () => {
  const w = world();
  assert.equal(houseLetGo(w.env, {}, 'claude:c0000000'), false);
  assert.equal(houseLetGo(w.env, {}, 'claude:h-1486-bc7dc6ad'), true, 'a house body whose house is off the record');
  assert.equal(houseLetGo(w.env, { 'h-1486': { state: 'running' } }, 'claude:h-1486-bc7dc6ad'), false);
  assert.equal(houseLetGo(w.env, { 'h-1486': { state: 'stopping' } }, 'claude:h-1486-bc7dc6ad'), true);
});

test('body end releases the conversation: no body, no retirement waiting on it, and its slot opens', async () => {
  const { w, a, b } = await capped();
  const c = loadConv(w.env, a.handle);
  const ref = c.body;
  // Stuck retiring, as cv-7efaaa138453 was: a retirement that keeps the body counted as working.
  c.retiring = { type: 'retire', body: ref, id: 'feedfacefeedfacefeedface' };
  saveConv(w.env, c);
  assert.deepEqual(releaseBody(w.env, ref), [a.handle]);
  const after = loadConv(w.env, a.handle);
  assert.equal(after.body, undefined);
  assert.equal(after.retiring, undefined);
  assert.deepEqual(releaseBody(w.env, ref), [], 'a second release finds nothing');
  await tick(w.env, w.o);
  assert.ok(loadConv(w.env, b.handle).body, 'the queued spawn started');
});

test('the spawn cap is a declared setting, with the default the runtime uses', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
  const s = pkg.loom.settings.find((x) => x.name === 'LOOM_RUNTIME_SPAWN_LIMIT');
  assert.ok(s, 'loom pieces set runtime LOOM_RUNTIME_SPAWN_LIMIT=5 needs it declared');
  assert.equal(Number(s.default), spawnCap({}));
  assert.equal(spawnCap({ LOOM_RUNTIME_SPAWN_LIMIT: '5' }), 5);
});
