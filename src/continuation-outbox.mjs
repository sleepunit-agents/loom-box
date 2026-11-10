// Internal mechanism only. No HTTP/CLI route may call this without first proving
// the current holder (key, session, house) or the clock's trusted delivery identity.
// originConversation is deliberately absent from this interface.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StateError, withLock } from './state.mjs';

const digest = (s) => createHash('sha256').update(s).digest('hex');
const cv = /^cv-[0-9a-f]{12}$/;
const run = /^run-[0-9a-f]{12}$/;
const wake = /^w-[0-9a-f]{6}$/;
const report = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const deny = (why) => { throw new StateError(why, 403); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A snapshot made by runtime after holder proof, never accepted from request JSON.
 * reset is required even before a first reset (use null), principal is the runtime's
 * canonical principal, and target includes the immutable venue/place tuple.
 */
function snapshot(s) {
  if (!s || !cv.test(s.conversation ?? '') || !run.test(s.run ?? '') || !/^[a-z][a-z0-9-]{0,39}$/.test(s.agent ?? '') ||
      !Object.hasOwn(s, 'reset') || !s.principal || s.principal.unknown ||
      !(s.principal.owner === true || (typeof s.principal.for === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.principal.for))) || typeof s.target?.venue !== 'string' || typeof s.target?.place !== 'string' || s.resetPending) deny('no authenticated continuation snapshot');
  return structuredClone({ conversation: s.conversation, run: s.run, agent: s.agent, reset: s.reset, principal: s.principal, target: s.target });
}
const unchanged = (saved, current) => current && !current.resetPending && same(saved.principal, current.principal) &&
  saved.agent === current.agent && saved.conversation === current.conversation && same(saved.reset, current.reset) && same(saved.target, current.target);

/** Files contain only sealed records. fsync both file and directory before returning
 * a receipt; rename alone isn't a power-loss durability guarantee. Locks never span I/O.
 * post must implement stable-ref idempotency, including identical-payload checking.
 */
export function continuationOutbox({ dir, sealer, now = Date.now, lifetimeMs = null, retainMs = 7 * 86400000, maxLive = 20, maxReports = 20, warn = () => {} }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Reports with a final outcome live in done/: drain lists only the top level, so finished reports cost a tick
  // nothing (never opened again there), and only collection, hourly, reads done/.
  const doneDir = join(dir, 'done'), badDir = join(dir, 'unreadable');
  mkdirSync(doneDir, { recursive: true, mode: 0o700 });
  const FINAL = ['delivered', 'expired', 'failed', 'withdrawn'];
  const isFinal = (v) => FINAL.includes(v?.state);
  const path = (id, done = false) => join(done ? doneDir : dir, `${id}.sealed`);
  const open1 = (file) => {
    try { return JSON.parse(sealer.open(readFileSync(file)).toString('utf8')); }
    catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
  };
  const read = (id) => open1(path(id)) ?? (id.startsWith('report-') ? open1(path(id, true)) : undefined) ?? null;
  const syncDir = (d) => { const dd = openSync(d, 'r'); try { fsyncSync(dd); } finally { closeSync(dd); } };
  const save = (id, value) => {
    const done = id.startsWith('report-') && isFinal(value);
    const where = done ? doneDir : dir;
    const temp = join(where, `.${id}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      writeFileSync(temp, sealer.seal(Buffer.from(JSON.stringify(value))), { flag: 'wx', mode: 0o600 });
      const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path(id, done));
      syncDir(where);
    } finally { rmSync(temp, { force: true }); }
    // Then the other copy goes: a crash between leaves two, and read prefers the top level (re-saved next drain).
    if (id.startsWith('report-')) { rmSync(path(id, !done), { force: true }); syncDir(done ? dir : doneDir); }
  };
  const locked = (fn) => withLock(dir, 'outbox.lock', fn, 'continuation outbox');
  const grantId = (handle) => {
    if (typeof handle !== 'string' || !/^cont-[0-9a-f]{64}$/.test(handle)) deny('unknown continuation capability');
    return `grant-${digest(handle)}`;
  };
  // All authority clock observations are serialized and durable, including rollback.
  const observe = () => {
    const time = now(), previous = read('clock');
    if (!Number.isSafeInteger(time) || time < 0) deny('continuation clock is uncertain');
    if (previous && time < previous.highwater) deny('continuation clock moved backwards');
    save('clock', { highwater: time });
    return time;
  };
  const active = (id, g, time) => {
    if (g.version !== 2) deny('legacy continuation requires a new authenticated grant');
    if (g.expired || time >= g.expiresAt) {
      g.expired = true; save(id, g); deny('continuation expired');
    }
  };
  const expireRow = (r) => {
    r.state = r.attempts > 0 ? 'indeterminate' : 'expired';
    r.reason = r.attempts > 0 ? 'acceptance requires fenced reconciliation' : 'continuation expired before any attempt';
  };
  const receipt = (r) => ({ ref: r.ref, state: r.state, attempts: r.attempts, ...(r.reason ? { reason: r.reason } : {}), ...(r.posted ? { posted: true } : {}) });
  return {
    sourceConversation(handle) {
      const g = read(grantId(handle));
      if (!g) deny('unknown continuation capability');
      return g.source.conversation;
    },
    issue(provenSource) {
      const source = snapshot(provenSource);
      const handle = `cont-${randomBytes(32).toString('hex')}`;
      return locked(() => {
        if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) deny('continuation deadline policy is not configured');
        const issuedAt = observe(), expiresAt = issuedAt + lifetimeMs;
        if (!Number.isSafeInteger(expiresAt)) deny('invalid continuation deadline policy');
        // A bounded number live per source conversation (its deadlines in a plaintext ledger: ids and times only),
        // so no body can grow the outbox, and every tick's work, without limit.
        const ledger = join(dir, 'issued.json');
        let live = {};
        try { live = JSON.parse(readFileSync(ledger, 'utf8')); } catch { live = {}; }
        for (const k of Object.keys(live)) { live[k] = (Array.isArray(live[k]) ? live[k] : []).filter((t) => Number.isSafeInteger(t) && t > issuedAt); if (!live[k].length) delete live[k]; }
        const mine = live[source.conversation] ?? [];
        if (mine.length >= maxLive) throw new StateError(`${source.conversation} already has ${maxLive} live continuations: wait for one to reach its deadline`, 429);
        live[source.conversation] = [...mine, expiresAt];
        const tmp = `${ledger}.${randomBytes(6).toString('hex')}.tmp`;
        writeFileSync(tmp, JSON.stringify(live), { mode: 0o600 }); renameSync(tmp, ledger);
        save(grantId(handle), { version: 2, source, issuedAt, expiresAt, expired: false, binding: null });
        return { handle, expiresAt };
      });
    },
    // Internal clock preflight. The caller proves the issuer conversation before
    // calling this; neither a supplied deadline nor a handle proves that identity.
    inspect(handle, currentSource, issuer, scheduledAt) {
      return locked(() => {
        const id = grantId(handle), g = read(id);
        if (!g || !unchanged(g.source, currentSource)) deny('continuation source was reset or changed');
        if (issuer?.agent !== g.source.agent || issuer?.conversation !== g.source.conversation ||
            issuer?.for !== g.source.principal.for || issuer?.owner !== g.source.principal.owner || issuer?.unknown)
          deny('continuation issuer differs');
        active(id, g, observe());
        if (!Number.isSafeInteger(scheduledAt) || scheduledAt < 0 || scheduledAt >= g.expiresAt)
          deny('continuation must be scheduled before its deadline');
        if (g.binding || g.firing) deny('continuation capability is already bound');
        return { handle, expiresAt: g.expiresAt };
      });
    },
    checkFiring(handle, firing, currentSource, child) {
      return locked(() => {
        const id = grantId(handle), g = read(id);
        if (!g || !unchanged(g.source, currentSource)) deny('continuation source was reset or changed');
        if (firing.expiresAt !== g.expiresAt) deny('continuation deadline differs');
        if (child?.agent !== g.source.agent || !same(child?.principal, g.source.principal) || child?.resetPending)
          deny('continuation principal differs');
        // The bound child's own conversation starting again (a quota requeue of the same firing): it starts, with no
        // new authority (bind refuses any other run). Refusing it would kill the wake's work.
        if (g.binding && g.binding.wake === firing.wake && g.binding.delivery === firing.delivery && g.binding.child.conversation === child?.conversation)
          return { expiresAt: g.expiresAt, bound: true };
        if (g.binding) deny('continuation capability is already bound');
        active(id, g, observe());
        if (!wake.test(firing.wake ?? '') || typeof firing.delivery !== 'string' || !firing.delivery || !cv.test(child?.conversation ?? '')) deny('an exact clock firing is required');
        const claim = { wake: firing.wake, delivery: firing.delivery, conversation: child.conversation, reset: child.reset, target: child.target };
        if (g.firing && !same(g.firing, claim)) deny('continuation capability is already bound to another firing');
        if (!g.firing) { g.firing = structuredClone(claim); save(id, g); }
        return { expiresAt: g.expiresAt };
      });
    },
    // Called by authenticated clock admission, not by a body. Exact retries are
    // harmless; a capability cannot be rebound to a different firing or child run.
    bind(handle, clockBinding, currentSource, provenChild) {
      if (!wake.test(clockBinding?.wake ?? '') || typeof clockBinding.delivery !== 'string' || !clockBinding.delivery) deny('an exact clock firing is required');
      const child = snapshot(provenChild);
      return locked(() => {
        const id = grantId(handle), g = read(id);
        if (!g || !unchanged(g.source, currentSource)) deny('continuation source was reset or changed');
        if (g.version === 2 && clockBinding.expiresAt !== g.expiresAt) deny('continuation deadline differs');
        if (child.agent !== g.source.agent || !same(child.principal, g.source.principal)) deny('continuation principal differs');
        const claim = { wake: clockBinding.wake, delivery: clockBinding.delivery, conversation: child.conversation, reset: child.reset, target: child.target };
        if (g.firing && !same(g.firing, claim)) deny('continuation capability is already bound to another firing');
        const binding = { wake: clockBinding.wake, delivery: clockBinding.delivery, child };
        if (g.binding && !same(g.binding, binding)) deny('continuation capability is already bound');
        if (g.binding) return { bound: true }; // Existing admission can recover receipts after cutoff.
        active(id, g, observe());
        g.binding = binding; save(id, g);
        return { bound: true };
      });
    },
    enqueue(handle, provenChild, currentSource, { id, text }, { on = null } = {}) {
      if (!report.test(id ?? '') || typeof text !== 'string' || !text.length || text.length > 40000) throw new StateError('a report needs an id and 1-40000 characters', 400);
      const child = snapshot(provenChild);
      return locked(() => {
        const gid = grantId(handle), g = read(gid);
        if (!g?.binding || !same(g.binding.child, child) || !unchanged(g.source, currentSource)) deny('not the bound continuation run');
        const ref = `continuation-${digest(`${gid}:${id}`)}`;
        const rid = `report-${digest(ref)}`;
        const prior = read(rid);
        if (prior) {
          if (prior.hash !== digest(text)) throw new StateError('report id already used for different text', 409);
          return receipt(prior);
        }
        const time = observe(); active(gid, g, time);
        // A bounded number of reports per continuation: a looping child can't grow the outbox without limit.
        if ((g.reports ?? 0) >= maxReports) throw new StateError(`this continuation has sent its ${maxReports} reports`, 429);
        g.reports = (g.reports ?? 0) + 1; save(gid, g);
        const row = { version: 2, expiresAt: g.expiresAt, ref, grant: gid, child, on, text, hash: digest(text), state: 'pending', attempts: 0, next: now() };
        save(rid, row);
        return receipt(row);
      });
    },
    status(handle, provenChild, id, currentSource) {
      const gid = grantId(handle), g = read(gid);
      if (!g?.binding || !same(g.binding.child, snapshot(provenChild)) || (currentSource !== undefined && !unchanged(g.source, currentSource))) deny('not the bound continuation run');
      const r = read(`report-${digest(`continuation-${digest(`${gid}:${id}`)}`)}`);
      return r ? receipt(r) : null;
    },
    // current returns runtime-owned snapshots, not body input. Recheck both sides
    // immediately before every attempt. A different current source run is fine;
    // a different child run, reset or principal never is.
    // `placeOf(source)` (optional, sync): where a post for this source goes, or null when it isn't there yet. Settled
    // once, under the lock, before any attempt is counted, and kept on the row (`place`), so a reconcile asks about the
    // very place a post may have reached, whatever becomes of the source's record later (t-2004).
    async drain({ current, post, reconcile, placeOf }) {
      for (const name of readdirSync(dir).filter((n) => /^report-[0-9a-f]{64}\.sealed$/.test(n))) {
        const id = name.slice(0, -7);
        let row;
        // One record that won't open (a damaged file, a replaced key) is skipped and said, never a stop for the rest.
        try { row = locked(() => {
          const r = read(id);
          if (r && isFinal(r)) { save(id, r); return null; } // an older layout's finished row: moved to done/
          if (!r || !['pending', 'indeterminate'].includes(r.state)) return null;
          const recovering = r.state === 'indeterminate';
          const g = read(r.grant);
          let time;
          try { time = observe(); } catch { return null; } // Hold; no write attempt during clock uncertainty.
          if (g?.version !== 2 || r.version !== 2) {
            r.state = r.attempts > 0 ? 'indeterminate' : 'expired'; r.reason = 'legacy continuation held; no implicit renewal'; save(id, r); return null;
          }
          if (r.expiresAt !== g.expiresAt) { r.state = 'indeterminate'; r.reason = 'deadline commitment differs'; save(id, r); return null; }
          if (g.expired || time >= g.expiresAt) {
            g.expired = true; save(r.grant, g); expireRow(r); save(id, r);
            if (r.state !== 'indeterminate' || !reconcile) return null;
          }
          // Backoff for both: posting by attempts, reconciling by its own count (never a core call every tick).
          if (r.next > time) return null;
          // Reconciliation only asks core what became of the exact sealed payload; it can't post. So an uncertain
          // row is resolved even after its source or child changed; only a new post needs current authority.
          const asking = recovering || r.state === 'indeterminate';
          const source = g && current(g.source.conversation), child = current(r.child.conversation);
          if (!g || (!asking && (!unchanged(g.source, source) || !unchanged(r.child, child) || child.run !== r.child.run))) {
            // Not every tick: an unchanged reset stays unchanged. Checked again after the backoff.
            r.state = r.attempts > 0 ? 'indeterminate' : 'failed'; r.reason = 'continuation authority was reset or changed';
            r.next = time + 3600000; save(id, r); return null;
          }
          const reconciliation = recovering || r.state === 'indeterminate';
          if (reconciliation && !reconcile) return null;
          if (!reconciliation && r.place === undefined && placeOf) {
            const at = placeOf(g.source);
            // Not there yet (a spawn's Comms thread not opened): no attempt, nothing sent; its own backoff, under the
            // deadline above, so a row that never finds its place expires as never attempted.
            if (typeof at !== 'string' || !at) {
              r.waits = (r.waits ?? 0) + 1;
              r.next = time + Math.min(3600000, 5000 * 2 ** Math.min(r.waits, 12));
              save(id, r); return null;
            }
            r.place = at;
          }
          if (!reconciliation) r.attempts += 1; else r.reconciles = (r.reconciles ?? 0) + 1;
          r.next = now() + Math.min(3600000, (reconciliation ? 5000 : 1000) * 2 ** Math.min(reconciliation ? r.reconciles : r.attempts, 12));
          save(id, r);
          return { ...r, reconciliation, target: g.source.target, agent: g.source.agent, conversation: g.source.conversation, place: r.place };
        }); } catch (e) {
          if (e instanceof StateError) throw e;
          // Said once, then set aside in unreadable/ (kept, never deleted: a restored key may open it). While anything
          // is there, no grant is collected.
          try { mkdirSync(badDir, { recursive: true, mode: 0o700 }); renameSync(path(id), join(badDir, `${id}.sealed`)); } catch { /* said again next tick */ }
          warn(`continuation ${id} won't open (${e.message}): set aside in unreadable/; grants are kept until it's gone`);
          continue;
        }
        if (!row) continue;
        let result;
        try { result = await (row.reconciliation ? reconcile : post)({ ref: row.ref, text: row.text, target: row.target, agent: row.agent, conversation: row.conversation, place: row.place, run: row.child.run, on: row.on ?? null, expiresAt: row.expiresAt }); }
        catch (e) {
          // Transport loss, throttling and request timeout can recover. A payload
          // conflict or other permanent client refusal cannot recover by replay.
          if (e?.status >= 400 && e.status < 500 && ![408, 425, 429].includes(e.status))
            result = { permanent: true, reason: e.message };
          else continue;
        } // A crash/timeout after acceptance retries the same ref.
        locked(() => {
          const r = read(id);
          // Another tick resolved (and perhaps collected) it while this answer was in flight.
          if (!r || !['pending', 'indeterminate', 'expired'].includes(r.state)) return;
          if (result?.ok && (row.reconciliation ? result.state === 'delivered' && typeof result.id === 'string' && result.id.length > 0 : result.posted === true)) { r.state = 'delivered'; r.posted = true; delete r.reason; }
          else if (row.reconciliation && result?.ok && result.state === 'not-accepted') { r.state = 'expired'; r.reason = 'core fenced acceptance and found no accepted report'; }
          // Core's thread tombstone refuses every later post: nothing can land there again.
          else if (row.reconciliation && result?.ok && result.state === 'deleted') { r.state = 'withdrawn'; r.reason = 'the destination thread was deleted'; }
          else if (result?.permanent) { r.state = 'indeterminate'; r.reason = String(result.reason ?? 'destination refused report').slice(0, 300); }
          // An accepted/pending response alone never means delivered.
          save(id, r);
        });
      }
    },
    // Bounded retention. Only after the shared deadline plus retainMs, and only
    // terminal outcomes: an expired grant can never bind, enqueue or post again
    // (every path checks the deadline against the persisted highwater), so its
    // records may go. Pending/indeterminate rows stay until drain resolves them,
    // and a grant stays while any row still names it. Legacy records are held.
    collect({ every = 0 } = {}) {
      // At most once per `every` ms (the tick asks hourly): a plaintext stamp, so a quiet outbox costs a stat.
      const stamp = join(dir, 'collected-at');
      if (every > 0) { try { if (now() - statSync(stamp).mtimeMs < every) return { reports: 0, grants: 0, skipped: true }; } catch { /* first */ } }
      return locked(() => {
        let time;
        try { time = observe(); } catch { return { reports: 0, grants: 0 }; } // Hold during clock uncertainty.
        try { writeFileSync(stamp, '', { mode: 0o600 }); utimesSync(stamp, time / 1000, time / 1000); } catch { /* best effort */ }
        const names = readdirSync(dir);
        const old = (x) => x?.version === 2 && Number.isSafeInteger(x.expiresAt) && x.expiresAt + retainMs <= time;
        const held = new Set();
        let reports = 0, grants = 0, unreadable = false;
        const isReport = (n) => /^report-[0-9a-f]{64}\.sealed$/.test(n);
        for (const [n, done] of [...names.filter(isReport).map((n) => [n, false]), ...readdirSync(doneDir).filter(isReport).map((n) => [n, true])]) {
          const id = n.slice(0, -7);
          let r; try { r = open1(path(id, done)); } catch (e) { unreadable = true; warn(`continuation ${id}: ${e.message}`); continue; }
          if (!r) continue;
          if (old(r) && isFinal(r)) { rmSync(path(id, done), { force: true }); reports += 1; }
          else held.add(r.grant);
        }
        // A report that won't open might name any grant: keep them all until it does (or is removed).
        let setAside = false; try { setAside = readdirSync(badDir).length > 0; } catch { /* none */ }
        if (unreadable || setAside) { if (reports) { syncDir(dir); syncDir(doneDir); } return { reports, grants: 0 }; }
        for (const n of names.filter((n) => /^grant-[0-9a-f]{64}\.sealed$/.test(n))) {
          const id = n.slice(0, -7);
          if (held.has(id)) continue;
          let g; try { g = read(id); } catch (e) { warn(`continuation ${id}: ${e.message}`); continue; }
          if (old(g)) { rmSync(path(id), { force: true }); grants += 1; }
        }
        if (reports || grants) { syncDir(dir); syncDir(doneDir); }
        return { reports, grants };
      });
    },
  };
}
