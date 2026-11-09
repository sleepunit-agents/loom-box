import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runTerminal, waitTerminalReady } from '../src/terminal.mjs';
const until = async fn => { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };
const fixture = () => {
  const input = new PassThrough(), output = new PassThrough(), calls = [];
  let text = '', shells = 0;
  output.on('data', d => { text += d; });
  const status = { id: 'h-7', agent: 'art', conversation: 'cv-123456789abc', run: 'run-1', working: true, queued: 0, model: { harness: 'codex', model: 'gpt' }, cards: [{ id: 'step1', state: 'running', summary: 'Reading a file' }] };
  const call = async (path, q) => {
    calls.push({path, ...q});
    if (q.action === 'status') return {...status};
    if (q.action === 'interrupt') { status.control = 'held'; return {state:'held'}; }
    if (q.action === 'resume') { delete status.control; return {state:'resuming'}; }
    return {seq: calls.length};
  };
  return {input, output, calls, status, call, text:()=>text, shells:()=>shells, shell:async()=>{shells++;}};
};
test('terminal keeps multiline and busy-turn input, shows activity and reports, then detaches without closing its house', async () => {
  const f=fixture(); const p=runTerminal({...f,id:'h-7',every:5});
  await until(()=>f.text().includes('Reading a file'));
  f.input.write('/begin\nfirst line\nsecond line\n/end\nsteer while it works\n');
  await until(()=>f.calls.filter(x=>x.action==='send').length===2);
  const sent=f.calls.filter(x=>x.action==='send');
  assert.equal(sent[0].text,'first line\nsecond line');
  assert.equal(sent[1].text,'steer while it works');
  assert.match(sent[0].message,/^[0-9a-f]{24}$/);
  assert.notEqual(sent[0].message,sent[1].message);
  f.status.report='TERMINAL FINAL REPORT'; f.status.reportRun='run-1';
  await until(()=>f.text().includes('TERMINAL FINAL REPORT'));
  f.input.write('/shell\n/model codex\n/stop\n/resume\n/detach\n');
  assert.equal(await p,0);
  assert.equal(f.shells(),1);
  assert.equal(f.calls.some(x=>x.action==='model'&&x.harness==='codex'),true);
  assert.equal(f.calls.some(x=>x.action==='interrupt'),true);
  assert.equal(f.calls.some(x=>x.action==='resume'),true);
  assert.equal(f.calls.some(x=>x.path==='down'),false);
});
test('an ambiguous send retains text and retries with the same ID; closing waits for native stop acknowledgement', async () => {
  const f=fixture(); let attempts=0;
  const call=async(path,q)=>{ if(q.action==='send'&&++attempts===1){f.calls.push({path,...q});throw Error('connection lost');} return f.call(path,q); };
  const p=runTerminal({...f,call,id:'h-7',every:5});
  await until(()=>f.text().includes('Reading a file'));
  f.input.write('keep my prompt\n');
  await until(()=>f.text().includes('Message retained'));
  f.input.write('/detach\n');
  await until(()=>f.text().includes('Your unconfirmed message is kept here'));
  f.input.write('/retry\n');
  await until(()=>attempts===2);
  const sent=f.calls.filter(x=>x.action==='send');
  assert.deepEqual(sent.map(x=>[x.message,x.text]),[[sent[0].message,'keep my prompt'],[sent[0].message,'keep my prompt']]);
  f.input.write('/close\n');
  assert.equal(await p,0);
  const stop=f.calls.findIndex(x=>x.action==='interrupt'), down=f.calls.findIndex(x=>x.path==='down');
  assert.ok(stop>=0&&down>stop);
  assert.ok(f.calls.slice(stop+1,down).some(x=>x.action==='status'));
});
test('EOF reports an unconfirmed prompt instead of silently losing it', async()=>{
  const f=fixture(); const call=async(path,q)=>{if(q.action==='send')throw Error('unavailable');return f.call(path,q);};
  const p=runTerminal({...f,call,id:'h-7',every:5});
  await until(()=>f.text().includes('Reading a file'));
  f.input.end('unconfirmed text\n');
  assert.equal(await p,1);
  assert.match(f.text(),/Unconfirmed message [0-9a-f]+; save this text to retry:\nunconfirmed text/);
});

test('EOF preserves an unfinished multiline message', async()=>{
  const f=fixture();const p=runTerminal({...f,id:'h-7',every:5});
  await until(()=>f.text().includes('Reading a file'));
  f.input.end('/begin\nline one\nline two\n');
  assert.equal(await p,1);
  assert.match(f.text(),/Unsent multiline message; save this text to retry:\nline one\nline two/);
  assert.equal(f.calls.some(x=>x.action==='send'),false);
});
test('close waits through pending native stop; new input cancels closing and stays in the conversation', async()=>{
  const f=fixture();const call=async(path,q)=>{
    if(q.action==='interrupt'){f.calls.push({path,...q});f.status.control='pending';return {state:'pending'};}
    return f.call(path,q);
  };
  const p=runTerminal({...f,call,id:'h-7',every:5});
  await until(()=>f.text().includes('Reading a file'));
  f.input.write('/close\n');
  await until(()=>f.text().includes('stop: pending'));
  assert.equal(f.calls.some(x=>x.path==='down'),false);
  f.input.write('keep working after all\n');
  await until(()=>f.calls.some(x=>x.action==='send'));
  assert.match(f.text(),/Closing cancelled by new input/);
  f.status.control='held';
  await new Promise(r=>setTimeout(r,20));
  assert.equal(f.calls.some(x=>x.path==='down'),false);
  f.input.write('/detach\n');assert.equal(await p,0);
});

test('startup observation waits on the same allocated house and refuses unrelated errors or an old host',async()=>{
  let count=0, time=0;const seen=[];
  const notReady=()=>Object.assign(Error('this house has no shared terminal host yet; rebuild it'),{status:409});
  const call=async(path,q)=>{seen.push(q.id);if(++count<3)throw notReady();return {conversation:'cv-123456789abc'};};
  assert.equal((await waitTerminalReady(call,'h-7',{timeoutMs:10,every:1,now:()=>time,sleep:async()=>{time++;}})).conversation,'cv-123456789abc');
  assert.deepEqual(seen,['h-7','h-7','h-7']);
  await assert.rejects(waitTerminalReady(async()=>{throw notReady();},'h-7',{timeoutMs:0,now:()=>0}),/same house/);
  await assert.rejects(waitTerminalReady(async()=>{throw Object.assign(Error('forbidden'),{status:403});},'h-7'),/forbidden/);
});
