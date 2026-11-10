import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyRunner } from '../src/agy.mjs';
import { agyCards } from '../src/activity.mjs';
import { agyActionNow } from '../src/ticker.mjs';
import { AGY_MODELS, DEFAULT_MODELS, resolveModel, resolveFor, setModels } from '../src/models.mjs';
import { configuredNativeRunner, nativeRunnerConfiguration, runnerFor } from '../src/runners.mjs';
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-test-')), cwd = join(dir, 'work');
  mkdirSync(cwd);
  const mcpFile = join(dir, 'mcp.json');
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { loom: { command: 'allowed' }, private: { command: 'denied' } } }));
  return { dir, cwd, mcpFile, runsDir: join(dir, 'runs') };
};
const wait = async f => { const deadline = Date.now() + 5000; while (!f()) { if (Date.now() > deadline) throw Error('host did not finish'); await new Promise(r => setTimeout(r, 20)); } };

test('isolated config contains allowed servers only; EOF captures tools and result', async () => {
  const f = fixture(), cli = join(f.dir, 'fake-agy');
  writeFileSync(cli, `#!${process.execPath}\nimport {readFileSync, symlinkSync, writeFileSync} from 'node:fs';\nlet input=''; for await (const c of process.stdin) input+=c;\nconst p=JSON.parse(input);\nconst servers=JSON.parse(readFileSync(process.env.HOME+'/.gemini/config/mcp_config.json')).mcpServers;\nif (servers.private || !servers.loom || process.env.GEMINI_API_KEY || process.env.AGY_LLM_GATEWAY_URL) process.exit(9);\nif (p.event!=='user' || p.message.content!=='private brief') process.exit(10);\nwriteFileSync(process.env.HOME+'/argv.json', JSON.stringify(process.argv));\nconsole.log(JSON.stringify({event:'step_update',step_update:{step_index:1,step_type:'tool',tool_name:'run_command',state:'DONE',tool_info:{parameters:{CommandLine:'echo hi'}}}}));\nconsole.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'final after EOF',usage:{total_tokens:12}}}));\n`, { mode: 0o700 });
  const runner = new AgyRunner({ ...f, agy: cli });
  const body = runner.start({ brief: 'private brief', model: 'gemini-3.8-flash', cwd: f.cwd, deny: ['mcp__private'], env: { ...process.env, GEMINI_API_KEY: 'never inherited', AGY_LLM_GATEWAY_URL: 'never inherited' } });
  await body.inputReady;
  await wait(() => runner.status(body) === 'idle');
  assert.equal(runner.final(body), 'final after EOF');
  assert.deepEqual(runner.turn(body), { failed: false, worked: true });
  assert.equal(runner.events(body.id).length, 2);
  const argv = readFileSync(join(f.runsDir, body.id, 'home/argv.json'), 'utf8');
  assert.ok(!argv.includes('private brief'));
  assert.ok(!argv.includes('never inherited'));
  assert.equal(runner.feed(body, { text: 'second prompt' }).fed, false);
  assert.equal(runner.slotOf(body), null);
  assert.equal(runner.usage(body), null);
  assert.equal(runner.recoverLaunch(body.id).state, 'ready');
});

test('authentication failure is a bounded failed turn, with no login or retry', async () => {
  const f = fixture(), cli = join(f.dir, 'auth-agy');
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end',()=>{console.error('authentication required'); process.exitCode=1;});\n`, { mode: 0o700 });
  const runner = new AgyRunner({ ...f, agy: cli });
  const body = runner.start({ brief: 'hello', cwd: f.cwd });
  await body.inputReady; await wait(() => runner.status(body) === 'idle');
  assert.equal(runner.turn(body).failed, true);
  assert.match(runner.turn(body).error, /^AUTH_REQUIRED/);
  assert.equal(runner.ids().length, 1);
});

test('refuses individual tool denies, workspace layers, malformed source and duplicate admission', () => {
  const f = fixture(), runner = new AgyRunner(f);
  for (const deny of [['Bash'], ['mcp__private__read']]) assert.throws(() => runner.start({ brief: 'hi', cwd: f.cwd, deny }), /cannot enforce/);
  mkdirSync(join(f.cwd, '.agents'));
  writeFileSync(join(f.cwd, '.agents/mcp_config.json'), '{}');
  assert.match(runner.wontRun([], f.cwd), /workspace configuration/);
  const linked = fixture();
  mkdirSync(join(linked.cwd, 'nested'));
  mkdirSync(join(linked.cwd, '.agents'));
  writeFileSync(join(linked.cwd, '.agents/mcp_config.json'), '{}');
  symlinkSync(join(linked.cwd, 'nested'), join(linked.dir, 'alias'));
  assert.match(new AgyRunner(linked).wontRun([], join(linked.dir, 'alias')), /workspace configuration/);
  const g = fixture(); writeFileSync(g.mcpFile, 'invalid');
  assert.match(new AgyRunner(g).wontRun([], g.cwd), /unreadable/);
  const h = fixture(); mkdirSync(join(h.runsDir, '12345678'), { recursive: true });
  const r = new AgyRunner({ ...h, key: () => '12345678' });
  assert.throws(() => r.start({ brief: 'hi', cwd: h.cwd }), /already exists/);
  assert.equal(r.recoverLaunch('12345678').state, 'pending');
});

test('agy labels and current action follow nested state and redact private values', () => {
  const active = { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'echo hello' } } } };
  assert.equal(agyActionNow([active]), 'Running a command');
  assert.equal(agyCards([active])[0].state, 'running');
  const done = { event: 'step_update', step_update: { ...active.step_update, state: 'DONE' } };
  assert.equal(agyCards([active, done]).length, 1);
  assert.equal(agyCards([active, done])[0].state, 'done');
  assert.equal(agyActionNow([active, { event: 'result' }]), 'Working');
  const secret = { ...active, step_update: { ...active.step_update, tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: '/home/art/.codex/auth.json' }, output: 'never display this' } } };
  const label = agyCards([secret])[0].summary;
  assert.ok(!label.includes('auth.json') && !label.includes('never display this'));
});

test('model list and scoring cannot opt an agent into agy', () => {
  const models = [...DEFAULT_MODELS, ...AGY_MODELS];
  const q = { agent: 'art', kind: 'agent', models, accounts: null };
  assert.equal(resolveModel(q).harness, 'claude');
  assert.throws(() => resolveModel({ ...q, models: AGY_MODELS }), /none/);
  assert.equal(resolveModel({ ...q, prefer: [AGY_MODELS[0].id] }).harness, 'agy');
  assert.equal(resolveModel({ ...q, settings: { prefer: [AGY_MODELS[0].id] } }).harness, 'agy');
  assert.equal(resolveModel({ ...q, harnessChoice: 'agy' }).harness, 'agy');
});

test('native configuration roundtrip selects agy without sharing a login', () => {
  const f = fixture(), runner = new AgyRunner(f);
  const config = nativeRunnerConfiguration(runner);
  assert.equal(config.mcpFile, f.mcpFile);
  assert.ok(configuredNativeRunner('agy', config) instanceof AgyRunner);
  assert.ok(runnerFor('agy', { HOME: f.dir }) instanceof AgyRunner);
});

 test('a pinned agy worker retains the explicit opt-in of its assignment', async () => {
  const f = fixture(), env = { HOME: f.dir, LOOM_BOX_DATA: join(f.dir, 'state'), LOOM_RUNTIME_SCORECARDS: 'off' };
  setModels(env, { list: [...DEFAULT_MODELS, ...AGY_MODELS] });
  const result = await resolveFor(env, { agent: 'art', venue: 'relay', pin: AGY_MODELS[0].id, accounts: { kind: 'none', list: () => null } });
  assert.equal(result.harness, 'agy');
 });
