import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { continuationOutbox } from '../src/continuation-outbox.mjs';
import { ageSealer } from '../src/sealed.mjs';
import { scratch } from './scratch.mjs';
import { continuationCall, deliver, deliveryDir, handOverWake, loadConv, tick } from '../src/delivery.mjs';
import { world } from './delivery-world.mjs';

for (const disposition of ['retry', 'cutoff', 'source-reset', 'child-reset']) test(`SIGKILL after durable firing claim before bind: ${disposition}`, () => {
  const dir = scratch('claim-crash-'), sealer = ageSealer({ HOME: dir }, join(dir, 'keys'));
  const source = {agent:'art',conversation:'cv-aaaaaaaaaaaa',run:'run-aaaaaaaaaaaa',reset:null,principal:{owner:true,for:'jonathan',people:[]},target:{venue:'loom',place:'source'}};
  const child = {...source,conversation:'cv-bbbbbbbbbbbb',run:'run-bbbbbbbbbbbb',target:{venue:'wake',place:'wake:w-123456'}};
  const firing = {wake:'w-123456',delivery:'clock:claim',expiresAt:11000};
  const options = {dir:join(dir,'outbox'),sealer,now:()=>1000,lifetimeMs:10000};
  const {handle} = continuationOutbox(options).issue(source);
  const fixture = {dir,source,child,firing,handle};
  const killed = spawnSync(process.execPath,['--input-type=module','-e',`
    import {join} from 'node:path';
    import {continuationOutbox} from './src/continuation-outbox.mjs';
    import {ageSealer} from './src/sealed.mjs';
    const x=JSON.parse(process.env.CLAIM_FIXTURE);
    const out=continuationOutbox({dir:join(x.dir,'outbox'),sealer:ageSealer({HOME:x.dir},join(x.dir,'keys')),now:()=>1001});
    out.checkFiring(x.handle,x.firing,x.source,x.child);
    process.kill(process.pid,'SIGKILL');
  `],{cwd:join(import.meta.dirname,'..'),env:{...process.env,CLAIM_FIXTURE:JSON.stringify(fixture)},encoding:'utf8',timeout:20000});
  assert.equal(killed.signal,'SIGKILL',killed.stderr);
  const reload = continuationOutbox({...options,now:()=>disposition==='cutoff'?11000:1002});
  const grant = () => JSON.parse(sealer.open(readFileSync(join(options.dir,readdirSync(options.dir).find(n=>n.startsWith('grant-'))))));
  assert.equal(grant().binding,null);
  assert.equal(grant().firing.delivery,firing.delivery);
  assert.throws(()=>reload.enqueue(handle,child,source,{id:'early',text:'no authority'}),/bound/);
  assert.throws(()=>reload.inspect(handle,source,{agent:'art',conversation:source.conversation,...source.principal},2000),/bound|expired/);
  assert.throws(()=>reload.checkFiring(handle,{...firing,wake:'w-654321'},source,child),/another firing|expired/);
  if(disposition==='source-reset') source.reset='changed';
  if(disposition==='child-reset') child.reset='changed';
  if(disposition==='retry') {
    assert.deepEqual(reload.checkFiring(handle,firing,source,child),{expiresAt:11000});
    reload.bind(handle,firing,source,child);
    assert.equal(reload.enqueue(handle,child,source,{id:'final',text:'recovered'}).state,'pending');
    assert.throws(()=>reload.bind(handle,firing,source,{...child,run:'run-cccccccccccc'}),/bound/);
  } else {
    assert.throws(()=>reload.checkFiring(handle,firing,source,child),/expired|reset|another firing/);
    assert.throws(()=>reload.bind(handle,firing,source,child),/expired|reset|another firing/);
    assert.equal(grant().binding,null);
  }
  assert.equal(grant().issuedAt,1000);
  assert.equal(grant().expiresAt,11000,'crash and recovery never renew deadline');
});

test('positively unstarted refusal retains claim and permits only the exact queued retry', async () => {
  const w=world();
  w.env.LOOM_HOME=join(w.env.HOME,'loom');
  mkdirSync(w.env.LOOM_HOME,{recursive:true});
  writeFileSync(join(w.env.LOOM_HOME,'household.json'),JSON.stringify({members:[{person:'jonathan',agents:'*'}]}));
  const source=await deliver(w.env,w.msg('claim-source','owner',{source:'loom',venue:'loom',from:{kind:'person',slug:'jonathan'}}),w.o);
  const args=cv=>{const c=loadConv(w.env,cv);return {conversation:cv,key:w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY,session:w.sessionFor(cv)};};
  const grant=continuationCall(w.env,{...args(source.conversation),action:'issue'},w.o);
  const firing=w.msg('wake:w-abcdef','continue',{source:'clock',venue:'wake',id:'w-abcdef',kind:'wake',from:{kind:'schedule'},continuation:{handle:grant.handle,expiresAt:grant.expiresAt,wake:'w-abcdef'}});
  handOverWake(w.env,{agent:'art',place:firing.place,id:firing.id,for:'owner'});
  const queued=await deliver(w.env,firing,{...w.o,detach:true,spawnWorker(){}});
  w.runner.failStart='test positive refusal';
  await tick(w.env,w.o,queued.conversation);
  const claim=()=>JSON.parse(w.o.sealer.open(readFileSync(join(deliveryDir(w.env),'continuations',readdirSync(join(deliveryDir(w.env),'continuations')).find(n=>n.startsWith('grant-'))))));
  assert.ok(claim().firing);
  assert.equal(claim().binding,null);
  assert.equal(loadConv(w.env,queued.conversation).body,undefined);
  const starts=w.kinds().filter(x=>x==='start').length;
  const other={...firing,id:'w-fedcba',place:'wake:w-fedcba',continuation:{...firing.continuation,wake:'w-fedcba'}};
  handOverWake(w.env,{agent:'art',place:other.place,id:other.id,for:'owner'});
  await deliver(w.env,other,w.o);
  assert.equal(w.kinds().filter(x=>x==='start').length,starts);
  w.runner.failStart=null;
  w.clock.advance(600001);
  await tick(w.env,w.o,queued.conversation);
  const child=loadConv(w.env,queued.conversation);
  assert.ok(child.body);
  assert.equal(child.continuationAdmissions.length,1);
  assert.equal(w.kinds().filter(x=>x==='start').length,starts+1);
  assert.equal(continuationCall(w.env,{...args(child.conversation),action:'enqueue',handle:grant.handle,id:'final',text:'after refusal'},w.o).state,'pending');
  assert.equal(claim().expiresAt,grant.expiresAt);
});
