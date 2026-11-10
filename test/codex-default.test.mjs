import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readModels, resolveFor, setModels, setRole } from '../src/models.mjs';
import { staticAccounts } from '../src/accounts.mjs';
import { scratch } from './scratch.mjs';
const gpt = { id: 'gpt-6.1-sol', harness: 'codex', family: 'openai' };
const opus = { id: 'opus', harness: 'claude', family: 'anthropic' };
const other = { id: 'other', harness: 'codex', family: 'openai' };
function setup() {
  const env = { HOME: scratch('default-'), LOOM_RUNTIME_SCORECARDS: 'off' };
  setModels(env, { list: [opus, other, gpt], agent: 'art', prefer: ['opus'] });
  const accounts = (full = false) => staticAccounts({ accounts: ['codex', 'claude'].map(h => ({ name: h, harness: h, provider: h === 'codex' ? 'openai' : 'anthropic', kind: 'login', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage: h === 'codex' && full ? { '5h': 1 } : {} })) });
  return { env, pick: (args = {}, full = false) => resolveFor(env, { agent: 'art', venue: 'wake', accounts: accounts(full), ...args }) };
}
test('runtime default is visible and overrides old list, agent and role ordering', async () => {
  const { env, pick } = setup();
  assert.equal(readModels(env).default, gpt.id);
  assert.equal((await pick()).model, gpt.id);
  setRole(env, { role: { id: 'coding', description: 'Code', models: ['opus', 'other', gpt.id] } });
  assert.equal((await pick({ role: 'coding' })).model, gpt.id);
  assert.equal((await pick({ prefer: ['opus'] })).harness, 'codex');
  setModels(env, { agent: 'art', default: 'other' });
  assert.equal(readModels(env).agents.art.default, 'other');
  assert.equal((await pick()).model, 'other');
});
test('Codex exhaustion cannot implicitly spend Claude; an explicit stated need permits it', async () => {
  const { pick } = setup();
  await assert.rejects(pick({}, true), /no model is left/);
  for (const modelNeed of ['authorization: review permissions', 'privacy: inspect data boundaries', 'coordinator: compare provider results']) {
    const r = await pick({ prefer: ['opus'], modelNeed });
    assert.equal(r.model, 'opus');
    assert.match(r.why.join('\n'), /stated model need/);
  }
  await assert.rejects(pick({ modelNeed: 'because I like it' }), /modelNeed/);
});
test('settings validate Codex defaults and keep the global default when changing one agent', () => {
  const { env } = setup();
  assert.throws(() => setModels(env, { default: 'opus' }), /Codex/);
  setModels(env, { agent: 'art', default: 'other' });
  assert.equal(readModels(env).default, gpt.id);
  setModels(env, { list: [gpt, opus] });
  assert.equal(readModels(env).agents.art.default, gpt.id);
});
test('resumes retain their old preference and cannot acquire the new default', async () => {
  const { env, pick } = setup();
  setModels(env, { agent: 'art', prefer: ['other'] });
  assert.equal((await pick({ harness: 'codex' })).model, 'other');
  assert.equal((await pick()).model, gpt.id);
});
test('a catalog edit cannot turn any saved default into a Claude model', () => {
  const { env } = setup();
  assert.throws(() => setModels(env, { list: [opus, other, { ...gpt, harness: 'claude', family: 'anthropic' }] }), /remain a Codex/);
  setModels(env, { agent: 'art', default: 'other' });
  assert.throws(() => setModels(env, { list: [opus, gpt, { ...other, harness: 'claude', family: 'anthropic' }] }), /remain a Codex/);
});
