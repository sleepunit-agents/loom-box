import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, loadConv, ownerConversationControl, tick } from '../src/delivery.mjs';
import { world, houseWorld, hasAge } from './delivery-world.mjs';
import { load } from '../src/state.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{const end=Date.now()+15000;while(!await fn()){if(Date.now()>end)throw Error('retirement checkpoint timed out');await pause(10)}};
function failingSlots(base) {
  let blocked=false,hits=0;
  return { seal(bytes) { let value;try{value=JSON.parse(bytes.toString())}catch{};
    if(blocked&&value?.v===1&&Array.isArray(value.files)&&value.harness){hits++;throw Error('fixture slot storage unavailable')}
    return base.seal(bytes);
  },open:bytes=>base.open(bytes),block:value=>{blocked=value},hits:()=>hits };
}

test('local retirement retains its transcript and unread inbox until the slot and receipt are durable',async()=>{
  const w=world({}, {inboxDir:true}),sealer=failingSlots(w.o.sealer),o={...w.o,sealer};
  const a=await deliver(w.env,w.msg('dm:checkpoint','original native work'),o);
  const steering=await deliver(w.env,w.msg('dm:checkpoint','unheard steering must survive'),o);
  const before=loadConv(w.env,a.conversation),id=before.body.split(':')[1],native=w.runner.slotOf({id}).session;
  const unheard=w.runner.inbox.pending(id).map(x=>x.id);assert.equal(unheard.length,1);
  sealer.block(true);
  await ownerConversationControl(w.env,{kind:'owner'},{conversation:a.conversation,action:'interrupt'},o);
  await tick(w.env,o);
  let c=loadConv(w.env,a.conversation);
  assert.equal(c.control.state,'pending');assert.equal(c.body,before.body);assert.equal(c.slot,undefined);
  assert.ok(existsSync(w.runner.transcript(native)));assert.equal(w.runner.inbox.pending(id).length,1);assert.ok(sealer.hits());
  sealer.block(false);
  const remove=w.runner.inbox.remove;let failed=false;
  w.runner.inbox.remove=(key)=>{remove(key);if(!failed){failed=true;throw Error('fixture worker died after deleting native files')}};
  await tick(w.env,o);
  c=loadConv(w.env,a.conversation);
  assert.equal(failed,true);assert.equal(c.control.state,'pending');assert.equal(c.nativeRetirement.slot.session,native);
  assert.equal(c.nativeRetirement.pending.length,1);assert.equal(existsSync(w.runner.transcript(native)),false);
  await tick(w.env,o);
  c=loadConv(w.env,a.conversation);
  assert.equal(c.control.state,'held');assert.equal(c.slot.session,native);assert.equal(c.nativeRetirement,undefined);
  assert.deepEqual(c.queue.map(x=>x.key),unheard,'unread steering survives cleanup and is requeued exactly once');
  await ownerConversationControl(w.env,{kind:'owner'},{conversation:a.conversation,action:'resume'},o);
  c=loadConv(w.env,a.conversation);assert.equal(c.runLog.at(-1).how,'resumed');
  assert.equal(w.runner.slotOf({id:c.body.split(':')[1]}).session,native);
  assert.equal(w.log.filter(x=>x[0]==='resume').length,1);
});

test('remote retirement keeps the received pack through seal failure and recovers after the pack acknowledgement', {skip:!hasAge},async()=>{
  const w=world(),h=houseWorld(),sealer=failingSlots(h.sealer),o={...w.o,sealer,runner:()=>h.hr,accounts:h.accounts};
  let host,drained;
  const first=deliver(h.env,{...w.msg('dm:remote-checkpoint','native work'),from:{kind:'person',slug:'jonathan'}},{...o,onDrain:p=>{drained=p}});
  try{
    await until(()=>!!load(h.env).houses['h-1']);host=h.host();
    const a=await first;await drained;
    const before=loadConv(h.env,a.conversation),body={id:before.body.split(':')[1],agent:'art',house:'h-1',harness:'claude'};
    sealer.block(true);await ownerConversationControl(h.env,{kind:'owner'},{conversation:a.conversation,action:'interrupt'},o);
    await until(async()=>{await tick(h.env,o);return sealer.hits()>0});
    assert.equal(loadConv(h.env,a.conversation).control.state,'pending');assert.equal(h.hr.packReady(body),true,'received pack remains the recoverable copy');
    sealer.block(false);
    const ack=h.hr.ackPack.bind(h.hr);let failed=false,reads=0;
    const pack=h.hr.pack.bind(h.hr);h.hr.pack=(...args)=>{reads++;return pack(...args)};
    h.hr.ackPack=b=>{ack(b);if(!failed){failed=true;throw Error('fixture worker died after acknowledging received pack')}};
    await tick(h.env,o);
    let c=loadConv(h.env,a.conversation);assert.equal(failed,true);assert.ok(c.nativeRetirement.slot.session);
    const native=c.nativeRetirement.slot.session;assert.equal(h.hr.packReady(body),false);const previousReads=reads;
    const recovered=spawnSync(process.execPath,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),'deliver','tick','--conversation',a.conversation],{env:{...h.env,LOOM_RUNTIME_LOOM_URL:'http://127.0.0.1:1/mcp',LOOM_RUNTIME_TOKEN_FILE:join(h.D,'no-token')},encoding:'utf8',timeout:15000});
    assert.equal(recovered.status,0,recovered.stderr);
    c=loadConv(h.env,a.conversation);assert.equal(c.control.state,'held');assert.equal(c.slot.session,native);
    assert.equal(c.nativeRetirement,undefined);assert.equal(reads,previousReads,'committed receipt avoids a second native pack');
    assert.equal(h.ended.length,1);
  }finally{if(host&&!h.left()){await h.kill();await host}await first}
});

test('local native read failure keeps retirement pending until the transcript can be collected', async () => {
  const w = world();
  const a = await deliver(w.env, w.msg('dm:read-checkpoint', 'original native work'), w.o);
  const before = loadConv(w.env, a.conversation), id = before.body.split(':')[1];
  const native = w.runner.slotOf({ id }).session;
  const originalFiles = w.runner.sessionFiles.bind(w.runner);
  w.runner.sessionFiles = () => ({ keep: [{ root: Object.keys(w.runner.roots)[0], rel: 'temporarily-unreadable-native-session' }], drop: [] });
  await ownerConversationControl(w.env, { kind: 'owner' }, { conversation: a.conversation, action: 'interrupt' }, w.o);
  await tick(w.env, w.o);
  let c = loadConv(w.env, a.conversation);
  assert.equal(c.control.state, 'pending');
  assert.equal(c.body, before.body);
  assert.equal(c.nativeRetirement, undefined, 'a failed filesystem read cannot commit an empty slot');
  assert.equal(c.slot, undefined);
  assert.equal(existsSync(w.runner.transcript(native)), true);
  assert.equal(w.log.filter(x => x[0] === 'resume').length, 0);
  w.runner.sessionFiles = originalFiles;
  await tick(w.env, w.o);
  c = loadConv(w.env, a.conversation);
  assert.equal(c.control.state, 'held');
  assert.equal(c.slot.session, native);
  assert.equal(existsSync(w.runner.transcript(native)), false, 'cleanup follows a committed slot');
  await ownerConversationControl(w.env, { kind: 'owner' }, { conversation: a.conversation, action: 'resume' }, w.o);
  assert.equal(loadConv(w.env, a.conversation).runLog.at(-1).how, 'resumed');
});
