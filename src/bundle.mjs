// loom's bundle seam (loom docs/extensions.md, "The bundle: a piece's part"):
// the runtime's state (boxes, primaries, how each agent's house is made, the
// houses) goes into the household bundle, encrypted by this piece to the
// owner's recipients, and comes back on restore. Box credentials and house
// tokens are core tokens, so they travel in core's part, not this one.
// Plaintext only on pipes, never argv or a file.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, localBoxName, stateDir, update } from './state.mjs';

const FORMAT = 'loom-box/1';
const AGE_RECIPIENT = /^age1[0-9a-z]{20,}$/;
const SSH_RECIPIENT = /^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/]+={0,3}( [^,\n]*)?$/;

export class BundleError extends Error {}

const age = (env) => env.LOOM_AGE || 'age';

export function exportPart(env) {
  const recipients = (env.LOOM_EXPORT_RECIPIENTS || '').split(',').map((r) => r.trim()).filter(Boolean);
  if (!recipients.length) throw new BundleError('LOOM_EXPORT_RECIPIENTS is empty: a part is never written out in the clear');
  recipients.forEach((r, i) => {
    if (!AGE_RECIPIENT.test(r) && !SSH_RECIPIENT.test(r)) throw new BundleError(`recipient ${i + 1} isn't an age recipient (age1…) or an ssh public key`);
  });
  const doc = JSON.stringify({ format: FORMAT, state: load(env) });
  const r = spawnSync(age(env), ['-e', '-a', ...recipients.flatMap((x) => ['-r', x])], { input: doc, env, encoding: 'utf-8' });
  if (r.error || r.status !== 0) throw new BundleError(`age: ${r.error?.message || (r.stderr || '').trim().split('\n').pop()}`);
  return r.stdout;
}

/**
 * A part back into this machine's state. The control plane's own box takes
 * this machine's name: the bundle may come from a machine that's gone.
 */
export function importPart(env, part, { force = false } = {}) {
  const identity = env.LOOM_IMPORT_IDENTITY;
  if (!identity) throw new BundleError('LOOM_IMPORT_IDENTITY names the owner\'s key file');
  if (existsSync(join(stateDir(env), 'state.json')) && !force) {
    throw new BundleError('this machine already has runtime state; restore into a fresh one, or pass --force');
  }
  const r = spawnSync(age(env), ['-d', '-i', identity], { input: part, env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new BundleError('the part doesn\'t decrypt with LOOM_IMPORT_IDENTITY. Nothing was written.');
  let doc;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  if (doc?.format !== FORMAT || doc.state?.v !== 1 || typeof doc.state.boxes !== 'object') {
    throw new BundleError(`the part decrypts but isn't a ${FORMAT} part. Nothing was written.`);
  }
  const s = doc.state;
  const here = localBoxName(env);
  // A remote box with this machine's name would have its credential (restored
  // with core's tokens) speak for loom's own box: refuse rather than merge them.
  if (s.boxes[here] && !s.boxes[here].local) {
    throw new BundleError(`the bundle has a box named ${here}, this machine's name; restore on a machine with another name (or set LOOM_BOX_LOCAL_NAME). Nothing was written.`);
  }
  for (const [name, b] of Object.entries(s.boxes)) {
    if (!b.local || name === here) continue;
    delete s.boxes[name];
    s.boxes[here] = { ...b, local: true };
    for (const [a, p] of Object.entries(s.primaries || {})) if (p === name) s.primaries[a] = here;
  }
  // Nothing that was up (or waiting) on the old machines runs again by itself:
  // those houses are lost, and their tokens (restored with core's part) are
  // queued for revoking, which the next box poll does.
  s.pendingRevokes ??= [];
  for (const h of Object.values(s.houses || {})) {
    if (['done', 'failed', 'stopped', 'lost'].includes(h.state)) continue;
    h.state = 'lost';
    h.note = 'restored from a bundle; it was not over when the bundle was made';
    if (h.tokenLabel && !s.pendingRevokes.includes(h.tokenLabel)) s.pendingRevokes.push(h.tokenLabel);
  }
  update(env, (cur) => {
    // A forced restore replaces what's here: whatever this machine still owed
    // a revoke (its own queue, its live houses' tokens, its boxes' credentials)
    // is carried over, so nothing it handed out stays live.
    if (force && existsSync(join(stateDir(env), 'state.json'))) {
      for (const l of cur.pendingRevokes ?? []) if (!s.pendingRevokes.includes(l)) s.pendingRevokes.push(l);
      for (const h of Object.values(cur.houses ?? {})) {
        if (!['done', 'failed', 'stopped', 'lost'].includes(h.state) && h.tokenLabel && !s.pendingRevokes.includes(h.tokenLabel)) s.pendingRevokes.push(h.tokenLabel);
      }
      for (const [name, b] of Object.entries(cur.boxes ?? {})) {
        const label = `box · ${name}`;
        if (!b.local && !b.revoked && !(s.boxes[name] && !s.boxes[name].revoked) && !s.pendingRevokes.includes(label)) s.pendingRevokes.push(label);
      }
    }
    for (const k of Object.keys(cur)) delete cur[k];
    Object.assign(cur, s);
  });
  return { boxes: Object.keys(s.boxes).length, houses: Object.keys(s.houses || {}).length };
}
