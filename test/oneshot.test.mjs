import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { scratch } from './scratch.mjs';
import { update } from '../src/state.mjs';
import { deliveryDir, saveConv, shortCallGate } from '../src/delivery.mjs';
import { terminalOutcome } from '../src/logins.mjs';
import { runAsync, answerOf } from '../src/grader.mjs';
import { chooseOneShot, runOneShot, refuseOneShot } from '../src/oneshot.mjs';

const setup = () => {
  const HOME = scratch('oneshot-'), env = { HOME, HOUSE_ID: 'h1', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/login', LOOM_BOX_LOCAL_NAME: 'box', LOOM_BOX_HOME: join(HOME, 'state') };
  update(env, s => {
    s.agents = { art: { repo: 'x', logins: ['claude', 'codex'] } };
    s.boxes = { box: { local: true, harnesses: { claude: { loggedIn: true, account: 'a' }, codex: { loggedIn: true, account: 'b' } }, usage: { claude: { windows: { '7d': .2 }, checked: Date.now()/1000 }, codex: { windows: { '7d': .1 }, checked: Date.now()/1000 } } } };
    s.houses = { h1: { agent: 'art', box: 'box', logins: ['claude','codex'], state: 'running' } };
    s.allocator = { mode: 'enforce' };
    s.models = { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }, { id: 'codex', harness: 'codex', family: 'openai' }], agents: { art: { prefer: ['codex','opus'] } } };
  });
  return env;
};
const caller = { kind: 'agent', agent: 'art', house: 'h1' };
test('one-shot uses agent preference, headroom fallback, and only mounted accounts', async () => {
  const env = setup();
  assert.equal((await chooseOneShot(env, caller)).model, 'codex');
  update(env, s => { s.boxes.box.usage.codex.windows['7d'] = .96; });
  await assert.rejects(chooseOneShot(env, caller), /no model|kept for conversations/);
  assert.equal((await chooseOneShot(env, caller, { modelNeed: 'coordinator: test quota fallback' })).model, 'opus');
  update(env, s => { s.houses.h1.logins = ['codex']; });
  await assert.rejects(chooseOneShot(env, caller), /no model|kept for conversations/);
});
test('another house or agent cannot select or hold accounts', async () => {
  const env = setup();
  await assert.rejects(chooseOneShot(env, { ...caller, agent: 'mark' }), /no such house/);
  await assert.rejects(chooseOneShot(env, { kind: 'owner' }), /house/);
  assert.throws(() => refuseOneShot(env, { ...caller, house: 'gone' }, { harness: 'claude' }), /no such house/);
  const pick = await chooseOneShot(env, caller); assert.equal(pick.accountKey, undefined);
  refuseOneShot(env, caller, { harness: 'codex' });
  assert.equal((await chooseOneShot(env, caller, { modelNeed: 'coordinator: test quota fallback' })).model, 'opus');
});
test('runtime reports usage before returning answer, and retries quota refusal only once', async () => {
  const env = { ...setup(), ANTHROPIC_API_KEY: 'private-key' }, calls = [], runs = [];
  const call = async (path, b) => { calls.push([path,b]); return path === 'oneshot-choice' ? { model: 'opus', harness: 'claude' } : { ok: true }; };
  const run = async (bin, argv, opts) => { runs.push([bin,argv,opts]); return { status: 0, stdout: JSON.stringify({ type:'rate_limit_event', rate_limit_info: { status:'allowed', unifiedWindows:{ seven_day: { utilization:.3 } } } })+'\n'+JSON.stringify({ type:'result', result:'VERDICT: CLEAR' }) }; };
  assert.equal(await runOneShot(env, { input:'secret prompt', cwd:env.HOME }, { call, run, warn:()=>{} }), 'VERDICT: CLEAR');
  assert.equal(calls[1][0], 'usage'); assert.equal(calls[1][1].reading.windows['7d'], .3);
  assert.ok(runs[0][1].includes('--safe-mode')); assert.ok(runs[0][1].includes('--permission-prompts')); assert.equal(runs[0][2].env.ANTHROPIC_API_KEY, undefined); assert.equal(runs[0][2].input,'secret prompt'); assert.ok(!JSON.stringify(runs[0][1]).includes('secret prompt'));
  mkdirSync(join(env.HOME,'.codex')); writeFileSync(join(env.HOME,'.codex','auth.json'),'{}');
  const attempts=[], choices=[];
  const retryCall=async(path,b)=>{ if(path==='oneshot-choice'){choices.push(b);return b.avoid.includes('claude')?{model:'codex',harness:'codex'}:{model:'opus',harness:'claude'};}return {ok:true};};
  const result=await runOneShot(env,{input:'p',cwd:env.HOME},{call:retryCall,warn:()=>{},run:async(bin)=>{attempts.push(bin);return bin==='claude'?{status:1,stdout:JSON.stringify({type:'result',is_error:true,error:'rate_limit'})}:{status:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fallback answer'}})};}});
  assert.equal(result,'fallback answer'); assert.deepEqual(attempts,['claude','codex']); assert.deepEqual(choices[1].avoid,['claude']);
});
test('Codex uses a clean home and captures rollout quota before removing it', async () => {
  const env=setup(); mkdirSync(join(env.HOME,'.codex')); writeFileSync(join(env.HOME,'.codex','auth.json'),'{}');
  let childHome, reported;
  const call=async(p,b)=>p==='oneshot-choice'?{model:'codex',harness:'codex'}:(assert.ok(existsSync(childHome)),reported=b,{ok:true});
  const run=async(bin,argv,o)=>{ assert.ok(argv.some((v,i)=>v==='--disable'&&argv[i+1]==='hooks')); assert.ok(argv.some((v,i)=>v==='--disable'&&argv[i+1]==='multi_agent')); assert.deepEqual(argv.slice(argv.indexOf('--sandbox'),argv.indexOf('--sandbox')+2),['--sandbox','read-only']); childHome=o.env.CODEX_HOME; const d=new Date(); const root=join(childHome,'sessions',String(d.getUTCFullYear()),String(d.getUTCMonth()+1).padStart(2,'0'),String(d.getUTCDate()).padStart(2,'0')); mkdirSync(root,{recursive:true});writeFileSync(join(root,'rollout.jsonl'),JSON.stringify({type:'event_msg',payload:{type:'token_count',rate_limits:{primary:{used_percent:25,window_minutes:10080,resets_at:2000000000}}}}));return {status:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}})};};
  assert.equal(await runOneShot(env,{input:'p',cwd:env.HOME},{call,run,warn:()=>{}}),'ok');
  assert.equal(existsSync(childHome),false); assert.equal(reported.reading.windows['7d'],.25); assert.notEqual(childHome,join(env.HOME,'.codex'));
});
test('a refusal followed by timeout never launches a second model', async () => {
  const env=setup();let n=0;
  await assert.rejects(runOneShot(env,{input:'p',cwd:env.HOME},{warn:()=>{},call:async()=>({model:'opus',harness:'claude'}),run:async()=>{n++;return {status:null,signal:'SIGKILL',stdout:JSON.stringify({type:'result',is_error:true,error:'rate_limit'})};}}),/not retried/);
  assert.equal(n,1);
});

test('allow-lists constrain owner preference and the owner preference precedes caller order',async()=>{
 const env=setup();update(env,s=>{s.modelChoices={agents:{art:'claude'}};});
 assert.equal((await chooseOneShot(env,caller,{prefer:['codex']})).model,'opus');
 update(env,s=>{s.models.agents.art.allow=['codex'];});
 assert.equal((await chooseOneShot(env,caller,{prefer:['opus']})).model,'codex');
});
test('a second structured quota refusal stops after two runs',async()=>{
 const env=setup();mkdirSync(join(env.HOME,'.codex'));writeFileSync(join(env.HOME,'.codex','auth.json'),'{}');let runs=0;
 const call=async(p,b)=>p==='oneshot-choice'?(b.avoid.includes('claude')?{model:'codex',harness:'codex'}:{model:'opus',harness:'claude'}):{ok:true};
 await assert.rejects(runOneShot(env,{input:'p',cwd:env.HOME},{call,warn:()=>{},run:async bin=>{runs++;return {status:1,stdout:JSON.stringify(bin==='claude'?{type:'result',is_error:true,error:'rate_limit'}:{type:'error',codex_error_info:'usage_limit_exceeded'})};}}),/failed/);assert.equal(runs,2);
});

test('a recovered refusal returns the completed answer without holding or retrying',async()=>{
 const env=setup(),calls=[];
 const output=[{type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'seven_day'}},{type:'assistant',message:{content:[{type:'text',text:'done'}]}},{type:'result',result:'completed answer'}].map(JSON.stringify).join('\n');
 const answer=await runOneShot(env,{input:'p',cwd:env.HOME},{warn:()=>{},call:async(p,b)=>{calls.push(p);return p==='oneshot-choice'?{model:'opus',harness:'claude'}:{ok:true};},run:async()=>({status:0,stdout:output})});
 assert.equal(answer,'completed answer');assert.deepEqual(calls,['oneshot-choice','usage']);
});
test('quota boundary is 97 percent when worker reserve is in shadow',async()=>{
 const env=setup();update(env,s=>{s.allocator.mode='shadow';s.boxes.box.usage.codex.windows['7d']=.969;});
 assert.equal((await chooseOneShot(env,caller)).model,'codex');
 update(env,s=>{s.boxes.box.usage.codex.windows['7d']=.97;});
 assert.equal((await chooseOneShot(env,caller,{modelNeed:'coordinator: test quota fallback'})).model,'opus');
});
test('short calls account for pending workers and conversation forecast',()=>{
 const env=setup(),now=Date.now(),account={name:'measured',usage:{'7d':.914,checked:now/1000,reset_7d:now/1000+36000}};
 assert.equal(shortCallGate(env,'agent',now)(account).allow,true);
 saveConv(env,{conversation:'cv-123456abcdef',venue:'wake',starting:true});
 assert.equal(shortCallGate(env,'agent',now)(account).allow,false);
 rmSync(join(deliveryDir(env),'conversations'),{recursive:true});
 account.usage['7d']=.82;
 assert.equal(shortCallGate(env,'agent',now)(account).allow,true);
 const readings=Array.from({length:7},(_,i)=>({account:'measured',at:now-(6-i)*3600000,usage:{'7d':.2+i*.01},jobs:0}));
 writeFileSync(join(deliveryDir(env),'allocator-readings.jsonl'),readings.map(JSON.stringify).join('\n'));
 assert.equal(shortCallGate(env,'agent',now)(account).allow,false);
});
test('short-call deadline kills a child process group, including shell grandchildren',async()=>{
 const start=Date.now();const r=await runAsync('/bin/sh',['-c','sleep 3 & wait'],{env:process.env,input:'',timeout:30,killGroup:true});
 assert.equal(r.signal,'SIGKILL');assert.ok(Date.now()-start<1500);
});

test('outer cancellation also kills detached short-call processes',async()=>{
 const pending=runAsync('/bin/sh',['-c','sleep 3 & wait'],{env:process.env,input:'',timeout:10000,killGroup:true});
 const cancel=setTimeout(()=>process.emit('SIGTERM'),30);const r=await pending;clearTimeout(cancel);assert.equal(r.signal,'SIGKILL');
});

test('project Codex config is refused before execution so MCP cannot bypass read-only',async()=>{
 const env=setup(),tree=join(env.HOME,'frozen');mkdirSync(join(tree,'.codex'),{recursive:true});writeFileSync(join(tree,'.codex','config.toml'),'[mcp_servers.writer]\ncommand="write-service"\n');let launched=false;
 await assert.rejects(runOneShot(env,{input:'p',cwd:tree},{call:async()=>({model:'codex',harness:'codex'}),warn:()=>{},run:async()=>{launched=true;}}),/configuration outside/);assert.equal(launched,false);
});
test('successful result-only Claude recovery and Codex stdout recovery keep the answer',async()=>{
 for(const harness of ['claude','codex']){
  const env=setup(),calls=[];mkdirSync(join(env.HOME,'.codex'));writeFileSync(join(env.HOME,'.codex','auth.json'),'{}');
  const events=harness==='claude'?[{type:'result',is_error:true,error:'rate_limit'},{type:'result',is_error:false,result:'done'}]:[{type:'error',codex_error_info:'usage_limit_exceeded'},{type:'item.completed',item:{type:'agent_message',text:'done'}},{type:'turn.completed'}];
  assert.equal(await runOneShot(env,{input:'p',cwd:env.HOME},{warn:()=>{},call:async(p)=>{calls.push(p);return {model:'m',harness};},run:async()=>({status:0,stdout:events.map(JSON.stringify).join('\n')})}),'done');
  assert.deepEqual(calls,['oneshot-choice']);
 }
});
test('a recovered refusal followed by an unrelated failure is not quota-retried',async()=>{
 const env=setup();mkdirSync(join(env.HOME,'.codex'));writeFileSync(join(env.HOME,'.codex','auth.json'),'{}');let runs=0,held=false;
 await assert.rejects(runOneShot(env,{input:'p',cwd:env.HOME},{warn:()=>{},call:async(p)=>{if(p==='oneshot-refused')held=true;return {model:'m',harness:'codex'};},run:async()=>{runs++;return {status:1,stdout:[{type:'error',codex_error_info:'usage_limit_exceeded'},{type:'item.completed',item:{type:'agent_message',text:'recovered'}},{type:'turn.failed',error:{message:'unrelated failure'}}].map(JSON.stringify).join('\n')};}}),/failed/);
 assert.equal(runs,1);assert.equal(held,false);
});
test('a later structured non-quota failure supersedes a quota refusal without an answer',async()=>{
 for(const harness of ['claude','codex']){
  const env=setup();mkdirSync(join(env.HOME,'.codex'));writeFileSync(join(env.HOME,'.codex','auth.json'),'{}');let runs=0,held=false;
  const events=harness==='claude'?[{type:'assistant',isApiErrorMessage:true,error:'rate_limit'},{type:'assistant',isApiErrorMessage:true,error:'server_error'},{type:'result',is_error:true,error:'server_error'}]:[{type:'event_msg',payload:{type:'error',codex_error_info:'usage_limit_exceeded'}},{type:'event_msg',payload:{type:'error',codex_error_info:'server_error'}},{type:'turn.failed',error:{message:'failed'}}];
  await assert.rejects(runOneShot(env,{input:'p',cwd:env.HOME},{warn:()=>{},call:async(p)=>{if(p==='oneshot-refused')held=true;return {model:'m',harness};},run:async()=>{runs++;return {status:1,stdout:events.map(JSON.stringify).join('\n')};}}),/failed/);
  assert.equal(runs,1);assert.equal(held,false);
 }
});
test('Codex rollout and stdout conflicts with a non-quota failure never retry',async()=>{
 for(const quotaInStdout of [true,false]){
  const env=setup();mkdirSync(join(env.HOME,'.codex'));writeFileSync(join(env.HOME,'.codex','auth.json'),'{}');let runs=0,held=false;
  const quota={type:'error',codex_error_info:'usage_limit_exceeded'},other={type:'error',codex_error_info:'server_error'};
  const run=async(_b,_a,o)=>{runs++;const d=new Date(),root=join(o.env.CODEX_HOME,'sessions',String(d.getUTCFullYear()),String(d.getUTCMonth()+1).padStart(2,'0'),String(d.getUTCDate()).padStart(2,'0'));mkdirSync(root,{recursive:true});writeFileSync(join(root,'rollout.jsonl'),JSON.stringify({type:'event_msg',payload:quotaInStdout?other:quota}));return {status:1,stdout:JSON.stringify(quotaInStdout?quota:other)};};
  await assert.rejects(runOneShot(env,{input:'p',cwd:env.HOME},{run,warn:()=>{},call:async(p)=>{if(p==='oneshot-refused')held=true;return {model:'m',harness:'codex'};}}),/failed/);
  assert.equal(runs,1);assert.equal(held,false);
 }
});
test('turn.completed bookkeeping never clears a quota error after an answer',()=>{
 const text=[{type:'item.completed',item:{type:'agent_message',text:'earlier answer'}},{type:'error',codex_error_info:'usage_limit_exceeded'},{type:'turn.completed'}].map(JSON.stringify).join('\n');
 assert.throws(()=>answerOf('codex',text),/failed/);
 assert.equal(terminalOutcome('codex',text).kind,'quota');
});
test('trailing quota metadata preserves a Claude result and still reports usage',async()=>{
 const env=setup(),calls=[];
 const output=[{type:'result',result:'done'},{type:'rate_limit_event',rate_limit_info:{status:'allowed',unifiedWindows:{seven_day:{utilization:.3}}}}].map(JSON.stringify).join('\n');
 assert.equal(await runOneShot(env,{input:'p',cwd:env.HOME},{warn:()=>{},call:async p=>{calls.push(p);return p==='oneshot-choice'?{model:'m',harness:'claude'}:{ok:true};},run:async()=>({status:0,stdout:output})}),'done');assert.deepEqual(calls,['oneshot-choice','usage']);
});
test('a truncated stdout answer cannot discard available Codex rollout usage',async()=>{
 const env=setup();mkdirSync(join(env.HOME,'.codex'));writeFileSync(join(env.HOME,'.codex','auth.json'),'{}');let reported=false,home;
 const run=async(_b,_a,o)=>{home=o.env.CODEX_HOME;const d=new Date(),root=join(home,'sessions',String(d.getUTCFullYear()),String(d.getUTCMonth()+1).padStart(2,'0'),String(d.getUTCDate()).padStart(2,'0'));mkdirSync(root,{recursive:true});writeFileSync(join(root,'rollout.jsonl'),[{type:'response_item',payload:{role:'assistant',type:'message',content:[{text:'done'}]}},{type:'event_msg',payload:{type:'token_count',rate_limits:{primary:{used_percent:20,window_minutes:10080,resets_at:2000000000}}}}].map(JSON.stringify).join('\n'));return {status:0,stdout:JSON.stringify({type:'thread.started',thread_id:'parent'})};};
 await assert.rejects(runOneShot(env,{input:'p',cwd:env.HOME},{run,warn:()=>{},call:async p=>{if(p==='usage'){reported=true;assert.ok(existsSync(home));return {ok:true};}return {model:'m',harness:'codex'};}}),/did not complete/);
 assert.equal(reported,true);assert.equal(existsSync(home),false);
});
test('a new Codex turn clears the preceding turn’s refusal',()=>{
 const text=[{type:'event_msg',payload:{type:'error',codex_error_info:'usage_limit_exceeded'}},{type:'turn_context'},{type:'turn.failed',error:{message:'ordinary failure'}}].map(JSON.stringify).join('\n');assert.equal(terminalOutcome('codex',text).kind,'failed');
});
test('all supported new-turn boundaries clear refusal; Claude tool results do not',()=>{
 const quota={type:'assistant',isApiErrorMessage:true,error:'rate_limit'};
 assert.equal(terminalOutcome('claude',[quota,{type:'user',message:{content:'new question'}},{type:'result',is_error:true}].map(JSON.stringify).join('\n')).kind,'failed');
 assert.equal(terminalOutcome('claude',[quota,{type:'user',message:{content:[{type:'tool_result',content:'bookkeeping'}]}}].map(JSON.stringify).join('\n')).kind,'quota');
 assert.equal(terminalOutcome('codex',[{type:'error',codex_error_info:'usage_limit_exceeded'},{type:'turn.started'},{type:'turn.failed'}].map(JSON.stringify).join('\n')).kind,'failed');
});
test('oversized process output fails closed but preserves later quota events',async()=>{
 const event={type:'rate_limit_event',rate_limit_info:{status:'allowed',unifiedWindows:{seven_day:{utilization:.7}}}};
 const script=`process.stdout.write(JSON.stringify({type:'result',result:'stale success'})+'\\n');process.stdout.write(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'allowed',unifiedWindows:{five_hour:{utilization:.9}}}})+'\\n');process.stdout.write('x'.repeat(9*1024*1024)+'\\n');process.stdout.write(${JSON.stringify(JSON.stringify(event))}+'\\n');process.stdout.write(JSON.stringify({type:'assistant',isApiErrorMessage:true,error:'authentication_failed'})+'\\n');`;
 const captured=await runAsync(process.execPath,['-e',script],{env:process.env,input:'',timeout:5000,killGroup:true});
 assert.equal(captured.truncated,true);assert.equal(captured.readings.claude.windows['7d'],.7); assert.equal(captured.readings.claude.windows['5h'],.9);
 const env=setup();let reported=false,held=false,runs=0;
 await assert.rejects(runOneShot(env,{input:'p',cwd:env.HOME},{warn:()=>{},run:async()=>{runs++;return captured;},call:async(p,b)=>{if(p==='usage'){reported=true;assert.equal(b.reading.windows['7d'],.7);return {ok:true};}if(p==='oneshot-refused')held=true;return {model:'m',harness:'claude'};}}),/output limit/);
 assert.equal(reported,true);assert.equal(held,false);assert.equal(runs,1);
});
test('answer extraction cannot reuse an answer from the preceding turn',()=>{
 assert.throws(()=>answerOf('codex',[{type:'item.completed',item:{type:'agent_message',text:'old'}},{type:'turn.completed'},{type:'turn.started'}].map(JSON.stringify).join('\n')),/did not complete/);
 assert.throws(()=>answerOf('claude',[{type:'result',result:'old'},{type:'user',message:{content:'next'}}].map(JSON.stringify).join('\n')),/did not complete/);
 assert.equal(answerOf('codex',[{type:'item.completed',item:{type:'agent_message',text:'old'}},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'new'}},{type:'turn.completed'}].map(JSON.stringify).join('\n')),'new');
});

test('a new unspecified one-shot uses runtime default rather than an old body model', async () => {
 const env = { ...setup(), LOOM_BODY_MODEL: 'old-codex' };
 update(env,s=>{s.models.list.push({id:'gpt-6.1-sol',harness:'codex',family:'openai'});s.models.agents.art.prefer=['codex','opus'];});
 mkdirSync(join(env.HOME,'.codex')); writeFileSync(join(env.HOME,'.codex','auth.json'),'{}');
 let preference;
 const result = await runOneShot(env,{input:'p',cwd:env.HOME},{warn:()=>{},call:async(path,b)=>{
  if(path==='oneshot-choice'){preference=b.prefer;return chooseOneShot(env,caller,b);}
  return {ok:true};
 },run:async(bin,argv)=>{assert.equal(argv[argv.indexOf('-m')+1],'gpt-6.1-sol');return {status:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}})};}});
 assert.equal(result,'ok'); assert.deepEqual(preference,[]);
});

 test('managed Codex login home permits only the user config above a frozen tree', async () => {
  const env = setup();
  env.CODEX_HOME = join(env.HOME, 'runtime-managed');
  mkdirSync(env.CODEX_HOME);
  writeFileSync(join(env.CODEX_HOME, 'auth.json'), '{}');
  mkdirSync(join(env.HOME, '.codex'));
  writeFileSync(join(env.HOME, '.codex', 'config.toml'), '[mcp_servers.writer]\ncommand="writer"\n');
  const tree = join(env.HOME, 'scratch', 'tree');
  mkdirSync(tree, { recursive: true });
  let runs = 0;
  const opts = { warn: () => {}, call: async () => ({ model: 'm', harness: 'codex' }), run: async (_bin, _argv, o) => {
    runs++;
    assert.notEqual(o.env.CODEX_HOME, env.CODEX_HOME);
    assert.deepEqual(readdirSync(o.env.CODEX_HOME), ['auth.json']);
    assert.equal(readlinkSync(join(o.env.CODEX_HOME, 'auth.json')), join(env.CODEX_HOME, 'auth.json'));
    assert.equal(existsSync(join(o.env.CODEX_HOME, 'config.toml')), false);
    return { status: 0, stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) };
  } };
  assert.equal(await runOneShot(env, { input: 'p', cwd: tree }, opts), 'ok');
  for (const at of [tree, join(env.HOME, 'scratch')]) {
    mkdirSync(join(at, '.codex'), { recursive: true });
    writeFileSync(join(at, '.codex', 'config.toml'), '');
    await assert.rejects(runOneShot(env, { input: 'p', cwd: tree }, opts), /configuration outside/);
    rmSync(join(at, '.codex'), { recursive: true });
  }
  // If HOME itself is the project root, its .codex is a project layer.
  mkdirSync(join(env.HOME, '.git'));
  await assert.rejects(runOneShot(env, { input: 'p', cwd: tree }, opts), /configuration outside/);
  assert.equal(runs, 1);
 });

test('cold review rejects physical project config through symlink cwd and uninspectable layers', async () => {
  const env = setup(), tree = join(env.HOME, 'physical', 'sub'), alias = join(env.HOME, 'alias');
  mkdirSync(tree, { recursive: true });
  mkdirSync(join(env.HOME, 'physical', '.codex'));
  writeFileSync(join(env.HOME, 'physical', '.codex', 'config.toml'), '');
  symlinkSync(join(env.HOME, 'physical'), alias);
  let runs = 0;
  const opts = { warn: () => {}, call: async () => ({ model: 'm', harness: 'codex' }), run: async () => { runs++; } };
  await assert.rejects(runOneShot(env, { input: 'p', cwd: join(alias, 'sub') }, opts), /configuration outside/);
  rmSync(join(env.HOME, 'physical', '.codex'), { recursive: true });
  // A loop yields ELOOP looking up config.toml, even under root: not ENOENT.
  symlinkSync('.codex', join(tree, '.codex'));
  await assert.rejects(runOneShot(env, { input: 'p', cwd: tree }, opts), /configuration outside/);
  assert.equal(runs, 0);
});

test('managed cold review canonicalizes aliased HOME and still refuses physical project layers', async () => {
  const env = setup(), physical = env.HOME, alias = join(physical, 'alias-home');
  symlinkSync(physical, alias);
  env.HOME = alias;
  env.CODEX_HOME = join(alias, 'managed');
  mkdirSync(env.CODEX_HOME);
  writeFileSync(join(env.CODEX_HOME, 'auth.json'), '{}');
  mkdirSync(join(alias, '.codex'));
  writeFileSync(join(alias, '.codex', 'config.toml'), '');
  const tree = join(alias, 'frozen'); mkdirSync(tree);
  let runs = 0;
  const opts = { warn: () => {}, call: async () => ({ model: 'm', harness: 'codex' }), run: async () => {
    runs++; return { status: 0, stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) };
  } };
  assert.equal(await runOneShot(env, { input: 'p', cwd: tree }, opts), 'ok');
  mkdirSync(join(tree, '.codex')); writeFileSync(join(tree, '.codex', 'config.toml'), '');
  await assert.rejects(runOneShot(env, { input: 'p', cwd: tree }, opts), /configuration outside/);
  assert.equal(runs, 1);
});
