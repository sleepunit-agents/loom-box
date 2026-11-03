// The runtime's pages as app panels and status screens (Jonathan, 2026-11-03: "app panels, not web forms"; "status
// screens, not markdown dumps"): a headline in words, a setting's row saying what it is now with one way to change it,
// and the switches' actions applying at once, each answering in plain words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { act, page } from '../src/ui.mjs';
import { load } from '../src/state.mjs';
import { api } from '../src/control.mjs';
import { memStore } from '../src/store.mjs';
import { GRANTS, KEY } from '../src/grants.mjs';
import { scratch } from './scratch.mjs';

const dist = process.env.LOOM_DIST || join(homedir(), 'Code', 'loom', 'dist');
const vocab = existsSync(join(dist, 'ui', 'vocab.js')) ? await import(join(dist, 'ui', 'vocab.js')) : null;
const fx = { now: () => new Date(), mint: () => 'loom_' + 'x'.repeat(30), revoke: () => {}, secret: () => 's' };

function setup() {
  const env = { HOME: scratch('loom-box-p-'), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  env.LOOM_HOME = join(env.HOME, 'loom');
  mkdirSync(env.LOOM_HOME, { recursive: true });
  writeFileSync(join(env.LOOM_HOME, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'] }));
  const st = memStore();
  st.put(GRANTS, KEY, { v: 1, pieces: { clock: { art: ['*'] }, tasks: { '*': ['*'] } }, relay: { art: ['mark'] }, seeded: { from: { clock: 'WAKE_AGENTS=art' } } });
  env.LOOM_RUNTIME_TEST_STORE = st;
  assert.equal(act(env, fx, { action: 'set-agent', fields: { agent: 'art', repo: 'https://github.com/x/art.git', ports: '7401', secrets: 'github-token=gh' } }).ok, true);
  return { env, st };
}
const section = (p, id) => p.sections.find((s) => s.id === id);
const valid = (what, p) => { if (vocab) { const v = vocab.parsePage(p); assert.notEqual(typeof v, 'string', `${what}: ${v}`); } };

test('Boxes is a status screen: a headline in words and tiles first; a body host is named, never its command', () => {
  const { env } = setup();
  // A body host's house: before, its row read "loom-runtime body-host --piece runtime --host-key …".
  api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'up', body: { task: `loom-runtime body-host --piece runtime --host-key ${'f'.repeat(32)}` } });
  const p = page(env, { path: '' });
  valid('boxes', p);
  const [health, stats] = section(p, 'status').blocks;
  assert.equal(health.type, 'health');
  assert.equal(stats.type, 'stats');
  assert.match(health.text, /^1 box up · 0 houses running$/);
  assert.deepEqual(stats.items.slice(0, 3).map((x) => x.label), ['Boxes', 'Houses', 'Services']);
  const houses = section(p, 'box-one').blocks.find((b) => b.type === 'panel' && /^Houses/.test(b.title ?? '')).rows;
  assert.deepEqual(houses.map((r) => [r.label, r.value, r.agent]), [["Art's body host", 'Waiting for a box', 'art']]);
  // The command and the id are a tap away, the boot key never anywhere.
  assert.match(JSON.stringify(houses[0].sheet), /body-host --piece runtime --host-key …/);
  assert.ok(!JSON.stringify(p).includes('f'.repeat(32)));
  // Something wrong leads the headline: a box asking to join.
  const j = api(env, fx, { caller: { kind: 'stranger', address: '10.0.0.9' }, path: 'join-request', body: { name: 'thor', proof_hash: 'a'.repeat(64) } });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  const p2 = page(env, { path: '' });
  valid('boxes with a join', p2);
  assert.deepEqual([section(p2, 'status').blocks[0].tone, section(p2, 'status').blocks[0].text], ['warn', 'A box asks to join']);
  assert.equal(section(p2, 'joins').blocks[0].rows[0].act.action, 'allow-join');
});

test("an agent's house panel: Nested containers and GPU are switches that keep every other grant", () => {
  const { env } = setup();
  const tab = page({ ...env, LOOM_SCOPE: 'art' }, { path: '' });
  valid('agent tab', tab);
  const rows = section(tab, 'agent-art').blocks[0].rows;
  const gpu = rows.find((r) => r.label === 'GPU');
  assert.deepEqual([gpu.value, gpu.toggle], ['Not allowed', { action: 'agent-flag', on: false, fields: { agent: 'art', flag: 'gpu' } }]);
  // The switch posts its fields and on="on"; from art's own tab too.
  const r = act({ ...env, LOOM_SCOPE: 'art' }, fx, { action: 'agent-flag', fields: { ...gpu.toggle.fields, on: 'on' } });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.message, 'Art\'s houses may have the box\'s GPU from their next start.');
  const c = load(env).agents.art;
  assert.deepEqual([c.gpu, c.nested, c.repo, c.secrets, c.ports.map((g) => g.port)], [true, false, 'https://github.com/x/art.git', { 'github-token': 'gh' }, [7401]]);
  assert.equal(act(env, fx, { action: 'agent-flag', fields: { agent: 'art', flag: 'gpu', on: '' } }).ok, true);
  assert.equal(load(env).agents.art.gpu, false);
  assert.equal(act(env, fx, { action: 'agent-flag', fields: { agent: 'art', flag: 'repo', on: 'on' } }).ok, false);
  // Mark's switch isn't art's tab's to press.
  assert.match(act({ ...env, LOOM_SCOPE: 'art' }, fx, { action: 'agent-flag', fields: { agent: 'mark', flag: 'gpu', on: 'on' } }).message, /art's page/);
});

test('Permissions: each piece a row in words with its sheet, each relay pair a switch, the people a row each', () => {
  const { env, st } = setup();
  const p = page(env, { path: 'permissions' });
  valid('permissions', p);
  const pieces = section(p, 'grants').blocks.find((b) => b.type === 'panel').rows;
  assert.deepEqual(pieces.map((r) => [r.label, r.value]), [['Clock', 'Art'], ['Tasks', 'Every agent'], ['Another piece', 'Grant a piece that isn\'t listed']]);
  assert.equal(pieces[0].detail, 'Imported from the piece\'s own agent list');
  // The sheet: Every agent or These agents (chips), as it is now.
  const f = Object.fromEntries(pieces[0].edit.fields.map((x) => [x.name, x]));
  assert.deepEqual([f.who.kind, f.who.value, f.agents.kind, f.agents.value], ['segmented', 'some', 'checks', 'art']);
  const rev = pieces[0].edit.hidden.rev;
  let r = act(env, fx, { action: 'grants-set', fields: { piece: 'clock', rev, who: 'some', agents: 'art,mark', paths: '*' } });
  assert.deepEqual([r.ok, r.message], [true, 'Clock is Art and Mark\'s to use; core asks from the next call.']);
  assert.deepEqual(st.get(GRANTS, KEY).doc.pieces.clock, { art: ['*'], mark: ['*'] });
  r = act(env, fx, { action: 'grants-set', fields: { piece: 'clock', rev: String(st.get(GRANTS, KEY).rev), who: 'all', agents: 'art', paths: '*' } });
  assert.deepEqual(st.get(GRANTS, KEY).doc.pieces.clock, { '*': ['*'] });
  // The old form's shape still works: agents as text.
  r = act(env, fx, { action: 'grants-set', fields: { piece: 'clock', rev: String(st.get(GRANTS, KEY).rev), agents: 'mark', paths: '*' } });
  assert.deepEqual([r.ok, st.get(GRANTS, KEY).doc.pieces.clock], [true, { mark: ['*'] }]);
  // A switch per pair; off and on again, the agent's other pairs kept.
  const relay = section(p, 'relay').blocks[0].rows;
  assert.deepEqual(relay.map((x) => [x.label, x.value, x.toggle.on]), [['Art to Mark', 'Without asking', true], ['Mark to Art', 'Asks you first', false]]);
  r = act(env, fx, { action: 'relay-pair', fields: { ...relay[1].toggle.fields, on: 'on' } });
  assert.deepEqual([r.ok, r.message, st.get(GRANTS, KEY).doc.relay.mark], [true, 'Mark relays to Art without asking now.', ['art']]);
  r = act(env, fx, { action: 'relay-pair', fields: { agent: 'art', to: 'mark', on: '' } });
  assert.deepEqual([r.ok, r.message, st.get(GRANTS, KEY).doc.relay.art], [true, 'Art asks you before relaying to Mark.', undefined]);
  assert.equal(act(env, fx, { action: 'relay-pair', fields: { agent: 'art', to: 'nobody', on: 'on' } }).ok, false);
  // The old relay form still answers.
  assert.equal(act(env, fx, { action: 'relay-set', fields: { agent: 'art', to: 'mark', rev: String(st.get(GRANTS, KEY).rev) } }).ok, true);
  // No revision numbers on the page.
  assert.ok(!/revision/.test(JSON.stringify(page(env, { path: 'permissions' }))));
});

test('a lane house reads as its lane, not its prompt\'s first words', async () => {
  const { houseName, doingOf } = await import('../src/ui.mjs');
  const h = { id: 'h-9', agent: 'art', box: 'one', state: 'running', task: 'You are running the landscape lane in a fresh house. Its prompt is too long to hand over in full.' };
  // Before: "You are running the landscape lane in a fresh house. Its pr…".
  assert.equal(houseName(h), 'Landscape lane');
  assert.deepEqual([doingOf(h, load(setup().env)).text, doingOf(h, load(setup().env)).kind], ['Landscape lane', 'lane']);
});
