// Per-house native history. Logins and generated Codex homes stay outside this
// directory; only the harnesses' history and admission witnesses survive it.
import { randomBytes } from 'node:crypto';
import { constants, copyFileSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const NATIVE_HISTORY_MOUNT = '/run/loom-native-history';
export const HISTORY_DIRS = ['launches', 'claude-jobs', 'claude-projects', 'codex-runs', 'codex-sessions', 'inboxes'];
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

const unique = () => `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
const rmdirIfEmpty = dir => { try { rmdirSync(dir); } catch (e) { if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e; } };

// One file into native history without ever replacing one there: the same bytes already there drop the house's copy;
// different bytes keep native history's where it is and put the house's beside it as `<name>.adopted-<stamp>`.
// A hard link moves the file itself, so a writer still holding it open keeps writing to the adopted copy.
function place(from, to) {
  for (let name = to; ; name = `${to}.adopted-${unique()}`) {
    try { linkSync(from, name); return unlinkSync(from); } catch (e) {
      if (e.code === 'EEXIST') { if (name === to && readFileSync(name).equals(readFileSync(from))) return unlinkSync(from); continue; }
      if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e;
    }
    try { copyFileSync(from, name, constants.COPYFILE_EXCL); } catch (e) { if (e.code === 'EEXIST') { if (name === to && readFileSync(name).equals(readFileSync(from))) return unlinkSync(from); continue; } throw e; }
    // Across filesystems a copy: the house's file goes only once the copy holds every byte it does.
    if (readFileSync(name).equals(readFileSync(from))) unlinkSync(from);
    return;
  }
}

// Merges a set-aside folder into native history. Anything that isn't a file or folder (a link, a socket) stays where
// it is, and so does the folder holding it: nothing is ever deleted that wasn't first placed in native history.
function adopt(staged, target) {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(staged)) {
    const from = join(staged, name), kind = lstatSync(from);
    if (kind.isDirectory()) {
      const there = stat(join(target, name));
      adopt(from, there && !(there.isDirectory() && !there.isSymbolicLink()) ? join(target, `${name}.adopted-${unique()}`) : join(target, name));
    } else if (kind.isFile()) place(from, join(target, name));
  }
  rmdirIfEmpty(staged);
}

function linkHistory(source, target) {
  for (let tries = 0; ; tries++) {
    const current = stat(source);
    if (current?.isSymbolicLink()) {
      if (resolve(dirname(source), readlinkSync(source)) === resolve(target)) return;
      throw Error('native history refuses to replace an existing directory link');
    }
    if (current && !current.isDirectory()) throw Error('native history refuses to replace existing native files');
    if (tries > 8) throw Error('native history could not link a folder that keeps changing');
    if (current && readdirSync(source).length) {
      // A CLI wrote here before its history was linked (t-2073). Set it aside under a name only this start holds:
      // rename is atomic, so of two starts racing only one adopts it, and the other links once it's gone.
      const staged = `${source}.adopting-${unique()}`;
      try { renameSync(source, staged); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      // Another start may have linked it between the look and the rename: that link holds no files, and following it
      // would merge native history into itself, so it goes and the next pass links again.
      const moved = lstatSync(staged);
      if (moved.isSymbolicLink()) { unlinkSync(staged); continue; }
      if (!moved.isDirectory()) throw Error(`native history refuses to replace existing native files (set aside at ${staged})`);
      adopt(staged, target);
      continue;
    }
    mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
    try {
      if (current) rmdirSync(source);
      symlinkSync(target, source, 'dir');
      return;
    } catch (e) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e; }
  }
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
  if (env.LOOM_RUNTIME_INBOX_DIR) {
    const source = env.LOOM_RUNTIME_INBOX_DIR;
    if (inside(root, source) && canonical(source) !== canonical(paths.inboxes)) throw Error('native inbox selector overlaps another history directory');
    if (resolve(source) !== resolve(paths.inboxes)) linkHistory(source, paths.inboxes);
  }
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
  if (options.inboxDir !== undefined && (typeof options.inboxDir !== 'string' || !env.LOOM_RUNTIME_INBOX_DIR || canonical(options.inboxDir) !== canonical(env.LOOM_RUNTIME_INBOX_DIR))) throw Error('native constructor cannot override durable inbox storage');
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
