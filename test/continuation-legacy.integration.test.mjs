import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { continuationOutbox } from '../src/continuation-outbox.mjs';
import { ageSealer } from '../src/sealed.mjs';
import { scratch } from './scratch.mjs';

for (const state of ['unbound', 'bound', 'pending', 'attempted', 'delivered']) test(`fresh process upgrades sealed legacy ${state} without renewal or network`, async () => {
  const dir = scratch('legacy-');
  const sealer = ageSealer({ HOME: dir }, join(dir, 'keys'));
  const source = {agent:'art',conversation:'cv-aaaaaaaaaaaa',run:'run-aaaaaaaaaaaa',reset:null,principal:{for:'jonathan',owner:true,people:[]},target:{venue:'loom',place:'aaaaaaaaaaaaaaaa'}};
  const child = {...source,conversation:'cv-bbbbbbbbbbbb',run:'run-bbbbbbbbbbbb',target:{venue:'wake',place:'wake:w-123456'}};
  const binding = {wake:'w-123456',delivery:'clock:legacy',expiresAt:86401000};
  const options = {dir:join(dir,'outbox'),sealer,now:()=>1000,lifetimeMs:86400000};
  const out = continuationOutbox(options), {handle} = out.issue(source);
  if (state !== 'unbound') out.bind(handle,binding,source,child);
  if (['pending','attempted','delivered'].includes(state)) out.enqueue(handle,child,source,{id:'final',text:'legacy words'});
  if (['attempted','delivered'].includes(state)) await out.drain({current:cv=>cv===source.conversation?source:child,post:async()=>{if(state==='attempted')throw Error('lost receipt');return {ok:true,posted:true};}});
  // Explicit old-schema encrypted fixtures. This does not claim an old binary
  // performed issuance; it proves a new interpreter reads durable legacy bytes.
  for (const file of readdirSync(options.dir).filter(n=>/^(grant|report)-/.test(n))) {
    const path=join(options.dir,file), row=JSON.parse(sealer.open(readFileSync(path)));
    delete row.version;delete row.expiresAt;
    writeFileSync(path,sealer.seal(Buffer.from(JSON.stringify(row))));
  }
  const input={dir,source,child,binding,handle,state};
  const r=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {join} from 'node:path';
    import {continuationOutbox} from './src/continuation-outbox.mjs';
    import {ageSealer} from './src/sealed.mjs';
    const x=JSON.parse(process.env.LEGACY_FIXTURE);
    const out=continuationOutbox({dir:join(x.dir,'outbox'),sealer:ageSealer({HOME:x.dir},join(x.dir,'keys')),now:()=>2000});
    if(x.state==='unbound')assert.throws(()=>out.bind(x.handle,x.binding,x.source,x.child),/legacy/);
    else assert.throws(()=>out.enqueue(x.handle,x.child,x.source,{id:'new',text:'no'}),/legacy/);
    await out.drain({current:cv=>cv===x.source.conversation?x.source:x.child,post:()=>assert.fail('legacy post'),reconcile:()=>assert.fail('legacy reconciliation')});
    if(['pending','attempted','delivered'].includes(x.state))assert.equal(out.status(x.handle,x.child,'final').state,{pending:'expired',attempted:'indeterminate',delivered:'delivered'}[x.state]);
  `],{cwd:join(import.meta.dirname,'..'),env:{...process.env,LEGACY_FIXTURE:JSON.stringify(input)},encoding:'utf8',timeout:20000});
  assert.equal(r.status,0,r.stderr || String(r.error));
  for(const file of readdirSync(options.dir).filter(n=>/^(grant|report)-/.test(n))) assert.equal(JSON.parse(sealer.open(readFileSync(join(options.dir,file)))).expiresAt,undefined);
});
