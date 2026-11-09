import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runBodyHost } from '../src/bodyhost.mjs';
import { runnerFor } from '../src/runners.mjs';
import { readLaunch } from '../src/launch-journal.mjs';
import { scratch } from './scratch.mjs';

for (const harness of ['claude', 'codex']) test(`${harness}: a real native worker can remain pending while the host syncs and receives shutdown`, async () => {
  const home = scratch('bodyhost-native-admission-'), id = 'a'.repeat(64), rid = 'b'.repeat(16);
  const release = join(home, 'release'), marker = join(home, 'native-waiting');
  const native = new URL(harness === 'claude' ? './fake-claude.mjs' : './fake-codex.mjs', import.meta.url).href;
  const executable = join(home, 'gated-native.mjs');
  writeFileSync(executable, '#!/usr/bin/env node\nimport{existsSync,writeFileSync}from"node:fs";writeFileSync('+JSON.stringify(marker)+',"waiting");while(!existsSync('+JSON.stringify(release)+'))await new Promise(r=>setTimeout(r,10));await import('+JSON.stringify(native)+');\n');
  chmodSync(executable, 0o755);
  const codex = join(home, 'codex'); mkdirSync(codex); writeFileSync(join(codex, 'config.toml'), 'model="gpt"\n');
  const env = { ...process.env, HOME: home, PATH: dirname(process.execPath)+':'+process.env.PATH, FAKE_HARNESS: home, CODEX_HOME: codex,
    LOOM_BOX_DATA: join(home, 'data'), LOOM_RUNTIME_CLAUDE: executable, LOOM_RUNTIME_CODEX: executable, LOOM_RUNTIME_CODEX_PROFILE: '',
    LOOM_RUNTIME_CLAUDE_JOBS: join(home, 'jobs'), LOOM_RUNTIME_CODEX_RUNS: join(home, 'runs'), LOOM_RUNTIME_INBOX_DIR: join(home, 'inbox'),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/login', LOOM_LOGIN_CODEX: '/fixture/login', HOUSE_TASK: 'private-bootstrap-never-native-env' };
  const q = { attempt: id, harness, model: harness === 'codex' ? 'gpt' : 'opus', brief: 'harmless native host fixture' + (harness === 'codex' ? 'x'.repeat(1024 * 1024) : ''), key: 'fixture-body-key', conversation: 'cv-123456abcdef' };
  let pendingSyncs = 0, stopping = false, body, finished = false;
  try {
    await runBodyHost({ env, hostKey: 'private-fixture-bootstrap', runner: h => runnerFor(h, env), sleep: () => new Promise(r=>setTimeout(r,10)), beats: 1000,
      client: async (_path, { report }) => {
        if (report.starting.includes(rid) && !report.done[rid]) pendingSyncs++;
        if (existsSync(marker) && readLaunch(env, id)?.state === 'admitted' && pendingSyncs >= 2) {
          stopping = true; writeFileSync(release, 'continue');
        }
        if (report.done[rid]?.id) {
          body = report.done[rid].id;
          assert.equal(report.done[rid].inputConfirmed, true);
          assert.equal(report.done[rid].attempt, id);
        }
        if (body && (!report.bodies[body] || report.bodies[body].status === 'ended') && !report.starting.length) { finished = true; return { exit: true }; }
        return { req: body || stopping ? {} : { [rid]: q }, ...(stopping ? { stopping: true } : {}),
          stop: body ? { [body]: { at: 1, pack: false } } : {}, received: body ? [rid] : [] };
      } });
    assert.equal(finished, true);
    assert.ok(pendingSyncs >= 2, 'launching did not block authenticated sync');
    assert.equal(readLaunch(env, id).state, 'ready');
    const calls = readFileSync(join(home, 'argv.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(a => harness === 'claude' ? a.includes('--bg') : a.args?.[0] === 'exec').length, 1);
    if (harness === 'claude') assert.equal(JSON.parse(readFileSync(join(home, 'env.log'), 'utf8').trim()).names.includes('HOUSE_TASK'), false);
  } finally {
    writeFileSync(release, 'continue');
    const record = readLaunch(env, id);
    if (record?.body) runnerFor(harness, env).end(record.body, env);
  }
});

test('after actual worker death, a blocked Claude query leaves host sync and shutdown responsive', async()=>{
  const home=scratch('host-dead-worker-query-'),id='e'.repeat(64),rid='f'.repeat(16),job='1234abcd';
  const started=join(home,'native-job-admitted'),query=join(home,'query-started'),release=join(home,'release-query'),releaseBg=join(home,'release-bg'),block=join(home,'block-query'),proof=join(home,'query-proof');
  const executable=join(home,'native-query-gate.mjs'),native=new URL('./fake-claude.mjs',import.meta.url).href;
  writeFileSync(executable,`#!/usr/bin/env node
import{existsSync,mkdirSync,readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';
const args=process.argv.slice(2),home=process.env.FAKE_HARNESS;
if(args[0]==='--bg'){
 const prompt=readFileSync(0,'utf8'),session='host-observer-session';mkdirSync(join(home,'jobs',${JSON.stringify(job)}),{recursive:true});
 writeFileSync(join(home,'jobs',${JSON.stringify(job)},'state.json'),JSON.stringify({state:'working',intent:prompt,sessionId:session}));
 writeFileSync(join(home,'agents.json'),JSON.stringify([{id:${JSON.stringify(job)},sessionId:session,state:'running'}]));writeFileSync(${JSON.stringify(started)},'ready');
 while(!existsSync(${JSON.stringify(releaseBg)}))await new Promise(r=>setTimeout(r,10));process.exit(0);
}
if(args[0]==='agents'&&existsSync(${JSON.stringify(block)})){
 writeFileSync(${JSON.stringify(query)},'waiting');const end=Date.now()+2000;
 while(!existsSync(${JSON.stringify(release)})&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
 writeFileSync(${JSON.stringify(proof)},String(existsSync(${JSON.stringify(release)})));
}
await import(${JSON.stringify(native)});
`);
  chmodSync(executable,0o755);
  const env={...process.env,HOME:home,PATH:dirname(process.execPath)+':'+process.env.PATH,FAKE_HARNESS:home,LOOM_BOX_DATA:join(home,'data'),
    LOOM_RUNTIME_CLAUDE:executable,LOOM_RUNTIME_CLAUDE_JOBS:join(home,'jobs'),LOOM_RUNTIME_INBOX_DIR:join(home,'inbox'),CLAUDE_SECURESTORAGE_CONFIG_DIR:'/fixture/login'};
  const request={attempt:id,harness:'claude',model:'opus',brief:'harmless read-only recovery fixture',key:'fixture-key',conversation:'cv-123456abcdef'};
  let killed=false,queryBeats=0,body,finished=false;
  try{
    await runBodyHost({env,hostKey:'fixture-bootstrap',runner:h=>runnerFor(h,env),sleep:()=>new Promise(r=>setTimeout(r,10)),beats:1000,
      client:async(_path,{report})=>{
        if(!killed&&existsSync(started)){
          const record=readLaunch(env,id);assert.equal(record.state,'admitted');
          writeFileSync(block,'hold observer');process.kill(record.worker.pid,'SIGKILL');killed=true;writeFileSync(releaseBg,'cleanup bg caller');
        }
        if(existsSync(query)&&++queryBeats>=3)writeFileSync(release,'authenticated host sync remained active');
        if(report.done[rid]?.id){body=report.done[rid].id;assert.equal(report.done[rid].inputConfirmed,false);}
        if(body&&report.bodies[body]?.status==='ended'&&!report.starting.length){finished=true;return{exit:true};}
        return{req:body||killed?{}:{[rid]:request},...(killed?{stopping:true}:{}),stop:body?{[body]:{at:1,pack:false}}:{},received:body?[rid]:[]};
      }});
    assert.equal(finished,true);assert.equal(killed,true);assert.ok(queryBeats>=3);
    assert.equal(readFileSync(proof,'utf8'),'true','sync released the observer while the native query was still waiting');
    assert.equal(readLaunch(env,id).body.id,job);
    assert.equal(readLaunch(env,id).input,'uncertain');
  }finally{
    writeFileSync(release,'cleanup');writeFileSync(releaseBg,'cleanup');
    const record=readLaunch(env,id);if(record?.body)runnerFor('claude',env).end(record.body,env);
  }
});

test('an allocated native house refuses work before admission when its older box did not mount durable history', async () => {
  const home = scratch('native-unprovisioned-house-'), attempt = 'e'.repeat(64);
  const env = { HOME: home, HOUSE_ID: 'h-1', LOOM_LOGIN_CODEX: '/fixture/login', LOOM_BOX_DATA: join(home, 'data'), CODEX_HOME: join(home, 'codex'), LOOM_RUNTIME_CODEX_RUNS: join(home, 'runs') };
  mkdirSync(env.CODEX_HOME); writeFileSync(join(env.CODEX_HOME, 'config.toml'), '');
  const native = runnerFor('codex', env, { codex: '/fixture-missing-native', systemDir: join(home, 'etc') });
  let receipt;
  await runBodyHost({ env, runner: () => native, hostKey: 'boot', idleS: 0, beats: 2, sleep: async () => {},
    client: async (path, body) => {
      if (path !== 'body-sync') return {};
      if (body.report.done.r1) receipt = body.report.done.r1;
      return { req: { r1: { attempt, harness: 'codex', brief: 'must remain unadmitted' } } };
    },
  });
  assert.equal(receipt?.nativeNotStarted, true);
  assert.match(receipt.error, /provisioned durable native history/);
  assert.equal(readLaunch(env, attempt), null, 'an unbacked house cannot even enter native admission');
});

for (const harness of ['claude', 'codex']) test(`${harness}: history configuration refusal before runner construction is positively unstarted`, async () => {
  const home = scratch('native-history-config-refusal-'), attempt = 'c'.repeat(64), history = join(home, 'native'); mkdirSync(history);
  const env = { HOME: home, HOUSE_ID: 'h-1', LOOM_RUNTIME_NATIVE_HISTORY: history,
    ...(harness === 'claude' ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/login', LOOM_RUNTIME_CLAUDE_JOBS: join(home, 'unsupported-jobs') }
      : { LOOM_LOGIN_CODEX: '/fixture/login', LOOM_RUNTIME_CODEX_HOMES: join(history, 'credential-homes') }) };
  let receipt;
  await runBodyHost({ env, runner: () => runnerFor(harness, env), hostKey: 'boot', idleS: 0, beats: 2, sleep: async () => {},
    client: async (path, body) => {
      if (path !== 'body-sync') return {};
      if (body.report.done.r1) receipt = body.report.done.r1;
      return { req: { r1: { attempt, harness, brief: 'never enter a native CLI' } } };
    } });
  assert.equal(receipt?.nativeNotStarted, true);
  assert.equal(readLaunch(env, attempt), null, 'no launch worker or native admission exists before configuration succeeds');
});
