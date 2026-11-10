// The owner's editor for work roles on the runtime page (t-2036): add, change and remove a role from the page, with
// the catalog's version guarding against a stale form, and the household's owner the only one who may.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { act, page } from '../src/ui.mjs';
import { readRoles, setModels, setRole } from '../src/models.mjs';
import { scratch } from './scratch.mjs';

function setup() {
  const env = { HOME: scratch('loom-box-roles-'), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  const fx = { now: () => new Date(), mint: () => 'loom_' + 'x'.repeat(30), revoke: () => {}, secret: () => 's' };
  setModels(env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }, { id: 'sol', harness: 'codex', family: 'openai' }] });
  return { env, fx };
}
const roles = (env) => page(env, { path: '' }).sections.find((s) => s.id === 'roles');

test('the owner adds, changes and removes a role from the runtime page', () => {
  const { env, fx } = setup();
  const empty = roles(env);
  const add = empty.blocks[0].rows.at(-1).edit;
  assert.equal(add.action, 'role-set');
  assert.deepEqual(add.fields.find((f) => f.name === 'models').options.map((o) => o.value), ['opus', 'sol']);
  const r = act(env, fx, { action: 'role-set', fields: { ...add.hidden, id: 'coding', description: 'Write and test code', models: 'sol,opus', failover: 'yes', why: 'first role' } });
  assert.equal(r.ok, true, r.message);
  const again = act(env, fx, { action: 'role-set', fields: { ...roles(env).blocks[0].rows.at(-1).edit.hidden, id: 'coding', description: 'Other', models: 'opus' } });
  assert.equal(again.ok, false); assert.match(again.message, /already a coding role/);
  assert.deepEqual(readRoles(env).roles.map((x) => [x.id, x.models, x.failover]), [['coding', ['sol', 'opus'], true]]);
  assert.equal(readRoles(env).changed.why, 'first role');

  const row = roles(env).blocks[0].rows.find((x) => x.label === 'coding');
  assert.equal(row.value, 'sol, opus');
  assert.equal(row.edit.fields.find((f) => f.name === 'models').value, 'sol,opus');
  assert.equal(act(env, fx, { action: 'role-set', fields: { ...row.edit.hidden, description: 'Code', families: 'anthropic', failover: 'no' } }).ok, true);
  assert.deepEqual(readRoles(env).roles[0], { id: 'coding', description: 'Code', families: ['anthropic'], failover: false, eligible: ['opus'] });

  // The form the owner opened before that edit is stale now: refused, nothing changed.
  const stale = act(env, fx, { action: 'role-remove', fields: row.act.fields });
  assert.equal(stale.ok, false); assert.match(stale.message, /changed since you opened/i);
  assert.equal(readRoles(env).roles.length, 1);
  const fresh = roles(env).blocks[0].rows.find((x) => x.label === 'coding');
  assert.equal(act(env, fx, { action: 'role-remove', fields: fresh.act.fields }).ok, true);
  assert.deepEqual(readRoles(env).roles, []);
});

test('a bad role is refused with its reason, and only the household owner edits roles', () => {
  const { env, fx } = setup();
  const hidden = roles(env).blocks[0].rows.at(-1).edit.hidden;
  const bad = act(env, fx, { action: 'role-set', fields: { ...hidden, id: 'review', description: 'Review code', models: 'gpt-9' } });
  assert.equal(bad.ok, false); assert.match(bad.message, /isn't in the model list/);
  const none = act(env, fx, { action: 'role-set', fields: { ...hidden, id: 'review', description: 'Review code' } });
  assert.equal(none.ok, false); assert.match(none.message, /name the models/);
  const loren = { kind: 'owner', who: 'loren', agents: ['mark'] };
  assert.match(act(env, fx, { action: 'role-set', caller: loren, fields: { ...hidden, id: 'review', description: 'Review', models: 'opus' } }).message, /household owner/);
  assert.match(act({ ...env, LOOM_SCOPE: 'art' }, fx, { action: 'role-set', fields: { ...hidden, id: 'review', description: 'Review', models: 'opus' } }).message, /art's page/);
  assert.deepEqual(readRoles(env).roles, []);
});

test('saving from the page keeps what the form does not show (input, output, dossier)', () => {
  const { env, fx } = setup();
  setRole(env, { role: { id: 'review', description: 'Review code', models: ['opus'], input: 'a PR', output: 'findings', dossier: 'review' } });
  const row = roles(env).blocks[0].rows.find((x) => x.label === 'review');
  assert.equal(act(env, fx, { action: 'role-set', fields: { ...row.edit.hidden, description: 'Review a change', models: 'opus', failover: 'no' } }).ok, true);
  const r = readRoles(env).roles[0];
  assert.deepEqual([r.description, r.input, r.output, r.dossier], ['Review a change', 'a PR', 'findings', 'review']);
  // The version is checked inside the write: an edit against an older one is refused there too.
  assert.throws(() => setRole(env, { role: { id: 'x', description: 'x', models: ['opus'] }, expect: 0 }), /changed since/);
});
