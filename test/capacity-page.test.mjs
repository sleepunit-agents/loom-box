// The owner's switch for worker capacity admission on the runtime page (t-2037, slice 3): off by default, turned on and
// off by the household owner only, the change kept with who made it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { act, page } from '../src/ui.mjs';
import { allocatorOf } from '../src/allocator.mjs';
import { load } from '../src/state.mjs';
import { scratch } from './scratch.mjs';

function setup() {
  const env = { HOME: scratch('loom-box-capacity-'), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  const fx = { now: () => new Date(), mint: () => 'loom_' + 'x'.repeat(30), revoke: () => {}, secret: () => 's' };
  return { env, fx };
}
const row = (env) => page(env, { path: '' }).sections.find((s) => s.id === 'capacity').blocks[0].rows[0];

test('off by default; the household owner turns it on and off; an agent owner may not; nothing else is a mode', () => {
  const { env, fx } = setup();
  assert.match(row(env).value, /^Off/);
  assert.equal(row(env).act.fields.mode, 'enforce');
  const loren = { kind: 'owner', who: 'loren', agents: ['mark'] };
  assert.match(act(env, fx, { action: 'allocator-mode', caller: loren, fields: { mode: 'enforce' } }).message, /household owner/);
  assert.equal(allocatorOf(load(env)).mode, 'shadow');
  assert.equal(act(env, fx, { action: 'allocator-mode', fields: { mode: 'yes' } }).ok, false);
  const on = act(env, fx, { action: 'allocator-mode', caller: { kind: 'owner', who: 'jonathan-barket' }, fields: row(env).act.fields });
  assert.equal(on.ok, true, on.message);
  assert.equal(allocatorOf(load(env)).mode, 'enforce');
  assert.equal(allocatorOf(load(env)).changed.by, 'jonathan-barket');
  assert.match(row(env).value, /^On/);
  assert.equal(act(env, fx, { action: 'allocator-mode', fields: row(env).act.fields }).ok, true);
  assert.equal(allocatorOf(load(env)).mode, 'shadow');
});
