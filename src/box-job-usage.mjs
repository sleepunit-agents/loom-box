// Numeric-only native session snapshots. Never serialize a transcript or its path.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { usageJobs, dayOf } from './job-usage.mjs';
import { StateError } from './state.mjs';
const counts = ['calls', 'startingContext', 'averageContext', 'peakContext', 'lastContext', 'cacheWriteCalls', 'cacheRead', 'cacheCreate', 'uncached', 'output', 'totalTokens', 'malformedLines', 'counterResets', 'durationSeconds'];
const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);
const date = x => x === null || typeof x === 'string' && /^\d{4}-\d\d-\d\dT/.test(x) && Number.isFinite(Date.parse(x));
export function numericJob(row) {
  if (!row || !id(row.session) || !['claude', 'codex'].includes(row.harness) || !Array.isArray(row.models) || row.models.length > 32 || !row.models.every(x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,127}$/.test(x)) || !date(row.start) || !date(row.end)) throw new StateError('invalid numeric job usage');
  const out = { session: row.session, harness: row.harness, models: [...row.models], start: row.start, end: row.end };
  for (const k of counts) {
    const n = row[k];
    if (!(n === null && ['startingContext', 'lastContext', 'durationSeconds'].includes(k)) && (!Number.isSafeInteger(n) || n < 0)) throw new StateError('invalid numeric job usage');
    out[k] = n;
  }
  if (out.totalTokens !== out.cacheRead + out.cacheCreate + out.uncached + out.output) throw new StateError('inconsistent numeric job usage');
  return out;
}
export async function houseJobUsage(dir) {
  const report = await usageJobs({ roots: [join(dir, 'native', 'claude-projects'), join(dir, 'native', 'codex-sessions')], day: 'all', limit: Infinity });
  return report.jobs.map(numericJob);
}
// A poll is bounded; every chunk must be acknowledged before a house may clean up.
export async function reportHouseJobs(client, house, dir) {
  const jobs = await houseJobUsage(dir);
  for (let i = 0; i < jobs.length; i += 100) await client.call('poll', { jobUsage: { house, jobs: jobs.slice(i, i + 100) } });
}
export async function reportBoxJobs(client, root) {
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const d of dirs) if (d.isDirectory() && /^h-\d+$/.test(d.name)) await reportHouseJobs(client, d.name, join(root, d.name));
}
// Caller and house ownership are checked by control before any rows are stored.
export function acceptJobUsage(state, box, report, at) {
  if (!report || !/^h-\d+$/.test(report.house ?? '') || !Array.isArray(report.jobs) || report.jobs.length > 100) throw new StateError('invalid box job usage');
  const house = state.houses[report.house];
  if (!house || house.box !== box) throw new StateError('job usage is for this box\'s houses only', 403);
  const rows = report.jobs.map(numericJob);
  const store = state.boxes[box].jobUsage ??= {};
  for (const row of rows) {
    const key = `${house.agent}:${row.harness}:${row.session}`;
    const old = store[key];
    // Resumed/copied sessions are lifetime snapshots, never summed. Keep the
    // largest observed snapshot when a partial copy or a stale scan arrives.
    if (!old || row.totalTokens >= old.totalTokens) store[key] = { ...row, agent: house.agent, house: report.house, reportedAt: at };
  }
}
export function mergeJobUsage(local, reports, { day, timezone = 'America/Chicago', limit = 10, agent, box, localBox } = {}) {
  day ??= dayOf(Date.now(), timezone);
  // Validate even on an empty report, before it reaches a network call.
  dayOf(Date.now(), timezone);
  if (day !== 'all' && !/^\d{4}-\d\d-\d\d$/.test(day)) throw new StateError('day is YYYY-MM-DD or all');
  const rows = new Map();
  for (const row of [...local.map(r => ({ ...r, box: localBox, source: 'local' })), ...reports]) {
    const key = `${row.box}:${row.harness}:${row.session}`;
    const old = rows.get(key);
    if (!old || row.totalTokens >= old.totalTokens) rows.set(key, { ...old, ...row });
    else rows.set(key, { ...row, ...old, ...(row.agent ? { agent: row.agent } : {}), ...(row.conversation ? { conversation: row.conversation } : {}) });
  }
  const jobs = [...rows.values()].filter(r => (!agent || r.agent === agent) && (!box || r.box === box || r.boxName === box) && (day === 'all' || r.start && dayOf(r.start, timezone) === day)).sort((a,b) => b.totalTokens - a.totalTokens);
  return { scope: 'native session per box (lifetime snapshots; copied sessions on different boxes may overlap)', day, timezone, measuredJobs: jobs.length, ranking: 'totalTokens (token traffic, not dollars)', jobs: jobs.slice(0, limit) };
}
