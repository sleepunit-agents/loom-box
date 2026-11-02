// Model choice (loom docs/specs/agent-runtime.md, section 4, and "What the tests must pin" 4):
//  - given two models of which one has no quota left, the resolver picks the other;
//  - given two models with quota, and a scorecard giving one a `graded` value at least 1.0 lower for a venue kind,
//    the resolver picks the higher one for that kind. Venue kinds are conversations.md's: live, scheduled, agent.
// And the precedence around them: hard limits, then the agent's preference, then scorecards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { staticAccounts } from '../src/accounts.mjs';
import { DEFAULT_MODELS, MIN_GRADED, checkModels, fetchScorecards, gradedOf, readModels, resolveFor, resolveModel, setModels, venueKind } from '../src/models.mjs';
import { scratch } from './scratch.mjs';

const A = { id: 'model-a', harness: 'claude', family: 'anthropic' };
const B = { id: 'model-b', harness: 'codex', family: 'openai' };
const acct = (name, provider, usage = {}) => ({ name, provider, credentials: [{ kind: 'long-lived', status: 'valid' }], usage });
const both = (ua = {}, ub = {}) => ({ accounts: [acct('home-max', 'anthropic', ua), acct('home-pro', 'openai', ub)], assign: {} });
const row = (model, kind, value, n = 10, day = '2026-11-01') => ({ day, model, family: model === 'model-a' ? 'anthropic' : 'openai', harness: 'x', kind, measure: 'graded', value, n, same_family: false });
const pick = (o) => resolveModel({ agent: 'art', kind: 'live', models: [A, B], settings: { prefer: ['model-a'] }, accounts: both(), ...o });

test('obligation 4: of two models, one with no quota left, the resolver picks the other', () => {
  // model-a is preferred, but its account's 7-day window is full.
  const r = pick({ accounts: both({ '7d': 0.99 }, { '7d': 0.1 }) });
  assert.equal(r.model, 'model-b');
  assert.match(r.why.join('\n'), /model-a: home-max out of quota/);
  // And the other way round.
  assert.equal(pick({ settings: { prefer: ['model-b'] }, accounts: both({}, { '5h': 1 }) }).model, 'model-a');
});

test('obligation 4: of two models with quota, a scorecard 1.0 lower for a venue kind demotes it for that kind only', () => {
  const scorecards = [row('model-a', 'live', 2.9), row('model-b', 'live', 4.0), row('model-a', 'scheduled', 4.5), row('model-b', 'scheduled', 4.0)];
  for (const kind of ['live', 'scheduled', 'agent']) {
    const r = pick({ kind, scorecards });
    // live: a is 1.1 lower, so b. scheduled: a is higher, it stays. agent: no rows, no demotion.
    assert.equal(r.model, kind === 'live' ? 'model-b' : 'model-a', kind);
  }
  assert.match(pick({ scorecards }).why.join('\n'), /model-a demoted for live: graded 2\.90, model-b 4\.00/);
  // Under 1.0 apart is no demotion.
  assert.equal(pick({ scorecards: [row('model-a', 'live', 3.1), row('model-b', 'live', 4.0)] }).model, 'model-a');
  // Exactly 1.0 is "at least 1.0".
  assert.equal(pick({ scorecards: [row('model-a', 'live', 3.0), row('model-b', 'live', 4.0)] }).model, 'model-b');
});

test('hard limits come first: a model with no quota is never picked for its scorecard, nor one the agent may not use', () => {
  const scorecards = [row('model-a', 'live', 1.0), row('model-b', 'live', 5.0)];
  // b is far better graded, but has no quota: a stays.
  assert.equal(pick({ scorecards, accounts: both({}, { '7d': 0.98 }) }).model, 'model-a');
  // b is far better graded, but art may only use a.
  assert.equal(pick({ scorecards, settings: { allow: ['model-a'], prefer: ['model-a'] } }).model, 'model-a');
  // Nothing left: it says why, and picks nothing.
  assert.throws(() => pick({ accounts: both({ '7d': 1 }, { '7d': 1 }) }), (e) => e.status === 409 && /no model is left for art/.test(e.message));
  assert.throws(() => pick({ settings: { allow: [] , prefer: [] }, models: [] }), /none of the runtime's models/);
});

test('the preference: this body\'s, then the agent\'s, then the list\'s order', () => {
  assert.equal(pick({}).model, 'model-a');
  assert.equal(pick({ prefer: ['model-b'] }).model, 'model-b');
  assert.equal(pick({ settings: {} }).model, 'model-a');
  assert.equal(pick({ settings: {}, models: [B, A] }).model, 'model-b');
});

test('quota is per agent and per model: its own accounts, in its order, and a model-scoped window', () => {
  const accounts = { accounts: [acct('home-max', 'anthropic', { '7d': 0.99 }), acct('work-max', 'anthropic', { '7d': 0.2, '7d_opus': 0.99 })], assign: { art: ['home-max'], mark: ['work-max'] } };
  const opus = { id: 'opus', harness: 'claude', family: 'anthropic', window: '7d_opus' };
  const sonnet = { id: 'sonnet', harness: 'claude', family: 'anthropic' };
  const r = (agent) => resolveModel({ agent, kind: 'live', models: [opus, sonnet], accounts });
  // art runs on home-max only, which is full: nothing.
  assert.throws(() => r('art'), /no model is left for art/);
  // mark's work-max has room, but not in opus's own window: sonnet, on work-max.
  assert.deepEqual([r('mark').model, r('mark').account], ['sonnet', 'work-max']);
  // An expired login is no room at all.
  const expired = { accounts: [{ ...acct('x', 'anthropic'), credentials: [{ kind: 'long-lived', status: 'expired' }] }], assign: {} };
  assert.throws(() => resolveModel({ agent: 'art', kind: 'live', models: [sonnet], accounts: expired }), /no model is left/);
});

test('a local model needs no account; unreadable accounts fail open, and say so', () => {
  const local = { id: 'qwen-coder', harness: 'codex', family: 'local:wunder' };
  assert.equal(resolveModel({ agent: 'art', kind: 'live', models: [A, local], accounts: { accounts: [], assign: {} } }).model, 'qwen-coder');
  const r = resolveModel({ agent: 'art', kind: 'live', models: [A], accounts: null });
  assert.equal(r.model, 'model-a');
  assert.match(r.why.join('\n'), /quota not checked: no account list/);
});

test('a scorecard counts only with enough graded samples in the window, weighted by n', () => {
  const rows = [row('m', 'live', 5, 2), row('m', 'live', 2, 2), row('m', 'live', 1, 1, '2026-09-01'), { ...row('m', 'live', 1), measure: 'first_reply_s' }];
  assert.equal(gradedOf(rows, 'm', 'live', { since: '2026-10-19' }), undefined, `${MIN_GRADED} samples needed`);
  assert.equal(gradedOf([...rows, row('m', 'live', 2, 1)], 'm', 'live', { since: '2026-10-19' }), (10 + 4 + 2) / 5);
  // A thin card can't demote.
  assert.equal(pick({ scorecards: [row('model-a', 'live', 1, 1), row('model-b', 'live', 5)] }).model, 'model-a');
});

test('the model list is checked: a family is one of the fixed set, a harness one the runtime runs', () => {
  assert.deepEqual(checkModels([{ id: 'x', harness: 'codex', family: 'local:wunder', extra: 1 }]), [{ id: 'x', harness: 'codex', family: 'local:wunder' }]);
  for (const family of ['anthropic', 'openai', 'google', 'mistral', 'local:5090-box']) assert.equal(checkModels([{ id: 'x', harness: 'claude', family }])[0].family, family);
  for (const family of ['Anthropic', 'meta', 'local:', 'local:UP', undefined]) assert.throws(() => checkModels([{ id: 'x', harness: 'claude', family }]), /family is/);
  assert.throws(() => checkModels([{ id: 'x', harness: 'gemini-cli', family: 'google' }]), /harness is one of claude, codex/);
  assert.throws(() => checkModels([A, A]), /listed twice/);
  assert.throws(() => checkModels([]), /1 to 32/);
});

test('the owner sets the list and each agent\'s settings; dropping a model drops it from every agent', () => {
  const env = { HOME: scratch('rt-models-'), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  assert.deepEqual(readModels(env).list, DEFAULT_MODELS);
  setModels(env, { list: [A, B], agent: 'art', prefer: ['model-b', 'model-a'], allow: ['model-a', 'model-b'] });
  assert.deepEqual(readModels(env).agents.art, { prefer: ['model-b', 'model-a'], allow: ['model-a', 'model-b'] });
  assert.throws(() => setModels(env, { agent: 'art', prefer: ['nope'] }), /isn't in the model list/);
  setModels(env, { list: [A] });
  assert.deepEqual(readModels(env).agents.art, { prefer: ['model-a'], allow: ['model-a'] });
});

test('a venue\'s kind: core\'s and the adapters\' are known; another must be told', () => {
  assert.deepEqual(['wake', 'relay', 'session', 'discord', 'slack'].map((v) => venueKind(v)), ['scheduled', 'agent', 'live', 'live', 'live']);
  assert.equal(venueKind('matrix', 'live'), 'live');
  assert.throws(() => venueKind('matrix'), /--venue-kind/);
  assert.throws(() => venueKind('wake', 'later'), /a venue kind is/);
});

test('scorecards come from loom\'s GET /api/loom/scorecards (or a stub file); anything unreadable is none, never a failure', async () => {
  const home = scratch('rt-cards-');
  const tok = join(home, 'tok'); writeFileSync(tok, 'loom_runtime_token\n');
  const env = { LOOM_RUNTIME_LOOM_URL: 'http://loom.test/mcp', LOOM_RUNTIME_TOKEN_FILE: tok };
  let asked;
  const answer = (status, body) => async (url, init) => { asked = { url, auth: init.headers.authorization }; return { ok: status === 200, status, json: async () => body }; };
  const got = await fetchScorecards(env, { kind: 'live', since: '2026-10-19', fetchImpl: answer(200, { rows: [row('model-a', 'live', 4)] }) });
  assert.deepEqual(got, { rows: [row('model-a', 'live', 4)] });
  assert.deepEqual(asked, { url: 'http://loom.test/api/loom/scorecards?kind=live&since=2026-10-19', auth: 'Bearer loom_runtime_token' });
  assert.deepEqual((await fetchScorecards(env, { fetchImpl: answer(200, [row('model-a', 'live', 4)]) })).rows.length, 1);
  // Not built yet (t-1742), or down: no rows, and why.
  assert.deepEqual(await fetchScorecards(env, { fetchImpl: answer(404, {}) }), { rows: [], error: 'scorecards: 404' });
  assert.match((await fetchScorecards(env, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).error, /ECONNREFUSED/);
  assert.match((await fetchScorecards({}, {})).error, /no LOOM_RUNTIME_TOKEN_FILE/);
  // A stub file.
  const f = join(home, 'cards.json'); writeFileSync(f, JSON.stringify({ rows: [row('model-b', 'live', 3)] }));
  assert.equal((await fetchScorecards({ LOOM_RUNTIME_SCORECARDS: f })).rows[0].model, 'model-b');
});

test('resolveFor puts it together: the runtime\'s list, the agent\'s settings, the accounts provider and loom\'s scorecards', async () => {
  const env = { HOME: scratch('rt-resolve-'), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  setModels(env, { list: [A, B], agent: 'art', prefer: ['model-a'] });
  const cards = join(env.HOME, 'cards.json');
  writeFileSync(cards, JSON.stringify([row('model-a', 'scheduled', 2.0), row('model-b', 'scheduled', 4.5)]));
  const accounts = staticAccounts(both());
  const r = await resolveFor({ ...env, LOOM_RUNTIME_SCORECARDS: cards }, { agent: 'art', venue: 'wake', accounts });
  assert.deepEqual([r.model, r.harness, r.family, r.kind, r.account], ['model-b', 'codex', 'openai', 'scheduled', 'home-pro']);
  // A resume keeps its harness.
  assert.equal((await resolveFor({ ...env, LOOM_RUNTIME_SCORECARDS: cards }, { agent: 'art', venue: 'wake', harness: 'claude', accounts })).model, 'model-a');
  // A provider that can't list fails open.
  const broken = { list: () => { throw new Error('down'); } };
  assert.equal((await resolveFor({ ...env, LOOM_RUNTIME_SCORECARDS: 'off' }, { agent: 'art', venue: 'wake', accounts: broken })).model, 'model-a');
});
