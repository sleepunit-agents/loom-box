// The accounts seam (loom docs/specs/agent-runtime.md, section 2; src/accounts.mjs): the runtime holds the model
// accounts through a provider interface, and this public package carries no provider's sign-in code. The
// household's own accounts code plugs in as a command; a house's `sub:<provider>` secret is issued through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountsError, accountsFor, accountsFrom, checkList, commandAccounts, hasRoom, noAccounts, staticAccounts } from '../src/accounts.mjs';
import { realEffects } from '../src/effects.mjs';
import { api } from '../src/control.mjs';
import { load } from '../src/state.mjs';
import { scratch } from './scratch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-accounts.mjs');

function provider(cfg) {
  const f = join(scratch('rt-acct-'), 'accounts.json');
  writeFileSync(f, JSON.stringify(cfg));
  const env = { ...process.env, FAKE_ACCOUNTS: f, LOOM_RUNTIME_ACCOUNTS: JSON.stringify([process.execPath, FAKE]) };
  return { env, log: () => readFileSync(`${f}.log`, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) };
}

const LIST = {
  v: 1,
  accounts: [
    { name: 'home-max', provider: 'anthropic', label: 'Home Max', plan: 'Max', owner: 'jonathan',
      credentials: [{ kind: 'long-lived', status: 'valid', where: { secret: 'claude-home-max' }, value: 'sk-must-not-pass' }, { kind: 'session', status: 'expired' }],
      usage: { '5h': 0.2, '7d': 0.5, '7d_opus': 0.98, reset_7d: 1793900000, checked: 1793800000, note: 'dropped' } },
    { name: 'home-pro', provider: 'openai', credentials: [{ kind: 'device', status: 'valid' }], usage: {} },
    { name: 'BAD NAME', provider: 'anthropic', credentials: [] },
    { name: 'other', provider: 'meta', credentials: [] },
  ],
  assign: { art: ['home-max', 'nope'], 'Bad Agent': ['home-max'] },
};

test('a command provider lists the household\'s accounts: names and states only, whatever else it hands over', () => {
  const p = provider({ list: LIST });
  const a = accountsFrom(p.env);
  assert.equal(a.kind, 'command');
  const l = a.list();
  assert.deepEqual(l.accounts.map((x) => x.name), ['home-max', 'home-pro']);
  assert.deepEqual(l.accounts[0].credentials, [{ kind: 'long-lived', status: 'valid' }, { kind: 'session', status: 'expired' }]);
  assert.equal(JSON.stringify(l).includes('sk-must-not-pass'), false);
  assert.equal(JSON.stringify(l).includes('claude-home-max'), false);
  assert.deepEqual(l.accounts[0].usage, { '5h': 0.2, '7d': 0.5, '7d_opus': 0.98, reset_7d: 1793900000, checked: 1793800000 });
  assert.deepEqual(l.assign, { art: ['home-max', 'nope'] });
  assert.deepEqual(p.log(), [['accounts', '--json']]);
  // Usage, from the list: each account's windows, resets, and room.
  assert.deepEqual(a.usage()[0], { account: 'home-max', provider: 'anthropic', windows: { '5h': 0.2, '7d': 0.5, '7d_opus': 0.98 }, resets: { '7d': 1793900000 }, checked: 1793800000, room: true });
  // Room: the general windows, and a model's own.
  assert.equal(hasRoom(l.accounts[0]), true);
  assert.equal(hasRoom(l.accounts[0], '7d_opus'), false);
  assert.deepEqual(accountsFor(l, 'art', 'anthropic').map((x) => x.name), ['home-max']);
  assert.deepEqual(accountsFor(l, 'mark', 'openai').map((x) => x.name), ['home-pro']);
});

test('a command provider issues a house\'s credential: the value on a pipe, which account and credential on stderr', () => {
  const p = provider({ list: LIST, issue: { 'art/anthropic': { account: 'home-max', name: 'claude-home-max', value: 'sk-ant-oat-1' }, 'art/anthropic/session': { account: 'home-max', name: 'claude-session', value: '{"claudeAiOauth":{}}' } } });
  const a = accountsFrom(p.env);
  assert.deepEqual(a.issue('art', 'anthropic'), { account: 'home-max', name: 'claude-home-max', value: 'sk-ant-oat-1' });
  assert.equal(a.issue('art', 'anthropic', 'session').name, 'claude-session');
  assert.throws(() => a.issue('mark', 'openai'), (e) => e instanceof AccountsError && /issuing mark's openai credential: subscriptions: can't issue openai for mark/.test(e.message));
  assert.deepEqual(p.log(), [['issue', 'art', 'anthropic'], ['issue', 'art', 'anthropic', '--kind', 'session'], ['issue', 'mark', 'openai']]);
});

test('a house\'s sub:<provider> secret is issued through the runtime\'s provider, at claim', () => {
  const p = provider({ list: LIST, issue: { 'art/anthropic': { account: 'home-max', name: 'claude-home-max', value: 'sk-ant-oat-1' } } });
  const env = { HOME: scratch('rt-claim-'), LOOM_BOX_LOCAL_NAME: 'one', ...{ FAKE_ACCOUNTS: p.env.FAKE_ACCOUNTS, LOOM_RUNTIME_ACCOUNTS: p.env.LOOM_RUNTIME_ACCOUNTS } };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  const real = realEffects(env);
  const fx = { now: () => new Date(), mint: () => `loom_${'t'.repeat(30)}`, revoke: () => {}, secret: (n) => `value-of-${n}`, issue: real.issue };
  const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  ok(api(env, fx, { caller: { kind: 'owner' }, path: 'set-agent', body: { agent: 'art', repo: 'https://x/art.git', secrets: { 'claude-oauth': 'sub:anthropic' } } }));
  const h = ok(api(env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'up', body: { task: 'x' } }));
  const c = ok(api(env, fx, { caller: { kind: 'piece', subject: 'one' }, path: 'claim', body: { id: h.id } }));
  assert.equal(c.secrets['claude-oauth'], 'sk-ant-oat-1');
  // The house records which credential it runs on, by name.
  assert.deepEqual(load(env).houses[h.id].runsOn, { 'claude-oauth': 'claude-home-max' });
  assert.deepEqual(p.log().at(-1), ['issue', 'art', 'anthropic']);
});

test('which provider: the setting\'s argv, `none`, or by default `loom subscriptions` (what box called before)', () => {
  assert.deepEqual(accountsFrom({}).argv, ['loom', 'subscriptions']);
  assert.deepEqual(accountsFrom({ LOOM_BOX_LOOM: '/opt/loom' }).argv, ['/opt/loom', 'subscriptions']);
  assert.deepEqual(accountsFrom({ LOOM_RUNTIME_ACCOUNTS: '["loom-accounts", "--household"]' }).argv, ['loom-accounts', '--household']);
  assert.equal(accountsFrom({ LOOM_RUNTIME_ACCOUNTS: 'none' }), noAccounts);
  assert.throws(() => accountsFrom({ LOOM_RUNTIME_ACCOUNTS: 'loom subscriptions' }), /an argv as JSON/);
  assert.throws(() => commandAccounts([]), /an argv/);
  assert.deepEqual(noAccounts.list(), { accounts: [], assign: {} });
  assert.throws(() => noAccounts.issue('art', 'anthropic'), /no accounts provider is set/);
  // A provider that isn't there fails as a provider, not a crash.
  assert.throws(() => accountsFrom({ LOOM_RUNTIME_ACCOUNTS: '["/nonexistent/accounts"]' }).list(), AccountsError);
  // An in-process one (a test's, or a piece handing its accounts over).
  const s = staticAccounts(LIST, () => ({ account: 'home-max', name: 'n', value: 'v' }));
  assert.equal(s.list().accounts.length, 2);
  assert.equal(s.issue().value, 'v');
  assert.deepEqual(checkList(null), { accounts: [], assign: {} });
});

test('the public package has no provider sign-in code: no OAuth token exchange, refresh or client of anyone\'s', () => {
  // The household's accounts code signs in as a harness's own client. That stays private; this package only talks to
  // a provider. A line like these in src/ would mean sign-in code moved in.
  const src = join(here, '..', 'src');
  const markers = [/oauth\/token/i, /refresh_token|refreshToken/, /client_id|CLIENT_ID/, /claudeAiOauth/, /anthropic-beta/i, /setup-token/, /grant_type/];
  for (const f of readdirSync(src)) {
    const text = readFileSync(join(src, f), 'utf-8');
    for (const m of markers) assert.equal(m.test(text), false, `${f} matches ${m}`);
  }
});
