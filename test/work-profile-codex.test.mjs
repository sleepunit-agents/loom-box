import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBody, resumeBody, readBody } from '../src/bodies.mjs';
import { CodexRunner } from '../src/runners.mjs';
import { setModels } from '../src/models.mjs';
import { staticAccounts } from '../src/accounts.mjs';
import { minimalProfile, jobProfileKey } from '../src/work-profile.mjs';

for (const store of ['absent', 'unrelated', 'declared', 'invalid']) test(`public Codex start and resume with ${store} profile store use the real adapter`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-codex-'));
  try {
    const env = {HOME: root, LOOM_BOX_DATA: join(root, 'data'), LOOM_RUNTIME_SCORECARDS: 'off'};
    const key = jobProfileKey({agent:'art', venue:'wake', kind:'scheduled'});
    if (store !== 'absent') {
      env.LOOM_RUNTIME_JOB_PROFILES = join(root, 'profiles.json');
      writeFileSync(env.LOOM_RUNTIME_JOB_PROFILES, store === 'invalid' ? '{broken' : JSON.stringify({v:1, jobs: store === 'declared' ? {[key]: minimalProfile()} : {}}));
    }
    setModels(env, {list:[{id:'gpt', harness:'codex', family:'openai'}], agent:'art', prefer:['gpt']});
    const adapter = new CodexRunner({codexHome:join(root,'codex'), systemDir:join(root,'system')});
    let n = 0; const captured = [];
    const admit = options => {
      const plan = adapter.plan(options.deny, options.cwd, options.env);
      if (plan.why) throw new Error(plan.why);
      captured.push(options);
      return {id:`codex000${++n}`, harness:'codex', slot:{harness:'codex', session:`session-${n}`}};
    };
    const runner = {start:admit, resume:(_slot,o)=>admit(o), slotOf:b=>b.slot};
    const bodyEnv = {HOME:root, PATH:'/bin', LEGACY_SECRET:'preserved'};
    const deps = {runner:()=>runner, bodyEnv, accounts:staticAccounts({accounts:[{name:'pro', provider:'openai', harness:'codex', kind:'login', agents:['art'], credentials:[{kind:'login',status:'valid'}], usage:{}}]})};
    const ask = {agent:'art', venue:'wake', brief:'legacy Codex', cwd:root};
    if (store === 'declared' || store === 'invalid') {
      await assert.rejects(startBody(env, ask, deps), /work profiles don't support Codex yet/);
      await assert.rejects(resumeBody(env, {...ask,slot:{harness:'codex',session:'old-session'}}, deps), /work profiles don't support Codex yet/);
      assert.equal(captured.length, 0);
      return;
    }
    const b = await startBody(env, ask, deps);
    await resumeBody(env, {body:b.body, brief:'next', cwd:root}, deps);
    await resumeBody(env, {...ask,slot:{harness:'codex',session:'unrecorded-session'}}, deps);
    for (const o of captured) { assert.deepEqual(o.env,bodyEnv); assert.equal(o.env.LOOM_BODY_PROFILE,undefined); }
    assert.equal(captured[0].brief,'legacy Codex');
    assert.equal(captured[1].brief,'next');
    assert.equal(readBody(env,b.body).profile,undefined);
    // Deleting a declaration must never unprofile a previously profiled history.
    const recorded=join(env.LOOM_BOX_DATA,'bodies',b.body.replace(':','-')+'.json');
    const rec=readBody(env,b.body); rec.profile=JSON.stringify(minimalProfile()); writeFileSync(recorded,JSON.stringify(rec));
    await assert.rejects(resumeBody(env,{body:b.body,brief:'removed declaration',cwd:root},deps),/work profiles don't support Codex yet/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
