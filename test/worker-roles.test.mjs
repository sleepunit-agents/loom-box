// Worker roles and job assignment (t-2036, t-2038):
//   - the roles catalog is the owner's, versioned, checked against the model list, and never widens an agent's allow;
//   - a body asks for a role when it spawns; the version it was admitted under is kept with the job;
//   - a job keeps the model it first ran on: a preference edit, a catalog edit or the preferred harness getting room
//     back never moves it; out of quota it waits, unless its spawn allowed a failover, which moves it once and keeps
//     the move as lineage, with no return home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { staticAccounts } from '../src/accounts.mjs';
import { loadConv, tick } from '../src/delivery.mjs';
import { readRoles, resolveFor, roleOf, setModelChoice, setModels, setRole } from '../src/models.mjs';
import { api } from '../src/control.mjs';
import { spawnCall } from '../src/spawn.mjs';
import { load } from '../src/state.mjs';
import { fakeRunner, world } from './delivery-world.mjs';

const OPUS = { id: 'opus', harness: 'claude', family: 'anthropic' };
const SONNET = { id: 'sonnet', harness: 'claude', family: 'anthropic' };
const SOL = { id: 'sol', harness: 'codex', family: 'openai' };
const acct = (name, provider, usage = {}) => ({ name, label: name, provider, harness: provider === 'anthropic' ? 'claude' : 'codex', kind: 'login', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage });
const owner = { kind: 'owner' };

function workers() {
  const w = world();
  setModels(w.env, { list: [OPUS, SONNET, SOL], agent: 'art', prefer: ['opus'] });
  const codex = fakeRunner(w.log, join(w.env.HOME, 'cx'), 'codex');
  const max = acct('max', 'anthropic');
  const pro = acct('pro', 'openai');
  w.o.runner = (h) => (h === 'codex' ? codex : w.runner);
  w.o.accounts = staticAccounts({ accounts: [max, pro] });
  w.o.alert = () => true;
  const spawn = (q) => spawnCall(w.env, owner, { agent: 'art', brief: 'Do the job', ...q }, w.o);
  const say = (handle, text) => spawnCall(w.env, owner, { agent: 'art', action: 'say', handle, text }, w.o);
  const runs = () => w.log.filter((l) => l[0] === 'start' || l[0] === 'resume');
  const out = (a) => { a.usage = { '7d': 0.99, reset_7d: Math.floor(w.clock.now().getTime() / 1000) + 3600 }; };
  return { ...w, codex, max, pro, spawn, say, runs, out };
}

test('the catalog is versioned, checked against the model list, logged, and dropped models leave its roles', () => {
  const w = workers();
  assert.deepEqual(readRoles(w.env).roles, []);
  assert.throws(() => setRole(w.env, { role: { id: 'coding', description: 'x', models: ['gpt-9'] } }), /gpt-9 isn't in the model list/);
  assert.throws(() => setRole(w.env, { role: { id: 'coding', description: 'x' } }), /name the models/);
  assert.throws(() => setRole(w.env, { role: { id: 'Coding', description: 'x', models: ['sol'] } }), /id is like/);
  assert.throws(() => setRole(w.env, { role: { id: 'coding', description: 'x', families: ['acme'] } }), /family/);
  let cat = setRole(w.env, { role: { id: 'coding', description: 'Write and fix code', models: ['sol', 'opus'] }, why: 'first role' });
  assert.equal(cat.version, 1);
  assert.deepEqual(cat.roles[0].eligible, ['sol', 'opus']);
  cat = setRole(w.env, { role: { id: 'light', description: 'Quick lookups', families: ['anthropic'] } });
  assert.equal(cat.version, 2);
  assert.deepEqual(cat.roles.find((r) => r.id === 'light').eligible, ['opus', 'sonnet'], 'a family is every model of it, in the list\'s order');
  assert.deepEqual(cat.log.map((l) => [l.version, l.what]), [[1, 'added coding'], [2, 'added light']]);
  assert.equal(cat.log[0].why, 'first role');
  // The owner drops sol from the list: it leaves the role, and that is a new version.
  setModels(w.env, { list: [OPUS, SONNET] });
  cat = readRoles(w.env);
  assert.equal(cat.version, 3);
  assert.deepEqual(cat.roles.find((r) => r.id === 'coding').models, ['opus']);
  cat = setRole(w.env, { remove: 'light' });
  assert.deepEqual(cat.roles.map((r) => r.id), ['coding']);
  assert.throws(() => roleOf(load(w.env), 'review'), /no role "review": the roles are coding/);
});

test('a role narrows the models and never widens what the agent may use', async () => {
  const w = workers();
  setRole(w.env, { role: { id: 'coding', description: 'Write and fix code', models: ['sol', 'opus'] } });
  const r = await resolveFor(w.env, { agent: 'art', venue: 'relay', role: 'coding', accounts: w.o.accounts });
  assert.equal(r.model, 'sol', 'the role\'s own order, ahead of the agent\'s preference');
  assert.match(r.why[0], /role coding \(catalog v1\): eligible sol, opus/);
  // The agent may use only opus: the role can't give it sol.
  setModels(w.env, { agent: 'art', allow: ['opus'] });
  assert.equal((await resolveFor(w.env, { agent: 'art', venue: 'relay', role: 'coding', accounts: w.o.accounts })).model, 'opus');
  setModels(w.env, { agent: 'art', allow: ['sonnet'] });
  await assert.rejects(resolveFor(w.env, { agent: 'art', venue: 'relay', role: 'coding', accounts: w.o.accounts }), /may use none/);
});

test('only the household owner edits the catalog; any agent reads it', async () => {
  const w = workers();
  const role = { id: 'coding', description: 'Write and fix code', models: ['sol'] };
  const asAgent = api(w.env, {}, { caller: { kind: 'agent', agent: 'art' }, path: 'roles', body: { role } });
  assert.equal((await asAgent).status, 403);
  const scoped = await api(w.env, {}, { caller: { kind: 'owner', agents: ['art'] }, path: 'roles', body: { role } });
  assert.equal(scoped.status, 403, 'an owner token scoped to some agents is not the household\'s owner');
  const ok = await api(w.env, {}, { caller: { kind: 'owner', who: 'jonathan' }, path: 'roles', body: { role, why: 'coding jobs on Sol' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.changed.by, 'jonathan');
  const read = await api(w.env, {}, { caller: { kind: 'agent', agent: 'art' }, path: 'roles', body: {} });
  assert.deepEqual(read.body.roles.map((r) => [r.id, r.eligible]), [['coding', ['sol']]]);
});

test('a spawned job records its role version and keeps its model across resumes, whatever changes', async () => {
  const w = workers();
  setRole(w.env, { role: { id: 'coding', description: 'Write and fix code', models: ['sol', 'opus'] } });
  await assert.rejects(w.spawn({ role: 'review' }), /no role "review"/);
  const r = await w.spawn({ role: 'coding' });
  let c = loadConv(w.env, r.handle);
  assert.match(c.body, /^codex:/);
  assert.deepEqual(c.spawn.role, { id: 'coding', version: 1, eligible: ['sol', 'opus'] });
  assert.equal(c.spawn.assignment.model, 'sol');
  assert.equal(c.spawn.assignment.roleVersion, 1);
  const res = await spawnCall(w.env, owner, { agent: 'art', action: 'result', handle: r.handle }, w.o);
  assert.deepEqual(res.assignment, { model: 'sol', harness: 'codex', role: 'coding' });
  // The catalog now wants opus first, the agent prefers opus, the owner picks Claude for the agent: none moves the job.
  setRole(w.env, { role: { id: 'coding', description: 'Write and fix code', models: ['opus', 'sol'] } });
  setModels(w.env, { agent: 'art', prefer: ['opus'] });
  assert.equal(setModelChoice(w.env, { agent: 'art', harness: 'claude' }).effective, 'claude');
  w.codex.finish(c.body);
  await w.say(r.handle, 'and the tests');
  c = loadConv(w.env, r.handle);
  assert.equal(w.runs().at(-1)[0], 'resume', 'its own Codex session, resumed');
  assert.match(c.body, /^codex:/);
  assert.equal(c.spawn.assignment.model, 'sol');
  assert.equal(c.spawn.role.version, 1, 'the version it was admitted under');
});

test('a worker job out of quota waits on its own model, its session kept, never moved to another harness', async () => {
  const w = workers();
  const r = await w.spawn({ prefer: 'opus' });
  let c = loadConv(w.env, r.handle);
  assert.equal(c.spawn.assignment.model, 'opus', 'an older-style spawn with no role is pinned on its first run');
  w.runner.finish(c.body);
  w.out(w.max);
  const before = w.runs().length;
  await w.say(r.handle, 'continue');
  c = loadConv(w.env, r.handle);
  assert.equal(w.runs().length, before, 'no body on Codex: the job waits for its own model');
  assert.equal(c.home, undefined, 'its slot is not parked as a home');
  assert.ok(c.slot, 'its session stays to resume');
  // The window resets: it resumes its own session on its own model.
  w.clock.advance(3601_000);
  await tick(w.env, w.o);
  await w.say(r.handle, 'continue again');
  assert.equal(w.runs().at(-1)[0], 'resume');
  assert.match(loadConv(w.env, r.handle).body, /^claude:/);
});

test('an allowed failover moves the job, keeps the move as lineage, and never returns home', async () => {
  const w = workers();
  setRole(w.env, { role: { id: 'coding', description: 'Write and fix code', models: ['opus', 'sol'] } });
  const r = await w.spawn({ role: 'coding', failover: true });
  let c = loadConv(w.env, r.handle);
  assert.equal(c.spawn.failover, true);
  assert.equal(c.spawn.assignment.model, 'opus');
  w.runner.finish(c.body);
  w.out(w.max);
  await w.say(r.handle, 'continue');
  c = loadConv(w.env, r.handle);
  assert.match(c.body, /^codex:/);
  assert.equal(w.runs().at(-1)[0], 'start', 'a fresh body: a Claude session is never resumed on Codex');
  assert.equal(c.spawn.assignment.model, 'sol');
  assert.deepEqual(c.spawn.lineage.map((l) => l.model), ['opus']);
  // Claude has room again: the job stays on Sol, resuming its Codex session.
  w.clock.advance(3601_000);
  w.codex.finish(c.body);
  await w.say(r.handle, 'and now');
  c = loadConv(w.env, r.handle);
  assert.match(c.body, /^codex:/);
  assert.equal(w.runs().at(-1)[0], 'resume');
  assert.equal(c.spawn.assignment.model, 'sol');
});

test('a body reads the roles through spawn (the MCP tool\'s action roles), with no conversation needed and no edit', async () => {
  const w = workers();
  setRole(w.env, { role: { id: 'review', description: 'Review a change', models: ['opus'], output: 'findings, most severe first' } });
  const r = await spawnCall(w.env, { kind: 'agent', agent: 'art' }, { action: 'roles', role: { id: 'x', description: 'y', models: ['sol'] } }, w.o);
  assert.deepEqual(r, { version: 1, roles: [{ id: 'review', description: 'Review a change', eligible: ['opus'], output: 'findings, most severe first' }] });
  assert.equal(readRoles(w.env).version, 1, 'reading never edits');
  await assert.rejects(spawnCall(w.env, { kind: 'stranger' }, { action: 'roles' }, w.o));
});

test('rules come before the assignment: a job pinned to Codex never runs there once its rules can\'t be kept on Codex', async () => {
  const w = workers();
  setRole(w.env, { role: { id: 'coding', description: 'Write and fix code', models: ['sol', 'opus'] } });
  const r = await w.spawn({ role: 'coding' });
  let c = loadConv(w.env, r.handle);
  assert.equal(c.spawn.assignment.model, 'sol');
  w.codex.finish(c.body);
  // Now the job's rules carry a deny list this Codex says it can't keep.
  w.codex.wontRun = () => 'Codex would read /x/.codex/config.toml too';
  w.o.policy = () => ({ deny: ['mcp__handoff'] });
  await w.say(r.handle, 'continue');
  c = loadConv(w.env, r.handle);
  assert.match(c.body, /^claude:/, 'off Codex, though pinned there');
  assert.equal(w.runs().at(-1)[0], 'start', 'a fresh body, never the Codex session resumed on Claude');
  assert.equal(c.spawn.assignment.model, 'opus');
  assert.deepEqual(c.spawn.lineage.map((l) => [l.model, l.why]), [['sol', 'its rules can\'t be kept on that harness']]);
});

test('a job whose assigned model left the list holds, its session and message kept, and resumes once the model is back', async () => {
  const w = workers();
  const r = await w.spawn({ prefer: 'sonnet' });
  let c = loadConv(w.env, r.handle);
  assert.equal(c.spawn.assignment.model, 'sonnet');
  const session = w.runner.slotOf({ id: c.body.split(':')[1] }).session;
  w.runner.finish(c.body);
  setModels(w.env, { list: [OPUS, SOL] });
  const before = w.runs().length;
  await w.say(r.handle, 'continue');
  c = loadConv(w.env, r.handle);
  assert.equal(w.runs().length, before, 'no body started on another model');
  assert.match(c.waiting, /assigned model sonnet can't run/);
  assert.ok(c.queue.some((m) => !m.note), 'its message waits');
  setModels(w.env, { list: [OPUS, SONNET, SOL] });
  await tick(w.env, w.o);
  assert.deepEqual(w.runs().at(-1).slice(0, 1).concat(w.runs().at(-1)[2]), ['resume', session], 'its own session, kept through the hold');
  assert.equal(loadConv(w.env, r.handle).spawn.assignment.model, 'sonnet');
});

test('a role whose models the agent may not use is refused at spawn', async () => {
  const w = workers();
  setRole(w.env, { role: { id: 'coding', description: 'Write and fix code', models: ['sol'] } });
  setModels(w.env, { agent: 'art', allow: ['opus', 'sonnet'] });
  await assert.rejects(w.spawn({ role: 'coding' }), /may use none of role coding's models \(sol\)/);
});

test('a job pinned to Codex whose house refuses Codex at the start moves, and is re-pinned so it stays moved', async () => {
  const w = workers();
  setRole(w.env, { role: { id: 'coding', description: 'Write and fix code', models: ['sol', 'opus'] } });
  const r = await w.spawn({ role: 'coding' });
  let c = loadConv(w.env, r.handle);
  assert.equal(c.spawn.assignment.model, 'sol');
  w.codex.finish(c.body);
  // Only the house's host can tell, at the start (runners.mjs, CODEX_WONT).
  w.codex.failResume = "codex won't run this body here: Codex would read /home/art/Art/.codex/config.toml too, a config the runtime can't replace";
  w.codex.failStart = w.codex.failResume;
  await w.say(r.handle, 'continue');
  c = loadConv(w.env, r.handle);
  assert.match(c.body ?? '', /^claude:/);
  assert.equal(c.spawn.assignment.model, 'opus', 're-pinned where it moved');
  assert.deepEqual(c.spawn.lineage.map((l) => [l.model, l.why]), [['sol', 'its rules can\'t be kept on that harness']]);
  // The next message resumes its Claude session: no Codex attempt, no fresh body.
  w.runner.finish(c.body);
  const tries = w.runs().length;
  await w.say(r.handle, 'and again');
  assert.equal(w.runs().length, tries + 1);
  assert.equal(w.runs().at(-1)[0], 'resume');
  assert.match(loadConv(w.env, r.handle).body, /^claude:/);
});
