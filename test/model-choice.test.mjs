import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { staticAccounts } from '../src/accounts.mjs';
import { api } from '../src/control.mjs';
import { deliver, loadConv, ownerModelChoice } from '../src/delivery.mjs';
import { resolveFor, resolveModel, setModels, setModelChoice } from '../src/models.mjs';
import { update } from '../src/state.mjs';
import { scratch } from './scratch.mjs';
import { world, fakeRunner } from './delivery-world.mjs';
const MODELS = [{ id: 'opus', harness: 'claude', family: 'anthropic' }, { id: 'gpt', harness: 'codex', family: 'openai' }];
const accounts = (codexUsage = {}) => staticAccounts({ accounts: [
  { name: 'max', provider: 'anthropic', harness: 'claude', kind: 'login', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage: {} },
  { name: 'pro', provider: 'openai', harness: 'codex', kind: 'login', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage: codexUsage },
] });
function setup() {
  const w = world();
  setModels(w.env, { list: MODELS, agent: 'art', prefer: ['opus'] });
  update(w.env, (s) => { s.agents.art = { repo: 'https://example.com/art.git' }; });
  w.codex = fakeRunner(w.log, join(w.env.HOME, 'codex'), 'codex');
  w.o.runner = (h) => h === 'codex' ? w.codex : w.runner;
  w.o.accounts = accounts();
  return w;
}
test('agent choice, per-thread override and Auto inheritance retain quota and allow-list constraints', async () => {
  const w = setup();
  setModelChoice(w.env, { agent: 'art', harness: 'codex' });
  const pick = (extra = {}) => resolveFor(w.env, { agent: 'art', venue: 'slack', accounts: w.o.accounts, ...extra });
  assert.equal((await pick()).harness, 'codex');
  const conversation = 'cv-012345abcdef';
  setModelChoice(w.env, { agent: 'art', conversation, harness: 'claude' });
  assert.equal((await pick({ conversation })).harness, 'claude');
  setModelChoice(w.env, { agent: 'art', conversation, harness: 'auto' });
  assert.equal((await pick({ conversation })).harness, 'codex');
  assert.equal((await pick({ accounts: accounts({ '5h': 1 }) })).harness, 'claude', 'quota still falls back');
  setModels(w.env, { agent: 'art', allow: ['opus'] });
  assert.throws(() => setModelChoice(w.env, { agent: 'art', harness: 'codex' }), /no allowed/);
  assert.equal((await pick()).harness, 'claude', 'old preference cannot widen a later restriction');
});
test('changing a thread choice affects its next turn and resumes its saved session when selected again', async () => {
  const w = setup();
  const r = await deliver(w.env, w.msg('choice', 'first'), w.o);
  const original = loadConv(w.env, r.conversation).body;
  assert.match(original, /^claude:/);
  ownerModelChoice(w.env, { kind: 'owner' }, { conversation: r.conversation, harness: 'codex' });
  assert.equal(loadConv(w.env, r.conversation).body, original, 'current turn is never interrupted');
  w.runner.finish(original);
  await deliver(w.env, w.msg('choice', 'second'), w.o);
  let c = loadConv(w.env, r.conversation);
  assert.match(c.body, /^codex:/);
  assert.equal(c.home.harness, 'claude');
  assert.match(w.log.filter((x) => x[0] === 'start').at(-1)[2], /owner selected Codex/);
  w.codex.finish(c.body);
  ownerModelChoice(w.env, { kind: 'owner' }, { conversation: r.conversation, harness: 'claude' });
  await deliver(w.env, w.msg('choice', 'third'), w.o);
  c = loadConv(w.env, r.conversation);
  assert.match(c.body, /^claude:/);
  assert.equal(w.log.filter((x) => x[0] === 'resume').at(-1)[2], `s-${original.split(':')[1]}`);
  assert.match(w.log.filter((x) => x[0] === 'resume').at(-1)[4], /owner selected Claude/);
  assert.doesNotMatch(w.log.filter((x) => x[0] === 'resume').at(-1)[4], /because this harness.s account was out of quota/);
});
test('the API enforces actual conversation ownership and rejects body or cross-agent mutation', async () => {
  const w = setup();
  const r = await deliver(w.env, w.msg('choice-auth', 'first'), w.o);
  const body = { conversation: r.conversation, harness: 'codex' };
  const call = (caller, data = body) => api(w.env, {}, { caller, path: 'model-choice', body: data });
  assert.equal((await call({ kind: 'agent', agent: 'art' })).status, 403);
  assert.equal((await call({ kind: 'owner', agents: ['mark'] })).status, 403);
  assert.equal((await call({ kind: 'owner' }, { ...body, agent: 'mark' })).status, 403);
  assert.equal((await call({ kind: 'owner' }, { ...body, conversation: 'cv-999999999999' })).status, 404);
  assert.equal((await call({ kind: 'owner', agents: ['art'] })).body.effective, 'codex');
  assert.equal((await call({ kind: 'owner' }, { conversation: r.conversation })).body.effective, 'codex');
});
test('the agent-window form renders a choice and applies it for that owner only', async () => {
  const w = setup();
  const { page, act } = await import('../src/ui.mjs');
  const env = { ...w.env, LOOM_SCOPE: 'art' };
  const view = page(env, { path: '', caller: { kind: 'owner', agents: ['art'] } });
  const form = view.sections.find((s) => s.id === 'model').blocks[0];
  assert.equal(form.action, 'model-choice');
  assert.deepEqual(form.fields[0].options.map((o) => o.value), ['auto', 'claude', 'codex']);
  assert.equal(act(env, {}, { action: 'model-choice', fields: { agent: 'art', harness: 'codex' }, caller: { kind: 'owner', agents: ['art'] } }).ok, true);
  assert.equal(act(env, {}, { action: 'model-choice', fields: { agent: 'mark', harness: 'claude' }, caller: { kind: 'owner', agents: ['art'] } }).ok, false);
});

test('an explicit harness choice is not demoted across harnesses, including resume metadata', () => {
  const scorecards = MODELS.map((m) => ({ day: '2026-11-01', model: m.id, kind: 'live', measure: 'graded', value: m.harness === 'claude' ? 5 : 1, n: 10 }));
  const q = { agent: 'art', kind: 'live', models: MODELS, accounts: accounts().list(), scorecards, harnessChoice: 'codex' };
  assert.equal(resolveModel(q).harness, 'codex');
  const resumed = resolveModel({ ...q, models: [MODELS[1]], all: MODELS });
  assert.deepEqual(resumed.preferred, { model: 'gpt', harness: 'codex' });
  assert.equal(resumed.fallback, undefined);
});
