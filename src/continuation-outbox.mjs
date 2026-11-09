// Internal mechanism only. No HTTP/CLI route may call this without first proving
// the current holder (key, session, house) or the clock's trusted delivery identity.
// originConversation is deliberately absent from this interface.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
export function continuationOutbox({ dir, sealer, now = Date.now }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = (id) => join(dir, `${id}.sealed`);
  const read = (id) => {
    try { return JSON.parse(sealer.open(readFileSync(path(id))).toString('utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const save = (id, value) => {
    const temp = join(dir, `.${id}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      writeFileSync(temp, sealer.seal(Buffer.from(JSON.stringify(value))), { flag: 'wx', mode: 0o600 });
      const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path(id));
      const dd = openSync(dir, 'r'); try { fsyncSync(dd); } finally { closeSync(dd); }
    } finally { rmSync(temp, { force: true }); }
  };
  const locked = (fn) => withLock(dir, 'outbox.lock', fn, 'continuation outbox');
  const grantId = (handle) => {
    if (typeof handle !== 'string' || !/^cont-[0-9a-f]{64}$/.test(handle)) deny('unknown continuation capability');
    return `grant-${digest(handle)}`;
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
      locked(() => save(grantId(handle), { source, issued: now(), binding: null }));
      return { handle };
    },
    // Called by authenticated clock admission, not by a body. Exact retries are
    // harmless; a capability cannot be rebound to a different firing or child run.
    bind(handle, clockBinding, currentSource, provenChild) {
      if (!wake.test(clockBinding?.wake ?? '') || typeof clockBinding.delivery !== 'string' || !clockBinding.delivery) deny('an exact clock firing is required');
      const child = snapshot(provenChild);
      return locked(() => {
        const id = grantId(handle), g = read(id);
        if (!g || !unchanged(g.source, currentSource)) deny('continuation source was reset or changed');
        if (child.agent !== g.source.agent || !same(child.principal, g.source.principal)) deny('continuation principal differs');
        const binding = { wake: clockBinding.wake, delivery: clockBinding.delivery, child };
        if (g.binding && !same(g.binding, binding)) deny('continuation capability is already bound');
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
        const row = { ref, grant: gid, child, on, text, hash: digest(text), state: 'pending', attempts: 0, next: now() };
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
    async drain({ current, post }) {
      for (const name of readdirSync(dir).filter((n) => /^report-[0-9a-f]{64}\.sealed$/.test(n))) {
        const id = name.slice(0, -7);
        const row = locked(() => {
          const r = read(id);
          if (!r || r.state !== 'pending' || r.next > now()) return null;
          const g = read(r.grant);
          const source = g && current(g.source.conversation), child = current(r.child.conversation);
          if (!g || !unchanged(g.source, source) || !unchanged(r.child, child) || child.run !== r.child.run) {
            r.state = 'failed'; r.reason = 'continuation authority was reset or changed'; save(id, r); return null;
          }
          r.attempts += 1;
          r.next = now() + Math.min(3600000, 1000 * 2 ** Math.min(r.attempts, 12));
          save(id, r);
          return { ...r, target: g.source.target, agent: g.source.agent, conversation: g.source.conversation };
        });
        if (!row) continue;
        let result;
        try { result = await post({ ref: row.ref, text: row.text, target: row.target, agent: row.agent, conversation: row.conversation, run: row.child.run, on: row.on ?? null }); }
        catch (e) {
          // Transport loss, throttling and request timeout can recover. A payload
          // conflict or other permanent client refusal cannot recover by replay.
          if (e?.status >= 400 && e.status < 500 && ![408, 425, 429].includes(e.status))
            result = { permanent: true, reason: e.message };
          else continue;
        } // A crash/timeout after acceptance retries the same ref.
        locked(() => {
          const r = read(id);
          if (r.state !== 'pending') return;
          if (result?.ok && result.posted === true) { r.state = 'delivered'; r.posted = true; delete r.reason; }
          else if (result?.permanent) { r.state = 'failed'; r.reason = String(result.reason ?? 'destination refused report').slice(0, 300); }
          // An accepted/pending response alone never means delivered.
          save(id, r);
        });
      }
    },
  };
}
