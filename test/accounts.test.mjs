// Model accounts (docs/model-accounts.md): each box signs itself in with the harness CLI's own login, reports its
// state with the CLI's own status command, and reads how full its account is from the harness's own run output.
// The runtime never reads, refreshes, copies or issues a credential, and never calls a provider's API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountsFrom, deriveAccounts, hasRoom, noAccounts, usageOf } from '../src/accounts.mjs';
import { LOGIN_MOUNT, accountKey, claudeRateLimit, codexRateLimit, codexUsageOnBox, harnessStatus, lastRateLimit, loginDir, parseClaudeStatus, parseCodexStatus, startLogin } from '../src/logins.mjs';
import { parseHouseFile, runArgs } from '../src/house.mjs';
import { scratch } from './scratch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-login.mjs');

// Recorded from real runs on loom's machine, 2026-11-02 (Claude Code 2.1.316; codex-cli 0.162.1).
const CLAUDE_EVENT = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793660400,"rateLimitType":"seven_day","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"unifiedWindows":{"seven_day":{"utilization":0.63,"resetsAt":1793660400,"status":"allowed"}}},"uuid":"6c0290b1-bb22-4e2b-97ca-63bc7303da38","session_id":"eac51e09-aa9f-45b6-9e38-31090d0f5c78"}';
const CODEX_EVENT = '{"timestamp":"2026-11-02T18:33:20.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":12.5,"window_minutes":10080,"resets_at":1793779679},"secondary":{"used_percent":40.0,"window_minutes":300,"resets_at":1793710000},"credits":{"has_credits":true,"unlimited":false,"balance":"62500.0000000000"},"individual_limit":null,"spend_control_reached":null,"plan_type":"pro","rate_limit_reached_type":null}}}';

test('usage, from the harness\'s own run output: Claude Code\'s rate_limit_event and Codex\'s token_count', () => {
  assert.deepEqual(claudeRateLimit(JSON.parse(CLAUDE_EVENT)), { windows: { '7d': 0.63 }, resets: { '7d': 1793660400 } });
  // A rejected window with no reading of its own is full.
  assert.deepEqual(claudeRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1793600000 } }),
    { windows: { '5h': 1 }, resets: { '5h': 1793600000 }, limited: true });
  assert.equal(claudeRateLimit({ type: 'assistant' }), null);
  assert.deepEqual(codexRateLimit(JSON.parse(CODEX_EVENT)), { windows: { '7d': 0.125, '5h': 0.4 }, resets: { '7d': 1793779679, '5h': 1793710000 }, plan: 'pro' });
  assert.equal(codexRateLimit({ type: 'event_msg', payload: { type: 'agent_message' } }), null);
  // The last reading in a stream wins; lines that aren't JSON are skipped.
  const stream = ['{"type":"system","subtype":"init"}', 'not json, rate', CLAUDE_EVENT, '{"type":"result","subtype":"success"}'].join('\n');
  assert.deepEqual(lastRateLimit('claude', stream).windows, { '7d': 0.63 });
  assert.equal(lastRateLimit('codex', stream), null);
});

test('a box reads Codex\'s usage from the rollouts its houses leave in its own login dir', () => {
  const env = { HOME: scratch('rt-cx-'), LOOM_BOX_DATA: '' };
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  const now = Date.parse('2026-11-02T18:40:00Z');
  assert.equal(codexUsageOnBox(env, { now }), null);
  const day = join(loginDir(env, 'codex'), 'sessions', '2026', '11', '02');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-old.jsonl'), `${CODEX_EVENT.replace('12.5', '99.0')}\n`);
  utimesSync(join(day, 'rollout-old.jsonl'), new Date(now - 60_000), new Date(now - 60_000));
  writeFileSync(join(day, 'rollout-new.jsonl'), `{"type":"session_meta"}\n${CODEX_EVENT}\n`);
  const got = codexUsageOnBox(env, { now });
  assert.equal(got.windows['7d'], 0.125);
  assert.equal(typeof got.checked, 'number');
});

test('a box\'s login state is the CLI\'s own status: states and a hash, never the email', () => {
  const s = parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com', orgId: 'org-1', subscriptionType: 'max' }));
  assert.deepEqual(s, { loggedIn: true, method: 'claude.ai', plan: 'max', account: accountKey('claude', 'org-1', 'owner@example.com') });
  assert.match(s.account, /^claude-[0-9a-f]{10}$/);
  assert.equal(JSON.stringify(s).includes('example.com'), false);
  assert.deepEqual(parseClaudeStatus('{"loggedIn":false}'), { loggedIn: false });
  assert.equal(parseClaudeStatus('nope').loggedIn, false);
  assert.deepEqual(parseCodexStatus('Logged in using ChatGPT\n', 0), { loggedIn: true, method: 'chatgpt' });
  assert.deepEqual(parseCodexStatus('Not logged in\n', 1), { loggedIn: false });
});

function fakeBox(as) {
  const env = { ...process.env, HOME: scratch('rt-login-'), FAKE_LOGIN_AS: as, FAKE_LOGIN_DEVICE_MS: '300' };
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  env[`LOOM_RUNTIME_${as.toUpperCase()}`] = FAKE;
  return env;
}
const waitFor = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return f(); };

test('logging a box in to Claude runs the CLI\'s own login there: its link to the owner, the pasted code to its stdin, and it writes its own login', async () => {
  const env = fakeBox('claude');
  const st = () => harnessStatus({ ...env, LOOM_RUNTIME_CODEX: '/nonexistent/codex' });
  assert.deepEqual(st().claude, { installed: true, loggedIn: false });
  assert.deepEqual(st().codex, { installed: false, loggedIn: false });
  const said = [];
  const l = startLogin(env, 'claude', { say: (x) => said.push(x), status: () => st().claude, every: 100 });
  const waiting = await waitFor(() => said.find((x) => x.state === 'waiting'));
  assert.deepEqual(waiting, { state: 'waiting', link: 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=s1' });
  assert.equal(l.code('bad'), false);
  assert.equal(l.code('good-code#s1'), true);
  const done = await waitFor(() => said.find((x) => x.state !== 'waiting'));
  assert.deepEqual(done, { state: 'done' });
  // The CLI wrote its login into the box's own login dir; the status now says so.
  assert.deepEqual(readdirSync(loginDir(env, 'claude')).includes('logged-in'), true);
  assert.equal(st().claude.loggedIn, true);
  assert.match(st().claude.account, /^claude-[0-9a-f]{10}$/);
});

test('logging a box in to Codex: the device link and code to the owner, and it finishes by itself', async () => {
  const env = fakeBox('codex');
  const said = [];
  startLogin(env, 'codex', { say: (x) => said.push(x), status: () => harnessStatus(env).codex, every: 100 });
  const done = await waitFor(() => said.find((x) => x.state !== 'waiting'));
  assert.deepEqual(said[0], { state: 'waiting', link: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH1' });
  assert.deepEqual(done, { state: 'done' });
  assert.deepEqual(harnessStatus(env).codex, { installed: true, loggedIn: true, method: 'chatgpt' });
});

test('a house that asks for the box\'s logins gets the box\'s login dir, and the env that points its CLI there; nothing else', () => {
  const base = { build: { containerfile: 'house/Containerfile', context: 'house' } };
  const house = parseHouseFile(JSON.stringify({ ...base, logins: ['claude', 'codex'] }));
  const args = runArgs(house, { id: 'h-1', agent: 'art', loomUrl: 'http://x', task: 't', image: 'img', dirs: { logins: { claude: '/data/logins/claude', codex: '/data/logins/codex' } } });
  const joined = args.join(' ');
  assert.match(joined, new RegExp(`-v /data/logins/claude:${LOGIN_MOUNT}/claude -e CLAUDE_SECURESTORAGE_CONFIG_DIR=${LOGIN_MOUNT}/claude`));
  assert.match(joined, new RegExp(`-v /data/logins/codex:${LOGIN_MOUNT}/codex -e CODEX_HOME=${LOGIN_MOUNT}/codex`));
  // A box that isn't logged in to one can't start it.
  assert.throws(() => runArgs(house, { id: 'h-1', agent: 'art', loomUrl: 'http://x', task: 't', image: 'img', dirs: { logins: { claude: '/d' } } }), /isn't logged in to Codex/);
  assert.throws(() => parseHouseFile(JSON.stringify({ ...base, logins: ['gemini'] })), /isn't a harness the box logs in/);
  assert.throws(() => parseHouseFile(JSON.stringify({ ...base, logins: ['codex'], env: { CODEX_HOME: '/x' } })), /CODEX_HOME is set by the codex login/);
  // Without logins, no login dir goes in.
  assert.equal(runArgs(parseHouseFile(JSON.stringify(base)), { id: 'h-1', agent: 'art', loomUrl: 'http://x', task: 't', image: 'img', dirs: {} }).join(' ').includes(LOGIN_MOUNT), false);
});

test('the accounts are a view of the boxes\' reports: one account per signed-in account, its boxes sharing its quota', () => {
  const nowMs = Date.parse('2026-11-02T12:00:00Z');
  const fresh = '2026-11-02T11:59:00Z';
  const s = {
    agents: { art: { secrets: {} }, mark: { secrets: { 'openai-api-key': 'mark-openai' } } },
    boxes: {
      loom: { local: true, mayHost: '*', harnesses: { claude: { installed: true, loggedIn: true, plan: 'max', account: 'claude-aaaaaaaaaa' }, codex: { installed: true, loggedIn: true, method: 'chatgpt' } },
        usage: { claude: { windows: { '7d': 0.5 }, resets: { '7d': 1 }, checked: 100 } } },
      rig: { mayHost: '*', lastSeen: fresh, harnesses: { claude: { installed: true, loggedIn: true, plan: 'max', account: 'claude-aaaaaaaaaa' } },
        usage: { claude: { windows: { '7d': 0.6, '5h': 0.1 }, checked: 200 } } },
      gone: { mayHost: '*', lastSeen: '2026-11-01T00:00:00Z', harnesses: { claude: { installed: true, loggedIn: true, account: 'claude-bbbbbbbbbb' } } },
      out: { mayHost: '*', revoked: '2026-10-01T00:00:00Z', harnesses: { claude: { installed: true, loggedIn: true, account: 'claude-cccccccccc' } } },
      off: { mayHost: '*', lastSeen: fresh, harnesses: { claude: { installed: true, loggedIn: false } } },
    },
  };
  const l = deriveAccounts(s, { members: [{ person: 'jonathan', agents: '*' }], nowMs });
  assert.deepEqual(l.accounts.map((a) => [a.name, a.kind, a.boxes, a.credentials[0].status]), [
    ['claude-aaaaaaaaaa', 'login', ['loom', 'rig'], 'valid'],
    ['claude-bbbbbbbbbb', 'login', ['gone'], 'unknown'],
    ['codex-box-loom', 'login', ['loom'], 'valid'],
    ['openai-api-key-mark', 'api-key', [], 'unknown'],
  ]);
  // The newest reading per window, across the account's boxes.
  assert.deepEqual(l.accounts[0].usage, { '7d': 0.6, '5h': 0.1, checked: 200 });
  assert.equal(l.accounts[3].agents.join(), 'mark');
  assert.deepEqual(usageOf(l)[0].windows, { '7d': 0.6, '5h': 0.1 });
  assert.equal(hasRoom({ usage: { '7d': 0.98 } }), false);
  assert.equal(hasRoom({ usage: { '7d': 0.2, '7d_opus': 0.99 } }), true);
  assert.equal(hasRoom({ usage: { '7d': 0.2, '7d_opus': 0.99 } }, '7d_opus'), false);
  // The setting: the boxes' reports, or none. There's no command to plug in any more.
  assert.equal(accountsFrom({ LOOM_RUNTIME_ACCOUNTS: 'none' }), noAccounts);
  assert.equal(accountsFrom({}).kind, 'boxes');
  assert.throws(() => accountsFrom({ LOOM_RUNTIME_ACCOUNTS: '["loom", "subscriptions"]' }), /unset .* or none/);
  // Off the control plane there are no reports: it says so (and the resolver fails open).
  assert.throws(() => accountsFrom({ HOME: scratch('rt-none-') }).list(), /no box reports here/);
});

test('the runtime holds no credential: no token endpoint, refresh, client id, provider API call or credentials file in src/', () => {
  // A line like these in src/ would mean loom had started handling a login itself instead of the harness CLI.
  const src = join(here, '..', 'src');
  const markers = [/oauth\/token/i, /refresh_token|refreshToken/, /client_id|CLIENT_ID/, /claudeAiOauth/, /anthropic-beta/i, /setup-token/, /grant_type/,
    /\.credentials\.json/, /auth\.json/, /api\.anthropic\.com/, /api\.openai\.com/, /oauth\/usage/, /CLAUDE_CODE_OAUTH_TOKEN=/, /x-app/i, /claude-cli/];
  for (const f of readdirSync(src)) {
    const text = readFileSync(join(src, f), 'utf-8');
    for (const m of markers) assert.equal(m.test(text), false, `${f} matches ${m}`);
  }
});
