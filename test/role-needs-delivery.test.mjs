// A spawned job of a role with needs (t-2092), through delivery: the role's needs go with the job; a body on this
// machine starts only if this machine has them, else the job is refused with what's missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConv } from '../src/delivery.mjs';
import { setRole } from '../src/models.mjs';
import { spawnCall } from '../src/spawn.mjs';
import { load, update } from '../src/state.mjs';
import { world } from './delivery-world.mjs';

test('a job whose role needs a GPU: its needs are kept with it, and this machine without one gives it no body', async () => {
  const w = world();
  setRole(w.env, { role: { id: 'render', description: 'Render frames', models: ['opus'], needs: ['gpu:5090'] } });
  const r = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Render it', role: 'render' }, w.o);
  const c = loadConv(w.env, r.handle);
  assert.deepEqual(c.spawn.role.needs, ['gpu:5090']);
  assert.equal(c.body, undefined, 'never placed blind');
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 0);
  assert.match(JSON.stringify(c), /needs a box with gpu:5090/);
});

test('the same job, on a machine that has the GPU, starts here', async () => {
  const w = world();
  update(w.env, (s) => { const k = Object.keys(s.boxes).find((x) => s.boxes[x].local); s.boxes[k].facts = ['gpu:nvidia-geforce-rtx-5090']; });
  setRole(w.env, { role: { id: 'render', description: 'Render frames', models: ['opus'], needs: ['gpu:5090'] } });
  const r = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Render it', role: 'render' }, w.o);
  assert.match(loadConv(w.env, r.handle).body ?? '', /^claude:/);
  void load;
});
