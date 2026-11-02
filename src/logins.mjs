// A box's model logins (docs/model-accounts.md): which harnesses this box has, and whether each is logged in, from
// the harness CLI's own status command; signing one in with the CLI's own login; and how full its account is, read
// from what the harness writes about its own runs.
//
// The rule this module keeps: the CLI owns its login. Each box signs itself in by running the CLI's own login
// command in a home of the box's own (<data>/cli-home/<harness>, 0700, never mounted). Its credential file, and
// only that, then moves (unread) to the shared login dir (<data>/logins/<harness>) that houses get, where the
// houses' CLIs refresh it in place; it moves back into the box's home before the box asks the CLI's status. Nothing here reads, copies, refreshes or sends a credential; a house that
// runs a harness (house file "harnesses") gets that dir mounted, and its own copy of the same CLI uses it. A login
// never leaves its box.
//
// What the box reports up (control.mjs, poll): per harness {installed, loggedIn, method, plan, account}, where
// `account` is a short hash of what the status command says identifies the account (Claude: orgId and email), so
// boxes signed in to one account share its quota. The email itself never leaves the box.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class LoginError extends Error {}

/** Where a house sees its box's login dir. */
export const LOGIN_MOUNT = '/run/loom/login';

/**
 * The harnesses a box can sign in. For each: its CLI, the CLI's own status and login commands, the env that points
 * the CLI at the box's login dir, and the env a house gets so its CLI uses the mounted dir.
 *   claude  `claude auth login --claudeai`: prints a link; the provider's page shows a code to paste back.
 *           CLAUDE_SECURESTORAGE_CONFIG_DIR is where Claude Code keeps its credentials, apart from its config, so a
 *           house keeps its own settings and uses the box's login.
 *   codex   `codex login --device-auth`: prints a link and a code to enter there; it finishes by itself.
 *           CODEX_HOME is the whole of Codex's home (its config, sessions and auth), so a house keeps its own and
 *           is told where the box's login is (LOOM_LOGIN_CODEX): it links its own auth file to the one there.
 *           Codex writes its auth file in place, through the link (codex-cli 0.162.1,
 *           checked 2026-11-02 with a throwaway home), so a refresh lands in the box's file. Sharing the box's
 *           CODEX_HOME instead would mix every house's config.toml (which carries its loom token) and transcripts.
 */
export const LOGIN_HARNESSES = {
  claude: {
    label: 'Claude', provider: 'anthropic', bin: 'claude', kind: 'paste-code',
    status: ['auth', 'status', '--json'], login: ['auth', 'login', '--claudeai'],
    boxEnv: (dir) => ({ CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir }),
    houseEnv: (at) => ({ CLAUDE_SECURESTORAGE_CONFIG_DIR: at }),
    link: /https:\/\/claude\.(?:com|ai)\/\S*oauth\/authorize\?\S+/,
  },
  codex: {
    label: 'Codex', provider: 'openai', bin: 'codex', kind: 'device',
    status: ['login', 'status'], login: ['login', '--device-auth'],
    boxEnv: (dir) => ({ CODEX_HOME: dir }),
    houseEnv: (at) => ({ LOOM_LOGIN_CODEX: at }),
    link: /https:\/\/auth\.openai\.com\/\S+/,
    userCode: /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/,
  },
};
export const LOGIN_NAMES = Object.keys(LOGIN_HARNESSES);

const dataDir = (env) => env.LOOM_BOX_DATA || join(env.HOME || homedir(), '.local', 'share', 'loom-box');

/** A harness's login dir on this box, made 0700 if it isn't there. */
export function loginDir(env, harness) {
  if (!LOGIN_HARNESSES[harness]) throw new LoginError(`no harness ${JSON.stringify(harness)} to log in`);
  const d = join(dataDir(env), 'logins', harness);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
  return d;
}

/**
 * Whether a shared login dir is fit to mount again (after pruneLoginDir): every entry a plain file or directory (no
 * symlink, device, fifo or socket), owned by the box's user, with no setuid or setgid bit. Returns why not, or null.
 * lstat only: nothing followed. The box never runs a CLI in this dir (cliHome), so this guards the next house.
 */
export function checkLoginDir(dir, { uid = process.getuid?.(), max = 5000 } = {}) {
  const S_ISUID = 0o4000, S_ISGID = 0o2000;
  let seen = 0;
  const walk = (p, rel) => {
    let st;
    try { st = lstatSync(p); } catch (e) { return `${rel || '.'}: ${e.code ?? e.message}`; }
    if (++seen > max) return `more than ${max} entries`;
    if (st.isSymbolicLink()) return `${rel || '.'} is a symlink`;
    if (!st.isFile() && !st.isDirectory()) return `${rel || '.'} isn't a plain file or directory`;
    if (uid !== undefined && st.uid !== uid) return `${rel || '.'} isn't owned by the box's user`;
    if (st.mode & (S_ISUID | S_ISGID)) return `${rel || '.'} has a setuid or setgid bit`;
    if (st.isDirectory()) {
      let names;
      try { names = readdirSync(p); } catch (e) { return `${rel || '.'}: ${e.code ?? e.message}`; }
      for (const n of names) { const why = walk(join(p, n), rel ? `${rel}/${n}` : n); if (why) return why; }
    }
    return null;
  };
  return walk(dir, '');
}

/**
 * The box's own CLI home for a harness: <data>/cli-home/<harness>, 0700, never mounted into a house. The box runs a
 * harness CLI (status, login) only with this as its home and config, never with the shared login dir: a house can
 * write the shared dir, and a config.toml or settings file planted there (Codex's `notify`, Claude's hooks) would
 * run on the box. Checking the dir first can't make that safe (it can change between the check and the run).
 */
export function cliHome(env, harness) {
  if (!LOGIN_HARNESSES[harness]) throw new LoginError(`no harness ${JSON.stringify(harness)}`);
  const d = join(dataDir(env), 'cli-home', harness);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
  return d;
}

/**
 * The one file that crosses between the box's CLI home and the shared login dir: the credential file each CLI owns
 * and writes itself. It only moves (moveCredential); its values are never read. Anything else in the shared dir
 * (beyond this file and the CLI's own temp or lock files beside it, which start with its name) is removed before
 * the dir is mounted again (pruneLoginDir).
 */
export const CRED_FILE = { claude: '.credentials.json', codex: 'auth.json' };
export const CRED_MAX = 64 * 1024;

/**
 * Move a harness's credential file from one dir to the other: opened without following a symlink, a regular file of
 * the box's user, at most CRED_MAX bytes, JSON; written beside the target as a temp file and renamed over it. The
 * bytes are copied as they are; nothing in them is looked at. Returns 'moved', 'same' (already identical) or
 * 'absent' (no file at the source); throws a LoginError for anything else.
 */
export function moveCredential(harness, from, to, { uid = process.getuid?.() } = {}) {
  const name = CRED_FILE[harness];
  const read = (dir, must) => {
    let fd;
    try { fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
      if (e.code === 'ENOENT' && !must) return null;
      throw new LoginError(e.code === 'ELOOP' ? `${name} is a symlink` : `${name}: ${e.code ?? e.message}`);
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new LoginError(`${name} isn't a regular file`);
      if (uid !== undefined && st.uid !== uid) throw new LoginError(`${name} isn't owned by the box's user`);
      if (st.size > CRED_MAX) throw new LoginError(`${name} is bigger than ${CRED_MAX} bytes`);
      const buf = Buffer.alloc(st.size);
      let got = 0;
      while (got < st.size) { const r = readSync(fd, buf, got, st.size - got, got); if (r <= 0) break; got += r; }
      return buf.subarray(0, got);
    } finally { closeSync(fd); }
  };
  const bytes = read(from, false);
  if (!bytes) return 'absent';
  try { const v = JSON.parse(bytes.toString('utf-8')); if (!v || typeof v !== 'object') throw new Error(); } catch { throw new LoginError(`${name} isn't JSON`); }
  let there = null;
  try { there = read(to, false); } catch { there = null; }
  if (there && there.equals(bytes)) return 'same';
  const tmp = join(to, `${name}.loom-${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, join(to, name));
  return 'moved';
}

/** The shared login dir, down to its allowlist (the credential file, and the CLI's own temp and lock files beside it); then checked. */
export function pruneLoginDir(dir, harness) {
  const name = CRED_FILE[harness];
  for (const n of readdirSync(dir)) {
    if (n === name || (n.startsWith(`${name}.`) && n.length < name.length + 64)) continue;
    // rmSync removes a symlink itself, never what it points at.
    rmSync(join(dir, n), { recursive: true, force: true });
  }
  return checkLoginDir(dir);
}

const binOf = (env, harness) => env[`LOOM_RUNTIME_${harness.toUpperCase()}`] || LOGIN_HARNESSES[harness].bin;
const cliEnv = (env, harness) => ({ ...env, ...LOGIN_HARNESSES[harness].boxEnv(cliHome(env, harness)), NO_COLOR: '1', BROWSER: '/bin/false' });

/** A short, stable name for an account: a hash, so two boxes on one account match without its email leaving either. */
export const accountKey = (harness, ...parts) => `${harness}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 10)}`;

/** `claude auth status --json`, cut down to what the runtime keeps. */
export function parseClaudeStatus(stdout) {
  let d;
  try { d = JSON.parse(stdout); } catch { return { loggedIn: false, error: 'claude auth status said something that isn\'t JSON' }; }
  if (!d?.loggedIn) return { loggedIn: false };
  const out = { loggedIn: true, method: typeof d.authMethod === 'string' ? d.authMethod.slice(0, 40) : 'unknown' };
  if (typeof d.subscriptionType === 'string' && d.subscriptionType) out.plan = d.subscriptionType.slice(0, 40);
  if (d.orgId || d.email) out.account = accountKey('claude', d.orgId ?? '', d.email ?? '');
  return out;
}

/** `codex login status`: "Logged in using ChatGPT", "Logged in using an API key…", or "Not logged in" (exit 1). */
export function parseCodexStatus(stdout, status) {
  const t = String(stdout ?? '').trim();
  const m = /^Logged in using (.+)$/m.exec(t);
  if (status !== 0 || !m) return { loggedIn: false };
  return { loggedIn: true, method: /chatgpt/i.test(m[1]) ? 'chatgpt' : /api key/i.test(m[1]) ? 'api-key' : m[1].slice(0, 40) };
}

/** One harness's status, as its CLI says it, run in the box's own CLI home (no sync). */
function statusIn(env, h, run) {
  const def = LOGIN_HARNESSES[h];
  const bin = binOf(env, h);
  const r = run(bin, def.status, { env: cliEnv(env, h), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  if (r.error) return { installed: true, loggedIn: false, error: `${bin}: ${r.error.message}`.slice(0, 120) };
  // codex prints its status on stderr in some versions: read both.
  return { installed: true, ...(h === 'claude' ? parseClaudeStatus(r.stdout) : parseCodexStatus(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, r.status)) };
}

/**
 * What this box has: each harness, installed or not, and its login's state, from the CLI's own status command, run
 * in the box's own CLI home. The credential the houses have been refreshing is moved in from the shared dir first,
 * and moved back if the status run refreshed it. A credential file there that isn't a plain file (a symlink a house
 * planted) is refused, and that login reported unhealthy.
 */
export function harnessStatus(env = process.env, { run = spawnSync } = {}) {
  const out = {};
  for (const h of Object.keys(LOGIN_HARNESSES)) {
    const bin = binOf(env, h);
    if (run('sh', ['-c', 'command -v "$1"', 'sh', bin], { env, stdio: 'ignore' }).status !== 0) { out[h] = { installed: false, loggedIn: false }; continue; }
    const shared = loginDir(env, h), mine = cliHome(env, h);
    try { moveCredential(h, shared, mine); } catch (e) { out[h] = { installed: true, loggedIn: false, unhealthy: String(e.message).slice(0, 120) }; continue; }
    out[h] = statusIn(env, h, run);
    try { moveCredential(h, mine, shared); } catch { /* the next status says so */ }
  }
  return out;
}

// ------------------------------------------------------------------ usage, from the harness's own run output

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const WINDOW_OF = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d_opus', seven_day_sonnet: '7d_sonnet' };

/**
 * Claude Code's stream-json `rate_limit_event` (claude -p --output-format stream-json --verbose), as Claude Code
 * 2.1.316 writes it:
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793660400,"rateLimitType":"seven_day",
 *    "unifiedWindows":{"seven_day":{"utilization":0.63,"resetsAt":1793660400,"status":"allowed"}}, …}}
 * → {windows: {"7d": 0.63}, resets: {"7d": 1793660400}, limited?}. Null if it isn't one.
 */
export function claudeRateLimit(event) {
  const info = event?.type === 'rate_limit_event' ? event.rate_limit_info : null;
  if (!info || typeof info !== 'object') return null;
  const windows = {}, resets = {};
  for (const [k, w] of Object.entries(info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {})) {
    const name = WINDOW_OF[k];
    if (!name || !w || typeof w !== 'object') continue;
    if (num(w.utilization) !== undefined) windows[name] = Math.max(0, Math.min(1, w.utilization));
    if (num(w.resetsAt) !== undefined) resets[name] = w.resetsAt;
  }
  // The window the event is about, when it carries no unifiedWindows entry for it: rejected means full.
  const about = WINDOW_OF[info.rateLimitType];
  if (about && windows[about] === undefined && info.status === 'rejected') windows[about] = 1;
  if (about && resets[about] === undefined && num(info.resetsAt) !== undefined) resets[about] = info.resetsAt;
  if (!Object.keys(windows).length && !Object.keys(resets).length) return null;
  return { windows, resets, ...(info.status === 'rejected' ? { limited: true } : {}) };
}

/**
 * Codex's `token_count` event, in the session rollout Codex writes under $CODEX_HOME/sessions (codex-cli 0.162.1;
 * `codex exec --json` doesn't carry it on stdout):
 *   {"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":0.0,
 *    "window_minutes":10080,"resets_at":1793779679},"secondary":null,"plan_type":"pro", …}}}
 * → {windows: {"7d": 0}, resets: {"7d": 1793779679}, plan?}. Null if it isn't one.
 */
export function codexRateLimit(event) {
  const p = event?.type === 'event_msg' ? event.payload : event;
  const rl = p?.type === 'token_count' ? p.rate_limits : null;
  if (!rl || typeof rl !== 'object') return null;
  const windows = {}, resets = {};
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w !== 'object' || num(w.window_minutes) === undefined) continue;
    const m = w.window_minutes;
    const name = m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : null;
    if (!name) continue;
    if (num(w.used_percent) !== undefined) windows[name] = Math.max(0, Math.min(1, w.used_percent / 100));
    if (num(w.resets_at) !== undefined) resets[name] = w.resets_at;
  }
  if (!Object.keys(windows).length) return null;
  return { windows, resets, ...(typeof rl.plan_type === 'string' ? { plan: rl.plan_type.slice(0, 40) } : {}), ...(rl.rate_limit_reached_type ? { limited: true } : {}) };
}

/** The last reading in some lines of a harness's output (JSONL), or null. */
export function lastRateLimit(harness, text) {
  const read = harness === 'claude' ? claudeRateLimit : codexRateLimit;
  let last = null;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.includes('rate')) continue;
    try { last = read(JSON.parse(line)) ?? last; } catch { /* not JSON */ }
  }
  return last;
}

/**
 * The newest Codex reading in a Codex home's session rollouts (`root`): a house's own ~/.codex/sessions
 * (`loom runtime usage report --harness codex` with nothing on stdin). The box's shared login dir holds no
 * sessions (only the credential file), so the box has none of its own to read. Only the newest few files of the last two
 * days are read, and only their ends.
 */
export function codexUsageOnBox(env, { now = Date.now(), root } = {}) {
  if (!root) return null;
  if (!existsSync(root)) return null;
  const files = [];
  for (const back of [0, 1]) {
    const d = new Date(now - back * 86400_000);
    const day = join(root, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
    try { for (const f of readdirSync(day)) if (f.endsWith('.jsonl')) files.push(join(day, f)); } catch { /* no such day */ }
  }
  // A house can write into this dir, so a file here is only read if it's a regular file (never a symlink), and only
  // its last TAIL_BYTES, through one bounded read.
  const newest = files.flatMap((f) => { try { const st = lstatSync(f); return st.isFile() ? [{ f, t: st.mtimeMs }] : []; } catch { return []; } })
    .sort((a, b) => b.t - a.t).slice(0, 3);
  for (const { f, t } of newest) {
    const text = tailOf(f);
    if (text === null) continue;
    const got = lastRateLimit('codex', text);
    if (got) return { ...got, checked: Math.floor(t / 1000) };
  }
  return null;
}

/** How much of a rollout's end is read: its last token_count is near the end. */
export const TAIL_BYTES = 256 * 1024;

/** A regular file's last TAIL_BYTES, opened without following a symlink; null if it isn't one. */
export function tailOf(path, max = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const n = Math.min(st.size, max);
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, st.size - n + got);
      if (r <= 0) break;
      got += r;
    }
    const text = buf.subarray(0, got).toString('utf-8');
    // A tail cut mid-line: drop the partial first line.
    return st.size > n ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// ------------------------------------------------------------------ signing in, with the CLI's own login

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]/g;
export const CODE = /^[A-Za-z0-9#_.\-]{8,400}$/;
const LOGIN_MS = 15 * 60_000;

/**
 * One login on this box: the CLI's own login command, in a pty (`script`, util-linux) so it prints its prompt, with
 * the box's own CLI home (cliHome) as its home, never the shared dir. It reports, through `say`: {state: 'waiting', link, userCode?}, then
 * {state: 'done'} once the CLI's status says logged in, or {state: 'failed', error}. `code(text)` hands the
 * owner's pasted code to the CLI's stdin. What the CLI prints is only scanned for its link and code; none of it is
 * kept, and the credential file it writes is only moved, never read.
 */
export function startLogin(env, harness, { say: tell, spawnImpl = spawn, status = () => statusIn(env, harness, spawnSync), every = 3000, until = LOGIN_MS } = {}) {
  const def = LOGIN_HARNESSES[harness];
  if (!def) throw new LoginError(`no harness ${JSON.stringify(harness)} to log in`);
  const bin = binOf(env, harness);
  // The login runs in the box's own CLI home; once it's done, its credential file moves to the shared dir the
  // houses use. A credential file there that isn't a plain file is refused before anything runs.
  const shared = loginDir(env, harness), mine = cliHome(env, harness);
  let planted = false;
  try { planted = !lstatSync(join(shared, CRED_FILE[harness])).isFile(); } catch { planted = false; }
  if (planted) throw new LoginError(`the ${def.label} login dir isn't safe to use: ${CRED_FILE[harness]} isn't a regular file`);
  const say = (st) => {
    if (st.state !== 'done') return tell(st);
    try { moveCredential(harness, mine, shared); } catch (e) { return tell({ state: 'failed', error: `logged in, but the login couldn't be handed to the houses: ${e.message}` }); }
    return tell(st);
  };
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  // A wide terminal, so the link comes out on one line.
  const cmd = `stty cols 2000 rows 50 2>/dev/null; exec ${[bin, ...def.login].map(q).join(' ')}`;
  const child = spawnImpl('script', ['-qfec', cmd, '/dev/null'], { env: cliEnv(env, harness), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let over = false;
  let reported = false;
  let timer;
  const finish = (st) => {
    if (over) return;
    over = true;
    clearInterval(timer);
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    say(st);
  };
  const onData = (b) => {
    if (over) return;
    out = (out + b.toString()).slice(-20000);
    const clean = out.replace(ANSI, '');
    if (!reported) {
      const link = def.link.exec(clean)?.[0];
      if (!link) return;
      const userCode = def.userCode ? def.userCode.exec(clean.slice(clean.indexOf(link)))?.[0] : undefined;
      if (def.userCode && !userCode) return;
      reported = true;
      say({ state: 'waiting', link, ...(userCode ? { userCode } : {}) });
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.stdin?.on('error', () => {});
  child.on('error', (e) => finish({ state: 'failed', error: `couldn't run ${bin}'s login: ${e.message}`.slice(0, 200) }));
  child.on('exit', () => {
    // The CLI ended: logged in, or not.
    setTimeout(() => {
      if (over) return;
      const st = status();
      finish(st?.loggedIn ? { state: 'done' } : { state: 'failed', error: reported ? `${def.label}'s login ended without logging in` : `${def.label}'s login gave no link` });
    }, 500);
  });
  const started = Date.now();
  timer = setInterval(() => {
    if (over) return;
    if (Date.now() - started > until) return finish({ state: 'failed', error: 'No sign-in in 15 minutes; start again.' });
    if (reported && def.kind === 'device') {
      const st = status();
      if (st?.loggedIn) finish({ state: 'done' });
    }
  }, every);
  return {
    code(text) {
      if (over || def.kind !== 'paste-code') return false;
      const c = String(text ?? '').trim();
      if (!CODE.test(c)) return false;
      // The code, then Enter on its own: a TUI can take text and a newline in one write as a paste.
      child.stdin.write(c);
      setTimeout(() => { if (!over) child.stdin.write('\r'); }, 500);
      return true;
    },
    cancel() { finish({ state: 'failed', error: 'cancelled' }); },
    get over() { return over; },
  };
}
