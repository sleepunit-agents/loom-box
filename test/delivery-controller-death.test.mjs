import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, setAgent } from '../src/control.mjs';
import { load, update } from '../src/state.mjs';
import { setModels } from '../src/models.mjs';
import { loadConv } from '../src/delivery.mjs';
import { readBody } from '../src/bodies.mjs';
import { readHouseLaunch } from '../src/house-launch-journal.mjs';
import { readLaunch } from '../src/launch-journal.mjs';
import { HouseRunner, hostOf } from '../src/houserunner.mjs';
import { runnerFor } from '../src/runners.mjs';
import { scratch } from './scratch.mjs';
import { fakeLoomBin } from './delivery-world.mjs';
const here=dirname(fileURLToPath(import.meta.url)),cli=join(here,'../src/cli.mjs');
const hasAge=spawnSync('age',['--version']).status===0;
const cvOf=(agent,venue,place)=>'cv-'+createHash('sha256').update(`${agent}\0${venue}\0${place}`).digest('hex').slice(0,12);
const wait=async f=>{const end=Date.now()+20000;for(;;){const value=f();if(value)return value;if(Date.now()>end)throw Error('controller death fixture timed out');await new Promise(r=>setTimeout(r,20));}};
function child(args,env,input='',cwd){
  const processChild=spawn(process.execPath,args,{env,cwd,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  processChild.stdout.on('data',x=>{stdout+=x;});processChild.stderr.on('data',x=>{stderr+=x;});
  const done=new Promise((resolve,reject)=>{processChild.on('error',reject);processChild.on('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
  processChild.stdin.end(input);return{process:processChild,done};
}
async function serverFor(env,holdReceipts=false){
  const seqs=new Map(),bound=[];let held=false,release;const gate=new Promise(r=>{release=r;});
  const server=createServer((request,response)=>{let raw='';request.on('data',x=>{raw+=x;});request.on('end',async()=>{
    const send=(status,body)=>{response.statusCode=status;response.setHeader('content-type','application/json');response.end(JSON.stringify(body));};
    try{
      const body=JSON.parse(raw||'{}'),token=(request.headers.authorization??'').replace(/^Bearer /,'');
      if(request.url.startsWith('/api/loom/')){
        if(token!=='fixture-runtime-token')return send(403,{error:'wrong runtime credential'});
        // Which conversation a house holds (t-2061): the runtime says so before it hands the house a body.
        if(request.url==='/api/loom/conversations/house'){bound.push(`${body.house}:${body.conversation}`);return send(200,{house:body.house,conversation:body.conversation});}
        if(request.url==='/api/loom/conversations/turn'){const cv=cvOf(body.agent,body.venue,body.place),seq=(seqs.get(cv)??0)+1;seqs.set(cv,seq);return send(200,{conversation:cv,seq});}
        if(request.url==='/api/loom/audit')return send(200,{conversation:body.conversation,seq:body.seq});
        if(request.url==='/api/loom/venues')return send(200,{venues:[{name:'slack',kind:'live',piece:'slack',send:[process.execPath,join(here,'fake-send.mjs')]}]});
        return send(404,{error:'not found'});
      }
      const path=/^\/api\/box\/([a-z-]+)$/.exec(request.url)?.[1];
      if(!path||token!=='fixture-house-token')return send(403,{error:'wrong house credential'});
      if(holdReceipts&&path==='body-sync'&&Object.values(body.report?.done??{}).some(d=>d.id)){held=true;await gate;}
      const result=await api(env,{now:()=>new Date()},{caller:{kind:'agent',agent:'art',house:'h-1'},path,body});send(result.status,result.body);
    }catch{send(500,{error:'fixture request failed'});}
  });});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return{url:`http://127.0.0.1:${server.address().port}/mcp`,held:()=>held,bound,release,close:()=>new Promise(r=>server.close(r))};
}
for(const boundary of ['reserved-before-publication','before-house-receipt','after-house-receipt','after-conversation-commit'])for(const harness of ['claude','codex'])test(`${harness}: actual controller SIGKILL ${boundary} recovers through fresh CLI delivery without duplicate native work`,{skip:!hasAge},async()=>{
  const root=scratch('delivery-controller-death-'),home=join(root,'controller'),house=join(root,'house'),place='dm:os-controller-death',cv=cvOf('art','slack',place);
  const env={PATH:process.env.PATH,HOME:home,LOOM_HOME:join(home,'.config/loom'),LOOM_BOX_HOME:join(root,'state'),LOOM_BOX_DATA:join(root,'data'),LOOM_BOX_LOCAL_NAME:'one',
    LOOM_RUNTIME_ACCOUNTS:'none',LOOM_RUNTIME_SCORECARDS:'off',LOOM_RUNTIME_TOKEN_FILE:join(root,'runtime-token')};
  mkdirSync(env.LOOM_HOME,{recursive:true});writeFileSync(env.LOOM_RUNTIME_TOKEN_FILE,'fixture-runtime-token\n');env.LOOM_BIN=fakeLoomBin(root);
  const sends=join(root,'sends');mkdirSync(sends);const priorSend=process.env.FAKE_SEND;process.env.FAKE_SEND=sends;env.FAKE_SEND=sends;
  const server=await serverFor(env,boundary==='before-house-receipt');env.LOOM_RUNTIME_LOOM_URL=server.url;
  setAgent(env,{now:()=>new Date()},{agent:'art',repo:'https://example.com/art.git'});
  setModels(env,{list:[{id:harness==='claude'?'opus':'gpt-5.5',harness,family:harness==='claude'?'anthropic':'openai'}]});
  update(env,s=>{const box=Object.values(s.boxes).find(b=>b.local);box.harnesses={[harness]:{loggedIn:true}};});
  mkdirSync(join(house,'work'),{recursive:true});writeFileSync(join(house,'token'),'fixture-house-token\n');
  const houseEnv={PATH:process.env.PATH,HOME:house,LOOM_URL:server.url,LOOM_TOKEN_FILE:join(house,'token'),HOUSE_ID:'h-1',HOUSE_AGENT:'art',FAKE_HARNESS:house,
    LOOM_RUNTIME_CLAUDE:join(here,'fake-claude.mjs'),LOOM_RUNTIME_CLAUDE_JOBS:join(house,'jobs'),LOOM_RUNTIME_CODEX:join(here,'fake-codex.mjs'),LOOM_RUNTIME_CODEX_RUNS:join(house,'runs'),
    ...(harness==='claude'?{CLAUDE_SECURESTORAGE_CONFIG_DIR:join(house,'login')}:{LOOM_LOGIN_CODEX:join(house,'login')})};
  houseEnv.LOOM_RUNTIME_NATIVE_HISTORY=join(house,'native');mkdirSync(houseEnv.LOOM_RUNTIME_NATIVE_HISTORY);
  houseEnv.CLAUDE_CONFIG_DIR=house;
  const marker=join(root,'ready-before-conversation-commit.json');
  const program=`import{readFileSync,writeFileSync,renameSync}from'node:fs';import{deliver}from${JSON.stringify(new URL('../src/delivery.mjs',import.meta.url).href)};import{HouseRunner}from${JSON.stringify(new URL('../src/houserunner.mjs',import.meta.url).href)};import{readHouseLaunch}from${JSON.stringify(new URL('../src/house-launch-journal.mjs',import.meta.url).href)};import{coreFrom}from${JSON.stringify(new URL('../src/core.mjs',import.meta.url).href)};
const boundary=${JSON.stringify(boundary)},marker=${JSON.stringify(marker)};
const mark=(handle,id)=>{writeFileSync(marker+'.tmp',JSON.stringify({handle,id,pid:process.pid}));renameSync(marker+'.tmp',marker);};
class Held extends HouseRunner{
 async prepareLaunch(id,options,resume){const handle=await super.prepareLaunch(id,options,resume);if(boundary==='reserved-before-publication'){mark(handle,null);await new Promise(()=>setInterval(()=>{},1000));}return handle;}
 async waitPreparedLaunch(handle){const body=await super.waitPreparedLaunch(handle);if(boundary==='after-house-receipt'){mark(handle,body.id);await new Promise(()=>setInterval(()=>{},1000));}return body;}
 acknowledgePreparedLaunch(handle){if(boundary==='after-conversation-commit'){mark(handle,readHouseLaunch(process.env,handle.id).body.id);process.kill(process.pid,'SIGSTOP');}return super.acknowledgePreparedLaunch(handle);}
}
let drained;await deliver(process.env,JSON.parse(readFileSync(0,'utf8')),{runner:h=>new Held(process.env,h,{bindHouse:b=>coreFrom(process.env).bindHouse(b)}),onDrain:p=>{drained=p}});await drained;`;
  const message={source:'slack',id:'owned-os-death-fixture',agent:'art',venue:'slack',place,label:'fixture',from:{kind:'person',slug:'loren'},kind:'message',at:new Date().toISOString(),text:'harmless isolated controller recovery fixture'};
  const original=child(['--input-type=module','-e',program],env,JSON.stringify(message));let host,replacement,prepared,handle;
  try{
    const allocation=await wait(()=>load(env).houses['h-1']);
    const boot=/--host-key ([0-9a-f]{48})/.exec(allocation.task)?.[1];assert.ok(boot);
    host=child([cli,'body-host','--piece','box','--host-key',boot,'--beats','100'],houseEnv,'',join(house,'work'));
    if(boundary==='before-house-receipt')await wait(()=>server.held());
    else await wait(()=>existsSync(marker));
    const before=loadConv(env,cv),witness=boundary==='before-house-receipt'?null:JSON.parse(readFileSync(marker,'utf8'));
    prepared=before.starting?.prepared;handle=prepared?.handle??witness?.handle??before.launchAcks[0];
    const expected=prepared?{run:prepared.snapshot.run,sender:prepared.snapshot.senderHash,instance:prepared.bodySpec.metadata.instance}:{run:before.run,sender:before.sendKey,instance:readBody(env,before.body).instance};
    if(prepared){assert.equal(before.starting.pid,original.process.pid);assert.equal(before.body,undefined);}
    else{assert.equal(witness.pid,original.process.pid);assert.ok(before.body);assert.equal(before.runs,1);}
    assert.equal(readHouseLaunch(env,handle.id).state,boundary==='reserved-before-publication'?'reserved':boundary==='before-house-receipt'?'published':'ready');
    if(boundary==='reserved-before-publication')assert.equal(existsSync(join(house,'argv.log')),false,'reservation has not invoked a native executable');
    assert.equal(before.actsFor.owner,false);assert.equal(handle.seat,`p-loren.${cv}`);
    original.process.kill('SIGKILL');assert.equal((await original.done).signal,'SIGKILL');
    assert.equal(host.process.exitCode,null,'the independent house host survives controller death');
    server.release();
    if(boundary!=='reserved-before-publication')await wait(()=>readHouseLaunch(env,handle.id).state==='ready');
    replacement=child([cli,'deliver','tick','--conversation',cv],env);
    const result=await replacement.done;assert.equal(result.code,0,result.stderr);
    const after=loadConv(env,cv),originalId=after.body.split(':')[1];
    assert.ok(server.bound.includes(`h-1:${cv}`),`core was told h-1 holds this conversation before its body ran: ${JSON.stringify(server.bound)} ${cv}`);
    if(boundary==='reserved-before-publication'){
      assert.equal(readHouseLaunch(env,handle.id).state,'refused','the dead registrar reservation was cancelled before retry');
      assert.notEqual(after.run,expected.run);assert.notEqual(after.sendKey,expected.sender);
      assert.equal(new HouseRunner(env,harness).publishPreparedLaunch(handle),'refused','late publication of the cancelled reservation cannot admit work');
    }else{
      assert.equal(after.body,`${harness}:${readHouseLaunch(env,handle.id).body.id}`);
      if(witness)assert.equal(originalId,witness.id);
      assert.equal(after.run,expected.run);assert.equal(after.sendKey,expected.sender);
      assert.equal(readBody(env,after.body).instance,expected.instance);
    }
    assert.deepEqual(after.actsFor,before.actsFor);assert.equal(after.runs,1);assert.equal(after.starting,undefined);assert.equal(after.launchAcks,undefined);
    assert.equal(hostOf(env,'art',`p-loren.${cv}`).req[handle.rid],undefined);
    const raw=originalId.replace(/^h-1-/,'');
    const session=await wait(()=>hostOf(env,'art',`p-loren.${cv}`).report?.bodies?.[raw]?.session);
    const bodyEnv={...houseEnv,...(harness==='claude'?{CLAUDE_CODE_SESSION_ID:session}:{CODEX_THREAD_ID:session})};
    const reply=await child([cli,'send','--conversation',cv,'--piece','box','--text','recovered sender proof'],bodyEnv,'',join(house,'work')).done;
    assert.equal(reply.code,0,reply.stdout+reply.stderr);assert.equal(JSON.parse(reply.stdout).posted,true);
    const posted=readFileSync(join(sends,'calls.log'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(posted.length,1);assert.equal(posted[0].text,'recovered sender proof');
    const calls=readFileSync(join(house,'argv.log'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(a=>harness==='claude'?a[0]==='--bg':a.args?.[0]==='exec').length,1);
    assert.equal(Object.keys(load(env).houses).length,1);
  }finally{
    if(original.process.exitCode===null&&original.process.signalCode===null)original.process.kill('SIGKILL');
    if(replacement&&replacement.process.exitCode===null&&replacement.process.signalCode===null)replacement.process.kill('SIGKILL');
    server.release();
    const pending=handle?.id??loadConv(env,cv)?.starting?.prepared?.id;
    let record=pending&&readLaunch(houseEnv,pending);
    if(!record&&loadConv(env,cv)?.body){const current=loadConv(env,cv).body.split(':')[1].replace(/^h-1-/,'');const runner=runnerFor(harness,houseEnv);runner.end({id:current},houseEnv);if(runner.stopped)await wait(()=>runner.stopped({id:current}));}
    if(record){const runner=runnerFor(harness,houseEnv),body=record.body??runner.recoverLaunch(record.token,{env:houseEnv}).body;if(body){runner.end(body,houseEnv);if(runner.stopped)await wait(()=>runner.stopped(body));}}
    if(host&&host.process.exitCode===null&&host.process.signalCode===null)host.process.kill('SIGTERM');
    await original.done;if(replacement)await replacement.done;if(host)await host.done;await server.close();if(priorSend===undefined)delete process.env.FAKE_SEND;else process.env.FAKE_SEND=priorSend;
  }
});
