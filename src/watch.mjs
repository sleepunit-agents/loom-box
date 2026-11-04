// Keeping watch (loom docs/specs/keeping-watch.md, "2. Boots and failed units"): each box says when it came back from
// a boot, and which of its systemd units have failed or keep restarting; the control plane turns that into the owner's
// Inbox (an alert while a unit is failing, an FYI when a box came back or a unit is OK again) and the owner's alert
// command (alerthook.mjs), on one cadence: when it starts, "(still)" every 6 hours while it lasts, and once when it's
// over (cleared=1).
//
// The box's half (bootInfo, unitSampler) only reads: /proc, `systemctl show`, `journalctl`. The control plane's half
// (noteReport, watchAsks, watchNotices) keeps what it has heard in <data>/box-watch.json, never in the state file.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setting } from './piece.mjs';
import { withLock } from './state.mjs';
import { raiseAlert } from './alerthook.mjs';
import { healthWords, problems } from './health.mjs';
import { appendFileSync, readdirSync, rmSync } from 'node:fs';

/** A condition still going is said again this often. */
export const REMIND_MS = 6 * 3600_000;
/** A unit is looping when it has restarted this many times in LOOP_WINDOW_MS, and stops when it hasn't for as long. */
export const LOOP_RESTARTS = 3;
export const LOOP_WINDOW_MS = 15 * 60_000;
/** How often a box samples its units (and, later, its health). */
export const SAMPLE_MS = 60_000;
const FYI_KEEP_MS = 7 * 86_400_000;
const FYI_MAX = 30;
const UNITS_MAX = 20;
const LOG_LINES = 10;
const LOG_CHARS = 1200;
const UNIT = /^[A-Za-z0-9@._:\\-]{1,120}\.(service|socket|timer|mount|path|target|scope|slice|swap|device|automount)$/;

const dataDir = (env) => env.LOOM_BOX_DATA || join(env.HOME || homedir(), '.local', 'share', 'loom-box');

// ─── The box's half ────────────────────────────────────────────────────────────────────────────────────────────────

/** This boot: the kernel's boot id, PID 1's start (so a restarted container, on the same kernel, is a new boot), uptime. */
export function bootInfo(root = '') {
  try {
    const kernel = readFileSync(`${root}/proc/sys/kernel/random/boot_id`, 'utf-8').trim();
    const stat = readFileSync(`${root}/proc/1/stat`, 'utf-8');
    // comm (field 2) is in parentheses and may hold spaces: the fields after its closing one start at field 3.
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const up = Number(readFileSync(`${root}/proc/uptime`, 'utf-8').split(' ')[0]);
    if (!/^[0-9a-f-]{36}$/.test(kernel) || !/^\d+$/.test(start ?? '') || !Number.isFinite(up)) return null;
    return { id: `${kernel}:${start}`, kernel, up: Math.round(up) };
  } catch { return null; }
}

/** What looks like a secret in a unit's journal, redacted (as Art's art-unit-alert did), and its lines cut to size. */
export function redact(text) {
  return String(text ?? '')
    .replace(/[\0-\x08\x0b-\x1f]/g, '')
    .replace(/(https:\/\/([a-z]+\.)?discord(app)?\.com\/api(\/v\d+)?\/webhooks\/\d+\/)\S+/gi, '$1[REDACTED]')
    .replace(/(authorization: *bearer +)\S+/gi, '$1[REDACTED]')
    .replace(/((password|passwd|secret|api[_-]?key|token)[=:] *)\S+/gi, '$1[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]')
    .replace(/\b(loom_|ghp_|gho_|github_pat_|xox[abposr]-)[A-Za-z0-9_-]{10,}/g, '$1[REDACTED]');
}

function sh(argv, env) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf-8', timeout: 15_000, env, maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
}

/** `systemctl show` output, as one object per unit. */
export function parseShow(text) {
  const out = [];
  for (const block of String(text ?? '').split(/\n\s*\n/)) {
    const u = {};
    for (const line of block.split('\n')) { const i = line.indexOf('='); if (i > 0) u[line.slice(0, i)] = line.slice(i + 1); }
    if (u.Id) out.push(u);
  }
  return out;
}

/**
 * A box's unit sampler: each call reads its units (the runner's user's and the system's) and returns what's failing:
 * `failed` (state failed) and `looping` (a service restarted LOOP_RESTARTS times in LOOP_WINDOW_MS: a crash loop with
 * Restart=always is never `failed`), each with its journal's last lines, redacted. Remembers restart counts between
 * calls. `run(argv)` is the stdout of a command (a test's own).
 */
export function unitSampler(env = process.env, o = {}) {
  const run = o.run ?? ((argv) => sh(argv, env));
  const restarts = new Map(); // key -> { n, bumps: [ms], looping }
  let ignore = null;
  try { const r = setting(env, 'UNITS_IGNORE'); if (r) ignore = new RegExp(r); } catch { ignore = null; }
  const scopes = [['user', ['--user']], ['system', []]];
  return function sample(nowMs = Date.now()) {
    const failed = [], looping = [];
    for (const [scope, flag] of scopes) {
      const units = parseShow(run(['systemctl', ...flag, 'show', '--no-pager', '-p', 'Id,ActiveState,SubState,Result,NRestarts', '*']));
      for (const u of units) {
        if (!UNIT.test(u.Id) || (ignore && ignore.test(u.Id))) continue;
        const key = `${scope}:${u.Id}`;
        const n = Number(u.NRestarts);
        if (Number.isFinite(n) && u.NRestarts !== '') {
          const r = restarts.get(key);
          if (!r) restarts.set(key, { n, bumps: [], looping: false });
          else {
            for (let i = r.n; i < n; i++) r.bumps.push(nowMs);
            r.n = n;
            r.bumps = r.bumps.filter((t) => nowMs - t < LOOP_WINDOW_MS);
            if (r.bumps.length >= LOOP_RESTARTS) r.looping = true;
            else if (!r.bumps.length) r.looping = false;
          }
        }
        const r = restarts.get(key);
        if (u.ActiveState === 'failed') failed.push({ unit: u.Id, scope, result: u.Result || 'failed' });
        else if (r?.looping) looping.push({ unit: u.Id, scope, restarts: r.bumps.length });
      }
    }
    const all = [...failed.map((x) => ({ ...x, state: 'failed' })), ...looping.map((x) => ({ ...x, state: 'looping' }))].slice(0, UNITS_MAX);
    for (const u of all) u.log = journal(run, u.scope, u.unit);
    return { at: new Date(nowMs).toISOString(), units: all };
  };
}

/** A unit's own last words: its journal's last lines, systemd's own status lines dropped, redacted, capped. */
function journal(run, scope, unit) {
  const out = run(['journalctl', ...(scope === 'user' ? ['--user'] : []), '-u', unit, '-n', '50', '--no-pager', '-q', '-o', 'short-iso']);
  const lines = out.split('\n').filter((l) => l.trim() && !/ systemd\[\d+\]: /.test(l)).slice(-LOG_LINES).map((l) => redact(l).slice(0, 300));
  let n = 0;
  return lines.reverse().filter((l) => (n += l.length + 1) <= LOG_CHARS).reverse();
}

// ─── The control plane's half ──────────────────────────────────────────────────────────────────────────────────────

const watchFile = (env) => join(dataDir(env), 'box-watch.json');

function readWatch(env) {
  try {
    const w = JSON.parse(readFileSync(watchFile(env), 'utf-8'));
    if (w?.v === 1 && w.boxes && typeof w.boxes === 'object') return { v: 1, boxes: w.boxes, notices: Array.isArray(w.notices) ? w.notices : [] };
  } catch { /* none yet */ }
  return { v: 1, boxes: {}, notices: [] };
}

function writeWatch(env, w) {
  mkdirSync(dataDir(env), { recursive: true, mode: 0o700 });
  const p = watchFile(env);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(w), { mode: 0o600 });
  renameSync(tmp, p);
}

/** Read-modify-write the watch under its lock. */
export function updateWatch(env, f) {
  mkdirSync(dataDir(env), { recursive: true, mode: 0o700 });
  return withLock(dataDir(env), 'box-watch.lock', () => { const w = readWatch(env); const r = f(w); writeWatch(env, w); return r; }, 'the box watch', 3000);
}

export function watchOf(env) { return readWatch(env); }

/** A unit's alert source, as Art's art-unit-alert named them: one triage conversation per unit. */
export function unitSource(unit) {
  return `unit-${String(unit).replace(/\.service$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 34)}`;
}

const minutes = (ms) => { const m = Math.max(1, Math.round(ms / 60_000)); return m < 120 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`; };
const seconds = (s) => (s < 120 ? `${s} s` : minutes(s * 1000));
const clock = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';
const lastLine = (log) => (Array.isArray(log) && log.length ? String(log[log.length - 1]).replace(/^\S+\s+\S+\s+/, '').slice(0, 200) : '');

function notice(w, n) {
  w.notices.unshift(n);
  w.notices = w.notices.filter((x) => Date.parse(n.at) - Date.parse(x.at) < FYI_KEEP_MS).slice(0, FYI_MAX);
}

/**
 * What a box said in one poll: its `boot` (each poll) and its `units` sample (once a minute, when it has a new one).
 * Keeps what's needed in the watch, leaves FYIs, and tells the alert command (o.alert, or raiseAlert) what started,
 * what lasted 6 hours more, and what's over. `label` is the box's name for people. Never throws.
 */
export function noteReport(env, box, { boot, units, health } = {}, nowMs = Date.now(), o = {}) {
  const alert = o.alert ?? raiseAlert;
  const label = o.label ?? box;
  const calls = [];
  try {
    updateWatch(env, (w) => {
      const b = (w.boxes[box] ??= {});
      const seen = b.seen;
      b.seen = new Date(nowMs).toISOString();
      // Heard from again: a box that was dark isn't (and the runtime's own box marks how long it's been up).
      if (!seen || nowMs - Date.parse(seen) > 2 * 60_000) b.upSince = b.seen;
      const dark = b.conditions?.dark;
      if (dark) {
        delete b.conditions.dark;
        if (dark.alerted) {
          notice(w, { text: `${label} is back after ${minutes(nowMs - Date.parse(dark.since))} dark`, at: b.seen, page: '' });
          calls.push({ source: 'box-health', severity: 'warn', summary: `${label} is back`, facts: { box, key: 'dark', cleared: 1, minutes: Math.round((nowMs - Date.parse(dark.since)) / 60_000) } });
        }
      }
      if (health && typeof health === 'object') noteHealth(env, w, b, box, label, health, nowMs, calls);
      if (boot && typeof boot.id === 'string' && boot.id.length <= 120 && Number.isFinite(boot.up)) {
        const prev = b.boot;
        if (prev && prev.id !== boot.id) {
          const bootAt = nowMs - boot.up * 1000;
          const dark = seen ? Math.max(0, Math.round((bootAt - Date.parse(seen)) / 1000)) : null;
          const host = prev.kernel && boot.kernel && prev.kernel !== boot.kernel;
          notice(w, { text: `${label} came back at ${clock(bootAt)}, up ${seconds(boot.up)}${dark !== null ? ` after being dark ${seconds(dark)}` : ''}${host ? '. Its host restarted too' : ''}`,
            at: new Date(nowMs).toISOString(), page: '' });
          calls.push({ source: 'box-boot', severity: 'warn', summary: `${label} came back from a restart${dark !== null ? ` after being dark ${seconds(dark)}` : ''}`,
            facts: { box, up_s: boot.up, ...(dark !== null ? { dark_s: dark } : {}), kernel_restarted: host ? 1 : 0, at: new Date(bootAt).toISOString() } });
        }
        b.boot = { id: boot.id, kernel: boot.kernel, up: boot.up, at: new Date(nowMs - boot.up * 1000).toISOString() };
      }
      if (units && Array.isArray(units.units)) {
        const had = b.units ?? {};
        const next = {};
        for (const u of units.units.slice(0, UNITS_MAX)) {
          if (!UNIT.test(u?.unit ?? '') || !['user', 'system'].includes(u.scope) || !['failed', 'looping'].includes(u.state)) continue;
          const key = `${u.scope}:${u.unit}`;
          const log = (Array.isArray(u.log) ? u.log : []).map((l) => redact(l).slice(0, 300)).slice(-LOG_LINES);
          const was = had[key];
          const ep = { unit: u.unit, scope: u.scope, state: u.state, since: was?.since ?? new Date(nowMs).toISOString(), said: was?.said, log,
            ...(u.restarts ? { restarts: Number(u.restarts) || 0 } : {}), ...(u.result ? { result: String(u.result).slice(0, 40) } : {}) };
          const fresh = !was;
          const due = was && (!was.said || nowMs - Date.parse(was.said) >= REMIND_MS);
          if (fresh || due) {
            const words = u.state === 'looping' ? 'keeps restarting' : 'failed';
            calls.push({ source: unitSource(u.unit), severity: 'bad', summary: `${u.unit} ${words} on ${label}${fresh ? '' : ' (still)'}`,
              facts: { box, unit: u.unit, scope: u.scope, state: u.state, restarts: ep.restarts, log: log.slice(-3).join(' | ').slice(0, 300),
                ...(fresh ? {} : { minutes: Math.round((nowMs - Date.parse(ep.since)) / 60_000) }) } });
            ep.said = new Date(nowMs).toISOString();
          }
          next[key] = ep;
        }
        for (const [key, ep] of Object.entries(had)) {
          if (next[key]) continue;
          const lasted = minutes(nowMs - Date.parse(ep.since));
          notice(w, { text: `${ep.unit} on ${label} is OK again (${ep.state === 'looping' ? 'kept restarting' : 'failed'} for ${lasted})`, at: new Date(nowMs).toISOString(), page: '' });
          calls.push({ source: unitSource(ep.unit), severity: 'warn', summary: `${ep.unit} on ${label} is OK again`, facts: { box, unit: ep.unit, cleared: 1, minutes: Math.round((nowMs - Date.parse(ep.since)) / 60_000) } });
        }
        b.units = next;
        b.unitsAt = units.at;
      }
    });
  } catch { return []; }
  for (const c of calls) { try { alert(env, c); } catch { /* the alert command never holds anything up */ } }
  return calls;
}

const READINGS = ['mem', 'psi', 'fs', 'disks', 'arc', 'pools', 'containers', 'smart'];

/**
 * One health sample against the rules: a condition holds from the first sample that shows it, alerts once it has held
 * for its `for`, says "(still)" every REMIND_MS, and ends on a sample that reads it fine. A sample without its
 * reading leaves it as it was. A reading the box had and hasn't sent for 30 minutes is its own condition (unread-…).
 */
function noteHealth(env, w, b, box, label, sample, nowMs, calls) {
  const s = sanitizeSample(sample);
  if (!s) return;
  const found = problems(s, label);
  const missing = new Set(READINGS.filter((r) => s[r] === null || s[r] === undefined || (Array.isArray(s.unread) && s.unread.includes(r))));
  const had = (b.readings ??= {});
  for (const r of READINGS) if (!missing.has(r)) had[r] = new Date(nowMs).toISOString();
  for (const r of missing) {
    if (had[r] && nowMs - Date.parse(had[r]) >= 30 * 60_000) found[`unread-${r}`] = { for: 0, reading: null, severity: 'warn', title: `${label} has stopped reading its ${r}`, detail: `no ${r} reading since ${clock(Date.parse(had[r]))}` };
  }
  const conds = (b.conditions ??= {});
  const iso = new Date(nowMs).toISOString();
  for (const [key, f] of Object.entries(found)) {
    const was = conds[key];
    const cur = { since: was?.since ?? iso, title: f.title, detail: f.detail, severity: f.severity, reading: f.reading, ...(was?.alerted ? { alerted: was.alerted, said: was.said } : {}) };
    const lasted = nowMs - Date.parse(cur.since);
    if (!cur.alerted && lasted >= f.for * 60_000) {
      cur.alerted = cur.said = iso;
      calls.push({ source: 'box-health', severity: f.severity, summary: f.title, facts: { box, key, minutes: Math.round(lasted / 60_000), detail: f.detail } });
    } else if (cur.alerted && nowMs - Date.parse(cur.said) >= REMIND_MS) {
      cur.said = iso;
      calls.push({ source: 'box-health', severity: f.severity, summary: `${f.title} (still)`, facts: { box, key, minutes: Math.round(lasted / 60_000), detail: f.detail } });
    }
    conds[key] = cur;
  }
  for (const [key, c] of Object.entries(conds)) {
    if (found[key] || key === 'dark') continue;
    // Unknown, not fine: a sample without its reading can't end it.
    if (c.reading && missing.has(c.reading)) continue;
    delete conds[key];
    if (c.alerted) {
      notice(w, { text: `${c.title}: OK again after ${minutes(nowMs - Date.parse(c.since))}`, at: iso, page: '' });
      calls.push({ source: 'box-health', severity: 'warn', summary: `${c.title}: OK again`, facts: { box, key, cleared: 1, minutes: Math.round((nowMs - Date.parse(c.since)) / 60_000) } });
    }
  }
  b.health = s;
  b.healthAt = iso;
  try { keepSample(env, box, s, nowMs); } catch { /* the history is best-effort */ }
}

/** A sample as the control plane keeps it: plain numbers and short strings only, nothing a box could stuff in. */
export function sanitizeSample(x) {
  const j = JSON.stringify(x ?? null);
  if (!x || typeof x !== 'object' || j.length > 64 * 1024) return null;
  try { return JSON.parse(j, (k, v) => (typeof v === 'string' ? v.slice(0, 120) : v)); } catch { return null; }
}

const healthDir = (env) => join(dataDir(env), 'health');

/** Every sample, a file a month per box, three months kept (as host-watch kept wunder's). */
function keepSample(env, box, s, nowMs) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(box)) return;
  mkdirSync(healthDir(env), { recursive: true, mode: 0o700 });
  const month = new Date(nowMs).toISOString().slice(0, 7);
  appendFileSync(join(healthDir(env), `${box}-${month}.jsonl`), JSON.stringify(s) + '\n', { mode: 0o600 });
  const mine = readdirSync(healthDir(env)).filter((n) => n.startsWith(`${box}-`) && /-\d{4}-\d{2}\.jsonl$/.test(n)).sort();
  for (const old of mine.slice(0, -3)) rmSync(join(healthDir(env), old), { force: true });
}

/** Dark: an always-on box not heard from for 10 minutes, once the runtime's own box has been up 10 minutes. */
export const DARK_MS = 10 * 60_000;
export function checkDark(env, s, nowMs = Date.now(), o = {}) {
  const alert = o.alert ?? raiseAlert;
  const calls = [];
  try {
    updateWatch(env, (w) => {
      const local = Object.entries(s.boxes).find(([, b]) => b.local)?.[0];
      const up = local && w.boxes[local]?.upSince;
      if (!up || nowMs - Date.parse(up) < DARK_MS) return;
      for (const [id, b] of Object.entries(s.boxes)) {
        if (b.revoked || !(b.local || b.reportOnly || b.alwaysOn)) continue;
        const wb = (w.boxes[id] ??= {});
        const seen = wb.seen ?? b.lastSeen;
        if (!seen || nowMs - Date.parse(seen) < DARK_MS) continue;
        const label = b.name ?? id;
        const conds = (wb.conditions ??= {});
        const d = conds.dark;
        const iso = new Date(nowMs).toISOString();
        if (!d) {
          conds.dark = { since: seen, title: `${label} is dark`, detail: `no word from it since ${clock(Date.parse(seen))}`, severity: 'bad', reading: null, alerted: iso, said: iso };
          calls.push({ source: 'box-health', severity: 'bad', summary: `${label} is dark`, facts: { box: id, key: 'dark', since: seen } });
        } else if (nowMs - Date.parse(d.said) >= REMIND_MS) {
          d.said = iso;
          calls.push({ source: 'box-health', severity: 'bad', summary: `${label} is dark (still)`, facts: { box: id, key: 'dark', since: d.since, minutes: Math.round((nowMs - Date.parse(d.since)) / 60_000) } });
        }
      }
    });
  } catch { return []; }
  for (const c of calls) { try { alert(env, c); } catch { /* never holds anything up */ } }
  return calls;
}

/** The Inbox's alerts: each unit failing or looping on a box. Its text holds while it lasts (pushed once). */
export function watchAsks(env, labelOf = (b) => b, revoked = () => false) {
  const w = readWatch(env);
  const asks = [];
  for (const [box, b] of Object.entries(w.boxes)) {
    if (revoked(box)) continue;
    for (const c of Object.values(b.conditions ?? {})) {
      if (!c.alerted) continue;
      asks.push({ text: c.title, meta: c.detail, at: c.since, page: '', label: 'Look', kind: 'alert' });
    }
    for (const ep of Object.values(b.units ?? {})) {
      asks.push({ text: `${ep.unit} ${ep.state === 'looping' ? 'keeps restarting' : 'failed'} on ${labelOf(box)}`, meta: lastLine(ep.log) || `${ep.scope} unit, since ${clock(Date.parse(ep.since))}`,
        at: ep.since, page: '', label: 'Look', kind: 'alert' });
    }
  }
  return asks.sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, 20);
}

/** The FYIs: a box back from a boot, a unit OK again. */
export function watchNotices(env, nowMs = Date.now()) {
  return readWatch(env).notices.filter((n) => n && typeof n.text === 'string' && nowMs - Date.parse(n.at) < FYI_KEEP_MS);
}

/** A box's page rows: when it last came back, and each unit failing with its journal's last lines (its own output). */
export function watchRows(env, box, nowMs = Date.now()) {
  const b = readWatch(env).boxes[box];
  if (!b) return [];
  const rows = [];
  if (b.health) {
    const unread = (b.health.unread ?? []).filter((r) => r !== 'smart' || !b.health.container);
    rows.push({ label: 'Health', value: healthWords(b.health), detail: `sampled ${minutes(nowMs - Date.parse(b.healthAt))} ago${unread.length ? ` · not read: ${unread.join(', ')}` : ''}`,
      tone: Object.values(b.conditions ?? {}).some((c) => c.alerted) ? 'bad' : 'ok' });
  }
  for (const c of Object.values(b.conditions ?? {})) {
    rows.push({ label: c.title, value: c.detail, detail: `since ${clock(Date.parse(c.since))}${c.alerted ? '' : ' (not long enough to alert yet)'}`, tone: c.alerted ? (c.severity === 'bad' ? 'bad' : 'warn') : 'muted' });
  }
  if (b.boot?.at) rows.push({ label: 'Booted', value: `${minutes(nowMs - Date.parse(b.boot.at))} ago`, detail: clock(Date.parse(b.boot.at)) });
  for (const ep of Object.values(b.units ?? {})) {
    rows.push({ label: ep.unit, value: ep.state === 'looping' ? `Keeps restarting (${ep.restarts ?? '?'} in 15 min)` : `Failed (${ep.result ?? 'failed'})`, tone: 'bad',
      detail: `${ep.scope} unit, since ${clock(Date.parse(ep.since))}`,
      sheet: { title: ep.unit, blocks: [
        { type: 'text', tone: 'muted', text: 'Its journal\'s last lines: the unit\'s own output, with what looks like a secret redacted.' },
        ...(ep.log?.length ? [{ type: 'list', items: ep.log.map((l) => ({ text: l })) }] : [{ type: 'text', text: 'The box couldn\'t read its journal.' }]),
      ] } });
  }
  return rows;
}

