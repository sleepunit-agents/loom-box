import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { world, houseWorld } from '../delivery-world.mjs';
import { api } from '../../src/control.mjs';
import { load } from '../../src/state.mjs';
import { setModels } from '../../src/models.mjs';
import { continuationCall, deliver, handOverWake, loadConv, tick } from '../../src/delivery.mjs';

// DRAFT, NOT YET HOST-EXECUTED. Codex only; source holder is synthetic.
// Clock SIGKILL/replay -> authenticated companion core -> HouseRunner -> real
// container body-host -> actual Codex shell -> continuation enqueue -> core receipt.
// Principal handoff and the house-token API transport use isolated test bridges.
// No installed service is a target. See docs/continuation-provider-bench.md.
test('OPT-IN actual Codex: SIGKILL clock receipt replay admits one native child and its provider submits one report', {
  skip: process.env.CONTINUATION_PROVIDER_OPT_IN !== 'actual-codex', timeout: 240000,
}, async t => {
  for (const [key,sha] of [['CONTINUATION_CORE','cd0713deefe2d819b7325cf7c75b8148e69f0c27'],['CONTINUATION_CLOCK','3ec64bace24c2f03bd58b86ac2c6acee16c4b1ef']]) {
    assert.ok(process.env[key],key+' is required');
    const r=spawnSync('git',['-C',process.env[key],'rev-parse','HEAD'],{encoding:'utf8'});
    assert.equal(r.status,0);assert.equal(r.stdout.trim(),sha,'exact companion revision');
  }
  assert.ok(process.env.CONTINUATION_PROVIDER_MODEL,'explicit model required');
  assert.ok(process.env.CONTINUATION_PROVIDER_AUTH,'explicit login file required');
  const w = world(), h = houseWorld({harness:'codex', claimMs:120000, warmMs:120000});
  w.env=h.env; w.o.now=()=>new Date(); w.o.sealer=h.sealer;
  w.env.PATH=process.env.PATH; w.env.LOOM_RUNTIME_TOKEN_FILE=join(w.env.HOME,'runtime-token');
  const deliveries = [], children = [], hosts = [];
  const pod=args=>spawnSync('podman',args,{encoding:'utf8',timeout:30000,killSignal:'SIGKILL'});
  const image=process.env.CONTINUATION_PROVIDER_IMAGE, codex=process.env.CONTINUATION_PROVIDER_CODEX;
  assert.match(image, /@sha256:[0-9a-f]{64}$/, 'pin an existing image by digest');
  assert.match(codex, /^\/[A-Za-z0-9_./-]+$/, 'explicit actual provider CLI path inside image');
  assert.equal(pod(['image','exists',image]).status,0,'never pull or build');
  const check=pod(['run','--rm','--pull=never','--network=none','--entrypoint',codex,image,'--version']);
  assert.equal(check.status,0,check.stderr); assert.match(check.stdout,/codex/i);
  const node=pod(['run','--rm','--pull=never','--network=none','--entrypoint','node',image,'-p','process.execPath']);
  assert.equal(node.status,0,node.stderr);const imageNode=node.stdout.trim();
  assert.match(imageNode,/^\/[A-Za-z0-9_./-]+$/);
  let stopping=false;
  const wait=async(fn,label)=>{const end=Date.now()+150000;while(!fn()){if(stopping)throw Error('bench shutting down');if(Date.now()>end)throw Error('provider bench deadline: '+label);await new Promise(r=>setTimeout(r,25));}};
  const dir=join(w.env.HOME,'provider-house');mkdirSync(join(dir,'work'),{recursive:true});
  mkdirSync(join(dir,'native'),{mode:0o700}); // production mounts a pre-created per-house native history dir (src/house.mjs)
  mkdirSync(join(dir,'codex'));copyFileSync(process.env.CONTINUATION_PROVIDER_AUTH,join(dir,'codex','auth.json'));chmodSync(join(dir,'codex','auth.json'),0o600);
  writeFileSync(join(dir,'token'),'isolated-house-token',{mode:0o600});
  let bridgeUrl, hostExit=null;
  const hostTask=(async()=>{
    await wait(()=>load(h.env).houses['h-1'],'house allocation');
    const box={kind:'piece',subject:Object.keys(load(h.env).boxes).find(k=>load(h.env).boxes[k].local)};
    const call=async(path,body)=>{const r=await api(h.env,{mint:()=> 'unused',revoke(){},secret:()=>''},{caller:box,path,body});assert.equal(r.status,200);return r.body;};
    await call('claim',{id:'h-1',nativeHistory:1});await call('report',{id:'h-1',state:'running'});
    const boot=/--host-key ([0-9a-f]{48})/.exec(load(h.env).houses['h-1'].task)[1];
    const name='loom-continuation-provider-'+process.pid;hosts.push(name);
    const env={HOME:'/fixture/house',PATH:imageNode.slice(0,imageNode.lastIndexOf('/'))+':/usr/local/bin:/usr/bin:/bin',HOUSE_ID:'h-1',HOUSE_AGENT:'art',LOOM_URL:bridgeUrl,LOOM_TOKEN_FILE:'/fixture/house/token',CODEX_HOME:'/fixture/house/codex',LOOM_LOGIN_CODEX:'/fixture/house/codex',LOOM_RUNTIME_CODEX:codex,LOOM_RUNTIME_CODEX_RUNS:'/fixture/house/runs',LOOM_RUNTIME_NATIVE_HISTORY:'/fixture/house/native',LOOM_RUNTIME_INBOX_DIR:'/fixture/house/inbox'};
    const host=spawn('podman',['run','--rm','--pull=never','--name',name,'--network=host','-v',dir+':/fixture/house','-v',join(import.meta.dirname,'../..')+':/runtime:ro','-w','/fixture/house/work',...Object.entries(env).flatMap(([k,v])=>['-e',k+'='+v]),'--entrypoint',imageNode,image,'/runtime/src/cli.mjs','body-host','--piece','runtime','--host-key',boot,'--beats','600'],{stdio:['ignore','ignore','pipe']});
    if(process.env.CONTINUATION_DIAG_HOST_LOG){const {createWriteStream}=await import('node:fs');host.stderr.pipe(createWriteStream(process.env.CONTINUATION_DIAG_HOST_LOG,{mode:0o600}));}
    else host.stderr.resume(); // Never copy provider output or credentials to test diagnostics.
    host.once('exit',(c,sg)=>{hostExit={c,sg};});
    host.once('error',()=>{});return host;
  })();
  hostTask.catch(()=>{}); // Cleanup observes failures; suppress unhandled rejection during earlier assertions.
  // No host allocation before authenticated clock admission. The promise is bounded,
  // and cleanup below tears down only this test's uniquely named container.
  t.after(async()=>{stopping=true;await hostTask.catch(()=>{});for(const name of hosts){pod(['rm','-f','--time','0',name]);assert.equal(pod(['container','exists',name]).status,1);}});
  const childOptions={...w.o,runner:()=>h.hr,accounts:h.accounts};

  const bridge = createServer(async (req,res) => {
    try {
      let raw=''; for await (const c of req) raw+=c;
      if(req.url.startsWith('/api/runtime/')) {
        assert.equal(req.headers.authorization,'Bearer isolated-house-token');
        const r=await api(h.env,{now:()=>new Date()},{caller:{kind:'agent',agent:'art',house:'h-1'},path:req.url.split('/').at(-1),body:JSON.parse(raw)});
        res.writeHead(r.status,{'content-type':'application/json'});res.end(JSON.stringify(r.body));return;
      }
      const { mode, input } = JSON.parse(raw);
      if (mode === 'principal') {
        handOverWake(w.env, {agent:'art', place:input[ input.indexOf('--place')+1 ], id:input[input.indexOf('--id')+1], for:'owner'});
        res.end('{}'); return;
      }
      assert.notEqual(mode,'api','holder calls must use the production executable');
      assert.equal(mode,'deliver'); deliveries.push(input);
      const answer=await deliver(w.env,input,childOptions); children.push(answer);
      res.end(JSON.stringify(answer));
    } catch(e) { res.statusCode=500; res.end(JSON.stringify({error:e.message})); }
  });
  bridge.listen(0,'127.0.0.1'); await once(bridge,'listening');
  t.after(()=>{bridge.closeAllConnections();bridge.close();});
  bridgeUrl=`http://127.0.0.1:${bridge.address().port}`;
  const coreHome=join(w.env.HOME,'core'); mkdirSync(coreHome);
  const core=fork(new URL('../fixtures/continuation-core.mjs',import.meta.url),[],{env:{...process.env,...w.env,LOOM_HOME:coreHome,CONTINUATION_TEST_TIME:'',CONTINUATION_BRIDGE:bridgeUrl,CONTINUATION_RUNTIME_CLI:join(import.meta.dirname,'../../src/cli.mjs')},stdio:['ignore','ignore','pipe','ipc']});
  t.after(()=>core.kill('SIGKILL'));
  let errors='';core.stderr.on('data',b=>errors+=b);
  const setup=await Promise.race([once(core,'message').then(([v])=>v),once(core,'exit').then(([c])=>{throw Error(`core ${c}: ${errors}`);})]);
  w.env.LOOM_HOME=coreHome;
  writeFileSync(w.env.LOOM_RUNTIME_TOKEN_FILE,setup.token);
  w.env.LOOM_RUNTIME_LOOM_URL=`http://127.0.0.1:${setup.port}/mcp`;
  w.o.core=undefined;childOptions.core=undefined;
  setModels(h.env,{list:[{id:'opus',harness:'claude',family:'anthropic'}],agent:'art',prefer:['opus']});
  const source=await deliver(w.env,w.msg(setup.place,'owner',{source:'loom',venue:'loom',place:setup.place,from:{kind:'person',slug:'jonathan'}}),w.o);
  const proof=cv=>{const c=loadConv(w.env,cv);return {conversation:cv,key:w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY,session:w.runner.slotOf({id:c.body.split(':')[1]}).session};};
  const holder=async(action,b)=>{const r=await fetch(`http://127.0.0.1:${setup.port}/api/runtime/continuation-${action}`,{method:'POST',headers:{authorization:`Bearer ${setup.agentToken}`,'content-type':'application/json'},body:JSON.stringify(b)});return {status:r.status,body:await r.json()};};
  // Production executable must retain its policy hold. Only this trusted test
  // parent supplies a lifetime; enqueue/status still use the unchanged executable.
  const issued=await holder('issue',proof(source.conversation));
  assert.notEqual(issued.status,200,JSON.stringify(issued));
  assert.match(JSON.stringify(issued.body), /deadline policy is not configured/);
  const grant=continuationCall(w.env,{...proof(source.conversation),action:'issue'},w.o);
  setModels(h.env,{list:[{id:process.env.CONTINUATION_PROVIDER_MODEL,harness:'codex',family:'openai'}],agent:'art',prefer:[process.env.CONTINUATION_PROVIDER_MODEL]});
  const bin=join(w.env.HOME,'bin');mkdirSync(bin);
  for (const name of ['systemctl','systemd-run']) writeFileSync(join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const principal=join(bin,'principal.mjs');
  writeFileSync(principal,`const r=await fetch(${JSON.stringify(bridgeUrl)},{method:'POST',body:JSON.stringify({mode:'principal',input:process.argv.slice(2)})});if(!r.ok)process.exit(1);`);
  const tokenFile=join(w.env.HOME,'clock-token');writeFileSync(tokenFile,setup.clockToken);
  const clockDir=join(w.env.HOME,'clock','art');mkdirSync(clockDir,{recursive:true});
  const entry={id:'w-abcdef',kind:'wake',created:'2026-11-09 00:00:00',at:'2026-11-09 00:00:00',prompt:`This is an isolated integration bench. Use your shell tool to run exactly: ${imageNode} /runtime/test/fixtures/continuation-provider-report.mjs ${grant.handle} . Wait for it to finish, then stop. Do not inspect credentials or do any other work.`,for:'owner',continuation:{handle:grant.handle,expiresAt:grant.expiresAt,wake:'w-abcdef'}};
  writeFileSync(join(clockDir,'spool.jsonl'),JSON.stringify(entry)+'\n');
  let holdReceipt=true, accepted;const acceptance=new Promise(r=>accepted=r);const clockBodies=[];
  const proxy=createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;clockBodies.push(JSON.parse(body));
    const answer=await fetch(`http://127.0.0.1:${setup.port}${req.url}`,{method:req.method,headers:{authorization:req.headers.authorization,'content-type':'application/json'},body});
    const text=await answer.text();
    if(holdReceipt){assert.equal(answer.status,200,text);accepted();return;}
    res.writeHead(answer.status,{'content-type':'application/json'});res.end(text);
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  t.after(()=>{proxy.closeAllConnections();proxy.close();});
  const fire=()=>spawn('python3',[join(process.env.CONTINUATION_CLOCK,'bin/wake'),'fire',entry.id],{env:{...process.env,HOME:w.env.HOME,PATH:`${bin}:${process.env.PATH}`,WAKE_DATA:join(w.env.HOME,'clock'),WAKE_LOCAL_AGENT:'art',WAKE_AGENT:'art',WAKE_FIRE:'house',WAKE_DELIVERY:'deliver',WAKE_LOOM_URL:`http://127.0.0.1:${proxy.address().port}`,WAKE_DELIVER_TOKEN_FILE:tokenFile,WAKE_PRINCIPAL:JSON.stringify([process.execPath,principal]),HOUSE_ID:''},stdio:['ignore','pipe','pipe']});
  const firing=fire();t.after(()=>firing.kill('SIGKILL'));
  await Promise.race([acceptance,once(firing,'exit').then(([c])=>{throw Error(`clock exited before acceptance: ${c}`);})]);
  const ended=once(firing,'exit');firing.kill('SIGKILL');assert.equal((await ended)[1],'SIGKILL');
  const pending=readFileSync(join(clockDir,'spool.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse).find(e=>e.id===entry.id);
  assert.deepEqual(pending.delivery,clockBodies[0],'wire body persisted before forwarding');
  holdReceipt=false;const restarted=fire();t.after(()=>restarted.kill('SIGKILL'));
  let err='';restarted.stderr.on('data',b=>err+=b);
  assert.equal((await once(restarted,'exit'))[0],0,err);
  assert.deepEqual(clockBodies[1],clockBodies[0],'fresh clock uses identical sealed firing');
  assert.equal(deliveries.length,1,readFileSync(join(clockDir,'wake.log'),'utf8'));
  assert.equal(deliveries[0].source,'clock');assert.deepEqual(deliveries[0].continuation,entry.continuation);
  // deliver's 2 s reach can end before a cold Podman body-host starts: it then answers
  // exactly its documented 'queued'/'still starting'. The recorded outcome must still
  // become 'started' for that one message; nothing else is accepted.
  const child=children[0];
  if(child.body==='queued') assert.equal(child.reason,'its body is still starting',JSON.stringify(child)); else assert.equal(child.body,'started',JSON.stringify(child));
  const outcomes=()=>Object.values(loadConv(h.env,child.conversation)?.outcomes??{});
  try { await wait(()=>outcomes().some(o=>o.body==='started'),'queued child body start'); }
  catch(e){ if(process.env.CONTINUATION_DIAG_HOST_LOG){const hs=load(h.env).houses;console.error('DIAG',JSON.stringify({outcomes:outcomes(),hostExit,houses:Object.fromEntries(Object.entries(hs).map(([k,v])=>[k,{...v,task:undefined}]))}));} throw e; }
  assert.equal(outcomes().length,1,JSON.stringify(outcomes()));
  try { await wait(()=>existsSync(join(dir,'ready.json')),'provider shell proof'); }
  catch(e){ if(process.env.CONTINUATION_DIAG_DIR){const {cpSync}=await import('node:fs');for(const d of ['runs','native','inbox','work'])try{cpSync(join(dir,d),join(process.env.CONTINUATION_DIAG_DIR,d),{recursive:true});}catch{} try{cpSync(join(dir,'codex','sessions'),join(process.env.CONTINUATION_DIAG_DIR,'codex-sessions'),{recursive:true});}catch{} console.error('DIAG',JSON.stringify({hostExit,outcomes:outcomes()}));} throw e; }
  const provider=JSON.parse(readFileSync(join(dir,'ready.json'),'utf8'));
  const c=loadConv(h.env,child.conversation);assert.equal(h.hr.slotOf({id:c.body.split(':')[1],agent:'art',house:'h-1'}).session,provider.session);
  assert.equal(c.continuationAdmissions.length,1);
  assert.equal(Object.keys(h.hr.host('art','owner').report.bodies).length,1,'one native body after replay');
  assert.equal(Object.keys(load(h.env).houses).length,1,'retry allocated no replacement house');
  assert.equal(deliveries.length,1,'authenticated core deduplicated clock replay before runtime');
  writeFileSync(join(dir,'release'),'go');
  await wait(()=>existsSync(join(dir,'enqueued.json')),'actual provider enqueue');
  const queued=JSON.parse(readFileSync(join(dir,'enqueued.json'),'utf8'));assert.equal(queued.state,'pending');assert.ok(queued.ref);
  await tick(h.env,{...childOptions,core:undefined});
  const {default:Sqlite}=await import(`${process.env.CONTINUATION_CORE}/node_modules/better-sqlite3/lib/index.js`);
  const db=new Sqlite(join(coreHome,'comms.db'),{readonly:true});
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comms_messages WHERE id LIKE 'continuation-%'").get().n,1); console.log(JSON.stringify({bench:'actual-codex-clock-replay',session:provider.session,clockRequests:clockBodies.length,runtimeAdmissions:deliveries.length,reportRows:1,image,codex,model:process.env.CONTINUATION_PROVIDER_MODEL,version:check.stdout.trim()})); } finally {db.close();}
});
