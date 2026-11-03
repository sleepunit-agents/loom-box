// The off-box status board's reports (t-1731's leftover): what Art's art-now-report.service sent before the now board
// moved into the runtime. An owner who runs a status board off this machine (sleepunit-agents/status: an agent whose
// reports stop shows "dark", so it has to live elsewhere) points the runtime at it, and the runtime's own tick posts
// each reporting agent's v1 report there:
//
//   {"v": 1, "agent": "art", "at": <this clock>, "interval_s": 10, "plumbing": {"mem_mb": n}, "bridges": {name: snap}}
//
// The bridges are that agent's now board (nowboard.mjs: the snapshots its bridges post here), as they wrote them; no
// message text is in one. Settings (both optional; with no URL nothing is sent):
//
//   LOOM_RUNTIME_STATUS_URL      the board's report endpoint, e.g. https://status.example.com/api/report
//   LOOM_RUNTIME_STATUS_TOKENS   agent:secret,… which agents report and the secret holding each one's bearer token
//                                (default: every agent with a board, its token in the secret <agent>-status-token)
//
// A token comes from the secrets piece (`issue`, the runtime's own process; its policy's `may` for that agent), is
// kept in memory only, and is never logged or put in argv. A failure is logged when it changes, then at most every
// LOG_EVERY_MS while it lasts; reporting never touches the board or the bridges.
import { readdirSync, readFileSync } from 'node:fs';
import { boardDir, boards } from './nowboard.mjs';
import { setting } from './piece.mjs';
import { AGENT_NAME } from './state.mjs';

export const INTERVAL_S = 10;
const POST_TIMEOUT_MS = 5000;
/** A token is fetched again this long after it was got (sooner after a 401). */
const TOKEN_TTL_MS = 3600_000;
/** After a token couldn't be got, the next try is at least this far off. */
const TOKEN_RETRY_MS = 60_000;
const LOG_EVERY_MS = 300_000;
const SECRET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRIDGE = /^[a-z][a-z0-9-]{0,30}$/;

/** The board's URL, or null: only http(s). */
export function statusUrl(env) {
  const u = setting(env, 'STATUS_URL');
  if (!u) return null;
  try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null; } catch { return null; }
}

/** Who reports, and the secret holding each one's token: [{agent, secret}]. Empty with no URL. */
export function statusTargets(env, nowS = Date.now() / 1000) {
  if (!statusUrl(env)) return [];
  const raw = setting(env, 'STATUS_TOKENS');
  if (raw) {
    return raw.split(',').map((p) => p.trim()).filter(Boolean).flatMap((p) => {
      const [agent, secret] = p.split(':').map((s) => s?.trim());
      return AGENT_NAME.test(agent ?? '') && SECRET.test(secret ?? '') ? [{ agent, secret }] : [];
    });
  }
  return Object.keys(boards(env, nowS)).map((agent) => ({ agent, secret: `${agent}-status-token` }));
}

function memMb() {
  try {
    const m = /^MemAvailable:\s+(\d+)/m.exec(readFileSync('/proc/meminfo', 'utf-8'));
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch { return null; }
}

/** One agent's v1 report: its board's bridges as they wrote them, stamped on this clock. */
export function buildReport(env, agent, { nowS = Date.now() / 1000, mem = memMb } = {}) {
  const bridges = {};
  let dir;
  try { dir = boardDir(env, agent); } catch { dir = null; }
  if (dir) {
    for (const [name, snap] of Object.entries(snapshotsIn(dir))) bridges[name] = snap;
  }
  const mb = mem();
  return { v: 1, agent, at: nowS, interval_s: INTERVAL_S, plumbing: mb === null ? {} : { mem_mb: mb }, bridges };
}

function snapshotsIn(dir) {
  const out = {};
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names.sort()) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue;
    const name = n.slice(0, -5);
    if (!BRIDGE.test(name) || name === 'convs') continue;
    try {
      const snap = JSON.parse(readFileSync(`${dir}/${n}`, 'utf-8'));
      if (snap && typeof snap === 'object' && !Array.isArray(snap)) out[name] = snap;
    } catch { /* being written, or not a snapshot */ }
    if (Object.keys(out).length >= 16) break;
  }
  return out;
}

/**
 * The reporter: `tick()` posts every reporting agent's report once (call it every INTERVAL_S). `effects.secret` is
 * the secrets piece's `issue` (effects.mjs); `fetch` and `now` are the world's, `log` gets one line per change.
 */
export function statusReporter(env, { effects, fetch: post = fetch, now = () => Date.now(), log = (m) => process.stderr.write(`loom-runtime: status: ${m}\n`) } = {}) {
  const tokens = new Map();   // agent -> {token, at} | {error, at}
  const said = new Map();     // agent -> {what, at}: the last line logged
  const say = (agent, what) => {
    const s = said.get(agent);
    // Sending is said once, when it comes back after a failure; a failure again every LOG_EVERY_MS while it lasts.
    if (what === 'ok' && (!s || s.what === 'ok')) { said.set(agent, { what, at: now() }); return; }
    if (s && s.what === what && now() - s.at < LOG_EVERY_MS) return;
    said.set(agent, { what, at: now() });
    log(what === 'ok' ? `${agent}: sending again` : `${agent}: ${what}`);
  };
  function tokenFor({ agent, secret }) {
    const t = tokens.get(agent);
    if (t?.token && now() - t.at < TOKEN_TTL_MS) return t.token;
    if (t?.error && now() - t.at < TOKEN_RETRY_MS) throw new Error(t.error);
    try {
      const token = String(effects.secret(secret, { agent }) ?? '').trim();
      if (!token) throw new Error(`the secret ${secret} is empty`);
      tokens.set(agent, { token, at: now() });
      return token;
    } catch (e) {
      // The secrets piece's message names the secret and the refusal, never a value.
      const error = `no token: ${String(e.message).split('\n')[0].slice(0, 200)}`;
      tokens.set(agent, { error, at: now() });
      throw new Error(error);
    }
  }
  async function one(url, target) {
    let token;
    try { token = tokenFor(target); } catch (e) { say(target.agent, e.message); return { agent: target.agent, ok: false }; }
    const report = buildReport(env, target.agent, { nowS: now() / 1000 });
    try {
      const r = await post(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(report), signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
      if (r.status === 401 || r.status === 403) tokens.delete(target.agent);
      if (r.status < 200 || r.status >= 300) { say(target.agent, `the board answered ${r.status}`); return { agent: target.agent, ok: false, status: r.status }; }
      say(target.agent, 'ok');
      return { agent: target.agent, ok: true, status: r.status };
    } catch (e) {
      say(target.agent, `send failed: ${String(e.message ?? e).split('\n')[0].slice(0, 200)}`);
      return { agent: target.agent, ok: false };
    }
  }
  let busy = false;
  return {
    async tick() {
      const url = statusUrl(env);
      if (!url || busy) return [];
      busy = true;
      try { return await Promise.all(statusTargets(env, now() / 1000).map((t) => one(url, t))); } finally { busy = false; }
    },
  };
}

/** In the runtime's own process: a tick every INTERVAL_S while a URL is set. Returns a stop. */
export function startStatusReporter(env, effects) {
  if (!statusUrl(env)) return () => {};
  const r = statusReporter(env, { effects });
  process.stderr.write(`loom-runtime: status: reporting to ${new URL(statusUrl(env)).host} every ${INTERVAL_S}s\n`);
  const t = setInterval(() => { r.tick().catch(() => {}); }, INTERVAL_S * 1000);
  t.unref?.();
  r.tick().catch(() => {});
  return () => clearInterval(t);
}
