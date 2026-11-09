import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeActionNow, codexActionNow, observation } from '../src/ticker.mjs';

test('Codex tracks live calls, clears completed/old turns and never projects arguments', () => {
 const start = {type:'item.started',item:{id:'a',type:'command_execution',command:'pgrep --private secret'}};
 assert.equal(codexActionNow([start]),'Running a command');
 assert.equal(codexActionNow([start,{type:'item.completed',item:{id:'a'}}]),'Working');
 assert.equal(codexActionNow([start,{type:'turn.completed'}]),'Working');
 assert.equal(codexActionNow([start,{type:'turn.started'}]),'Working');
 assert.equal(codexActionNow([{type:'item.completed',item:{id:'a',type:'mcp_tool_call',arguments:'secret'}}]),'Working');
});
test('Claude removes results, isolates turns, and uses fixed safe action words', () => {
 const start={type:'assistant',message:{content:[{type:'tool_use',id:'a',name:'Read',input:{file_path:'/private/secret'}}]}};
 assert.equal(claudeActionNow([start]),'Reading a file');
 assert.equal(claudeActionNow([start,{type:'user',message:{content:[{type:'tool_result',tool_use_id:'a',content:'secret'}]}}]),'Working');
 assert.equal(claudeActionNow([start,{type:'user',message:{content:[{type:'text',text:'private chat'}]}}]),'Working');
 assert.equal(claudeActionNow([start,{type:'assistant',message:{content:[],stop_reason:'end_turn'}}]),'Working');
});
test('fresh observation expires and cannot refresh itself from a reread or future timestamp', () => {
 const now=Date.parse('2026-11-09T20:00:00Z'), at=new Date(now).toISOString();
 assert.equal(observation('Running a command',at,now).expiresAt,'2026-11-09T20:00:30.000Z');
 assert.equal(observation('Running a command',at,now+30000),null);
 assert.equal(observation('Working',at,now-1),null);
 assert.equal(observation('pgrep secret',at,now),null);
 assert.equal(observation('Working','unknown',now),null);
});

test('change notifications renew observations in bounded buckets, never treating a lifecycle time as freshness', async () => {
 const {workingPrint}=await import('../src/delivery.mjs');
 const row={agent:'art',conversation:'cv-000000000001',since:1};
 assert.equal(workingPrint([row]),workingPrint([{...row,since:999}]));
 const a={action:'Working',observedAt:'2026-11-09T20:00:00Z'};
 assert.equal(workingPrint([{...row,activity:a}]),workingPrint([{...row,activity:{...a,observedAt:'2026-11-09T20:00:09Z'}}]));
 assert.notEqual(workingPrint([{...row,activity:a}]),workingPrint([{...row,activity:{...a,observedAt:'2026-11-09T20:00:10Z'}}]));
 assert.notEqual(workingPrint([{...row,activity:a}]),workingPrint([{...row,activity:{...a,action:'Reading a file'}}]));
});

test('retained offline and starting work never masquerades as a fresh observation', async () => {
 const { world, cvOf } = await import('./delivery-world.mjs');
 const { deliver, workingConversations } = await import('../src/delivery.mjs');
 const w=world();
 await deliver(w.env,{source:'loom',id:'now',agent:'mark',venue:'loom',place:'th:abcdefghij',from:{kind:'person',slug:'jonathan'},kind:'message',at:w.clock.now().toISOString(),text:'private'},w.o);
 w.runner.tickerAction=()=> 'Reading a file';
 const rows=()=>workingConversations(w.env,w.o,w.clock.now().getTime());
 assert.equal(rows()[0].activity.action,'Reading a file');
 w.runner.remote=true;
 w.runner.pending=()=>true;
 w.runner.status=()=> 'unknown';
 assert.equal(rows()[0].activity,undefined);
});
