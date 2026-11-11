import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROFILE_CAP, profileHostProblem, profileEnv, selectedProfile, minimalProfile, jobProfileKey, validateProfile, restrictedEnv, workServers, claudeWorkArgs } from '../src/work-profile.mjs';
import { amendment, requestAmendment, commitAmendment } from '../src/profile-amendment.mjs';
const profile = patch => ({ ...minimalProfile(), ...patch });
const job = { agent: 'art', venue: 'wake', kind: 'scheduled', place: 'lane:plan' };
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'job-profile-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('per-job declarations differ, no global allowlist or off bypass', () => fixture(root => {
  const file = join(root, 'profiles.json');
  writeFileSync(file, JSON.stringify({ v: 1, jobs: {
    [jobProfileKey(job)]: profile({ mcp: ['loom'], secrets: ['mcp.loom'] }),
    [jobProfileKey({ ...job, place: 'lane:music' })]: profile({ mcp: ['spotify'], secrets: ['mcp.spotify'] }),
  } }));
  const settings = { LOOM_RUNTIME_JOB_PROFILES: file, LOOM_RUNTIME_WORK_PROFILE: 'off' };
  const first = selectedProfile(profileEnv({}, 'scheduled', settings, job));
  const second = selectedProfile(profileEnv({}, 'scheduled', settings, { ...job, place: 'lane:music' }));
  assert.deepEqual(Object.keys(workServers({ loom: {}, github: {}, spotify: {} }, first)), ['loom']);
  assert.deepEqual(Object.keys(workServers({ loom: {}, github: {}, spotify: {} }, second)), ['spotify']);
  assert.deepEqual(selectedProfile(profileEnv({}, 'live', {})), minimalProfile());
  assert.match(profileEnv({}, 'live', {}).LOOM_BODY_PROFILE_PROBLEM, /JOB PROFILE PROBLEM/);
}));
test('missing and malformed profiles have minimal access and visible problem, never inherited marker', () => fixture(root => {
  const file = join(root, 'profiles.json');
  for (const body of ['{broken', JSON.stringify({ v: 1, jobs: { [jobProfileKey(job)]: profile({ tools: ['default'] }) } }), JSON.stringify({ v: 1, jobs: {} })]) {
    writeFileSync(file, body);
    const env = profileEnv({ HOME: root, SLACK_TOKEN: 'undeclared', LOOM_BODY_PROFILE: 'work' }, 'scheduled', { LOOM_RUNTIME_JOB_PROFILES: file }, job);
    assert.deepEqual(selectedProfile(env), minimalProfile());
    assert.match(env.LOOM_BODY_PROFILE_PROBLEM, /JOB PROFILE PROBLEM/);
    assert.equal(env.SLACK_TOKEN, undefined);
  }
  assert.throws(() => selectedProfile({ LOOM_BODY_PROFILE: 'work' }), /invalid transported/);
  assert.throws(() => validateProfile(profile({ skills: ['../escape'] })), /invalid/);
}));
test('only declared environment and MCP credentials cross the profile boundary', () => {
  const env = restrictedEnv({ HOME: '/tmp', PATH: '/bin', SLACK_TOKEN: 'private', MUSIC_KEY: 'chosen', NODE_OPTIONS: 'bad', LOOM_TOKEN: 'no' }, profile({ secrets: ['MUSIC_KEY'] }));
  assert.equal(env.MUSIC_KEY, 'chosen'); assert.equal(env.SLACK_TOKEN, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.LOOM_TOKEN, undefined);
  assert.throws(() => restrictedEnv({ NODE_OPTIONS: 'bad' }, profile({ secrets: ['NODE_OPTIONS'] })), /configure the harness/);
  assert.throws(() => restrictedEnv({}, profile({ secrets: ['MISSING_KEY'] })), /unavailable/);
  assert.throws(() => workServers({ loom: { headers: { Authorization: 'undeclared' } } }, profile({ mcp: ['loom'] })), /explicitly declare/);
  assert.throws(() => workServers({}, profile({ mcp: ['loom'] })), /unavailable/);
});
test('Claude config is private, exact servers/tools, disables inherited skills; unsupported skills refuse', () => fixture(root => {
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ mcpServers: { loom: { url: 'https://example.invalid', headers: { Authorization: 'fixture-only' } }, gmail: {} }, permissions: { deny: ['Bash(rm *)'] } }));
  const env = { HOME: root, LOOM_BODY_PROFILE: JSON.stringify(profile({ mcp: ['loom'], tools: ['Read'], secrets: ['mcp.loom'] })) };
  const args = claudeWorkArgs(env, root, join(root, 'jobs'));
  const config = args[args.indexOf('--mcp-config') + 1];
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(config, 'utf8')).mcpServers), ['loom']);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.equal(args[args.indexOf('--tools') + 1], 'Read');
  assert.ok(args.includes('--safe-mode')); assert.ok(args.includes('--disable-slash-commands'));
  assert.doesNotMatch(args.join(' '), /fixture-only/);
  assert.deepEqual(JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8')).permissions.deny, ['Bash(rm *)', 'Skill']);
  assert.throws(() => claudeWorkArgs({ ...env, LOOM_BODY_PROFILE: JSON.stringify(profile({ skills: ['music'] })) }, root, join(root, 'jobs')), /cannot yet isolate/);
}));
test('source disabled flags cannot be promoted by a declaration or project config', () => fixture(root => {
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ mcpServers: { loom: {} }, disabledMcpServers: ['loom'] }));
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { loom: {} } }));
  assert.throws(() => claudeWorkArgs({ HOME: root, LOOM_BODY_PROFILE: JSON.stringify(profile({ mcp: ['loom'] })) }, root, join(root, 'jobs')), /unavailable/);
}));
test('Codex adapter fails visibly rather than using unverified tool/skill isolation', async () => {
  const { CodexRunner } = await import('../src/runners.mjs');
  const x = new CodexRunner();
  assert.match(x.plan([], '/tmp', { LOOM_BODY_PROFILE: JSON.stringify(minimalProfile()) }).why, /refusing launch/);
});
for (const method of ['start', 'prepare']) test(`house ${method} enforces transported declaration and removes inherited secrets`, async () => {
  const { houseWorld, until } = await import('./delivery-world.mjs');
  const { load } = await import('../src/state.mjs');
  const w = houseWorld(); let host; w.env.PROFILE_TEST_SECRET = 'undeclared-fixture';
  const p = JSON.stringify(profile({ tools: ['Read'] }));
  const options = { agent: 'art', brief: 'profile transport fixture', model: 'opus', seat: 'owner.cv-abcdef123456', deny: ['mcp__github'], env: { LOOM_BODY_PROFILE: p, LOOM_BODY_KEY: 'fixture-key', LOOM_BODY_CONVERSATION: 'cv-abcdef123456' } };
  try {
    const pending = method === 'start' ? w.hr.start(options) : w.hr.prepareLaunch('7'.repeat(64), options);
    await until(() => load(w.env).houses['h-1']); host = w.host();
    const got = await pending;
    if (method === 'prepare') w.hr.publishPreparedLaunch(got);
    await until(() => Object.keys(w.local.envs).length > 0);
    const id = Object.keys(w.local.envs)[0];
    assert.deepEqual(selectedProfile(w.local.envs[id]), profile({ tools: ['Read'] }));
    assert.deepEqual(w.local.denies[id], ['mcp__github']);
    assert.equal(w.local.envs[id].PROFILE_TEST_SECRET, undefined);
  } finally { if (host) { await w.kill(); await host; } }
});
test('amendments use stable per-job/revision grant targets; owner callback persists once and rejects stale/forged data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-grant-'));
  try {
    const key = jobProfileKey(job), file = join(root, 'store.json'), p = minimalProfile();
    writeFileSync(file, JSON.stringify({ v: 1, jobs: { [key]: p } }));
    const cards = new Map();
    const request = async x => { if (!cards.has(x.target)) cards.set(x.target, { approval: 'a-fixture', state: 'pending' }); return cards.get(x.target); };
    const args = { key, profile: p, field: 'tools', name: 'Read', request };
    const [a,b] = await Promise.all([requestAmendment(args), requestAmendment(args)]);
    assert.equal(a.approval, b.approval); assert.equal(cards.size, 1);
    assert.deepEqual(JSON.parse(readFileSync(file)).jobs[key], p); // A pending/denied request does not amend.
    const other = amendment(key, p, 'tools', 'Bash');
    assert.throws(() => commitAmendment(file, { ...a.amendment, key: 'other-job' }), /does not match/);
    assert.deepEqual(commitAmendment(file, a.amendment), { applied: true });
    assert.deepEqual(JSON.parse(readFileSync(file)).jobs[key].tools, ['Read']);
    assert.deepEqual(selectedProfile(profileEnv({}, 'scheduled', { LOOM_RUNTIME_JOB_PROFILES: file }, job)).tools, ['Read']);
    assert.deepEqual(commitAmendment(file, a.amendment), { applied: false, already: true });
    assert.throws(() => commitAmendment(file, other), /changed since approval/);
    mkdirSync(`${file}.lock`);
    assert.throws(() => commitAmendment(file, a.amendment), /EEXIST/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('profile capability predicate accepts only the exact host protocol version', () => {
  for (const report of [undefined, {}, { caps: ['parts', 'native-admission'] }, { caps: ['job-profile-v0'] }]) {
    assert.match(profileHostProblem(JSON.stringify(minimalProfile()), report), /cannot enforce/);
  }
  assert.equal(profileHostProblem(JSON.stringify(minimalProfile()), { caps: [PROFILE_CAP] }), null);
  assert.equal(profileHostProblem(undefined, {}), null);
});
test('durable house admission refuses old profile host before publishing work', async () => {
  const { houseWorld, until } = await import('./delivery-world.mjs');
  const { load } = await import('../src/state.mjs');
  const w = houseWorld(); let host;
  const original = w.hr.host.bind(w.hr);
  w.hr.host = (...args) => { const h = original(...args); return { ...h, report: { ...h.report, caps: ['parts', 'native-admission'] } }; };
  try {
    const pending = w.hr.prepareLaunch('8'.repeat(64), { agent: 'art', brief: 'must not run', model: 'opus', seat: 'owner.cv-abcdef123456', env: { LOOM_BODY_PROFILE: JSON.stringify(minimalProfile()) } });
    const refused = assert.rejects(pending, /cannot enforce job profiles/);
    await until(() => load(w.env).houses['h-1']); host = w.host();
    await refused;
    assert.equal(Object.keys(w.local.envs).length, 0);
  } finally { if (host) { await w.kill(); await host; } }
});
test('Claude launch enforces secret filtering at the process boundary and preserves prior deny flags', async () => {
  const { ClaudeRunner } = await import('../src/runners.mjs');
  fixture(root => {
    const jobs = join(root, 'jobs'); mkdirSync(join(jobs, 'abcd1234'), { recursive: true });
    writeFileSync(join(jobs, 'abcd1234', 'state.json'), JSON.stringify({ sessionId: 'session-id', intent: '(bridge spawn token cafefeed: ignore this line)' }));
    let started = false, captured;
    const c = new ClaudeRunner({ jobsDir: jobs, token: () => 'cafefeed', sleep: () => {}, run: (_cmd, args, opts) => {
      if (args[0] === 'agents') return { status: 0, stdout: JSON.stringify(started ? [{ id: 'abcd1234', sessionId: 'session-id' }] : []) };
      captured = { args, env: opts.env }; started = true; return { status: 0 };
    } });
    c.start({ brief: 'profile job', cwd: root, env: { HOME: root, PATH: '/bin', SLACK_TOKEN: 'must-not-pass', MUSIC_KEY: 'allowed', LOOM_BODY_PROFILE: JSON.stringify(profile({ tools: ['Read'], secrets: ['MUSIC_KEY'] })) }, deny: ['mcp__github'] });
    assert.equal(captured.env.SLACK_TOKEN, undefined); assert.equal(captured.env.MUSIC_KEY, 'allowed');
    assert.equal(captured.args[captured.args.indexOf('--tools') + 1], 'Read');
    assert.equal(captured.args[captured.args.indexOf('--disallowedTools') + 1], 'mcp__github');
    assert.throws(() => c.resume({ harness: 'claude', session: 'old' }, { brief: 'resume', env: { HOME: root, LOOM_BODY_PROFILE: JSON.stringify(minimalProfile()) } }), /verified profile-bound history/);
  });
});

test('remote selection defers secret availability to the destination execution boundary', () => fixture(root => {
  const file = join(root, 'profiles.json');
  writeFileSync(file, JSON.stringify({ v: 1, jobs: { [jobProfileKey(job)]: profile({ secrets: ['HOUSE_ONLY_KEY'] }) } }));
  const selected = profileEnv({}, 'scheduled', { LOOM_RUNTIME_JOB_PROFILES: file }, job, { deferSecrets: true });
  assert.deepEqual(selectedProfile(selected).secrets, ['HOUSE_ONLY_KEY']);
  assert.throws(() => restrictedEnv({}, selectedProfile(selected)), /unavailable/);
  assert.equal(restrictedEnv({ HOUSE_ONLY_KEY: 'destination' }, selectedProfile(selected)).HOUSE_ONLY_KEY, 'destination');
}));
for (const mode of ['legacy', 'downgrade']) test(`profile host ${mode} rejects before request publication`, async () => {
  const { houseWorld, until } = await import('./delivery-world.mjs');
  const { load } = await import('../src/state.mjs');
  const w = houseWorld(); let host;
  const seat = 'owner.cv-abcdef123456';
  const loseCapability = () => {
    const file = join(w.env.LOOM_BOX_DATA || join(w.env.HOME, '.local/share/loom-box'), 'delivery/hosts', `art@${seat}.json`);
    const h = JSON.parse(readFileSync(file, 'utf8'));
    h.report.caps = h.report.caps.filter(c => c !== PROFILE_CAP);
    writeFileSync(file, JSON.stringify(h));
  };
  if (mode === 'legacy') w.hr.bound = async () => loseCapability();
  const o = { agent: 'art', brief: 'must not run', model: 'opus', seat, env: { LOOM_BODY_PROFILE: JSON.stringify(minimalProfile()) } };
  try {
    const pending = mode === 'legacy' ? w.hr.start(o) : w.hr.prepareLaunch('9'.repeat(64), o);
    const result = mode === 'legacy' ? assert.rejects(pending, /cannot enforce job profiles/) : pending;
    await until(() => load(w.env).houses['h-1']); host = w.host();
    const reserved = await result;
    if (mode === 'downgrade') { loseCapability(); assert.throws(() => w.hr.publishPreparedLaunch(reserved), /lost job profile support/); }
    assert.equal(Object.keys(w.local.envs).length, 0);
  } finally { if (host) { await w.kill(); await host; } }
});
test('Claude preserves distinct denies from user, project and local settings', () => fixture(root => {
  const home = join(root, 'home'), cwd = join(root, 'repo');
  mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Bash(user *)'] } }));
  writeFileSync(join(cwd, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Bash(project *)'] } }));
  writeFileSync(join(cwd, '.claude/settings.local.json'), JSON.stringify({ permissions: { deny: ['Read(local-secret)'] } }));
  const args = claudeWorkArgs({ HOME: home, LOOM_BODY_PROFILE: JSON.stringify(minimalProfile()) }, cwd, join(root, 'jobs'));
  assert.deepEqual(JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8')).permissions.deny, ['Bash(user *)', 'Bash(project *)', 'Read(local-secret)', 'Skill']);
}));
