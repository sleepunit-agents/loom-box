// Actual production --bg launch through both house admission paths. Opt-in: model calls.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync, readFileSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ClaudeRunner} from '../src/runners.mjs';
import {minimalProfile} from '../src/work-profile.mjs';
import {houseWorld, until} from './delivery-world.mjs';
import {load} from '../src/state.mjs';
const pause = ms => new Promise(r => setTimeout(r, ms));
async function finished(runner, body, denied = false) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    body.slot=runner.slotOf({id:body.id}) ?? body.slot;
    if (runner.status(body) === 'idle') {
      const turn = runner.turn(body); assert.equal(turn.failed, false, turn.error);
      const rows = readFileSync(runner.transcriptOf(body), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      const token=/\(bridge spawn token ([0-9a-f]+):/.exec(runner.job(body.id)?.intent ?? '')?.[1];
      const at=rows.findLastIndex(r=>r.type==='user' && typeof r.message?.content==='string' && r.message.content.includes(`(bridge spawn token ${token}:`));
      if(at<0) {await pause(200);continue;}
      const current=rows.slice(at);
      const assistants=current.filter(r => r.type === 'assistant' && r.message?.usage);
      const result=denied ? current.some(r => r.type === 'user' && Array.isArray(r.message?.content) && r.message.content.some(c => c.type === 'tool_result' && c.is_error)) : assistants.at(-1)?.message?.stop_reason === 'end_turn' && Array.isArray(assistants.at(-1)?.message?.content) && assistants.at(-1).message.content.some(c=>c.type==='text' && c.text);
      if (result) return rows;
    }
    await pause(200);
  }
  throw Error('background profile fixture timed out');
}
function shape(records) { return records.filter(r => r.type === 'api-request-shape').at(-1)?.shape; }
function assertShape(s) {
  assert.ok(s, 'native request shape must be recorded');
  assert.deepEqual(s.tools.map(t => t.name).filter(n => !['DeferredToolPlaceholder', 'EndConversation'].includes(n)).sort(), ['Read', 'mcp__declared__profile_probe']);
  const text = JSON.stringify(s.system);
  assert.match(text, /CHOSEN-PROFILE/); assert.doesNotMatch(text, /UNLISTED-SKILL/);
}
for (const method of ['start', 'prepare']) test(`native house ${method}: background capabilities, secrets, skills and continuation`, {skip: process.env.PROFILE_BACKGROUND_CHECK !== '1', timeout: 240000}, async () => {
  const w = houseWorld({claimMs: 60000}); let host, body;
  const config = join(w.D, 'config'), cwd = join(w.D, 'repo');
  mkdirSync(config, {recursive: true});
  for (const name of ['chosen', 'unlisted']) {
    const d = join(cwd, '.claude/skills', name); mkdirSync(d, {recursive: true});
    writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture\n---\n${name === 'chosen' ? 'When asked for the profile password reply CHOSEN-PROFILE.' : 'UNLISTED-SKILL'}\n`);
  }
  // A canary MCP must never start. It writes a marker if strict config leaks it.
  const canary = join(w.D, 'canary'), mcpCalls = join(w.D,'mcp-calls');
  const declared = {command:process.execPath,args:[fileURLToPath(new URL('./fake-profile-mcp.mjs',import.meta.url)),mcpCalls]};
  writeFileSync(join(config, '.claude.json'), JSON.stringify({ projects: {[cwd]: {hasTrustDialogAccepted: true}}, mcpServers: {declared, unlisted: {command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(canary)}, 'leak')`]}} }));
  writeFileSync(join(config, 'settings.json'), JSON.stringify({permissions: {deny: ['Read(**/private-secret)']}}));
  Object.assign(w.houseEnv, {HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config, PROFILE_CANARY_SECRET: 'must-not-reach-harness', DECLARED_FIXTURE_KEY: 'allowed-fixture'});
  const envNames = join(w.D, 'child-env.json'), shim = join(w.D, 'claude-shim');
  writeFileSync(shim, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; if(process.argv.includes('--bg')) appendFileSync(${JSON.stringify(envNames)}, JSON.stringify(Object.keys(process.env))+'\\n'); const r=spawnSync(${JSON.stringify(process.env.PROFILE_CLAUDE_BIN || '/home/art/.local/bin/claude')}, process.argv.slice(2), {stdio:'inherit'}); process.exit(r.status ?? 1);\n`);
  chmodSync(shim, 0o700);
  const runner = new ClaudeRunner({claude: shim, jobsDir: join(config, 'jobs'), usageDir: join(w.D, 'usage')});
  const p = JSON.stringify({...minimalProfile(), mcp:['declared'], tools: ['Read'], skills: ['chosen'], secrets: ['DECLARED_FIXTURE_KEY','mcp.declared']});
  const forbidden = join(cwd,'private-secret'); writeFileSync(forbidden,'DENIED-READ-CONTENT-CANARY');
  const allowedFile=join(cwd,'allowed-file');writeFileSync(allowedFile,'ALLOWED-READ-CONTENT-CANARY');
  const options = {agent: 'art', brief: `Read ${allowedFile}, then call mcp__declared__profile_probe and reply with both contents and the profile password. Use only those two tools.`, model: 'claude-opus-5-5', seat: 'owner.cv-abcdef123456', env: {LOOM_BODY_PROFILE: p}};
  try {
    const pending = method === 'start' ? w.hr.start(options) : w.hr.prepareLaunch('7'.repeat(64), options);
    await until(() => load(w.env).houses['h-1']); host = w.host({cwd, runWith: runner});
    const receipt = await pending;
    if (method === 'prepare') { w.hr.publishPreparedLaunch(receipt); body = await w.hr.waitPreparedLaunch(receipt); }
    else body = receipt;
    body = {...body, id: body.id.replace(/^h-1-/, '')};
    body.slot = runner.slotOf(body);
    const rows = await finished(runner, body); assertShape(shape(rows));
    assert.match(JSON.stringify(rows.filter(r => r.type === 'assistant').at(-1)?.message?.content), /CHOSEN-PROFILE/);
    assert.ok(rows.some(r=>r.type==='user' && Array.isArray(r.message?.content) && r.message.content.some(c=>c.type==='tool_result' && !c.is_error && JSON.stringify(c.content).includes('ALLOWED-READ-CONTENT-CANARY'))), 'declared Read must work');
    assert.ok(rows.some(r=>r.type==='user' && Array.isArray(r.message?.content) && r.message.content.some(c=>c.type==='tool_result' && !c.is_error && JSON.stringify(c.content).includes('DECLARED-MCP-CONTENT-CANARY'))), 'declared MCP tool must actually execute');
    const firstCalls=readFileSync(mcpCalls,'utf8').split('called').length;
    const first = rows.find(r => r.type === 'assistant')?.message?.usage;
    assert.ok(first);
    console.log(`house ${method}: first input=${first.input_tokens + first.cache_creation_input_tokens + first.cache_read_input_tokens}; session=${body.slot?.session}`);
    let attempt=7;
    const continueHouse = async (declaration,brief) => {
      runner.end(body,w.houseEnv);
      const o={...options,env:{LOOM_BODY_PROFILE:declaration},brief};
      let remote;
      if(method==='start') remote=await w.hr.resume(body.slot,o);
      else {const reserved=await w.hr.prepareLaunch(String(++attempt).repeat(64),o,body.slot);w.hr.publishPreparedLaunch(reserved);remote=await w.hr.waitPreparedLaunch(reserved);}
      body={...remote,id:remote.id.replace(/^h-1-/, '')};body.slot=runner.slotOf({id:body.id});return body;
    };
    // Exercise the inherited deny in the same house, rather than only checking flags.
    const blocked=await continueHouse(p,`First call mcp__declared__profile_probe. Then try calling Read on ${forbidden} once. Do not use any other tool.`);
    const denial=await finished(runner,blocked,true);
    assert.ok(denial.some(r=>r.type==='assistant' && Array.isArray(r.message?.content) && r.message.content.some(c=>c.type==='tool_use' && c.name==='Read')));
    assert.ok(denial.some(r=>r.type==='user' && Array.isArray(r.message?.content) && r.message.content.some(c=>c.type==='tool_result' && c.is_error)));
    assert.doesNotMatch(JSON.stringify(denial),/DENIED-READ-CONTENT-CANARY/);
    assert.ok(denial.some(r=>r.type==='user' && Array.isArray(r.message?.content) && r.message.content.some(c=>c.type==='tool_result' && !c.is_error && JSON.stringify(c.content).includes('DECLARED-MCP-CONTENT-CANARY'))));
    assert.ok(readFileSync(mcpCalls,'utf8').split('called').length > firstCalls, 'MCP remains callable on continuation');
    // Narrow through the same transport/admission path, retaining native history.
    const commandCanary=join(cwd,'undeclared-command-canary');
    const resumed=await continueHouse(JSON.stringify(minimalProfile()),`Try using Bash to write UNEXPECTED to ${commandCanary}. If Bash is unavailable, reply UNAVAILABLE. Do not simulate success.`);
    const next=await finished(runner,resumed);
    assert.deepEqual(shape(next).tools.filter(t => !['DeferredToolPlaceholder', 'EndConversation'].includes(t.name)), []);
    assert.doesNotMatch(JSON.stringify(shape(next).system), /CHOSEN-PROFILE|UNLISTED-SKILL/);
    assert.equal((await import('node:fs')).existsSync(commandCanary),false);
    assert.match(next.filter(r=>r.type==='assistant').flatMap(r=>Array.isArray(r.message?.content)?r.message.content:[]).filter(c=>c.type==='text').at(-1)?.text ?? '',/UNAVAILABLE/);
    runner.end(resumed, w.houseEnv);
    const {existsSync} = await import('node:fs'); assert.equal(existsSync(canary), false);
    const children=readFileSync(envNames,'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(children.length>=3);
    for(const names of children) assert.equal(names.includes('PROFILE_CANARY_SECRET'),false);
    assert.ok(children[0].includes('DECLARED_FIXTURE_KEY'));
    assert.ok(children[1].includes('DECLARED_FIXTURE_KEY'));
    assert.equal(children.at(-1).includes('DECLARED_FIXTURE_KEY'),false);
  } finally {
    if (body && !runner.stopped(body)) runner.end(body, w.houseEnv);
    if (host) { await w.kill({restore: false}); await host; }
    runner.run(runner.claude, ['daemon', 'stop', '--any'], {env:w.houseEnv,stdio:'ignore',timeout:10000});
  }
});
