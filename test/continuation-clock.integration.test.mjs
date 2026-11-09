import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ageSealer } from '../src/sealed.mjs';
import { world } from './delivery-world.mjs';
import { continuationCall, deliver, deliveryDir, handOverWake, loadConv, tick } from '../src/delivery.mjs';

// This retains deterministic harness and delivery/principal bridge seams. Holder APIs
// run through the actual managed production executable in separate processes. It adds the
// real clock fire process and core's authenticated managed delivery offer, rather
// than pretending a direct deliver() call proves those boundaries.
test('clock fire process reaches authenticated core delivery and binds only its admitted child', {
  skip: !process.env.CONTINUATION_CORE || !process.env.CONTINUATION_CLOCK, timeout: 45000,
}, async t => {
  const w = world(); w.o.now=()=>new Date(); w.o.sealer=ageSealer(w.env,deliveryDir(w.env)); const deliveries = []; const children = [];
  const bridge = createServer(async (req,res) => {
    try {
      let raw=''; for await (const c of req) raw+=c;
      const { mode, input } = JSON.parse(raw);
      if (mode === 'principal') {
        handOverWake(w.env, {agent:'art', place:input[ input.indexOf('--place')+1 ], id:input[input.indexOf('--id')+1], for:'owner'});
        res.end('{}'); return;
      }
      assert.notEqual(mode,'api','holder calls must use the production executable');
      assert.equal(mode,'deliver'); deliveries.push(input);
      const answer=await deliver(w.env,input,w.o); children.push(answer);
      res.end(JSON.stringify(answer));
    } catch(e) { res.statusCode=500; res.end(JSON.stringify({error:e.message})); }
  });
  bridge.listen(0,'127.0.0.1'); await once(bridge,'listening');
  t.after(()=>{bridge.closeAllConnections();bridge.close();});
  const bridgeUrl=`http://127.0.0.1:${bridge.address().port}`;
  const coreHome=join(w.env.HOME,'core'); mkdirSync(coreHome);
  const core=fork(new URL('./fixtures/continuation-core.mjs',import.meta.url),[],{env:{...process.env,...w.env,LOOM_HOME:coreHome,CONTINUATION_BRIDGE:bridgeUrl,CONTINUATION_RUNTIME_CLI:join(import.meta.dirname,'../src/cli.mjs')},stdio:['ignore','ignore','pipe','ipc']});
  t.after(()=>core.kill('SIGKILL'));
  let errors='';core.stderr.on('data',b=>errors+=b);
  const setup=await Promise.race([once(core,'message').then(([v])=>v),once(core,'exit').then(([c])=>{throw Error(`core ${c}: ${errors}`);})]);
  w.env.LOOM_HOME=coreHome;
  writeFileSync(w.env.LOOM_RUNTIME_TOKEN_FILE,setup.token);
  w.env.LOOM_RUNTIME_LOOM_URL=`http://127.0.0.1:${setup.port}/mcp`;
  w.o.core=undefined;
  const source=await deliver(w.env,w.msg(setup.place,'owner',{source:'loom',venue:'loom',place:setup.place,from:{kind:'person',slug:'jonathan'}}),w.o);
  const proof=cv=>{const c=loadConv(w.env,cv);return {conversation:cv,key:w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY,session:w.sessionFor(cv)};};
  const holder=async(action,b)=>{const r=await fetch(`http://127.0.0.1:${setup.port}/api/runtime/continuation-${action}`,{method:'POST',headers:{authorization:`Bearer ${setup.agentToken}`,'content-type':'application/json'},body:JSON.stringify(b)});return {status:r.status,body:await r.json()};};
  // Production executable must retain its policy hold. Only this trusted test
  // parent supplies a lifetime; enqueue/status still use the unchanged executable.
  const issued=await holder('issue',proof(source.conversation));
  assert.notEqual(issued.status,200,JSON.stringify(issued));
  assert.match(JSON.stringify(issued.body), /deadline policy is not configured/);
  const grant=continuationCall(w.env,{...proof(source.conversation),action:'issue'},w.o);
  const bin=join(w.env.HOME,'bin');mkdirSync(bin);
  for (const name of ['systemctl','systemd-run']) writeFileSync(join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const principal=join(bin,'principal.mjs');
  writeFileSync(principal,`const r=await fetch(${JSON.stringify(bridgeUrl)},{method:'POST',body:JSON.stringify({mode:'principal',input:process.argv.slice(2)})});if(!r.ok)process.exit(1);`);
  const tokenFile=join(w.env.HOME,'clock-token');writeFileSync(tokenFile,setup.clockToken);
  const clockDir=join(w.env.HOME,'clock','art');mkdirSync(clockDir,{recursive:true});
  const entry={id:'w-abcdef',kind:'wake',created:'2026-11-09 00:00:00',at:'2026-11-09 00:00:00',prompt:'complete route',for:'owner',continuation:{handle:grant.handle,expiresAt:grant.expiresAt,wake:'w-abcdef'}};
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
  const child=children[0];assert.equal(child.body,'started');
  const q={...proof(child.conversation),handle:grant.handle,action:'enqueue',id:'report',text:'clock route report'};
  const enqueued=await holder('enqueue',q);assert.equal(enqueued.status,200,JSON.stringify(enqueued));assert.ok(enqueued.body.ref);
  const post=async(body,token)=>{const r=await fetch(`http://127.0.0.1:${setup.port}/api/loom/deliver`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const {source:_,...wire}=deliveries[0];
  assert.deepEqual((await post(wire,setup.clockToken)).body,child);
  assert.equal(deliveries.length,1,'core replay never launches another child');
  assert.equal((await post({...wire,id:'spoof-source',source:'clock'},setup.impostorToken)).status,400);
  assert.equal((await post({...wire,id:'non-clock'},setup.impostorToken)).status,403);
  assert.equal(deliveries.length,1,'non-clock never reaches runtime');
  const forged={...wire,id:'w-fedcba',place:'wake:w-fedcba',continuation:{handle:'cont-'+'f'.repeat(64),expiresAt:grant.expiresAt,wake:'w-fedcba'}};
  const denied=await post(forged,setup.clockToken);
  assert.equal(denied.status,200);
  assert.ok(['queued','failed'].includes(denied.body.body));
  assert.equal(loadConv(w.env,denied.body.conversation).body,undefined);
  assert.equal((await holder('enqueue',{...q,session:'borrowed'})).status,403);
  assert.equal((await holder('enqueue',{...q,key:'borrowed'})).status,403);
  handOverWake(w.env,{agent:'art',place:'wake:w-123456',id:'w-123456',for:'owner'});
  const rebound=await post({...wire,id:'w-123456',place:'wake:w-123456',continuation:{handle:grant.handle,expiresAt:grant.expiresAt,wake:'w-123456'}},setup.clockToken);
  assert.equal(rebound.status,200);
  assert.ok(['queued','failed'].includes(rebound.body.body));
  assert.equal(loadConv(w.env,rebound.body.conversation).body,undefined);
  writeFileSync(w.env.LOOM_RUNTIME_TOKEN_FILE,setup.token);
  w.env.LOOM_RUNTIME_LOOM_URL=`http://127.0.0.1:${setup.port}/mcp`;
  // Tick uses the real core client here, including its explicit stored receipt.
  await tick(w.env,{...w.o,core:undefined});
  assert.equal((await holder('status',q)).body.state,'delivered');
  assert.equal((await holder('enqueue',{...q,id:'reset'})).status,200);
  const changed=loadConv(w.env,source.conversation);changed.actsFor.reset='reset-after-queue';
  writeFileSync(join(deliveryDir(w.env),'conversations',`${source.conversation}.json`),JSON.stringify(changed));
  await tick(w.env,{...w.o,core:undefined});
  assert.equal((await holder('status',{...q,id:'reset'})).status,403);
  const {default:Sqlite}=await import(`${process.env.CONTINUATION_CORE}/node_modules/better-sqlite3/lib/index.js`);
  const db=new Sqlite(join(coreHome,'comms.db'),{readonly:true});
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comms_messages WHERE id LIKE 'continuation-%'").get().n,1); } finally {db.close();}
});
