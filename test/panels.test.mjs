// The runtime's pages as app panels and status screens (Jonathan, 2026-11-03: "app panels, not web forms"; "status
// screens, not markdown dumps"): a headline in words, a setting's row saying what it is now with one way to change it,
// and the switches' actions applying at once, each answering in plain words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { act, manifest, page } from '../src/ui.mjs';
import { load } from '../src/state.mjs';
import { api, list, up } from '../src/control.mjs';
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

test('Boxes with three or more boxes: one row each (state, houses, what it is or what\'s wrong, worst first), each a tap from its own page with everything', () => {
  const { env } = setup();
  const owner = { kind: 'owner' };
  const add = (name, extra = {}) => { const r = api(env, fx, { caller: owner, path: 'add-box', body: { name, mayHost: 'anyone', ...extra } }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.box; };
  const poll = (box, body = {}) => assert.equal(api(env, fx, { caller: { kind: 'piece', subject: box }, path: 'poll', body }).status, 200);
  const thor = add('thor'), odin = add('odin'), loki = add('loki');
  // thor is fine and always on; odin has a sign-in missing; loki never joined.
  poll(thor, { harnesses: { claude: { installed: true, loggedIn: true } } });
  poll(odin, { harnesses: { claude: { installed: true, loggedIn: false } } });
  assert.equal(act(env, fx, { action: 'box-watch', fields: { name: thor, always_on: 'on' } }).page, `box/${thor}`, 'a box\'s own action comes back to its page');
  // Before (2026-11-05): up to three boxes were each a whole card on Boxes (state, machine, runtime, sign-ins, health,
  // watch, houses, settings), a wall of detail per box. Now: one row each.
  const p = page(env, { path: '' });
  valid('boxes, four', p);
  const rows = section(p, 'boxes').blocks[0].rows;
  assert.equal(rows.length, 4, 'one row per box');
  assert.deepEqual(rows.map((r) => r.page).sort(), ['box/one', `box/${thor}`, `box/${odin}`, `box/${loki}`].sort(), 'each row links to its own box');
  for (const r of rows) {
    assert.match(r.page, /^box\/[a-z0-9-]+$/, `${r.label} links to its own page`);
    assert.ok(['ok', 'warn', 'bad'].includes(r.tone), `${r.label} says how it is`);
    assert.ok(r.value && r.detail, `${r.label} has its state and one fact`);
    for (const k of ['sheet', 'act', 'edit', 'toggle', 'choice']) assert.equal(r[k], undefined, `${r.label}'s row is a link, nothing else`);
  }
  // What's wrong first, and said on the row; a fine box says what it's for.
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.label, r.tone]).sort(), [['loki', 'warn'], ['odin', 'warn']]);
  assert.equal(rows.find((r) => r.label === 'odin').detail, 'Claude isn\'t logged in · hosts houses');
  assert.equal(rows.find((r) => r.label === 'loki').detail, 'Hosts houses', 'not joined is its state, said once');
  assert.equal(rows.find((r) => r.label === 'loki').value, 'Not joined yet · 0 houses');
  assert.match(rows.find((r) => r.label === 'thor').value, /^Up · seen just now · 0 houses$/);
  assert.equal(rows.find((r) => r.label === 'thor').detail, 'Hosts houses · always on');
  assert.match(rows.find((r) => r.label === 'one').detail, /^Loom's own · hosts houses/);
  // No box's detail on the index: no per-box card, no runtime, sign-in or settings rows.
  for (const id of ['one', thor, odin, loki]) assert.equal(section(p, `box-${id}`), undefined);
  assert.ok(!/Log in|Update now|Revoke|May host/.test(JSON.stringify(section(p, 'boxes'))));
  // Each box's own page has everything that was on its card: state, machine, runtime, sign-ins (Log in), watch, settings and Revoke.
  const bp = page(env, { path: `box/${odin}` });
  valid('a box', bp);
  assert.equal(bp.title, 'odin');
  assert.deepEqual([section(bp, 'status').blocks[0].tone, section(bp, 'status').blocks[0].text], ['warn', 'Claude isn\'t logged in on odin']);
  const card = section(bp, `box-${odin}`);
  const panel = card.blocks[0].rows;
  assert.deepEqual(panel.slice(0, 2).map((r) => r.label), ['State', 'Machine']);
  assert.equal(panel.find((r) => r.label === 'Claude').act.action, 'login-start');
  assert.ok(panel.some((r) => r.label === 'Watch' && r.act?.action === 'box-watch'));
  const settings = card.blocks.find((b) => b.type === 'panel' && b.title === 'Settings');
  assert.deepEqual(settings.rows.map((r) => r.label), ['May host', 'Owner', 'Lent to']);
  assert.equal(settings.action.action, 'revoke-box');
  // A box that isn't there (or a made-up path) is Not found, never another box's page.
  assert.equal(page(env, { path: 'box/nope' }).title, 'Not found');
  // A box's page is the household owner's: never an agent's tab or an agent owner's page.
  assert.equal(page({ ...env, LOOM_SCOPE: 'art' }, { path: `box/${odin}` }).status, 403);
  assert.equal(page(env, { path: `box/${odin}`, caller: { kind: 'owner', who: 'loren', agents: ['art'] } }).status, 403);
});

test('a box\'s sign-ins and Update now on its own page stay its owner\'s: another household owner sees them, can\'t press', () => {
  const { env } = setup();
  writeFileSync(join(env.LOOM_HOME, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], members: [{ person: 'alice', agents: '*' }, { person: 'bob', agents: '*' }] }));
  const owner = { kind: 'owner' };
  assert.equal(api(env, fx, { caller: { kind: 'piece', subject: 'one' }, path: 'poll', body: { harnesses: { claude: { installed: true, loggedIn: false } } } }).status, 200);
  assert.equal(api(env, fx, { caller: owner, path: 'box-owner', body: { name: 'one', owner: 'alice' } }).status, 200);
  const claude = (who) => section(page(env, { path: 'box/one', caller: { kind: 'owner', who } }), 'box-one').blocks[0].rows.find((r) => r.label === 'Claude');
  assert.equal(claude('alice').act.action, 'login-start');
  assert.equal(claude('bob').act, undefined);
  assert.equal(act(env, fx, { action: 'login-start', fields: { box: 'one', harness: 'claude' }, caller: { kind: 'owner', who: 'bob' } }).ok, false);
});

test('Boxes is a status screen: a headline in words and tiles first; a body host is named, never its command', () => {
  const { env } = setup();
  // A body host's house: before, its row read "loom-runtime body-host --piece runtime --host-key …".
  up(env, fx, { kind: 'owner' }, { agent: 'art', task: `loom-runtime body-host --piece runtime --host-key ${'f'.repeat(32)}` }, { kind: 'body-host' });
  const p = page(env, { path: '' });
  valid('boxes', p);
  const [health, stats] = section(p, 'status').blocks;
  assert.equal(health.type, 'health');
  assert.equal(stats.type, 'stats');
  assert.match(health.text, /^1 box up · 0 houses running$/);
  assert.deepEqual(stats.items.slice(0, 3).map((x) => x.label), ['Boxes', 'Houses', 'Services']);
  // The box's houses are on its own page, a tap from its row.
  assert.equal(section(p, 'boxes').blocks[0].rows[0].page, 'box/one');
  const bp = page(env, { path: 'box/one' });
  valid('a box', bp);
  const houses = section(bp, 'box-one').blocks.find((b) => b.type === 'panel' && /^Houses/.test(b.title ?? '')).rows;
  assert.deepEqual(houses.map((r) => [r.label, r.value, r.agent]), [["Art's body host", 'Waiting for a box', 'art']]);
  // The command and the id are a tap away, the boot key never anywhere.
  assert.match(JSON.stringify(houses[0].sheet), /body-host --piece runtime --host-key …/);
  assert.ok(!JSON.stringify(p).includes('f'.repeat(32)));
  assert.ok(!JSON.stringify(bp).includes('f'.repeat(32)));
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

test('a body host is the runtime\'s mark, never its task\'s text: an agent can\'t ask for one, and an old look-alike still shows', () => {
  const { env } = setup();
  const task = `loom-runtime body-host --piece runtime --host-key ${'e'.repeat(48)}`;
  // Asked for by an agent (or anyone but delivery): refused, so no one passes their work off as a body host.
  const r = api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'up', body: { task } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /only delivery starts one/);
  assert.equal(act(env, fx, { action: 'up', fields: { agent: 'art', task: `  ${task}` } }).ok, false);
  // A field in the body doesn't make one either.
  assert.equal(api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'up', body: { task: 'real work', kind: 'body-host' } }).status, 200);
  assert.equal(Object.values(load(env).houses).find((h) => h.task === 'real work').kind, undefined);
  // One an agent asked for before the mark (no kind): an ordinary house on the page and on Home's card, never hidden.
  const st = load(env);
  st.houses['h-77'] = { id: 'h-77', agent: 'art', box: 'one', state: 'running', created: new Date().toISOString(), started: new Date().toISOString(), updated: new Date().toISOString(), by: 'art', task };
  writeFileSync(join(env.LOOM_BOX_HOME, 'state.json'), JSON.stringify(st));
  const tab = page({ ...env, LOOM_SCOPE: 'art' }, { path: '' });
  const rows = section(tab, 'houses').blocks.find((b) => b.type === 'panel').rows;
  const row = rows.find((x) => x.act?.fields?.id === 'h-77');
  assert.ok(row, 'the look-alike shows');
  assert.notEqual(row.label, "Art's body host");
  assert.equal(JSON.stringify(tab).includes('e'.repeat(48)), false, 'its key masked all the same');
  assert.ok(manifest(env).agents.art.doing.length >= 1, 'it counts as something Art is doing');
  // A real one from before the mark (delivery asked for it, as the owner): still named as one.
  const st2 = load(env);
  st2.houses['h-78'] = { ...st2.houses['h-77'], id: 'h-78', by: 'owner' };
  writeFileSync(join(env.LOOM_BOX_HOME, 'state.json'), JSON.stringify(st2));
  const rows2 = section(page({ ...env, LOOM_SCOPE: 'art' }, { path: '' }), 'houses').blocks.find((b) => b.type === 'panel').rows;
  assert.deepEqual(['h-77', 'h-78'].map((id) => rows2.find((x) => x.act?.fields?.id === id).label === "Art's body host"), [false, true]);
  st2.houses['h-78'].state = 'stopped';
  writeFileSync(join(env.LOOM_BOX_HOME, 'state.json'), JSON.stringify(st2));
  // And the box doesn't take it for a body host either (its build checks).
  const poll = api(env, fx, { caller: { kind: 'piece', subject: 'one' }, path: 'poll', body: {} });
  assert.deepEqual(poll.body.bodyHosts, []);
  void list;
});
