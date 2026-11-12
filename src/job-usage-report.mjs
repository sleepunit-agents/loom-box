import { load, localBoxName, StateError } from './state.mjs';
import { usageJobs, defaultUsageRoots } from './job-usage.mjs';
import { numericJob, mergeJobUsage } from './box-job-usage.mjs';
import { listConvs } from './delivery.mjs';
import { readBody } from './bodies.mjs';

export async function jobUsageReport(env, caller, options = {}) {
  const { agent, box, day, timezone, limit = 10 } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new StateError('limit is 1–10000');
  if (caller.kind === 'agent' && agent && agent !== caller.agent) throw new StateError('only your agent\'s job usage', 403);
  const who = caller.kind === 'agent' ? caller.agent : agent;
  const s = load(env), localBox = Object.keys(s.boxes).find(k => s.boxes[k].local) ?? localBoxName(env);
  const identities = new Map();
  for (const c of listConvs(env)) {
    let body;
    try { if (c.body) body = readBody(env, c.body); } catch { /* no native identity yet */ }
    for (const slot of [c.slot, c.home, body?.slot]) if (slot?.session && slot?.harness) {
      identities.set(`${c.agent}:${slot.harness}:${slot.session}`, { conversation: c.conversation, ...(slot === body?.slot && c.run ? { currentRun: c.run } : {}) });
    }
  }
  const reports = [];
  for (const [id, b] of Object.entries(s.boxes)) {
    if (b.revoked) continue;
    for (const r of Object.values(b.jobUsage ?? {})) {
      if (who && r.agent !== who) continue;
      reports.push({ ...r, box: id, boxName: b.name ?? id, source: 'box', ...identities.get(`${r.agent}:${r.harness}:${r.session}`) });
    }
  }
  // A remote agent sees only identified own sessions. The owner can also see
  // unassociated terminal histories on loom's machine.
  const local = (await usageJobs({ roots: defaultUsageRoots(env), day: 'all', limit: Infinity })).jobs.map(numericJob).map(r => {
    const matches = [...identities].filter(([key]) => key.endsWith(`:${r.harness}:${r.session}`));
    return { ...r, ...(matches.length === 1 ? { agent: matches[0][0].split(':')[0], ...matches[0][1] } : {}) };
  }).filter(r => !who || r.agent === who);
  return mergeJobUsage(local, reports, { day, timezone, limit, agent: who, box, localBox });
}
