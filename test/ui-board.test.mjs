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
import { scratch } from './scratch.mjs';

function setup() {
  const env = { HOME: scratch('loom-box-b-'), LOOM_BOX_LOCAL_NAME: 'one' };
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
  // The house panel's last row opens the whole form in a sheet.
  const form = section(tab, 'agent-art').blocks.find((b) => b.type === 'panel').rows.find((r) => r.edit?.action === 'set-agent').edit;
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
  assert.deepEqual(section(board, 'agents').blocks[0].rows.map((i) => [i.label, i.agent, i.page]), [['Art', 'art', 'agent:art']]);
  const p = page({ ...env, LOOM_SCOPE: 'art' }, { path: '' });
  const ids = p.sections.map((x) => x.id);
  assert.deepEqual(ids, ['model', 'houses', 'services', 'sessions', 'up', 'agent-art']);
  assert.equal(section(p, 'model').blocks[0].action, 'model-choice');
  const sess = section(p, 'sessions');
  const items = sess.blocks.find((b) => b.type === 'list').items;
  assert.deepEqual(items.map((i) => [i.text, i.href, i.agent, i.act.action, i.act.tone]), [['House session', 'https://claude.ai/code?environment=env_01ABCdef', 'art', 'service-down', 'danger']]);
  // No box session yet: where it runs is a form, behind a details.
  assert.ok(sess.blocks.some((b) => b.type === 'details' && /first box session/.test(b.summary)));
  // A card for the box: its houses with their agent, and the machine's facts folded.
  assert.ok(section(page(env, { path: 'box/one' }), 'box-one').blocks[0].rows.some((r) => r.label === 'Machine' && r.sheet));
  // From art's tab: art's things only, none of the household's.
  const scoped = { ...env, LOOM_SCOPE: 'art' };
  assert.match(act(scoped, fx, { action: 'service-restart', fields: { agent: 'mark', name: 'remote' } }).message, /art's page/);
  assert.match(act(scoped, fx, { action: 'revoke-box', fields: { name: 'one' } }).message, /art's page/);
  // Each service up has Restart at its row.
  assert.deepEqual(section(p, 'services').blocks[0].rows.map((i) => [i.label, i.act?.action]), [['House session', 'service-restart']]);
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

test("the Houses tab names each house by what it is (its service, its wake), no house id in sight; a box's machine in words; just now, not 0s ago", () => {
  const { env, fx } = setup();
  assert.equal(act(env, fx, { action: 'service-up', fields: { agent: 'art', name: 'discord' } }).ok, true);
  const wake = 'You are Art, waking (wake id w-6b2931, kind wake, set 2026-10-30 08:00:00, note: t-1689 cadence runner build round 1). Go.';
  api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'up', body: { task: JSON.stringify({ prompt: wake }) } });
  const s = load(env);
  const bridge = s.services['art/discord'].house;
  const task = Object.values(s.houses).find((h) => !h.service).id;
  const p = page({ ...env, LOOM_SCOPE: 'art' }, { path: '' });
  // A headline, then a panel: each house by what it is, its state in words, its box.
  assert.equal(section(p, 'houses').blocks[0].type, 'health');
  const rows = section(p, 'houses').blocks.find((b) => b.type === 'panel').rows;
  assert.deepEqual(rows.map((r) => [r.label, r.value, r.detail, r.agent]).sort(), [
    // Before (#42): "one · h-…". After: the box alone.
    ["Art's Discord bridge", 'Waiting for a box', 'On one', 'art'],
    ['Wake: cadence runner build round 1 (t-1689)', 'Waiting for a box', 'On one', 'art'],
  ].sort());
  assert.ok(rows.every((r) => r.act.confirm === 'This house stops.'));
  // The id stays where it works: the Stop action's field.
  assert.deepEqual(rows.map((r) => r.act.fields.id).sort(), [bridge, task].sort());
  assert.ok(!JSON.stringify(section(p, 'houses').blocks.map((b) => (b.rows ?? []).map((r) => [r.label, r.value, r.detail]))).match(/\bh-\d+/), 'no house id in a row');
  // A stopped house goes to Recent: named the same, its age "just now", no Id column (before: [..., 'Updated', 'Id']).
  assert.equal(act(env, fx, { action: 'down', fields: { id: task } }).ok, true);
  const box = { caller: { kind: 'piece', subject: 'one' } };
  api(env, fx, { ...box, path: 'claim', body: { id: task } });
  api(env, fx, { ...box, path: 'report', body: { id: task, state: 'stopped', exit: 0 } });
  const recent = section(page({ ...env, LOOM_SCOPE: 'art' }, { path: '' }), 'houses').blocks.find((b) => b.type === 'details').blocks[0];
  assert.deepEqual(recent.columns, ['House', 'Box', 'State', 'Updated']);
  assert.equal(recent.rows.length, 1);
  assert.ok(recent.rows.every((r) => r.length === 4 && !r.some((c) => /\bh-\d+/.test(c))), 'no house id in Recent');
  const row = recent.rows[0];
  assert.equal(row[0], 'Wake: cadence runner build round 1 (t-1689)');
  assert.equal(row[3], 'just now');
  // The box's Machine card: its facts in words.
  const st = load(env);
  st.boxes.one.facts = ['os:linux', 'arch:x86_64', 'cpus:64', 'mem:94g', 'gpu:nvidia-geforce-rtx-5090', 'runtime:podman'];
  writeFileSync(join(env.LOOM_BOX_HOME, 'state.json'), JSON.stringify(st));
  const machine = section(page(env, { path: 'box/one' }), 'box-one').blocks[0].rows.find((r) => r.label === 'Machine');
  assert.equal(machine.value, 'Linux · 64 CPUs · 94 GB · NVIDIA GeForce RTX 5090');
  const kv = machine.sheet.blocks[0].items;
  assert.deepEqual(kv.slice(0, 6), [
    { label: 'System', value: 'Linux' }, { label: 'Architecture', value: 'x86-64' }, { label: 'CPUs', value: '64' },
    { label: 'Memory', value: '94 GB' }, { label: 'GPU', value: 'NVIDIA GeForce RTX 5090' }, { label: 'Runtime', value: 'podman' },
  ]);
});

test('collection rows and headlines agree that physically ended houses are finishing, not running',()=>{
  const {env,fx}=setup();const box={kind:'piece',subject:'one'};
  for(let i=0;i<2;i++){
    const h=api(env,fx,{caller:{kind:'agent',agent:'art'},path:'up',body:{task:'work'}}).body;
    api(env,fx,{caller:box,path:'claim',body:{id:h.id}});api(env,fx,{caller:box,path:'report',body:{id:h.id,state:'running'}});
    if(i===0)api(env,fx,{caller:box,path:'collection-status',body:{id:h.id,phase:'state'}});
  }
  const board=section(page(env,{path:''}),'status').blocks[0];
  assert.match(board.text,/1 house running/);assert.match(board.detail,/1 house finishing/);
  const stats=section(page(env,{path:''}),'status').blocks.find(b=>b.type==='stats').items;
  assert.match(stats.find(i=>i.label==='Houses').detail,/1 house finishing/);
  const local=section(page(env,{path:'box/one'}),'status').blocks[0];assert.match(local.text,/1 house running/);assert.match(local.text,/1 house finishing/);
  const scoped=page({...env,LOOM_SCOPE:'art'},{path:''}),health=section(scoped,'houses').blocks[0];
  assert.match(health.text,/1 house running/);assert.match(health.detail,/1 house finishing/);
  assert.equal(health.tone,'warn');assert.match(JSON.stringify(scoped),/Saving state/);
  const rows=section(scoped,'houses').blocks.find(b=>b.type==='panel').rows;
  assert.equal(rows.find(r=>r.value==='Saving state').act,undefined,'there is no process left to stop');
  assert.equal(rows.find(r=>r.value==='Running').act.action,'down','working houses retain their Stop control');
  const limited=page(env,{path:'',caller:{kind:'owner',who:'loren',agents:['art']}});
  const items=section(limited,'houses').blocks[0].items;
  assert.equal(items.find(i=>i.badge==='saving state').meta,'Saving state');
  assert.equal(items.find(i=>i.badge==='saving state').act,undefined);
  assert.equal(items.find(i=>i.badge==='running').act.action,'down');
});
