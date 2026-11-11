// Runtime half of the approvals contract. Only the trusted approvals adapter calls
// commitAmendment, under its owner-only grant executor. No body-facing apply endpoint.
import { readFileSync, mkdirSync, rmSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { validateProfile, minimalProfile } from './work-profile.mjs';
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fields = ['mcp', 'tools', 'skills', 'secrets'];
export function amendment(key, profile, field, name) {
  const p = validateProfile(profile);
  if (typeof key !== 'string' || key.length > 1024 || !fields.includes(field)) throw Error('invalid job profile amendment');
  if (p[field].includes(name)) throw Error('job profile already declares this capability');
  const next = validateProfile({ ...p, [field]: [...new Set([...p[field], name])] });
  return { v: 1, key, before: hash(p), field, name, profile: next, target: `runtime-job-profile:${hash([key, hash(p), field, name])}` };
}
export async function requestAmendment({ key, profile, field, name, request }) {
  const a = amendment(key, profile, field, name);
  // The approvals piece deduplicates this exact target, including denials. Retries
  // after a lost response cannot create a second card. No approval is spent here.
  const receipt = await request({ kind: 'grant', target: a.target,
    ask: `Allow this job to use ${name}?`, why: `Permanently add ${field} ${name} to this job's profile.`,
    if_yes: 'The approvals executor amends this job profile for future runs.',
    if_no: 'This job profile stays unchanged.', amendment: a });
  return { ...receipt, amendment: a };
}
export function commitAmendment(file, a) {
  // This library does not verify a body-provided "approved" flag. Its caller is
  // the approvals piece's trusted grant executor; wire it only there.
  if (!a || a.v !== 1) throw Error('invalid amendment');
  const next = validateProfile(a.profile);
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  mkdirSync(lock, { mode: 0o700 }); // Busy/stale lock fails closed; no unsafe timeout takeover.
  let tmp;
  try {
    const store = JSON.parse(readFileSync(file, 'utf8'));
    if (store.v !== 1 || !store.jobs) throw Error('invalid profile store');
    const current = validateProfile(Object.hasOwn(store.jobs, a.key) ? store.jobs[a.key] : minimalProfile());
    const previous = { ...next, [a.field]: next[a.field]?.filter(n => n !== a.name) };
    const checked = amendment(a.key, previous, a.field, a.name);
    if (checked.target !== a.target || checked.before !== a.before || hash(checked.profile) !== hash(next)) throw Error('amendment does not match approved target');
    if (store.applied?.[a.target]) return { applied: false, already: true };
    if (hash(current) !== a.before) throw Error('job profile changed since approval; request a fresh amendment');
    store.jobs[a.key] = next;
    (store.applied ??= {})[a.target] = true;
    tmp = `${file}.${randomBytes(12).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(store)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file); tmp = null;
    const parent = openSync(dirname(file), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return { applied: true };
  } finally { if (tmp) rmSync(tmp, { force: true }); rmSync(lock, { recursive: true }); }
}
