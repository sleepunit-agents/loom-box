// Cross-piece conformance against the companion approvals checkout, never a real store.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync, execFile} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requestForBody, withProfileLock, amendment, commitAmendment} from '../src/profile-amendment.mjs';
import {jobProfileKey, minimalProfile, profileEnv, selectedProfile} from '../src/work-profile.mjs';
import {act} from '../src/ui.mjs';
import {runFor} from '../src/gates-api.mjs';
const bin = process.env.PROFILE_APPROVALS_BIN;
test('authenticated runtime request → real approvals Deny/Allow → owner executor → persisted next launch', {skip: !bin}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-approval-integration-'));
  try {
    const file = join(root, 'profiles.json'), job = {agent:'art',venue:'spawn',kind:'agent',place:'fixture'};
    writeFileSync(file, JSON.stringify({v:1,jobs:{[jobProfileKey(job)]:minimalProfile()}}));
    const env = {HOME:root, PATH:process.env.PATH, LOOM_RUNTIME_JOB_PROFILES:file, APPROVALS_DIR:join(root,'approvals'), APPROVALS_LOCAL_AGENT:'art', LOOM_RUNTIME_TEST_STORE:{}};
    // Exercise the piece's real CLI/UI functions with a temporary host store.
    // Its main() house forwarding is deliberately outside this fixture.
    const host = join(root,'approvals-host');
    writeFileSync(host, `#!/usr/bin/python3\nimport runpy,sys,json\na=runpy.run_path(${JSON.stringify(bin)})\nif sys.argv[1:]==['ui','act']: print(json.dumps(a['ui_act'](json.load(sys.stdin))))\nelse: print(a['run'](sys.argv[1:]),end='')\n`); chmodSync(host,0o700);
    const call = (args, input) => spawnSync(host,args,{env,encoding:'utf8',input,timeout:6000});
    const rec = {...job,profile:JSON.stringify(minimalProfile())}, cv='cv-0123456789ab';
    const d = {householdAgent:()=>true,heldConv:(_env,_cv,p)=>p.key==='correct' && p.session==='session' ? {agent:'art',body:'claude:fixture',local:true} : null,principalOf:()=>({owner:true}),readBody:()=>rec,
      approvalsRun:(_env,args)=>new Promise(resolve=>execFile(host,args,{env,encoding:'utf8',timeout:6000},(error,stdout,stderr)=>resolve({status:error ? 1 : 0,stdout,stderr}))) };
    const entry=(args, deps=d, proof={key:'correct',session:'session'})=>runFor(env,{kind:'agent',agent:'art'},['profile','request','--conversation',cv,'--field','tools','--name',...args],{}, {},undefined,proof,deps);
    for (const deps of [{...d,principalOf:()=>({owner:false})},{...d,readBody:()=>({...rec,ended:true})}]) assert.notEqual((await entry(['Read'],deps)).exit,0);
    assert.equal((await entry(['Read','--profile','forged'])).exit,2);
    assert.notEqual((await entry(['Read'],d,{key:'wrong',session:'session'})).exit,0);
    const ask = name => requestForBody(env,{kind:'agent',agent:'art'},{conversation:cv,field:'tools',name},{key:'correct',session:'session'},d);
    await assert.rejects(requestForBody(env,{kind:'agent',agent:'art'},{conversation:cv,field:'tools',name:'Read'},{key:'wrong',session:'session'},d), /authenticated/);
    const [a,b] = await Promise.all([ask('Read'),ask('Read')]); assert.equal(a.approval,b.approval);
    const owner={kind:'owner',who:'jonathan-barket',agents:'*'};
    const answer = (id, action) => {const r=call(['ui','act'],JSON.stringify({action,fields:{id},caller:owner}));assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).ok,true);};
    answer(a.approval,'deny'); assert.equal((await ask('Read')).approval,a.approval); assert.equal((await ask('Read')).state,'denied');
    assert.deepEqual(selectedProfile(profileEnv({},'agent',env,job)),minimalProfile());
    // A different missing capability has a different card; Deny never permits a spend.
    env.LOOM_RUNTIME_TEST_APPROVALS={spend:(id,target,agent)=>{const r=call(['use',id,'--kind','grant','--target',target,'--as',JSON.stringify({kind:'agent',agent})]);return r.status===0 && r.stdout.trim()===`${id}: used` ? '' : r.stderr;}};
    const fields={id:a.approval,agent:'art',target:a.target};
    assert.equal(act(env,{}, {action:'grant-approved',fields,caller:owner}).ok,false);
    const stale=await ask('Write'); answer(stale.approval,'allow');
    const c=await ask('Bash'); answer(c.approval,'allow');
    // Simulate a process crash after the trusted spend, before profile write.
    assert.equal(env.LOOM_RUNTIME_TEST_APPROVALS.spend(c.approval,c.target,'art'),'');
    assert.deepEqual(selectedProfile(profileEnv({},'agent',env,job)),minimalProfile());
    const allowed={id:c.approval,agent:'art',target:c.target};
    assert.equal(act(env,{}, {action:'grant-approved',fields:allowed,caller:{kind:'agent',agent:'art'}}).ok,false);
    assert.equal(act(env,{}, {action:'grant-approved',fields:{...allowed,agent:'other'},caller:owner}).ok,false);
    assert.equal(act(env,{}, {action:'grant-approved',fields:allowed,caller:owner}).ok,true);
    assert.equal(act(env,{}, {action:'grant-approved',fields:{id:stale.approval,agent:'art',target:stale.target},caller:owner}).ok,false);
    // Fresh selection reads only the durable store; no request-process state.
    const moduleURL = new URL('../src/work-profile.mjs',import.meta.url).href;
    const fresh = spawnSync(process.execPath,['--input-type=module','-e',`import {profileEnv,selectedProfile} from ${JSON.stringify(moduleURL)};process.stdout.write(JSON.stringify(selectedProfile(profileEnv({},'agent',{LOOM_RUNTIME_JOB_PROFILES:${JSON.stringify(file)}},${JSON.stringify(job)}))))`],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:root}});
    assert.equal(fresh.status,0,fresh.stderr); assert.deepEqual(JSON.parse(fresh.stdout).tools,['Bash']);
    assert.equal(act(env,{}, {action:'grant-approved',fields:allowed,caller:owner}).ok,true);
    assert.deepEqual(JSON.parse(readFileSync(file)).jobs[jobProfileKey(job)].tools,['Bash']);
    await assert.rejects(ask('Read'), /profile changed/);
    const otherJob = {...job,place:'other-job'}, store=JSON.parse(readFileSync(file));
    store.jobs[jobProfileKey(otherJob)]=minimalProfile(); writeFileSync(file,JSON.stringify(store)); rec.place=otherJob.place;
    const other=await ask('Write'); answer(other.approval,'allow');
    const cross={id:c.approval,agent:'art',target:other.target};
    assert.equal(act(env,{}, {action:'grant-approved',fields:cross,caller:owner}).ok,false);
    assert.deepEqual(JSON.parse(readFileSync(file)).jobs[jobProfileKey(otherJob)],minimalProfile());
    assert.equal(act(env,{}, {action:'grant-approved',fields:{id:other.approval,agent:'art',target:other.target},caller:owner}).ok,true);
    assert.deepEqual(JSON.parse(readFileSync(file)).jobs[jobProfileKey(job)].tools,['Bash']);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('profile lock serializes live writers and releases on SIGKILL before callback retry', () => {
  const root=mkdtempSync(join(tmpdir(),'profile-lock-'));
  try {
    const file=join(root,'profiles.json'), key=jobProfileKey({agent:'art',venue:'wake',kind:'scheduled'});
    writeFileSync(file,JSON.stringify({v:1,jobs:{[key]:minimalProfile()}}));
    const a=amendment(key,minimalProfile(),'tools','Read');
    withProfileLock(file,()=>assert.throws(()=>commitAmendment(file,a),/locked/));
    const url=new URL('../src/profile-amendment.mjs',import.meta.url).href;
    const child=spawnSync(process.execPath,['--input-type=module','-e',`import {withProfileLock} from ${JSON.stringify(url)};withProfileLock(${JSON.stringify(file)},()=>process.kill(process.pid,'SIGKILL'))`],{timeout:5000});
    assert.equal(child.signal,'SIGKILL'); assert.equal(commitAmendment(file,a).applied,true);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('profile publication interrupted before or after rename recovers atomically without losing another job', () => {
  for (const stage of ['before','after']) {
    const root=mkdtempSync(join(tmpdir(),'profile-publish-'));
    try {
      const file=join(root,'profiles.json'),key='job',other={...minimalProfile(),tools:['Bash']};
      writeFileSync(file,JSON.stringify({v:1,jobs:{[key]:minimalProfile(),other}}));
      const a=amendment(key,minimalProfile(),'tools','Read'),url=new URL('../src/profile-amendment.mjs',import.meta.url).href;
      const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;fs.renameSync=(src,dst)=>{if(dst===${JSON.stringify(file)} && ${JSON.stringify(stage)}==='before')process.kill(process.pid,'SIGKILL');rename(src,dst);if(dst===${JSON.stringify(file)})process.kill(process.pid,'SIGKILL');};syncBuiltinESMExports();const {commitAmendment}=await import(${JSON.stringify(url)});commitAmendment(${JSON.stringify(file)},${JSON.stringify(a)});`;
      const child=spawnSync(process.execPath,['--input-type=module','-e',script],{timeout:5000});assert.equal(child.signal,'SIGKILL');
      const saved=JSON.parse(readFileSync(file));assert.deepEqual(saved.jobs.other,other);
      assert.deepEqual(saved.jobs[key].tools,stage==='before'?[]:['Read']);
      assert.equal(Boolean(saved.applied?.[a.target]),stage==='after');
      const result=commitAmendment(file,a);assert.equal(result.applied,stage==='before');
      assert.deepEqual(JSON.parse(readFileSync(file)).jobs.other,other);
    } finally {rmSync(root,{recursive:true,force:true});}
  }
});

test('new request directories are durable before a card is filed', async () => {
  const root=mkdtempSync(join(tmpdir(),'profile-request-durable-')),file=join(root,'profiles.json');
  const job={agent:'art',venue:'wake',kind:'scheduled'},synced=[],real=fs.fsyncSync;
  try {
    writeFileSync(file,JSON.stringify({v:1,jobs:{[jobProfileKey(job)]:minimalProfile()}}));
    fs.fsyncSync=fd=>{synced.push(fs.readlinkSync(`/proc/self/fd/${fd}`));return real(fd);};syncBuiltinESMExports();
    const d={householdAgent:()=>true,heldConv:()=>({agent:'art',body:'claude:fixture',local:true}),principalOf:()=>({owner:true}),readBody:()=>({...job,profile:JSON.stringify(minimalProfile())}),approvalsRun:async(_env,args)=>{
      assert.ok(synced.includes(root));assert.ok(synced.includes(`${file}.requests`));assert.ok(synced.includes('/tmp'));
      return {status:0,stdout:JSON.stringify({id:'a-12345678',kind:'grant',state:'pending',target:args[args.indexOf('--target')+1]})};}};
    await requestForBody({LOOM_RUNTIME_JOB_PROFILES:file},{kind:'agent',agent:'art'},{conversation:'cv-0123456789ab',field:'tools',name:'Read'},{key:'fixture',session:'fixture'},d);
  } finally {fs.fsyncSync=real;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
});
