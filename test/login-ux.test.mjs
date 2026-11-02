// Logging a box in from its page, as the owner sees it (Jonathan, 2026-11-02: "the result of I came back and gave
// you a token should spin and go hey look it worked"). End to end: the real control plane in-process, a real runner,
// the fake podman and a fake harness CLI (test/fake-login.mjs). Pinned here:
//  - the sign-in page shows progress by itself (a busy callout, and refresh while anything is pending), then flips
//    to "✓ Claude logged in (claude.ai, Max)" with no action of the owner's in between; the same for Codex's device flow;
//  - a failure says why in one line, keeps the CLI's last lines (never the code), and offers Try again;
//  - never stuck: a runner that restarted, or lost a login, fails it with the reason, and "Log in" starts a fresh one;
//    one too old is given up; a runner going down says so; a runner starting stops the sign-in containers left behind;
//  - the box's card shows each harness's state up front, and its runtime against loom's ("updating…", why an update
//    failed and when it tries again, Update now, and the one line for a box still on the old box piece).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { api } from '../src/control.mjs';
import { runner } from '../src/box.mjs';
import { harnessStatus, startLogin, sweepCliContainers, whyLoginFailed, scrubCliOutput } from '../src/logins.mjs';
import { act, page } from '../src/ui.mjs';
import { load, update } from '../src/state.mjs';
import { swapCommand } from '../src/version.mjs';
import { scratch } from './scratch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const owner = { kind: 'owner' };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const ok = (x) => { assert.equal(x.status, 200, JSON.stringify(x.body)); return x.body; };
async function until(f, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = f(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
let env, fx, client;
const call = (path, body = {}) => api(env, fx, { caller: owner, path, body });
const boxCall = (path, body = {}) => api(env, fx, { caller: { kind: 'piece', subject: 'one' }, path, body });
const loginPage = (id) => page(env, { path: `login/${id}` });
/** The sign-in section's blocks, and the callout that leads it. */
const blocksOf = (p) => p.sections[0].blocks;
const calloutOf = (p) => blocksOf(p).find((b) => b.type === 'callout');
const boxCard = () => page(env, { path: '' }).sections.find((x) => x.id === 'box-one');
const rowsOf = (card) => card.blocks.find((b) => b.type === 'list' && b.items.some((i) => i.text === 'Claude')).items;

beforeEach(() => {
  const home = scratch('loom-login-ux-');
  const bin = join(home, 'bin'), clis = join(home, 'clis');
  mkdirSync(join(bin, 'podman-state'), { recursive: true });
  mkdirSync(clis);
  copyFileSync(join(here, 'fake-podman.mjs'), join(bin, 'podman'));
  chmodSync(join(bin, 'podman'), 0o755);
  for (const h of ['claude', 'codex']) {
    writeFileSync(join(clis, h), `#!/bin/sh\nFAKE_LOGIN_AS=${h} exec "${process.execPath}" "${join(here, 'fake-login.mjs')}" "$@"\n`);
    chmodSync(join(clis, h), 0o755);
  }
  writeFileSync(join(bin, 'podman-state', 'config.json'), JSON.stringify({ cliBin: clis }));
  env = { HOME: home, PATH: process.env.PATH, LOOM_BOX_HOME: join(home, 'state'), LOOM_BOX_DATA: join(home, 'data'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_PODMAN: join(bin, 'podman'),
    XDG_RUNTIME_DIR: join(home, 'run'), LOOM_RUNTIME_LOGIN_IMAGE: 'fake:clis', FAKE_LOGIN_DEVICE_MS: '600' };
  fx = { now: () => new Date(), mint: () => 'loom_house_token_aaaaaaaaaaaaaaaa', revoke: () => {}, secret: (n) => `secret:${n}` };
  const myEnv = env, myFx = fx;
  client = { async call(path, body) { const x = api(myEnv, myFx, { caller: { kind: 'piece', subject: 'one' }, path, body }); if (x.status !== 200) throw new Error(x.body.error); return x.body; } };
  ok(call('set-agent', { agent: 'art', repo: 'https://github.com/x/art.git' }));
});

/** A runner on the fake CLIs: their status and login, through the fake podman. */
let logged = [];
const boxRunner = (o = {}) => runner(env, client, { loomUrl: 'http://loom.test/mcp', log: (m) => logged.push(m), upgrade: () => null,
  status: (agents) => harnessStatus(env, { agents }), login: (h, opt) => startLogin(env, h, { ...opt, every: 100 }), sweep: () => [], ...o });

test('Claude: the page spins through each step by itself and flips to "✓ Claude logged in (claude.ai, Max)"', async () => {
  const box = boxRunner();
  await box.tick();
  assert.deepEqual(rowsOf(boxCard()).find((i) => i.text === 'Claude').act, { action: 'login-start', label: 'Log in Claude', tone: 'primary', fields: { box: 'one', harness: 'claude' } });
  // Pressing Log in goes straight to the sign-in page, which says what's happening and reloads itself.
  const started = act(env, fx, { action: 'login-start', fields: { box: 'one', harness: 'claude' } });
  assert.match(started.page, /^login\/l-[0-9a-f]{12}$/);
  const id = started.page.slice(6);
  let p = loginPage(id);
  assert.deepEqual([calloutOf(p).busy, calloutOf(p).title, p.refresh], [true, 'Starting Claude\'s sign-in on one…', 2]);
  await box.tick();
  // The link, and the form for the code: a slow refresh, which loom holds while the field is in use.
  p = await until(() => { const x = loginPage(id); return blocksOf(x).some((b) => b.type === 'form') && x; });
  assert.equal(p.refresh, 10);
  assert.equal(blocksOf(p).find((b) => b.type === 'link' && b.href).href, 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=s1');
  // The owner pastes the code: the page says it's checking, with a spinner, and reloads every 2 seconds.
  assert.equal(act(env, fx, { action: 'login-code', fields: { id, code: 'good-code#s1' } }).message, 'Got it: the box is checking the code.');
  p = loginPage(id);
  assert.deepEqual([calloutOf(p).busy, calloutOf(p).title, p.refresh], [true, 'Checking with Anthropic…', 2]);
  // The link carries the sign-in's state and code challenge: kept only while it's waiting, and never logged.
  assert.equal(load(env).logins[id].link, undefined);
  assert.equal(JSON.stringify(p).includes('oauth/authorize'), false);
  // Nothing the owner does from here: the box's next poll takes the code, the CLI finishes, the page flips.
  await box.tick();
  p = await until(() => { const x = loginPage(id); return calloutOf(x)?.tone === 'ok' && x; });
  assert.equal(calloutOf(p).title, '✓ Claude logged in (claude.ai, Max)');
  assert.equal(calloutOf(p).busy, undefined);
  assert.equal(p.refresh, undefined, 'settled: no more reloads');
  assert.equal(JSON.stringify(p).includes('good-code'), false);
  assert.equal(logged.some((m) => /oauth|authorize|good-code/.test(m)), false, logged.join('\n'));
  // And the box's card says so up front.
  assert.deepEqual([rowsOf(boxCard()).find((i) => i.text === 'Claude').meta, rowsOf(boxCard()).find((i) => i.text === 'Claude').tone], ['✓ logged in (claude.ai, Max)', 'ok']);
});

test('Codex: the page shows the code and the link, then flips to logged in by itself once the box sees it', async () => {
  const box = boxRunner();
  await box.tick();
  const id = act(env, fx, { action: 'login-start', fields: { box: 'one', harness: 'codex' } }).page.slice(6);
  await box.tick();
  const p = await until(() => { const x = loginPage(id); return blocksOf(x).some((b) => b.type === 'code') && x; });
  assert.deepEqual(blocksOf(p).find((b) => b.type === 'code'), { type: 'code', label: 'Code to enter', text: 'ABCD-EFGH1' });
  assert.equal(blocksOf(p).find((b) => b.type === 'link' && b.href).href, 'https://auth.openai.com/codex/device');
  assert.deepEqual([calloutOf(p).busy, calloutOf(p).title, p.refresh], [true, 'Waiting for you to enter the code at OpenAI…', 3]);
  const done = await until(() => { const x = loginPage(id); return calloutOf(x)?.tone === 'ok' && x; });
  assert.equal(calloutOf(done).title, '✓ Codex logged in (ChatGPT)');
  assert.equal(done.refresh, undefined);
});

test('a code the provider turns down: the page says why in a line, shows the CLI\'s last lines without the code, and offers Try again', async () => {
  const box = boxRunner();
  await box.tick();
  const id = act(env, fx, { action: 'login-start', fields: { box: 'one', harness: 'claude' } }).page.slice(6);
  await box.tick();
  await until(() => load(env).logins[id].state === 'waiting');
  act(env, fx, { action: 'login-code', fields: { id, code: 'wrong-code-7f3a9#s1' } });
  await box.tick();
  const p = await until(() => { const x = loginPage(id); return calloutOf(x)?.tone === 'bad' && x; });
  assert.equal(calloutOf(p).title, 'Claude didn\'t log in');
  assert.equal(calloutOf(p).text, 'Anthropic didn\'t accept that code. It may have expired, or been copied in part: try again, and paste the whole code.');
  const said = blocksOf(p).find((b) => b.type === 'details');
  assert.equal(said.meta, 'exit 1');
  assert.match(said.blocks[0].text, /Invalid code/);
  assert.equal(JSON.stringify(p).includes('wrong-code-7f3a9'), false, 'the pasted code never shows');
  assert.equal(JSON.stringify(load(env)).includes('wrong-code-7f3a9'), false);
  assert.deepEqual(blocksOf(p).find((b) => b.type === 'buttons').items, [{ action: 'login-start', label: 'Try again', tone: 'primary', fields: { box: 'one', harness: 'claude' } }]);
  assert.equal(p.refresh, undefined);
  // The box's card: not logged in, the reason, and Try again.
  const row = rowsOf(boxCard()).find((i) => i.text === 'Claude');
  assert.deepEqual([row.tone, row.act.label], ['bad', 'Try again']);
  assert.match(row.meta, /^not logged in · last try: Anthropic didn't accept that code/);
  // Try again is a fresh sign-in.
  const again = act(env, fx, { action: 'login-start', fields: { box: 'one', harness: 'claude' } }).page.slice(6);
  assert.notEqual(again, id);
});

test('a runtime restart mid-sign-in: the new runner\'s first poll fails the old login, saying so, and Log in starts a fresh one', async () => {
  const before = boxRunner();
  await before.tick();
  const id = act(env, fx, { action: 'login-start', fields: { box: 'one', harness: 'claude' } }).page.slice(6);
  await before.tick();
  await until(() => load(env).logins[id].state === 'waiting');
  // The old runner is gone without a word (killed): its login is "waiting" in loom's state. Before this, "Log in"
  // gave back that same dead login, again: true.
  const swept = [];
  const after = boxRunner({ sweep: () => { swept.push('swept'); return ['loom-login-' + id]; } });
  await after.tick();
  assert.deepEqual(swept, ['swept'], 'the new runner stops the sign-in containers left behind, once');
  await after.tick();
  assert.deepEqual(swept, ['swept']);
  assert.equal(load(env).logins[id].state, 'failed');
  assert.equal(load(env).logins[id].error, 'the runtime restarted during the sign-in; start again');
  const p = loginPage(id);
  assert.deepEqual([calloutOf(p).title, calloutOf(p).text], ['Claude didn\'t log in', 'the runtime restarted during the sign-in; start again']);
  const fresh = ok(call('login-start', { box: 'one', harness: 'claude' }));
  assert.notEqual(fresh.id, id);
  assert.equal(fresh.again, undefined);
  await after.tick();
  await until(() => load(env).logins[fresh.id].state === 'waiting');
  await after.endLogins();
  // The old runner's own sign-in, in this one test process: ended too, so nothing is left running.
  await before.endLogins();
});

test('a runner that lost a login (its process gone, the runner the same) fails it; one too old is given up; a runner going down says why', async () => {
  // Lost: handed to this run, and the run's list doesn't have it.
  ok(boxCall('poll', { harnesses: { claude: { installed: true, loggedIn: false } }, loginsRunning: { run: 'abcdef123456', ids: [] } }));
  const l = ok(call('login-start', { box: 'one', harness: 'claude' }));
  assert.deepEqual(ok(boxCall('poll', { loginsRunning: { run: 'abcdef123456', ids: [] } })).logins.map((x) => x.id), [l.id]);
  ok(boxCall('poll', { loginsRunning: { run: 'abcdef123456', ids: [l.id] } }));
  assert.equal(load(env).logins[l.id].state, 'starting', 'the box has it: under way');
  ok(boxCall('poll', { loginsRunning: { run: 'abcdef123456', ids: [] } }));
  assert.match(load(env).logins[l.id].error, /isn't running this sign-in any more/);
  // Too old: a login from 17 minutes ago that never finished is given up when Log in is pressed again.
  const l2 = ok(call('login-start', { box: 'one', harness: 'claude' }));
  update(env, (s) => { s.logins[l2.id].created = new Date(Date.now() - 17 * 60_000).toISOString(); });
  const l3 = ok(call('login-start', { box: 'one', harness: 'claude' }));
  assert.notEqual(l3.id, l2.id);
  assert.equal(load(env).logins[l2.id].error, 'No sign-in in time; start again.');
  // A box that stops polling mid-sign-in: given up after two minutes, saying so.
  ok(boxCall('poll', { loginsRunning: { run: 'abcdef123456', ids: [] } }));
  update(env, (s) => { s.boxes.one.lastSeen = new Date(Date.now() - 3 * 60_000).toISOString(); s.logins[l3.id].created = new Date(Date.now() - 3 * 60_000).toISOString(); });
  // The page says so before anything polls (a page changes nothing; it reads the login as loom will).
  assert.equal(calloutOf(loginPage(l3.id)).text, 'one stopped answering during the sign-in; start again');
  const l4 = ok(call('login-start', { box: 'one', harness: 'claude' }));
  assert.notEqual(l4.id, l3.id);
  assert.equal(load(env).logins[l3.id].error, 'one stopped answering during the sign-in; start again');
  // A runner going down (a restart, an update) tells loom why for each login it has, and stops its container.
  const box = boxRunner();
  await box.tick();
  const id = act(env, fx, { action: 'login-start', fields: { box: 'one', harness: 'codex' } }).page.slice(6);
  await box.tick();
  await until(() => load(env).logins[id].state === 'waiting');
  await box.shutdown();
  assert.equal(load(env).logins[id].error, 'the runtime restarted during the sign-in; start again');
});

test('a box starting stops the sign-in containers a runner before it left (by their label)', () => {
  const calls = [];
  const run = (bin, args) => { calls.push(args.join(' ')); return args[0] === 'ps' ? { status: 0, stdout: 'loom-login-l-0123456789ab\nquirky_name\n' } : { status: 0 }; };
  assert.deepEqual(sweepCliContainers({ PATH: '/bin' }, { run }), ['loom-login-l-0123456789ab', 'quirky_name']);
  assert.deepEqual(calls, ['ps -a --filter label=loom.cli --format {{.Names}}', 'rm -f -t 2 loom-login-l-0123456789ab quirky_name']);
});

test('why a login failed, in a line; what the CLI said, with no code or token in it', () => {
  assert.match(whyLoginFailed('claude', { exit: 1, out: 'getaddrinfo ENOTFOUND claude.ai' }), /couldn't reach Anthropic/);
  assert.match(whyLoginFailed('codex', { exit: 99 }), /codex isn't installed/);
  assert.equal(whyLoginFailed('claude', { exit: 1, out: 'bye', stage: 'link' }), 'Claude\'s login stopped before it gave a sign-in link (exit 1).');
  const s = scrubCliOutput('visit https://claude.com/cai/oauth/authorize?code=true&state=abc\nrefresh_token: rt-AAAABBBBCCCC1111\nAuthorization: Bearer sk-ant-oat01-ZZZZ\npasted xY9-my-code#s1 rejected\nexpires 2026-11-02', ['xY9-my-code#s1']);
  assert.equal(s, 'visit https://claude.com/cai/oauth/authorize?[…]\nrefresh_token: […]\nAuthorization: Bearer […]\npasted […] rejected\nexpires 2026-11-02');
});

/** This runtime as loom installs it, at `commit`: its own code under pieces/runtime/versions/<commit>/, so ownCommit() says so. */
async function installedAt(commit) {
  const pkg = join(scratch('loom-pieces-'), 'pieces', 'runtime', 'versions', commit, 'node_modules', 'loom-runtime');
  cpSync(join(here, '..', 'src'), join(pkg, 'src'), { recursive: true });
  copyFileSync(join(here, '..', 'package.json'), join(pkg, 'package.json'));
  const at = (f) => import(pathToFileURL(join(pkg, 'src', f)).href);
  return { ui: await at('ui.mjs'), control: await at('control.mjs') };
}

test('the box\'s card: its runtime against loom\'s (one source: ownCommit), updating…, why an update failed and when it retries, Update now, and the old box piece\'s one line', async () => {
  const LOOM = 'c'.repeat(40), OLD = 'a'.repeat(40);
  const { ui, control } = await installedAt(LOOM);
  // A box of its own (not loom's own machine, which runs loom's runtime by definition), so it can lag.
  const thor = ok(control.api(env, fx, { caller: owner, path: 'add-box', body: { name: 'thor', mayHost: 'art' } })).box;
  const boxCall = (path, body = {}) => control.api(env, fx, { caller: { kind: 'piece', subject: thor }, path, body });
  const boxCard = () => ui.page(env, { path: '' }).sections.find((x) => x.id === `box-${thor}`);
  const runtimeRow = () => boxCard().blocks.find((b) => b.type === 'list').items.find((i) => i.text === 'Runtime');
  // What loom tells the box to run is what the page compares against.
  assert.equal(ok(boxCall('poll', { harnesses: { claude: { installed: true, loggedIn: true, method: 'claude.ai', plan: 'max' } } })).version, LOOM);
  // Too old to say: the old box piece, and the line to run on it once.
  assert.deepEqual([runtimeRow().meta, runtimeRow().tone], [`too old to say which · loom's ccccccc`, 'warn']);
  const help = boxCard().blocks.find((b) => b.type === 'callout');
  assert.equal(help.title, 'This box is on the old box piece');
  assert.equal(boxCard().blocks.find((b) => b.type === 'code').text, swapCommand(LOOM));
  // Behind, an install under way.
  ok(boxCall('poll', { runtime: { commit: OLD, piece: 'box', upgrade: { commit: LOOM, from: OLD, state: 'installing', at: new Date().toISOString() } } }));
  assert.deepEqual([runtimeRow().meta, runtimeRow().badge, runtimeRow().act], [`aaaaaaa · loom's ccccccc · updating…, swapping its box piece for runtime`, 'updating…', undefined]);
  assert.equal(boxCard().blocks.some((b) => b.type === 'code'), false);
  // It failed: why, when it tries again, what the install said, and Update now.
  const retryAt = new Date(Date.now() + 5 * 3600_000).toISOString();
  ok(boxCall('poll', { runtime: { commit: OLD, piece: 'box', upgrade: { commit: LOOM, from: OLD, state: 'failed', at: new Date().toISOString(), retryAt,
    error: 'installing runtime failed (exit 1); the box piece is back as it was', detail: 'npm ERR! EEXIST: bin loom-box' } } }));
  assert.equal(runtimeRow().meta, `aaaaaaa · loom's ccccccc · the update didn't work: installing runtime failed (exit 1); the box piece is back as it was · tries again in 5h`);
  assert.deepEqual([runtimeRow().tone, runtimeRow().act], ['bad', { action: 'box-update-now', label: 'Update now', fields: { name: thor }, tone: 'primary' }]);
  assert.equal(boxCard().blocks.find((b) => b.type === 'details' && b.summary === 'What the install said').blocks[0].text, 'npm ERR! EEXIST: bin loom-box');
  // Update now: loom keeps asking, poll after poll, until the box's record says an attempt started on it.
  assert.equal(ui.act(env, fx, { action: 'box-update-now', fields: { name: thor } }).message, 'thor tries loom\'s runtime on its next poll.');
  const token = ok(boxCall('poll', {})).upgradeNow;
  assert.match(token, /^[0-9a-f]{12}$/);
  assert.equal(ok(boxCall('poll', {})).upgradeNow, token, 'not consumed by a poll where nothing started (a house starting, upgrades off)');
  ok(boxCall('poll', { runtime: { commit: OLD, piece: 'box', upgrade: { commit: LOOM, from: OLD, state: 'installing', at: new Date().toISOString(), now: token } } }));
  assert.equal(ok(boxCall('poll', {})).upgradeNow, undefined);
  // Rolling back: said, and no button (the recovery timer has it).
  ok(boxCall('poll', { runtime: { commit: OLD, piece: 'box', upgrade: { commit: LOOM, from: OLD, state: 'rolling-back', at: new Date().toISOString(), error: 'installing runtime failed (exit 1)' } } }));
  assert.deepEqual([runtimeRow().badge, runtimeRow().act], ['rolling back', undefined]);
  // Not for an agent owner.
  assert.equal(ui.act(env, fx, { action: 'box-update-now', fields: { name: thor }, caller: { kind: 'owner', who: 'loren', agents: ['art'] } }).ok, false);
  // Caught up.
  ok(boxCall('poll', { runtime: { commit: LOOM, piece: 'runtime' } }));
  assert.deepEqual([runtimeRow().meta, runtimeRow().tone], ['ccccccc · up to date with loom\'s', 'ok']);
  // And the harnesses, up front on the same card.
  const claude = boxCard().blocks.find((b) => b.type === 'list').items.find((i) => i.text === 'Claude');
  assert.deepEqual([claude.meta, claude.act.label], ['✓ logged in (claude.ai, Max)', 'Log in again']);
  // A dev checkout (this repo's own code) has no commit: "loom's version unknown", nothing to press.
  const dev = page(env, { path: '' }).sections.find((x) => x.id === `box-${thor}`).blocks.find((b) => b.type === 'list').items.find((i) => i.text === 'Runtime');
  assert.deepEqual([dev.meta, dev.act], ['ccccccc · loom\'s version unknown', undefined]);
});

test('a box\'s logins and Update now are its owner\'s: another household owner gets 403', () => {
  mkdirSync(join(env.HOME, 'loom'), { recursive: true });
  env.LOOM_HOME = join(env.HOME, 'loom');
  writeFileSync(join(env.LOOM_HOME, 'household.json'), JSON.stringify({ members: [{ person: 'alice', agents: '*' }, { person: 'bob', agents: '*' }] }));
  ok(boxCall('poll', { harnesses: { claude: { installed: true, loggedIn: false } } }));
  ok(call('box-owner', { name: 'one', owner: 'alice' }));
  const alice = { kind: 'owner', who: 'alice' }, bob = { kind: 'owner', who: 'bob' };
  const as = (c, path, body) => api(env, fx, { caller: c, path, body });
  assert.equal(as(bob, 'box-update-now', { name: 'one' }).status, 403);
  assert.match(as(bob, 'box-update-now', { name: 'one' }).body.error, /one is alice's/);
  assert.equal(as(bob, 'login-start', { box: 'one', harness: 'claude' }).status, 403);
  const l = ok(as(alice, 'login-start', { box: 'one', harness: 'claude' }));
  assert.equal(as(bob, 'login-cancel', { id: l.id }).status, 403);
  assert.equal(page(env, { path: `login/${l.id}`, caller: bob }).status, 403);
  assert.equal(page(env, { path: `login/${l.id}`, caller: alice }).status, undefined);
  assert.equal(act(env, fx, { action: 'box-update-now', fields: { name: 'one' }, caller: bob }).ok, false);
  ok(as(alice, 'box-update-now', { name: 'one' }));
  // Bob sees the box's card, with nothing to press on it.
  const claudeRow = (c) => page(env, { path: '', caller: c }).sections.find((x) => x.id === 'box-one').blocks.find((b) => b.type === 'list').items.find((r) => r.text === 'Claude');
  ok(as(alice, 'login-cancel', { id: l.id }));
  ok(boxCall('poll', {}));
  assert.equal(claudeRow(bob).act, undefined);
  assert.equal(claudeRow(alice).act.action, 'login-start');
});

test('a sign-in nobody picked up on a box that stopped polling fails after two minutes', () => {
  ok(boxCall('poll', { harnesses: { claude: { installed: true, loggedIn: false } } }));
  const l = ok(call('login-start', { box: 'one', harness: 'claude' }));
  assert.equal(load(env).logins[l.id].state, 'wanted');
  update(env, (s) => { s.boxes.one.lastSeen = new Date(Date.now() - 3 * 60_000).toISOString(); s.logins[l.id].created = new Date(Date.now() - 3 * 60_000).toISOString(); });
  assert.equal(calloutOf(loginPage(l.id)).title, 'Claude didn\'t log in');
  const again = ok(call('login-start', { box: 'one', harness: 'claude' }));
  assert.notEqual(again.id, l.id);
  assert.equal(load(env).logins[l.id].error, 'one stopped answering during the sign-in; start again');
});

test('the sweep of sign-in containers left behind is tried each tick until podman answers once, and a failure is logged', async () => {
  let n = 0;
  logged = [];
  const box = boxRunner({ sweep: () => (++n === 1 ? null : []) });
  await box.tick();
  assert.equal(n, 1);
  assert.ok(logged.some((m) => /podman couldn't list the sign-in containers/.test(m)));
  await box.tick();
  await box.tick();
  assert.equal(n, 2, 'once it worked, not again');
  const calls = [];
  assert.equal(sweepCliContainers({ PATH: '/bin' }, { run: (b, a) => { calls.push(a[0]); return { status: 125 }; } }), null);
  assert.equal(sweepCliContainers({ PATH: '/bin' }, { run: (b, a) => (a[0] === 'ps' ? { status: 0, stdout: 'loom-login-x\n' } : { status: 1 }) }), null, 'an rm that fails is not swept');
});

test('a runner tells loom which runtime it is, how its last upgrade went, and acts on Update now', async () => {
  const told = [];
  const box = boxRunner({ runtime: () => ({ commit: 'a'.repeat(40), piece: 'box' }), upgrade: (o) => { told.push(o.now); return null; } });
  mkdirSync(env.LOOM_BOX_HOME, { recursive: true });
  writeFileSync(join(env.LOOM_BOX_HOME, 'upgrade.json'), JSON.stringify({ commit: 'c'.repeat(40), from: 'a'.repeat(40), at: new Date().toISOString(), state: 'failed', error: 'loom pieces install failed (exit 1)' }));
  await box.tick();
  const rt = load(env).boxes.one.runtime;
  assert.deepEqual([rt.commit, rt.piece, rt.upgrade.state, rt.upgrade.error], ['a'.repeat(40), 'box', 'failed', 'loom pieces install failed (exit 1)']);
  act(env, fx, { action: 'box-update-now', fields: { name: 'one' } });
  const token = load(env).boxes.one.upgradeNow;
  await box.tick();
  assert.match(token, /^[0-9a-f]{12}$/);
  assert.deepEqual(told, [false, token]);
});
