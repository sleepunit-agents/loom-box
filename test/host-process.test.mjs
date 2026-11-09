import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HOUSE = join(dirname(fileURLToPath(import.meta.url)), '..', 'house');
const pause = ms => new Promise(r => setTimeout(r, ms));
const until = async fn => { const end=Date.now()+5000; while(!fn()) { if(Date.now()>end) throw Error('fixture did not become ready'); await pause(10); } };
const wrapper = `from loom_host_process import run_host
import pathlib,sys,json,os
r=run_host([sys.executable,sys.argv[1]],stdin=None)
pathlib.Path(os.environ['CASE_DIR'],'rescued').write_text(json.dumps({'code':r.code,'cancelled':r.cancelled}))
sys.exit(0 if r.cancelled else r.code)
`;
for (const code of [130,7]) test(`a parent forwards TERM, waits for collection, and preserves ${code===130?'intentional cancellation':'a genuine failure'}`, async () => {
  const dir=mkdtempSync(join(tmpdir(),'host-process-'));
  const child=join(dir,'child.py');
  writeFileSync(child,`import signal,os,pathlib,time,sys
p=pathlib.Path(os.environ['CASE_DIR'])
p.joinpath('pid').write_text(str(os.getpid()))
def stop(*_):
 p.joinpath('stopping').write_text('requested')
 while not p.joinpath('release').exists():time.sleep(.01)
 p.joinpath('collected').write_text('saved')
 sys.exit(${code})
signal.signal(signal.SIGTERM,stop)
p.joinpath('ready').write_text('ready')
while True:time.sleep(10)
`);
  const p=spawn('python3',['-c',wrapper,child],{env:{PATH:process.env.PATH,PYTHONPATH:HOUSE,CASE_DIR:dir},stdio:['ignore','pipe','pipe']});
  let error='';p.stderr.on('data',b=>{error+=b});
  const done=new Promise(resolve=>p.once('close',(exit,signal)=>resolve({exit,signal})));
  try {
    await until(()=>existsSync(join(dir,'ready')));
    p.kill('SIGTERM');await until(()=>existsSync(join(dir,'stopping')));
    assert.equal(existsSync(join(dir,'rescued')),false,'Git rescue must wait for the runtime acknowledgement');
    assert.equal(p.exitCode,null);
    writeFileSync(join(dir,'release'),'go');
    const result=await done;assert.equal(result.exit,code===130?0:7,error);assert.equal(result.signal,null);
    assert.equal(readFileSync(join(dir,'collected'),'utf8'),'saved');
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'rescued'),'utf8')),{code,cancelled:code===130});
  } finally {
    writeFileSync(join(dir,'release'),'cleanup');
    if(p.exitCode===null)p.kill('SIGTERM');
    if(existsSync(join(dir,'pid'))) {
      const pid=Number(readFileSync(join(dir,'pid'),'utf8'));
      try { if(readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from(child))) process.kill(pid,'SIGTERM'); } catch {}
    }
    await done;rmSync(dir,{recursive:true,force:true});
  }
});

test('an unsolicited failure or cancellation code never becomes a successful house stop', () => {
  for(const code of [7,130]) {
    const p=spawnSync('python3',['-c',`from loom_host_process import run_host
import sys
r=run_host([sys.executable,'-c','raise SystemExit(${code})'])
assert r.code==${code} and not r.cancelled
`],{env:{PATH:process.env.PATH,PYTHONPATH:HOUSE},encoding:'utf8'});
    assert.equal(p.status,0,p.stderr);
  }
});
