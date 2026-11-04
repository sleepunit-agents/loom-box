// The box's half of the runtime: a machine that calls home to loom, says what
// it has, and runs the houses it's given. It never reaches loom's stores and
// loom never reaches into it (runtime.md, "Boxes" 5): it polls, so a box
// behind NAT or on hotel wifi works the same.
//
// A house is a container, and only a container (house.mjs): the box checks
// out the agent's repo, reads its house file, builds the image (cached by the
// build context's git tree), and runs it with podman, with the house's own
// podman secrets (its agent:<agent> token and the secrets the control plane
// gave it), its own state and nested-container dirs, and the repo mirror
// read-only. No agent code runs on the box itself. When it ends, its secrets,
// clone and dirs go.
import { lastUpgrade, maybeUpgrade, ownCommit, ownPiece } from './version.mjs';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { pieceName } from './piece.mjs';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { arch, cpus, homedir, platform, totalmem } from 'node:os';
import { join as pathJoin } from 'node:path';
import { newProof } from './enroll.mjs';
import { BOX_NAME, stateDir } from './state.mjs';
import { containerName, missingSecrets, parseHouseFile, podmanSecret, runArgs, specFor } from './house.mjs';
import { PART_RAW, joinParts, partsOf } from './blobs.mjs';
import { boxSessions } from './remote.mjs';
import { sessionsBusy } from './busy.mjs';
import { bootInfo, SAMPLE_MS, unitSampler } from './watch.mjs';
import { harnessStatus, LOGIN_HARNESSES, loginDir, pruneLoginDir, startLogin, sweepCliContainers } from './logins.mjs';

/** How often a box asks its harness CLIs whether they're logged in (and at once after a login). */
export const STATUS_MS = 5 * 60_000;

export const POLL_MS = 15_000;
const STOP_GRACE_MS = 30_000;
const LOG_TAIL = 4000;

export class BoxError extends Error {}

const configPath = (env) => pathJoin(stateDir(env), 'box.json');
const credPath = (env) => pathJoin(stateDir(env), 'credential');
const podman = (env) => env.LOOM_BOX_PODMAN || 'podman';
const dataDir = (env) => env.LOOM_BOX_DATA || pathJoin(env.HOME || homedir(), '.local', 'share', 'loom-box');

function writePrivate(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Whether `run --local` runs the control plane's own box here. The box piece's
 * service runs `run --local` wherever the piece is installed; on a machine that
 * joined a loom (box.json) that's the join, not a second, empty control plane.
 */
export function runsLocal(env, wantLocal) {
  return !!wantLocal && !existsSync(configPath(env));
}

/**
 * How `run` runs here: 'joined' (box.json: this machine joined a loom), 'local'
 * (--local on loom's own machine: it has a household), or 'unjoined' (--local on
 * a machine that's neither: the piece's service was installed before `loom box
 * join`, and it waits rather than becoming a second control plane).
 */
export function runMode(env, wantLocal) {
  if (existsSync(configPath(env))) return 'joined';
  if (!wantLocal) return 'joined';
  const home = env.LOOM_HOME || pathJoin(env.HOME || homedir(), '.config', 'loom');
  return existsSync(pathJoin(home, 'household.json')) ? 'local' : 'unjoined';
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
export const CDI_SPECS = ['/etc/cdi/nvidia.yaml', '/var/run/cdi/nvidia.yaml', '/etc/cdi/nvidia.json', '/var/run/cdi/nvidia.json'];

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
  // NVIDIA's CDI spec (nvidia-ctk cdi generate): what lets podman hand a house the GPU (t-1616).
  if (CDI_SPECS.some((p) => existsSync(p))) facts.add('cdi:nvidia');
  for (const l of labels) facts.add(l);
  return [...facts].filter((f) => /^[a-z][a-z0-9-]{0,31}(:[A-Za-z0-9._ +-]{1,64})?$/.test(f)).slice(0, 32);
}

/**
 * A client for the control plane over loom's piece API, at /api/<piece>/…: the name the box joined under (box.json
 * `piece`), and for a box that joined before the runtime had its new name, `box`, which its credential's role names.
 */
export function remoteClient(url, credential, fetchImpl = fetch, piece = 'box') {
  const base = url.replace(/\/+$/, '');
  return {
    async call(path, body = {}) {
      const r = await fetchImpl(`${base}/api/${piece}/${path}`, {
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
/**
 * Join by asking (t-1617): no credential to carry. The box asks loom (a stranger's call,
 * no token), shows the code the owner's card shows, and waits for Let it in or Block;
 * let in, it picks up its credential (only with the proof it kept) and joins.
 */
export async function askToJoin(env, { url, name, labels = [] }, { fetchImpl = fetch, say = (m) => process.stderr.write(m + '\n'), every = 5000, until = 15 * 60_000 } = {}) {
  if (!/^https?:\/\/[^\s]+$/.test(url ?? '')) throw new BoxError('join takes the URL of a loom, like https://loom.example.com');
  if (!BOX_NAME.test(name ?? '')) throw new BoxError('--name is the box\'s name: lowercase letters, digits, dots, dashes and underscores');
  const base = url.replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
  const post = async (path, body) => {
    let r;
    try {
      r = await fetchImpl(`${base}/api/${pieceName(env)}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (err) { throw Object.assign(new BoxError(`can't reach ${base}: ${err.message}`), { transient: true }); }
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new BoxError(out.error ?? `${r.status} ${r.statusText}`), { transient: r.status >= 500 });
    return out;
  };
  const { proof, proofHash } = newProof();
  const asked = await post('join-request', { name, labels, facts: detectFacts(env, labels), proof_hash: proofHash });
  say(`Asked ${base} to let ${asked.name} in. On loom's page (Home), a card shows code ${asked.code}: let it in only if it matches this one. Waiting…`);
  const end = Date.now() + until;
  for (;;) {
    await new Promise((r) => setTimeout(r, every));
    // loom restarting or unreachable for a moment isn't an answer: keep asking until the request expires.
    let p;
    try { p = await post('join-poll', { id: asked.id, proof }); } catch (err) {
      if (!err.transient) throw err;
      if (Date.now() > end) throw new BoxError(`loom stopped answering (${err.message}); ask again`);
      continue;
    }
    if (p.state === 'allowed') return joinLoom(env, { url: base, name: p.name, labels, credential: p.credential }, fetchImpl);
    if (p.state === 'blocked') throw new BoxError('the owner blocked this box');
    if (p.state === 'gone') throw new BoxError('the request expired or was answered elsewhere; ask again');
    if (Date.now() > end) throw new BoxError('nobody answered within 15 minutes; ask again');
  }
}

export async function joinLoom(env, { url, name, labels = [], credential }, fetchImpl = fetch) {
  if (!/^https?:\/\/[^\s]+$/.test(url ?? '')) throw new BoxError('join takes the URL of a loom, like https://loom.example.com');
  if (!BOX_NAME.test(name ?? '')) throw new BoxError('--name is the box\'s name, as the owner added it');
  const cred = (credential ?? '').trim();
  if (!/^loom_[A-Za-z0-9_-]{20,}$/.test(cred)) throw new BoxError('that isn\'t a loom credential (it starts with loom_)');
  const client = remoteClient(url, cred, fetchImpl, pieceName(env));
  const hi = await client.call('hello', { facts: detectFacts(env, labels) });
  // The box's name is only what it's called; loom knows it by its id (an old box: the name is the id).
  if (hi.box !== name && hi.name !== name) throw new BoxError(`that credential is ${hi.name ?? hi.box}'s, not ${name}'s`);
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writePrivate(credPath(env), cred + '\n');
  writePrivate(configPath(env), JSON.stringify({ url, name, id: hi.box, labels, piece: pieceName(env) }, null, 2) + '\n');
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
  const { mirror } = syncMirror(env, house, workdir, repoAuth, (gitEnv, m) => git(['clone', '-q', ...(house.branch ? ['--branch', house.branch] : []), m, pathJoin(workdir, 'repo')], { env: gitEnv }));
  return { repo: realpathSync(pathJoin(workdir, 'repo')), mirror };
}

/**
 * The box's mirror of an agent's repo, fetched (or cloned) now, with the repo's secret if it has one; `then` runs with
 * git's environment while the secret's helper is still there.
 */
function syncMirror(env, house, workdir, repoAuth, then = () => {}) {
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
    then(gitEnv, mirror);
  } finally {
    if (askpass) { rmSync(askpass, { force: true }); rmSync(pathJoin(workdir, '.repo-auth'), { force: true }); }
  }
  return { mirror, gitEnv };
}

/** A path inside the clone, or an error: a symlink can't point a build outside it. */
function inside(repo, rel, what) {
  const p = pathJoin(repo, rel);
  if (!existsSync(p)) throw new BoxError(`the repo has no ${rel} (${what})`);
  const real = realpathSync(p);
  if (real !== repo && !real.startsWith(repo + '/')) throw new BoxError(`${rel} points outside the repo`);
  return real;
}

function pod(env, args, opts = {}) {
  const r = spawnSync(podman(env), args, { env: { PATH: env.PATH, HOME: env.HOME, ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}) }, encoding: 'utf-8', timeout: 3_600_000, ...opts });
  if (r.error) throw new BoxError(`podman: ${r.error.message}`);
  return r;
}

/**
 * The image tag a house of `agent` gets from the repo (a clone, or the box's mirror) at `ref`: the git tree of its
 * build context and the blob of its Containerfile. The same for a clone at HEAD and for the mirror at the branch the
 * clone checks out, so a check (buildNow) names the image the next house would build, without building it.
 */
export function buildTagAt(repo, ref, agent, build) {
  const rev = (spec) => {
    const r = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '-q', spec], { encoding: 'utf-8' });
    if (r.status !== 0) throw new BoxError(`git rev-parse ${spec}: ${(r.stderr || '').trim() || 'no such path'}`);
    return r.stdout.trim();
  };
  return `loom-house-${agent}:${rev(`${ref}:${build.context}`).slice(0, 12)}${rev(`${ref}:${build.containerfile}`).slice(0, 8)}`;
}

/**
 * The image an agent's next house would be built from, worked out on the box's mirror of its repo (fetched now) and
 * not built: its house file at the branch's head, then its build's tag (buildTagAt). `c` is build-check's answer.
 */
export function buildNow(env, c) {
  const work = pathJoin(dataDir(env), 'build-check', c.agent);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    const { mirror } = syncMirror(env, { agent: c.agent, repo: c.repo }, work, c.repoAuth);
    const ref = c.branch ? `refs/heads/${c.branch}` : 'HEAD';
    const shown = spawnSync('git', ['-C', mirror, 'show', `${ref}:${c.houseFile || 'house/house.json'}`], { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 });
    if (shown.status !== 0) throw new BoxError(`the repo has no ${c.houseFile} at ${ref}`);
    return buildTagAt(mirror, ref, c.agent, parseHouseFile(shown.stdout).build);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The image a running house's container was made from, as box.mjs tags it (podman's localhost/ dropped): else null. */
function imageOf(env, id) {
  const r = pod(env, ['inspect', '--format', '{{.ImageName}}', containerName(id)]);
  const m = r.status === 0 ? /^(?:localhost\/)?(loom-house-[a-z][a-z0-9-]*:[0-9a-f]{20})$/.exec(r.stdout.trim()) : null;
  return m ? m[1] : null;
}

/**
 * The house's image: built from its Containerfile, tagged by the git tree of
 * its build context and the Containerfile's blob, so an unchanged house file
 * reuses the image and any change builds a new one.
 */
function image(env, h, house, repo, logFd) {
  const ctx = inside(repo, house.build.context, 'build context');
  const cf = inside(repo, house.build.containerfile, 'Containerfile');
  const tag = buildTagAt(repo, 'HEAD', h.agent, house.build);
  if (pod(env, ['image', 'exists', tag]).status === 0) return tag;
  const b = pod(env, ['build', '-t', tag, '-f', cf, ctx], { stdio: ['ignore', logFd, logFd] });
  if (b.status !== 0) throw new BoxError(`the image didn't build (exit ${b.status}); see the house log`);
  return tag;
}

/**
 * A service's state travels through loom as base64 of a gzipped tar. Restored
 * into a fresh dir with no symlinks left in it (a tarball from a compromised
 * box can't point the next house, or this box, anywhere else).
 */
const MAX_STATE_UNPACKED = 64 * 1024 * 1024;
const MAX_STATE_ENTRIES = 10_000;

export function restoreState(dir, packed) {
  if (!packed) return;
  // Unpacked here, not by tar: decompressed with a hard cap (a small tarball
  // can't fill the disk), every header checked (ustar magic and checksum,
  // octal sizes, plain files and directories only, no absolute or ".." names,
  // nothing after the end), and only what passed is written, by this code, as
  // files and directories it creates itself. No links can come out of it.
  let tar;
  try {
    tar = gunzipSync(Buffer.isBuffer(packed) ? packed : Buffer.from(packed, 'base64'), { maxOutputLength: MAX_STATE_UNPACKED });
  } catch {
    throw new BoxError('the service\'s saved state is too big to unpack, or isn\'t a gzipped tarball');
  }
  const bad = (why) => { throw new BoxError(`the service's saved state was refused: ${why}`); };
  const root = realpathSync(dir);
  const entries = [];
  let off = 0;
  for (;;) {
    if (off + 512 > tar.length) bad('it ends mid-header');
    const hdr = tar.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) {
      // The end: two zero blocks, then nothing but zeros.
      if (tar.subarray(off).some((b) => b !== 0)) bad('there is data after its end');
      break;
    }
    if (entries.length >= MAX_STATE_ENTRIES) bad('too many entries');
    const text = (a, n) => hdr.subarray(a, a + n).toString('latin1');
    const field = (a, n) => text(a, n).replace(/\0[\s\S]*$/, '');
    if (text(257, 6) !== 'ustar\0' && text(257, 6) !== 'ustar ') bad('a header isn\'t ustar');
    const octal = (a, n, what) => {
      const v = field(a, n).trim();
      if (!/^[0-7]+$/.test(v)) bad(`a header's ${what} isn't octal`);
      return parseInt(v, 8);
    };
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : hdr[i];
    if (octal(148, 8, 'checksum') !== sum) bad('a header\'s checksum is wrong');
    const type = String.fromCharCode(hdr[156] || 48);
    const size = octal(124, 12, 'size');
    const prefix = field(345, 155);
    const name = (prefix ? `${prefix}/` : '') + field(0, 100);
    if (type !== '0' && type !== '5') bad('it holds something other than plain files and directories');
    if (type === '5' && size !== 0) bad('a directory has a size');
    const parts = name.split('/').filter((p) => p !== '' && p !== '.');
    if (name.startsWith('/') || parts.includes('..') || parts.some((p) => /[\0]/.test(p))) bad(`${name} is outside its dir`);
    const dataEnd = off + 512 + size;
    if (dataEnd > tar.length) bad('a file runs past its end');
    entries.push({ type, parts, data: tar.subarray(off + 512, dataEnd) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  for (const e of entries) {
    if (!e.parts.length) continue; // "./" itself
    const target = pathJoin(root, ...e.parts);
    if (!target.startsWith(root + '/')) bad('a path escapes its dir');
    if (e.type === '5') { mkdirSync(target, { recursive: true, mode: 0o700 }); continue; }
    mkdirSync(pathJoin(target, '..'), { recursive: true, mode: 0o700 });
    // wx: never through, or over, something already there.
    writeFileSync(target, e.data, { mode: 0o600, flag: 'wx' });
  }
}

export function packState(dir) {
  // ustar, and only plain files and directories: what restoreState accepts. A
  // link a tool leaves in the mount (mise's tracked-configs) is left out, not
  // saved into a state the next house would refuse.
  const names = spawnSync('find', ['.', '(', '-type', 'f', '-o', '-type', 'd', ')', '-print0'], { cwd: dir, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  if (names.status !== 0) return null;
  const r = spawnSync('tar', ['--format=ustar', '-C', dir, '--null', '--no-recursion', '-T', '-', '-czf', '-'],
    { input: names.stdout, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  if (r.status !== 0) return null;
  return r.stdout;
}

/** A service's saved state, fetched a part at a time after its claim, and checked whole. */
async function fetchState(client, id, shape) {
  if (!shape) return null;
  const chunks = [];
  for (let part = 0; part < shape.parts; part++) {
    const r = await client.call('state-part', { id, part });
    chunks.push(Buffer.from(r.data, 'base64'));
  }
  return joinParts(chunks, shape);
}

/** A service's state back to loom, a part at a time; the last part makes it the one the next house gets. */
async function sendState(client, id, packed) {
  const parts = partsOf(packed.length);
  for (let part = 0; part < parts; part++) {
    const state = packed.subarray(part * PART_RAW, (part + 1) * PART_RAW).toString('base64');
    await client.call('save-state', { id, part, parts, state });
  }
}

function rootless(env) {
  const r = pod(env, ['info', '--format', '{{.Host.Security.Rootless}}']);
  return r.status === 0 && r.stdout.trim() === 'true';
}

/**
 * The run loop: poll, start what's wanted, stop what's asked, report how each
 * house went. `client` is the control plane (remote over HTTP, or in-process
 * on loom's own machine); `loomUrl` is what a house is told loom is.
 */
export function runner(env, client, { loomUrl, labels = [], log = (m) => process.stderr.write(`loom-box: ${m}\n`), hasSocket = (p) => existsSync(p), hasCdi = () => CDI_SPECS.some((p) => existsSync(p)), upgrade = maybeUpgrade,
  status = (agents) => harnessStatus(env, { agents }), login = (h, o) => startLogin(env, h, o), codexUsage = () => null, clock = () => Date.now(), secureChannel = true,
  sweep = () => sweepCliContainers(env), runtime = () => ({ commit: ownCommit(), piece: ownPiece() }),
  buildOf = (c) => buildNow(env, c), houseImage = (id) => imageOf(env, id), sampleUnits: unitsImpl = undefined, bootInfo: bootImpl = undefined }) {
  const houses = new Map(); // id -> { child, dir, stopAt? }
  // This runner, as the control plane tells it from one before it: a login handed to another run is one a restart
  // dropped (control.mjs, settleLogins).
  const run = randomBytes(6).toString('hex');
  let swept = false;
  // The harness CLIs' own word on their logins, asked every STATUS_MS (and after a login), not every poll.
  let harnesses = null;
  let asked = 0;
  const logins = new Map(); // login id -> the CLI's login under way
  let loginAgents = null; // per harness, the agents the control plane says may use this box's login (its last poll)
  function harnessesNow(force) {
    // Not before the first poll: the CLI runs in an image of an agent the control plane names.
    if (!loginAgents) return harnesses;
    if (force || !harnesses || clock() - asked >= STATUS_MS) {
      try { harnesses = status(loginAgents); } catch (e) { log(`harness status: ${e.message}`); }
      asked = clock();
    }
    return harnesses;
  }
  /** The owner's logins for this box: start the CLI's own, hand it a pasted code, or cancel it. */
  function onLogins(want) {
    for (const l of want ?? []) {
      const have = logins.get(l.id);
      if (l.state === 'cancel') { have?.cancel(); continue; }
      if (have) { if (l.code) have.code?.(l.code); continue; }
      if (l.state !== 'wanted' || !LOGIN_HARNESSES[l.harness]) continue;
      // A pasted code would cross this box's channel to loom: not over plain HTTP outside the tailnet.
      if (!secureChannel) {
        client.call('login-report', { id: l.id, state: 'failed', error: 'this box reaches loom over plain HTTP, outside the tailnet: a login needs HTTPS or the tailnet (loom box join with an https:// or tailnet URL)' }).catch(() => {});
        continue;
      }
      log(`logging in ${l.harness} (the owner asked, from loom's page)`);
      const report = (st) => {
        const last = st.state !== 'waiting';
        if (last) log(`${l.harness} login: ${st.state}${st.error ? ` (${st.error})` : ''}`);
        const hs = last ? harnessesNow(true) : undefined;
        // Still this box's until its last word has landed: a poll between would say it's gone (control.mjs).
        return client.call('login-report', { id: l.id, ...st, kind: LOGIN_HARNESSES[l.harness].kind, ...(hs ? { harnesses: hs } : {}) })
          .catch((e) => log(`login-report ${l.id}: ${e.message}`))
          .finally(() => { if (last) logins.delete(l.id); });
      };
      logins.set(l.id, { starting: true });
      try { logins.set(l.id, login(l.harness, { say: report, agents: loginAgents?.[l.harness] ?? [], id: l.id })); } catch (e) { report({ state: 'failed', error: e.message }); }
    }
  }
  const sessions = boxSessions(env, client, { dataDir: dataDir(env), log });

  // Its warm body hosts' agents' repos, checked for a newer image: each house when it's first seen here (its own image
  // too, if the control plane doesn't know it: one adopted after a restart), then each agent at the harness status's
  // pace (STATUS_MS). Only the tag is worked out; nothing is built.
  const checked = new Set(); // house ids checked
  const agentAt = new Map(); // agent -> when its repo was last checked
  async function checkBuilds(hosts) {
    if (!Array.isArray(hosts)) return;
    const live = new Set(hosts.map((x) => x?.id));
    for (const id of [...checked]) if (!live.has(id)) checked.delete(id);
    const round = new Map(); // agent -> its current build, this round
    for (const x of hosts.slice(0, 16)) {
      if (!x || typeof x.id !== 'string' || typeof x.agent !== 'string') continue;
      const due = clock() - (agentAt.get(x.agent) ?? -Infinity) >= STATUS_MS || (!x.known && !checked.has(x.id)) || round.has(x.agent);
      if (!due) continue;
      try {
        const c = await client.call('build-check', { id: x.id });
        const house = c.known ? null : houseImage(x.id);
        // A house from before its claim kept how it was made: only its own image (control.mjs, buildCheck).
        let current = c.check === false ? null : round.get(x.agent);
        if (current === undefined) {
          current = null;
          try { current = buildOf(c); } catch (e) { log(`checking ${x.agent}'s image: ${e.message}`); }
          round.set(x.agent, current);
          agentAt.set(x.agent, clock());
        }
        if (house || current) {
          const r = await client.call('build-report', { id: x.id, ...(house ? { house } : {}), ...(current ? { current } : {}) });
          if (r?.outdated) log(`${x.id} runs ${r.build}, older than ${x.agent}'s ${r.current}: it drains (no new bodies), then idles out`);
        }
        checked.add(x.id);
      } catch (e) {
        // Not again before its pace (an older control plane has no build-check; a secret that couldn't be had).
        checked.add(x.id);
        agentAt.set(x.agent, clock());
        log(`build check for ${x.id}: ${e.message}`);
      }
    }
  }

  /** Everything a house leaves behind but its log. */
  function clean(h, dir, secretNames) {
    if (secretNames.length) pod(env, ['secret', 'rm', ...secretNames.map((n) => podmanSecret(h.id, n))]);
    for (const d of ['repo', 'state', 'nested']) {
      const p = pathJoin(dir, d);
      if (!existsSync(p)) continue;
      // Nested storage holds files owned by the container's subordinate ids.
      if (pod(env, ['unshare', 'rm', '-rf', p]).status !== 0) rmSync(p, { recursive: true, force: true });
    }
  }

  async function start(h) {
    const dir = pathJoin(dataDir(env), 'houses', h.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let claimed;
    try {
      claimed = await client.call('claim', { id: h.id });
    } catch (err) {
      log(`couldn't claim ${h.id}: ${err.message}`);
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    let made = [];
    try {
      const logFd = openSync(pathJoin(dir, 'log'), 'a', 0o600);
      const { repo, mirror } = checkout(env, h, dir, claimed.repoAuth);
      const house = specFor(parseHouseFile(readFileSync(inside(repo, h.houseFile || 'house/house.json', 'house file'), 'utf-8')), h.service);
      // Every house gets its own loom token; the rest are what the control plane chose.
      const given = { ...(claimed.secrets || {}), 'loom-token': claimed.token };
      const missing = missingSecrets(house, given);
      if (missing.length) throw new BoxError(`the house file wants ${missing.join(', ')}, which ${h.agent}'s houses don't get`);
      if (house.nested && !rootless(env)) throw new BoxError('nested containers need rootless podman on the box');
      if (h.gpu && !claimed.gpu) throw new BoxError(`the house needs the GPU, and the owner hasn't allowed ${h.agent}'s houses a GPU (loom box agent ${h.agent} … --gpu, or the agent's page)`);
      if (h.gpu && !hasCdi()) throw new BoxError('the house needs the GPU, and this box has no NVIDIA CDI spec: run `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml` (nvidia-container-toolkit) once, then try again');
      const tag = image(env, h, house, repo, logFd);
      // The box's own logins the house wants: each must be logged in here (the box's report, as of its claim). Checked
      // after the image is built, so a first house leaves an image the box can run its own login in (logins.mjs).
      const notIn = (house.logins ?? []).filter((l) => !(claimed.logins ?? []).includes(l));
      if (notIn.length) throw new BoxError(`this box has no ${notIn.map((l) => LOGIN_HARNESSES[l].label).join(' or ')} login for ${h.agent}'s houses: log it in from its page (Boxes, Log in), on a box ${h.agent}'s owner owns, with the login granted to ${h.agent}`);
      // Only the logins the claim names (logged in here, granted, and this box its agent's owner's): checked above,
      // and again here, so nothing else of the box's is ever mounted.
      const dirs = { mirror, logins: Object.fromEntries((house.logins ?? []).filter((l) => (claimed.logins ?? []).includes(l)).map((l) => {
        // A house can write a login dir: before it's mounted again, it's cut down to its allowlist and checked (logins.mjs).
        const bad = pruneLoginDir(loginDir(env, l), l);
        if (bad) throw new BoxError(`this box's ${LOGIN_HARNESSES[l].label} login dir isn't safe to mount: ${bad}`);
        return [l, loginDir(env, l)];
      })) };
      for (const d of ['state', 'nested']) { dirs[d] = pathJoin(dir, d); mkdirSync(dirs[d], { mode: 0o700 }); }
      if (h.service || h.slot) restoreState(dirs.state, await fetchState(client, h.id, claimed.state));
      // A session house: what attaching to it runs, for `loom box attach` on this box.
      if (h.session) writeFileSync(pathJoin(dir, 'attach.json'), JSON.stringify({ container: containerName(h.id), command: house.attach ?? ['sh'] }), { mode: 0o600 });
      const args = runArgs(house, { id: h.id, agent: h.agent, loomUrl, task: h.task, service: h.service, session: !!h.session, image: tag, dirs, allowNested: !!claimed.nested, allowPorts: claimed.ports ?? [], allowTailnets: claimed.tailnets ?? [],
        hasSocket, gpu: !!h.gpu && !!claimed.gpu,
        skipped: (name, socket) => { writeSync(logFd, `loom-box: this box has no ${name} tailnet (${socket}); the house starts without it\n`); log(`${h.id}: no ${name} tailnet on this box; starting without it`); } });
      // The house's own podman secrets, each value on stdin (never argv).
      for (const name of Object.keys(house.secrets)) {
        // podman reads `-` only from a real pipe (node hands a child a socket),
        // so the value goes through cat: still stdin only, never argv or disk.
        const r = spawnSync('sh', ['-c', 'cat | exec "$0" secret create --replace "$1" -', podman(env), podmanSecret(h.id, name)], {
          input: given[name], encoding: 'utf-8', timeout: 60_000,
          env: { PATH: env.PATH, HOME: env.HOME, ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}) },
        });
        if (r.status !== 0) throw new BoxError(`couldn't make the house's ${name} secret: ${(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`}`);
        made.push(name);
      }
      // The repo was only needed to build: the house clones what it wants itself.
      rmSync(pathJoin(dir, 'repo'), { recursive: true, force: true });
      const child = spawn(podman(env), args, {
        detached: true,
        stdio: [house.task === 'stdin' ? 'pipe' : 'ignore', logFd, logFd],
        env: { PATH: env.PATH, HOME: env.HOME, ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}) },
      });
      closeSync(logFd);
      if (house.task === 'stdin') { child.stdin.on('error', () => {}); child.stdin.end(h.task); }
      const secretNames = made;
      made = [];
      houses.set(h.id, { child, dir });
      log(`started ${h.id} (${h.agent})`);
      // With the image it runs: the control plane drains a body host's house on an older one (houserunner.mjs).
      await client.call('report', { id: h.id, state: 'running', build: tag }).catch((e) => log(`report ${h.id}: ${e.message}`));
      child.on('exit', (code, signal) => ended(h, dir, secretNames, code, signal));
    } catch (err) {
      clean(h, dir, made);
      log(`${h.id} failed to start: ${err.message}`);
      // The build's own output is in the house log: send its end along with why.
      const out = tail(pathJoin(dir, 'log'));
      await client.call('report', { id: h.id, state: 'failed', log: `the box couldn't start it: ${err.message}${out ? `\n${out}` : ''}` }).catch(() => {});
    }
  }

  /** A house is over: a service's state goes back first, then its secrets and dirs, then the report. */
  async function ended(h, dir, secretNames, code, signal) {
    const entry = houses.get(h.id);
    houses.delete(h.id);
    // A service's state goes back to loom before anything else knows it stopped,
    // so the next box (a move, or a restart) picks up where this one left off.
    // (An adopted house's kind isn't known here: loom keeps state only for a service's.)
    if (h.service || h.slot || entry?.adopted) {
      const packed = existsSync(pathJoin(dir, 'state')) ? packState(pathJoin(dir, 'state')) : null;
      if (packed !== null) {
        await sendState(client, h.id, packed).catch((e) => { if (h.service || h.slot) log(`couldn't save ${h.service ?? h.slot}'s state: ${e.message}`); });
      }
    }
    if (entry?.adopted) pod(env, ['rm', '-f', containerName(h.id)]);
    clean(h, dir, secretNames);
    const state = entry?.stopAt ? 'stopped' : code === 0 ? 'done' : 'failed';
    log(`${h.id} ${state} (${signal ?? `exit ${code}`})`);
    client.call('report', { id: h.id, state, exit: code ?? -1, log: tail(pathJoin(dir, 'log')) }).catch((e) => log(`report ${h.id}: ${e.message}`));
  }

  /**
   * A house that's still running from before this box restarted (a deploy, the
   * runner crashing): watched again, not bounced. `podman wait` says when it
   * ends, and it ends the way any house does.
   */
  function adopt(id) {
    const dir = pathJoin(dataDir(env), 'houses', id);
    const ls = pod(env, ['secret', 'ls', '--format', '{{.Name}}']);
    const secretNames = (ls.stdout || '').split('\n').filter((n) => n.startsWith(`loom-${id}-`)).map((n) => n.slice(`loom-${id}-`.length));
    const child = spawn(podman(env), ['wait', containerName(id)], {
      detached: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: env.PATH, HOME: env.HOME, ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}) },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    houses.set(id, { child, dir, adopted: true });
    child.on('exit', () => {
      const code = /^-?\d+/.test(out.trim()) ? Number(out.trim().split('\n').pop()) : null;
      ended({ id }, dir, secretNames, code, null);
    });
    log(`adopted ${id}: still running from before this box restarted`);
  }

  function stop(id) {
    const e = houses.get(id);
    if (!e || e.stopAt) return;
    e.stopAt = Date.now();
    // podman stop reaches the container itself; the signal, the podman client.
    spawn(podman(env), ['stop', '-t', '25', containerName(id)], { stdio: 'ignore', env: { PATH: env.PATH, HOME: env.HOME, ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}) } }).on('error', () => {});
    // An adopted house's child is only `podman wait`: it ends when the container does.
    if (e.adopted) return;
    try { process.kill(-e.child.pid, 'SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-e.child.pid, 'SIGKILL'); } catch { /* gone */ } }, STOP_GRACE_MS).unref();
  }

  /**
   * This box's own process going down (systemd restarting it, a deploy): every
   * house still tracked gets the same per-house `stop(id)` a manual `down`
   * reaches, and this waits for them rather than leaving the caller to exit out
   * from under them — t-1498, `podman stop -t 25` never ran on a bare SIGTERM,
   * so a container whose PID 1 ignores SIGTERM (no handler) never exited, and
   * systemd's own stop timeout fired instead. A box can't tell the control
   * plane a house is "stopping" (that's the owner's or agent's `down` to ask
   * for); it can only make podman actually stop the container, so the house's
   * own report of this still lands as its control-plane state allows (usually
   * "failed" on the next poll, the same outcome this restart already produced
   * before systemd's own timeout forced it) — stopping the container fast and
   * cleanly, well under systemd's stop timeout, is the whole of this fix.
   * A little past every house's own grace period, in case the last one's
   * SIGKILL fallback is still landing.
   */
  /**
   * This runner going (a restart, an update): no login outlives it (its pty goes with it), so each one under way
   * is cancelled, its container stopped, and loom told why, before the process ends.
   */
  async function endLogins(why = 'the runtime restarted during the sign-in; start again') {
    const ending = [];
    for (const [id, l] of logins) {
      if (!l.cancel || l.over) continue;
      ending.push(id);
      l.cancel(why);
    }
    const until = Date.now() + 5_000;
    while (ending.some((id) => logins.has(id)) && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
  }

  async function shutdown() {
    await endLogins();
    for (const id of houses.keys()) stop(id);
    const until = Date.now() + STOP_GRACE_MS + 5_000;
    while (houses.size && Date.now() < until) await new Promise((res) => setTimeout(res, 200));
  }

  // Keeping watch (watch.mjs): this boot on every poll; the units, sampled once a minute and sent with the next poll.
  const sampleUnits = unitsImpl ?? unitSampler(env);
  const readBoot = bootImpl ?? (() => bootInfo());
  // The units' sample runs beside the polls (a wedged journal never holds one up) and goes with the first poll after.
  let unitsAt = 0, unitsDone = null, unitsBusy = false;
  function watchReport() {
    const out = {};
    try { const b = readBoot(); if (b) out.boot = b; } catch { /* left out */ }
    if (unitsDone) { out.units = unitsDone; unitsDone = null; }
    if (!unitsBusy && clock() - unitsAt >= SAMPLE_MS) {
      unitsAt = clock();
      unitsBusy = true;
      Promise.resolve().then(() => sampleUnits(clock())).then((u) => { unitsDone = u; }, (e) => log(`units: ${e.message}`)).finally(() => { unitsBusy = false; });
    }
    return out;
  }
  /** For a test: the units' sample under way, done. */
  async function settled() { while (unitsBusy) await new Promise((r) => setTimeout(r, 5)); }

  async function tick() {
    // Which remote sessions here are mid-turn (busy.mjs): loom shows it on the agents' cards (t-1624).
    let busy;
    try { busy = sessionsBusy(pathJoin(stateDir(env), 'session-cpu.json')); } catch { busy = undefined; }
    // A runner before this one may have left a login's container behind (it died mid-sign-in): those go, once.
    // Tried again each tick until podman answers once (null: it didn't).
    if (!swept) {
      let gone = null;
      try { gone = sweep(); } catch (e) { log(`sweep: ${e.message}`); }
      if (Array.isArray(gone)) { swept = true; if (gone.length) log(`stopped ${gone.length} sign-in container(s) a runner before this one left`); }
      else log('sweep: podman couldn\'t list the sign-in containers a runner before this one may have left; trying again next poll');
    }
    const hs = harnessesNow(false);
    let cx = null;
    try { cx = codexUsage(); } catch { cx = null; }
    // Which runtime this box runs, and how its last upgrade went (version.mjs): the box's page shows both.
    let rt = null;
    try { const r = runtime(); rt = { ...(r.commit ? { commit: r.commit } : {}), ...(r.piece ? { piece: r.piece } : {}) }; const u = lastUpgrade(stateDir(env), clock()); if (u) rt.upgrade = u; } catch { rt = null; }
    const want = await client.call('poll', { ...watchReport(), facts: detectFacts(env, labels), ...(busy ? { sessions: busy } : {}), ...(hs ? { harnesses: hs } : {}), ...(cx ? { usage: { codex: cx } } : {}),
      // The logins this runner has going: one loom handed out that isn't here was lost (control.mjs, settleLogins).
      loginsRunning: { run, ids: [...logins.keys()] }, ...(rt ? { runtime: rt } : {}) });
    if (want.loginAgents) {
      const first = !loginAgents;
      loginAgents = want.loginAgents;
      // The first poll told the box whose images it may run its CLI in: ask the CLI now, not in five minutes.
      if (first) { const hs2 = harnessesNow(true); if (hs2) await client.call('poll', { harnesses: hs2 }).catch((e) => log(`poll: ${e.message}`)); }
    }
    onLogins(want.logins);
    // The control plane thinks these are up here, but this box doesn't have them:
    // it restarted under them. Say so rather than leave them "running" forever.
    for (const id of want.active || []) {
      if (houses.has(id)) continue;
      // Still running: watch it again rather than bounce it.
      const running = pod(env, ['inspect', '--format', '{{.State.Running}}', containerName(id)]);
      if (running.status === 0 && running.stdout.trim() === 'true') { adopt(id); continue; }
      // Gone or dead. A service's house keeps what it had: stopped the way a move stops it
      // (so it can finish writing), and its state sent back before anything
      // of it goes. The control plane takes it only from a live service house.
      pod(env, ['stop', '-t', '25', containerName(id)]);
      const dir = pathJoin(dataDir(env), 'houses', id);
      const stateDir = pathJoin(dir, 'state');
      if (existsSync(stateDir)) {
        const packed = packState(stateDir);
        if (packed) await sendState(client, id, packed).catch((e) => log(`${id}: its state wasn't kept (${e.message})`));
      }
      // Whatever of it is still here goes: its container, its secrets, its dirs.
      pod(env, ['rm', '-f', containerName(id)]);
      clean({ id }, dir, []);
      rmSync(dir, { recursive: true, force: true });
      const ls = pod(env, ['secret', 'ls', '--format', '{{.Name}}']);
      const mine = (ls.stdout || '').split('\n').filter((n) => n.startsWith(`loom-${id}-`));
      if (mine.length) pod(env, ['secret', 'rm', ...mine]);
      const state = (want.stop || []).includes(id) ? 'stopped' : 'failed';
      await client.call('report', { id, state, log: 'the box no longer has this house (it restarted while the house was up)' })
        .catch((e) => log(`report ${id}: ${e.message}`));
    }
    for (const id of want.stop || []) stop(id);
    for (const h of want.start || []) if (!houses.has(h.id)) await start(h);
    await checkBuilds(want.bodyHosts);
    await sessions(want.remotes);
    // On another loom-box than loom's: install that one, between house starts (version.mjs).
    try {
      // Update now: the owner's token, carried into the attempt's record so loom knows it started (and stops asking).
      const did = upgrade({ want: want.version, starting: (want.start || []).length > 0, env, stateDir: stateDir(env), now: typeof want.upgradeNow === 'string' ? want.upgradeNow : false });
      if (did) log(did);
    } catch (e) { log(`upgrade: ${e.message}`); }
    return want;
  }

  return { tick, stop, houses, shutdown, endLogins, run, settled };
}

export { dataDir };
