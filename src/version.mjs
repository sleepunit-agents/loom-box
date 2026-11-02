// Which runtime this is, and keeping a box on the one loom runs.
//
// loom installs a piece at a commit (loom docs/specs/pieces-install.md):
// $LOOM_HOME/pieces/<name>/versions/<commit>/…, so a process knows its own commit
// (and the name it's installed under) from where its code is. The control plane says
// which commit it runs in every poll answer; a box on another one installs that one,
// from a unit of its own (systemd-run), so the install can restart the box's service
// without being killed with it. Houses don't notice: a box adopts its running houses
// when it starts again. A failed install isn't tried again for UPGRADE_RETRY_MS,
// unless the owner presses "Update now" on the box's page (the vetting is the same).
//
// What the box last tried is kept in <state>/upgrade.json, and reported in each poll
// (lastUpgrade), so the page shows "updating…", or why it didn't and when it tries again:
//   {commit, from, at, state: 'installing'|'refused'|'failed'|'done', error?, detail?, retryAt?}
//
// The rename (agent-runtime.md, section 1): the piece was `box`, it's `runtime` now, and the
// two can't be installed side by side (both ship `loom-box`). A box installed as `box` told to
// install a commit whose package is `runtime` swaps them itself (applyUpgrade): the old piece
// removed (its settings and data stay), the new one installed, its settings carried over
// (LOOM_BOX_* to LOOM_RUNTIME_*); the old one put back if the install fails. Only a box already
// running this code can do that; one older says so on its page, with the command (SWAP_DOC).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const COMMIT = /^[0-9a-f]{40}$/;
const PIECE = /^[a-z][a-z0-9-]{0,39}$/;
export const UPGRADE_RETRY_MS = 6 * 3600_000;
/** An install that hasn't said how it went in this long is taken as failed (its unit died). */
export const INSTALL_STALE_MS = 30 * 60_000;
export const DEFAULT_REPO = 'sleepunit-agents/loom-box';

/** This code's commit, from the path loom installed it at; null when it isn't an installed piece (a dev checkout). */
export function ownCommit(url = import.meta.url) {
  const m = /\/versions\/([0-9a-f]{40})\//.exec(fileURLToPath(url));
  return m ? m[1] : null;
}

/** The commit loom's runtime is, for its page: its own, else LOOM_RUNTIME_COMMIT (a dev checkout, the tests). */
export function selfCommit(env = process.env) {
  return ownCommit() || (COMMIT.test(env.LOOM_RUNTIME_COMMIT ?? '') ? env.LOOM_RUNTIME_COMMIT : null);
}

/** The name loom installed this code under (`box` or `runtime`), from its path; null in a dev checkout. */
export function ownPiece(url = import.meta.url) {
  const m = /\/pieces\/([a-z][a-z0-9-]{0,39})\/versions\/[0-9a-f]{40}\//.exec(fileURLToPath(url));
  return m ? m[1] : null;
}

/** The piece name a package.json says it installs as: its loom.name, else its `loom-<name>` bin (as loom reads it). */
export function packagePiece(pkg) {
  if (typeof pkg?.loom?.name === 'string' && PIECE.test(pkg.loom.name)) return pkg.loom.name;
  const bins = typeof pkg?.bin === 'object' && pkg.bin ? Object.keys(pkg.bin) : [];
  const b = bins.find((x) => /^loom-[a-z][a-z0-9-]*$/.test(x));
  return b ? b.slice(5) : null;
}

/**
 * Whether the box itself trusts a commit it's told to install, without trusting who told it:
 * it must be on the canonical repo's main (not a fork's commit GitHub would also serve under
 * that name), and after the one the box runs (going back is a rollback, done by hand).
 * Returns null when it's fine, else why not. `out.piece` is then the name the commit's package installs as.
 */
export function vetCommit(repo, want, mine, run = spawnSync, out = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loom-box-vet-'));
  const git = (...args) => run('git', ['-C', dir, ...args], { stdio: 'ignore', timeout: 120_000 }).status;
  try {
    if (git('init', '-q') !== 0) return 'git is missing';
    if (git('fetch', '-q', '--filter=blob:none', `https://github.com/${repo}.git`, 'main') !== 0) return `couldn't read ${repo}'s main`;
    if (git('merge-base', '--is-ancestor', want, 'FETCH_HEAD') !== 0) return `${want.slice(0, 7)} isn't on ${repo}'s main`;
    // Forward only: what this box runs must come before it. Anything else (behind, beside, or git can't
    // place this box's commit) isn't installed; a rollback is done by hand.
    if (git('merge-base', '--is-ancestor', mine, want) !== 0) return `${want.slice(0, 7)} doesn't follow this box's ${mine.slice(0, 7)} on ${repo}'s main; a rollback is done by hand`;
    // What it installs as: `runtime` since the rename. Only read, for the swap (applyUpgrade).
    const pkg = run('git', ['-C', dir, 'show', `${want}:package.json`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000 });
    try { out.piece = packagePiece(JSON.parse(pkg.stdout ?? '')); } catch { out.piece = null; }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const recordFile = (stateDir) => join(stateDir, 'upgrade.json');
function writeRecord(stateDir, rec) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(recordFile(stateDir), JSON.stringify(rec) + '\n', { mode: 0o600 });
}
function readRecord(stateDir) {
  try { return JSON.parse(readFileSync(recordFile(stateDir), 'utf-8')); } catch { return null; }
}

/** The box's last upgrade attempt, for its poll: an install too long without word is a failed one. */
export function lastUpgrade(stateDir, nowMs = Date.now()) {
  const r = readRecord(stateDir);
  if (!r || !COMMIT.test(r.commit ?? '')) return null;
  if (r.state === 'installing' && nowMs - Date.parse(r.at) > INSTALL_STALE_MS) {
    return { ...r, state: 'failed', error: 'the install never said how it went (its unit ended without a word)', retryAt: new Date(Date.parse(r.at) + UPGRADE_RETRY_MS).toISOString() };
  }
  // From before the record said how it went: an attempt, and when it's tried again.
  if (!r.state) return { ...r, state: 'installing', retryAt: new Date(Date.parse(r.at) + UPGRADE_RETRY_MS).toISOString() };
  return r;
}

/**
 * The box's part, once a poll: should it install the commit loom runs? Returns what it did, for the log
 * (null when nothing). `spawn` is injected in tests; `stateDir` keeps the last attempt. `now: true` is the owner's
 * "Update now": the retry wait doesn't hold, nothing else changes.
 */
export function maybeUpgrade({ want, mine = ownCommit(), piece = ownPiece(), starting = false, env = process.env, stateDir, nowMs = Date.now(), spawn = spawnSync, vet = vetCommit, now = false, cli = fileURLToPath(new URL('./cli.mjs', import.meta.url)), node = process.execPath }) {
  if (env.LOOM_BOX_UPGRADE === 'off' || !COMMIT.test(want ?? '') || !mine || want === mine || starting) return null;
  const last = lastUpgrade(stateDir, nowMs);
  if (!now && last?.commit === want && nowMs - Date.parse(last.at) < UPGRADE_RETRY_MS) return null;
  if (last?.commit === want && last.state === 'installing' && nowMs - Date.parse(last.at) < INSTALL_STALE_MS) return null;
  const at = new Date(nowMs).toISOString();
  const retryAt = new Date(nowMs + UPGRADE_RETRY_MS).toISOString();
  const repo = env.LOOM_BOX_REPO || DEFAULT_REPO;
  const out = {};
  const no = vet(repo, want, mine, undefined, out);
  if (no) {
    writeRecord(stateDir, { commit: want, from: mine, at, state: 'refused', error: no, retryAt });
    return `not installing ${want.slice(0, 7)}: ${no}; asking again in ${UPGRADE_RETRY_MS / 3600_000}h`;
  }
  writeRecord(stateDir, { commit: want, from: mine, at, state: 'installing', retryAt });
  const target = out.piece && PIECE.test(out.piece) ? out.piece : piece;
  // The unit runs this version's own `upgrade-apply` (applyUpgrade): the install, or the box→runtime swap.
  const pass = ['LOOM_HOME', 'LOOM_BIN', 'LOOM_BOX_HOME', 'HOME', 'PATH'].filter((k) => env[k]).map((k) => `--setenv=${k}=${env[k]}`);
  const r = spawn('systemd-run', ['--user', '--collect', '--quiet', `--unit=loom-box-upgrade-${want.slice(0, 12)}`, ...pass,
    node, cli, 'upgrade-apply', '--commit', want, '--from', mine, '--repo', repo, ...(piece ? ['--piece', piece] : []), ...(target ? ['--target', target] : [])], { stdio: 'ignore', env });
  if (r.status !== 0) {
    writeRecord(stateDir, { commit: want, from: mine, at, state: 'failed', error: `couldn't start the install (systemd-run exit ${r.status})`, retryAt });
    return `couldn't start installing ${want.slice(0, 7)} (systemd-run exit ${r.status}); trying again in ${UPGRADE_RETRY_MS / 3600_000}h`;
  }
  const swap = piece && target && piece !== target;
  return `installing ${want.slice(0, 7)} (this box runs ${mine.slice(0, 7)})${swap ? `, swapping the ${piece} piece for ${target}` : ''}; its service restarts, and the houses carry on`;
}

/** $LOOM_HOME, else ~/.config/loom: where loom keeps its pieces. */
export const loomHome = (env) => env.LOOM_HOME || join(env.HOME || homedir(), '.config', 'loom');

/**
 * An old piece's settings, under the new piece's names: LOOM_BOX_<X> becomes LOOM_RUNTIME_<X>, and only the ones
 * the new piece declares (all of them, when it's not known what it declares). Returns NAME=value strings.
 */
export function carriedSettings(old, declared = null) {
  const out = [];
  for (const [k, v] of Object.entries(old && typeof old === 'object' ? old : {})) {
    if (typeof v !== 'string' || !/^LOOM_[A-Z0-9_]+$/.test(k)) continue;
    const to = k.replace(/^LOOM_BOX_/, 'LOOM_RUNTIME_');
    if (declared && !declared.includes(to)) continue;
    out.push(`${to}=${v}`);
  }
  return out;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
/** What a piece declares as its settings, from the copy of its loom block loom keeps (piece.json). */
const declaredOf = (env, name) => {
  const rec = readJson(join(loomHome(env), 'pieces', name, 'piece.json'));
  const s = rec?.loom?.settings;
  return Array.isArray(s) ? s.map((x) => x?.name).filter((n) => typeof n === 'string') : null;
};

/** Carry the old piece's settings to the new one (`loom pieces set`). Returns how many, or why not. */
export function carrySettings(env, { from = 'box', to = 'runtime', run = spawnSync, loomBin = env.LOOM_BIN || 'loom' } = {}) {
  const old = readJson(join(loomHome(env), 'pieces', from, 'settings.json'));
  const pairs = carriedSettings(old, declaredOf(env, to));
  if (!pairs.length) return { carried: 0 };
  const r = run(loomBin, ['pieces', 'set', to, ...pairs], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  return r.status === 0 ? { carried: pairs.length } : { carried: 0, error: `loom pieces set ${to} failed (exit ${r.status})` };
}

/** The last lines of an install's output, with nothing in them that looks like a token. */
const tailOf = (r) => `${r?.stdout ?? ''}\n${r?.stderr ?? ''}`.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-6).join('\n')
  .replace(/\b(token|secret|password|bearer|key)(["':= ]+)\S+/gi, '$1$2[…]').replace(/[A-Za-z0-9+/_=-]{32,}/g, '[…]').slice(-600);

/**
 * The detached unit's work (`loom-runtime upgrade-apply`): install `commit`, and say how it went in upgrade.json.
 * When the box is installed as `piece` and the commit's package is `target` (box → runtime), swap them: remove the
 * old one (loom keeps its settings and data), install the new one, carry the settings over; if the install fails,
 * install the old commit again, which picks its kept settings up.
 */
export function applyUpgrade({ commit, from, repo = DEFAULT_REPO, piece, target, env = process.env, stateDir, run = spawnSync, nowMs = Date.now() }) {
  if (!COMMIT.test(commit ?? '') || !COMMIT.test(from ?? '')) throw new Error('upgrade-apply needs --commit and --from, full commits');
  const loomBin = env.LOOM_BIN || 'loom';
  const loom = (...args) => run(loomBin, args, { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20 * 60_000 });
  const at = new Date(nowMs).toISOString();
  const retryAt = new Date(nowMs + UPGRADE_RETRY_MS).toISOString();
  const say = (rec) => { writeRecord(stateDir, { commit, from, at, retryAt, ...rec }); return rec; };
  const src = (c) => `github:${repo}#${c}`;
  if (!piece || !target || piece === target) {
    const r = loom('pieces', 'install', '--from', src(commit), '--yes');
    return r.status === 0 ? say({ state: 'done' }) : say({ state: 'failed', error: `loom pieces install failed (exit ${r.status})`, detail: tailOf(r) });
  }
  // The swap. The settings are read first: remove keeps them, but they're carried from what was there.
  const rm = loom('pieces', 'remove', piece);
  if (rm.status !== 0) return say({ state: 'failed', error: `couldn't remove the old ${piece} piece to install ${target} (exit ${rm.status}); nothing changed`, detail: tailOf(rm) });
  const inst = loom('pieces', 'install', '--from', src(commit), '--yes');
  if (inst.status !== 0) {
    const back = loom('pieces', 'install', '--from', src(from), '--yes');
    return say({ state: 'failed', detail: tailOf(inst),
      error: back.status === 0 ? `installing ${target} failed (exit ${inst.status}); the ${piece} piece is back as it was`
        : `installing ${target} failed (exit ${inst.status}), and putting the ${piece} piece back failed too (exit ${back.status}): on the box, run loom pieces install --from ${src(from)} --yes` });
  }
  const c = carrySettings(env, { from: piece, to: target, run, loomBin });
  return say({ state: 'done', swapped: { from: piece, to: target, settings: c.carried }, ...(c.error ? { error: `installed; ${c.error}: set them by hand (the old values are in pieces/${piece}/settings.json)` } : {}) });
}

/**
 * For a box still on a version older than the swap (it can't do it itself): the one line to run on it once. The
 * new piece's own `carry-settings` copies the old piece's settings over.
 */
export const swapCommand = (commit, repo = DEFAULT_REPO) =>
  `loom pieces remove box && loom pieces install --from github:${repo}#${commit} --yes && loom runtime carry-settings`;
