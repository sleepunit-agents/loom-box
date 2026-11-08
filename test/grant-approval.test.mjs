// A Yes on a permission ask applies it (t-1970): an agent asks for a piece with a `grant` approval, and loom core, right
// after the household owner's Allow, posts `grant-approved` here as the owner. The runtime spends the approval (allowed,
// for exactly that target) and only then adds the agent to the piece's grant, everyone else's kept. Deny never reaches
// here; a member, an agent's tab, or no caller at all is refused; and each agent's page says what it can use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { act, page, grantTarget } from '../src/ui.mjs';
import { memStore } from '../src/store.mjs';
import { GRANTS, KEY, addGrant, decide, usableBy } from '../src/grants.mjs';
import { scratch } from './scratch.mjs';

const dist = process.env.LOOM_DIST || join(homedir(), 'Code', 'loom', 'dist');
const vocab = existsSync(join(dist, 'ui', 'vocab.js')) ? await import(join(dist, 'ui', 'vocab.js')) : null;
const valid = (what, p) => { if (vocab) { const v = vocab.parsePage(p); assert.notEqual(typeof v, 'string', `${what}: ${v}`); } };
const fx = { now: () => new Date(), mint: () => 'loom_' + 'x'.repeat(30), revoke: () => {}, secret: () => 's' };
const OWNER = { kind: 'owner', who: 'jonathan-barket', agents: '*' };

/** A household (art, mark), its grants, and a fake approvals piece: `allowed` is what it would let be spent. */
function setup({ doc = { v: 1, pieces: { tasks: { art: ['*'] }, clock: { '*': ['*'] }, secrets: { art: ['*'] } }, relay: {} }, allowed = {} } = {}) {
  const env = { HOME: scratch('loom-box-ga-'), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  env.LOOM_HOME = join(env.HOME, 'loom');
  mkdirSync(env.LOOM_HOME, { recursive: true });
  writeFileSync(join(env.LOOM_HOME, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'] }));
  const st = memStore();
  if (doc) st.put(GRANTS, KEY, doc);
  const spent = [];
  env.LOOM_RUNTIME_TEST_STORE = st;
  env.LOOM_RUNTIME_TEST_APPROVALS = {
    spend(aid, target, agent) {
      const a = allowed[aid];
      if (!a) return `${aid} is pending, waiting on the owner`;
      if (a.used) return `${aid} is used`;
      if (a.target !== target || a.agent !== agent) return `${aid} allows grant for ${a.target}, not grant for ${target}`;
      a.used = true;
      spent.push(aid);
      return '';
    },
  };
  return { env, st, spent };
}
const grantsOf = (st) => st.get(GRANTS, KEY)?.doc;
const approve = (env, fields, ...as) => act(env, fx, { action: 'grant-approved', fields, caller: as.length ? as[0] : OWNER });

test('an Allow applies the grant: the approval spent, the agent added, everyone else kept', () => {
  const { env, st, spent } = setup({ allowed: { 'a-0000beef': { target: 'tasks:mark', agent: 'art' } } });
  assert.deepEqual(decide(grantsOf(st), { agent: 'mark', piece: 'tasks', path: 'run' }).allow, false, 'before: Mark may not use Tasks');
  const r = approve(env, { id: 'a-0000beef', agent: 'art', target: 'tasks:mark' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.message, 'Mark may use Tasks now.');
  assert.equal(r.page, 'permissions/mark');
  assert.deepEqual(spent, ['a-0000beef']);
  assert.deepEqual(grantsOf(st).pieces.tasks, { art: ['*'], mark: ['*'] });
  assert.deepEqual(decide(grantsOf(st), { agent: 'mark', piece: 'tasks', path: 'run' }), { allow: true });
  // The rest of the household's grants are as they were.
  assert.deepEqual(grantsOf(st).pieces.secrets, { art: ['*'] });
  // Spent once: the same Allow again grants nothing more.
  assert.equal(approve(env, { id: 'a-0000beef', agent: 'art', target: 'tasks:mark' }).ok, false);
});

test('only some paths: the agent gets just those, and they add up', () => {
  const { env, st } = setup({ allowed: { 'a-00000001': { target: 'tasks:mark:run', agent: 'art' }, 'a-00000002': { target: 'tasks:mark:people/*', agent: 'art' } } });
  assert.equal(approve(env, { id: 'a-00000001', agent: 'art', target: 'tasks:mark:run' }).message, 'Mark may use Tasks for run now.');
  assert.equal(approve(env, { id: 'a-00000002', agent: 'art', target: 'tasks:mark:people/*' }).ok, true);
  assert.deepEqual(grantsOf(st).pieces.tasks.mark, ['run', 'people/*']);
  assert.equal(decide(grantsOf(st), { agent: 'mark', piece: 'tasks', path: 'secrets' }).allow, false);
});

test('a Deny (or an ask not yet answered) grants nothing: there is no allowed approval to spend', () => {
  const { env, st, spent } = setup();
  const before = JSON.stringify(grantsOf(st));
  const r = approve(env, { id: 'a-0000beef', agent: 'art', target: 'tasks:mark' });
  assert.equal(r.ok, false);
  assert.match(r.message, /Not granted/);
  assert.deepEqual(spent, []);
  assert.equal(JSON.stringify(grantsOf(st)), before);
});

test('only the household owner\'s call applies it: a member, an agent, no caller, an agent\'s tab are refused, nothing spent', () => {
  const allowed = { 'a-0000beef': { target: 'tasks:mark', agent: 'art' } };
  const { env, st, spent } = setup({ allowed });
  const before = JSON.stringify(grantsOf(st));
  for (const caller of [{ kind: 'owner', who: 'loren', agents: ['art'] }, { kind: 'agent', agent: 'art' }, undefined, { kind: 'piece' }]) {
    const r = approve(env, { id: 'a-0000beef', agent: 'art', target: 'tasks:mark' }, caller);
    assert.equal(r.ok, false, JSON.stringify(caller) ?? 'no caller');
  }
  const tab = { ...env, LOOM_SCOPE: 'art' };
  assert.equal(approve(tab, { id: 'a-0000beef', agent: 'art', target: 'tasks:mark' }).ok, false);
  assert.deepEqual(spent, []);
  assert.equal(JSON.stringify(grantsOf(st)), before);
  assert.equal(allowed['a-0000beef'].used, undefined, 'the owner\'s yes is still there to apply');
});

test('the approval decides the target: one allowed for tasks:mark can\'t be spent for secrets:mark', () => {
  const { env, st } = setup({ allowed: { 'a-0000beef': { target: 'tasks:mark', agent: 'art' } } });
  const r = approve(env, { id: 'a-0000beef', agent: 'art', target: 'secrets:mark' });
  assert.equal(r.ok, false);
  assert.deepEqual(grantsOf(st).pieces.secrets, { art: ['*'] });
});

test('nothing spent for what the runtime would refuse: a stranger, bad paths, a bad id', () => {
  const allowed = { 'a-0000beef': { target: 'tasks:zed', agent: 'art' }, 'a-0000cafe': { target: 'tasks:mark:a/../b', agent: 'art' } };
  const { env, spent } = setup({ allowed });
  assert.match(approve(env, { id: 'a-0000beef', agent: 'art', target: 'tasks:zed' }).message, /No agent zed/);
  assert.equal(approve(env, { id: 'a-0000cafe', agent: 'art', target: 'tasks:mark:a/../b' }).ok, false);
  assert.equal(approve(env, { id: 'nope', agent: 'art', target: 'tasks:mark' }).ok, false);
  assert.deepEqual(spent, []);
});

test('no grants yet: nothing written, nothing spent, and it says the piece\'s own list decides (a document would take every other piece away)', () => {
  const { env, st, spent } = setup({ doc: null, allowed: { 'a-0000beef': { target: 'tasks:mark', agent: 'art' } } });
  const r = approve(env, { id: 'a-0000beef', agent: 'art', target: 'tasks:mark' });
  assert.equal(r.ok, false);
  assert.match(r.message, /no grants yet, so Tasks decides by its own agent list/);
  assert.equal(st.get(GRANTS, KEY), null);
  assert.deepEqual(spent, []);
});

test('already granted (every agent, or this one): says so and changes nothing', () => {
  const { st } = setup();
  assert.deepEqual(addGrant(st, { piece: 'clock', agent: 'mark' }), { changed: false, why: 'mark may already use clock' });
  assert.equal(addGrant(st, { piece: 'tasks', agent: 'art', paths: ['run'] }).changed, false);
  assert.equal(addGrant(st, { piece: 'newpiece', agent: 'mark' }).changed, true);
  assert.deepEqual(grantsOf(st).pieces.newpiece, { mark: ['*'] });
});

test('grantTarget reads what approvals files', () => {
  assert.deepEqual(grantTarget('tasks:mark'), { piece: 'tasks', agent: 'mark', paths: ['*'] });
  assert.deepEqual(grantTarget('tasks:mark:run,people/*'), { piece: 'tasks', agent: 'mark', paths: ['run', 'people/*'] });
  for (const bad of ['tasks', 'Tasks:mark', '', 'tasks:mark:', 'tasks:mark:a b']) assert.equal(grantTarget(bad), null, bad);
});

test('Permissions says, per agent, which pieces it can use, in plain words; each agent has its own page', () => {
  const { env, st } = setup();
  const p = page(env, { path: 'permissions' });
  valid('permissions', p);
  const rows = p.sections.find((s) => s.id === 'agents').blocks[0].rows;
  assert.deepEqual(rows.map((r) => [r.label, r.value, r.page]), [['What Art can use', '3 pieces', 'permissions/art'], ['What Mark can use', '1 piece', 'permissions/mark']]);
  const m = page(env, { path: 'permissions/mark' });
  valid('permissions/mark', m);
  assert.equal(m.title, 'What Mark can use');
  assert.deepEqual(m.sections.find((s) => s.id === 'can').blocks[0].rows.map((r) => [r.label, r.value]), [['Clock', 'All of it']]);
  assert.deepEqual(m.sections.find((s) => s.id === 'cannot').blocks[0].rows.map((r) => r.label), ['Secrets', 'Tasks']);
  addGrant(st, { piece: 'tasks', agent: 'mark', paths: ['run'] });
  const m2 = page(env, { path: 'permissions/mark' });
  assert.deepEqual(m2.sections.find((s) => s.id === 'can').blocks[0].rows.map((r) => [r.label, r.value]), [['Clock', 'All of it'], ['Tasks', 'Only run']]);
  assert.equal(page(env, { path: 'permissions/zed' }).title, 'Not found');
  // A member who owns some agents doesn't get the household's permissions.
  assert.equal(page(env, { path: 'permissions/mark', caller: { kind: 'owner', who: 'loren', agents: ['mark'] } }).title, 'Not found');
  assert.deepEqual(usableBy(null, 'mark'), null);
});

test('an Allow for what the agent already has says so in names, and spends the approval', () => {
  const { env, spent } = setup({ allowed: { 'a-0000beef': { target: 'clock:mark', agent: 'art' } } });
  const r = approve(env, { id: 'a-0000beef', agent: 'art', target: 'clock:mark' });
  assert.deepEqual([r.ok, r.message], [true, 'Mark may use Clock already.']);
  assert.deepEqual(spent, ['a-0000beef']);
});
