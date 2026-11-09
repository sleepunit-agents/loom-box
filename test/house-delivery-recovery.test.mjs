import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, loadConv, ownerConversationControl, tick } from '../src/delivery.mjs';
import { readBody } from '../src/bodies.mjs';
import { HouseRunner } from '../src/houserunner.mjs';
import { readHouseLaunch } from '../src/house-launch-journal.mjs';
import { load, update } from '../src/state.mjs';
import { api } from '../src/control.mjs';
import { collectNativeHistory } from '../src/native-collection-client.mjs';
import { cvOf, hasAge, houseWorld, world } from './delivery-world.mjs';
const wait = async fn => { const end=Date.now()+5000; while(!fn()) { if(Date.now()>end) throw Error('house delivery fixture timed out'); await new Promise(r=>setTimeout(r,10)); } };
async function stopHost(h, host, seat) {
  if (!host) return;
  const path=join(h.env.LOOM_BOX_DATA,'delivery/hosts',seat==='owner'?'art.json':`art@${seat}.json`);
  const record=JSON.parse(readFileSync(path,'utf8'));
  writeFileSync(path,JSON.stringify({...record,house:'h-999'}));
  await host;
}

for (const harness of ['claude', 'codex']) test(`${harness}: a terminated pre-bind attempt preserves its reconciliation notice and sealed input under owner hold`, { skip: !hasAge }, async () => {
  const w = world(), h = houseWorld({ harness }), seat = 'p-loren', cv = cvOf('art', 'slack', 'dm:lost-prebind');
  const publish = h.hr.publishPreparedLaunch.bind(h.hr);
  h.hr.publishPreparedLaunch = handle => { const result = publish(handle); h.setRequestDrop(() => true); return result; };
  h.hr.waitPreparedLaunch = async () => { throw Error('fixture registrar stopped observing after publication'); };
  const o = { ...w.o, runner: () => h.hr, accounts: h.accounts, sealer: h.sealer };
  let host, drained;
  const first = deliver(h.env, w.msg('dm:lost-prebind', 'reconcile this authorized work'), { ...o, onDrain: p => { drained = p; } });
  try {
    await wait(() => load(h.env).houses['h-1']); host = h.host(); await first; await drained;
    const before = loadConv(h.env, cv), prepared = before.starting.prepared;
    assert.equal(readHouseLaunch(h.env, prepared.id).state, 'published');
    const path = join(h.env.LOOM_BOX_DATA, 'delivery/hosts', `art@${seat}.json`), record = readFileSync(path, 'utf8');
    const stopping = stopHost(h, host, seat); h.setRequestDrop(() => false); await stopping; host = undefined; writeFileSync(path, record);
    await ownerConversationControl(h.env, { kind: 'owner' }, { conversation: cv, action: 'interrupt' }, { ...o, detach: true, spawnWorker() {} });
    update(h.env, s => { s.houses['h-1'].state = 'running'; s.houses['h-1'].nativeHistory = { v: 1, complete: false }; });
    const root = join(h.D, 'missing-native'); mkdirSync(root);
    const caller = { kind: 'piece', subject: load(h.env).houses['h-1'].box };
    const client = { async call(path, body) { const result = await api(h.env, { sealer: h.sealer }, { caller, path, body }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; } };
    await collectNativeHistory({ client, id: 'h-1', root, snapshot: join(h.D, 'snapshot'), physical: 'gone' });
    w.clock.advance(1001); await tick(h.env, o); await tick(h.env, o);
    const after = loadConv(h.env, cv);
    assert.equal(after.body, undefined); assert.equal(after.starting, undefined); assert.equal(after.control.state, 'held');
    assert.equal(after.queue.length, 1); assert.equal(typeof after.queue[0].sealed, 'string');
    assert.equal(after.nativeRecovery.reason, 'missing-history'); assert.equal(after.nativeRecovery.mayHaveActed, true);
    assert.deepEqual(after.actsFor, before.actsFor); assert.equal(after.actsFor.owner, false);
    assert.equal(after.nativeLossCount, 1); assert.equal(after.runLog.at(-1).contextLost, true);
    assert.equal(readHouseLaunch(h.env, prepared.id).state, 'terminated');
    assert.equal(readHouseLaunch(h.env, prepared.id).termination.consumed, true);
    assert.equal(h.local.startsEntered ?? 0, 0, 'a held reconciliation never creates a replacement');
    w.clock.advance(1001); await tick(h.env, o); assert.equal(loadConv(h.env, cv).nativeLossCount, 1);
  } finally { h.setRequestDrop(() => false); await stopHost(h, host, seat); await first; }
});
for (const harness of ['claude','codex']) test(`${harness}: conversation recovery binds the original house receipt, generation, run and sender without promoting its principal`, {skip:!hasAge}, async()=>{
  const w=world(), h=houseWorld({harness});
  const cv=cvOf('art','slack','dm:house-recovery'), seat='p-loren';
  const originalWait=h.hr.waitPreparedLaunch.bind(h.hr);
  h.hr.waitPreparedLaunch=async handle=>{ await originalWait(handle); throw Error('fixture registrar lost the ready native receipt'); };
  const o={...w.o,runner:()=>h.hr,accounts:h.accounts,sealer:h.sealer};
  let drained,host;
  const first=deliver(h.env,w.msg('dm:house-recovery','original work'),{...o,onDrain:p=>{drained=p}});
  try {
    await wait(()=>load(h.env).houses['h-1']); host=h.host();
    const out=await first; await drained;
    assert.equal(out.body,'queued');
    const before=loadConv(h.env,cv), prepared=before.starting.prepared;
    assert.equal(prepared.mode,'house');
    assert.equal(before.body,undefined);
    assert.equal(readHouseLaunch(h.env,prepared.id).state,'ready');
    assert.equal(before.actsFor.owner,false);
    const fresh=new HouseRunner(h.env,harness,{sealer:h.sealer,poll:10});
    w.clock.advance(1001);
    await tick(h.env,{...o,runner:()=>fresh});
    const after=loadConv(h.env,cv);
    assert.equal(after.body,`${harness}:h-1-b0000000`);
    assert.equal(after.run,prepared.snapshot.run);
    assert.equal(after.sendKey,prepared.snapshot.senderHash);
    assert.equal(readBody(h.env,after.body).instance,prepared.bodySpec.metadata.instance);
    assert.deepEqual(after.actsFor,before.actsFor);
    assert.equal(after.runs,1);
    assert.equal(after.starting,undefined);
    assert.equal(after.launchAcks,undefined);
    assert.equal(fresh.host('art',seat).req[prepared.handle.rid],undefined);
    assert.equal(h.local.startsEntered,1);
    await tick(h.env,{...o,runner:()=>fresh});
    assert.equal(loadConv(h.env,cv).runs,1);
    assert.equal(h.local.startsEntered,1);
  } finally { await stopHost(h,host,seat); await first; }
});

test('a committed conversation retains its failed house acknowledgement for a fresh controller', {skip:!hasAge}, async()=>{
  const w=world(),h=houseWorld({harness:'codex'}),seat='p-loren',cv=cvOf('art','slack','dm:house-ack');
  h.hr.acknowledgePreparedLaunch=()=>{throw Error('fixture acknowledgement storage unavailable');};
  const o={...w.o,runner:()=>h.hr,accounts:h.accounts,sealer:h.sealer};
  let host,drained;
  const first=deliver(h.env,w.msg('dm:house-ack','one work item'),{...o,onDrain:p=>{drained=p}});
  try {
    await wait(()=>load(h.env).houses['h-1']);host=h.host();
    const out=await first;await drained;
    assert.equal(out.body,'started');
    const committed=loadConv(h.env,cv),handle=committed.launchAcks[0];
    assert.equal(committed.starting,undefined);
    assert.equal(committed.runs,1);
    assert.ok(h.hr.host('art',seat).req[handle.rid]);
    const fresh=new HouseRunner(h.env,'codex',{sealer:h.sealer});
    await tick(h.env,{...o,runner:()=>fresh});
    const after=loadConv(h.env,cv);
    assert.equal(after.body,committed.body);
    assert.equal(after.run,committed.run);
    assert.equal(after.sendKey,committed.sendKey);
    assert.equal(after.launchAcks,undefined);
    assert.equal(fresh.host('art',seat).req[handle.rid],undefined);
    assert.equal(h.local.startsEntered,1);
    assert.equal(after.runs,1);
  } finally {await stopHost(h,host,seat);await first;}
});

for (const harness of ['claude','codex']) test(`${harness}: uncertain input is replayed only after its original writer stopped and its native context was restored`, {skip:!hasAge}, async()=>{
  const w=world(),h=houseWorld({harness}),seat='p-loren',cv=cvOf('art','slack','dm:uncertain-house');
  let resumed=0, uncertain=true, host, drained;
  const originalWait=h.hr.waitPreparedLaunch.bind(h.hr),slotOf=h.local.slotOf.bind(h.local),slots=new Map();
  h.hr.waitPreparedLaunch=async handle=>{const body=await originalWait(handle);if(uncertain){uncertain=false;return {...body,inputUncertain:true};}return body;};
  h.local.slotOf=body=>slots.get(body.id)??body.slot??slotOf(body);
  h.local.resume=async(slot,options)=>{
    assert.ok(h.ended.includes('b0000000'),'the old writer acknowledged shutdown before another native call');
    assert.equal(h.local.status({id:'b0000000'}),'ended');
    assert.equal(readFileSync(join(h.local.roots.sess,slot.session+'.jsonl'),'utf8'),'transcript of b0000000\n','the native context was restored before resume');
    resumed++;
    const body=await h.local.start(options);slots.set(body.id,slot);return {...body,slot};
  };
  const o={...w.o,runner:()=>h.hr,accounts:h.accounts,sealer:h.sealer};
  const first=deliver(h.env,w.msg('dm:uncertain-house','original uncertain work'),{...o,onDrain:p=>{drained=p}});
  try {
    await wait(()=>load(h.env).houses['h-1']);host=h.host();
    await first;await drained;
    const end=Date.now()+5000;
    while(resumed===0||loadConv(h.env,cv).retiring||loadConv(h.env,cv).starting){
      if(Date.now()>end)throw Error('uncertain input did not finish acknowledged retirement/resume');
      w.clock.advance(1001);await tick(h.env,o);await new Promise(r=>setTimeout(r,10));
    }
    const after=loadConv(h.env,cv);
    assert.equal(resumed,1);
    assert.equal(h.local.startsEntered,2);
    assert.equal(after.body,`${harness}:h-1-b0000001`);
    assert.equal(after.queue.length,0);
    assert.equal(after.runLog[0].inputUncertain,true);
    assert.equal(Object.values(after.outcomes)[0].body,'resumed');
    assert.equal(after.actsFor.owner,false);
  }finally{await stopHost(h,host,seat);await first;}
});


for (const harness of ['claude','codex']) test(`${harness}: owner interruption holds uncertain input after collection without starting a replacement`, {skip:!hasAge}, async()=>{
  const w=world(),h=houseWorld({harness}),seat='p-loren',cv=cvOf('art','slack','dm:held-uncertain-house');
  const o={...w.o,runner:()=>h.hr,accounts:h.accounts,sealer:h.sealer};
  const originalWait=h.hr.waitPreparedLaunch.bind(h.hr);
  h.hr.waitPreparedLaunch=async handle=>{
    const body=await originalWait(handle);
    await ownerConversationControl(h.env,{kind:'owner'},{conversation:cv,action:'interrupt'},{...o,detach:true,spawnWorker(){}});
    return {...body,inputUncertain:true};
  };
  let host,drained;
  const first=deliver(h.env,w.msg('dm:held-uncertain-house','keep this work for explicit resume'),{...o,onDrain:p=>{drained=p}});
  try {
    await wait(()=>load(h.env).houses['h-1']);host=h.host();
    await first;await drained;
    const end=Date.now()+5000;
    while(loadConv(h.env,cv).control?.state!=='held'){
      if(Date.now()>end)throw Error('owner hold did not finish collecting uncertain native input');
      w.clock.advance(1001);await tick(h.env,o);await new Promise(r=>setTimeout(r,10));
    }
    const held=loadConv(h.env,cv);
    assert.equal(held.body,undefined);
    assert.equal(held.queue.length,1);
    assert.equal(held.slot.harness,harness);
    assert.equal(held.slot.session,'s-b0000000');
    assert.equal(held.actsFor.owner,false);
    assert.equal(h.local.startsEntered,1);
    assert.ok(h.ended.includes('b0000000'));
    w.clock.advance(1001);await tick(h.env,o);
    assert.equal(h.local.startsEntered,1,'ordinary ticks cannot override the explicit owner hold');
  }finally{await stopHost(h,host,seat);await first;}
});
