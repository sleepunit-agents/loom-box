// Which runtime this is, and keeping a box on the one loom runs (docs/upgrading.md).
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
//   {commit, from, at, state, error?, detail?, retryAt?, now?}
//   state: 'installing' | 'removing' | 'rolling-back' (under way) | 'refused' | 'failed' | 'done'
//
// The rename (agent-runtime.md, section 1): the piece was `box`, it's `runtime` now, and the
// two can't be installed side by side (both ship `loom-box`). A box installed as `box` told to
// install a commit whose package is `runtime` swaps them itself (applyUpgrade), recoverably:
// a copy of the old version kept first (a rollback from path:, no network), a recovery timer
// armed, each step written to upgrade.json, so a unit that dies mid-swap is finished or rolled
// back by the timer (recoverUpgrade). Only a box already running this code can do that; one
// older says so on its page, with the command (swapCommand).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const COMMIT = /^[0-9a-f]{40}$/;
const PIECE = /^[a-z][a-z0-9-]{0,39}$/;
export const UPGRADE_RETRY_MS = 6 * 3600_000;
/** An install that hasn't said how it went in this long is taken as failed (its unit died). */
export const INSTALL_STALE_MS = 30 * 60_000;
export const DEFAULT_REPO = 'sleepunit-agents/loom-box';
/** An upgrade under way: a new one isn't started over it. */
export const UNDER_WAY = new Set(['installing', 'removing', 'rolling-back']);
/** How often the recovery timer fires while a swap is unfinished (and a couple of minutes after each boot). */
export const RECOVER_AFTER = '10min';
/**
 * The recovery is a real user timer, not a transient one: a reboot wipes `systemd-run` units, and a reboot mid-swap
 * may leave neither piece installed, so no runner to notice. Unit files under ~/.config/systemd/user, enabled, with
 * Persistent=true; removed when the swap is over.
 */
export const RECOVER_UNIT = 'loom-box-upgrade-recover';
/** A recovery that hasn't run in this long isn't trusted to be there (its timer never fires): the runner recovers. */
export const RECOVER_TRUST_MS = 3 * INSTALL_STALE_MS;
/** systemd's user unit dir: where the recovery timer's files go. */
export const userUnitDir = (env) => join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'systemd', 'user');

/**
 * Whether a swap's recovery can be left to its timer: the unit files are there, systemd says the timer is active,
 * and it was armed or last ran within RECOVER_TRUST_MS. Otherwise the runner recovers at once (maybeUpgrade).
 */
export function recoveryTrusted(rec, { env = process.env, run = spawnSync, nowMs = Date.now() } = {}) {
  if (!rec?.recoverUnit) return false;
  const dir = userUnitDir(env);
  if (!existsSync(join(dir, `${RECOVER_UNIT}.timer`)) || !existsSync(join(dir, `${RECOVER_UNIT}.service`))) return false;
  const last = Math.max(Date.parse(rec.armedAt ?? 0) || 0, Date.parse(rec.recoveredAt ?? 0) || 0);
  if (nowMs - last > RECOVER_TRUST_MS) return false;
  const r = run('systemctl', ['--user', 'is-active', '--quiet', `${RECOVER_UNIT}.timer`], { env, stdio: 'ignore', timeout: 10_000 });
  return r?.status === 0;
}

/**
 * One swap step at a time, across the upgrade unit, the recovery timer and a runner's recovery: a lock file with
 * the holder's pid, taken with O_EXCL. A holder that's gone (its pid dead) or older than RECOVER_TRUST_MS doesn't hold.
 */
function withLock(stateDir, f) {
  const p = join(stateDir, 'upgrade.lock');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const take = () => { try { writeFileSync(p, String(process.pid), { flag: 'wx', mode: 0o600 }); return true; } catch { return false; } };
  if (!take()) {
    let alive = false;
    try {
      const pid = Number(readFileSync(p, 'utf-8'));
      const young = Date.now() - statSync(p).mtimeMs < RECOVER_TRUST_MS;
      if (pid && pid !== process.pid && young) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
    } catch { alive = false; }
    if (alive) return null;
    rmSync(p, { force: true });
    if (!take()) return null;
  }
  try { return f(); } finally { rmSync(p, { force: true }); }
}

/**
 * This code's commit, from the path loom installed it at; null when it isn't an installed piece (a dev checkout).
 * The one source of loom's runtime commit: what the control plane tells boxes to run, and what the page compares.
 */
export function ownCommit(url = import.meta.url) {
  const m = /\/versions\/([0-9a-f]{40})\//.exec(fileURLToPath(url));
  return m ? m[1] : null;
}

/** This code's package dir (what a path: install of this very version takes). */
export const ownPackageDir = (url = import.meta.url) => dirname(dirname(fileURLToPath(url)));

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
export function vetCommit(repo, want, mine, run = spawnSync, out = {}, url = `https://github.com/${repo}.git`) {
  const dir = mkdtempSync(join(tmpdir(), 'loom-box-vet-'));
  const git = (...args) => run('git', ['-C', dir, ...args], { stdio: 'ignore', timeout: 120_000 }).status;
  try {
    if (git('init', '-q') !== 0) return 'git is missing';
    if (git('fetch', '-q', '--filter=blob:none', url, 'main') !== 0) return `couldn't read ${repo}'s main`;
    if (git('merge-base', '--is-ancestor', want, 'FETCH_HEAD') !== 0) return `${want.slice(0, 7)} isn't on ${repo}'s main`;
    // Forward only: what this box runs must come before it. Anything else (behind, beside, or git can't
    // place this box's commit) isn't installed; a rollback is done by hand.
    if (git('merge-base', '--is-ancestor', mine, want) !== 0) return `${want.slice(0, 7)} doesn't follow this box's ${mine.slice(0, 7)} on ${repo}'s main; a rollback is done by hand`;
    // What it installs as: `runtime` since the rename. Not knowing is a refusal: a plain install of a renamed
    // package over the old one is the bin clash the swap exists for.
    const pkg = run('git', ['-C', dir, 'show', `${want}:package.json`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000 });
    if (pkg.status !== 0) return `couldn't read ${want.slice(0, 7)}'s package.json, so can't tell which piece it installs as`;
    let name = null;
    try { name = packagePiece(JSON.parse(pkg.stdout ?? '')); } catch { name = null; }
    if (!name) return `${want.slice(0, 7)}'s package.json doesn't say which piece it installs as`;
    out.piece = name;
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
  // A swap rolling back is the recovery timer's (it re-arms until it's done): never taken as over.
  if ((r.state === 'installing' || r.state === 'removing') && nowMs - Date.parse(r.at) > INSTALL_STALE_MS && !r.recoverUnit && !r.piece) {
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
  // "Update now" that can't start yet says why (the box logs it, and loom keeps asking until an attempt starts).
  const waits = (why) => (now ? `update now waits: ${why}` : null);
  if (env.LOOM_BOX_UPGRADE === 'off') return waits('upgrades are off on this box (LOOM_BOX_UPGRADE=off)');
  if (!COMMIT.test(want ?? '')) return waits('loom names no runtime commit (it runs a dev checkout)');
  if (!mine) return waits('this box runs a dev checkout, not an installed piece');
  // A swap left part-way (even one that got as far as installing what this box now runs) comes first.
  const last = lastUpgrade(stateDir, nowMs);
  if (last && UNDER_WAY.has(last.state)) {
    const swapping = last.piece && last.target && last.piece !== last.target;
    // A swap whose recovery timer is really there, and has run lately: its own.
    if (swapping && recoveryTrusted(last, { env, run: spawn, nowMs })) return waits(`an upgrade to ${short(last.commit)} is under way (${last.state})`);
    const quiet = nowMs - Math.max(Date.parse(last.at) || 0, Date.parse(last.stepAt ?? 0) || 0, Date.parse(last.recoveredAt ?? 0) || 0) > INSTALL_STALE_MS;
    // A swap with no timer to trust (a reboot wiped it, or it never fires): recover now, from this poll, in a unit of
    // its own, so the reinstall restarting this box's service can't cut it short. A plain install: wait out its time.
    if (swapping && (quiet || last.recoverUnit)) {
      const k = spawn('systemd-run', ['--user', '--collect', '--quiet', `--unit=${RECOVER_UNIT}-now`, ...passEnv(env), node, cli, 'upgrade-apply', '--recover'], { stdio: 'ignore', env });
      return k?.status === 0 ? `the swap to ${short(last.commit)} stopped at ${last.state} and its recovery timer isn't there: recovering now`
        : `the swap to ${short(last.commit)} stopped at ${last.state}: couldn't start its recovery (systemd-run exit ${k?.status}); trying again next poll`;
    }
    if (!quiet) return waits(`an upgrade to ${short(last.commit)} is under way (${last.state})`);
  }
  if (want === mine) return null;
  if (starting) return waits('a house is starting; it tries after');
  if (!now && last?.commit === want && nowMs - Date.parse(last.at) < UPGRADE_RETRY_MS) return null;
  const at = new Date(nowMs).toISOString();
  const retryAt = new Date(nowMs + UPGRADE_RETRY_MS).toISOString();
  const repo = env.LOOM_BOX_REPO || DEFAULT_REPO;
  const out = {};
  const no = vet(repo, want, mine, undefined, out);
  const tag = typeof now === 'string' ? { now } : {};
  if (no) {
    writeRecord(stateDir, { commit: want, from: mine, at, state: 'refused', error: no, retryAt, ...tag });
    return `not installing ${want.slice(0, 7)}: ${no}; asking again in ${UPGRADE_RETRY_MS / 3600_000}h`;
  }
  writeRecord(stateDir, { commit: want, from: mine, at, state: 'installing', retryAt, ...tag });
  const target = out.piece;
  // The unit runs this version's own `upgrade-apply` (applyUpgrade): the install, or the box→runtime swap.
  const pass = passEnv(env);
  const r = spawn('systemd-run', ['--user', '--collect', '--quiet', `--unit=loom-box-upgrade-${want.slice(0, 12)}`, ...pass,
    node, cli, 'upgrade-apply', '--commit', want, '--from', mine, '--repo', repo, ...(piece ? ['--piece', piece] : []), ...(target ? ['--target', target] : [])], { stdio: 'ignore', env });
  if (r.status !== 0) {
    writeRecord(stateDir, { commit: want, from: mine, at, state: 'failed', error: `couldn't start the install (systemd-run exit ${r.status})`, retryAt, ...tag });
    return `couldn't start installing ${want.slice(0, 7)} (systemd-run exit ${r.status}); trying again in ${UPGRADE_RETRY_MS / 3600_000}h`;
  }
  const swap = piece && target && piece !== target;
  return `installing ${want.slice(0, 7)} (this box runs ${mine.slice(0, 7)})${swap ? `, swapping the ${piece} piece for ${target}` : ''}; its service restarts, and the houses carry on`;
}

const short = (c) => String(c ?? '').slice(0, 7);
/** What a detached unit is given of the box's environment (systemd-run's own env is the user manager's). */
const passEnv = (env) => ['LOOM_HOME', 'LOOM_BIN', 'LOOM_BOX_HOME', 'HOME', 'PATH'].filter((k) => env[k]).map((k) => `--setenv=${k}=${env[k]}`);

/** $LOOM_HOME, else ~/.config/loom: where loom keeps its pieces. */
export const loomHome = (env) => env.LOOM_HOME || join(env.HOME || homedir(), '.config', 'loom');

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
const pieceRecord = (env, name) => readJson(join(loomHome(env), 'pieces', name, 'piece.json'));
/** What a piece declares as its settings, from the copy of its loom block loom keeps (piece.json). */
const declaredOf = (env, name) => {
  const s = pieceRecord(env, name)?.loom?.settings;
  return Array.isArray(s) ? s.map((x) => x?.name).filter((n) => typeof n === 'string') : null;
};

/**
 * An old piece's settings, for the new one. Every one is kept under its own name (`all`: the runtime still reads
 * LOOM_BOX_*, and LOOM_BOX_DATA is where all of a box's state is); and each the new piece declares under its new
 * name (LOOM_BOX_<X> → LOOM_RUNTIME_<X>) or its own is also `declared`, for loom's settings store.
 */
export function carriedSettings(old, declared = null) {
  const all = [], set = [];
  const src = old && typeof old === 'object' ? old : {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v !== 'string' || !/^LOOM_[A-Z0-9_]+$/.test(k) || /[\n\r\0]/.test(v)) continue;
    all.push([k, v]);
    if (declared?.includes(k)) set.push(`${k}=${v}`);
    const to = k.replace(/^LOOM_BOX_/, 'LOOM_RUNTIME_');
    if (to !== k && declared?.includes(to) && src[to] === undefined) set.push(`${to}=${v}`);
  }
  return { all, set };
}

/**
 * The file a swapped-in runtime reads its carried settings from (loadCarried): <piece home>/carried.env. Not
 * loom's settings store, which takes only names the piece declares (`loom pieces set` refuses the rest), and not
 * its service.env, which loom rewrites from that store on every install and `set`.
 */
export const CARRIED = 'carried.env';
export function loadCarried(env = process.env) {
  if (!env.LOOM_PIECE_HOME) return 0;
  let text = '';
  try { text = readFileSync(join(env.LOOM_PIECE_HOME, CARRIED), 'utf-8'); } catch { return 0; }
  let n = 0;
  for (const line of text.split('\n')) {
    const m = /^(LOOM_[A-Z0-9_]+)=(.*)$/.exec(line);
    // What loom sets (a declared setting, the daemon's env) wins: this only fills in what's missing.
    if (m && env[m[1]] === undefined) { env[m[1]] = m[2]; n++; }
  }
  return n;
}

/** Carry the old piece's settings to the new one: carried.env with all of them, `loom pieces set` the declared. */
export function carrySettings(env, { from = 'box', to = 'runtime', run = spawnSync, loomBin = env.LOOM_BIN || 'loom' } = {}) {
  const old = readJson(join(loomHome(env), 'pieces', from, 'settings.json'));
  const { all, set } = carriedSettings(old, declaredOf(env, to));
  const home = join(loomHome(env), 'pieces', to);
  if (all.length) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, CARRIED), all.map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  }
  if (!set.length) return { carried: all.length, declared: 0 };
  const r = run(loomBin, ['pieces', 'set', to, ...set], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  return r.status === 0 ? { carried: all.length, declared: set.length } : { carried: all.length, declared: 0, error: `loom pieces set ${to} failed (exit ${r.status})` };
}

/** The last lines of an install's output, with nothing in them that looks like a token. */
const tailOf = (r) => `${r?.stdout ?? ''}\n${r?.stderr ?? ''}`.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-6).join('\n')
  .replace(/\b(token|secret|password|bearer|key)(["':= ]+)\S+/gi, '$1$2[…]').replace(/[A-Za-z0-9+/_=-]{32,}/g, '[…]').slice(-600);

/** The detached units' common part: run loom, and write each step of an upgrade to upgrade.json. */
function upgradeKit({ env, stateDir, run, node = process.execPath, cli = fileURLToPath(new URL('./cli.mjs', import.meta.url)) }) {
  const loomBin = env.LOOM_BIN || 'loom';
  const loom = (...args) => {
    const r = run(loomBin, args, { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20 * 60_000 });
    return r ?? { status: 1 };
  };
  const say = (rec) => { const r = { ...rec, stepAt: new Date().toISOString() }; writeRecord(stateDir, r); return r; };
  const systemctl = (...args) => run('systemctl', ['--user', ...args], { env, stdio: 'ignore', timeout: 30_000 }) ?? { status: 1 };
  /**
   * The recovery timer (RECOVER_UNIT): real unit files, enabled, so it survives a reboot. It fires a couple of
   * minutes after each boot and every RECOVER_AFTER (Persistent=true catches up a run missed while the box was off)
   * until the swap is over (disarm).
   */
  const arm = (rec) => {
    const dir = userUnitDir(env);
    const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const pass = ['LOOM_HOME', 'LOOM_BIN', 'LOOM_BOX_HOME', 'HOME', 'PATH'].filter((k) => env[k] && !/[\n\r]/.test(env[k]));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${RECOVER_UNIT}.service`), ['# Written by loom-runtime (src/version.mjs): finishes or rolls back a box→runtime swap. Removed when it\'s over.',
        '[Unit]', 'Description=loom runtime: finish or roll back the box→runtime swap', '', '[Service]', 'Type=oneshot',
        ...pass.map((k) => `Environment=${q(`${k}=${env[k]}`)}`), `ExecStart=${[node, cli, 'upgrade-apply', '--recover'].map(q).join(' ')}`, ''].join('\n'));
      writeFileSync(join(dir, `${RECOVER_UNIT}.timer`), ['# Written by loom-runtime (src/version.mjs). Removed when the swap is over.',
        '[Unit]', 'Description=loom runtime: the box→runtime swap\'s recovery', '', '[Timer]', 'OnBootSec=2min', `OnUnitActiveSec=${RECOVER_AFTER}`,
        'OnCalendar=*:0/10', 'Persistent=true', '', '[Install]', 'WantedBy=timers.target', ''].join('\n'));
    } catch { return null; }
    if (systemctl('daemon-reload').status !== 0 || systemctl('enable', '--now', `${RECOVER_UNIT}.timer`).status !== 0) return null;
    return { ...rec, recoverUnit: `${RECOVER_UNIT}.timer`, armedAt: new Date().toISOString() };
  };
  const disarm = (rec) => {
    if (rec.recoverUnit) {
      systemctl('disable', '--now', `${RECOVER_UNIT}.timer`);
      for (const f of [`${RECOVER_UNIT}.timer`, `${RECOVER_UNIT}.service`]) rmSync(join(userUnitDir(env), f), { force: true });
      systemctl('daemon-reload');
    }
    const { recoverUnit: _u, armedAt: _a, ...rest } = rec;
    return rest;
  };
  return { loom, say, arm, disarm, loomBin };
}

const installed = (env, name, commit) => {
  const r = pieceRecord(env, name);
  return !!r && (commit === undefined || r.commit === commit || r.source?.commit === commit);
};

/**
 * The swap, from wherever it got to (rec.state), to an end: done, failed with the old piece back, or still
 * rolling back with the recovery timer re-armed. Each step is written before it's taken.
 */
function continueSwap(kit, env, rec) {
  const { loom, say, arm, disarm } = kit;
  const src = `github:${rec.repo}#${rec.commit}`;
  let r = rec;
  if (r.state === 'removing') {
    if (installed(env, r.piece)) {
      const rm = loom('pieces', 'remove', r.piece);
      if (rm.status !== 0) return say({ ...disarm(r), state: 'failed', error: `couldn't remove the old ${r.piece} piece to install ${r.target} (exit ${rm.status}); nothing changed`, detail: tailOf(rm) });
    }
    r = say({ ...r, state: 'installing' });
  }
  if (r.state === 'installing') {
    let inst = { status: 0 };
    if (!installed(env, r.target, r.commit)) inst = loom('pieces', 'install', '--from', src, '--yes');
    if (inst.status === 0) {
      const c = carrySettings(env, { from: r.piece, to: r.target, run: kit.run, loomBin: kit.loomBin });
      return say({ ...disarm(r), state: 'done', swapped: { from: r.piece, to: r.target, settings: c.carried, declared: c.declared },
        ...(c.error ? { error: `installed; ${c.error}: set them by hand (every old value is in pieces/${r.target}/${CARRIED})` } : {}) });
    }
    r = say({ ...r, state: 'rolling-back', error: `installing ${r.target} failed (exit ${inst.status})`, detail: tailOf(inst) });
  }
  if (r.state === 'rolling-back') {
    // The kept copy first: no network. Then the old commit from GitHub.
    let back = installed(env, r.piece) ? { status: 0 } : { status: 1 };
    if (back.status !== 0 && r.keep && existsSync(join(r.keep, 'package.json'))) back = loom('pieces', 'install', '--from', `path:${r.keep}`, '--yes');
    if (back.status !== 0) back = loom('pieces', 'install', '--from', `github:${r.repo}#${r.from}`, '--yes');
    if (back.status === 0) return say({ ...disarm(r), state: 'failed', error: `${r.error ?? `installing ${r.target} failed`}; the ${r.piece} piece is back as it was` });
    // The timer stays armed (it repeats); armed again if it isn't there any more.
    const again = r.recoverUnit && existsSync(join(userUnitDir(env), `${RECOVER_UNIT}.timer`)) ? r : arm(r);
    return say({ ...(again ?? r), state: 'rolling-back',
      error: `${r.error ?? `installing ${r.target} failed`}, and putting the ${r.piece} piece back failed too (exit ${back.status}): ${again ? `it tries again in ${RECOVER_AFTER}` : 'and the recovery timer couldn\'t be armed'}. By hand, on the box: loom pieces install --from ${r.keep ? `path:${r.keep}` : `github:${r.repo}#${r.from}`} --yes` });
  }
  return r;
}

/**
 * The detached unit's work (`loom-runtime upgrade-apply`): install `commit`, and say how it went in upgrade.json.
 * When the box is installed as `piece` and the commit's package is `target` (box → runtime), swap them,
 * recoverably: keep a copy of this version's package (`keepDir`, this code's own) in the box's state dir, arm the
 * recovery timer, then remove the old piece (loom keeps its settings and data), install the new one, and carry the
 * settings over. If the install fails, the kept copy goes back in (path:, no network), else the old commit.
 */
export function applyUpgrade({ commit, from, repo = DEFAULT_REPO, piece, target, env = process.env, stateDir, run = spawnSync, nowMs = Date.now(), keepDir = ownPackageDir(), node, cli }) {
  if (!COMMIT.test(commit ?? '') || !COMMIT.test(from ?? '')) throw new Error('upgrade-apply needs --commit and --from, full commits');
  const kit = { ...upgradeKit({ env, stateDir, run, node, cli }), run };
  const prev = readRecord(stateDir);
  const base = { commit, from, repo, piece, target, at: new Date(nowMs).toISOString(), retryAt: new Date(nowMs + UPGRADE_RETRY_MS).toISOString(), ...(prev?.commit === commit && prev.now ? { now: prev.now } : {}) };
  if (!piece || !target || piece === target) {
    const r = kit.loom('pieces', 'install', '--from', `github:${repo}#${commit}`, '--yes');
    return kit.say(r.status === 0 ? { ...base, state: 'done' } : { ...base, state: 'failed', error: `loom pieces install failed (exit ${r.status})`, detail: tailOf(r) });
  }
  // 1. A copy of what runs now, outside the piece home `remove` empties: the rollback needs no network.
  const keep = join(stateDir, 'upgrade-keep', from);
  try {
    if (!existsSync(join(keepDir, 'package.json'))) throw new Error(`no package.json in ${keepDir}`);
    rmSync(keep, { recursive: true, force: true });
    mkdirSync(dirname(keep), { recursive: true, mode: 0o700 });
    cpSync(keepDir, keep, { recursive: true, filter: (p) => !p.includes(`${join(keepDir, 'node_modules')}`) });
  } catch (e) {
    return kit.say({ ...base, state: 'failed', error: `couldn't keep a copy of the ${piece} piece to roll back to (${e.message}); nothing changed` });
  }
  // 2. The recovery timer, before anything changes: if this unit dies mid-swap, it finishes or rolls back.
  const armed = kit.arm({ ...base, keep });
  if (!armed) return kit.say({ ...base, state: 'failed', error: 'couldn\'t arm the recovery timer (systemd-run --on-active); nothing changed' });
  // 3. Each step written before it's taken.
  const went = withLock(stateDir, () => continueSwap(kit, env, kit.say({ ...armed, state: 'removing' })));
  return went ?? readRecord(stateDir);
}

/**
 * The recovery timer's run (`upgrade-apply --recover`): a swap upgrade.json says is under way is carried on from
 * its last step. Nothing to do once it's over.
 */
export function recoverUpgrade({ env = process.env, stateDir, run = spawnSync, node, cli } = {}) {
  const kit = { ...upgradeKit({ env, stateDir, run, node, cli }), run };
  const went = withLock(stateDir, () => {
    const rec = readRecord(stateDir);
    if (!rec || !UNDER_WAY.has(rec.state) || !rec.piece || !rec.target || rec.piece === rec.target) {
      // Over (or nothing): a timer left behind goes.
      if (existsSync(join(userUnitDir(env), `${RECOVER_UNIT}.timer`))) kit.disarm({ recoverUnit: `${RECOVER_UNIT}.timer` });
      return rec;
    }
    return continueSwap(kit, env, { ...rec, recoveredAt: new Date().toISOString() });
  });
  // Another holds the lock (the upgrade unit still at it): nothing to do this time.
  return went === null ? readRecord(stateDir) : went;
}

/**
 * For a box still on a version older than the swap (it can't do it itself): the one line to run on it once. The
 * new piece's own `carry-settings` copies the old piece's settings over.
 */
export const swapCommand = (commit, repo = DEFAULT_REPO) =>
  `loom pieces remove box && loom pieces install --from github:${repo}#${commit} --yes && loom runtime carry-settings`;
