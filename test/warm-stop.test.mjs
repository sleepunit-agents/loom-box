import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { down, poll } from '../src/control.mjs';
import { deliver, loadConv, ownerConversationControl, tick } from '../src/delivery.mjs';
import { hostOf } from '../src/houserunner.mjs';
import { load, update } from '../src/state.mjs';
import { world, houseWorld, bodyInHouse, hasAge } from './delivery-world.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{const end=Date.now()+15000;while(!await fn()){if(Date.now()>end)throw Error('warm drain timed out');await pause(10)}};
for(const phase of ['working','launching','queued']) for(const harness of ['claude','codex']) test(`owner Down drains two ${harness} conversations (${phase}) before host exit or physical stop`,{skip:!hasAge},async()=>{
  const w=world();const h=houseWorld({harness,packMs:40});
  const o={...w.o,runner:()=>h.hr,accounts:h.accounts,sealer:h.sealer};
  const msg=place=>({...w.msg(place,'do the harmless fixture work'),from:{kind:'person',slug:'jonathan'}});
  let host,drained;
  const first=deliver(h.env,msg('dm:stop-one'),{...o,onDrain:p=>{drained=p}});
  try{
    await until(()=>!!load(h.env).houses['h-1']);host=h.host();
    const a=await first;await drained;
    const body=loadConv(h.env,a.conversation).body;
    writeFileSync(h.local.transcript(body.split(':')[1].slice('h-1-'.length)),'large native session\n'+'x'.repeat(500000));
    h.local.startDelay=phase==='launching'?200:0;
    if(phase==='queued')h.setRequestDrop(()=>true);
    let secondDrain;
    const second=deliver(h.env,msg('dm:stop-two'),{...o,onDrain:p=>{secondDrain=p}});
    if(phase==='launching')await until(()=>h.local.startsEntered===2);
    else if(phase==='queued')await until(()=>Object.keys(hostOf(h.env,'art').req??{}).length>0);
    else {await second;await secondDrain;}
    let upload=true,blocked=false,drop=true,lost=false;
    h.setRequestDrop((path,body)=>{const deny=upload&&!!Object.keys(body.report?.packed??{}).length;if(deny)blocked=true;return deny});
    h.setDrop(r=>{if(!lost&&r.acked?.length){lost=true;return true}return drop&&r.exit===true});
    update(h.env,s=>{s.houses['h-1'].state='running'});
    const box=load(h.env).houses['h-1'].box;
    down(h.env,{}, {kind:'owner'}, {id:'h-1'});
    const want=()=>poll(h.env,{}, {kind:'box',subject:box},{});
    assert.equal(want().stop.includes('h-1'),false,'do not signal the container while native sessions are live');
    const b=await second;await secondDrain;
    const before=[a,b].map(x=>loadConv(h.env,x.conversation));
    for(const c of before)if(c.body)assert.ok(c.body.startsWith(`${harness}:h-1-`));
    if(phase==='queued')assert.equal(h.local.startsEntered,1,'queued work never starts after Down');
    await until(async()=>{await tick(h.env,o);return blocked});
    await pause(100); // longer than the fixture host's pack age limit
    const file=join(h.env.LOOM_BOX_DATA,'delivery/hosts/art.json');const record=JSON.parse(readFileSync(file,'utf8'));
    for(const stop of Object.values(record.stop??{}))stop.at=Date.now()-61000;
    writeFileSync(file,JSON.stringify(record));upload=false;
    await until(async()=>{await tick(h.env,o);return [a,b].every(x=>loadConv(h.env,x.conversation).control?.state==='held')});
    assert.equal(lost,true,'a committed part reply was lost and retried');
    assert.equal(h.left(),false,'a lost final acknowledgement keeps the host alive');
    for(const c of before){const now=loadConv(h.env,c.conversation);if(c.body)assert.ok(now.slot?.session);assert.equal(now.body,undefined)}
    await assert.rejects(ownerConversationControl(h.env,{kind:'owner'},{conversation:a.conversation,action:'resume'},o),/still saving work/);
    assert.equal(want().stop.includes('h-1'),false,'Git rescue must finish naturally after session drain');
    drop=false;await until(()=>h.left());await host;
    assert.equal(h.ended.length,phase==='queued'?1:2);assert.equal(Object.keys(load(h.env).houses).length,1,'no replacement work while stopping');
    update(h.env,s=>{s.houses['h-1'].state='stopped'});
    await ownerConversationControl(h.env,{kind:'owner'},{conversation:a.conversation,action:'resume'},{...o,detach:true,spawnWorker(){}});
    assert.equal(loadConv(h.env,a.conversation).control,undefined,'resume becomes available after the physical house finishes');
  }finally{h.setRequestDrop(()=>false);h.setDrop(()=>false);if(host&&!h.left()){await h.kill();await host}await first;}
});

test('a completed pack is not re-requested after its stop acknowledgement',{skip:!hasAge},async()=>{
  const h=houseWorld();const {body,host}=await bodyInHouse(h);
  try{
    h.hr.requestPack(body);await until(()=>h.hr.packReady(body)&&!Object.keys(hostOf(h.env,'art').stop).length);
    h.hr.requestPack(body);assert.deepEqual(hostOf(h.env,'art').stop,{},'completed native pack is already an acknowledgement');
    const files=await h.hr.pack(body);assert.ok(files.length);assert.deepEqual(hostOf(h.env,'art').stop,{});
  }finally{await h.kill();await host}
});

for(const mode of ['job','session']) test(`${mode} houses retain their acknowledged signal stop path`,{skip:!hasAge},async()=>{
  const h=houseWorld();const {host}=await bodyInHouse(h);
  try{
    update(h.env,s=>{s.houses['h-1'].state='running';s.houses['h-1'][mode]=mode==='job'?{house:'h-1'}:true});
    down(h.env,{}, {kind:'owner'}, {id:'h-1'});
    const box=load(h.env).houses['h-1'].box;
    assert.equal(poll(h.env,{}, {kind:'box',subject:box},{}).stop.includes('h-1'),true);
  }finally{await h.kill();await host}
});
