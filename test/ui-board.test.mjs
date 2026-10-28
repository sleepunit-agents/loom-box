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
  const tab = page({ ...env, LOOM_SCOPE: 'art' }, { path: '' });
  const form = section(tab, 'agent-art').blocks.find((b) => b.type === 'details').blocks.find((b) => b.type === 'form' && b.action === 'set-agent');
  const f = form.fields.find((x) => x.name === 'tailnets');
  assert.equal(f.value, 'fleet=/run/tailscale-fleet/tailscaled.sock');
  // Saving the form as it is keeps the grant.
  const fields = Object.fromEntries(form.fields.filter((x) => x.value !== undefined).map((x) => [x.name, x.value]));
  assert.equal(act(env, fx, { action: 'set-agent', fields: { ...fields, agent: 'art' } }).ok, true);
  assert.deepEqual(load(env).agents.art.tailnets, [{ name: 'fleet', socket: '/run/tailscale-fleet/tailscaled.sock' }]);
});

test("an agent's Houses tab: its houses, services with Restart, its sessions with their links; the board keeps boxes and links each agent; Restart stops the house", () => {
  const { env, fx } = setup();
  assert.equal(act(env, fx, { action: 'service-up', fields: { agent: 'art', name: 'remote' } }).ok, true);
  const house = load(env).services['art/remote'].house;
  mkdirSync(join(env.LOOM_BOX_DATA, 'houses', house), { recursive: true });
  writeFileSync(join(env.LOOM_BOX_DATA, 'houses', house, 'log'), 'starting…\nhttps://claude.ai/code?environment=env_01ABCdef\n');
  const board = page(env, { path: '' });
  const bids = board.sections.map((x) => x.id);
  for (const gone of ['services', 'sessions', 'houses', 'up', 'primaries']) assert.ok(!bids.includes(gone), `the board has no ${gone}: ${bids}`);
  assert.deepEqual(section(board, 'agents').blocks[0].items.map((i) => i.page), ['agent:art']);
  const p = page({ ...env, LOOM_SCOPE: 'art' }, { path: '' });
  const ids = p.sections.map((x) => x.id);
  assert.deepEqual(ids, ['houses', 'services', 'sessions', 'up', 'agent-art']);
  const sess = section(p, 'sessions');
  const items = sess.blocks.find((b) => b.type === 'list').items;
  assert.deepEqual(items.map((i) => [i.text, i.href, i.agent, i.act.action, i.act.tone]), [["art's house: house session", 'https://claude.ai/code?environment=env_01ABCdef', 'art', 'service-down', 'danger']]);
  // No box session yet: where it runs is a form, behind a details.
  assert.ok(sess.blocks.some((b) => b.type === 'details' && /first box session/.test(b.summary)));
  // A card for the box: its houses with their agent, and the machine's facts folded.
  assert.ok(section(board, 'box-one').blocks.some((b) => b.type === 'details' && b.summary === 'Machine'));
  // From art's tab: art's things only, none of the household's.
  const scoped = { ...env, LOOM_SCOPE: 'art' };
  assert.match(act(scoped, fx, { action: 'service-restart', fields: { agent: 'mark', name: 'remote' } }).message, /art's page/);
  assert.match(act(scoped, fx, { action: 'revoke-box', fields: { name: 'one' } }).message, /art's page/);
  // Each service up has Restart at its row.
  assert.deepEqual(section(p, 'services').blocks[0].items.map((i) => i.act?.action), ['service-restart']);
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

test("an agent owner's page is their agents' houses and services; the household's actions are refused (loom docs/specs/owners.md)", () => {
  const { env, fx } = setup();
  assert.equal(act(env, fx, { action: 'set-agent', fields: { agent: 'mark', repo: 'https://x/mark.git' } }).ok, true);
  api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'up', body: { task: 'art work' } });
  api(env, fx, { caller: { kind: 'agent', agent: 'mark' }, path: 'up', body: { task: 'mark work' } });
  const loren = { kind: 'owner', who: 'loren', agents: ['mark'] };
  const p = page(env, { path: '', caller: loren });
  assert.equal(p.title, 'Houses');
  const rows = section(p, 'houses').blocks[0].items;
  assert.deepEqual(rows.map((r) => r.agent), ['mark']);
  assert.equal(page(env, { path: 'agents', caller: loren }).title, 'Not found');
  assert.match(act(env, fx, { action: 'set-agent', fields: { agent: 'mark', repo: 'https://evil.example/x.git' }, caller: loren }).message, /household owner/);
  assert.equal(load(env).agents.mark.repo, 'https://x/mark.git');
  const artHouse = Object.values(load(env).houses).find((h) => h.agent === 'art').id;
  assert.equal(act(env, fx, { action: 'down', fields: { id: artHouse }, caller: loren }).ok, false);
  assert.equal(act(env, fx, { action: 'down', fields: { id: rows[0].act.fields.id }, caller: loren }).ok, true);
  // The household owner's board, as before.
  assert.notEqual(page(env, { path: '', caller: { kind: 'owner', who: 'jonathan-barket', agents: '*' } }).title, 'Houses');
});
