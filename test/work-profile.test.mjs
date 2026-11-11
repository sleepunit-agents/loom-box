import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileEnv, workServers, claudeWorkArgs } from '../src/work-profile.mjs';
test('job profile narrows servers and keeps full profile for live sessions and explicit off', () => {
  assert.equal(profileEnv({}, 'agent', {}).LOOM_BODY_PROFILE, 'work');
  assert.equal(profileEnv({}, 'scheduled', {}).LOOM_BODY_PROFILE, 'work');
  assert.equal(profileEnv({}, 'live', {}).LOOM_BODY_PROFILE, undefined);
  assert.equal(profileEnv({ LOOM_BODY_PROFILE: 'work' }, 'live', {}).LOOM_BODY_PROFILE, undefined);
  assert.equal(profileEnv({ LOOM_BODY_PROFILE: 'work' }, 'agent', { LOOM_RUNTIME_WORK_PROFILE: 'off' }).LOOM_BODY_PROFILE, undefined);
  assert.equal(profileEnv({}, 'agent', { LOOM_RUNTIME_WORK_PROFILE: 'off' }).LOOM_BODY_PROFILE, undefined);
  assert.deepEqual(workServers({ loom: {}, github: {}, taskstore: {}, gmail: {}, slack: {} }), { loom: {}, github: {}, taskstore: {} });
});
test('Claude gets a private strict MCP file; credential contents never become argv', () => {
  const root = mkdtempSync(join(tmpdir(), 'work-profile-'));
  try {
    writeFileSync(join(root, '.claude.json'), JSON.stringify({ mcpServers: { loom: { url: 'https://example.invalid', headers: { Authorization: 'test-fixture-only' } }, Gmail: {} } }));
    const args = claudeWorkArgs({ HOME: root, LOOM_BODY_PROFILE: 'work' }, root, join(root, 'jobs'));
    assert.equal(args[0], '--strict-mcp-config');
    assert.doesNotMatch(args.join(' '), /test-fixture-only/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(args[2], 'utf8')).mcpServers), ['loom']);
    assert.equal(JSON.parse(readFileSync(args[2], 'utf8')).mcpServers.loom.headers.Authorization, 'test-fixture-only');
    assert.equal(statSync(args[2]).mode & 0o777, 0o600);
    assert.deepEqual(claudeWorkArgs({ HOME: root }, root, join(root, 'jobs')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('real runner launch keeps deny flags, and lean/full Codex homes cannot overwrite each other', async () => {
  const { ClaudeRunner, CodexRunner } = await import('../src/runners.mjs');
  const root = mkdtempSync(join(tmpdir(), 'profile-runners-'));
  try {
    writeFileSync(join(root, '.claude.json'), JSON.stringify({ mcpServers: { loom: { url: 'https://example.invalid' } } }));
    writeFileSync(join(root, 'config.toml'), '[mcp_servers.loom]\nurl="https://example.invalid"\n[mcp_servers.github]\nurl="https://github.invalid"\n[mcp_servers.Gmail]\nurl="https://gmail.invalid"\n');
    const jobs = join(root, 'jobs'); mkdirSync(join(jobs, 'abcd1234'), { recursive: true });
    writeFileSync(join(jobs, 'abcd1234', 'state.json'), JSON.stringify({ sessionId: 'session-id', intent: '(bridge spawn token cafefeed: ignore this line)' }));
    let launched, didLaunch = false;
    const c = new ClaudeRunner({ jobsDir: jobs, token: () => 'cafefeed', sleep: () => {}, run: (_cmd, args) => {
      if (args[0] === 'agents') return { status: 0, stdout: JSON.stringify(didLaunch ? [{ id: 'abcd1234', sessionId: 'session-id' }] : []) };
      didLaunch = true; launched = args; return { status: 0 };
    } });
    c.start({ brief: 'Work', cwd: root, env: { HOME: root, LOOM_BODY_PROFILE: 'work' }, deny: ['mcp__github'] });
    assert.ok(launched.includes('--strict-mcp-config'));
    assert.equal(launched[launched.indexOf('--disallowedTools') + 1], 'mcp__github');
    let actualArgs, actualEnv;
    const x = new CodexRunner({ codexHome: root, systemDir: join(root, 'system'), runsDir: join(root, 'runs'), homesDir: join(root, 'homes'), spawn: (_cmd, args, opts) => { actualArgs = args; actualEnv = opts.env; return { pid: 12345, stdin: { on() {}, end() {} }, on() {}, unref() {} }; } });
    const lean = x.plan(['mcp__github'], root, { CODEX_HOME: root, LOOM_BODY_PROFILE: 'work' });
    assert.deepEqual(Object.keys(lean.servers), ['loom']);
    assert.ok(lean.args.includes('mcp_servers.github={enabled=false, command="false"}'));
    assert.ok(lean.args.includes('apps'));
    assert.ok(lean.args.includes('remote_plugin'));
    const full = x.plan(['mcp__github'], root, { CODEX_HOME: root });
    assert.notEqual(x.homeIdOf(lean), x.homeIdOf(full));
    x.start({ brief: 'Do work', cwd: root, env: { CODEX_HOME: root, HOME: root, LOOM_BODY_PROFILE: 'work' }, deny: ['mcp__github'] });
    assert.ok(actualArgs.includes('apps')); assert.ok(actualArgs.includes('remote_plugin'));
    assert.ok(actualArgs.includes('mcp_servers.github={enabled=false, command="false"}'));
    assert.notEqual(actualEnv.CODEX_HOME, root);
    const config = readFileSync(join(actualEnv.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(config, /mcp_servers.loom/); assert.doesNotMatch(config, /mcp_servers.github|mcp_servers.Gmail/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
