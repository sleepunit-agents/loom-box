// Per-house native history. Logins and generated Codex homes stay outside this
// directory; only the harnesses' history and admission witnesses survive it.
import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const NATIVE_HISTORY_MOUNT = '/run/loom-native-history';
export const HISTORY_DIRS = ['launches', 'claude-jobs', 'claude-projects', 'codex-runs', 'codex-sessions'];
export const historyPaths = root => Object.fromEntries(HISTORY_DIRS.map(name => [name, join(root, name)]));
const stat = file => { try { return lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const canonical = file => {
  let at = resolve(file); const missing = [];
  while (!stat(at)) { missing.unshift(basename(at)); at = dirname(at); }
  return resolve(realpathSync(at), ...missing);
};
const inside = (root, file) => { const rel = relative(canonical(root), canonical(file)); return rel === '' || !rel.startsWith('../') && rel !== '..' && !isAbsolute(rel); };

export function nativeHistoryRoot(env) {
  const root = env.LOOM_RUNTIME_NATIVE_HISTORY;
  if (!root) return null;
  if (!/^h-[0-9]+$/.test(env.HOUSE_ID ?? '') || !isAbsolute(root)) throw Error('native history needs its allocated house and absolute mount');
  const rootStat = stat(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw Error('native history mount is unavailable');
  return root;
}

function linkHistory(source, target) {
  const current = stat(source);
  if (current?.isSymbolicLink()) {
    if (resolve(dirname(source), readlinkSync(source)) === resolve(target)) return;
    throw Error('native history refuses to replace an existing directory link');
  }
  if (current && (!current.isDirectory() || readdirSync(source).length)) throw Error('native history refuses to replace existing native files');
  mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
  if (current) rmSync(source, { recursive: true });
  symlinkSync(target, source, 'dir');
}

/** Called before the existing adapter is constructed, never a new launcher. */
export function nativeHistoryEnv(harness, env) {
  const root = nativeHistoryRoot(env);
  if (!root) return env;
  const paths = historyPaths(root);
  for (const dir of Object.values(paths)) {
    const current = stat(dir);
    if (current && (!current.isDirectory() || current.isSymbolicLink())) throw Error('native history directory is not plain');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const home = env.HOME || homedir();
  if (harness === 'claude') {
    const config = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    if (inside(root, config)) throw Error('native history cannot contain the Claude configuration home');
    for (const [setting, name, leaf] of [['LOOM_RUNTIME_CLAUDE_JOBS', 'claude-jobs', 'jobs'], ['LOOM_RUNTIME_CLAUDE_PROJECTS', 'claude-projects', 'projects']]) {
      if (env[setting] && ![join(config, leaf), paths[name]].some(p => resolve(p) === resolve(env[setting]))) throw Error('native history cannot reconcile a custom Claude history selector with its CLI');
    }
    // Link the actual CLI destinations too; changing a collector's selector
    // alone does not change where Claude writes. Its hooks/config/auth remain.
    linkHistory(join(config, 'jobs'), paths['claude-jobs']);
    linkHistory(join(config, 'projects'), paths['claude-projects']);
    return { ...env, LOOM_RUNTIME_CLAUDE_JOBS: env.LOOM_RUNTIME_CLAUDE_JOBS || join(config, 'jobs'), LOOM_RUNTIME_CLAUDE_PROJECTS: env.LOOM_RUNTIME_CLAUDE_PROJECTS || join(config, 'projects') };
  }
  if (harness === 'codex') {
    const codexHome = env.CODEX_HOME || join(home, '.codex');
    const runs = env.LOOM_RUNTIME_CODEX_RUNS || join(home, '.local/share/loom-runtime/codex-runs');
    const sessions = env.LOOM_RUNTIME_CODEX_SESSIONS || join(codexHome, 'sessions');
    const homes = env.LOOM_RUNTIME_CODEX_HOMES || join(dirname(runs), 'codex-homes');
    if (inside(root, codexHome) || inside(root, homes)) throw Error('native history cannot contain Codex login/configuration homes');
    for (const [source, target] of [[runs, paths['codex-runs']], [sessions, paths['codex-sessions']]]) {
      if (inside(root, source) && canonical(source) !== canonical(target)) throw Error('native history selector overlaps another history directory');
      if (resolve(source) !== resolve(target)) linkHistory(source, target);
    }
    return { ...env, CODEX_HOME: codexHome, LOOM_RUNTIME_CODEX_RUNS: runs, LOOM_RUNTIME_CODEX_SESSIONS: sessions, LOOM_RUNTIME_CODEX_HOMES: homes };
  }
  return env;
}

/** Explicit constructor injection cannot bypass the mounted storage contract. */
export function validateNativeHistoryOptions(harness, env, options) {
  const root = nativeHistoryRoot(env);
  if (!root) return;
  const selectors = harness === 'claude'
    ? { jobsDir: env.LOOM_RUNTIME_CLAUDE_JOBS, projectsDir: env.LOOM_RUNTIME_CLAUDE_PROJECTS }
    : { runsDir: env.LOOM_RUNTIME_CODEX_RUNS, sessionsDir: env.LOOM_RUNTIME_CODEX_SESSIONS };
  for (const [key, expected] of Object.entries(selectors)) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || canonical(options[key]) !== canonical(expected))) throw Error('native constructor cannot override durable history storage');
  }
  if (harness === 'codex') for (const key of ['codexHome', 'homesDir']) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || inside(root, options[key]))) throw Error('native constructor cannot persist credential homes in history');
  }
}
