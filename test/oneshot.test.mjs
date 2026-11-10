import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { scratch } from './scratch.mjs';
import { update } from '../src/state.mjs';
import { deliveryDir, saveConv, shortCallGate } from '../src/delivery.mjs';
import { runAsync } from '../src/grader.mjs';
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
  assert.equal((await chooseOneShot(env, caller)).model, 'opus');
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
  assert.equal((await chooseOneShot(env, caller)).model, 'opus');
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
  const run=async(bin,argv,o)=>{ assert.ok(argv.some((v,i)=>v==='--disable'&&argv[i+1]==='hooks')); assert.deepEqual(argv.slice(argv.indexOf('--sandbox'),argv.indexOf('--sandbox')+2),['--sandbox','read-only']); childHome=o.env.CODEX_HOME; const d=new Date(); const root=join(childHome,'sessions',String(d.getUTCFullYear()),String(d.getUTCMonth()+1).padStart(2,'0'),String(d.getUTCDate()).padStart(2,'0')); mkdirSync(root,{recursive:true});writeFileSync(join(root,'rollout.jsonl'),JSON.stringify({type:'event_msg',payload:{type:'token_count',rate_limits:{primary:{used_percent:25,window_minutes:10080,resets_at:2000000000}}}}));return {status:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}})};};
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
 assert.equal((await chooseOneShot(env,caller)).model,'opus');
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
