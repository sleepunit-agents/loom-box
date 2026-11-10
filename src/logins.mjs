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
import { setting } from './piece.mjs';
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
 * network it needs to reach the provider, and so does an identity check (`identify`, below). A box with no container
 * runtime can't offer logins.
 *
 * **Identity** (t-1913). Neither CLI's offline status names the account: Claude's `auth status` gives its org and
 * email only from a profile in its config, which a fresh container's config doesn't have, and Codex's `login status`
 * names nothing. So each box's login was an account of its own, and two boxes on one subscription showed twice, one
 * copy unread (and so, to the resolver, roomy). `identify` asks the CLI itself, with the network: Claude fetches
 * its profile on a proper start-up (`claude mcp list`, which spends no usage) and then says who it is; Codex's app
 * server answers `account/read` (its account id and email). Only a hash of those leaves the box (accountKey). It's
 * asked after a login and every IDENTIFY_MS, not every status check (IDENTIFY_RETRY_MS while it has no answer); an
 * answer is kept while the login lasts, and a check that can't reach the provider keeps the last one.
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
    identify: 'command -v claude >/dev/null 2>&1 || exit 99; mkdir -p /tmp/cli/.claude; cd /tmp/cli; claude mcp list >/dev/null 2>&1 </dev/null; exec claude auth status --json',
  },
  codex: {
    env: { CODEX_HOME: '/tmp/cli/.codex' },
    // Status: the shared auth file, linked into the container's own Codex home (the link resolves in the container).
    status: `command -v codex >/dev/null 2>&1 || exit 99; mkdir -p "$CODEX_HOME"; ln -s ${AT('codex')}/auth.json "$CODEX_HOME/auth.json"; cd /tmp/cli; exec codex login status`,
    // Login: in the container's own home, then its new auth file put in the shared dir by rename (inside the container).
    login: `command -v codex >/dev/null 2>&1 || exit 99; mkdir -p "$CODEX_HOME"; cd /tmp/cli; stty cols 2000 rows 50 2>/dev/null; codex login --device-auth || exit $?; `
      + `rm -f ${AT('codex')}/auth.json.loom-new && cp "$CODEX_HOME/auth.json" ${AT('codex')}/auth.json.loom-new && chmod 600 ${AT('codex')}/auth.json.loom-new && mv -f ${AT('codex')}/auth.json.loom-new ${AT('codex')}/auth.json`,
    // Identity: its app server's `account/read`, over a fifo, waited for (at most 15 s), then the server stopped.
    identify: `command -v codex >/dev/null 2>&1 || exit 99; mkdir -p "$CODEX_HOME"; ln -s ${AT('codex')}/auth.json "$CODEX_HOME/auth.json"; cd /tmp/cli; `
      + ': >rpc-out; mkfifo rpc-in; codex app-server <rpc-in >rpc-out 2>/dev/null & p=$!; exec 3>rpc-in; '
      + `printf '%s\\n' '${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'loom', version: '0' } } })}' '${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}' '${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/read', params: {} })}' >&3; `
      + 'i=0; while [ $i -lt 15 ] && ! grep -q \'"id":2\' rpc-out; do sleep 1; i=$((i+1)); done; exec 3>&-; kill $p 2>/dev/null; grep \'"id":2\' rpc-out',
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

/**
 * The label on every container a box runs a CLI in, so a box that starts again finds the ones a runner before it
 * left behind (a restart mid-login: the `script` that held the login's pty died, its container didn't) and stops
 * them (sweepCliContainers).
 */
export const CLI_LABEL = 'loom.cli';
/** A login's container is named after its login id, so the box can stop it by name. */
export const loginContainer = (id) => `loom-login-${id}`;

/** The exact `podman run` arguments for one box-side CLI run: the shared dir the only mount. */
export function cliRunArgs(env, harness, what, image, { name } = {}) {
  const def = CONTAINER_SCRIPTS[harness];
  const login = what === 'login';
  if (!def[what]) throw new LoginError(`no ${what} for ${harness}`);
  return ['run', '--rm', ...(login ? ['-i', '-t'] : []), '--label', `${CLI_LABEL}=${what}`, ...(name ? ['--name', name] : []), '--user', '0:0', '--cap-drop', 'all', '--security-opt', 'no-new-privileges',
    // The network only where it's needed to reach the provider (a login, an identity check); anything else, none.
    ...(what === 'login' || what === 'identify' ? [] : ['--network', 'none']), '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    ...Object.entries({ ...def.env, NO_COLOR: '1', BROWSER: '/bin/false' }).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-v', `${loginDir(env, harness)}:${AT(harness)}:rw,nosuid,nodev,noexec`,
    '--entrypoint', 'sh', image, '-c', def[what]];
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
  if (typeof d.loginExpiresAt === 'string' && Number.isFinite(Date.parse(d.loginExpiresAt))) out.loginExpiresAt = new Date(d.loginExpiresAt).toISOString();
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

/**
 * Codex's app server's answer to `account/read` (codex-cli 0.162.1, checked 2026-11-06):
 *   {"id":2,"result":{"account":{"type":"chatgpt","email":"…","planType":"pro"},"workspaceRouting":{"chatgptAccountId":"…"}}}
 * → {account: a hash of the account id and email, plan}, or null (an API key's login, an error, or nothing said).
 */
export function parseCodexAccount(stdout) {
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.includes('"id":2')) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const a = m?.id === 2 ? m.result?.account : null;
    if (!a || a.type !== 'chatgpt') return null;
    const id = typeof m.result.workspaceRouting?.chatgptAccountId === 'string' ? m.result.workspaceRouting.chatgptAccountId : '';
    const email = typeof a.email === 'string' ? a.email : '';
    if (!id && !email) return null;
    return { account: accountKey('codex', id, email), ...(typeof a.planType === 'string' && a.planType ? { plan: a.planType.slice(0, 40) } : {}) };
  }
  return null;
}

/** Who a harness's login is ({account, plan?}), as its CLI says when it can reach the provider; null if it can't. */
export function cliIdentify(env, h, image, run = spawnSync) {
  const r = run(podmanBin(env), cliRunArgs(env, h, 'identify', image), { env: podEnv(env), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  if (r.error || r.status === 99) return null;
  if (h === 'codex') return parseCodexAccount(r.stdout);
  const st = parseClaudeStatus(r.stdout);
  return st.loggedIn && st.account ? { account: st.account, ...(st.plan ? { plan: st.plan } : {}) } : null;
}

/** How often a box asks again who its logins are (a re-login asks at once). */
export const IDENTIFY_MS = 6 * 3600_000;
/** How soon it asks again when the CLI couldn't say (the provider unreachable). */
export const IDENTIFY_RETRY_MS = 30 * 60_000;
// What each login dir's CLI last said it is: {account?, plan?, at (asked)}. Kept while it stays logged in.
const IDENTITIES = new Map();

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
export function harnessStatus(env = process.env, { run = spawnSync, agents = {}, force = false, nowMs = Date.now() } = {}) {
  const out = {};
  for (const h of Object.keys(LOGIN_HARNESSES)) {
    const img = loginImage(env, agents[h] ?? [], { run });
    if (!img.image) { out[h] = { installed: false, loggedIn: false, unhealthy: img.why }; continue; }
    const bad = credentialState(env, h);
    if (bad && bad !== 'absent') { out[h] = { installed: true, loggedIn: false, unhealthy: bad.slice(0, 120) }; continue; }
    out[h] = cliStatus(env, h, img.image, run);
    // Who it is (identify, above): asked when not known yet, after a login (force), and every IDENTIFY_MS.
    const key = loginDir(env, h);
    if (!out[h].loggedIn || out[h].method === 'api-key') { IDENTITIES.delete(key); continue; }
    if (out[h].account) continue;
    let known = IDENTITIES.get(key);
    if (force || !known || nowMs - known.at >= (known.account ? IDENTIFY_MS : IDENTIFY_RETRY_MS)) {
      const got = cliIdentify(env, h, img.image, run);
      // An answer replaces the last; no answer keeps the last answer (or notes the try, for the retry's pacing).
      IDENTITIES.set(key, known = got ? { ...got, at: nowMs } : { ...known, at: nowMs });
    }
    if (known.account) out[h] = { ...out[h], account: known.account, ...(known.plan && !out[h].plan ? { plan: known.plan } : {}) };
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

/**
 * A usage-limit refusal, from a harness's own structured fields (t-1907): never its prose.
 *
 * Claude Code writes a refused API call into the session's transcript as a synthetic assistant entry,
 *   {"type":"assistant","isApiErrorMessage":true,"error":"rate_limit", "message": {"model":"<synthetic>", …}}
 * (`error` is Claude Code's SDKAssistantMessageError: rate_limit, billing_error, authentication_failed, …). In
 * stream-json the same refusal is a `rate_limit_event` whose status is `rejected` (claudeRateLimit's `limited`), or a
 * `result` with `is_error` and that `error`. `rate_limit` is a usage limit; `billing_error` is an API key's credit gone.
 * → {code} or null.
 */
export const CLAUDE_LIMIT_ERRORS = ['rate_limit', 'billing_error'];
export function claudeRefusal(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type === 'assistant' && entry.isApiErrorMessage === true && CLAUDE_LIMIT_ERRORS.includes(entry.error)) return { code: entry.error };
  if (entry.type === 'result' && entry.is_error === true && CLAUDE_LIMIT_ERRORS.includes(entry.error)) return { code: entry.error };
  if (entry.type === 'rate_limit_event' && entry.rate_limit_info?.status === 'rejected') return { code: 'rate_limit' };
  return null;
}

/**
 * Codex's (codex-cli 0.162): its rollout's `error` event carries `codex_error_info`, a serde enum written in snake case
 * (`"usage_limit_exceeded"`, or `{"usage_limit_exceeded": …}` for a variant with data); a `token_count` whose
 * rate_limits name `rate_limit_reached_type` says the same. `codex exec --json`'s own `turn.failed` carries only a
 * message, so it isn't read. → {code} or null.
 */
export function codexRefusal(event) {
  const p = event?.type === 'event_msg' ? event.payload : event;
  if (!p || typeof p !== 'object') return null;
  if (p.type === 'error') {
    const info = p.codex_error_info;
    const code = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : null;
    if (code === 'usage_limit_exceeded') return { code };
  }
  if (p.type === 'token_count' && p.rate_limits && typeof p.rate_limits === 'object' && p.rate_limits.rate_limit_reached_type) return { code: 'usage_limit_exceeded' };
  return null;
}

/** Terminal state for one short CLI run. Completion wrappers never erase a failure. */
export function terminalOutcome(harness, text) {
  const quota = harness === 'claude' ? claudeRefusal : codexRefusal;
  let state = null;
  for (const line of String(text ?? '').split('\n')) {
    let v; try { v = JSON.parse(line); } catch { continue; }
    if (harness === 'claude' && v && typeof v === 'object' && !v.type && ('result' in v || 'is_error' in v)) v = { ...v, type: 'result' };
    const p = ['event_msg', 'response_item'].includes(v?.type) ? v.payload : v;
    const toolResult = Array.isArray(v?.message?.content) && v.message.content.some(c => c?.type === 'tool_result');
    if (harness === 'claude' && v?.type === 'user' && !toolResult ||
      harness === 'codex' && (['turn_context', 'turn.started'].includes(v?.type) || ['task_started', 'user_message'].includes(p?.type))) { state = null; continue; }
    const q = quota(v);
    if (q) { state = { kind: 'quota', ...q }; continue; }
    if (harness === 'claude') {
      if ((v?.type === 'assistant' && v.isApiErrorMessage === true || v?.type === 'result' && v.is_error === true) && v.error !== undefined) state = { kind: 'error' };
      else if (v?.type === 'result' && v.is_error === true) { if (!['quota', 'error'].includes(state?.kind)) state = { kind: 'failed' }; }
      else if (v?.type === 'result' && typeof v.result === 'string') state = { kind: 'answer', answer: v.result };
      else if (v?.type === 'assistant' && v.isApiErrorMessage !== true) state = { kind: 'answer' };
    } else {
      if (p?.type === 'error' && p.codex_error_info !== undefined) state = { kind: 'error' };
      else if (p?.type === 'error' || p?.type === 'turn.failed') { if (!['quota', 'error'].includes(state?.kind)) state = { kind: 'failed' }; }
      else if (v?.type === 'item.completed' && v.item?.type === 'agent_message') state = { kind: 'answer', ...(typeof v.item.text === 'string' ? { answer: v.item.text } : {}) };
      else if (p?.type === 'agent_message' || v?.type === 'response_item' && p?.role === 'assistant') state = { kind: 'answer' };
      else if (v?.type === 'response_item') state = { kind: 'progress' };
    }
  }
  return state;
}

/**
 * The refusal that ended a turn, from the end of its harness's own JSONL (a transcript or a rollout): the last
 * refusal, if nothing but more refusals and bookkeeping came after it (a turn that went on to work isn't refused).
 */
export function lastRefusal(harness, text) {
  const read = harness === 'claude' ? claudeRefusal : codexRefusal;
  let last = null;
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue;
    let v;
    try { v = JSON.parse(line); } catch { continue; }
    const got = read(v);
    if (got) { last = got; continue; }
    // A later explicit non-quota failure supersedes the earlier quota error.
    // Generic completion bookkeeping without an error code does not: the CLI
    // may wrap the same refusal in a result/turn.failed carrying only prose.
    if (harness === 'claude' && v?.error !== undefined &&
      (v?.type === 'assistant' && v.isApiErrorMessage === true || v?.type === 'result' && v.is_error === true)) last = null;
    const payload = v?.type === 'event_msg' ? v.payload : v;
    if (harness === 'codex' && payload?.type === 'error' && payload.codex_error_info !== undefined) last = null;
    // Work after it (an assistant's real answer, a tool call), or a later turn's start (a prompt): that refusal didn't
    // end the last turn. A session's file holds every turn it had, and one that dies with no output must not inherit
    // an earlier turn's refusal.
    if (harness === 'claude' && v?.type === 'assistant' && v.isApiErrorMessage !== true) last = null;
    if (harness === 'claude' && v?.type === 'result' && !v.is_error && typeof v.result === 'string') last = null;
    if (harness === 'codex' && (v?.type === 'item.completed' && v.item?.type === 'agent_message')) last = null;
    if (harness === 'claude' && v?.type === 'user' && !(Array.isArray(v.message?.content) && v.message.content.some((c) => c?.type === 'tool_result'))) last = null;
    if (harness === 'codex' && (v?.type === 'response_item' || v?.type === 'turn_context' || (v?.type === 'event_msg' && ['user_message', 'task_started'].includes(v.payload?.type)))) last = null;
  }
  return last;
}

/**
 * When a refused account has room again (seconds), from a reading: the latest reset among its full windows (FULL), else
 * the soonest reset still ahead (the reading lags: which window refused isn't known, so the nearest is tried first; the
 * next refusal holds it again). Undefined when the reading names none.
 */
export function refusedUntil(reading, nowS = Math.floor(Date.now() / 1000)) {
  const w = reading?.windows ?? {};
  const r = reading?.resets ?? {};
  const ahead = (k) => typeof r[k] === 'number' && r[k] > nowS;
  const full = Object.keys(w).filter((k) => w[k] >= 0.97 && ahead(k));
  if (full.length) return Math.max(...full.map((k) => r[k]));
  const next = Object.keys(r).filter(ahead);
  return next.length ? Math.min(...next.map((k) => r[k])) : undefined;
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

// The local daemon's login is private to this machine, never the shared house login.
// Opted in only on loom's control plane. The native CLI reads its own trusted config;
// it is NEVER pointed at the shared login directory (whose contents houses can change).
export function machineClaudeEnabled(env) {
  try { return JSON.parse(setting(env, 'LOCAL_BODIES') || 'null')?.machineClaudeLogin === true; } catch { return false; }
}
export function machineClaudeEnv(env) {
  return Object.fromEntries(['HOME', 'PATH', 'XDG_RUNTIME_DIR', 'LANG'].filter((k) => env[k]).map((k) => [k, env[k]]));
}
export function machineClaudeStatus(env, run = spawnSync) {
  const r = run(join(env.HOME || homedir(), '.local/bin/claude'), ['auth', 'status', '--json'], {
    env: machineClaudeEnv(env), cwd: env.HOME || homedir(), encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { installed: !r.error || r.error.code !== 'ENOENT', ...parseClaudeStatus(r.stdout || '{}') };
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
/** How long a box gives one sign-in before it gives up. The control plane gives up a minute later (control.mjs). */
export const LOGIN_MS = 15 * 60_000;

/**
 * Every container a CLI ran in that's still here (sweepCliContainers): a box starting again stops what a runner
 * before it left, since no login survives its runner (the code would go to a pty nobody holds). Returns their names.
 */
export function sweepCliContainers(env, { run = spawnSync, keep = [] } = {}) {
  const r = run(podmanBin(env), ['ps', '-a', '--filter', `label=${CLI_LABEL}`, '--format', '{{.Names}}'], { env: podEnv(env), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  // null: podman didn't answer, so nothing is known (the box tries again); [] is "none left".
  if (r.error || r.status !== 0) return null;
  const names = String(r.stdout ?? '').split('\n').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9_.-]{1,128}$/.test(x) && !keep.includes(x));
  if (names.length) {
    const rm = run(podmanBin(env), ['rm', '-f', '-t', '2', ...names], { env: podEnv(env), stdio: 'ignore', timeout: 60_000 });
    if (rm.error || rm.status !== 0) return null;
  }
  return names;
}

/**
 * What a CLI printed, safe to show the owner: no code, token or credential. Everything after `code=`, any word
 * after "token", "secret", "key", "password" or "bearer", any long base64-ish run (20+ chars, or 12+ with a digit),
 * and each string in `also` (the code that was pasted) become […]. Control characters go.
 */
export function scrubCliOutput(text, also = []) {
  let t = String(text ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/[^\n\x20-\x7e]/g, '');
  for (const a of also) if (a && a.length >= 4) t = t.split(a).join('[…]');
  t = t.replace(/(code=)[^\s&]*/gi, '$1[…]')
    .replace(/\b(token|secret|password|bearer|api[_ -]?key|key)(["':= ]+)[^\s"',}]+/gi, '$1$2[…]');
  // Word by word: a link keeps its address but not its query; anything else long and base64-ish goes.
  return t.split(/(\s+)/).map((w) => {
    const u = /^(https?:\/\/[^?\s]*)\?\S*$/.exec(w);
    if (u) return `${u[1]}?[…]`;
    if (/^https?:\/\//.test(w)) return w;
    return w.replace(/[A-Za-z0-9+/_=.#-]{20,}/g, '[…]').replace(/(?=[A-Za-z0-9+/_=#-]*\d)(?=[A-Za-z0-9+/_=#-]*[A-Za-z])[A-Za-z0-9+/_=#-]{12,}/g, '[…]');
  }).join('');
}

/** The last few non-empty lines a CLI printed, scrubbed (scrubCliOutput), at most 600 characters. */
export function cliTail(text, also = [], lines = 6) {
  const all = scrubCliOutput(text, also).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  return all.slice(-lines).join('\n').slice(-600);
}

/**
 * One line a person can act on, for a login that ended without logging in: from the CLI's exit status and what it
 * printed. `stage` is how far it got: 'link' (no sign-in link yet), 'waiting' (the owner signing in), 'code' (a
 * pasted code given to it).
 */
export function whyLoginFailed(harness, { exit, out = '', stage = 'waiting' } = {}) {
  const def = LOGIN_HARNESSES[harness];
  const who = def.provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  const o = String(out);
  if (exit === 99) return `${def.bin} isn't installed in the image this box signs in with.`;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|network (?:is )?unreachable|could not resolve/i.test(o)) return `The box couldn't reach ${who}: check its network, then try again.`;
  if (/invalid[ _-]?(?:code|grant)|code (?:is )?(?:invalid|expired)|expired (?:code|authorization)|authorization (?:code )?(?:failed|invalid)|OAuth error|bad request/i.test(o)) {
    return `${who} didn't accept that code. It may have expired, or been copied in part: try again, and paste the whole code.`;
  }
  if (/access[ _]denied|denied|cancel+ed by user/i.test(o)) return `The sign-in was turned down at ${who}'s page.`;
  if (/expired|timed? ?out/i.test(o)) return `The sign-in expired before it finished: try again, and finish within a few minutes.`;
  if (stage === 'link') return `${def.label}'s login stopped before it gave a sign-in link${exit !== undefined && exit !== null ? ` (exit ${exit})` : ''}.`;
  if (stage === 'code') return `${def.label}'s login ended after the code without logging in${exit !== undefined && exit !== null ? ` (exit ${exit})` : ''}.`;
  return `${def.label}'s login ended without logging in${exit !== undefined && exit !== null ? ` (exit ${exit})` : ''}.`;
}

/**
 * One login on this box: the CLI's own login command, in a throwaway container (cliRunArgs), in a pty (`script`,
 * util-linux) so it prints its prompt. It reports, through `say`: {state: 'waiting', link, userCode?}, then
 * {state: 'done'} once the CLI's status says logged in, or {state: 'failed', error}. `code(text)` hands the
 * owner's pasted code to the CLI's stdin. What the CLI prints is only scanned for its link and code; none of it is
 * kept, and loom never opens the credential file it writes.
 */
export function startLogin(env, harness, { say, spawnImpl = spawn, status, every = 3000, until = LOGIN_MS, agents = [], run = spawnSync, id, machine = false } = {}) {
  const def = LOGIN_HARNESSES[harness];
  if (!def) throw new LoginError(`no harness ${JSON.stringify(harness)} to log in`);
  // In a throwaway container (cliRunArgs), with a pty from `script` here so the CLI prints its prompt. Claude writes
  // its new credential straight into the shared dir (its secure-storage dir); Codex's is renamed in, in the container.
  if (machine && harness !== 'claude') throw new LoginError('only Claude has a machine login');
  const img = machine ? {} : loginImage(env, agents, { run });
  if (!machine && !img.image) throw new LoginError(img.why);
  const bad = machine ? null : credentialState(env, harness);
  if (bad && bad !== 'absent') throw new LoginError(`the ${def.label} login dir isn't safe to use: ${bad}`);
  status ??= machine ? () => machineClaudeStatus(env, run) : () => cliStatus(env, harness, img.image, run);
  const before = machine ? status() : null;
  const bin = machine ? join(env.HOME || homedir(), '.local/bin/claude') : podmanBin(env);
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const name = !machine && id ? loginContainer(id) : undefined;
  const cmd = [bin, ...(machine ? def.login : cliRunArgs(env, harness, 'login', img.image, { name }))].map(q).join(' ');
  const child = spawnImpl('script', ['-qfec', cmd, '/dev/null'], { ...(machine ? { cwd: env.HOME || homedir() } : {}), env: machine ? { ...machineClaudeEnv(env), BROWSER: '/bin/false', NO_COLOR: '1' } : podEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let over = false;
  let reported = false;
  let pasted = null;
  let timer;
  // What a failure carries: one line for a person (error), and the CLI's last lines, scrubbed (detail), and its exit.
  const failed = (error, exit) => ({ state: 'failed', error, ...(cliTail(out, pasted ? [pasted] : []) ? { detail: cliTail(out, pasted ? [pasted] : []) } : {}), ...(Number.isInteger(exit) ? { exit } : {}) });
  const finish = (st) => {
    if (over) return;
    over = true;
    clearInterval(timer);
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    // `script` going doesn't always take podman's container with it: stop it by name.
    if (name) { try { run(bin, ['rm', '-f', '-t', '2', name], { env: podEnv(env), stdio: 'ignore', timeout: 30_000 }); } catch { /* gone */ } }
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
  child.on('exit', (code) => {
    // The CLI ended: logged in, or not.
    setTimeout(() => {
      if (over) return;
      const st = status();
      if (st?.loggedIn && (!machine || (code === 0 && (!before?.loginExpiresAt || Date.parse(st.loginExpiresAt) > Date.parse(before.loginExpiresAt) + 60_000)))) return finish({ state: 'done' });
      if (machine && st?.loggedIn && code === 0) return finish(failed('The login ended without extending this machine’s sign-in. Try again.', code));
      finish(failed(whyLoginFailed(harness, { exit: code, out: out.replace(ANSI, ''), stage: !reported ? 'link' : pasted ? 'code' : 'waiting' }), code));
    }, 500);
  });
  const started = Date.now();
  timer = setInterval(() => {
    if (over) return;
    if (Date.now() - started > until) return finish(failed(`No sign-in in ${Math.round(until / 60_000)} minutes; start again.`));
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
      pasted = c;
      child.stdin.write(c);
      setTimeout(() => { if (!over) child.stdin.write('\r'); }, 500);
      return true;
    },
    cancel(why = 'Cancelled.') { finish({ state: 'failed', error: why }); },
    get over() { return over; },
  };
}
