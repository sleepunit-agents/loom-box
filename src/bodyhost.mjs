import { PROFILE_CAP, selectedProfile, restrictedEnv, minimalProfile } from './work-profile.mjs';
// The body host (shuttle's bodies.py Host, ported): runs in an agent's own warm house, as the house's task
// (houserunner.mjs, hostTask), and wakes the bodies the runtime asks for with the house's own runner: its harness,
// logged in on its box; its repo, its cwd, its secrets; its agent's loom token. A body's environment is the house's,
// plus its run's own key (LOOM_BODY_KEY, what `loom runtime send` proves it with).
//
// One sync a beat, through the piece API (`body-sync`, as the house's token): it reports its bodies (status, session,
// whether its harness can be fed), what it started, and a stopped body's session files in parts; it's answered what to
// start, stop and feed. It never reports what it can't see. It leaves when it's had no live body and nothing asked
// for its idle time (the next delivery asks for a house again), or when the runtime says its bodies are another house's.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { composeBrief } from './briefs.mjs';
import { packSession, dropSession, restoreFiles, SessionSizeError } from './sessions.mjs';
import { PART_CHARS } from './houserunner.mjs';
import { ClaudeRunner, CodexRunner, nativeRunnerConfiguration } from './runners.mjs';
import { launchInjectedNative, superviseNativeLaunch } from './native-launch.mjs';
import { cancelReservedLaunch } from './launch-journal.mjs';
import { LOGIN_HARNESSES } from './logins.mjs';
import { nativeHistoryRoot } from './native-history.mjs';
import { nativePendingInbox } from './native-inbox.mjs';

/**
 * At most how many bytes of cards one report carries (t-2109): a report goes through core's 1 MB cap with its packed
 * session part (PART_CHARS) and its final beside them, and a card's diff may be ~96 KB.
 */
export const CARDS_MAX = 256 * 1024;
/** At most how many bytes a whole report carries (t-2109): core takes 1 MB a call, with room for the call around it. */
export const REPORT_MAX = 900 * 1024;
/** At most how many characters of packed session parts a report carries (one part is at most PART_CHARS). */
export const PACKED_MAX = 400 * 1024;
/**
 * A report's cards trimmed so the whole report fits in `max` bytes (t-2109): one report carries every body's, beside
 * packed session parts and finals, so several threads in one house share one budget. The newest cards, across its
 * bodies, are kept; each body's keep their order. Anything else in the report is never trimmed.
 */
export function fitCards(report, max) {
  fitFinals(report);
  const all = [];
  for (const [id, b] of Object.entries(report.bodies ?? {})) if (Array.isArray(b.cards)) b.cards.forEach((c, i) => all.push({ id, i, at: Date.parse(c?.at ?? '') || 0, n: Buffer.byteLength(JSON.stringify(c)) + 1 }));
  const total = Buffer.byteLength(JSON.stringify(report));
  if (total <= max) return report;
  // Each nonempty array has one fewer separator than cards. Start from exact empty arrays.
  const populated = Object.values(report.bodies ?? {}).filter((b) => Array.isArray(b.cards) && b.cards.length).length;
  let room = max - (total - all.reduce((k, x) => k + x.n, 0) + populated);
  const keep = new Set(), keptBodies = new Set();
  // A card that doesn't fit stops its own body's older ones only (each keeps its newest), not the other bodies'.
  const stopped = new Set();
  for (const x of all.sort((p, q) => (p.at < q.at ? 1 : p.at > q.at ? -1 : q.i - p.i))) { if (stopped.has(x.id)) continue; const cost = x.n - (keptBodies.has(x.id) ? 0 : 1); if (cost > room) { stopped.add(x.id); continue; } room -= cost; keptBodies.add(x.id); keep.add(`${x.id}\0${x.i}`); }
  for (const [id, b] of Object.entries(report.bodies)) if (Array.isArray(b.cards)) b.cards = b.cards.filter((_, i) => keep.has(`${id}\0${i}`));
  return report;
}
/**
 * The session parts a report carries: at most PACKED_MAX of them, the longest waiting first (each beat sends the next
 * ones), so a report with several bodies packing at once still fits core's cap (t-2109); at least one, whatever its size.
 */
export function packedParts(packing, history) {
  const packed = {};
  let size = 0;
  for (const [id, p] of [...packing].sort((x, y) => x[1].since - y[1].since)) {
    const n = String(p.parts[p.next] ?? '').length;
    if (Object.keys(packed).length && size + n > PACKED_MAX) continue;
    size += n;
    packed[id] = { part: p.next, parts: p.parts.length, data: p.parts[p.next], ...(p.format ? { format: p.format } : history ? { pending: p.pending } : {}), ...(p.omitted ? { omitted: p.omitted } : {}) };
  }
  return packed;
}
/** At most how many bytes of finals a report carries in all (each is at most 40000 characters): FINALS_MAX. */
export const FINALS_MAX = 300 * 1024;
/**
 * A report's finals, cut evenly when together they'd pass FINALS_MAX (t-2109): every idle body sends its final each
 * beat, so many in one house could crowd out a packed part. A cut one says so. Below the cap, untouched.
 */
export function fitFinals(report) {
  // Measured as sent: JSON, where a control character takes 6 bytes.
  const sent = (s) => Buffer.byteLength(JSON.stringify(s));
  const finals = Object.values(report.bodies ?? {}).filter((b) => typeof b.final === 'string');
  if (finals.reduce((k, b) => k + sent(b.final), 0) <= FINALS_MAX) return report;
  const keep = Math.floor((FINALS_MAX / finals.length - 64) / 6); // UTF-16 units: at most 6 bytes each, as JSON
  for (const b of finals) if (sent(b.final) > FINALS_MAX / finals.length) {
    let t = b.final.slice(0, Math.max(0, keep));
    if (/[\ud800-\udbff]$/.test(t)) t = t.slice(0, -1);
    b.final = `${t}\n… (cut to fit: ${finals.length} finals in one report)`;
  }
  return report;
}
/** The newest of `cards` whose JSON fits in `max` bytes, in their order (none dropped from the middle). */
export function newestWithin(cards, max) {
  let size = 0, k = cards.length;
  while (k > 0) {
    const n = Buffer.byteLength(JSON.stringify(cards[k - 1])) + 1;
    if (size + n > max) break;
    size += n; k--;
  }
  return cards.slice(k);
}

/**
 * Whether this house has its box's login for a harness: the box sets the login's env only for the harnesses the house
 * file declares (house.mjs, "harnesses"). A body on a harness the house didn't declare would run with no login.
 */
export function houseHasLogin(env, harness) {
  const def = LOGIN_HARNESSES[harness];
  return !!def && Object.keys(def.houseEnv('')).every((k) => typeof env[k] === 'string' && env[k] !== '');
}

const CV = /^cv-[0-9a-f]{12}$/;

/**
 * Where a house keeps each conversation's current run key (0600 files in a 0700 dir), for `loom runtime send`.
 * Not the environment alone: a harness whose sessions run under a daemon (`claude --bg`) gives every session the
 * daemon's environment, which is the first body's, so a later body would hold another run's key (t-1744, h-784).
 */
export const keysDir = (env) => env.LOOM_RUNTIME_KEYS_DIR || join(env.HOME || homedir(), '.local', 'state', 'loom-runtime', 'keys');
export const keyFile = (env, conversation) => (CV.test(conversation ?? '') ? join(keysDir(env), `${conversation}.key`) : null);

/** The run key a body speaks with in `conversation`: its house's file for it, else the body's own environment. */
export function bodyKeyFor(env, conversation) {
  const f = keyFile(env, conversation);
  if (f) { try { const k = readFileSync(f, 'utf-8').trim(); if (k) return k; } catch { /* none kept here */ } }
  // The environment's key is its LOOM_BODY_CONVERSATION's run's: never another conversation's proof (t-2053).
  return env.LOOM_BODY_CONVERSATION === conversation ? env.LOOM_BODY_KEY : undefined;
}

export function keepKey(env, conversation, key) {
  const f = keyFile(env, conversation);
  if (!f || typeof key !== 'string' || !key) return;
  mkdirSync(keysDir(env), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, key, { mode: 0o600 });
  renameSync(tmp, f);
}

/**
 * A harness session id, as a body's environment names it (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID): the one thing a
 * `claude --bg` body's environment says that is its own. A spare session the daemon started ahead of time keeps the
 * environment of whatever it was started under, so its LOOM_BODY_CONVERSATION (and LOOM_BODY_KEY) can be another
 * conversation's; its session id is its own (t-2053).
 */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/;
export const bodySession = (env) => {
  const s = env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID || undefined;
  return SESSION.test(s ?? '') ? s : undefined;
};
/**
 * Where a house says which conversation each of its bodies' sessions holds: <keys>/sessions/<sha256 of the session>,
 * and back (<keys>/held/<cv>: that hash). Hashed, so the map itself never lists a session id.
 */
const sessionHash = (session) => createHash('sha256').update(String(session)).digest('hex');
const bySession = (env, session) => (SESSION.test(session ?? '') ? join(keysDir(env), 'sessions', sessionHash(session)) : null);
const byConversation = (env, cv) => (CV.test(cv ?? '') ? join(keysDir(env), 'held', cv) : null);

function writeAtomic(f, text) {
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, f);
}
const readTrim = (f) => { try { return readFileSync(f, 'utf-8').trim(); } catch { return ''; } };

/**
 * Says that harness session `session` holds conversation `cv` (t-2053): written by whoever started the body (its house's
 * host, or the runtime on loom's machine) once the session is known, and read by the body's own CLI. Never the body's
 * environment alone, which a reused session keeps from its first start.
 */
export function keepSession(env, session, cv) {
  const f = bySession(env, session), g = byConversation(env, cv);
  if (!f || !g) return false;
  writeAtomic(f, cv);
  writeAtomic(g, sessionHash(session));
  return true;
}

/** Forgets that `session` holds `cv` (its body ended), leaving whatever a later start wrote. */
export function forgetSession(env, session, cv) {
  const f = bySession(env, session), g = byConversation(env, cv);
  if (f && readTrim(f) === cv) rmSync(f, { force: true });
  if (g && readTrim(g) === sessionHash(session)) rmSync(g, { force: true });
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const SESSION_WAIT_MS = 15_000;

/**
 * This body's own conversation (t-2053), or undefined: the one its house's host says its harness session holds. Its
 * environment's LOOM_BODY_CONVERSATION only when nothing says otherwise. When the house says that conversation is
 * another session's (a reused spare kept the first body's environment), it waits a little for its own (the host
 * writes it as soon as the start is claimed) and never answers with the other's.
 */
export function bodyConversation(env, { waitMs = SESSION_WAIT_MS, sleep = sleepSync } = {}) {
  const fromEnv = CV.test(env.LOOM_BODY_CONVERSATION ?? '') ? env.LOOM_BODY_CONVERSATION : undefined;
  const session = bodySession(env);
  if (!session) return fromEnv;
  const mine = () => { const cv = readTrim(bySession(env, session)); return CV.test(cv) ? cv : undefined; };
  let cv = mine();
  if (cv) return cv;
  if (!fromEnv) return undefined;
  // Only a Claude Code session can be a reused spare: a Codex body is its own process, started with its own
  // environment, so that stands (its thread id is known only after its first event, so its map can lag).
  if (!env.CLAUDE_CODE_SESSION_ID) return fromEnv;
  const holder = readTrim(byConversation(env, fromEnv));
  // That conversation is this session's: the environment is its own.
  if (holder === sessionHash(session)) return fromEnv;
  // A house that keeps no map at all (an older host): the environment stands.
  if (!holder && !existsSync(join(keysDir(env), 'sessions'))) return fromEnv;
  // Otherwise its own entry is coming (its host writes it as soon as the start is claimed): wait for it. When the
  // environment's conversation is known to be another session's, never answer with it; else, as a last resort, it.
  for (let waited = 0; waited < waitMs; waited += 250) {
    sleep(250);
    if ((cv = mine())) return cv;
  }
  return holder ? undefined : fromEnv;
}

function dropKey(env, conversation, key) {
  const f = keyFile(env, conversation);
  if (!f) return;
  try { if (readFileSync(f, 'utf-8').trim() === key) rmSync(f, { force: true }); } catch { /* gone */ }
}

export const SYNC_MS = 2000;
export const IDLE_S = 600;
export const SYNC_BACKOFF_MAX_MS = 300_000;
export const SYNC_BROKEN_AFTER = 5;
/** The whole HTTP request, including its key and envelope, stays below core's 1 MiB cap. */
export const SYNC_REQUEST_MAX = 1000 * 1024;
export const syncFailureKind = (e) => /oversized|size cap/.test(String(e?.message)) ? 'oversized'
  : /timeout|timed out|aborted/i.test(String(e?.message)) ? 'timeout' : 'unavailable';
export const syncBackoff = (n) => Math.min(SYNC_BACKOFF_MAX_MS, SYNC_MS * 2 ** Math.min(20, Math.max(0, n - 1)));
export function checkedSyncRequest(hostKey, report) {
  const body = { hostKey, report };
  if (Buffer.byteLength(JSON.stringify(body)) > SYNC_REQUEST_MAX) throw Error('sync report exceeds size cap');
  return body;
}
/** An abandoned transfer may expire after this age only when a fresh controller answer no longer requests it. */
export const PACK_MS = 120_000;

/**
 * `client(path, body)` reaches the runtime's piece API as this house; `runner(harness)` is a local runner here.
 * Resolves when the host leaves.
 */
export async function runBodyHost({ client, runner, env = process.env, hostKey, cwd = process.cwd(), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), idleS = IDLE_S, beats = Infinity, packMs = PACK_MS, log = () => {} }) {
  const history = nativeHistoryRoot(env);
  // Every harness's history linked now, before any body runs (t-2072): a body that runs the other harness's CLI itself
  // (a Claude body's `codex exec`, a Codex body's `claude -p`) would otherwise make that CLI's history a plain folder
  // with files in it, and native history refuses to replace those, so no body on that harness could start here again.
  if (history) for (const h of ['claude', 'codex']) { try { runner(h); } catch (e) { log(`couldn't link ${h}'s native history: ${String(e.message).split('\n')[0].slice(0, 200)}`); } }
  // Its own key, in memory only: the boot key from its task, traded on its first sync for the host's key.
  let key = hostKey;
  // A body's environment is the house's, less what's the host's alone: its task (which carried the boot key).
  const bodyEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'HOUSE_TASK' && k !== 'LOOM_HOST_KEY'));
  const mine = new Map();   // id -> {harness}
  const mapSession = (b, session) => {
    if (!b?.cv || !session || b.mapped === session) return;
    try { if (keepSession(env, session, b.cv)) b.mapped = session; } catch (e) { log(`couldn't keep ${b.cv}'s session: ${e.message}`); }
  };
  const durableRequests = new Set();
  const launching = new Map(); // durable rid -> in-flight promise
  const uncertain = new Map(); // durable rid -> original request to reconcile
  const done = {};          // rid -> {id} | {error}
  const packing = new Map(); // id -> {parts: [string], next}
  const heard = new Map();   // id -> Set of follow-up ids fed to it (each is fed once, however often it's sent)
  // id -> the stop (its `at`) this host carried out for it: a stop is one body's, so the same stop still on the record
  // never ends the body that came back under that id (a resumed Claude session has its old job id; t-1881).
  const stopped = new Map();
  let acks = {};             // id -> [follow-up ids] fed since the last answered sync: sent until one is answered
  const sentUsage = {};      // harness -> the last reading sent (JSON): the same one isn't sent twice
  // Each turn that ended: its harness's own reading (runners.mjs, usage), through the house's `usage` path, as a house
  // run-task's is. A body that had none (no status line yet, a rollout without token_count) sends nothing.
  async function reportUsage(over) {
    for (const t of over) {
      let reading = null;
      try { reading = runner(t.harness).usage?.(t.body) ?? null; } catch { reading = null; }
      if (!reading) continue;
      const sig = JSON.stringify(reading);
      if (sentUsage[t.harness] === sig) continue;
      try {
        await client('usage', { harness: t.harness, reading: { ...reading, checked: reading.checked ?? Math.floor(now() / 1000) } });
        sentUsage[t.harness] = sig;
        log(`usage from ${t.id}: ${t.harness} ${Object.entries(reading.windows).map(([w, v]) => `${w} ${Math.round(v * 100)}%`).join(', ')}`);
      } catch (e) { log(`couldn't report ${t.id}'s usage: ${String(e.message).split('\n')[0].slice(0, 200)}`); }
    }
  }
  let lastBusy = now();
  let syncFailures = 0;
  let packedReceipts = false;
  for (let beat = 0; beat < beats; beat++) {
    const bodies = {};
    const turnsOver = [];
    for (const [id, b] of mine) {
      const r = runner(b.harness);
      let status = 'unknown';
      try { status = b.ended ? 'ended' : r.status({ id }); } catch { /* it can't say */ }
      // A turn just over (it was working, or just started, and isn't now): its account's usage goes to the runtime.
      if (['working', 'started'].includes(b.seen) && (status === 'idle' || status === 'ended')) turnsOver.push({ id, harness: b.harness, body: { id, ...(b.slot ? { slot: b.slot } : {}) } });
      if (status !== 'unknown') b.seen = status;
      const slot = (() => { try { return r.slotOf({ id, ...(b.slot ? { slot: b.slot } : {}) }) ?? b.slot; } catch { return b.slot; } })();
      if (slot?.session) { b.slot = slot; if (!b.ended) mapSession(b, slot.session); }
      // What its inbox still holds (ids only): fed, never taken by its hook. The runtime keeps their text.
      const pending = (() => { try { return (r.inbox?.pending?.(id) ?? []).map((p) => p?.id).filter((k) => typeof k === 'string').slice(0, 64); } catch { return []; } })();
      // Its turn over: how it went (runners.mjs, turn), for the runtime's loop check (t-1763).
      // Read once when its turn is over, and kept (a turn that's over stays as it was).
      if (status === 'working') delete b.turn;
      else if ((status === 'idle' || status === 'ended') && b.turn === undefined) { try { b.turn = r.turn?.({ id, ...(b.slot ? { slot: b.slot } : {}) }) ?? null; } catch { b.turn = null; } }
      const turn = status === 'idle' || status === 'ended' ? b.turn : null;
      // A Comms thread's body: its tool steps, the newest 100, read from its harness's own record (activity.mjs).
      // At most CARDS_MAX of them in all (t-2109: a diff can be large): the newest kept, so a report always fits core's cap.
      const cards = b.activity ? (() => { try { return newestWithin((r.activity?.({ id, ...(b.slot ? { slot: b.slot } : {}) }) ?? []).slice(-100), CARDS_MAX); } catch { return []; } })() : null;
      // And its last sign of life (t-2109): when its record last moved, its tokens so far.
      const alive = b.activity ? (() => { try { return r.signOfLife?.({ id, ...(b.slot ? { slot: b.slot } : {}) }) ?? null; } catch { return null; } })() : null;
      let final;
      if (status === 'idle' || status === 'ended') {
        try { final = r.final?.({ id, ...(b.slot ? { slot: b.slot } : {}) })?.slice(0, 40000); } catch { /* retry next sync */ }
      }
      let tickerAction;
      if (status === 'working') { try { tickerAction = r.tickerAction?.({ id, ...(b.slot ? { slot: b.slot } : {}) }); } catch { /* unavailable */ } }
      bodies[id] = { ...(tickerAction ? { tickerAction, tickerObservedAt: new Date(now()).toISOString() } : {}), harness: b.harness, status, ...(slot?.session ? { session: slot.session } : {}), feedable: !!r.inbox, pending, ...(turn ? { turn } : {}), ...(typeof final === 'string' ? { final } : {}), ...(cards ? { cards } : {}), ...(alive ? { alive } : {}) };
    }
    await reportUsage(turnsOver);
    const packed = packedParts(packing, history);
    let got;
    const sent = acks;
    const report = { bodies, done, packed, inboxAck: sent, caps: [PROFILE_CAP, 'parts', 'native-admission', ...(history ? ['native-history'] : [])], starting: [...new Set([...launching.keys(), ...uncertain.keys(), ...Object.keys(done)])] };
    fitCards(report, REPORT_MAX);
    try { got = await client('body-sync', checkedSyncRequest(key, report)); } catch (e) {
      syncFailures++;
      const kind = syncFailureKind(e), delay = syncBackoff(syncFailures);
      log(`sync failed (${syncFailures}, ${kind}); retry in ${delay / 1000}s`);
      // This small independent request still works when the full report is rejected. Never send error text:
      // it can carry credentials or a body's words. Retry reporting at the same bounded cadence as sync.
      if (syncFailures >= SYNC_BROKEN_AFTER) {
        try { await client('body-health', { hostKey: key, failures: syncFailures, kind }); }
        catch { log('could not report broken sync to the runtime'); }
      }
      // No native work or uncollected data here: even a host that never got its first answer may leave.
      // A working/unknown body or uncertain launch must never be abandoned on a network failure.
      if (idleS && !mine.size && !packing.size && !launching.size && !uncertain.size && !Object.keys(done).length && now() - lastBusy >= idleS * 1000) {
        log(`idle ${idleS}s with failing sync: leaving`); return;
      }
      await sleep(delay); continue;
    }
    syncFailures = 0;
    if (typeof got.hostKey === 'string') key = got.hostKey;
    packedReceipts = got.packedReceipts === true;
    // Answered: what it acknowledged is the runtime's to forget now. (A lost answer: they go again next beat.)
    if (acks === sent) acks = {};
    for (const [id, part] of got.acked ?? []) {
      const p = packing.get(id);
      if (p && p.next === part) { p.next += 1; p.since = now(); if (p.next >= p.parts.length) {
        if (p.cleanup) dropSession(runner(p.cleanup.harness), p.cleanup.slot, { id });
        packing.delete(id); mine.delete(id);
      } }
    }
    for (const id of got.restart ?? []) { const p = packing.get(id); if (p) { p.next = 0; p.since = now(); } }
    // A timeout is not evidence that the receiver stopped waiting: network failures retain the only copy.
    // A fresh authenticated answer that explicitly removed its stop may abandon an unclaimed transfer.
    for (const [id, p] of packing) if (!got.stop?.[id] && now() - p.since > packMs) {
      if (p.cleanup) dropSession(runner(p.cleanup.harness), p.cleanup.slot, { id });
      packing.delete(id); mine.delete(id); log(`dropped ${id}'s session: the runtime no longer asks for it`);
    }
    if (got.exit) { log(`leaving: ${got.reason ?? 'the runtime says so'}`); return; }
    const req = got.req ?? {};
    if (got.stopping) for (const q of [...launching.values()].map(x => x.request)) {
      try { cancelReservedLaunch(bodyEnv, q.attempt); } catch { /* admitted or unobservable attempts stay held */ }
    }
    for (const rid of Object.keys(done)) {
      if (durableRequests.has(rid)) {
        if (got.received?.includes(rid)) { delete done[rid]; durableRequests.delete(rid); }
      } else if (!req[rid]) delete done[rid];
    }
    for (const [rid, q] of new Map([...Object.entries(req), ...uncertain])) {
      if (done[rid] || launching.has(rid)) continue;
      const launch = async () => {
        let enteredNative = false;
        try {
          if (q.attempt && !/^[0-9a-f]{64}$/.test(q.attempt)) throw Object.assign(new Error('invalid durable native attempt'), { nativeNotStarted: true });
          if (!houseHasLogin(env, q.harness)) throw new Error(`this house doesn't declare the ${q.harness} harness (its house file's "harnesses"), so it has no ${q.harness} login: add it there`);
          const r = runner(q.harness);
          if (env.HOUSE_ID && !history && (r instanceof ClaudeRunner || r instanceof CodexRunner)) throw Object.assign(new Error('this box has not provisioned durable native history; update the box runtime before starting native work'), { nativeNotStarted: true });
          const cv = q.key && CV.test(q.conversation ?? '') ? q.conversation : null;
          // A brief in parts names the agent's own files (briefs.mjs): read here, from its repo (this house's cwd).
          // A file that isn't there fails the start: never a body without what its brief must carry.
          const transported = q.profile !== undefined ? { LOOM_BODY_PROFILE: q.profile, ...(q.profileProblem ? { LOOM_BODY_PROFILE_PROBLEM: q.profileProblem } : {}) } : q.harness === 'claude' ? { LOOM_BODY_PROFILE: JSON.stringify(minimalProfile()), LOOM_BODY_PROFILE_PROBLEM: 'JOB PROFILE PROBLEM: missing transported job profile; using minimal profile (no tools, MCP, skills or secrets).' } : {};
          const profile = selectedProfile(transported);
          const brief = q.parts !== undefined ? composeBrief(q.parts, cwd) : q.brief;
          const o = { brief, model: q.model, deny: q.deny ?? [], cwd, env: { ...(profile ? restrictedEnv({ ...bodyEnv, ...transported }, profile) : bodyEnv), LOOM_BODY_MODEL: q.model, ...(q.key ? { LOOM_BODY_KEY: q.key } : {}), ...(cv ? { LOOM_BODY_CONVERSATION: cv } : {}) } };
          // Kept by its conversation before the body starts, so its first `send` finds it.
          if (cv) keepKey(env, cv, q.key);
          let written = [];
          let b;
          try {
            if (q.attempt) {
              const configuration = nativeRunnerConfiguration(r);
              if (!configuration && (r instanceof ClaudeRunner || r instanceof CodexRunner)) throw Object.assign(new Error('this native runner cannot preserve its launch configuration'), { nativeNotStarted: true });
              enteredNative = true;
              if (configuration) b = await superviseNativeLaunch(bodyEnv, { id: q.attempt, harness: q.harness, options: o, configuration,
                ...(q.resume ? { resume: { harness: q.harness, session: q.resume }, files: q.files ?? [] } : {}) });
              else {
                b = await launchInjectedNative(bodyEnv, { id: q.attempt, harness: q.harness, options: o,
                  ...(q.resume ? { resume: { harness: q.harness, session: q.resume }, files: q.files ?? [] } : {}) }, r);
              }
            } else {
              if (q.resume) { written = restoreFiles(r, q.files); b = await r.resume({ harness: q.harness, session: q.resume }, o); } else b = await r.start(o);
            }
          } catch (e) { if (!q.attempt || !enteredNative || e.nativeNotStarted) for (const w of written) rmSync(w, { recursive: true, force: true }); throw e; }
          mine.set(b.id, { harness: q.harness, seen: 'started', ...(b.slot ? { slot: b.slot } : {}), ...(cv ? { cv, key: q.key } : {}), ...(q.activity === true ? { activity: true } : {}) });
          // Which conversation its session holds, for its own CLI (t-2053): as soon as the session is known.
          mapSession(mine.get(b.id), b.slot?.session ?? (() => { try { return r.slotOf(b)?.session; } catch { return undefined; } })());
          done[rid] = { id: b.id, ...(q.attempt ? { attempt: q.attempt, inputConfirmed: b.inputUncertain !== true } : {}) };
          uncertain.delete(rid);
          log(`started ${b.id} for ${rid}`);
        } catch (e) {
          if (q.attempt && enteredNative && !e.nativeNotStarted) {
            uncertain.set(rid, q); log(`launch ${rid} remains uncertain: ${String(e.message).split('\n')[0].slice(0, 200)}`);
          } else { done[rid] = { error: String(e.message).split('\n')[0].slice(0, 300), ...(q.attempt ? { attempt: q.attempt, nativeNotStarted: true } : {}) }; uncertain.delete(rid); }
        }
      };
      if (q.attempt) {
        durableRequests.add(rid);
        const promise = launch();
        launching.set(rid, { promise, request: q });
        promise.finally(() => launching.delete(rid));
      } else await launch();
    }
    for (const id of [...stopped.keys()]) if (!got.stop?.[id]) stopped.delete(id);
    for (const [id, s] of Object.entries(got.stop ?? {})) {
      const b = mine.get(id);
      if (!b || b.ended || (stopped.get(id) === s.at && b.stopPending !== s.at)) continue;
      const r = runner(b.harness);
      if (b.stopPending !== s.at) {
        try {
          r.end({ id }, bodyEnv);
          stopped.set(id, s.at);
          b.stopPending = s.at;
        } catch { /* observe, then retry a request that wasn't acknowledged */ }
      }
      // A stop request is not an acknowledgement. Codex exits asynchronously and
      // may flush its rollout after SIGTERM; never snapshot or delete it mid-write.
      let status;
      try { status = r.status({ id }); } catch { continue; }
      if (status !== 'idle' && status !== 'ended') continue;
      if (r.stopped) { try { if (!r.stopped({ id })) continue; } catch { continue; } }
      if (s.pack) {
        const slot = (() => { try { return r.slotOf({ id }); } catch { return null; } })();
        // An empty pack (nothing kept, or too big to keep) is no slot: the runtime starts the next body fresh.
        let files = [], omitted;
        try { files = packSession(r, slot, { id }); } catch (e) {
          log(`packing ${id}: ${e.message}`);
          // A failed read is not an empty session. Keep its files and stop
          // ownership so the next beat retries without another native stop.
          if (!(e instanceof SessionSizeError)) continue;
          omitted = 'size-limit';
        }
        if (!history) dropSession(r, slot, { id });
        const pending = history ? (r.inbox ? nativePendingInbox(r.inbox.dir, id) : []) : null;
        // Receipts travel in the same bounded parts as session files, rather than repeated beside every part.
        const format = history && packedReceipts ? 'receipts-v1' : undefined;
        const all = Buffer.from(JSON.stringify(format ? { files, pending } : files)).toString('base64');
        const parts = [];
        for (let i = 0; i < all.length || i === 0; i += PART_CHARS) parts.push(all.slice(i, i + PART_CHARS));
        packing.set(id, { parts, next: 0, since: now(), ...(format ? { format } : {}), ...(omitted ? { omitted } : {}), ...(history ? {
          cleanup: { harness: b.harness, slot }, pending: r.inbox ? pending : [],
        } : {}) });
      } else {
        // A plain stop leaves nothing: its session's files go (only a pack keeps them, sealed, in a slot).
        dropSession(r, (() => { try { return r.slotOf({ id }); } catch { return null; } })(), { id });
      }
      delete b.stopPending;
      if (b.cv) dropKey(env, b.cv, b.key);
      if (b.cv && b.mapped) { forgetSession(env, b.mapped, b.cv); delete b.mapped; }
      heard.delete(id);
      b.ended = true;
    }
    // An ended body is reported once its stop is answered, then forgotten (unless its session is still going back).
    for (const [id, b] of mine) if (b.ended && !got.stop?.[id] && !packing.has(id) && bodies[id]?.status === 'ended') mine.delete(id);
    for (const [id, items] of Object.entries(got.inbox ?? {})) {
      const b = mine.get(id);
      if (!b || b.ended) continue;
      const had = heard.get(id) ?? new Set();
      heard.set(id, had);
      for (const it of items) {
        if (typeof it?.id !== 'string') continue;
        // Fed once: a follow-up sent again (its ack's answer was lost) is only acknowledged again.
        if (!had.has(it.id)) {
          let r;
          try { r = runner(b.harness).feed({ id }, { id: it.id, text: it.text }); } catch { r = { fed: false }; }
          if (!r?.fed) continue; // not taken: not acknowledged, so it stays the runtime's (and comes back when its body ends)
          had.add(it.id);
        }
        (acks[id] ??= []).push(it.id);
      }
    }
    const working = Object.values(bodies).some((b) => b.status === 'working');
    const collecting = [...mine.values()].some(b => b.stopPending !== undefined);
    if (working || collecting || Object.keys(req).length || packing.size || launching.size || uncertain.size) lastBusy = now();
    if (idleS && now() - lastBusy >= idleS * 1000) { log(`idle ${idleS}s: leaving`); return; }
    await sleep(SYNC_MS);
  }
}
