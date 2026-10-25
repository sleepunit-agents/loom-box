// The runtime's state on the control plane (the machine loom runs on): which
// boxes exist, which agents each may host, each agent's primary, how an
// agent's house is made, and every house asked for. One JSON file, 0600, in a
// 0700 directory; every change is read-modify-write under a lock and lands by
// rename, so a reader never sees half a file.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, chmodSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export const BOX_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const AGENT_NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class StateError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Where the control plane keeps its state: $LOOM_BOX_HOME, else ~/.config/loom-box. */
export function stateDir(env = process.env) {
  return env.LOOM_BOX_HOME || join(env.HOME || homedir(), '.config', 'loom-box');
}

/** The control plane's own box: named after this machine, unless LOOM_BOX_LOCAL_NAME says otherwise. */
export function localBoxName(env = process.env) {
  const n = (env.LOOM_BOX_LOCAL_NAME || hostname().split('.')[0] || 'local').toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return BOX_NAME.test(n) ? n : 'local';
}

function empty(env) {
  const local = localBoxName(env);
  return {
    v: 1,
    // The control plane is the first box (runtime.md, "Boxes" 1): it needs no
    // enrollment, may host anyone, and is everyone's primary until told otherwise.
    boxes: { [local]: { local: true, mayHost: '*', facts: [], created: new Date().toISOString() } },
    primaries: {},
    agents: {},
    houses: {},
    seq: 0,
  };
}

export function load(env = process.env) {
  const path = join(stateDir(env), 'state.json');
  if (!existsSync(path)) return empty(env);
  const st = statSync(path);
  if (st.mode & 0o077) throw new StateError(`${path} is readable by others; chmod 600 it`, 500);
  const s = JSON.parse(readFileSync(path, 'utf-8'));
  if (s?.v !== 1 || typeof s.boxes !== 'object') throw new StateError(`${path}: not a loom-box state file`, 500);
  for (const k of ['primaries', 'agents', 'houses']) s[k] ??= {};
  s.seq ??= 0;
  return s;
}

function save(env, s) {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, 'state.json');
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Run f(state) under the lock and save what it leaves. The lock is a file
 * holding the holder's pid; a holder that's gone is cleared, a live one is
 * waited for (5s), never broken.
 */
export function update(env, f) {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'state.lock');
  const deadline = Date.now() + 5000;
  let fd;
  for (;;) {
    try { fd = openSync(lock, 'wx', 0o600); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0;
      try { pid = Number(readFileSync(lock, 'utf-8')); } catch { /* raced with its removal */ }
      if (pid && !alive(pid)) { rmSync(lock, { force: true }); continue; }
      if (Date.now() > deadline) throw new StateError('the runtime state is locked by a running process; try again', 503);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    writeSync(fd, String(process.pid));
    const s = load(env);
    const out = f(s);
    save(env, s);
    return out;
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

/** A new house id: h-<n>, never reused. */
export function nextHouseId(s) {
  s.seq += 1;
  return `h-${s.seq}`;
}
