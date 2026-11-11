// Offline native transcript accounting; deliberately separate from account/quota readings.
// No prompt, tool argument or answer text is emitted.
import { createReadStream, existsSync, readdirSync, lstatSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
const n = x => Number.isFinite(x) && x >= 0 ? x : 0;
const stamp = x => { const t = Date.parse(x); return Number.isFinite(t) ? t : null; };
export const dayOf = (t, tz = 'America/Chicago') => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

export async function transcriptUsage(file) {
  let calls = new Map();
  const observations = [];
  let harness, session, model, start, end, malformed = 0, resets = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { malformed++; continue; }
    const p = r.payload ?? {}, at = stamp(r.timestamp);
    if (at !== null) { start = start === undefined ? at : Math.min(start, at); end = end === undefined ? at : Math.max(end, at); }
    if (r.type === 'session_meta') { harness = 'codex'; session = p.id ?? p.session_id; }
    if (r.sessionId) session = r.sessionId;
    if (r.type === 'turn_context' && p.model) model = p.model;
    if (r.type === 'assistant' && r.message?.usage) {
      harness = 'claude';
      const m = r.message, u = m.usage;
      const key = r.requestId ?? m.id;
      // Without an API message/request id, duplicate billing cannot be ruled out.
      if (!key) continue;
      const v = { at, model: m.model ?? model ?? 'unknown', uncached: n(u.input_tokens), cacheRead: n(u.cache_read_input_tokens), cacheCreate: n(u.cache_creation_input_tokens), output: n(u.output_tokens) };
      const old = calls.get(key);
      if (old) for (const k of ['uncached', 'cacheRead', 'cacheCreate', 'output']) v[k] = Math.max(old[k], v[k]);
      calls.set(key, v);
    }
    if (r.type === 'event_msg' && p.type === 'token_count' && p.info?.last_token_usage && p.info?.total_token_usage) {
      harness = 'codex';
      observations.push({ at, ordinal: r.ordinal, model: model ?? 'unknown', total: p.info.total_token_usage, usage: p.info.last_token_usage });

    }
  }
  if (harness === 'codex') { const normalized = codexCalls(observations); calls = normalized.calls; resets = normalized.resets; }
  if (!calls.size) return null;
  const result = summarizeUsage({ calls, session: session ?? basename(file, '.jsonl'), harness, start, end, malformed, resets, file: resolve(file) });
  Object.defineProperty(result, 'nativeObservations', { value: observations });
  return result;
}
function codexCalls(observations) {
  const calls = new Map(), seen = new Set();
  let last, resets = 0;
  for (const row of [...observations].sort((a,b) => (a.at ?? 0) - (b.at ?? 0) || (a.ordinal ?? 0) - (b.ordinal ?? 0))) {
    const sig = JSON.stringify(row.total);
    const key = row.ordinal === undefined ? `${row.at}:${sig}` : `ordinal:${row.ordinal}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (sig === last?.sig) continue;
    if (last && n(row.total.input_tokens) < last.input) resets++;
    last = { sig, input: n(row.total.input_tokens) };
    const u = row.usage, cacheRead = n(u.cached_input_tokens), cacheCreate = n(u.cache_write_input_tokens);
    calls.set(key, { at: row.at, model: row.model, cacheRead, cacheCreate, uncached: Math.max(0, n(u.input_tokens) - cacheRead - cacheCreate), output: n(u.output_tokens) });
  }
  return { calls, resets };
}
function summarizeUsage({ calls, session, harness, start, end, malformed, resets, file }) {
  const models = new Set();
  const rows = [...calls.values()];
  const totals = { cacheRead: 0, cacheCreate: 0, uncached: 0, output: 0 };
  for (const row of rows) { models.add(row.model); for (const k of Object.keys(totals)) totals[k] += row[k]; }
  const contexts = rows.map(r => r.cacheRead + r.cacheCreate + r.uncached);
  const input = totals.cacheRead + totals.cacheCreate + totals.uncached;
  const reasons = [];
  if (contexts[0] > 50000) reasons.push('large starting context');
  if (contexts.reduce((a, b) => Math.max(a, b), 0) > 150000) reasons.push('context exceeded 150k');
  if (rows.length > 100) reasons.push('many model calls');
  if (input && totals.cacheRead / input > 0.8) reasons.push('repeated cached context dominates');
  if (input && totals.cacheCreate / input > 0.1) reasons.push('cache creation is a material share');
  if (totals.output > 100000) reasons.push('large output volume');
  const result = { session, harness, models: [...models], calls: rows.length,
    start: start === undefined ? null : new Date(start).toISOString(), end: end === undefined ? null : new Date(end).toISOString(),
    durationSeconds: start === undefined ? null : Math.round((end - start) / 1000), startingContext: contexts[0],
    averageContext: Math.round(input / rows.length), peakContext: contexts.reduce((a, b) => Math.max(a, b), 0), lastContext: contexts.at(-1),
    cacheWriteCalls: rows.filter(r => r.cacheCreate > 0).length,
    ...totals, totalTokens: input + totals.output, reasons: reasons.length ? reasons : ['ordinary context and call volume'],
    malformedLines: malformed, counterResets: resets, file };
  Object.defineProperty(result, 'nativeCalls', { value: calls });
  return result;
}

// Explicit roots may be host archives, native-history mounts, or local harness dirs.
// Never follow directory symlinks (duplicate histories and escaping archive roots).
export function* transcriptFiles(root) {
  let st; try { st = lstatSync(root); } catch { return; }
  if (st.isSymbolicLink()) return;
  if (st.isFile()) { if (root.endsWith('.jsonl')) yield root; return; }
  if (!st.isDirectory()) return;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) yield* transcriptFiles(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}
export function defaultUsageRoots(env = process.env) {
  const home = env.HOME || homedir();
  const native = env.LOOM_RUNTIME_NATIVE_HISTORY;
  // A mounted native history is linked from the local dirs: scan its plain roots once.
  return native && existsSync(native) ? [join(native, 'claude-projects'), join(native, 'codex-sessions')]
    : [join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'), join(env.CODEX_HOME || join(home, '.codex'), 'sessions')];
}
export async function usageJobs({ roots = defaultUsageRoots(), day = dayOf(Date.now()), timezone = 'America/Chicago', limit = 10 } = {}) {
  const sessions = new Map(), seen = new Set();
  let scanned = 0;
  for (const root of roots) for (const file of transcriptFiles(root)) {
    const key = resolve(file); if (seen.has(key)) continue; seen.add(key); scanned++;
    const job = await transcriptUsage(file);
    // Job's start day, with full lifetime totals: neither file mtime nor only today's tail.
    if (!job) continue;
    const id = `${job.harness}:${job.session}`, old = sessions.get(id);
    if (!old) { sessions.set(id, job); continue; }
    let calls = new Map(old.nativeCalls);
    const observations = [...(old.nativeObservations ?? []), ...(job.nativeObservations ?? [])];
    for (const [key, row] of job.nativeCalls) {
      const before = calls.get(key);
      calls.set(key, before ? { ...row, ...Object.fromEntries(['uncached', 'cacheRead', 'cacheCreate', 'output'].map(k => [k, Math.max(before[k], row[k])])) } : row);
    }
    let resets = Math.max(old.counterResets, job.counterResets);
    if (job.harness === 'codex') { const normalized = codexCalls(observations); calls = normalized.calls; resets = normalized.resets; }
    // Copies may be partial. Native call identity dedupes the union before ranking.
    const merged = summarizeUsage({ calls: new Map([...calls].sort((a,b) => (a[1].at ?? 0) - (b[1].at ?? 0))), session: job.session, harness: job.harness,
      start: Math.min(Date.parse(old.start), Date.parse(job.start)), end: Math.max(Date.parse(old.end), Date.parse(job.end)),
      malformed: old.malformedLines + job.malformedLines, resets, file: old.file });
    Object.defineProperty(merged, 'nativeObservations', { value: observations });
    sessions.set(id, merged);
  }
  const jobs = [...sessions.values()].filter(job => day === 'all' || job.start && dayOf(job.start, timezone) === day);
  jobs.sort((a, b) => b.totalTokens - a.totalTokens);
  return { scope: 'native session (one job may span multiple sessions)', day, timezone, roots, scannedFiles: scanned,
    measuredJobs: jobs.length, ranking: 'totalTokens (token traffic, not dollars)', jobs: jobs.slice(0, limit) };
}
