import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRunner } from '../src/runners.mjs';
import { minimalProfile } from '../src/work-profile.mjs';
import { packSession, restoreFiles } from '../src/sessions.mjs';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'profile-floor-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function native(root) {
  const jobsDir = join(root, 'jobs'); let active = false, count = 0, captured;
  const id = 'abcd1234'; mkdirSync(join(jobsDir, id), { recursive: true });
  const runner = new ClaudeRunner({ jobsDir, token: () => `token${++count}`, sleep: () => {}, run: (_cmd, args, opts) => {
    if (args[0] === 'agents') return { status: 0, stdout: JSON.stringify(active ? [{ id, sessionId: `session-${count}` }] : []) };
    captured = { args, ...opts }; active = true;
    mkdirSync(join(root, 'projects/fixture'), { recursive: true });
    writeFileSync(join(root, `projects/fixture/session-${count}.jsonl`), '{}\n');
    const token = opts.input.match(/bridge spawn token ([^:]+):/)[1];
    writeFileSync(join(jobsDir, id, 'state.json'), JSON.stringify({ sessionId: `session-${count}`, intent: `(bridge spawn token ${token}: ignore this line)` }));
    return { status: 0 };
  } });
  return { runner, captured: () => captured };
}
const env = (root, config) => ({ HOME: root, CLAUDE_CONFIG_DIR: config, LOOM_BODY_PROFILE: JSON.stringify({ ...minimalProfile(), tools: ['Read'] }) });
const settings = captured => JSON.parse(readFileSync(captured.args[captured.args.lastIndexOf('--settings') + 1], 'utf8'));

test('source floor survives config A to B, native session forks, process restart and packed house transfer', () => fixture(root => {
  const a = join(root, 'a'), b = join(root, 'b');
  mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, '.claude.json'), JSON.stringify({ permissions: { deny: ['Read(/private-a)'] }, projects: {[root]: {disabledMcpjsonServers: ['blocked']}}, mcpServers: {blocked: {command:'disabled-in-project'}} }));
  writeFileSync(join(a, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm *)'] } }));
  writeFileSync(join(b, '.claude.json'), JSON.stringify({ mcpServers: { blocked: { command: 'must-not-start' } } }));
  const first = native(join(root, 'first'));
  const started = first.runner.start({ brief: 'start', cwd: root, env: env(root, a), deny: ['Write'] });
  // New process/runner, same durable history; config directory B has neither deny.
  const restarted = native(join(root, 'first'));
  const resumed = restarted.runner.resume(started.slot, { brief: 'resume', cwd: root, env: env(root, b) });
  assert.deepEqual(new Set(settings(restarted.captured()).permissions.deny), new Set(['Read(/private-a)', 'Bash(rm *)', 'Write', 'Skill']));
  // Track a native fork after initial admission before packing it.
  writeFileSync(join(root, 'first/jobs/abcd1234/state.json'), JSON.stringify({ sessionId: 'forked-session' }));
  writeFileSync(join(root, 'first/projects/fixture/forked-session.jsonl'), '{}\n');
  const slot = restarted.runner.slotOf(resumed);
  const files = packSession(restarted.runner, slot, resumed);
  assert.ok(files.some(f => JSON.stringify(f).includes('session-forked-session.json')));
  const house = native(join(root, 'other-house')); restoreFiles(house.runner, files);
  house.runner.resume(slot, { brief: 'next house', cwd: root, env: env(root, b) });
  assert.ok(settings(house.captured()).permissions.deny.includes('Read(/private-a)'));
  const withMcp = { ...env(root, b), LOOM_BODY_PROFILE: JSON.stringify({ ...minimalProfile(), mcp: ['blocked'], secrets: ['mcp.blocked'] }) };
  assert.throws(() => house.runner.resume(house.runner.slotOf({ id: 'abcd1234' }), { brief: 'revive', cwd: root, env: withMcp }), /unavailable/);
}));

test('invalid transport actually launches minimal, prints a problem, and filters secrets', () => fixture(root => {
  const n = native(root);
  n.runner.start({ brief: 'start', cwd: root, env: { HOME: root, LOOM_BODY_PROFILE: '{broken', PRIVATE_KEY: 'canary' } });
  const got = n.captured();
  assert.match(got.input, /JOB PROFILE PROBLEM: invalid transported/);
  assert.equal(got.input.match(/JOB PROFILE PROBLEM/g).length, 1);
  assert.equal(got.args[got.args.indexOf('--tools') + 1], '');
  assert.deepEqual(JSON.parse(readFileSync(got.args[got.args.indexOf('--mcp-config') + 1])).mcpServers, {});
  assert.equal(got.env.PRIVATE_KEY, undefined);
}));

test('unknown source floor remains visibly minimal on subsequent resumes', () => fixture(root => {
  const n = native(root);
  const body = n.runner.resume({ harness: 'claude', session: 'unknown-session' }, { brief: 'resume', cwd: root, env: env(root, root) });
  n.runner.resume(body.slot, { brief: 'resume again', cwd: root, env: env(root, root) });
  assert.equal(n.captured().args[n.captured().args.indexOf('--tools') + 1], '');
  assert.match(n.captured().input, /no saved source restriction floor/);
}));

for (const corrupt of ['{broken', JSON.stringify({deny: 'Read', disabled: []}), 'directory']) test(`corrupt source floor ${corrupt} remains visibly minimal`, () => fixture(root => {
  const n = native(root);
  const path = n.runner.floorPath('session-corrupt-session'); mkdirSync(join(root, 'projects/.loom-profile-floors'), {recursive: true});
  if (corrupt === 'directory') mkdirSync(path); else writeFileSync(path, corrupt);
  const body = n.runner.resume({harness: 'claude', session: 'corrupt-session'}, {brief: 'resume', cwd: root, env: env(root, root)});
  assert.equal(n.captured().args[n.captured().args.indexOf('--tools') + 1], '');
  assert.match(n.captured().input, /no saved source restriction floor/);
  n.runner.resume(body.slot, {brief: 'again', cwd: root, env: env(root, root)});
  assert.equal(n.captured().args[n.captured().args.indexOf('--tools') + 1], '');
}));
test('restriction metadata alone never masquerades as native session history', () => fixture(root => {
  const n = native(root); n.runner.saveFloor('session-empty-session', {deny: ['Read'], disabled: []});
  assert.deepEqual(packSession(n.runner, {harness:'claude', session:'empty-session'}), []);
}));

test('fresh context successor carries a floor without packing or resuming the predecessor', () => fixture(root => {
  const source = native(join(root, 'source'));
  const old = source.runner.start({ brief: 'old', cwd: root, env: env(root, root), deny: ['Read(/private)'] });
  source.runner.saveFloor(`body-${old.id}`, { deny: ['Read(/private)'], disabled: ['blocked'] });
  const floor = source.runner.profileFloor(old);
  const target = native(join(root, 'target'));
  const fresh = target.runner.start({ brief: 'accept only', cwd: root, env: env(root, root), profileFloor: floor });
  assert.equal(target.captured().args.includes('--resume'), false);
  assert.ok(settings(target.captured()).permissions.deny.includes('Read(/private)'));
  assert.deepEqual(target.runner.profileFloor(fresh), floor);
  const files = packSession(target.runner, fresh.slot, fresh);
  const third = native(join(root, 'third')); restoreFiles(third.runner, files);
  third.runner.resume(fresh.slot, { brief: 'continue after restart and house transfer', cwd: root, env: env(root, root), profileFloor: floor });
  assert.ok(settings(third.captured()).permissions.deny.includes('Read(/private)'));
  assert.deepEqual(third.runner.profileFloor({ id: 'abcd1234' }).disabled, ['blocked']);
  const declaredBlocked = { ...env(root, root), LOOM_BODY_PROFILE: JSON.stringify({ ...minimalProfile(), mcp: ['blocked'], secrets: ['mcp.blocked'] }) };
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ mcpServers: { blocked: { command: 'must-not-launch' } } }));
  assert.throws(() => third.runner.start({ brief: 'second rotation', cwd: root, env: declaredBlocked, profileFloor: floor }), /unavailable/);
}));

test('unknown transported context floor selects minimal before unavailable secrets and stays unknown in history', () => fixture(root => {
  const target = native(root);
  const input = { ...env(root, root), LOOM_BODY_PROFILE: JSON.stringify({ ...minimalProfile(), tools: ['Read'], secrets: ['MISSING_KEY'] }) };
  const fresh = target.runner.start({ brief: 'accept', cwd: root, env: input, profileFloor: { deny: ['Write'], disabled: [], unknown: true } });
  assert.match(target.captured().input, /minimal profile/);
  assert.equal(target.captured().args[target.captured().args.indexOf('--tools') + 1], '');
  assert.equal(target.runner.profileFloor(fresh).unknown, true);
  target.runner.resume(fresh.slot, { brief: 'continue', cwd: root, env: { ...input } });
  assert.equal(target.runner.profileFloor(fresh).unknown, true);
  assert.ok(settings(target.captured()).permissions.deny.includes('Write'));
}));

test('a saved context snapshot cannot make missing later native resume provenance known', () => fixture(root => {
  const target = native(root), floor = { deny: ['Read(/private)'], disabled: ['blocked'] };
  target.runner.resume({ harness: 'claude', session: 'missing-session' }, { brief: 'later resume', cwd: root, profileFloor: floor,
    env: { ...env(root, root), LOOM_BODY_PROFILE: JSON.stringify({ ...minimalProfile(), tools: ['Read'], secrets: ['UNAVAILABLE'] }) } });
  assert.equal(target.captured().args[target.captured().args.indexOf('--tools') + 1], '');
  assert.match(target.captured().input, /minimal profile/);
  assert.equal(target.runner.profileFloor({ id: 'abcd1234' }).unknown, true);
  assert.ok(settings(target.captured()).permissions.deny.includes('Read(/private)'));
}));
