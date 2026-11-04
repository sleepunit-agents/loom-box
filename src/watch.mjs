// Keeping watch (loom docs/specs/keeping-watch.md, "2. Boots and failed units"): each box says when it came back from
// a boot, and which of its systemd units have failed or keep restarting; the control plane turns that into the owner's
// Inbox (an alert while a unit is failing, an FYI when a box came back or a unit is OK again) and the owner's alert
// command (alerthook.mjs), on one cadence: when it starts, "(still)" every 6 hours while it lasts, and once when it's
// over (cleared=1).
//
// The box's half (bootInfo, unitSampler) only reads: /proc, `systemctl show`, `journalctl`. The control plane's half
// (noteReport, watchAsks, watchNotices) keeps what it has heard in <data>/box-watch.json, never in the state file.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setting } from './piece.mjs';
import { withLock } from './state.mjs';
import { raiseAlert } from './alerthook.mjs';
import { healthWords, problems } from './health.mjs';
import { appendFileSync, readdirSync, rmSync, statSync } from 'node:fs';

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
/** A journal line is cut to this before anything reads it; a units sample's log text, all told, to UNITS_LOG_MAX. */
const LINE_MAX = 2000;
export const UNITS_LOG_MAX = 32 * 1024;
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
/**
 * A webhook URL with its secret part gone: any token on the line that parses as a URL whose host or path says
 * "webhook" (Discord, Teams, most), or whose host is hooks.slack.com, keeps only its scheme and host. No regex: a
 * box's long line can't make it backtrack.
 */
function maskWebhooks(line) {
  return line.split(/(\s+)/).map((tok) => {
    if (!tok.includes('://') || tok.length < 10) return tok;
    // A URL in quotes or brackets: what's around it stays.
    const lead = tok.length - tok.replace(/^['"(<\[]+/, '').length;
    const core = tok.slice(lead);
    let u;
    try { u = new URL(core); } catch { return tok; }
    if (!/^https?:$/.test(u.protocol)) return tok;
    const host = u.host.toLowerCase();
    if (!(host === 'hooks.slack.com' || host.includes('webhook') || u.pathname.toLowerCase().includes('webhook'))) return tok;
    return `${tok.slice(0, lead)}${u.protocol}//${u.host}/[REDACTED]`;
  }).join('');
}

export function redact(text) {
  // A line is cut to 2000 characters first, and every regex left is bounded with its scheme anchored, so a box's long
  // line can't make one backtrack for long (ReDoS) on the control plane.
  return maskWebhooks(String(text ?? '').slice(0, LINE_MAX).replace(/[\0-\x08\x0b-\x1f]/g, ''))
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/)[^\s\/]{0,200}@/g, '$1[REDACTED]@')
    .replace(/(\bbearer {1,5})[A-Za-z0-9._~+\/=-]{8,500}/gi, '$1[REDACTED]')
    .replace(/((?:password|passwd|secret|api[_-]?key|token)[=:] {0,5})[^\s]{1,500}/gi, '$1[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{16,200}/g, 'sk-[REDACTED]')
    .replace(/\b(loom_|ghp_|gho_|github_pat_|xox[abposr]-)[A-Za-z0-9_-]{10,200}/g, '$1[REDACTED]');
}

/** A command's stdout, or null when it couldn't run or failed. Async, so a wedged journal never stalls the polls. */
function sh(argv, env) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { encoding: 'utf-8', timeout: 10_000, env, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? null : out));
  });
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
  return async function sample(nowMs = Date.now()) {
    const failed = [], looping = [], unread = [];
    for (const [scope, flag] of scopes) {
      // Since when, as systemd says (--timestamp=unix, systemd 251+); an older one, without it.
      const props = 'Id,ActiveState,SubState,Result,NRestarts,StateChangeTimestamp';
      let text = await run(['systemctl', ...flag, 'show', '--no-pager', '--timestamp=unix', '-p', props, '*']);
      if (text === null) text = await run(['systemctl', ...flag, 'show', '--no-pager', '-p', props.replace(',StateChangeTimestamp', ''), '*']);
      // Couldn't read this scope (no user bus, a timeout): unknown, never "nothing's failing".
      if (text === null) { unread.push(scope); continue; }
      const units = parseShow(text);
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
        const at = /^@(\d{9,11})$/.exec(u.StateChangeTimestamp ?? '');
        if (u.ActiveState === 'failed') failed.push({ unit: u.Id, scope, result: u.Result || 'failed', ...(at ? { since: new Date(Number(at[1]) * 1000).toISOString() } : {}) });
        else if (r?.looping) looping.push({ unit: u.Id, scope, restarts: r.bumps.length });
      }
    }
    const all = [...failed.map((x) => ({ ...x, state: 'failed' })), ...looping.map((x) => ({ ...x, state: 'looping' }))].slice(0, UNITS_MAX);
    for (const u of all) u.log = await journal(run, u.scope, u.unit);
    return { at: new Date(nowMs).toISOString(), units: all, ...(unread.length ? { unread } : {}) };
  };
}

/** A unit's own last words: its journal's last lines, systemd's own status lines dropped, redacted, capped. */
async function journal(run, scope, unit) {
  const out = (await run(['journalctl', ...(scope === 'user' ? ['--user'] : []), '-u', unit, '-n', '50', '--no-pager', '-q', '-o', 'short-iso'])) ?? '';
  const lines = out.split('\n').map((l) => l.slice(0, LINE_MAX)).filter((l) => l.trim() && !/ systemd\[\d{1,10}\]: /.test(l)).slice(-LOG_LINES).map((l) => redact(l).slice(0, 300));
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

/** At most this many FYIs one box keeps in the Inbox at a time: a box with flapping units can't crowd out the rest. */
const FYI_PER_BOX = 5;
function notice(w, n) {
  w.notices.unshift(n);
  const per = {};
  w.notices = w.notices.filter((x) => Date.parse(n.at) - Date.parse(x.at) < FYI_KEEP_MS && (!x.box || (per[x.box] = (per[x.box] ?? 0) + 1) <= FYI_PER_BOX)).slice(0, FYI_MAX);
}

/** Text a box sent, as it may be shown or said: no control characters (C0, DEL, C1), capped. */
export function printable(v, n = 120) {
  return String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, n);
}
const ISO_OK = (v, nowMs) => typeof v === 'string' && v.length <= 30 && Number.isFinite(Date.parse(v)) && Date.parse(v) <= nowMs + 60_000 && Date.parse(v) > nowMs - 400 * 86_400_000;

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
          notice(w, { box, text: `${label} is back after ${minutes(nowMs - Date.parse(dark.since))} dark`, at: b.seen, page: '' });
          calls.push({ source: 'box-health', severity: 'warn', summary: `${label} is back`, facts: { box, key: 'dark', cleared: 1, minutes: Math.round((nowMs - Date.parse(dark.since)) / 60_000) } });
        }
      }
      if (health && typeof health === 'object') noteHealth(env, w, b, box, label, health, nowMs, calls);
      // Only a boot in the shape bootInfo makes: a kernel's boot id, PID 1's start, an uptime under ten years.
      if (boot && typeof boot.id === 'string' && /^[0-9a-f-]{36}:\d{1,20}$/.test(boot.id) && /^[0-9a-f-]{36}$/.test(boot.kernel ?? '')
        && typeof boot.up === 'number' && Number.isFinite(boot.up) && boot.up >= 0 && boot.up < 10 * 365 * 86_400) {
        const prev = b.boot;
        if (prev && prev.id !== boot.id) {
          const bootAt = nowMs - boot.up * 1000;
          const dark = seen ? Math.max(0, Math.round((bootAt - Date.parse(seen)) / 1000)) : null;
          const host = prev.kernel && boot.kernel && prev.kernel !== boot.kernel;
          notice(w, { box, text: `${label} came back at ${clock(bootAt)}, up ${seconds(boot.up)}${dark !== null ? ` after being dark ${seconds(dark)}` : ''}${host ? '. Its host restarted too' : ''}`,
            at: new Date(nowMs).toISOString(), page: '' });
          calls.push({ source: 'box-boot', severity: 'warn', summary: `${label} came back from a restart${dark !== null ? ` after being dark ${seconds(dark)}` : ''}`,
            facts: { box, up_s: boot.up, ...(dark !== null ? { dark_s: dark } : {}), kernel_restarted: host ? 1 : 0, at: new Date(bootAt).toISOString() } });
        }
        b.boot = { id: boot.id, kernel: boot.kernel, up: boot.up, at: new Date(nowMs - boot.up * 1000).toISOString() };
      }
      // A sample whose log text is more than a box should ever send is dropped whole (it's unread, not "all fine").
      const logChars = units && Array.isArray(units.units) ? units.units.slice(0, UNITS_MAX).reduce((n, u) => n + (Array.isArray(u?.log) ? u.log.slice(0, 50).reduce((m, l) => m + String(l).length, 0) + Math.max(0, u.log.length - 50) * LINE_MAX : 0), 0) : 0;
      if (units && Array.isArray(units.units) && logChars <= UNITS_LOG_MAX) {
        const had = b.units ?? {};
        const next = {};
        for (const u of units.units.slice(0, UNITS_MAX)) {
          if (!UNIT.test(u?.unit ?? '') || !['user', 'system'].includes(u.scope) || !['failed', 'looping'].includes(u.state)) continue;
          const key = `${u.scope}:${u.unit}`;
          const log = (Array.isArray(u.log) ? u.log : []).slice(-LOG_LINES).map((l) => printable(redact(String(l).slice(0, LINE_MAX)), 300));
          const was = had[key];
          // Since when: systemd's word if the box had it (and it's a sane time), else when loom first heard.
          const since = was?.since ?? (ISO_OK(u.since, nowMs) ? new Date(Date.parse(u.since)).toISOString() : new Date(nowMs).toISOString());
          const ep = { unit: u.unit, scope: u.scope, state: u.state, since, said: was?.said, log,
            ...(Number.isFinite(Number(u.restarts)) && Number(u.restarts) > 0 ? { restarts: Math.min(1e6, Number(u.restarts)) } : {}),
            ...(u.result ? { result: printable(u.result, 40) } : {}) };
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
        const unread = new Set(Array.isArray(units.unread) ? units.unread.filter((x) => x === 'user' || x === 'system') : []);
        for (const [key, ep] of Object.entries(had)) {
          if (next[key]) continue;
          // Its scope couldn't be read this time: unknown, never "OK again".
          if (unread.has(ep.scope)) { next[key] = ep; continue; }
          const lasted = minutes(nowMs - Date.parse(ep.since));
          notice(w, { box, text: `${ep.unit} on ${label} is OK again (${ep.state === 'looping' ? 'kept restarting' : 'failed'} for ${lasted})`, at: new Date(nowMs).toISOString(), page: '' });
          calls.push({ source: unitSource(ep.unit), severity: 'warn', summary: `${ep.unit} on ${label} is OK again`, facts: { box, unit: ep.unit, cleared: 1, minutes: Math.round((nowMs - Date.parse(ep.since)) / 60_000) } });
        }
        b.units = next;
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
  // One sample a box per HEALTH_MIN_GAP_MS: more are dropped, history and all.
  if (b.healthAt && nowMs - Date.parse(b.healthAt) < HEALTH_MIN_GAP_MS) return;
  const s = sanitizeSample(sample);
  if (!s) return;
  label = printable(label, 64);
  const found = problems(s, label);
  const missing = new Set(READINGS.filter((r) => s[r] === null || s[r] === undefined || (Array.isArray(s.unread) && s.unread.includes(r))));
  const had = (b.readings ??= {});
  for (const r of READINGS) if (!missing.has(r)) had[r] = new Date(nowMs).toISOString();
  for (const r of missing) {
    if (had[r] && nowMs - Date.parse(had[r]) >= 30 * 60_000) found[`unread-${r}`] = { for: 0, reading: null, severity: 'warn', title: `${label} has stopped reading its ${r}`, detail: `no ${r} reading since ${clock(Date.parse(had[r]))}` };
  }
  const conds = (b.conditions ??= {});
  const iso = new Date(nowMs).toISOString();
  let opened = 0;
  for (const [key, f] of Object.entries(found)) {
    const was = conds[key];
    // A sample may open only so many conditions, and a box hold only so many (each is an alert to come).
    if (!was && (++opened > NEW_CONDITIONS_MAX || Object.keys(conds).length >= CONDITIONS_MAX)) continue;
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
      notice(w, { box, text: `${c.title}: OK again after ${minutes(nowMs - Date.parse(c.since))}`, at: iso, page: '' });
      calls.push({ source: 'box-health', severity: 'warn', summary: `${c.title}: OK again`, facts: { box, key, cleared: 1, minutes: Math.round((nowMs - Date.parse(c.since)) / 60_000) } });
    }
  }
  b.health = s;
  b.healthAt = iso;
  try { keepSample(env, box, s, nowMs); } catch { /* the history is best-effort */ }
}


/** At most this many of each list or map a sample carries, and new conditions one sample may open. */
export const SAMPLE_LIST_MAX = 32;
export const NEW_CONDITIONS_MAX = 16;
const CONDITIONS_MAX = 64;
/** One sample per box per this long; the rest are dropped quietly (a box's data, not anyone's work). */
export const HEALTH_MIN_GAP_MS = 50_000;
const HISTORY_FILE_MAX = 32 * 1024 * 1024;

const POOL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MOUNT = /^\/[A-Za-z0-9_.\/+ -]{0,119}$/;
const DISK = /^(sd[a-z]{1,4}|nvme\d{1,3}n\d{1,3}|vd[a-z]{1,4})$/;
const CT_ID = /^\d{1,9}$/;
const CT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const READING = /^[a-z]{1,16}$/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const psiIn = (p) => (p && typeof p === 'object' ? { some: num(p.some) ?? 0, full: num(p.full) ?? 0 } : null);
const entries = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o).slice(0, 4 * SAMPLE_LIST_MAX) : []);

/**
 * A sample as the control plane keeps it: only the fields the rules read, each a finite number or a short printable
 * string; a pool, mount, disk or container name that doesn't match its pattern is dropped, and each list or map is
 * cut to SAMPLE_LIST_MAX. A box is only partly trusted, and these names go into titles, the page and the alert command.
 */
export function sanitizeSample(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const out = { t: num(x.t), container: x.container === null || x.container === undefined ? null : printable(x.container, 20), cpus: num(x.cpus) };
  out.load = Array.isArray(x.load) ? x.load.slice(0, 3).map((v) => num(v) ?? 0) : null;
  out.mem = x.mem && typeof x.mem === 'object' && num(x.mem.total) ? { total: num(x.mem.total), available: num(x.mem.available) ?? 0, swap_total: num(x.mem.swap_total) ?? 0, swap_free: num(x.mem.swap_free) ?? 0 } : null;
  out.psi = x.psi && typeof x.psi === 'object' ? { cpu: psiIn(x.psi.cpu), io: psiIn(x.psi.io), memory: psiIn(x.psi.memory) } : null;
  out.fs = Array.isArray(x.fs) ? x.fs.filter((f) => f && typeof f.mount === 'string' && MOUNT.test(f.mount) && num(f.used_pct) !== null).slice(0, SAMPLE_LIST_MAX).map((f) => ({ mount: f.mount, used_pct: num(f.used_pct) })) : null;
  if (x.disks === null || x.disks === undefined) out.disks = null;
  else out.disks = Object.fromEntries(entries(x.disks).filter(([k, d]) => DISK.test(k) && d && typeof d === 'object').slice(0, SAMPLE_LIST_MAX)
    .map(([k, d]) => [k, { rotational: typeof d.rotational === 'boolean' ? d.rotational : null, util: num(d.util) ?? 0, r_mb_s: num(d.r_mb_s) ?? 0, w_mb_s: num(d.w_mb_s) ?? 0, r_await: num(d.r_await), w_await: num(d.w_await) }]));
  out.arc = x.arc && typeof x.arc === 'object' ? { size: num(x.arc.size), c_max: num(x.arc.c_max), dnode_size: num(x.arc.dnode_size) ?? 0, dnode_limit: num(x.arc.dnode_limit) ?? 0, prune_per_s: num(x.arc.prune_per_s) ?? 0 } : null;
  out.pools = Array.isArray(x.pools) ? x.pools.filter((p) => p && typeof p.name === 'string' && POOL.test(p.name)).slice(0, SAMPLE_LIST_MAX)
    .map((p) => ({ name: p.name, health: /^[A-Z]{1,16}$/.test(p.health ?? '') ? p.health : 'UNKNOWN', cap: num(p.cap) ?? 0 })) : null;
  if (x.containers === null || x.containers === undefined) out.containers = null;
  else out.containers = Object.fromEntries(entries(x.containers).filter(([k, c]) => CT_ID.test(k) && c && typeof c === 'object').slice(0, SAMPLE_LIST_MAX)
    .map(([k, c]) => [k, { io: psiIn(c.io), memory: psiIn(c.memory), ...(typeof c.name === 'string' && CT_NAME.test(c.name) ? { name: c.name } : {}) }]));
  if (x.smart === null || x.smart === undefined) out.smart = null;
  else out.smart = Object.fromEntries(entries(x.smart).filter(([k, h]) => DISK.test(k) && h && typeof h === 'object').slice(0, SAMPLE_LIST_MAX)
    .map(([k, h]) => [k, { passed: typeof h.passed === 'boolean' ? h.passed : null, temp_c: num(h.temp_c), reallocated: num(h.reallocated), pending: num(h.pending), wear_pct: num(h.wear_pct), media_errors: num(h.media_errors) }]));
  out.unread = Array.isArray(x.unread) ? x.unread.filter((r) => typeof r === 'string' && READING.test(r)).slice(0, 16) : [];
  return out;
}

const healthDir = (env) => join(dataDir(env), 'health');

/** Every sample, a file a month per box, three months kept (as host-watch kept wunder's). */
function keepSample(env, box, s, nowMs) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(box)) return;
  mkdirSync(healthDir(env), { recursive: true, mode: 0o700 });
  const month = new Date(nowMs).toISOString().slice(0, 7);
  const file = join(healthDir(env), `${box}-${month}.jsonl`);
  // A month's file stops growing past HISTORY_FILE_MAX (a sample a minute is ~2-5 MB a month); three months kept.
  let size = 0;
  try { size = statSync(file).size; } catch { /* new */ }
  if (size < HISTORY_FILE_MAX) appendFileSync(file, JSON.stringify(s) + '\n', { mode: 0o600 });
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
      // The runtime itself up 10 minutes: its own box polling now (within 2 minutes) and since 10 minutes ago. After the
      // runtime was down, the first poll from anyone finds its own box stale, so nobody is dark until it's been back 10.
      const own = local && w.boxes[local];
      if (!own?.upSince || !own.seen || nowMs - Date.parse(own.seen) > 2 * 60_000 || nowMs - Date.parse(own.upSince) < DARK_MS) return;
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
  return readWatch(env).notices.filter((n) => n && typeof n.text === 'string' && nowMs - Date.parse(n.at) < FYI_KEEP_MS).map(({ box: _b, ...n }) => n);
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

