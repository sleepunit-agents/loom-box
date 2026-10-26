// Box sessions (control.mjs, "box sessions"): one Claude Code remote-control
// session for an agent, run on this box itself, not in a house. The owner
// brings it up when the work needs the machine and takes it down after.
//
// Each is a systemd user unit (loom-remote-<agent>), so it outlives a restart
// of the box's own service, as houses do. It runs in the agent's folder, on the
// box's own Claude login: never an env token (a box's user manager may carry
// CLAUDE_CODE_OAUTH_TOKEN for its daemon; remote-control needs the session
// login, and Claude Code prefers the env token), with permissions bypassed
// (Jonathan, 2026-10-25: the work is continuous). Its output goes to a file
// here, where the box finds the session's link and reports it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';

const RETRY_MS = 60_000;
const LINK = /https:\/\/claude\.ai\/code\?environment=env_[A-Za-z0-9]{1,64}/g;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

export const unitOf = (agent) => `loom-remote-${agent}`;
const systemctl = (env) => env.LOOM_BOX_SYSTEMCTL || 'systemctl';
const systemdRun = (env) => env.LOOM_BOX_SYSTEMD_RUN || 'systemd-run';
const claudeBin = (env) => env.LOOM_BOX_CLAUDE || (existsSync(pathJoin(env.HOME || homedir(), '.local', 'bin', 'claude')) ? pathJoin(env.HOME || homedir(), '.local', 'bin', 'claude') : 'claude');
const logOf = (dir, agent) => pathJoin(dir, 'remotes', `${agent}.log`);

/** What the box does about its sessions each tick: sync(remotes) from the poll. */
export function boxSessions(env, client, { dataDir, log }) {
  const told = new Map();     // agent -> what was last reported ("state url")
  const tried = new Map();    // agent -> when it was last started
  const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf-8', timeout: 20_000, env: { ...env } });
  const active = (agent) => (run(systemctl(env), ['--user', 'is-active', unitOf(agent)]).stdout || '').trim();

  async function tell(agent, state, extra = {}) {
    const key = `${state} ${extra.url ?? ''}`;
    if (told.get(agent) === key) return;
    try {
      await client.call('remote-report', { agent, state, ...extra });
      told.set(agent, key);
    } catch (err) { log(`box session ${agent}: report: ${err.message}`); }
  }

  function output(agent) {
    try { return readFileSync(logOf(dataDir, agent), 'utf-8').replace(ANSI, ''); } catch { return ''; }
  }

  function start(r) {
    if (!existsSync(r.dir) || !statSync(r.dir).isDirectory()) return `there's no folder ${r.dir} on this box`;
    mkdirSync(pathJoin(dataDir, 'remotes'), { recursive: true, mode: 0o700 });
    // A unit left from before (failed, or stopped): cleared so the name is free.
    run(systemctl(env), ['--user', 'reset-failed', unitOf(r.agent)]);
    const out = logOf(dataDir, r.agent);
    const res = run(systemdRun(env), ['--user', `--unit=${unitOf(r.agent)}`, '--collect', '--quiet',
      `--property=WorkingDirectory=${r.dir}`, `--property=StandardOutput=truncate:${out}`, `--property=StandardError=append:${out}`,
      '--', 'env', '-u', 'CLAUDE_CODE_OAUTH_TOKEN', '-u', 'ANTHROPIC_API_KEY',
      claudeBin(env), 'remote-control', '--name', r.name, '--permission-mode', 'bypassPermissions']);
    if (res.status !== 0) return `systemd-run: ${(res.stderr || res.error?.message || '').trim().split('\n').pop()}`;
    return null;
  }

  return async function sync(remotes = []) {
    for (const r of remotes) {
      const a = active(r.agent);
      const up = a === 'active' || a === 'activating';
      if (r.want === 'down') {
        if (up) run(systemctl(env), ['--user', 'stop', unitOf(r.agent)]);
        tried.delete(r.agent);
        if (r.state !== 'stopped') await tell(r.agent, 'stopped');
        continue;
      }
      if (up) {
        const links = output(r.agent).match(LINK);
        await tell(r.agent, links ? 'running' : 'starting', links ? { url: links[links.length - 1] } : {});
        continue;
      }
      // Wanted up and not running: it never started, or it ended. Start it, at most once a minute.
      const last = tried.get(r.agent);
      if (last && Date.now() - last < RETRY_MS) continue;
      if (last) {
        const why = output(r.agent).split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' · ').slice(0, 300);
        await tell(r.agent, 'failed', { error: why || 'it ended' });
      }
      tried.set(r.agent, Date.now());
      const err = start(r);
      if (err) { await tell(r.agent, 'failed', { error: err }); log(`box session ${r.agent}: ${err}`); continue; }
      log(`box session ${r.agent}: started in ${r.dir}`);
      told.delete(r.agent);
      await tell(r.agent, 'starting');
    }
  };
}
