// The runtime's manifest from its delivery service, over a local socket (t-2114). Each `loom-runtime ui --json` was a
// node start that loaded the state, scanned delivery and listed the gates' proposals again; loom asks for it every few
// seconds while a page is open. The delivery service already runs all the time, so it answers instead: from memory,
// kept current after each of its ticks while loom is asking, and it tells core "moved" exactly when the manifest does.
//
// Where: $LOOM_PIECE_HOME/run/ui.sock. Core finds it the same way (the piece's home is core's to name, never a path
// the piece hands it), in a 0700 directory, the socket itself 0600: only this user reaches it. That user can run
// `loom-runtime ui --json` anyway, which reads the same files, so the socket gives nobody anything new.
//
// What: one request per line, {"id": n, "op": "manifest", "version": "<file>@<mtime>", "since": <ms>}; one answer per
// line, in order, {"id": n, "ok": true, "version": "<the cli.mjs this service runs>@<mtime>", "at": <ms>, "stdout":
// "<what ui --json prints>"}. Core compares `version` with what the piece's bin resolves to now, so an install never
// reads the old version's answer; only an ask for this version counts as loom reading the socket. `since`: computed
// again if the kept answer is older (core heard the piece moved, or an action ran). Nothing else is served: no page, no action, no API, and no grant ever travels here. The manifest is one
// answer for every viewer (it reads no scope); core narrows it per viewer as it does an answer from `ui --json`.
import { createServer, createConnection } from 'node:net';
import { chmodSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A request line longer than this is no request: the connection goes. */
export const MAX_LINE = 1024;
/** Connections at once (core keeps one; a few spare for a restart overlapping). */
export const MAX_CONNS = 8;
/** An answer older than this is computed again before it's given. */
export const STALE_MS = 20_000;
/** While loom asked within this long, each tick computes the manifest again, so an answer is always ready. */
export const ACTIVE_MS = 120_000;
/** A connection with nothing asked this long goes (core reconnects). */
export const IDLE_MS = 10 * 60_000;
/** However many asks want an answer newer than the kept one, at most one compute for them per this long. */
export const SINCE_MIN_MS = 250;
/** sun_path is 108 bytes on Linux; past this, no socket (loom keeps running `ui --json`). */
const MAX_PATH = 100;

/** What this service runs: the file and when it last changed, as core reads the piece's bin (piece-socket.ts, versionOf). */
const FILE = fileURLToPath(new URL('./cli.mjs', import.meta.url));
export const VERSION = `${FILE}@${statSync(FILE).mtimeMs}`;
/** A connection whose unread answers pass this goes: a client that asks and never reads can't fill the service's memory. */
export const MAX_UNREAD = 2 * 1024 * 1024;

/** Where the socket is: in the piece's own home, as core names it. null outside loom (no LOOM_PIECE_HOME). */
export function socketPath(env) {
  const home = typeof env?.LOOM_PIECE_HOME === 'string' ? env.LOOM_PIECE_HOME : '';
  if (!home.startsWith('/')) return null;
  const p = join(home, 'run', 'ui.sock');
  return Buffer.byteLength(p) <= MAX_PATH ? p : null;
}

/** The manifest as it's compared for "moved": without the idle observation's clock, which every computation renews. */
export function stablePrint(stdout) {
  try {
    const m = JSON.parse(stdout);
    for (const r of Object.values(m?.agents ?? {})) if (r && typeof r === 'object') delete r.idle;
    return JSON.stringify(m);
  } catch { return stdout; }
}

/** The run dir, ours and 0700, or an error: never a symlink or someone else's directory. */
function ownDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} isn't a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${dir} isn't this user's`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/** Whether a server already answers at `path` (another delivery service): then this one doesn't take it. */
function answering(path) {
  return new Promise((resolve) => {
    const c = createConnection(path);
    const done = (v) => { c.destroy(); resolve(v); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    setTimeout(() => done(false), 500).unref?.();
  });
}

/**
 * Serve the manifest at socketPath(env). `compute()` returns what `ui --json` would print (a string). `changed()` tells
 * core the manifest moved. Returns {path, tick, close}, or null when there's nowhere to listen (no piece home, another
 * service answering, a bind that failed): the caller goes on as before, core keeps running `ui --json`.
 * `tick()` (after each delivery tick): while loom is asking, compute again, and tell core if it moved; it returns
 * whether loom is asking, so the caller knows whether its own "what's at work" heartbeat is still needed.
 */
export async function serveManifest(env, { compute, changed, now = Date.now, log = (m) => process.stderr.write(`loom-runtime deliver: ${m}\n`) }) {
  const path = socketPath(env);
  if (!path) return null;
  try { ownDir(join(path, '..')); } catch (e) { log(`no manifest socket: ${e.message}`); return null; }
  try {
    const st = lstatSync(path);
    if (!st.isSocket()) { log(`no manifest socket: ${path} is something else`); return null; }
    if (await answering(path)) { log(`no manifest socket: another service answers at ${path}`); return null; }
    unlinkSync(path);
  } catch (e) { if (e.code !== 'ENOENT') { log(`no manifest socket: ${e.message}`); return null; } }

  let kept = null;   // {at, stdout, print}
  let asked = 0;
  const fresh = () => {
    // Stamped when it starts: what it read is from then on, and a move during the compute is newer than it.
    const at = now();
    const stdout = compute();
    const next = { at, stdout, print: stablePrint(stdout) };
    const moved = kept !== null && kept.print !== next.print;
    kept = next;
    return moved;
  };
  let computedAt = -Infinity;   // when the last compute started (since-driven ones are at most one per SINCE_MIN_MS)
  const answer = (id, version, since) => {
    // An ask for another version: core won't take the answer, so it's not computed (nor loom reading this socket).
    if (version !== VERSION) return { id, ok: false, version: VERSION };
    try {
      // Also when nobody was asking: the kept answer wasn't being kept current, and the heartbeat may have told core of a
      // move since.
      const lapsed = !asked || now() - asked >= ACTIVE_MS;
      const wants = Number.isSafeInteger(since) && kept && Math.min(since, now()) > kept.at && now() - computedAt >= SINCE_MIN_MS;
      if (!kept || lapsed || now() - kept.at >= STALE_MS || wants) { computedAt = now(); fresh(); }
      asked = now();
      // Still older than core asked for (a since-driven compute ran just now): core runs `ui --json` for this one.
      return { id, ok: true, version: VERSION, at: kept.at, stdout: kept.stdout };
    } catch (e) {
      log(`manifest: ${e.message}`);
      asked = 0;
      return { id, ok: false, version: VERSION };
    }
  };

  const conns = new Set();
  const server = createServer({ allowHalfOpen: false }, (c) => {
    if (conns.size >= MAX_CONNS) { c.destroy(); return; }
    conns.add(c);
    c.on('close', () => conns.delete(c));
    c.on('error', () => c.destroy());
    c.setTimeout(IDLE_MS, () => c.destroy());
    c.setEncoding('utf-8');
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { m = null; }
        // Anything but a manifest request: the connection goes, unanswered.
        if (!m || typeof m !== 'object' || m.op !== 'manifest' || !Number.isSafeInteger(m.id) || m.id < 0) { c.destroy(); return; }
        // An answer from the future can't be made: asking for one would recompute on every line. The connection goes.
        if (m.since !== undefined && (!Number.isSafeInteger(m.since) || m.since > now() + 1000)) { c.destroy(); return; }
        // Asking faster than it reads: the connection goes.
        if (c.writableLength > MAX_UNREAD) { c.destroy(); return; }
        c.write(JSON.stringify(answer(m.id, m.version, m.since)) + '\n');
      }
      if (Buffer.byteLength(buf) > MAX_LINE) c.destroy();
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // The socket is made 0600 as it's bound (the umask only for that call: it binds before listen returns).
      const old = process.umask(0o177);
      try { server.listen(path, () => { server.off('error', reject); resolve(); }); } finally { process.umask(old); }
    });
  } catch (e) {
    log(`no manifest socket: ${e.message}`);
    return null;
  }
  try { chmodSync(path, 0o600); } catch { /* the dir is 0700 either way */ }
  server.on('error', (e) => log(`manifest socket: ${e.message}`));

  return {
    path,
    /** After a delivery tick: while loom asks, compute again and tell core if it moved. Whether loom is asking. */
    async tick() {
      if (!asked || now() - asked >= ACTIVE_MS) return false;
      let moved = false;
      // One that fails: core gets ok:false and runs `ui --json` meanwhile, so the heartbeat is back on.
      try { moved = fresh(); } catch (e) { log(`manifest: ${e.message}`); asked = 0; return false; }
      if (moved) { try { await changed(); } catch (e) { log(`couldn't tell core the manifest moved: ${e.message}`); } }
      return true;
    },
    close() {
      for (const c of conns) c.destroy();
      return new Promise((resolve) => server.close(() => { try { unlinkSync(path); } catch { /* gone */ } resolve(); }));
    },
  };
}
