// A box's model logins (docs/model-accounts.md): which harnesses this box has, and whether each is logged in, from
// the harness CLI's own status command; signing one in with the CLI's own login; and how full its account is, read
// from what the harness writes about its own runs.
//
// The rule this module keeps: the CLI owns its login. Each box signs itself in by running the CLI's own login
// command in a throwaway container (cliRunArgs) whose only mount is the shared login dir (<data>/logins/<harness>)
// that houses get. Every CLI (the box's, in its containers, and the houses') reads and refreshes the credential
// there in place. loom never opens it, and never runs a CLI on the box itself. Nothing here reads, copies, refreshes or sends a credential; a house that
// runs a harness (house file "harnesses") gets that dir mounted, and its own copy of the same CLI uses it. A login
// never leaves its box.
//
// What the box reports up (control.mjs, poll): per harness {installed, loggedIn, method, plan, account}, where
// `account` is a short hash of what the status command says identifies the account (Claude: orgId and email), so
// boxes signed in to one account share its quota. The email itself never leaves the box.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync } from 'node:fs';
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
    houseEnv: (at) => ({ CLAUDE_SECURESTORAGE_CONFIG_DIR: at }),
    link: /https:\/\/claude\.(?:com|ai)\/\S*oauth\/authorize\?\S+/,
  },
  codex: {
    label: 'Codex', provider: 'openai', bin: 'codex', kind: 'device',
    status: ['login', 'status'], login: ['login', '--device-auth'],
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
 * lstat only: nothing followed. The box never runs a CLI on this dir outside a container, so this guards the next house.
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
 * The credential file each CLI owns, in the shared login dir. loom never opens it: the CLI reads and writes it in
 * place, the box only lstats it (a regular file of the box's user) and, after a Codex login, renames the CLI's new
 * one into place. Anything else in the shared dir (beyond it and the CLI's own temp or lock files beside it, which
 * start with its name) is removed before the dir is mounted again (pruneLoginDir).
 */
export const CRED_FILE = { claude: '.credentials.json', codex: 'auth.json' };
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

/** Why the shared credential file can't be used (lstat only: never opened), or null; 'absent' if there's none. */
export function credentialState(env, harness, { uid = process.getuid?.() } = {}) {
  let st;
  try { st = lstatSync(join(loginDir(env, harness), CRED_FILE[harness])); } catch (e) { return e.code === 'ENOENT' ? 'absent' : `${CRED_FILE[harness]}: ${e.code}`; }
  if (st.isSymbolicLink()) return `${CRED_FILE[harness]} is a symlink`;
  if (!st.isFile()) return `${CRED_FILE[harness]} isn't a regular file`;
  if (uid !== undefined && st.uid !== uid) return `${CRED_FILE[harness]} isn't owned by the box's user`;
  if (st.mode & 0o6000) return `${CRED_FILE[harness]} has a setuid or setgid bit`;
  return null;
}

// ------------------------------------------------------------------ the CLI, run in a throwaway container

/**
 * The box runs a harness CLI (status, login) only inside a throwaway container, never on the box itself: a house
 * that has the login can swap anything in the shared dir (the credential file for a symlink) between any check the
 * box makes and the CLI's open, and a CLI running on the box would then read or write wherever the link points. In
 * a container the shared dir is the only thing mounted, so any link resolves inside it, and nothing of the box's is
 * there to reach. The box process itself never opens a path in the shared dir: it lstats the credential file to say
 * whether the login is healthy, and cuts the dir down before a mount (pruneLoginDir). Config and home are the
 * container's own (a tmpfs, and its own overlay, gone with --rm). Status runs with no network; a login with the
 * network it needs to reach the provider. A box with no container runtime can't offer logins.
 *
 * The image is one that has the CLIs: LOOM_RUNTIME_LOGIN_IMAGE if the box's owner set one, else the newest house
 * image built on this box for an agent the control plane says may use that login (its owner owns this box, and
 * granted it): that agent's houses get the login anyway, so its image sees nothing new.
 */
const AT = (h) => `${LOGIN_MOUNT}/${h}`;
const CONTAINER_SCRIPTS = {
  claude: {
    env: { CLAUDE_CONFIG_DIR: '/tmp/cli/.claude', CLAUDE_SECURESTORAGE_CONFIG_DIR: AT('claude') },
    status: 'command -v claude >/dev/null 2>&1 || exit 99; mkdir -p /tmp/cli/.claude; cd /tmp/cli; exec claude auth status --json',
    login: 'command -v claude >/dev/null 2>&1 || exit 99; mkdir -p /tmp/cli/.claude; cd /tmp/cli; stty cols 2000 rows 50 2>/dev/null; exec claude auth login --claudeai',
  },
  codex: {
    env: { CODEX_HOME: '/tmp/cli/.codex' },
    // Status: the shared auth file, linked into the container's own Codex home (the link resolves in the container).
    status: `command -v codex >/dev/null 2>&1 || exit 99; mkdir -p "$CODEX_HOME"; ln -s ${AT('codex')}/auth.json "$CODEX_HOME/auth.json"; cd /tmp/cli; exec codex login status`,
    // Login: in the container's own home, then its new auth file put in the shared dir by rename (inside the container).
    login: `command -v codex >/dev/null 2>&1 || exit 99; mkdir -p "$CODEX_HOME"; cd /tmp/cli; stty cols 2000 rows 50 2>/dev/null; codex login --device-auth || exit $?; `
      + `rm -f ${AT('codex')}/auth.json.loom-new && cp "$CODEX_HOME/auth.json" ${AT('codex')}/auth.json.loom-new && chmod 600 ${AT('codex')}/auth.json.loom-new && mv -f ${AT('codex')}/auth.json.loom-new ${AT('codex')}/auth.json`,
  },
};
export const podmanBin = (env) => env.LOOM_BOX_PODMAN || 'podman';

/** The image a box runs a harness's CLI in, or null (with why). `agents` are the ones that may use the login here. */
export function loginImage(env, agents = [], { run = spawnSync } = {}) {
  const set = env.LOOM_RUNTIME_LOGIN_IMAGE;
  if (set) return { image: set };
  const r = run(podmanBin(env), ['images', '--format', '{{.Repository}}:{{.Tag}} {{.CreatedAt}}'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  if (r.error || r.status !== 0) return { image: null, why: 'this box has no container runtime it can run (podman), so it can\'t offer logins' };
  const want = new Set(agents.map((a) => `loom-house-${a}`));
  const imgs = (r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [ref, ...at] = l.split(' '); return { ref, at: Date.parse(at.slice(0, 2).join(' ')) || 0 }; })
    .filter((x) => want.has(x.ref.replace(/^localhost\//, '').split(':')[0])).sort((a, b) => b.at - a.at);
  if (!imgs.length) return { image: null, why: 'no house image of an agent granted this login is built on this box yet (start one of its houses once, or set LOOM_RUNTIME_LOGIN_IMAGE)' };
  return { image: imgs[0].ref };
}

/** The exact `podman run` arguments for one box-side CLI run: the shared dir the only mount. */
export function cliRunArgs(env, harness, what, image) {
  const def = CONTAINER_SCRIPTS[harness];
  const login = what === 'login';
  return ['run', '--rm', ...(login ? ['-i', '-t'] : []), '--user', '0:0', '--cap-drop', 'all', '--security-opt', 'no-new-privileges',
    ...(login ? [] : ['--network', 'none']), '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    ...Object.entries({ ...def.env, NO_COLOR: '1', BROWSER: '/bin/false' }).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-v', `${loginDir(env, harness)}:${AT(harness)}:rw,nosuid,nodev,noexec`,
    '--entrypoint', 'sh', image, '-c', login ? def.login : def.status];
}

const podEnv = (env) => ({ PATH: env.PATH, HOME: env.HOME, ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}) });

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

/** One harness's status, as its CLI says it, run in a throwaway container. */
export function cliStatus(env, h, image, run = spawnSync) {
  const r = run(podmanBin(env), cliRunArgs(env, h, 'status', image), { env: podEnv(env), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
  if (r.error) return { installed: false, loggedIn: false, unhealthy: `can't run a container: ${r.error.message}`.slice(0, 120) };
  if (r.status === 99) return { installed: false, loggedIn: false };
  // codex prints its status on stderr in some versions: read both. Only these parsed states are kept.
  return { installed: true, ...(h === 'claude' ? parseClaudeStatus(r.stdout) : parseCodexStatus(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, r.status)) };
}

/**
 * What this box has: each harness, installed or not (in the image it runs logins in), and its login's state, from
 * the CLI's own status command, run in a throwaway container with the shared login dir its only mount. A
 * credential file there that isn't a plain file of the box's user (a symlink a house planted) is reported
 * unhealthy, and the CLI isn't run on it. `agents` says, per harness, which agents may use the login here (the
 * control plane's answer), to pick the image. loom never opens the credential file.
 */
export function harnessStatus(env = process.env, { run = spawnSync, agents = {} } = {}) {
  const out = {};
  for (const h of Object.keys(LOGIN_HARNESSES)) {
    const img = loginImage(env, agents[h] ?? [], { run });
    if (!img.image) { out[h] = { installed: false, loggedIn: false, unhealthy: img.why }; continue; }
    const bad = credentialState(env, h);
    if (bad && bad !== 'absent') { out[h] = { installed: true, loggedIn: false, unhealthy: bad.slice(0, 120) }; continue; }
    out[h] = cliStatus(env, h, img.image, run);
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

/**
 * Whether a box reaches loom over a channel a sign-in code may cross: HTTPS, or plain HTTP only to loopback or a
 * tailnet address (100.64.0.0/10, or a *.ts.net name), which the tailnet encrypts.
 */
export function secureLoomUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || /^127\./.test(h) || h.endsWith('.ts.net')) return true;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(h);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]/g;
export const CODE = /^[A-Za-z0-9#_.\-]{8,400}$/;
const LOGIN_MS = 15 * 60_000;

/**
 * One login on this box: the CLI's own login command, in a throwaway container (cliRunArgs), in a pty (`script`,
 * util-linux) so it prints its prompt. It reports, through `say`: {state: 'waiting', link, userCode?}, then
 * {state: 'done'} once the CLI's status says logged in, or {state: 'failed', error}. `code(text)` hands the
 * owner's pasted code to the CLI's stdin. What the CLI prints is only scanned for its link and code; none of it is
 * kept, and loom never opens the credential file it writes.
 */
export function startLogin(env, harness, { say, spawnImpl = spawn, status, every = 3000, until = LOGIN_MS, agents = [], run = spawnSync } = {}) {
  const def = LOGIN_HARNESSES[harness];
  if (!def) throw new LoginError(`no harness ${JSON.stringify(harness)} to log in`);
  // In a throwaway container (cliRunArgs), with a pty from `script` here so the CLI prints its prompt. Claude writes
  // its new credential straight into the shared dir (its secure-storage dir); Codex's is renamed in, in the container.
  const img = loginImage(env, agents, { run });
  if (!img.image) throw new LoginError(img.why);
  const bad = credentialState(env, harness);
  if (bad && bad !== 'absent') throw new LoginError(`the ${def.label} login dir isn't safe to use: ${bad}`);
  status ??= () => cliStatus(env, harness, img.image, run);
  const bin = podmanBin(env);
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cmd = [bin, ...cliRunArgs(env, harness, 'login', img.image)].map(q).join(' ');
  const child = spawnImpl('script', ['-qfec', cmd, '/dev/null'], { env: podEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
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
