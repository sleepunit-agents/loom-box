import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeHouse, observationReplaced, reapHouseWaits, waitForHouseWaits } from '../src/house-watchers.mjs';

const options = { stdio: 'ignore' };
// Node ignores argv after -e's script, so it stands in for a long-lived wait.
const dir = mkdtempSync(join(tmpdir(), 'watchers-'));
const command = join(dir, 'podman');
writeFileSync(command, '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });

test('repeated adoption keeps exactly one live wait for each house', async () => {
  const other = await observeHouse(command, 'house-other', options);
  let previous, previousWait;
  const childPid = child => { try { return Number(readFileSync(`/proc/${child.pid}/task/${child.pid}/children`,'utf8').trim()); } catch { return 0; } };
  const alive = pid => { try { return !/^State:\s+[ZX]/m.test(readFileSync(`/proc/${pid}/status`,'utf8')); } catch { return false; } };
  const until = async f => { for(let n=0;n<200;n++){if(f())return;await new Promise(r=>setTimeout(r,10));}throw Error('timed out'); };
  try {
    for (let n = 0; n < 8; n++) {
      let next;
      if (previous) {
        process.kill(previous.pid,'SIGSTOP');
        let replacementStarted=false;
        const replacing=observeHouse(command,'house-one',options).then(child=>{replacementStarted=true;return child;});
        await new Promise(r=>setTimeout(r,30));
        assert.equal(replacementStarted,false,'replacement waits for stopped guardian');
        assert.ok(alive(previousWait),'previous wait remains sole observer until guardian resumes');
        process.kill(previous.pid,'SIGCONT');
        next=await replacing;
        assert.equal(alive(previousWait),false,'actual previous wait is gone before replacement starts');
      } else next = await observeHouse(command, 'house-one', options);
      if(!next.pid)await once(next, 'spawn');
      const group = pid => readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').pop().split(' ')[2];
      assert.equal(group(next.pid), group(process.pid), 'observer is not detached');
      if (previous) { assert.equal(observationReplaced(previous),true); if (previous.exitCode === null && previous.signalCode === null) await once(previous, 'exit'); assert.equal(previous.signalCode, 'SIGKILL'); }
      if(previousWait) await until(()=>!alive(previousWait));
      await until(()=>childPid(next)>0);
      previousWait=childPid(next);
      assert.ok(alive(previousWait),'actual wait is live');
      await until(()=>childPid(other)>0);
      assert.ok(alive(childPid(other)),'other house wait survives replacement');
      previous = next;
      assert.equal(other.signalCode, null);
      assert.equal(next.signalCode, null);
    }
  } finally { if(previous)try{process.kill(previous.pid,'SIGCONT');}catch{} previous?.kill('SIGKILL'); other.kill('SIGKILL'); }
});

test('orphan sweep requires exact executable, argv, parent and assigned house', () => {
  const proc = join(dir, 'proc'); mkdirSync(proc);
  const add = (id, parent, args, exe = command) => { const p=join(proc,String(id)); mkdirSync(p); writeFileSync(join(p,'status'),`PPid:\t${parent}\n`); writeFileSync(join(p,'cmdline'),args.join('\0')+'\0'); symlinkSync(exe,join(p,'exe')); };
  mkdirSync(join(proc,'99')); writeFileSync(join(proc,'99','comm'),'systemd\n');
  mkdirSync(join(proc,'98')); writeFileSync(join(proc,'98','comm'),'node\n');
  add(10,1,['podman','wait','ours']); add(11,99,['podman','wait','ours']);
  add(12,98,['podman','wait','ours']); add(13,1,['podman','wait','theirs']);
  add(14,1,['podman','stop','ours']); add(15,1,['podman','wait','ours','theirs']);
  add(16,1,['podman','wait','ours'],process.execPath);
  add(28,1,['unrelated-name','wait','ours']);
  add(24,1,['podman','wait','','ours']);
  add(17,1,['podman','wait','ours-extra']);
  mkdirSync(join(proc,'97')); writeFileSync(join(proc,'97','comm'),'tini\n');
  mkdirSync(join(proc,'96')); writeFileSync(join(proc,'96','comm'),'dumb-init\n');
  const marked = (id, value) => writeFileSync(join(proc,String(id),'environ'),`LOOM_WAIT_OWNER=${value}\0`);
  add(20,98,['podman','wait','ours']); marked(20,'500:123');
  add(21,98,['podman','wait','ours']); marked(21,'501:123');
  mkdirSync(join(proc,'501')); writeFileSync(join(proc,'501','stat'),'501 (custom runtime) S '+Array(18).fill('0').join(' ')+' 123');
  add(22,98,['podman','wait','ours']); marked(22,'501:122');
  add(25,98,['podman','wait','ours']); marked(25,'502:123');
  mkdirSync(join(proc,'502')); writeFileSync(join(proc,'502','stat'),'502 (zombie runtime) Z '+Array(18).fill('0').join(' ')+' 123');
  add(26,1,['podman','wait','ours']); marked(26,'');
  add(23,98,['podman','wait','ours']); marked(23,'invalid');
  add(18,97,['podman','wait','ours']); add(19,96,['podman','wait','ours']);
  const expected=[[10,'SIGKILL'],[11,'SIGKILL'],[18,'SIGKILL'],[19,'SIGKILL'],[20,'SIGKILL'],[22,'SIGKILL'],[25,'SIGKILL']];
  const killed=[]; reapHouseWaits(command,new Set(['ours']),proc,(pid,sig)=>killed.push([pid,sig]));
  assert.deepEqual(killed,expected);
  killed.length = 0;
  reapHouseWaits('podman',new Set(['ours']),proc,(pid,sig)=>killed.push([pid,sig]),dir);
  assert.deepEqual(killed,expected, 'uses the runtime PATH');
  const nonexec=join(dir,'nonexec'), directory=join(dir,'directory');
  mkdirSync(nonexec); mkdirSync(directory);
  writeFileSync(join(nonexec,'podman'),'not executable',{mode:0o644});
  mkdirSync(join(directory,'podman'));
  killed.length=0;
  reapHouseWaits('podman',new Set(['ours']),proc,(pid,sig)=>killed.push([pid,sig]),[nonexec,directory,dir].join(':'));
  assert.deepEqual(killed,expected, 'skips non-executable files and directories');
  killed.length=0;
  reapHouseWaits(command,new Set(['ours']),proc,(pid,sig)=>killed.push([pid,sig]),dir,new Set([12,13,14,15,16,17,21,23,24,26]));
  assert.deepEqual(killed,[...expected.slice(0,2),[12,'SIGKILL'],...expected.slice(2)],'explicit legacy PID still requires executable/name/argv and preserves marked live owners');
  rmSync(proc,{recursive:true});
});

test('death acknowledgement times out for a pending kill and accepts a zombie', async () => {
  const proc=join(dir,'pending-proc');mkdirSync(join(proc,'100'),{recursive:true});
  const status=join(proc,'100','status');writeFileSync(status,'State: D\n');
  try {
    await assert.rejects(waitForHouseWaits([100],proc,20),/still running/);
    let released=false;
    const timer=setTimeout(()=>{released=true;writeFileSync(status,'State: Z\n');},30);
    try { await waitForHouseWaits([100],proc,200); assert.equal(released,true,'death was acknowledged before startup continues'); }
    finally { clearTimeout(timer); }
  } finally { rmSync(proc,{recursive:true}); }
});

test('default startup cleanup blocks real adoption, retries rejection, and awaits death acknowledgement', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test',
    new URL('./fixtures/pending-watcher-cleanup.mjs', import.meta.url).pathname],
  { encoding: 'utf8', timeout: 15000, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const [output,exit] of [['9',0],['0',7]]) test(`guardian forwards actual wait output ${output} and exit ${exit}`, async () => {
  const command=join(dir,'result-'+exit);writeFileSync(command,`#!/bin/sh\nprintf '${output}\\n'\nexit ${exit}\n`,{mode:0o755});
  const child=await observeHouse(command,'result-'+exit,{stdio:['ignore','pipe','ignore']});
  let result='';child.stdout.on('data',d=>result+=d);
  const [code]=await once(child,'close');
  assert.equal(code,exit);assert.equal(result,output+'\n');
});
