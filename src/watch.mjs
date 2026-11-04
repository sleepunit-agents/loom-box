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
export function noteReport(env, box, { boot, units } = {}, nowMs = Date.now(), o = {}) {
  const alert = o.alert ?? raiseAlert;
  const label = o.label ?? box;
  const calls = [];
  try {
    updateWatch(env, (w) => {
      const b = (w.boxes[box] ??= {});
      const seen = b.seen;
      b.seen = new Date(nowMs).toISOString();
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

/** The Inbox's alerts: each unit failing or looping on a box. Its text holds while it lasts (pushed once). */
export function watchAsks(env, labelOf = (b) => b, revoked = () => false) {
  const w = readWatch(env);
  const asks = [];
  for (const [box, b] of Object.entries(w.boxes)) {
    if (revoked(box)) continue;
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

