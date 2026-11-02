// The body host (shuttle's bodies.py Host, ported): runs in an agent's own warm house, as the house's task
// (houserunner.mjs, hostTask), and wakes the bodies the runtime asks for with the house's own runner: its harness,
// logged in on its box; its repo, its cwd, its secrets; its agent's loom token. A body's environment is the house's,
// plus its run's own key (LOOM_BODY_KEY, what `loom runtime send` proves it with).
//
// One sync a beat, through the piece API (`body-sync`, as the house's token): it reports its bodies (status, session,
// whether its harness can be fed), what it started, and a stopped body's session files in parts; it's answered what to
// start, stop and feed. It never reports what it can't see. It leaves when it's had no live body and nothing asked
// for its idle time (the next delivery asks for a house again), or when the runtime says its bodies are another house's.
import { rmSync } from 'node:fs';
import { packSession, dropSession, restoreFiles } from './sessions.mjs';
import { PART_CHARS } from './houserunner.mjs';

export const SYNC_MS = 2000;
export const IDLE_S = 600;

/**
 * `client(path, body)` reaches the runtime's piece API as this house; `runner(harness)` is a local runner here.
 * Resolves when the host leaves.
 */
export async function runBodyHost({ client, runner, env = process.env, cwd = process.cwd(), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), idleS = IDLE_S, beats = Infinity, log = () => {} }) {
  const mine = new Map();   // id -> {harness}
  const done = {};          // rid -> {id} | {error}
  const packing = new Map(); // id -> {parts: [string], next}
  let lastBusy = now();
  for (let beat = 0; beat < beats; beat++) {
    const bodies = {};
    for (const [id, b] of mine) {
      const r = runner(b.harness);
      let status = 'unknown';
      try { status = b.ended ? 'ended' : r.status({ id }); } catch { /* it can't say */ }
      const slot = (() => { try { return r.slotOf({ id }); } catch { return null; } })();
      bodies[id] = { harness: b.harness, status, ...(slot?.session ? { session: slot.session } : {}), feedable: !!r.inbox };
    }
    const packed = {};
    for (const [id, p] of packing) packed[id] = { part: p.next, parts: p.parts.length, data: p.parts[p.next] };
    let got;
    try { got = await client('body-sync', { report: { bodies, done, packed } }); } catch (e) { log(`sync failed: ${e.message}`); await sleep(SYNC_MS); continue; }
    for (const [id, part] of got.acked ?? []) {
      const p = packing.get(id);
      if (p && p.next === part) { p.next += 1; if (p.next >= p.parts.length) { packing.delete(id); mine.delete(id); } }
    }
    if (got.exit) { log(`leaving: ${got.reason ?? 'the runtime says so'}`); return; }
    const req = got.req ?? {};
    for (const rid of Object.keys(done)) if (!req[rid]) delete done[rid];
    for (const [rid, q] of Object.entries(req)) {
      if (done[rid]) continue;
      try {
        const r = runner(q.harness);
        const o = { brief: q.brief, model: q.model, deny: q.deny ?? [], cwd, env: { ...env, ...(q.key ? { LOOM_BODY_KEY: q.key } : {}) } };
        let written = [];
        let b;
        try {
          if (q.resume) { written = restoreFiles(r, q.files); b = await r.resume({ harness: q.harness, session: q.resume }, o); } else b = await r.start(o);
        } catch (e) { for (const w of written) rmSync(w, { recursive: true, force: true }); throw e; }
        mine.set(b.id, { harness: q.harness });
        done[rid] = { id: b.id };
        log(`started ${b.id} for ${rid}`);
      } catch (e) { done[rid] = { error: String(e.message).split('\n')[0].slice(0, 300) }; }
    }
    for (const [id, s] of Object.entries(got.stop ?? {})) {
      const b = mine.get(id);
      if (!b || b.ended) continue;
      const r = runner(b.harness);
      try { r.end({ id }); } catch { /* already gone */ }
      b.ended = true;
      if (s.pack) {
        const slot = (() => { try { return r.slotOf({ id }); } catch { return null; } })();
        let files = [];
        try { files = packSession(r, slot, { id }); } catch (e) { log(`packing ${id}: ${e.message}`); }
        dropSession(r, slot, { id });
        const all = Buffer.from(JSON.stringify(files)).toString('base64');
        const parts = [];
        for (let i = 0; i < all.length || i === 0; i += PART_CHARS) parts.push(all.slice(i, i + PART_CHARS));
        packing.set(id, { parts, next: 0 });
      }
      // A plain stop keeps the session's files: a warm resume continues that session here.
    }
    // An ended body is reported once its stop is answered, then forgotten (unless its session is still going back).
    for (const [id, b] of mine) if (b.ended && !got.stop?.[id] && !packing.has(id) && bodies[id]?.status === 'ended') mine.delete(id);
    for (const [id, items] of Object.entries(got.inbox ?? {})) {
      const b = mine.get(id);
      if (!b) continue;
      for (const it of items) runner(b.harness).feed({ id }, { id: it.id, text: it.text });
    }
    const working = Object.values(bodies).some((b) => b.status === 'working');
    if (working || Object.keys(req).length || packing.size) lastBusy = now();
    if (idleS && now() - lastBusy >= idleS * 1000) { log(`idle ${idleS}s: leaving`); return; }
    await sleep(SYNC_MS);
  }
}
