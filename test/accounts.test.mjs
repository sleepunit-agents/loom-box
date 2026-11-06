// Model accounts (docs/model-accounts.md): each box signs itself in with the harness CLI's own login, reports its
// state with the CLI's own status command, and reads how full its account is from the harness's own run output.
// The runtime never reads, refreshes, copies or issues a credential, and never calls a provider's API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
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

test('Codex\'s usage, from a house\'s own session rollouts (its CODEX_HOME)', () => {
  const env = { HOME: scratch('rt-cx-'), LOOM_BOX_DATA: '' };
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  const now = Date.parse('2026-11-02T18:40:00Z');
  const root = join(env.HOME, '.codex', 'sessions');
  assert.equal(codexUsageOnBox(env, { now, root }), null);
  assert.equal(codexUsageOnBox(env, { now }), null, 'no root: the box has no sessions of its own');
  const day = join(root, '2026', '11', '02');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-old.jsonl'), `${CODEX_EVENT.replace('12.5', '99.0')}\n`);
  utimesSync(join(day, 'rollout-old.jsonl'), new Date(now - 60_000), new Date(now - 60_000));
  writeFileSync(join(day, 'rollout-new.jsonl'), `{"type":"session_meta"}\n${CODEX_EVENT}\n`);
  const got = codexUsageOnBox(env, { now, root });
  assert.equal(got.windows['7d'], 0.125);
  assert.equal(typeof got.checked, 'number');
});

test('a rollout is read only if it\'s a regular file, never through a symlink, and only its last 256 KB', async () => {
  const { symlinkSync } = await import('node:fs');
  const { TAIL_BYTES, tailOf } = await import('../src/logins.mjs');
  const env = { HOME: scratch('rt-cx2-') };
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  const now = Date.parse('2026-11-02T18:40:00Z');
  const root = join(env.HOME, '.codex', 'sessions');
  const day = join(root, '2026', '11', '02');
  mkdirSync(day, { recursive: true });
  // A symlink a house left, pointing at something of the box's: not followed.
  const outside = join(env.HOME, 'box-secret.jsonl');
  writeFileSync(outside, `${CODEX_EVENT}\n`);
  symlinkSync(outside, join(day, 'rollout-link.jsonl'));
  assert.equal(codexUsageOnBox(env, { now, root }), null);
  assert.equal(tailOf(join(day, 'rollout-link.jsonl')), null);
  // A huge file: only its end is read, and its reading (at the end) is still found.
  const big = join(day, 'rollout-big.jsonl');
  writeFileSync(big, `${'{"type":"x","pad":"'.padEnd(1000, 'p')}"}\n`.repeat(3000) + `${CODEX_EVENT}\n`);
  const tail = tailOf(big);
  assert.ok(Buffer.byteLength(tail) <= TAIL_BYTES);
  assert.equal(codexUsageOnBox(env, { now, root }).windows['7d'], 0.125);
  // A directory named like a rollout isn't read.
  mkdirSync(join(day, 'rollout-dir.jsonl'));
  assert.equal(tailOf(join(day, 'rollout-dir.jsonl')), null);
});

test('the box never runs a CLI in the shared login dir: a planted config.toml with a notify command never runs, during status or login', async () => {
  const env = fakeBox('codex');
  const shared = loginDir(env, 'codex');
  const ran = join(env.HOME, 'notify-ran');
  writeFileSync(join(shared, 'config.toml'), `notify = "touch ${ran}"\n`);
  // The fake CLI runs its home's notify, as Codex does: the box's own home has none.
  harnessStatus(env);
  const said = [];
  startLogin(env, 'codex', { say: (x) => said.push(x), every: 100 });
  await waitFor(() => said.find((x) => x.state !== 'waiting'));
  harnessStatus(env);
  const { existsSync: ex } = await import('node:fs');
  assert.equal(ex(ran), false, 'the planted notify never ran on the box');
  assert.equal(said.at(-1).state, 'done');
  // The login landed in the shared dir as the credential file; the planted config is cut away before a mount.
  const { pruneLoginDir } = await import('../src/logins.mjs');
  assert.equal(pruneLoginDir(shared, 'codex'), null);
  assert.deepEqual(readdirSync(shared), ['auth.json']);
});

test('a credential file in the shared dir is never opened by loom: a symlinked one is refused, and the box reports that login unhealthy', async () => {
  const { symlinkSync, chmodSync: ch, rmSync } = await import('node:fs');
  const { checkLoginDir, credentialState } = await import('../src/logins.mjs');
  const env = fakeBox('codex');
  const shared = loginDir(env, 'codex');
  assert.equal(credentialState(env, 'codex'), 'absent');
  writeFileSync(join(shared, 'auth.json'), '{"a":1}');
  assert.equal(credentialState(env, 'codex'), null);
  // A symlinked auth.json (to something of the box's): refused, never followed.
  const outside = join(env.HOME, 'box-file.json');
  writeFileSync(outside, '{"box":1}');
  rmSync(join(shared, 'auth.json'));
  symlinkSync(outside, join(shared, 'auth.json'));
  assert.equal(credentialState(env, 'codex'), 'auth.json is a symlink');
  const st = harnessStatus(env).codex;
  assert.deepEqual([st.loggedIn, st.unhealthy], [false, 'auth.json is a symlink']);
  assert.throws(() => startLogin(env, 'codex', { say: () => {} }), /isn't safe to use: auth\.json is a symlink/);
  // checkLoginDir still refuses a setuid file among the allowlisted names.
  rmSync(join(shared, 'auth.json'));
  writeFileSync(join(shared, 'auth.json'), '{}');
  writeFileSync(join(shared, 'auth.json.lock'), '');
  ch(join(shared, 'auth.json.lock'), 0o4755);
  assert.match(checkLoginDir(shared), /auth\.json\.lock has a setuid or setgid bit/);
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

// A box whose container runtime is the fake podman, emulating the throwaway CLI container with the fake CLIs as the
// image's (only `only`'s, when it's named: the other isn't installed in the image).
function fakeBox(only) {
  const env = { ...process.env, HOME: scratch('rt-login-'), FAKE_LOGIN_DEVICE_MS: '300', LOOM_RUNTIME_LOGIN_IMAGE: 'fake:clis' };
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  const bin = join(env.HOME, 'bin'), cli = join(env.HOME, 'clis');
  mkdirSync(join(bin, 'podman-state'), { recursive: true });
  mkdirSync(cli);
  copyFileSync(join(here, 'fake-podman.mjs'), join(bin, 'podman'));
  chmodSync(join(bin, 'podman'), 0o755);
  for (const h of ['claude', 'codex']) {
    if (only && only !== h) continue;
    // The provider unreachable (FAKE_LOGIN_OFFLINE) while clis/offline exists: a container sees only the env it's given.
    writeFileSync(join(cli, h), `#!/bin/sh\n[ -e "${join(cli, 'offline')}" ] && export FAKE_LOGIN_OFFLINE=1\nFAKE_LOGIN_AS=${h} FAKE_LOGIN_DEVICE_MS=300 exec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(join(cli, h), 0o755);
  }
  writeFileSync(join(bin, 'podman-state', 'config.json'), JSON.stringify({ cliBin: cli }));
  env.LOOM_BOX_PODMAN = join(bin, 'podman');
  return env;
}
const waitFor = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return f(); };

test('logging a box in to Claude runs the CLI\'s own login there: its link to the owner, the pasted code to its stdin, and it writes its own login', async () => {
  const env = fakeBox('claude');
  const st = () => harnessStatus(env);
  // Each run is a throwaway container: the shared dir its only mount, no network for a status.
  const { cliRunArgs } = await import('../src/logins.mjs');
  const a = cliRunArgs(env, 'claude', 'status', 'img');
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '-v'), [`${loginDir(env, 'claude')}:/run/loom/login/claude:rw,nosuid,nodev,noexec`]);
  assert.deepEqual([a.includes('--rm'), a[a.indexOf('--network') + 1], a.includes('--cap-drop'), a.includes('-t')], [true, 'none', true, false]);
  const b = cliRunArgs(env, 'claude', 'login', 'img');
  assert.deepEqual([b.includes('--network'), b.includes('-t'), b.filter((x, i) => b[i - 1] === '-v').length], [false, true, 1]);
  // Who the login is: the provider asked (network), still the one mount, no terminal.
  const c = cliRunArgs(env, 'claude', 'identify', 'img');
  assert.deepEqual([c.includes('--network'), c.includes('-t'), c.filter((x, i) => c[i - 1] === '-v').length, c.at(-1).includes('claude mcp list')], [false, false, 1, true]);
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
  // The CLI wrote its login straight into the shared dir (its secure-storage dir); the status now says so.
  assert.deepEqual(readdirSync(loginDir(env, 'claude')), ['.credentials.json']);
  assert.equal(st().claude.loggedIn, true);
  assert.match(st().claude.account, /^claude-[0-9a-f]{10}$/);
});

test('logging a box in to Codex: the device link and code to the owner, and it finishes by itself', async () => {
  const env = fakeBox('codex');
  const said = [];
  startLogin(env, 'codex', { say: (x) => said.push(x), every: 100 });
  const done = await waitFor(() => said.find((x) => x.state !== 'waiting'));
  assert.deepEqual(said[0], { state: 'waiting', link: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH1' });
  assert.deepEqual(done, { state: 'done' });
  // Its new auth file was renamed into the shared dir, inside the container.
  const { lstatSync: ls } = await import('node:fs');
  assert.deepEqual(readdirSync(loginDir(env, 'codex')), ['auth.json']);
  assert.equal(ls(join(loginDir(env, 'codex'), 'auth.json')).isFile(), true);
  assert.deepEqual(harnessStatus(env).codex, { installed: true, loggedIn: true, method: 'chatgpt', plan: 'pro', account: accountKey('codex', 'acct-1', 'owner@example.com') });
});

// t-1913: box `one` logged in to the same Claude Max and Codex Pro as loom's machine, and the accounts list showed
// each twice ("Codex" and "Codex Pro"), one copy unread: neither CLI's offline status names the account, so each
// box's login was an account of its own.
test('two boxes signed in to one account are one account, though neither CLI\'s offline status names it', () => {
  const boxes = ['loom', 'one'].map(() => {
    const env = fakeBox();
    writeFileSync(join(loginDir(env, 'claude'), '.credentials.json'), '{"fake":true}', { mode: 0o600 });
    writeFileSync(join(loginDir(env, 'codex'), 'auth.json'), '{"fake":true}', { mode: 0o600 });
    return harnessStatus(env, { force: true });
  });
  for (const h of ['claude', 'codex']) {
    assert.match(boxes[0][h].account ?? '', new RegExp(`^${h}-[0-9a-f]{10}$`), `${h}: the box names the account`);
    assert.equal(boxes[0][h].account, boxes[1][h].account, `${h}: both boxes name the same one`);
  }
  assert.equal(boxes[1].codex.plan, 'pro', 'Codex\'s plan, from its own word, not only from a usage reading');
  assert.equal(JSON.stringify(boxes).includes('example.com'), false, 'the email never leaves the box');
  // The control plane's view: one Claude Max and one Codex Pro, on both boxes; a reading on either is the account's.
  const nowMs = Date.parse('2026-11-06T19:00:00Z');
  const seen = '2026-11-06T18:59:00Z';
  const s = { agents: { art: { secrets: {} } }, accountSalt: 'salt', boxes: {
    loom: { local: true, mayHost: '*', harnesses: boxes[0], usage: { codex: { house: { windows: { '7d': 0 }, resets: { '7d': 1794408630 }, checked: 1793987469, plan: 'pro' } } } },
    one: { mayHost: '*', lastSeen: seen, harnesses: { ...boxes[1], codex: { ...boxes[1].codex, plan: undefined } } },
  } };
  const l = deriveAccounts(s, { nowMs });
  assert.deepEqual(l.accounts.map((a) => [a.label, a.boxes]), [['Claude Max (owner\'s)', ['loom', 'one']], ['Codex Pro (owner\'s)', ['loom', 'one']]]);
  assert.deepEqual(usageOf(l, nowMs).map((u) => u.windows), [{}, { '7d': 0 }]);
});

test('one account on two boxes has one quota: the newest reading of each window, whichever box or house took it', () => {
  const nowMs = Date.parse('2026-11-06T19:00:00Z');
  const nowS = nowMs / 1000;
  const seen = '2026-11-06T18:59:00Z';
  const hs = { claude: { installed: true, loggedIn: true, plan: 'max', account: 'claude-aaaaaaaaaa' } };
  const two = (loomUsage, oneUsage) => deriveAccounts({ agents: { art: { secrets: {} } }, accountSalt: 'salt', boxes: {
    loom: { local: true, mayHost: '*', harnesses: hs, ...(loomUsage ? { usage: { claude: loomUsage } } : {}) },
    one: { mayHost: '*', lastSeen: seen, harnesses: hs, ...(oneUsage ? { usage: { claude: oneUsage } } : {}) },
  } }, { nowMs }).accounts;
  const out = { windows: { '7d': 0.99 }, resets: { '7d': nowS + 3 * 86400 }, checked: nowS - 3600 };
  // An unread copy can't make a known-full account look roomy.
  let a = two({ house: out }, null);
  assert.equal(a.length, 1);
  assert.equal(hasRoom(a[0], undefined, nowMs), false, 'out of room, though box one has read nothing');
  a = two(null, { house: out });
  assert.equal(hasRoom(a[0], undefined, nowMs), false, 'whichever box holds the reading');
  // A box's own reading doesn't outrank a newer house reading of the same account: the newest is the account's now.
  a = two({ box: { windows: { '7d': 0.2 }, checked: nowS - 86400 } }, { house: out });
  assert.deepEqual([a[0].usage['7d'], hasRoom(a[0], undefined, nowMs)], [0.99, false]);
  // A newer reading after the window reset is the truth: the full one is history.
  a = two({ house: out }, { house: { windows: { '7d': 0.05 }, resets: { '7d': nowS + 7 * 86400 }, checked: nowS - 60 } });
  assert.deepEqual([a[0].usage['7d'], hasRoom(a[0], undefined, nowMs)], [0.05, true]);
  // A full reading whose reset has passed has room again, with nothing newer to say otherwise.
  a = two({ house: { ...out, resets: { '7d': nowS - 60 }, checked: nowS - 7 * 86400 } }, null);
  assert.equal(hasRoom(a[0], undefined, nowMs), true);
});

test('a box whose identity check can\'t reach the provider keeps the account it last named, and an unnamed login stays its own', () => {
  const env = fakeBox();
  writeFileSync(join(loginDir(env, 'claude'), '.credentials.json'), '{"fake":true}', { mode: 0o600 });
  writeFileSync(join(loginDir(env, 'codex'), 'auth.json'), '{"fake":true}', { mode: 0o600 });
  const offline = (on) => (on ? writeFileSync(join(env.HOME, 'clis', 'offline'), '') : rmSync(join(env.HOME, 'clis', 'offline')));
  offline(true);
  const off = harnessStatus(env, { force: true });
  assert.deepEqual([off.claude.loggedIn, off.claude.account, off.codex.loggedIn, off.codex.account], [true, undefined, true, undefined]);
  offline(false);
  const named = harnessStatus(env, { force: true });
  assert.match(named.claude.account, /^claude-/);
  // The provider unreachable again: the name it gave holds (a status check doesn't ask again every time either).
  offline(true);
  assert.equal(harnessStatus(env, { force: true }).claude.account, named.claude.account);
  // Logged out: forgotten.
  rmSync(join(loginDir(env, 'claude'), '.credentials.json'));
  assert.deepEqual(harnessStatus(env).claude, { installed: true, loggedIn: false });
});

test('a house gets the box\'s login for each harness it runs, and the env that points its CLI there; nothing else', async () => {
  const base = { build: { containerfile: 'house/Containerfile', context: 'house' } };
  const house = parseHouseFile(JSON.stringify({ ...base, harnesses: ['claude', 'codex'] }));
  const args = runArgs(house, { id: 'h-1', agent: 'art', loomUrl: 'http://x', task: 't', image: 'img', dirs: { logins: { claude: '/data/logins/claude', codex: '/data/logins/codex' } } });
  const joined = args.join(' ');
  assert.match(joined, new RegExp(`-v /data/logins/claude:${LOGIN_MOUNT}/claude:rw,nosuid,nodev,noexec -e CLAUDE_SECURESTORAGE_CONFIG_DIR=${LOGIN_MOUNT}/claude`));
  assert.match(joined, new RegExp(`-v /data/logins/codex:${LOGIN_MOUNT}/codex:rw,nosuid,nodev,noexec -e LOOM_LOGIN_CODEX=${LOGIN_MOUNT}/codex`));
  // A box that isn't logged in to one can't start it.
  assert.throws(() => runArgs(house, { id: 'h-1', agent: 'art', loomUrl: 'http://x', task: 't', image: 'img', dirs: { logins: { claude: '/d' } } }), /isn't logged in to Codex/);
  assert.throws(() => parseHouseFile(JSON.stringify({ ...base, harnesses: ['gemini'] })), /isn't a harness the box logs in/);
  assert.throws(() => parseHouseFile(JSON.stringify({ ...base, harnesses: ['codex'], env: { LOOM_LOGIN_CODEX: '/x' } })), /LOOM_LOGIN_CODEX is set by the codex login/);
  // The house keeps its own CODEX_HOME (its config carries its own loom token): the login isn't it.
  assert.equal(joined.includes('CODEX_HOME='), false);
  // Least privilege: a service that runs only Claude gets no Codex login, though the box has one.
  const svc = parseHouseFile(JSON.stringify({ ...base, services: { bridge: { harnesses: ['claude'] } } }));
  const { specFor } = await import('../src/house.mjs');
  const only = runArgs(specFor(svc, 'bridge'), { id: 'h-2', agent: 'art', loomUrl: 'http://x', service: 'bridge', image: 'img', dirs: { logins: { claude: '/data/logins/claude', codex: '/data/logins/codex' } } }).join(' ');
  assert.equal(only.includes('/run/loom/login/claude'), true);
  assert.equal(only.includes('/run/loom/login/codex'), false);
  assert.equal(only.includes('LOOM_LOGIN_CODEX'), false);
  // The old key is refused, not ignored.
  assert.throws(() => parseHouseFile(JSON.stringify({ ...base, logins: ['claude'] })), /unknown key: logins/);
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
      // loren's box reports the same account as jonathan's: it can't merge into his.
      lorens: { mayHost: '*', owner: 'loren', lastSeen: fresh, harnesses: { claude: { installed: true, loggedIn: true, plan: 'pro', account: 'claude-aaaaaaaaaa' } } },
    },
    accountSalt: 'household-salt',
  };
  s.agents['pond-bot'] = { secrets: {} };
  const members = [{ person: 'jonathan', agents: '*' }, { person: 'loren', agents: ['pond-bot'] }];
  const l = deriveAccounts(s, { members, nowMs });
  // One account for jonathan's two boxes on the same login; loren's apart; a box not seen lately (gone) offers
  // nothing; a revoked one or one not logged in neither.
  const rows = (xs) => xs.map((x) => JSON.stringify(x)).sort();
  assert.deepEqual(rows(l.accounts.map((a) => [a.kind, a.harness, a.boxes, a.label, a.agents])), rows([
    ['login', 'claude', ['loom', 'rig'], 'Claude Max (jonathan\'s)', ['art', 'mark']],
    ['login', 'codex', ['loom'], 'Codex (jonathan\'s)', ['art', 'mark']],
    ['login', 'claude', ['lorens'], 'Claude Pro (loren\'s)', []],
    ['api-key', 'codex', [], 'Openai API key (mark)', ['mark']],
  ]));
  const by = (box, h) => l.accounts.find((a) => a.boxes.includes(box) && a.harness === h);
  assert.deepEqual([by('loom', 'claude').boxes, by('loom', 'claude').agents], [['loom', 'rig'], ['art', 'mark']]);
  assert.deepEqual([by('lorens', 'claude').boxes, by('lorens', 'claude').agents], [['lorens'], []], 'pond-bot\'s login grant is off by default');
  assert.equal(l.accounts.some((a) => a.boxes.includes('gone') || a.boxes.includes('out') || a.boxes.includes('off')), false);
  assert.match(by('loom', 'claude').name, /^jonathan:claude-[0-9a-f]{10}$/);
  assert.match(by('lorens', 'claude').name, /^loren:claude-[0-9a-f]{10}$/);
  assert.equal(JSON.stringify(l).includes('aaaaaaaaaa'), false, 'the box-reported hash doesn\'t show');
  // A different household salt gives a different key: the hash means nothing elsewhere.
  assert.notEqual(deriveAccounts({ ...s, accountSalt: 'other' }, { members, nowMs }).accounts.find((a) => a.boxes.includes('loom')).name, by('loom', 'claude').name);
  // The newest reading per window, across the account's boxes.
  assert.deepEqual(by('loom', 'claude').usage, { '7d': 0.6, '5h': 0.1, checked: 200 });
  assert.equal(l.accounts.find((a) => a.kind === 'api-key').agents.join(), 'mark');
  assert.deepEqual(usageOf(l).find((u) => u.account === by('loom', 'claude').name).windows, { '7d': 0.6, '5h': 0.1 });
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
    for (const m of markers) {
      // logins.mjs names the two credential files, to move them unread between the box's CLI home and the shared dir.
      if (f === 'logins.mjs' && (String(m) === String(/\.credentials\.json/) || String(m) === String(/auth\.json/))) continue;
      // grader.mjs names the provider hosts its egress proxy lets a grader's CLI reach (a CONNECT tunnel it never
      // reads into); it calls none of them itself. Its egress test pins that only CONNECT to those hosts passes.
      if (f === 'grader.mjs' && (String(m) === String(/api\.anthropic\.com/) || String(m) === String(/api\.openai\.com/))) {
        assert.equal(text.match(/api\.(anthropic|openai)\.com/g).length, 2, 'grader.mjs names each provider host once, in EGRESS');
        assert.equal(/fetch\(|https?\.request|https?:\/\/api\./.test(text), false, 'grader.mjs makes no request of its own');
        continue;
      }
      assert.equal(m.test(text), false, `${f} matches ${m}`);
    }
  }
});

// Real podman: what the box's own CLI run can reach is only what's mounted, so a symlink a house plants resolves in
// the throwaway container, never on the box. Skipped where podman can't run a container (or build the tiny image).
const realPodman = spawnSync('podman', ['info', '--format', '{{.Host.Security.Rootless}}'], { encoding: 'utf-8', timeout: 20_000 }).status === 0
  && spawnSync('sh', ['-c', 'command -v script'], { stdio: 'ignore' }).status === 0;

test('in a real container: a planted symlink to a box file is never read or written by the box\'s own status or login', { skip: !realPodman && 'no podman here' }, async (t) => {
  const { spawnSync: s } = await import('node:child_process');
  const { statSync, symlinkSync, rmSync } = await import('node:fs');
  const { cliStatus } = await import('../src/logins.mjs');
  const ctx = scratch('rt-img-');
  // The tiny image's CLIs: they read and write their credential file, as the real ones do.
  writeFileSync(join(ctx, 'claude'), `#!/bin/sh
f="$CLAUDE_SECURESTORAGE_CONFIG_DIR/.credentials.json"
case "$*" in
  "auth status --json") cat "$f" >/dev/null 2>&1 && ok=true || ok=false; echo refreshed >> "$f" 2>/dev/null; echo "{\\"loggedIn\\": $ok, \\"authMethod\\": \\"claude.ai\\"}";;
  "auth login --claudeai") echo "https://claude.com/cai/oauth/authorize?code=true&state=s1"; printf 'Paste code here if prompted > '; read c; echo '{"new":1}' > "$f"; cat "$f" >/dev/null; exit 0;;
esac
`);
  writeFileSync(join(ctx, 'Containerfile'), 'FROM docker.io/library/alpine:3.20\nCOPY claude /usr/local/bin/claude\nRUN chmod 755 /usr/local/bin/claude\n');
  const tag = 'localhost/loom-runtime-test-cli:1';
  const b = s('podman', ['build', '-q', '-t', tag, ctx], { encoding: 'utf-8', timeout: 300_000 });
  if (b.status !== 0) { t.skip(`couldn't build the test image: ${(b.stderr || '').trim().split('\n').pop()}`); return; }
  const env = { ...process.env, LOOM_BOX_DATA: join(ctx, 'data'), LOOM_RUNTIME_LOGIN_IMAGE: tag };
  const sentinel = join(ctx, 'box-secret');
  writeFileSync(sentinel, 'the box\'s own file\n');
  const before = statSync(sentinel);
  const shared = loginDir(env, 'claude');
  // A house swapped the credential file for a link to the box's file, after the box's lstat (so the CLI runs on it).
  symlinkSync(sentinel, join(shared, '.credentials.json'));
  const st = cliStatus(env, 'claude', tag);
  assert.equal(st.loggedIn, false, 'the link pointed at nothing inside the container');
  // A login whose credential file becomes that link while it waits: its write lands in the container, not the box.
  rmSync(join(shared, '.credentials.json'));
  const said = [];
  const l = startLogin(env, 'claude', { say: (x) => said.push(x), status: () => ({ loggedIn: false }), every: 100 });
  await waitFor(() => said.find((x) => x.state === 'waiting'), 60_000);
  symlinkSync(sentinel, join(shared, '.credentials.json'));
  l.code('good-code#s1');
  await waitFor(() => said.find((x) => x.state !== 'waiting'), 60_000);
  const after = statSync(sentinel);
  assert.equal(readFileSync(sentinel, 'utf-8'), 'the box\'s own file\n');
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
  // The control: with no link, the same login's write lands in the shared dir (so the code got there, and it wrote).
  rmSync(join(shared, '.credentials.json'));
  const said2 = [];
  const l2 = startLogin(env, 'claude', { say: (x) => said2.push(x), status: () => ({ loggedIn: false }), every: 100 });
  await waitFor(() => said2.find((x) => x.state === 'waiting'), 60_000);
  l2.code('good-code#s1');
  await waitFor(() => said2.find((x) => x.state !== 'waiting'), 60_000);
  assert.equal(readFileSync(join(shared, '.credentials.json'), 'utf-8').trim(), '{"new":1}');
  s('podman', ['rmi', '-f', tag], { stdio: 'ignore' });
});
