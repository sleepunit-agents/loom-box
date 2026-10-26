// The Boxes page per its board (2026-10-26): sessions first, a card per box,
// services with Restart, and the agent form keeping every grant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, page } from '../src/ui.mjs';
import { load } from '../src/state.mjs';
import { api } from '../src/control.mjs';

function setup() {
  const env = { HOME: mkdtempSync(join(tmpdir(), 'loom-box-b-')), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  const fx = { now: () => new Date(), mint: () => 'loom_' + 'x'.repeat(30), revoke: () => {}, secret: () => 's' };
  assert.equal(act(env, fx, { action: 'set-agent', fields: { agent: 'art', repo: 'https://x/art.git', secrets: 'github-token=gh', tailnets: 'fleet=/run/tailscale-fleet/tailscaled.sock' } }).ok, true);
  return { env, fx };
}
const section = (p, id) => p.sections.find((s) => s.id === id);

test('the agent form carries the tailnet grant, so saving it keeps it', () => {
  const { env, fx } = setup();
  assert.deepEqual(load(env).agents.art.tailnets, [{ name: 'fleet', socket: '/run/tailscale-fleet/tailscaled.sock' }]);
  const form = section(page(env, { path: 'agents' }), 'agent-art').blocks.find((b) => b.type === 'form' && b.action === 'set-agent');
  const f = form.fields.find((x) => x.name === 'tailnets');
  assert.equal(f.value, 'fleet=/run/tailscale-fleet/tailscaled.sock');
  // Saving the form as it is keeps the grant.
  const fields = Object.fromEntries(form.fields.filter((x) => x.value !== undefined).map((x) => [x.name, x.value]));
  assert.equal(act(env, fx, { action: 'set-agent', fields: { ...fields, agent: 'art' } }).ok, true);
  assert.deepEqual(load(env).agents.art.tailnets, [{ name: 'fleet', socket: '/run/tailscale-fleet/tailscaled.sock' }]);
});

test('Sessions come first: the house session with its link from the house log, one tap down; Restart stops the house', () => {
  const { env, fx } = setup();
  assert.equal(act(env, fx, { action: 'service-up', fields: { agent: 'art', name: 'remote' } }).ok, true);
  const house = load(env).services['art/remote'].house;
  mkdirSync(join(env.LOOM_BOX_DATA, 'houses', house), { recursive: true });
  writeFileSync(join(env.LOOM_BOX_DATA, 'houses', house, 'log'), 'starting…\nhttps://claude.ai/code?environment=env_01ABCdef\n');
  const p = page(env, { path: '' });
  assert.equal(p.sections[0].id, 'sessions');
  const items = p.sections[0].blocks.find((b) => b.type === 'list').items;
  assert.deepEqual(items.map((i) => [i.text, i.href, i.agent]), [["art's house: house session", 'https://claude.ai/code?environment=env_01ABCdef', 'art']]);
  const buttons = p.sections[0].blocks.find((b) => b.type === 'buttons').items;
  assert.deepEqual(buttons.map((b) => [b.action, b.tone]), [['service-down', 'danger']]);
  // No box session yet: where it runs is a form, behind a details.
  assert.ok(p.sections[0].blocks.some((b) => b.type === 'details' && /first box session/.test(b.summary)));
  // A card for the box, its houses with their agent.
  assert.ok(section(p, 'box-one'));
  // Not running yet: already a fresh start.
  assert.match(act(env, fx, { action: 'service-restart', fields: { agent: 'art', name: 'remote' } }).message, /already starting fresh/);
  // Running: Restart stops it, and once the box says it stopped, a fresh house is wanted (no back-off).
  const box = { caller: { kind: 'piece', subject: 'one' } };
  api(env, fx, { ...box, path: 'claim', body: { id: house } });
  api(env, fx, { ...box, path: 'report', body: { id: house, state: 'running' } });
  const r = act(env, fx, { action: 'service-restart', fields: { agent: 'art', name: 'remote' } });
  assert.equal(r.ok, true, r.message);
  assert.equal(load(env).houses[house].state, 'stopping');
  api(env, fx, { ...box, path: 'report', body: { id: house, state: 'stopped', exit: 0 } });
  const svc = load(env).services['art/remote'];
  assert.notEqual(svc.house, house);
  assert.equal(load(env).houses[svc.house].state, 'wanted');
  assert.equal(svc.restarts, 0);
  assert.equal(act(env, fx, { action: 'service-restart', fields: { agent: 'art', name: 'nope' } }).ok, false);
});
