// The box's deterministic client for core's collection transaction. The caller
// proves physical termination; this module starts no native work and deletes no
// original history. Only its final acknowledged result permits box cleanup.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { snapshotNativeHistory, offlineNativeAttempt, offlineNativeSession } from './native-history-collection.mjs';
import { PART_CHARS } from './houserunner.mjs';

export async function collectNativeHistory({ client, id, root, snapshot, physical }) {
  if (!/^h-[0-9]{1,9}$/.test(id ?? '') || !['gone', 'stopped'].includes(physical)) throw Error('native collection needs physical house termination');
  const call = body => client.call('native-collection', { id, ...body });
  const plan = await call({ phase: 'plan', physical });
  if (!plan || !Array.isArray(plan.entries) || typeof plan.complete !== 'boolean') throw Error('invalid native collection plan');
  if (plan.plan === undefined && plan.complete && !plan.entries.length) return { complete: true };
  if (!/^[0-9a-f]{32}$/.test(plan.plan ?? '')) throw Error('invalid native collection plan identity');
  const entries = new Set();
  for (const entry of plan.entries) {
    if (typeof entry?.key !== 'string' || entry.key.length > 128 || entries.has(entry.key) || !['claude', 'codex'].includes(entry.harness) ||
        typeof entry.received !== 'boolean' || !Array.isArray(entry.attempts) || entry.attempts.some(a => !/^[0-9a-f]{64}$/.test(a)) ||
        entry.bodyId !== undefined && !/^[A-Za-z0-9-]{4,64}$/.test(entry.bodyId) ||
        entry.session !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(entry.session)) throw Error('invalid native collection entry');
    if (entry.bodyId ? entry.key !== `body:${entry.bodyId}` : entry.attempts.length !== 1 || entry.key !== `attempt:${entry.attempts[0]}`) throw Error('native collection entry changed identity');
    entries.add(entry.key);
  }
  if (plan.entries.some(e => !e.received)) {
    if (!existsSync(snapshot)) snapshotNativeHistory(root, snapshot);
    const st = lstatSync(snapshot);
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error('native collection snapshot is not plain');
  }
  for (const entry of plan.entries) {
    if (entry.received) continue;
    const native = entry.bodyId
      ? offlineNativeSession(snapshot, { harness: entry.harness, id: entry.bodyId, ...(entry.session ? { session: entry.session } : {}) })
      : offlineNativeAttempt(snapshot, { house: id, harness: entry.harness, attempt: entry.attempts[0] });
    if (native.nativeNotStarted) {
      const receipt = await call({ phase: 'refuse', plan: plan.plan, key: entry.key, nativeNotStarted: true });
      if (receipt?.plan !== plan.plan || receipt.received !== true) throw Error('native refusal was not acknowledged');
      continue;
    }
    const whole = Buffer.from(JSON.stringify(native.files)), data = whole.toString('base64');
    const sha256 = createHash('sha256').update(whole).digest('hex'), parts = Math.max(1, Math.ceil(data.length / PART_CHARS));
    let complete = false;
    for (let part = 0; part < parts; part++) {
      const receipt = await call({ phase: 'part', plan: plan.plan, key: entry.key, bodyId: native.id, session: native.session,
        inputConfirmed: native.inputConfirmed === true, pending: native.pending, ...(native.omitted ? { omitted: native.omitted } : {}),
        sha256, parts, part, data: data.slice(part * PART_CHARS, (part + 1) * PART_CHARS) });
      if (receipt?.plan !== plan.plan || receipt.part !== part || receipt.received !== true || typeof receipt.complete !== 'boolean') throw Error('native session part was not acknowledged');
      complete = receipt.complete;
    }
    if (!complete) throw Error('native session collection is incomplete');
  }
  // Repeat finish even if the host's journal says complete: core may have died
  // before committing that completion to the house's terminal-report fence.
  const done = await call({ phase: 'finish', plan: plan.plan });
  if (done?.plan !== plan.plan || done.complete !== true) throw Error('native collection completion was not acknowledged');
  return { complete: true, plan: plan.plan };
}
