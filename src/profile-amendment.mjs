import { durableJson } from './durable-json.mjs';
// Runtime half of the approvals contract. Only the trusted approvals adapter calls
// commitAmendment, under its owner-only grant executor. No body-facing apply endpoint.
import { readFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateProfile, minimalProfile } from './work-profile.mjs';
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fields = ['mcp', 'tools', 'skills', 'secrets'];
export function amendment(key, profile, field, name) {
  const p = validateProfile(profile);
  if (typeof key !== 'string' || key.length > 1024 || !fields.includes(field)) throw Error('invalid job profile amendment');
  if (p[field].includes(name)) throw Error('job profile already declares this capability');
  const next = validateProfile({ ...p, [field]: [...new Set([...p[field], name])], ...(field === 'mcp' ? {secrets: [...new Set([...p.secrets, `mcp.${name}`])]} : {}) });
  return { v: 1, key, previous: p, before: hash(p), field, name, profile: next, target: `runtime-job-profile:${hash([key, hash(p), field, name])}` };
}
// flock locks the inherited open-file description, which the parent retains.
// Process death closes it in the kernel; no PID guessing or stale-lock stealing.
export function withProfileLock(file, f) {
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const fd = openSync(`${file}.lock`,'a',0o600);
  try {
    const r = spawnSync('/usr/bin/flock',['-n','3'],{stdio:['ignore','ignore','pipe',fd],encoding:'utf8',timeout:5000});
    if (r.status !== 0 || r.error) throw Error('job profile store is locked or the host cannot acquire its kernel lock');
    return f();
  } finally {closeSync(fd);}
}
export function commitAmendment(file, a) {
  // This library does not verify a body-provided "approved" flag. Its caller is
  // the approvals piece's trusted grant executor; wire it only there.
  if (!a || a.v !== 1) throw Error('invalid amendment');
  const next = validateProfile(a.profile);
  return withProfileLock(file, () => {
    const store = JSON.parse(readFileSync(file, 'utf8'));
    if (store.v !== 1 || !store.jobs) throw Error('invalid profile store');
    const current = validateProfile(Object.hasOwn(store.jobs, a.key) ? store.jobs[a.key] : minimalProfile());
    const previous = validateProfile(a.previous);
    const checked = amendment(a.key, previous, a.field, a.name);
    if (checked.target !== a.target || checked.before !== a.before || hash(checked.profile) !== hash(next)) throw Error('amendment does not match approved target');
    if (store.applied?.[a.target]) return { applied: false, already: true };
    if (hash(current) !== a.before) throw Error('job profile changed since approval; request a fresh amendment');
    store.jobs[a.key] = next;
    (store.applied ??= {})[a.target] = true;
    durableJson(file,store);
    return { applied: true };
  });
}

// The body supplies only the missing capability. Runtime derives the job and
// revision from its authenticated current conversation, never from argv.
export const PROFILE_TARGET = /^runtime-job-profile:[0-9a-f]{64}$/;
const pendingFile = (file, target) => {
  if (!file || !PROFILE_TARGET.test(target)) throw Error('invalid profile amendment store or target');
  return `${file}.requests/${target.split(':')[1]}.json`;
};
export async function requestForBody(env, caller, { conversation, field, name }, proof, d) {
  const { ownerBody } = await import('./hostverbs.mjs');
  const held = ownerBody(env, caller, conversation, proof, d);
  if (!held.c) throw Error('job profile requests need the authenticated current owner job');
  const { readBody } = await import('./bodies.mjs');
  const { jobProfileKey, selectProfile } = await import('./work-profile.mjs');
  const rec = (d.readBody ?? readBody)(env, held.c.body);
  if (rec.agent !== caller.agent || rec.ended || !rec.profile) throw Error('current job has no active profile');
  const job = { agent: rec.agent, venue: rec.venue, kind: rec.kind, place: rec.place };
  const selected = selectProfile(env, job);
  if (selected.problem) throw Error('configure a valid job profile store before requesting an amendment');
  const profile = validateProfile(JSON.parse(rec.profile));
  if (hash(profile) !== hash(selected.profile)) throw Error('job profile changed; start the job with its new profile first');
  const a = amendment(jobProfileKey(job), profile, field, name);
  const file = pendingFile(env.LOOM_RUNTIME_JOB_PROFILES, a.target);
  durableJson(file,{agent:rec.agent,amendment:a});
  const { approvalsRunAsync, approvalsWhy } = await import('./approvals-call.mjs');
  const result = await (d.approvalsRun ?? approvalsRunAsync)(env, ['request', '--json', '--kind', 'grant', '--target', a.target,
    '--as', JSON.stringify({kind: 'agent', agent: rec.agent}), '--on-behalf', 'owner', '--conversation', conversation,
    '--ask', 'Allow this job to use the requested capability?', '--why', 'It needs this capability to finish its work.',
    '--if-yes', 'I permanently add this capability to this job profile.', '--if-no', 'I keep this job profile unchanged.',
    '--details', `Job: ${a.key}\nAdded declarations:\n${['mcp', 'tools', 'skills', 'secrets'].flatMap(k => a.profile[k].filter(n => !a.previous[k].includes(n)).map(n => `${k}: ${n}`)).join('\n')}\nRevision: ${a.before}`]);
  if (result.status !== 0 || result.error) throw Error(approvalsWhy(result));
  const card = JSON.parse(result.stdout);
  if (!/^a-[0-9a-f]{8}$/.test(card.id) || card.target !== a.target || card.kind !== 'grant') throw Error('approvals returned a different amendment');
  return {approval: card.id, state: card.state, target: a.target};
}

// Called only from the existing household-owner grant callback in ui.mjs.
export function applyApprovedProfile(env, {id, agent, target}, spend) {
  if (!/^a-[0-9a-f]{8}$/.test(id ?? '')) throw Error('invalid profile approval');
  const file = env.LOOM_RUNTIME_JOB_PROFILES;
  const saved = JSON.parse(readFileSync(pendingFile(file, target), 'utf8'));
  if (saved.agent !== agent || saved.amendment.target !== target) throw Error('profile approval belongs to another job');
  // The companion approvals adapter makes this exact trusted spend idempotent,
  // so a crash between spending and writing can retry, without a second card.
  const why = spend(id, target, agent);
  if (why) throw Error(`profile approval could not be spent: ${why}`);
  return commitAmendment(file, saved.amendment);
}
