import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { staticAccounts } from '../src/accounts.mjs';
import { startBody, resumeBody } from '../src/bodies.mjs';
import { setModels } from '../src/models.mjs';
import { scratch } from './scratch.mjs';
import { fakeRunner } from './delivery-world.mjs';

for (const place of ['x'.repeat(200) + '-complete-identity', '']) test(`profile identity preserves ${place ? 'long' : 'empty'} places across body/slot resumes`, async () => {
  const HOME = scratch('rt-profile-place-');
  const env = { HOME, LOOM_BOX_DATA: join(HOME, 'data'), LOOM_BOX_HOME: join(HOME, 'state'), LOOM_RUNTIME_SCORECARDS: 'off', LOOM_RUNTIME_JOB_PROFILES: join(HOME, 'profiles.json') };
  setModels(env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }], agent: 'art', prefer: ['opus'] });
  const profile = tools => ({ v: 1, mcp: [], tools, skills: [], secrets: [] });
  const key = value => JSON.stringify(['art', 'wake', 'scheduled', value]);
  writeFileSync(env.LOOM_RUNTIME_JOB_PROFILES, JSON.stringify({ v: 1, jobs: {
    [key(place)]: profile(['Read']), [key(place ? place.slice(0, 200) : null)]: profile(['Bash']),
  } }));
  const runner = fakeRunner([], join(HOME, 'native')), seen = [];
  for (const method of ['start', 'resume']) { const call = runner[method]; runner[method] = (...args) => { seen.push(JSON.parse(args.at(-1).env.LOOM_BODY_PROFILE).tools); return call(...args); }; }
  const options = { runner: () => runner, accounts: staticAccounts({ accounts: [{ name: 'max', provider: 'anthropic', harness: 'claude', kind: 'login', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }] }] }), bodyEnv: { HOME } };
  const first = await startBody(env, { agent: 'art', venue: 'wake', place, brief: 'start', modelNeed: 'coordinator: profile identity fixture' }, options);
  assert.equal(first.place, place);
  const resumed = await resumeBody(env, { body: first.body, brief: 'resume' }, options);
  assert.equal(resumed.place, place);
  const fromSlot = await resumeBody(env, { slot: resumed.slot, agent: 'art', venue: 'wake', brief: 'slot resume' }, options);
  assert.equal(fromSlot.place, place);
  assert.deepEqual(seen, [['Read'], ['Read'], ['Read']]);
});
