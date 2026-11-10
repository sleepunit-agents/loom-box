import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const reapScript = new URL('../scripts/reap-house-waits.mjs', import.meta.url).pathname;
const box = new URL('../src/box.mjs', import.meta.url).href;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let n=0;n<200;n++) { if(fn()) return; await pause(25); } throw Error('timed out'); }
function alive(pid) { try { return !/^State:\s+[ZX]/m.test(readFileSync(`/proc/${pid}/status`, 'utf8')); } catch(e) { if(e.code==='ENOENT')return false; throw e; } }

// A real custom Linux subreaper, deliberately not named systemd/tini/dumb-init.
// It launches the runtime and reaps its descendants without signalling them.
const supervisor = `import ctypes, subprocess, sys, os
ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
p=subprocess.Popen(sys.argv[1:])
while True:
 try: os.wait()
 except ChildProcessError: break
`;
for (const mode of ['normal', 'SIGKILL', 'recovery', 'historical', 'script', 'legacy']) test(`real runner ${mode}: waits die under a custom subreaper and houses survive`, async () => {
  const dir=mkdtempSync(join(tmpdir(),'wait-crash-'));
  const waitFile=join(dir,'waits');
  // A real executable: /proc/exe and the exact three-element wait argv match.
  const podman=join(dir,'podman');
  writeFileSync(join(dir,'podman.c'), `#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
int main(int n,char **a) {
 FILE *p=fopen("physical","r");int physical=0;if(p){fscanf(p,"%d",&physical);fclose(p);}
 if(n>1 && !strcmp(a[1],"stop") && physical>0)kill(physical,SIGKILL);
 if(n==3 && !strcmp(a[1],"wait")) { FILE *f=fopen("waits","a"); fprintf(f,"{\\\"pid\\\":%d,\\\"name\\\":\\\"%s\\\",\\\"parent\\\":%d}\\n",getpid(),a[2],getppid());fclose(f);while(physical>0 && !kill(physical,0))usleep(10000);puts("0"); }
 if(n>1 && !strcmp(a[1],"inspect")) puts("true");
 return 0;
}`);
  const built=spawnSync('cc',[join(dir,'podman.c'),'-o',podman],{encoding:'utf8'});
  assert.equal(built.status,0,built.stderr);
  const physical=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  await once(physical,'spawn');
  writeFileSync(join(dir,'physical'),String(physical.pid));
  let runtime, superProcess, generation=0;
  const start = async () => {
    const expectedWaits=generation===0?2:mode==='historical'?3:4;
    const active=generation>0&&mode==='historical'?['h-456']:['h-123','h-456'];
    generation++;
    const source=`import {runner} from ${JSON.stringify(box)};
      const r=runner({HOME:${JSON.stringify(dir)},PATH:${JSON.stringify(dir)}+':'+process.env.PATH,LOOM_BOX_DATA:${JSON.stringify(join(dir,'data'))},LOOM_BOX_PODMAN:'podman'},
        {call:async p=>p==='poll'?{active:${JSON.stringify(active)}}:{}},
        {loomUrl:'http://loom.test/mcp',log:()=>{},sweep:()=>[],status:()=>null,sampleHealth:()=>null,bootInfo:()=>null,sampleUnits:()=>null});
      let guards;
      if(${JSON.stringify(mode)}==='legacy') {
        const {spawn}=await import('node:child_process');
        guards=['h-123','h-456'].map(id=>spawn(${JSON.stringify(podman)},['wait','loom-house-'+id],{env:{PATH:process.env.PATH},stdio:'ignore'}).pid);
      } else { await r.tick(); guards=[...r.houses.values()].map(e=>e.child.pid); }
      console.log(JSON.stringify({pid:process.pid,guards}));
      process.stdin.resume();process.stdin.once('data',()=>process.exit(0));`;
    superProcess=spawn('python3',['-c',supervisor,process.execPath,'--input-type=module','-e',source],{cwd:dir,stdio:['pipe','pipe','inherit']});
    let output='';superProcess.stdout.on('data',d=>output+=d);
    await until(()=>output.includes('\n'));runtime=JSON.parse(output.trim());
    await until(()=>existsSync(waitFile)&&readFileSync(waitFile,'utf8').trim().split('\n').length >= expectedWaits);
  };
  const waits=()=>readFileSync(waitFile,'utf8').trim().split('\n').map(JSON.parse);
  try {
    await start();
    const initial=waits();assert.equal(initial.length,2);
    assert.deepEqual(initial.map(w=>w.name).sort(),['loom-house-h-123','loom-house-h-456']);
    assert.ok(initial.every(w=>alive(w.pid)));
    if(mode==='normal')superProcess.stdin.write('exit\n');
    else {
      if(['recovery','historical','script'].includes(mode)) {
        // Simulate guardian loss too, leaving real exact-matching waits owned by
        // this custom subreaper. The default startup sweep must recover them.
        process.kill(runtime.pid,'SIGSTOP');
        for(const pid of runtime.guards)process.kill(pid,'SIGKILL');
        await until(()=>runtime.guards.every(pid=>!alive(pid)));
        assert.ok(initial.every(w=>alive(w.pid)));
      }
      process.kill(runtime.pid,'SIGKILL');
    }
    await until(()=>!alive(runtime.pid));
    if(mode==='script'||mode==='legacy') {
      for(const id of ['h-123','h-456'])mkdirSync(join(dir,'data','houses',id),{recursive:true});
      const sweep = (reap,pids=[]) => spawnSync(process.execPath,[reapScript,...(pids.length?['--legacy-pids='+pids.join(',')]:[])],{env:{...process.env,LOOM_BOX_DATA:join(dir,'data'),LOOM_BOX_PODMAN:podman,REAP:reap},encoding:'utf8'});
      const explicit=mode==='legacy'?initial.map(w=>w.pid):[];
      if(mode==='legacy') {
        assert.equal(sweep('1').stdout,'','automatic script skips unmarked custom-parent waits');
        assert.ok(initial.every(w=>alive(w.pid)));
      }
      const dry=sweep('0',explicit);assert.equal(dry.status,0,dry.stderr);
      assert.equal(dry.stdout.trim().split('\n').length,2);
      assert.ok(initial.every(w=>alive(w.pid)),'dry-run preserves every wait');
      const apply=sweep('1',explicit);assert.equal(apply.status,0,apply.stderr);
      await until(()=>initial.every(w=>!alive(w.pid)));
      assert.equal(sweep('0').stdout,'','final dry-run is empty');
    }
    if(mode==='recovery'||mode==='historical') {
      const oldSupervisor=superProcess;
      if(mode==='historical')mkdirSync(join(dir,'data','houses','h-123'),{recursive:true});
      await start();
      await until(()=>initial.every(w=>!alive(w.pid)));
      assert.ok(waits().slice(2).every(w=>alive(w.pid)),'replacement waits stay live');
      await until(()=>oldSupervisor.exitCode!==null);
      superProcess.stdin.write('exit\n');
    }
    await until(()=>waits().every(w=>!alive(w.pid)));
    assert.ok(alive(physical.pid),'physical house work survives');
    await until(()=>superProcess.exitCode!==null);
  } finally {
    try { process.kill(runtime?.pid,'SIGKILL'); } catch {}
    for(const w of existsSync(waitFile)?waits():[])try{process.kill(w.pid,'SIGKILL');}catch{}
    superProcess?.kill('SIGKILL');physical.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});
  }
});
