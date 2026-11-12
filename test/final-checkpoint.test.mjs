import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ClaudeRunner } from '../src/runners.mjs';
import { dropSession, packSession } from '../src/sessions.mjs';
import { scratch } from './scratch.mjs';

const event = text => JSON.stringify({ type: 'assistant', message: { content: [{type: 'text', text}] } }) + '\n';
function fixture(count = 1, padding = 0) {
  const root = scratch('final-checkpoint-'), jobsDir = join(root, 'jobs'), projectsDir = join(root, 'projects');
  const project = join(projectsDir, 'p'); fs.mkdirSync(project, {recursive:true});
  const entries = Array.from({length:count}, (_,i) => {
    const id = i.toString(16).padStart(8,'0'), session = `${id}-session`, dir = join(jobsDir,id), file = join(project, `${session}.jsonl`);
    fs.mkdirSync(dir, {recursive:true}); fs.writeFileSync(join(dir,'state.json'),JSON.stringify({sessionId:session}));
    fs.writeFileSync(file,(padding ? JSON.stringify({type:'tool',padding:'x'.repeat(padding)})+'\n' : '')+event('last 界 🐟'));
    return {id,slot:{harness:'claude',session},dir,file,checkpoint:join(dir,'.loom-final')};
  });
  return {root,jobsDir,projectsDir,entries,runner:new ClaudeRunner({jobsDir,projectsDir,readMax:{final:7}})};
}
function bytesFrom(files, fn) {
  const inodes = new Set(files.map(p=>fs.statSync(p).ino)), original = fs.readSync;
  let bytes = 0, reads = 0;
  fs.readSync = (...args) => { const n = original(...args); if (inodes.has(fs.fstatSync(args[0]).ino)) {bytes+=n;reads++;} return n; };
  syncBuiltinESMExports();
  try { fn(); } finally {fs.readSync=original;syncBuiltinESMExports();}
  return {bytes,reads};
}
function cold(f, body = f.entries[0], slice = 7, expectedBytes) {
  const source = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {ClaudeRunner} from ${JSON.stringify(new URL('../src/runners.mjs',import.meta.url).href)};
const ino=fs.statSync(${JSON.stringify(body.file)}).ino,read=fs.readSync;let bytes=0;
fs.readSync=(...args)=>{const n=read(...args);if(fs.fstatSync(args[0]).ino===ino)bytes+=n;return n;};syncBuiltinESMExports();
const r = new ClaudeRunner(${JSON.stringify({jobsDir:f.jobsDir,projectsDir:f.projectsDir,readMax:{final:slice}})});
console.log(JSON.stringify({words:r.final(${JSON.stringify({id:body.id,slot:body.slot})}),bytes}));`;
  const got=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'});
  assert.equal(got.status,0,got.stderr); const result=JSON.parse(got.stdout);
  if(expectedBytes !== undefined) assert.equal(result.bytes,expectedBytes,'cold transcript byte count');
  return result.words;
}

test('final checkpoints eliminate transcript reads across 128 rotating jobs and a new process', () => {
  const f = fixture(128,16*1024), r = new ClaudeRunner({jobsDir:f.jobsDir,projectsDir:f.projectsDir});
  const poll=()=>{for(const b of f.entries) assert.equal(r.final(b),'last 界 🐟');};
  const files=f.entries.map(b=>b.file), initial=bytesFrom(files,poll), next=bytesFrom(files,poll);
  assert.ok(initial.bytes>128*16*1024); assert.deepEqual(next,{bytes:0,reads:0});
  const times=f.entries.map(b=>fs.statSync(b.checkpoint,{bigint:true}).mtimeNs);
  assert.deepEqual(bytesFrom(files,poll),{bytes:0,reads:0});
  assert.deepEqual(f.entries.map(b=>fs.statSync(b.checkpoint,{bigint:true}).mtimeNs),times,'unchanged checkpoints are not rewritten');
  const b=f.entries[0];
  fs.appendFileSync(b.file,event('appended 🐟'));
  assert.deepEqual(bytesFrom([b.file],()=>assert.equal(r.final(b),'appended 🐟')),{bytes:Buffer.byteLength(event('appended 🐟')),reads:1});
  assert.equal(cold(f,b,7,0),'appended 🐟');
});

test('final checkpoint restores unfinished UTF-8, unterminated words and oversized-line skip state', () => {
  const f=fixture(),b=f.entries[0],r=f.runner;
  const line=Buffer.from(event('next 界 🐟').trimEnd()), cut=line.indexOf(Buffer.from('🐟'))+2;
  fs.writeFileSync(b.file,Buffer.concat([Buffer.from(event('old')),line.subarray(0,cut)]));
  assert.equal(r.final(b),'old'); assert.equal(cold(f),'old');
  fs.appendFileSync(b.file,line.subarray(cut)); assert.equal(cold(f,b,7,line.length-cut+2),'next 界 🐟');
  // Valid unterminated words must survive their line becoming too large on a later poll.
  fs.appendFileSync(b.file,' '.repeat(17*1024*1024));
  assert.match(cold(f,b,4*1024*1024),/transcript line exceeded.*\nnext 界 🐟$/);
  assert.match(cold(f,b,7,0),/transcript line exceeded.*\nnext 界 🐟$/);
  fs.appendFileSync(b.file,'\n'+event('recovered'));
  assert.equal(cold(f),'recovered');
});

test('final checkpoint resets for truncation/replacement and rejects corrupt, huge and linked checkpoint files', () => {
  const f=fixture(),b=f.entries[0]; assert.equal(f.runner.final(b),'last 界 🐟');
  fs.writeFileSync(b.file,event('short'));assert.equal(cold(f),'short');
  fs.renameSync(b.file,b.file+'.old');fs.writeFileSync(b.file,event('replacement'));
  assert.equal(cold(f),'replacement');
  const other=fixture();assert.equal(other.runner.final(other.entries[0]),'last 界 🐟');
  for(const mode of ['corrupt','oversize','symlink','wrong-session']) {
    fs.rmSync(b.checkpoint,{force:true});
    if(mode==='corrupt') fs.writeFileSync(b.checkpoint,'broken');
    if(mode==='oversize') {const fd=fs.openSync(b.checkpoint,'w');fs.ftruncateSync(fd,128*1024*1024);fs.closeSync(fd);}
    if(mode==='symlink') fs.symlinkSync(b.file+'.old',b.checkpoint);
    if(mode==='wrong-session') {
      fs.copyFileSync(other.entries[0].checkpoint,b.checkpoint);
    }
    const old=fs.readFileSync(b.file+'.old','utf8');
    assert.equal(cold(f),'replacement',mode);
    assert.equal(fs.readFileSync(b.file+'.old','utf8'),old,'checkpoint symlink target untouched');
  }
});

test('final checkpoints retire with jobs, are never packed, and slot-only cleanup drops RAM and leftover checkpoints', () => {
  const f=fixture(2),[a,b]=f.entries,r=f.runner;
  for(const job of [a,b]) assert.equal(r.final(job),'last 界 🐟');
  fs.writeFileSync(join(a.dir,'.loom-final-'+ 'a'.repeat(24)+'.tmp'),'crash');
  const packed=packSession(r,a.slot,a); assert.ok(packed.length);assert.ok(packed.every(p=>!p.rel.includes('.loom-final')));
  dropSession(r,a.slot,a);
  assert.equal(fs.existsSync(a.dir),false);assert.equal(fs.existsSync(b.checkpoint),true);
  dropSession(r,b.slot); assert.equal(fs.existsSync(b.checkpoint),false);
  // RAM must not preserve the retired words when a new file appears at the same path.
  fs.writeFileSync(b.file,event('brand new')); assert.equal(r.final(b),'brand new');
  fs.rmSync(b.dir,{recursive:true}); fs.appendFileSync(b.file,event('after retirement'));
  assert.equal(r.final(b),'after retirement'); assert.equal(fs.existsSync(b.dir),false,'polling cannot recreate a retired job');
});

test('final checkpoint refuses mismatched job ownership, job links and disappearing/replaced job directories', () => {
  const f=fixture(4),r=f.runner,[a,b,c,d]=f.entries;
  fs.writeFileSync(join(a.dir,'state.json'),JSON.stringify({sessionId:'another-session'}));
  assert.equal(r.final(a),'last 界 🐟');assert.equal(fs.existsSync(a.checkpoint),false);
  fs.renameSync(b.dir,b.dir+'.old');fs.symlinkSync(b.dir+'.old',b.dir);
  assert.equal(r.final(b),'last 界 🐟');assert.equal(fs.existsSync(join(b.dir+'.old','.loom-final')),false);
  const original=fs.readSync;let once=false;
  fs.readSync=(...args)=>{const n=original(...args);if(!once&&fs.fstatSync(args[0]).ino===fs.statSync(c.file).ino){once=true;fs.rmSync(c.dir,{recursive:true});}return n;};
  syncBuiltinESMExports();try{assert.equal(r.final(c),'last 界 🐟');}finally{fs.readSync=original;syncBuiltinESMExports();}
  assert.equal(fs.existsSync(c.dir),false);
  once=false;
  fs.readSync=(...args)=>{const n=original(...args);if(!once&&fs.fstatSync(args[0]).ino===fs.statSync(d.file).ino){once=true;fs.renameSync(d.dir,d.dir+'.old');fs.mkdirSync(d.dir);fs.writeFileSync(join(d.dir,'state.json'),JSON.stringify({sessionId:d.slot.session}));}return n;};
  syncBuiltinESMExports();try{assert.equal(r.final(d),'last 界 🐟');}finally{fs.readSync=original;syncBuiltinESMExports();}
  assert.equal(fs.existsSync(d.checkpoint),false);assert.equal(fs.existsSync(join(d.dir+'.old','.loom-final')),false);
});


test('final checkpoint preserves escaped unpaired surrogates in assistant text', () => {
  const f=fixture(),b=f.entries[0];
  const words='high \ud800 and low \udfff and paired 🐟';
  fs.writeFileSync(b.file,event(words));
  assert.equal(f.runner.final(b),words);assert.equal(cold(f),words);
});

test('final checkpoint validates checksum and lengths before trusting words or allocating fields', () => {
  const f=fixture(),b=f.entries[0]; assert.equal(f.runner.final(b),'last 界 🐟');
  const good=fs.readFileSync(b.checkpoint), n=good.readUInt32BE(), h=JSON.parse(good.subarray(4,4+n));
  const damaged=Buffer.from(good);damaged[4+n+h.restBytes]^=1;
  fs.writeFileSync(b.checkpoint,damaged);
  assert.equal(cold(f),'last 界 🐟','valid structure with altered words fails checksum and rescans');
  // A malicious header must not turn a short file into a huge allocation.
  const head=Buffer.from(JSON.stringify({...h,restBytes:2**40})),prefix=Buffer.alloc(4);prefix.writeUInt32BE(head.length);
  fs.writeFileSync(b.checkpoint,Buffer.concat([prefix,head,Buffer.alloc(32)]));
  assert.equal(cold(f),'last 界 🐟');
  fs.writeFileSync(b.checkpoint,good.subarray(0,good.length-1));
  assert.equal(cold(f),'last 界 🐟','short payload is rejected');
});

test('final checkpoint preserves snapshot retry semantics after a cold restore', () => {
  const f=fixture(65),r=new ClaudeRunner({jobsDir:f.jobsDir,projectsDir:f.projectsDir}),b=f.entries[0];
  for(const job of f.entries) assert.equal(r.final(job),'last 界 🐟'); // first state is now on disk only
  fs.appendFileSync(b.file,event('discarded'));
  const read=fs.readSync,ino=fs.statSync(b.file).ino;let changed=false;
  fs.readSync=(...args)=>{const n=read(...args);if(!changed&&fs.fstatSync(args[0]).ino===ino){changed=true;fs.renameSync(b.file,b.file+'.old');fs.writeFileSync(b.file,event('replacement'));}return n;};
  syncBuiltinESMExports();try{assert.equal(r.final(b),'replacement');}finally{fs.readSync=read;syncBuiltinESMExports();}
  assert.equal(cold(f),'replacement','discarded snapshot was never checkpointed');
});
