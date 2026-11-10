// Worker capacity admission (t-2037), slice 1: SHADOW ONLY. Nothing here changes which model a job gets or whether it
// starts; it says what admission would decide, and why, and logs that beside the start, so the owner's guessed
// parameters can be checked against real use before anything enforces them.
//
// The rule: a worker job (a spawned job, a scheduled wake, grading) may take from an account window only what leaves a
// reserve for conversations until that window resets. The reserve is the larger of a floor (a guess: 5%) and the
// forecast conversational burn until reset, with a safety margin (a guess: 50%). Close to a reset, the forecast is
// small and idle capacity can be lent; far from it, more is protected. A live conversation is always admitted: the
// final chat fallback stays. Readings are account-level, so a job's own use is an estimate, said as one.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FULL } from './accounts.mjs';

export const RESERVE_FLOOR = 0.05;   // a guess, to be checked against the shadow log
export const RESERVE_MARGIN = 0.5;   // a guess, likewise
const HOUR_MS = 3_600_000;
const KINDS = ['live', 'agent', 'scheduled', 'grading'];

const windowsOf = (usage = {}) => Object.keys(usage).filter((k) => /^\d+[hd]$/.test(k) || /^\d+d_[a-z0-9]+$/.test(k));
const durationMs = (w) => { const m = /^(\d+)([hd])/.exec(w); return m ? Number(m[1]) * (m[2] === 'h' ? HOUR_MS : 24 * HOUR_MS) : null; };

/**
 * Conversational burn per window, as a fraction of the window per hour, from readings taken while only conversations
 * ran: [{at (ms), usage: {"5h": 0.2, …}}], oldest first. A drop (the window reset) starts a new run of readings. Fewer
 * than `minSamples` rises in a window: null (no forecast; the floor stands alone, and the decision says so). A reading
 * that says worker bodies were held then (`jobs` > 0, recordReadings) ends a quiet run: that rise isn't conversations'.
 */
export function forecastBurn(readings, { minSamples = 6 } = {}) {
  const per = {};
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1], b = readings[i];
    const hours = (b.at - a.at) / HOUR_MS;
    if (!(hours > 0) || a.jobs > 0 || b.jobs > 0) continue;
    for (const w of windowsOf(b.usage)) {
      const x = a.usage?.[w], y = b.usage[w];
      if (typeof x !== 'number' || typeof y !== 'number' || y < x) continue; // a reset, or no reading
      (per[w] ??= { used: 0, hours: 0, n: 0 });
      per[w].used += y - x; per[w].hours += hours; per[w].n += 1;
    }
  }
  return Object.fromEntries(Object.entries(per).map(([w, p]) => [w, p.n >= minSamples && p.hours > 0 ? p.used / p.hours : null]));
}

/**
 * What admission would decide for one start on one account: {allow, kind, windows: [{window, used, reserve, after,
 * horizonH, forecast}], why}. `usage` is the account's (accounts.mjs: fractions, reset_<w> in seconds, checked in
 * seconds). `estimate` is the job's own expected use per window (a fraction; one number for every window, or by
 * window), `inFlight` what jobs already running are expected to use still. A stale reading is never read as empty:
 * the forecast burn since it was taken is added.
 */
export function admit({ usage = {}, kind, estimate = 0, inFlight = 0, burn = {}, now = Date.now(), floor = RESERVE_FLOOR, margin = RESERVE_MARGIN }) {
  if (!KINDS.includes(kind)) throw new Error(`kind is ${KINDS.join(', ')}`);
  const nowS = now / 1000;
  const of = (v, w) => (typeof v === 'number' ? v : (v && typeof v[w] === 'number' ? v[w] : 0));
  const rows = [];
  for (const w of windowsOf(usage)) {
    const reset = usage[`reset_${w}`];
    const reset_passed = typeof reset === 'number' && reset <= nowS;
    const rate = typeof burn[w] === 'number' ? burn[w] : null;
    const since = typeof usage.checked === 'number' ? Math.max(0, now - usage.checked * 1000) / HOUR_MS : 0;
    const used = reset_passed ? 0 : Math.min(1, (typeof usage[w] === 'number' ? usage[w] : 1) + (rate ?? 0) * since);
    // Until the reset, or (no reset said) the window's whole length: the cautious horizon.
    const horizonH = typeof reset === 'number' && !reset_passed ? (reset - nowS) / 3600 : (durationMs(w) ?? 7 * 24 * HOUR_MS) / HOUR_MS;
    const forecast = rate === null ? null : rate * horizonH;
    const reserve = Math.min(FULL, Math.max(floor, (forecast ?? 0) * (1 + margin)));
    const after = used + of(inFlight, w) + of(estimate, w);
    rows.push({ window: w, used: round(used), reserve: round(reserve), after: round(after), horizonH: round(horizonH, 2), forecast: forecast === null ? null : round(forecast), ok: after + reserve <= FULL });
  }
  if (kind === 'live') return { allow: true, kind, windows: rows, why: 'a live conversation is always admitted (the final chat fallback)' };
  const short = rows.filter((r) => !r.ok);
  if (!rows.length) return { allow: false, kind, windows: rows, why: 'no usage reading for this account: unknown is not room' };
  const why = short.length
    ? short.map((r) => `${r.window}: ${pct(r.after)} after this job would leave less than the ${pct(r.reserve)} kept for conversations over the ${hours(r.horizonH)} to its reset${r.forecast === null ? ' (the floor: no forecast yet)' : ''}`).join('; ')
    : `room in every window with the conversations' reserve kept (${rows.map((r) => `${r.window} ${pct(r.after)} + ${pct(r.reserve)}`).join(', ')})`;
  return { allow: !short.length, kind, windows: rows, why };
}

const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const pct = (v) => `${Math.round(v * 100)}%`;
const hours = (h) => (h < 1 ? `${Math.round(h * 60)} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`);

/**
 * The shadow log: one line per start, {at, kind, agent, account, model, decision, why, windows, estimate}, never a
 * brief or a transcript. Bounded: past `maxBytes`, the log turns over to .1 (one older file kept).
 */
export function logShadow(dir, entry, { maxBytes = 2_000_000 } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'allocator-shadow.jsonl');
  try { if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`); } catch { /* none yet */ }
  const keep = Object.fromEntries(['at', 'kind', 'agent', 'account', 'model', 'decision', 'why', 'windows', 'estimate', 'job'].filter((k) => entry[k] !== undefined).map((k) => [k, entry[k]]));
  appendFileSync(file, JSON.stringify(keep) + '\n', { mode: 0o600 });
}

export function readShadow(dir) {
  try { return readFileSync(join(dir, 'allocator-shadow.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

/**
 * Slice 1b: the readings history forecastBurn needs. One line per account each time its reading is newer (`checked`),
 * {at, account, usage: {window: fraction}, jobs}: `jobs` is how many worker bodies (spawned jobs, wakes) were held when
 * it was recorded, on any account (which account a body draws on isn't kept, so this is the cautious count). Fractions
 * and counts only, never a brief or a name beyond the account's. Bounded like the shadow log: past `maxBytes` it turns
 * over to .1, so about two files of history (a few weeks at one reading per account every few minutes).
 */
export function recordReadings(dir, accounts, { jobs = 0, maxBytes = 2_000_000 } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'allocator-readings.jsonl'), lastFile = join(dir, 'allocator-readings.last.json');
  let last = {};
  try { last = JSON.parse(readFileSync(lastFile, 'utf8')) ?? {}; } catch { /* none yet */ }
  const lines = [];
  for (const a of accounts) {
    const u = a?.usage, checked = u?.checked;
    if (typeof a?.name !== 'string' || typeof checked !== 'number' || !(checked > (last[a.name] ?? 0))) continue;
    const usage = Object.fromEntries(windowsOf(u).filter((w) => typeof u[w] === 'number').map((w) => [w, round(u[w])]));
    if (!Object.keys(usage).length) continue;
    lines.push(JSON.stringify({ at: checked * 1000, account: a.name, usage, jobs }));
    last[a.name] = checked;
  }
  if (!lines.length) return 0;
  try { if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`); } catch { /* none yet */ }
  appendFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  writeFileSync(lastFile, JSON.stringify(last), { mode: 0o600 });
  return lines.length;
}

/** One account's recorded readings, oldest first (both files), for forecastBurn. Unreadable lines are skipped. */
export function readReadings(dir, account) {
  const out = [];
  for (const f of ['allocator-readings.jsonl.1', 'allocator-readings.jsonl']) {
    let text = '';
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) {
      if (!l) continue;
      try { const r = JSON.parse(l); if (r.account === account && typeof r.at === 'number') out.push(r); } catch { /* a torn line */ }
    }
  }
  return out.sort((x, y) => x.at - y.at);
}
