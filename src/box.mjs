// The box's half of the runtime: a machine that calls home to loom, says what
// it has, and runs the houses it's given. It never reaches loom's stores and
// loom never reaches into it (runtime.md, "Boxes" 5): it polls, so a box
// behind NAT or on hotel wifi works the same.
//
// A house: the agent's repo checked out fresh, its house command run with
//   HOUSE_ID, HOUSE_AGENT, HOUSE_TASK  what to do
//   HOUSE_SECRETS_DIR                  loom-token (agent:<agent>, this house's
//                                      only) and the agent's house secrets, a
//                                      file each, 0600; removed when it ends
//   LOOM_URL                           where loom is (MCP)
// and its own process group, so stopping it takes everything it started.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, homedir, platform, totalmem } from 'node:os';
import { join as pathJoin } from 'node:path';
import { BOX_NAME, stateDir } from './state.mjs';

export const POLL_MS = 15_000;
const STOP_GRACE_MS = 30_000;
const LOG_TAIL = 4000;

export class BoxError extends Error {}

const configPath = (env) => pathJoin(stateDir(env), 'box.json');
const credPath = (env) => pathJoin(stateDir(env), 'credential');
const dataDir = (env) => env.LOOM_BOX_DATA || pathJoin(env.HOME || homedir(), '.local', 'share', 'loom-box');

function writePrivate(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadConfig(env) {
  const p = configPath(env);
  if (!existsSync(p)) throw new BoxError('this machine hasn\'t joined a loom: run `loom box join <url> --name <name>`');
  const c = JSON.parse(readFileSync(p, 'utf-8'));
  if (!c.url || !BOX_NAME.test(c.name ?? '')) throw new BoxError(`${p} is not a loom-box config`);
  return c;
}

function readCredential(env) {
  const p = credPath(env);
  const st = statSync(p);
  if (st.mode & 0o077) throw new BoxError(`${p} is readable by others; chmod 600 it`);
  return readFileSync(p, 'utf-8').trim();
}

/** What this box has, as facts: "arch:x86_64", "gpu:nvidia-geforce-rtx-5090", "runtime:podman". */
export function detectFacts(env = process.env, labels = []) {
  const facts = new Set([`os:${platform()}`, `arch:${arch() === 'x64' ? 'x86_64' : arch()}`, `cpus:${cpus().length}`, `mem:${Math.round(totalmem() / 2 ** 30)}g`]);
  for (const rt of ['podman', 'docker']) {
    if (spawnSync('sh', ['-c', `command -v ${rt}`], { env, stdio: 'ignore' }).status === 0) facts.add(`runtime:${rt}`);
  }
  const smi = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { env, encoding: 'utf-8', timeout: 5000 });
  if (smi.status === 0) {
    for (const line of smi.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      facts.add(`gpu:${line.toLowerCase().replace(/[^a-z0-9.+-]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)}`);
    }
  }
  for (const l of labels) facts.add(l);
  return [...facts].filter((f) => /^[a-z][a-z0-9-]{0,31}(:[A-Za-z0-9._ +-]{1,64})?$/.test(f)).slice(0, 32);
}

/** A client for the control plane over loom's piece API. */
export function remoteClient(url, credential, fetchImpl = fetch) {
  const base = url.replace(/\/+$/, '');
  return {
    async call(path, body = {}) {
      const r = await fetchImpl(`${base}/api/box/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: JSON.stringify(body),
      });
      let out;
      try { out = await r.json(); } catch { out = {}; }
      if (!r.ok) throw new BoxError(`${path}: ${r.status} ${out?.error ?? r.statusText}`);
      return out;
    },
  };
}

/** `loom box join <url> --name <name>`: keep the credential (0600) and say hello. */
export async function joinLoom(env, { url, name, labels = [], credential }, fetchImpl = fetch) {
  if (!/^https?:\/\/[^\s]+$/.test(url ?? '')) throw new BoxError('join takes the URL of a loom, like https://loom.example.com');
  if (!BOX_NAME.test(name ?? '')) throw new BoxError('--name is the box\'s name, as the owner added it');
  const cred = (credential ?? '').trim();
  if (!/^loom_[A-Za-z0-9_-]{20,}$/.test(cred)) throw new BoxError('that isn\'t a loom credential (it starts with loom_)');
  const client = remoteClient(url, cred, fetchImpl);
  const hi = await client.call('hello', { facts: detectFacts(env, labels) });
  if (hi.box !== name) throw new BoxError(`that credential is ${hi.box}'s, not ${name}'s`);
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writePrivate(credPath(env), cred + '\n');
  writePrivate(configPath(env), JSON.stringify({ url, name, labels }, null, 2) + '\n');
  return hi;
}

function tail(path) {
  try {
    const st = statSync(path);
    const fd = openSync(path, 'r');
    const n = Math.min(st.size, LOG_TAIL);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, st.size - n);
    closeSync(fd);
    return buf.toString('utf-8');
  } catch { return ''; }
}

function git(args, opts) {
  const r = spawnSync('git', args, { ...opts, encoding: 'utf-8', timeout: 600_000 });
  if (r.status !== 0) throw new BoxError(`git ${args[0]}: ${(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`}`);
}

/**
 * Check out the agent's repo for one house: a mirror per agent per box (the
 * box's cache, rebuilt from the repo whenever), and a fresh clone off it per
 * house, so houses never share a working tree.
 */
function checkout(env, house, workdir, repoAuth) {
  const mirrors = pathJoin(dataDir(env), 'repos');
  mkdirSync(mirrors, { recursive: true, mode: 0o700 });
  const mirror = pathJoin(mirrors, `${house.agent}.git`);
  const gitEnv = { PATH: env.PATH, HOME: env.HOME, GIT_TERMINAL_PROMPT: '0' };
  let askpass;
  if (repoAuth) {
    // The token never goes in argv or the URL: git asks a helper that reads it from a 0600 file.
    const tok = pathJoin(workdir, '.repo-auth');
    writePrivate(tok, repoAuth.trim());
    askpass = pathJoin(workdir, '.askpass');
    writeFileSync(askpass, `#!/bin/sh\ncase "$1" in Username*) echo x-access-token ;; *) cat '${tok}' ;; esac\n`, { mode: 0o700 });
    Object.assign(gitEnv, { GIT_ASKPASS: askpass });
  }
  const noHelper = ['-c', 'credential.helper='];
  try {
    if (existsSync(mirror)) git([...noHelper, '-C', mirror, 'remote', 'set-url', 'origin', house.repo], { env: gitEnv });
    if (existsSync(mirror)) git([...noHelper, '-C', mirror, 'fetch', '-q', '--prune', 'origin'], { env: gitEnv });
    else git([...noHelper, 'clone', '-q', '--mirror', house.repo, mirror], { env: gitEnv });
    git(['clone', '-q', ...(house.branch ? ['--branch', house.branch] : []), mirror, pathJoin(workdir, 'repo')], { env: gitEnv });
  } finally {
    if (askpass) { rmSync(askpass, { force: true }); rmSync(pathJoin(workdir, '.repo-auth'), { force: true }); }
  }
  const repo = realpathSync(pathJoin(workdir, 'repo'));
  const cmd = pathJoin(repo, house.houseCmd);
  if (!existsSync(cmd)) throw new BoxError(`${house.agent}'s repo has no ${house.houseCmd}`);
  const real = realpathSync(cmd);
  if (!real.startsWith(repo + '/')) throw new BoxError(`${house.houseCmd} points outside the repo`);
  return { repo, cmd: real };
}

/**
 * The run loop: poll, start what's wanted, stop what's asked, report how each
 * house went. `client` is the control plane (remote over HTTP, or in-process
 * on loom's own machine); `loomUrl` is what a house is told loom is.
 */
export function runner(env, client, { loomUrl, labels = [], log = (m) => process.stderr.write(`loom-box: ${m}\n`) }) {
  const houses = new Map(); // id -> { child, dir, stopAt? }

  async function start(h) {
    const dir = pathJoin(dataDir(env), 'houses', h.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const secretsDir = pathJoin(dir, 'secrets');
    let claimed;
    try {
      claimed = await client.call('claim', { id: h.id });
    } catch (err) {
      log(`couldn't claim ${h.id}: ${err.message}`);
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    try {
      mkdirSync(secretsDir, { mode: 0o700 });
      writePrivate(pathJoin(secretsDir, 'loom-token'), claimed.token + '\n');
      for (const [name, value] of Object.entries(claimed.secrets || {})) writePrivate(pathJoin(secretsDir, name), value);
      const { repo, cmd } = checkout(env, h, dir, claimed.repoAuth);
      const out = openSync(pathJoin(dir, 'log'), 'a', 0o600);
      const child = spawn(cmd, [], {
        cwd: repo,
        detached: true,
        stdio: ['ignore', out, out],
        env: {
          PATH: env.PATH, HOME: env.HOME, LANG: env.LANG || 'C.UTF-8',
          ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}),
          HOUSE_ID: h.id, HOUSE_AGENT: h.agent, HOUSE_TASK: h.task, HOUSE_SECRETS_DIR: secretsDir, LOOM_URL: loomUrl,
        },
      });
      closeSync(out);
      houses.set(h.id, { child, dir });
      log(`started ${h.id} (${h.agent})`);
      await client.call('report', { id: h.id, state: 'running' }).catch((e) => log(`report ${h.id}: ${e.message}`));
      child.on('exit', (code, signal) => {
        const entry = houses.get(h.id);
        houses.delete(h.id);
        rmSync(secretsDir, { recursive: true, force: true });
        rmSync(pathJoin(dir, 'repo'), { recursive: true, force: true });
        const state = entry?.stopAt ? 'stopped' : code === 0 ? 'done' : 'failed';
        log(`${h.id} ${state} (${signal ?? `exit ${code}`})`);
        client.call('report', { id: h.id, state, exit: code ?? -1, log: tail(pathJoin(dir, 'log')) }).catch((e) => log(`report ${h.id}: ${e.message}`));
      });
    } catch (err) {
      rmSync(secretsDir, { recursive: true, force: true });
      log(`${h.id} failed to start: ${err.message}`);
      await client.call('report', { id: h.id, state: 'failed', log: `the box couldn't start it: ${err.message}` }).catch(() => {});
    }
  }

  function stop(id) {
    const e = houses.get(id);
    if (!e || e.stopAt) return;
    e.stopAt = Date.now();
    try { process.kill(-e.child.pid, 'SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-e.child.pid, 'SIGKILL'); } catch { /* gone */ } }, STOP_GRACE_MS).unref();
  }

  async function tick() {
    const want = await client.call('poll', { facts: detectFacts(env, labels) });
    // The control plane thinks these are up here, but this box doesn't have them:
    // it restarted under them. Say so rather than leave them "running" forever.
    for (const id of want.active || []) {
      if (houses.has(id)) continue;
      const state = (want.stop || []).includes(id) ? 'stopped' : 'failed';
      await client.call('report', { id, state, log: 'the box no longer has this house (it restarted while the house was up)' })
        .catch((e) => log(`report ${id}: ${e.message}`));
    }
    for (const id of want.stop || []) stop(id);
    for (const h of want.start || []) if (!houses.has(h.id)) await start(h);
    return want;
  }

  return { tick, stop, houses };
}

export { dataDir };
