// Which loom-box this is, and keeping a box on the one loom runs.
//
// loom installs a piece at a commit (loom docs/specs/pieces-install.md):
// $LOOM_HOME/pieces/box/versions/<commit>/…, so a process knows its own commit
// from where its code is. The control plane says which commit it runs in every
// poll answer; a box on another one installs that one, from a unit of its own
// (systemd-run), so the install can restart the box's service without being
// killed with it. Houses don't notice: a box adopts its running houses when it
// starts again. A failed install isn't tried again for UPGRADE_RETRY_MS.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const COMMIT = /^[0-9a-f]{40}$/;
export const UPGRADE_RETRY_MS = 6 * 3600_000;

/** This code's commit, from the path loom installed it at; null when it isn't an installed piece (a dev checkout). */
export function ownCommit(url = import.meta.url) {
  const m = /\/versions\/([0-9a-f]{40})\//.exec(fileURLToPath(url));
  return m ? m[1] : null;
}

/**
 * The box's part, once a poll: should it install the commit loom runs? Returns what it did, for the log
 * (null when nothing). `spawn` is injected in tests; `stateDir` keeps the last attempt.
 */
export function maybeUpgrade({ want, mine = ownCommit(), starting = false, env = process.env, stateDir, nowMs = Date.now(), spawn = spawnSync }) {
  if (env.LOOM_BOX_UPGRADE === 'off' || !COMMIT.test(want ?? '') || !mine || want === mine || starting) return null;
  const file = join(stateDir, 'upgrade.json');
  let last = null;
  try { last = JSON.parse(readFileSync(file, 'utf-8')); } catch { /* none yet */ }
  if (last?.commit === want && nowMs - Date.parse(last.at) < UPGRADE_RETRY_MS) return null;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ commit: want, from: mine, at: new Date(nowMs).toISOString() }) + '\n', { mode: 0o600 });
  const repo = env.LOOM_BOX_REPO || 'sleepunit-agents/loom-box';
  const r = spawn('systemd-run', ['--user', '--collect', '--quiet', `--unit=loom-box-upgrade-${want.slice(0, 12)}`,
    env.LOOM_BIN || 'loom', 'pieces', 'install', '--from', `github:${repo}#${want}`, '--yes'], { stdio: 'ignore', env });
  return r.status === 0
    ? `installing loom-box ${want.slice(0, 7)} (this box runs ${mine.slice(0, 7)}); its service restarts, and the houses carry on`
    : `couldn't start installing loom-box ${want.slice(0, 7)} (systemd-run exit ${r.status}); trying again in ${UPGRADE_RETRY_MS / 3600_000}h`;
}
