// loom's own machine is a box named after the machine. When the machine is
// renamed, its box is renamed with it, never doubled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, renameLocal, update } from '../src/state.mjs';
import { scratch } from './scratch.mjs';

const home = () => scratch('lb-name-');

function seeded(name) {
  const env = { LOOM_BOX_HOME: home(), LOOM_BOX_LOCAL_NAME: name, HOME: '/nonexistent' };
  update(env, (s) => {
    s.houses['h-1'] = { id: 'h-1', agent: 'art', box: name, state: 'done' };
    s.houses['h-2'] = { id: 'h-2', agent: 'art', box: 'thor', state: 'done' };
    s.boxes.thor = { mayHost: ['art'] };
    s.services = { 'art/discord': { agent: 'art', name: 'discord', box: name, want: 'down', house: 'h-1' } };
    s.serviceState = { 'art/discord': { from: 'h-1', box: name, at: 'x', data: '' } };
    s.primaries = { art: name, mark: 'thor' };
  });
  return env;
}

test('a renamed machine is refused until its box is renamed, not given a second box', () => {
  const env = seeded('art');
  const renamed = { ...env, LOOM_BOX_LOCAL_NAME: 'loom' };
  assert.throws(() => load(renamed), /loom's own box is art, but this machine is now called loom/);
  assert.deepEqual(renameLocal(renamed), { box: 'loom', was: 'art', renamed: true });
  const s = load(renamed);
  assert.deepEqual(Object.keys(s.boxes).sort(), ['loom', 'thor']);
  assert.ok(s.boxes.loom.local);
  assert.equal(s.houses['h-1'].box, 'loom');
  assert.equal(s.houses['h-2'].box, 'thor');
  assert.equal(s.services['art/discord'].box, 'loom');
  assert.equal(s.serviceState['art/discord'].box, 'loom');
  assert.deepEqual(s.primaries, { art: 'loom', mark: 'thor' });
  assert.deepEqual(renameLocal(renamed), { box: 'loom', renamed: false });
});

test('the rename waits for the box\'s houses to end, and won\'t take an enrolled box\'s name', () => {
  const env = seeded('art');
  update(env, (s) => { s.houses['h-3'] = { id: 'h-3', agent: 'art', box: 'art', state: 'running' }; });
  assert.throws(() => renameLocal({ ...env, LOOM_BOX_LOCAL_NAME: 'loom' }), /art still has houses running \(h-3\)/);
  assert.throws(() => renameLocal({ ...env, LOOM_BOX_LOCAL_NAME: 'thor' }), /already a box named thor/);
  assert.ok(load(env).boxes.art.local, 'nothing changed');
});
