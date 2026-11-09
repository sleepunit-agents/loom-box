// The body host (shuttle's bodies.py Host, ported): runs in an agent's own warm house, as the house's task
// (houserunner.mjs, hostTask), and wakes the bodies the runtime asks for with the house's own runner: its harness,
// logged in on its box; its repo, its cwd, its secrets; its agent's loom token. A body's environment is the house's,
// plus its run's own key (LOOM_BODY_KEY, what `loom runtime send` proves it with).
//
// One sync a beat, through the piece API (`body-sync`, as the house's token): it reports its bodies (status, session,
// whether its harness can be fed), what it started, and a stopped body's session files in parts; it's answered what to
// start, stop and feed. It never reports what it can't see. It leaves when it's had no live body and nothing asked
// for its idle time (the next delivery asks for a house again), or when the runtime says its bodies are another house's.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { composeBrief } from './briefs.mjs';
import { packSession, dropSession, restoreFiles } from './sessions.mjs';
import { PART_CHARS } from './houserunner.mjs';
import { LOGIN_HARNESSES } from './logins.mjs';

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
  return env.LOOM_BODY_KEY;
}

export function keepKey(env, conversation, key) {
  const f = keyFile(env, conversation);
  if (!f || typeof key !== 'string' || !key) return;
  mkdirSync(keysDir(env), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, key, { mode: 0o600 });
  renameSync(tmp, f);
}

function dropKey(env, conversation, key) {
  const f = keyFile(env, conversation);
  if (!f) return;
  try { if (readFileSync(f, 'utf-8').trim() === key) rmSync(f, { force: true }); } catch { /* gone */ }
}

export const SYNC_MS = 2000;
export const IDLE_S = 600;
/** A session going back that the runtime hasn't acknowledged in this long is dropped (and its files with it). */
export const PACK_MS = 120_000;

/**
 * `client(path, body)` reaches the runtime's piece API as this house; `runner(harness)` is a local runner here.
 * Resolves when the host leaves.
 */
export async function runBodyHost({ client, runner, env = process.env, hostKey, cwd = process.cwd(), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), idleS = IDLE_S, beats = Infinity, packMs = PACK_MS, log = () => {} }) {
  // Its own key, in memory only: the boot key from its task, traded on its first sync for the host's key.
  let key = hostKey;
  // A body's environment is the house's, less what's the host's alone: its task (which carried the boot key).
  const bodyEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'HOUSE_TASK' && k !== 'LOOM_HOST_KEY'));
  const mine = new Map();   // id -> {harness}
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
      const slot = (() => { try { return r.slotOf({ id }); } catch { return null; } })();
      // What its inbox still holds (ids only): fed, never taken by its hook. The runtime keeps their text.
      const pending = (() => { try { return (r.inbox?.pending?.(id) ?? []).map((p) => p?.id).filter((k) => typeof k === 'string').slice(0, 64); } catch { return []; } })();
      // Its turn over: how it went (runners.mjs, turn), for the runtime's loop check (t-1763).
      // Read once when its turn is over, and kept (a turn that's over stays as it was).
      if (status === 'working') delete b.turn;
      else if ((status === 'idle' || status === 'ended') && b.turn === undefined) { try { b.turn = r.turn?.({ id, ...(b.slot ? { slot: b.slot } : {}) }) ?? null; } catch { b.turn = null; } }
      const turn = status === 'idle' || status === 'ended' ? b.turn : null;
      // A Comms thread's body: its tool steps, the newest 100, read from its harness's own record (activity.mjs).
      const cards = b.activity ? (() => { try { return (r.activity?.({ id, ...(b.slot ? { slot: b.slot } : {}) }) ?? []).slice(-100); } catch { return []; } })() : null;
      let final;
      if (status === 'idle' || status === 'ended') {
        try { final = r.final?.({ id, ...(b.slot ? { slot: b.slot } : {}) })?.slice(0, 40000); } catch { /* retry next sync */ }
      }
      bodies[id] = { harness: b.harness, status, ...(slot?.session ? { session: slot.session } : {}), feedable: !!r.inbox, pending, ...(turn ? { turn } : {}), ...(typeof final === 'string' ? { final } : {}), ...(cards ? { cards } : {}) };
    }
    await reportUsage(turnsOver);
    const packed = {};
    for (const [id, p] of [...packing]) {
      // Nobody's taking it (its stop was dropped, the runtime moved on): given up, so the house can idle out.
      if (now() - p.since > packMs) { packing.delete(id); mine.delete(id); log(`dropped ${id}'s session: nobody took it`); continue; }
      packed[id] = { part: p.next, parts: p.parts.length, data: p.parts[p.next] };
    }
    let got;
    const sent = acks;
    try { got = await client('body-sync', { hostKey: key, report: { bodies, done, packed, inboxAck: sent, caps: ['parts'] } }); } catch (e) { log(`sync failed: ${e.message}`); await sleep(SYNC_MS); continue; }
    if (typeof got.hostKey === 'string') key = got.hostKey;
    // Answered: what it acknowledged is the runtime's to forget now. (A lost answer: they go again next beat.)
    if (acks === sent) acks = {};
    for (const [id, part] of got.acked ?? []) {
      const p = packing.get(id);
      if (p && p.next === part) { p.next += 1; p.since = now(); if (p.next >= p.parts.length) { packing.delete(id); mine.delete(id); } }
    }
    if (got.exit) { log(`leaving: ${got.reason ?? 'the runtime says so'}`); return; }
    const req = got.req ?? {};
    for (const rid of Object.keys(done)) if (!req[rid]) delete done[rid];
    for (const [rid, q] of Object.entries(req)) {
      if (done[rid]) continue;
      try {
        if (!houseHasLogin(env, q.harness)) throw new Error(`this house doesn't declare the ${q.harness} harness (its house file's "harnesses"), so it has no ${q.harness} login: add it there`);
        const r = runner(q.harness);
        const cv = q.key && CV.test(q.conversation ?? '') ? q.conversation : null;
        // A brief in parts names the agent's own files (briefs.mjs): read here, from its repo (this house's cwd).
        // A file that isn't there fails the start: never a body without what its brief must carry.
        const brief = q.parts !== undefined ? composeBrief(q.parts, cwd) : q.brief;
        const o = { brief, model: q.model, deny: q.deny ?? [], cwd, env: { ...bodyEnv, ...(q.key ? { LOOM_BODY_KEY: q.key } : {}), ...(cv ? { LOOM_BODY_CONVERSATION: cv } : {}) } };
        // Kept by its conversation before the body starts, so its first `send` finds it.
        if (cv) keepKey(env, cv, q.key);
        let written = [];
        let b;
        try {
          if (q.resume) { written = restoreFiles(r, q.files); b = await r.resume({ harness: q.harness, session: q.resume }, o); } else b = await r.start(o);
        } catch (e) { for (const w of written) rmSync(w, { recursive: true, force: true }); throw e; }
        mine.set(b.id, { harness: q.harness, seen: 'started', ...(b.slot ? { slot: b.slot } : {}), ...(cv ? { cv, key: q.key } : {}), ...(q.activity === true ? { activity: true } : {}) });
        done[rid] = { id: b.id };
        log(`started ${b.id} for ${rid}`);
      } catch (e) { done[rid] = { error: String(e.message).split('\n')[0].slice(0, 300) }; }
    }
    for (const id of [...stopped.keys()]) if (!got.stop?.[id]) stopped.delete(id);
    for (const [id, s] of Object.entries(got.stop ?? {})) {
      const b = mine.get(id);
      if (!b || b.ended || (stopped.get(id) === s.at && b.stopPending !== s.at)) continue;
      const r = runner(b.harness);
      if (b.stopPending !== s.at) {
        try {
          r.end({ id });
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
      delete b.stopPending;
      if (b.cv) dropKey(env, b.cv, b.key);
      heard.delete(id);
      b.ended = true;
      if (s.pack) {
        const slot = (() => { try { return r.slotOf({ id }); } catch { return null; } })();
        // An empty pack (nothing kept, or too big to keep) is no slot: the runtime starts the next body fresh.
        let files = [];
        try { files = packSession(r, slot, { id }); } catch (e) { log(`packing ${id}: ${e.message}`); files = []; }
        dropSession(r, slot, { id });
        const all = Buffer.from(JSON.stringify(files)).toString('base64');
        const parts = [];
        for (let i = 0; i < all.length || i === 0; i += PART_CHARS) parts.push(all.slice(i, i + PART_CHARS));
        packing.set(id, { parts, next: 0, since: now() });
      } else {
        // A plain stop leaves nothing: its session's files go (only a pack keeps them, sealed, in a slot).
        dropSession(r, (() => { try { return r.slotOf({ id }); } catch { return null; } })(), { id });
      }
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
    if (working || Object.keys(req).length || packing.size) lastBusy = now();
    if (idleS && now() - lastBusy >= idleS * 1000) { log(`idle ${idleS}s: leaving`); return; }
    await sleep(SYNC_MS);
  }
}
