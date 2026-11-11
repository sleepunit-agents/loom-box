import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkedSyncRequest, runBodyHost, SYNC_REQUEST_MAX, syncBackoff } from '../src/bodyhost.mjs';
import { bodyHealth, bodySync, hostOf, syncProblems } from '../src/houserunner.mjs';
import { agentReports } from '../src/ui.mjs';
import { api } from '../src/control.mjs';
import { scratch } from './scratch.mjs';
import { testSealer } from './delivery-world.mjs';

const run = (o) => runBodyHost({ env: {}, hostKey: 'test-key', runner: () => { throw Error('no bodies'); }, ...o });
test('alternating oversized requests and timeouts back off to five minutes and independently report broken sync', async () => {
  const waits = [], health = [], logs = [];
  await run({ beats: 12, idleS: 0, sleep: async n => waits.push(n), log: s => logs.push(s), client: async (path, b) => {
    if (path === 'body-health') { health.push(b); return { ok: true }; }
    throw Error(waits.length % 2 ? 'aborted due to timeout' : 'oversized: declared 1048673 bytes exceeds cap 1048576 SECRET');
  } });
  assert.deepEqual(waits, [2000,4000,8000,16000,32000,64000,128000,256000,300000,300000,300000,300000]);
  assert.equal(health[0].failures, 5);
  assert.equal(health.length, 8);
  assert.ok(health.every(b => Buffer.byteLength(JSON.stringify(b)) < 150));
  assert.ok(logs.every(s => !s.includes('SECRET')));
  assert.equal(syncBackoff(10000), 300000);
});
test('a successful sync resets failure backoff', async () => {
  const waits = []; let n = 0;
  await run({ beats: 5, sleep: async ms => waits.push(ms), client: async () => { if (++n === 3) return {}; throw Error('timeout'); } });
  assert.deepEqual(waits, [2000,4000,2000,2000,4000]);
});
test('an empty host exits after ten minutes even if every sync fails and health reporting is down', async () => {
  let time = 0, calls = 0;
  await run({ now: () => time, sleep: async n => { time += n; }, client: async () => { calls++; throw Error('timeout'); } });
  assert.ok(time >= 600000 && time < 900000);
  assert.ok(calls < 30);
});
test('a host retains a working body across a long outage', async () => {
  let time = 0, calls = 0;
  await run({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: 'fixture' }, beats: 15, now: () => time,
    sleep: async n => { time += n; }, runner: () => ({ start: async () => ({ id: 'abcd1234' }), status: () => 'working' }),
    client: async path => { if (path === 'body-health') return {}; if (!calls++) return { req: { '0123456789abcdef': { harness: 'claude', brief: 'fixture' } } }; throw Error('timeout'); } });
  assert.equal(calls, 15);
  assert.ok(time > 600000);
});
test('the complete serialized request including Unicode and envelope is bounded before HTTP', () => {
  assert.ok(Buffer.byteLength(JSON.stringify(checkedSyncRequest('key', { bodies: {} }))) < SYNC_REQUEST_MAX);
  assert.throws(() => checkedSyncRequest('key', { bodies: {}, packed: { a: '界'.repeat(SYNC_REQUEST_MAX / 2) } }), /size cap/);
  assert.throws(() => checkedSyncRequest('x'.repeat(SYNC_REQUEST_MAX), {}), /size cap/);
});
function fixture() {
  const dir = scratch('sync-health-'), env = { LOOM_BOX_DATA: dir }, key = 'host-secret';
  const hosts = join(dir, 'delivery', 'hosts'); mkdirSync(hosts, { recursive: true });
  writeFileSync(join(hosts, 'art.json'), JSON.stringify({ agent: 'art', house: 'h-1', hostHash: createHash('sha256').update(key).digest('hex'), req: {}, stop: {}, inbox: {} }));
  return { env, key, caller: { kind: 'agent', agent: 'art', house: 'h-1' }, s: { agents: { art: {} }, houses: { 'h-1': { agent: 'art', kind: 'body-host', state: 'running' } } } };
}
test('small health path authenticates host, persists broken status for the card and clears on recovery', async () => {
  const { env, key, caller, s } = fixture(), body = { hostKey: key, failures: 5, kind: 'oversized' };
  assert.equal((await api(env, {}, { caller, path: 'body-health', body })).status, 200);
  assert.equal(hostOf(env, 'art').syncFailure.kind, 'oversized');
  const reports = agentReports(s, Date.now(), {}, [], {}, syncProblems(env, s));
  assert.equal(reports.art.state, 'broken');
  assert.match(reports.art.reason, /oversized; 5 failures/);
  assert.throws(() => bodyHealth(env, { ...caller, house: 'h-2' }, body), /host house/);
  assert.throws(() => bodyHealth(env, caller, { ...body, hostKey: 'body-key' }), /host’s own key/);
  assert.throws(() => bodyHealth(env, { kind: 'owner' }, body), /host only/);
  assert.throws(() => bodyHealth(env, caller, { ...body, kind: 'secret text' }), /invalid/);
  bodySync(env, caller, { hostKey: key, report: { bodies: {}, done: {} } }, { sealer: testSealer });
  assert.equal(hostOf(env, 'art').syncFailure, undefined);
  assert.deepEqual(syncProblems(env, s), {});
});
test('failures from a stopped house do not mark an agent broken', () => {
  const { env, key, caller, s } = fixture();
  bodyHealth(env, caller, { hostKey: key, failures: 5, kind: 'timeout' });
  s.houses['h-1'].state = 'stopped';
  assert.deepEqual(syncProblems(env, s), {});
});

test('a lost first key-exchange answer still permits a small failure report but never replays a start', () => {
  const { env, key, caller } = fixture(), file = join(env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art.json');
  const host = hostOf(env, 'art'); host.bootHash = host.hostHash; delete host.hostHash;
  writeFileSync(file, JSON.stringify(host));
  const first = bodySync(env, caller, { hostKey: key, report: {} }, { sealer: testSealer });
  assert.ok(first.hostKey);
  assert.equal(bodyHealth(env, caller, { hostKey: key, failures: 5, kind: 'timeout' }).ok, true);
  assert.throws(() => bodySync(env, caller, { hostKey: key, report: {} }, { sealer: testSealer }), /host's own key/);
  bodySync(env, caller, { hostKey: first.hostKey, report: {} }, { sealer: testSealer });
  assert.equal(hostOf(env, 'art').syncFailure, undefined);
});

test('several sessions and finals reproduce an oversized old report; existing shared budgets and the final guard fit it', async () => {
  const { packedParts, fitCards, REPORT_MAX } = await import('../src/bodyhost.mjs');
  const packing = new Map(Array.from({ length: 3 }, (_, i) => [`body${i}`, { parts: ['x'.repeat(360 * 1024)], next: 0, since: i }]));
  const bodies = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`body${i}`, { status: 'idle', final: '\u0001'.repeat(40000) }]));
  const old = { bodies: structuredClone(bodies), packed: Object.fromEntries([...packing].map(([id,p]) => [id,{part:0,parts:1,data:p.parts[0]}])) };
  assert.ok(Buffer.byteLength(JSON.stringify({hostKey:'key',report:old})) > 1048576);
  const report = { bodies, packed: packedParts(packing, false) };
  fitCards(report, REPORT_MAX);
  const wire = checkedSyncRequest('key', report);
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) <= SYNC_REQUEST_MAX);
  assert.equal(Object.keys(wire.report.packed).length, 1, 'other session parts remain queued for later syncs');
  assert.equal(packing.size, 3, 'no transfer was discarded');
});

test('an oversized locally generated report is never posted, still reports broken, and retains its body', async () => {
  let syncs = 0, health = 0;
  await run({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: 'fixture' }, beats: 8, idleS: 0, sleep: async () => {},
    runner: () => ({ start: async () => ({ id: 'abcd1234' }), status: () => 'working', tickerAction: () => 'x'.repeat(SYNC_REQUEST_MAX + 1) }),
    client: async (path,b) => {
      if (path === 'body-health') { health++; assert.equal(b.kind,'oversized'); return {}; }
      syncs++; assert.ok(Buffer.byteLength(JSON.stringify(b)) <= SYNC_REQUEST_MAX);
      return { req: { '0123456789abcdef': { harness:'claude', brief:'fixture' } } };
    } });
  assert.equal(syncs,1);
  assert.equal(health,3);
});

test('a draining house reports and clears only its own failure', () => {
  const { env, key, caller, s } = fixture(), file = join(env.LOOM_BOX_DATA,'delivery','hosts','art.json');
  const host = hostOf(env,'art');
  host.draining = { 'h-2': { hostHash: host.hostHash, syncFailure: { failures: 6, kind: 'timeout' } } };
  writeFileSync(file,JSON.stringify(host));
  s.houses['h-2'] = { agent:'art', kind:'body-host', state:'running' };
  assert.equal(syncProblems(env,s).art[0].house,'h-2');
  bodyHealth(env,caller,{hostKey:key,failures:5,kind:'oversized'});
  bodySync(env,{...caller,house:'h-2'},{hostKey:key,report:{}},{sealer:testSealer});
  assert.deepEqual(syncProblems(env,s).art,[{house:'h-1',failures:5,kind:'oversized'}]);
});

test('the real host and controller collect a session with 10,000 large pending receipts through bounded parts', async () => {
  const { env, key, caller } = fixture(), home = scratch('sync-paged-receipts-'), history = join(home,'native'); mkdirSync(history);
  const id='b0000000', rid='0123456789abcdef', file=join(history,'session'); writeFileSync(file,'s'.repeat(400000));
  const inbox=join(home,'inbox'), entry=join(inbox,id); mkdirSync(entry,{recursive:true});
  const pending=Array.from({length:10000},(_,i)=>String(i).padStart(8,'0')+'界'.repeat(56));
  writeFileSync(join(entry,'meta.json'),JSON.stringify({chan:id,bridge:'runtime',venue:'runtime'}));
  writeFileSync(join(entry,'pending.jsonl'),pending.map(id=>JSON.stringify({id})).join('\n'));
  let calls=0, finished=false, parts=0, lost=false, lastPart;
  const native={start:()=>({id}),status:()=> 'idle',stopped:()=>true,end:()=>{},inbox:{dir:inbox,pending:()=>[]},
    slotOf:()=>({harness:'codex',session:'known-session'}),roots:{sessions:history},
    sessionFiles:()=>({keep:[{root:'sessions',rel:'session'}],drop:[]})};
  await runBodyHost({env:{HOME:home,HOUSE_ID:'h-1',LOOM_RUNTIME_NATIVE_HISTORY:history,LOOM_LOGIN_CODEX:'/login'},hostKey:key,
    runner:()=>native,beats:40,idleS:0,sleep:async()=>{},client:async(path,b)=>{
      assert.equal(path,'body-sync'); assert.ok(Buffer.byteLength(JSON.stringify(b))<=SYNC_REQUEST_MAX);
      if(calls++===1){const h=hostOf(env,'art');h.stop={[id]:{pack:true,at:1,session:'known-session'}};writeFileSync(join(env.LOOM_BOX_DATA,'delivery','hosts','art.json'),JSON.stringify(h));}
      const p=b.report.packed[id]; if(p){parts++;assert.equal(p.format,'receipts-v1');assert.equal(p.pending,undefined);assert.ok(existsSync(file));lastPart=p.part;}
      const answer=bodySync(env,caller,b,{sealer:testSealer});
      if(calls===1)answer.req={[rid]:{harness:'codex',brief:'fixture'}};
      if(p&&!lost){lost=true;throw Error('timeout: lost acknowledgement');}
      if(parts>0&&!existsSync(file)){finished=true;return{...answer,exit:true};}
      return answer;
    }});
  assert.equal(finished,true); assert.ok(parts>5); assert.ok(lastPart>0);
  const kept=JSON.parse(testSealer.open(readFileSync(join(env.LOOM_BOX_DATA,'delivery','hosts','packed','art','h-1',id+'.age'))));
  assert.deepEqual(kept.pending,pending);
  assert.equal(Buffer.from(kept.files[0].data,'base64').toString(),'s'.repeat(400000));
});
