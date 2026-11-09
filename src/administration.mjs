// Durable scopes for administrative work. This is not a model launcher.
// API/approval/box transport is enabled only after its integration gates pass.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { StateError, load, withLock } from './state.mjs';
import { deliveryDir, holdsRun, loadConv } from './delivery.mjs';
import { mint, principalOf } from './principal.mjs';
import { approvalsRunAsync, approvalsWhy } from './approvals-call.mjs';
import { boxOwner, membersOf, ownsBox } from './owners.mjs';
import { mayHost } from './control.mjs';
import { ageSealer } from './sealed.mjs';
import { redact } from './redact.mjs';

const CV = /^cv-[0-9a-f]{12}$/;
const SCOPE = /^adm-[0-9a-f]{32}$/;
const APPROVAL = /^a-[0-9a-f]{8}$/;
const MAX_JOURNAL = 32 * 1024 * 1024;
export const ADMINISTRATION_KIND = 'box-administration';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 409) => { throw new StateError(message, status); };
const dir = env => join(env.LOOM_BOX_DATA || join(env.HOME || homedir(), '.local/share/loom-box'), 'administration');
const file = env => join(dir(env), 'journal.json');
const fresh = () => ({ v: 1, highWater: 0, scopes: {}, operations: {} });
const clock = o => { const n = (o.now?.() ?? new Date()).getTime(); if (!Number.isSafeInteger(n) || n <= 0) fail('administration needs a valid clock'); return n; };

function validate(j) {
  const map = v => v && typeof v === 'object' && !Array.isArray(v);
  const instant = n => Number.isSafeInteger(n) && n > 0;
  const broken = () => fail('administration journal cannot be decoded; access remains held', 503);
  if (j?.v !== 1 || !Number.isSafeInteger(j.highWater) || j.highWater < 0 || !map(j.scopes) || !map(j.operations)) broken();
  for (const [id, s] of Object.entries(j.scopes)) {
    if (!SCOPE.test(id) || s?.id !== id || !['requested', 'pending', 'activating', 'active', 'approval-unresolved', 'revoked', 'finished', 'denied', 'expired'].includes(s.state) || !instant(s.created) || s.created > j.highWater) broken();
    const fields = Object.fromEntries(['agent', 'conversation', 'authority', 'box', 'identity', 'work', 'why', 'cwd', 'minutes', 'execution'].map(k => [k, s[k]]));
    if (hash(fields) !== s.scopeHash || s.target !== `box:${s.box}:administration:${id}:${s.scopeHash.slice(0, 16)}`) broken();
    if (s.approval !== undefined && !APPROVAL.test(s.approval)) broken();
    if (['pending', 'activating', 'active', 'approval-unresolved'].includes(s.state) && !s.approval) broken();
    if (s.activation && (s.activation.approvedBy !== s.execution.owner || !instant(s.activation.prepared) || !instant(s.activation.approvalExpires) || !instant(s.activation.until) ||
        s.activation.until <= s.activation.prepared || s.activation.until > s.activation.approvalExpires || s.activation.until > s.activation.prepared + s.minutes * 60_000)) broken();
    if (['activating', 'active'].includes(s.state) && !s.activation || s.state === 'active' && !instant(s.activated)) broken();
  }
  for (const [id, r] of Object.entries(j.operations)) {
    if (!/^ado-[0-9a-f]{32}$/.test(id) || r?.id !== id || !j.scopes[r.scope] || !['queued', 'claimed', 'admitted', 'stop-requested', 'cancelled', 'finished', 'failed', 'unknown'].includes(r.state) ||
        !/^[0-9a-f]{64}$/.test(r.payloadHash ?? '') || typeof r.sealed !== 'string' || !instant(r.created) || !Number.isInteger(r.timeoutMs) || r.timeoutMs < 1 || r.timeoutMs > 600_000) broken();
    if (r.claim) {
      try { if (!same(workerFor(j.scopes[r.scope], r.claim.worker), r.claim.worker)) broken(); } catch { broken(); }
      if (!instant(r.claim.at) || r.claim.at < r.created || r.claim.at > j.highWater ||
          !/^[0-9a-f]{64}$/.test(r.claim.ticketHash ?? '') || typeof r.claim.sealedTicket !== 'string' ||
          r.claim.sealedTicket.length > 4096) broken();
    }
    if (['claimed', 'admitted', 'stop-requested'].includes(r.state) && !r.claim) broken();
    if (r.admission && (!r.claim || !instant(r.admission.at) || r.admission.at < r.claim.at || r.admission.at > j.highWater ||
        !same(r.admission.worker, r.claim.worker) || r.admission.ticketHash !== r.claim.ticketHash)) broken();
    if (['admitted', 'stop-requested'].includes(r.state) && !r.admission) broken();
    if (r.result && (!r.admission || !instant(r.result.at) || r.result.at < r.admission.at || r.result.at > j.highWater ||
        !/^[0-9a-f]{64}$/.test(r.result.hash ?? '') || typeof r.result.sealed !== 'string' || r.result.sealed.length > 1024 * 1024)) broken();
    if (['finished', 'failed'].includes(r.state) && !r.result) broken();
    if (r.result) {
      try { commandResult(r.result); } catch { broken(); }
      const expected = r.result.outcome === 'unknown' ? 'unknown' : r.result.outcome === 'not-started' ? 'cancelled' : r.result.exitCode === 0 ? 'finished' : 'failed';
      if (r.state !== expected) broken();
    }
  }
  return j;
}

function read(env) {
  let text;
  try {
    const fd = openSync(file(env), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.mode & 0o077 || s.size > MAX_JOURNAL || process.getuid && s.uid !== process.getuid()) fail('administration journal is not a bounded private file', 503);
      text = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(text) !== s.size) fail('administration journal changed while reading', 503);
    } finally { closeSync(fd); }
  } catch (error) { if (error.code === 'ENOENT') return fresh(); throw error; }
  let j; try { j = JSON.parse(text); } catch { fail('administration journal cannot be decoded', 503); }
  return validate(j);
}

function transaction(env, o, fn) {
  return withLock(dir(env), 'lock', () => {
    const j = read(env), at = clock(o);
    if (at < j.highWater) fail('administration clock moved backwards; access remains held', 503);
    j.highWater = at;
    const result = fn(j, at);
    validate(j);
    const text = JSON.stringify(j);
    if (Buffer.byteLength(text) > MAX_JOURNAL) fail('administration journal is full; retaining existing receipts', 503);
    mkdirSync(dir(env), { recursive: true, mode: 0o700 }); chmodSync(dir(env), 0o700);
    const temporary = file(env) + '.' + randomBytes(8).toString('hex') + '.tmp';
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file(env));
    // Approval consumption and later physical command admission must follow a
    // persisted intent, including the new directory's entry after a reboot.
    for (const path of [dir(env), dirname(dir(env))]) {
      const directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return result;
  }, 'administration records');
}

const authority = (env, c) => ({ principal: principalOf(env, c), reset: c.actsFor?.reset ?? null });
const same = (a, b) => hash(a) === hash(b);
function body(env, caller, q, o) {
  const c = CV.test(q?.conversation ?? '') ? loadConv(env, q.conversation) : null;
  if (!c || caller?.kind !== 'agent' || caller.service || caller.agent !== c.agent || !holdsRun(env, c.conversation, q, { ...o, caller })) fail('administration requires the current native body of its own conversation', 403);
  return { agent: c.agent, conversation: c.conversation, authority: authority(env, c) };
}

function box(env, scope) {
  const s = load(env), b = s.boxes[scope.box], members = membersOf(env);
  if (!b || b.reportOnly || !s.agents[scope.agent] || !ownsBox(b, scope.agent, members) || !mayHost(b, scope.agent, members)) fail('administration requires an eligible box owned by this agent’s owner', 403);
  const identity = b.administration?.identities?.[scope.identity], host = b.administration?.host;
  if (b.administration?.v !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(host ?? '') ||
      !Number.isInteger(identity?.uid) || !Number.isInteger(identity?.gid) || identity.uid < 0 || identity.gid < 0 ||
      identity.uid > 2147483647 || identity.gid > 2147483647 || (scope.identity === 'root' ? identity.uid !== 0 : identity.uid === 0)) fail('this box does not support the requested administrative identity');
  const execution = { host, owner: boxOwner(b, members), uid: identity.uid, gid: identity.gid };
  if (scope.execution && !same(scope.execution, execution)) fail('the approved box or OS identity changed');
  return execution;
}

function current(env, scope) {
  const c = loadConv(env, scope.conversation);
  return !!c && c.agent === scope.agent && same(authority(env, c), scope.authority);
}

function scopeOf(j, id) { if (!SCOPE.test(id ?? '') || !j.scopes[id]) fail('no such administration scope', 404); return j.scopes[id]; }
function access(env, scope, caller, q, o) {
  if (caller?.kind === 'owner' && (!Array.isArray(caller.agents) || caller.agents.includes(scope.agent))) {
    const b = load(env).boxes[scope.box];
    if (!caller.who && !Array.isArray(caller.agents) || caller.who === boxOwner(b, membersOf(env))) return;
    fail('only this box’s owner reads or revokes its administrative work', 403);
  }
  const ctx = body(env, caller, q, o);
  if (ctx.agent !== scope.agent || ctx.conversation !== scope.conversation || !same(ctx.authority, scope.authority)) fail('administration belongs to another conversation or principal', 403);
}

function plain(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`administration needs a plain ${name}`, 400);
  return value.trim();
}
function cwd(value) { if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail('administration needs an absolute working directory', 400); return value; }
function key(value) { if (typeof value !== 'string' || !value || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) fail('administration needs an idempotency key', 400); return value; }

const publicScope = s => ({ id: s.id, agent: s.agent, conversation: s.conversation, box: s.box, identity: s.identity,
  execution: structuredClone(s.execution), principal: structuredClone(s.authority.principal),
  work: s.work, why: s.why, cwd: s.cwd, minutes: s.minutes, state: s.state, created: s.created,
  ...(s.approval ? { approval: s.approval } : {}), ...(s.activation ? { until: s.activation.until } : {}) });
const publicOperation = r => ({ id: r.id, scope: r.scope, intent: r.intent, payloadHash: r.payloadHash,
  state: r.state, created: r.created, timeoutMs: r.timeoutMs,
  ...(r.cancelledBeforeAdmission ? { notStarted: true } : {}),
  ...(r.result ? { result: { hash: r.result.hash, at: r.result.at, outcome: r.result.outcome, exitCode: r.result.exitCode, signal: r.result.signal } } : {}) });

// The approval page normalizes display text. ASCII JSON escapes preserve the
// exact strings, including Unicode paths, without a visually different grant.
// Refuse an oversized card before saving a request; never truncate authority.
function approvalDetails(s) {
  const fields = Object.fromEntries(['agent', 'conversation', 'authority', 'box', 'identity', 'work', 'why', 'cwd', 'minutes', 'execution'].map(k => [k, s[k]]));
  const text = JSON.stringify(fields, null, 1).replace(/[^\x20-\x7e\n]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (text.length > 1000) fail('administration scope exceeds the approval card budget; shorten its work, reason or directory', 400);
  return text;
}

/** Persist one immutable scope before filing its approval. The transport uses
 * this stable target to reconcile a lost request response. */
export function requestAdministration(env, caller, q, o = {}) {
  const ctx = body(env, caller, q, o), minutes = q.minutes ?? 60;
  if (!['runner', 'root'].includes(q.identity) || !Number.isInteger(minutes) || minutes < 1 || minutes > 480) fail('administration needs runner or root identity and 1–480 minutes', 400);
  const fields = { ...ctx, box: q.box, identity: q.identity, work: plain(q.work, 'work description', 400), why: plain(q.why, 'reason', 200), cwd: cwd(q.cwd), minutes };
  fields.execution = box(env, fields);
  approvalDetails(fields);
  const id = 'adm-' + hash([ctx.agent, ctx.conversation, key(q.requestKey)]).slice(0, 32), scopeHash = hash(fields);
  return transaction(env, o, (j, at) => {
    const old = j.scopes[id];
    if (old) { if (old.scopeHash !== scopeHash) fail('administration request key already has another scope'); return publicScope(old); }
    const s = { ...fields, id, scopeHash, state: 'requested', created: at,
      target: `box:${fields.box}:administration:${id}:${scopeHash.slice(0, 16)}` };
    j.scopes[id] = s; return publicScope(s);
  });
}

/** Internal controller operation, not an agent API. Only the approval client
 * may attach the card it obtained for this immutable target. */
export function administrationApproval(env, id, approval, o = {}) {
  if (!APPROVAL.test(approval ?? '')) fail('invalid administration approval');
  return transaction(env, o, j => {
    const s = scopeOf(j, id);
    if (s.approval && s.approval !== approval) fail('administration already has another approval');
    if (s.state !== 'requested' && !s.approval) fail('administration no longer accepts an approval');
    s.approval ??= approval; if (s.state === 'requested') s.state = 'pending';
    return publicScope(s);
  });
}

function stop(j, scope, state, at) {
  scope.state = state; scope.ended = at;
  for (const r of Object.values(j.operations)) if (r.scope === scope.id) {
    if (['queued', 'claimed'].includes(r.state)) { r.state = 'cancelled'; r.cancelledBeforeAdmission = true; }
    else if (r.state === 'admitted') { r.state = 'stop-requested'; r.stopRequested = at; }
  }
}
function refresh(env, j, s, at) {
  if (!['requested', 'pending', 'activating', 'active'].includes(s.state)) return;
  let eligible = current(env, s);
  try { box(env, s); } catch { eligible = false; }
  if (!eligible) stop(j, s, 'revoked', at);
  else if (s.activation && at >= s.activation.until) stop(j, s, 'expired', at);
}
const approvalFor = s => s.authority.principal.owner ? 'owner' : s.authority.principal.for ?? '?';
function cardMatches(card, s) {
  return card?.id === s.approval && card.agent === s.agent && card.kind === ADMINISTRATION_KIND && card.target === s.target && card.for === approvalFor(s)
    && (!['allowed', 'used'].includes(card.state) || card.decidedBy === s.execution.owner);
}

/** Internal production approval client. It never accepts a body-supplied
 * statement or principal. Each consumption gets a fresh signed statement
 * after checking the saved scope against current conversation authority. */
export function administrationApprovals(env, o = {}) {
  const run = o.approvalsRun ?? ((argv) => approvalsRunAsync(env, argv));
  const as = s => JSON.stringify({ kind: 'agent', agent: s.agent, house: "loom's runtime" });
  const call = async argv => {
    const r = await run(argv);
    if (r.error || r.status !== 0) fail('administration approvals: ' + approvalsWhy(r), 503);
    return r.stdout;
  };
  return {
    async request(scope) {
      const proof = transaction(env, o, (j, at) => {
        const live = scopeOf(j, scope.id);
        refresh(env, j, live, at);
        if (live.state !== 'requested' || live.scopeHash !== scope.scopeHash) fail('administration scope no longer accepts an approval');
        return { scope: structuredClone(live), statement: mint(deliveryDir(env), {
          agent: live.agent, conversation: live.conversation, principal: principalOf(env, loadConv(env, live.conversation)),
        }, at) };
      });
      const s = proof.scope;
      const text = await call(['request', '--kind', ADMINISTRATION_KIND, '--target', s.target,
        '--what', 'Complete the scoped work on this box', '--ask', 'Allow this work on the box?',
        '--why', 'The agent needs host access to complete the work described below.',
        '--if-yes', 'The agent can run commands for this work until access expires or you revoke it.',
        '--if-no', 'Host access stays disabled.', '--details', approvalDetails(s),
        '--minutes', String(s.minutes), '--conversation', s.conversation, '--as', as(s), '--principal', proof.statement]);
      const id = /^(a-[0-9a-f]{8}):/.exec(text)?.[1];
      if (!id) fail('administration approval request response cannot be decoded', 503);
      return id;
    },
    async check(id, scope) {
      let card;
      const text = await call(['check', id, '--json', '--as', as(scope)]);
      try { card = JSON.parse(text); } catch { fail('administration approval response cannot be decoded', 503); }
      if (!card || typeof card !== 'object' || Array.isArray(card)) fail('administration approval response cannot be decoded', 503);
      return card;
    },
    async use(id, scope) {
      const proof = transaction(env, o, (j, at) => {
        const live = scopeOf(j, scope.id);
        refresh(env, j, live, at);
        if (live.approval !== id || live.scopeHash !== scope.scopeHash || live.state !== 'activating') fail('administration approval is no longer eligible for consumption');
        // refresh checked current principal/reset and exact box/OS identity.
        return { as: as(live), target: live.target, statement: mint(deliveryDir(env), {
          agent: live.agent, conversation: live.conversation, principal: principalOf(env, loadConv(env, live.conversation)),
        }, at) };
      });
      await call(['use', id, '--kind', ADMINISTRATION_KIND, '--target', proof.target,
        '--as', proof.as, '--principal', proof.statement]);
    },
  };
}

/** Reconcile filing after a lost response using the immutable approval target.
 * Only this controller can attach the result; body APIs cannot supply card ids. */
export async function fileAdministrationApproval(env, id, approvals, o = {}) {
  approvals ??= administrationApprovals(env, o);
  const s = transaction(env, o, (j, at) => {
    const live = scopeOf(j, id);
    refresh(env, j, live, at);
    return structuredClone(live);
  });
  if (s.state !== 'requested') return publicScope(s);
  const aid = await approvals.request(s);
  return administrationApproval(env, id, aid, o);
}

/** Called by the normal runtime delivery tick, without starting another model.
 * Refresh every lease, then bound slow approval calls and rotate pending work. */
export async function administrationTick(env, o = {}, only) {
  const initial = read(env);
  if (!Object.keys(initial.scopes).length) return;
  const pending = transaction(env, o, (j, at) => {
    for (const s of Object.values(j.scopes)) refresh(env, j, s, at);
    const batch = Object.values(j.scopes).filter(s => (!only || s.conversation === only) && ['requested', 'pending', 'activating'].includes(s.state))
      .sort((a, b) => (a.checked ?? 0) - (b.checked ?? 0) || a.id.localeCompare(b.id)).slice(0, 4);
    for (const s of batch) s.checked = at;
    return batch.map(s => s.id);
  });
  for (const id of pending) {
    try {
      await fileAdministrationApproval(env, id, undefined, o);
      await advanceAdministration(env, id, undefined, o);
    } catch (e) { (o.warn ?? console.warn)('administration ' + id + ': ' + e.message); }
  }
}

/** No external call runs under the journal lock. The allowed expiry and fixed
 * lease cutoff are committed BEFORE consumption. A used card without that
 * intent can never create or lengthen a lease. */
export async function advanceAdministration(env, id, approvals, o = {}) {
  approvals ??= administrationApprovals(env, o);
  let s = transaction(env, o, (j, at) => {
    const s = scopeOf(j, id);
    refresh(env, j, s, at);
    return structuredClone(s);
  });
  if (!['pending', 'activating'].includes(s.state)) return publicScope(s);
  let card = await approvals.check(s.approval, structuredClone(s));
  if (!cardMatches(card, s)) fail('administration approval does not match its immutable scope');
  s = transaction(env, o, (j, at) => {
    const live = scopeOf(j, id);
    refresh(env, j, live, at);
    if (!['pending', 'activating'].includes(live.state)) return structuredClone(live);
    if (['denied', 'expired'].includes(card.state)) { stop(j, live, card.state, at); return structuredClone(live); }
    if (card.state === 'allowed' && !live.activation) {
      const expires = Date.parse(card.expires);
      if (!Number.isSafeInteger(expires) || expires <= at) { stop(j, live, 'expired', at); return structuredClone(live); }
      live.activation = { prepared: at, approvedBy: card.decidedBy, approvalExpires: expires, until: Math.min(expires, at + live.minutes * 60_000) };
      live.state = 'activating';
    }
    if (card.state === 'used' && !live.activation) live.state = 'approval-unresolved';
    return structuredClone(live);
  });
  if (s.state !== 'activating') return publicScope(s);
  if (card.state === 'allowed') {
    // A lost use reply leaves this same activating scope. Next tick checks the
    // used receipt; it does not file another card or invent a fresh cutoff.
    await approvals.use(s.approval, structuredClone(s));
    card = await approvals.check(s.approval, structuredClone(s));
  }
  if (!cardMatches(card, s)) fail('administration consumption receipt changed scope');
  return transaction(env, o, (j, at) => {
    const live = scopeOf(j, id);
    refresh(env, j, live, at);
    if (live.state !== 'activating') return publicScope(live);
    if (card.state === 'used') { live.state = 'active'; live.activated = at; }
    else if (['denied', 'expired'].includes(card.state)) stop(j, live, card.state, at);
    return publicScope(live);
  });
}

/** Owner-only page inventory. Other household members do not inherit the
 * named box owner's work descriptions or command intents. */
export function listAdministration(env, caller, boxId, o = {}) {
  if (caller?.kind !== 'owner' || typeof caller.who !== 'string') return [];
  const initial = read(env);
  if (!Object.values(initial.scopes).some(s => s.box === boxId)) return [];
  return transaction(env, o, (j, at) => {
    const rows = [];
    for (const s of Object.values(j.scopes)) if (s.box === boxId) {
      try { access(env, s, caller, {}, o); }
      catch (e) { if (e instanceof StateError && e.status === 403) continue; throw e; }
      refresh(env, j, s, at);
      rows.push({ ...publicScope(s), operations: Object.values(j.operations).filter(r => r.scope === s.id).map(publicOperation) });
    }
    return rows.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  });
}

export function administrationStatus(env, caller, q, o = {}) {
  return transaction(env, o, (j, at) => {
    const s = scopeOf(j, q.scope); access(env, s, caller, q, o); refresh(env, j, s, at);
    return { ...publicScope(s), operations: Object.values(j.operations).filter(r => r.scope === s.id).map(publicOperation) };
  });
}

export function queueAdministration(env, caller, q, o = {}) {
  const ctx = body(env, caller, q, o);
  if (!Array.isArray(q.argv) || !q.argv.length || q.argv.length > 128 || q.argv.some(a => typeof a !== 'string' || a.includes('\0')) || !q.argv[0]) fail('administration needs bounded command arguments', 400);
  const timeoutMs = q.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 || q.stdin !== undefined && typeof q.stdin !== 'string') fail('administration needs a bounded command timeout and text stdin', 400);
  const intent = redact(plain(q.intent, 'command intent', 200));
  const requestKey = key(q.requestKey);
  const sealer = o.sealer ?? ageSealer(env, deliveryDir(env));
  return transaction(env, o, (j, at) => {
    const s = scopeOf(j, q.scope);
    if (ctx.agent !== s.agent || ctx.conversation !== s.conversation || !same(ctx.authority, s.authority) || !current(env, s)) fail('administration belongs to another conversation or principal', 403);
    if (q.identity !== undefined && q.identity !== s.identity) fail('an administrative command cannot change its approved identity');
    const payload = { argv: q.argv, stdin: q.stdin ?? '', cwd: q.cwd === undefined ? s.cwd : cwd(q.cwd), identity: s.identity, timeoutMs };
    const text = JSON.stringify(payload); if (Buffer.byteLength(text) > 128 * 1024) fail('administrative command input is too large', 413);
    const id = 'ado-' + hash([s.id, requestKey]).slice(0, 32), payloadHash = hash(payload), old = j.operations[id];
    if (old) { if (old.payloadHash !== payloadHash || old.intent !== intent) fail('administrative command key already has another payload'); return publicOperation(old); }
    box(env, s);
    if (s.state !== 'active' || !s.activation || at >= s.activation.until) fail('administration scope is not active');
    const sealed = sealer.seal(Buffer.from(text)).toString('base64');
    const committed = clock(o);
    if (committed < at) fail('administration clock moved backwards; access remains held', 503);
    if (committed >= s.activation.until) fail('administration expired while sealing the command');
    j.highWater = committed;
    const r = { id, scope: s.id, intent, payloadHash, sealed, timeoutMs, state: 'queued', created: committed };
    j.operations[id] = r; return publicOperation(r);
  });
}

// These are internal controller operations. They are not box API routes until
// the durable box worker and physical admission tests are implemented.
function administrativeBox(env, caller, { reporting = false } = {}) {
  const b = caller?.kind === 'piece' && load(env).boxes[caller.subject];
  if (!b || b.revoked || b.reportOnly && !reporting) fail('administration requires its enrolled workload box', 403);
  return caller.subject;
}
function workerIdentity(value) {
  if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.boot ?? '') ||
      !/^[0-9]{1,24}$/.test(value.birth ?? '') ||
      !Number.isInteger(value.uid) || !Number.isInteger(value.gid)) fail('administration needs an exact worker OS identity', 400);
  return { pid: value.pid, boot: value.boot, birth: value.birth, host: value.host, uid: value.uid, gid: value.gid };
}
function operationFor(j, id, boxId) {
  const r = j.operations[id], s = r && j.scopes[r.scope];
  if (!s || s.box !== boxId) fail('no administrative command for this box', 404);
  return { r, s };
}
function workerFor(scope, worker) {
  const w = workerIdentity(worker);
  if (w.host !== scope.execution.host || w.uid !== scope.execution.uid || w.gid !== scope.execution.gid) fail('administrative worker has another host or OS identity', 403);
  return w;
}

/** Polling is observation, never a command claim or permission to spawn. */
export function administrationWork(env, caller, o = {}) {
  const boxId = administrativeBox(env, caller);
  const initial = read(env);
  if (!Object.values(initial.operations).some(r => initial.scopes[r.scope]?.box === boxId)) return [];
  return transaction(env, o, (j, at) => {
    for (const s of Object.values(j.scopes)) if (s.box === boxId) refresh(env, j, s, at);
    return Object.values(j.operations).filter(r => j.scopes[r.scope].box === boxId &&
      ['queued', 'claimed', 'admitted', 'stop-requested', 'unknown'].includes(r.state)).map(r => ({ ...publicOperation(r), identity: j.scopes[r.scope].identity }));
  });
}

/** One immutable worker owns the command claim. A dead or unobserved worker
 * never grants a different worker the right to replay a possibly effective command. */
export function claimAdministration(env, caller, q, o = {}) {
  const boxId = administrativeBox(env, caller, { reporting: true }), sealer = o.sealer ?? ageSealer(env, deliveryDir(env));
  return transaction(env, o, (j, at) => {
    const { r, s } = operationFor(j, q.operation, boxId);
    const worker = workerFor(s, q.worker);
    refresh(env, j, s, at);
    if (r.claim && !same(r.claim.worker, worker)) fail('administrative command already belongs to another worker');
    if (s.state !== 'active' || !['queued', 'claimed'].includes(r.state)) return { claimed: false, operation: publicOperation(r) };
    const plain = sealer.open(Buffer.from(r.sealed, 'base64'));
    if (plain.length > 128 * 1024) fail('administrative payload exceeds its input budget', 503);
    const payload = JSON.parse(plain.toString('utf8'));
    if (hash(payload) !== r.payloadHash) fail('administrative payload changed; command remains held', 503);
    let ticket;
    if (r.claim) ticket = sealer.open(Buffer.from(r.claim.sealedTicket, 'base64')).toString('utf8');
    else {
      ticket = randomBytes(32).toString('hex');
      r.claim = { worker, at, ticketHash: hash(ticket), sealedTicket: sealer.seal(Buffer.from(ticket)).toString('base64') };
    }
    if (!/^[0-9a-f]{64}$/.test(ticket) || hash(ticket) !== r.claim.ticketHash) fail('administrative claim ticket cannot be reconciled', 503);
    const ready = clock(o);
    if (ready < at) fail('administration clock moved backwards; command remains held', 503);
    j.highWater = ready;
    refresh(env, j, s, ready);
    if (s.state !== 'active') return { claimed: false, operation: publicOperation(r) };
    r.state = 'claimed';
    return { claimed: true, operation: publicOperation(r), worker, ticket, payload, conversation: s.conversation, principalOwner: s.authority.principal.owner === true, until: s.activation.until };
  });
}

/** Commit authorization for the SAME worker, immediately before its physical
 * child gate. The box must persist this receipt and use its own one-shot gate.
 * Receiving this receipt again is NOT permission to launch another process. */
export function admitAdministration(env, caller, q, o = {}) {
  const boxId = administrativeBox(env, caller);
  return transaction(env, o, (j, at) => {
    const { r, s } = operationFor(j, q.operation, boxId);
    const worker = workerFor(s, q.worker);
    if (!r.claim || !same(r.claim.worker, worker) || typeof q.ticket !== 'string' || hash(q.ticket) !== r.claim.ticketHash) fail('administrative admission does not match its durable claim', 403);
    refresh(env, j, s, at);
    if (s.state !== 'active' || !['claimed', 'admitted'].includes(r.state)) return { authorized: false, operation: publicOperation(r) };
    const first = !r.admission;
    r.admission ??= { at, worker, ticketHash: r.claim.ticketHash };
    r.state = 'admitted';
    return { authorized: true, first, operation: publicOperation(r),
      receipt: { operation: r.id, payloadHash: r.payloadHash, worker, admittedAt: r.admission.at,
        until: s.activation.until, serverAt: at, remainingMs: s.activation.until - at } };
  });
}

/** A worker may observe revocation without obtaining another admission receipt. */
export function administrationCommandStatus(env, caller, q, o = {}) {
  const boxId = administrativeBox(env, caller, { reporting: true });
  return transaction(env, o, (j, at) => {
    const { r, s } = operationFor(j, q.operation, boxId), worker = workerFor(s, q.worker);
    if (!r.claim || !same(r.claim.worker, worker) || typeof q.ticket !== 'string' || hash(q.ticket) !== r.claim.ticketHash) fail('administrative observation does not match its claim', 403);
    refresh(env, j, s, at);
    return { operation: publicOperation(r), stop: s.state !== 'active' || ['cancelled', 'stop-requested'].includes(r.state) };
  });
}

/** A pre-admission cancellation fences a late admission. It never declares
 * an already admitted command absent, stopped, or safe to replay. */
export function cancelAdministrationClaim(env, caller, q, o = {}) {
  const boxId = administrativeBox(env, caller, { reporting: true });
  return transaction(env, o, (j, at) => {
    const { r, s } = operationFor(j, q.operation, boxId), worker = workerFor(s, q.worker);
    if (!r.claim || !same(r.claim.worker, worker) || typeof q.ticket !== 'string' || hash(q.ticket) !== r.claim.ticketHash) fail('administrative cancellation does not match its claim', 403);
    refresh(env, j, s, at);
    if (!r.admission && ['claimed', 'cancelled'].includes(r.state)) {
      r.state = 'cancelled'; r.cancelledBeforeAdmission = true;
      return { cancelled: true, operation: publicOperation(r) };
    }
    return { cancelled: false, operation: publicOperation(r) };
  });
}

function commandResult(value) {
  const { outcome, stdout = '', stderr = '', exitCode = null, signal = null, truncated = false } = value ?? {};
  if (!['exited', 'unknown', 'not-started'].includes(outcome) || typeof stdout !== 'string' || typeof stderr !== 'string' ||
      typeof truncated !== 'boolean' || Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 256 * 1024 ||
      !(exitCode === null || Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) ||
      !(signal === null || /^SIG[A-Z0-9]{1,16}$/.test(signal)) ||
      (outcome === 'exited' ? (exitCode === null) === (signal === null) : exitCode !== null || signal !== null)) fail('administration needs a bounded, explicit command result', 400);
  const result = { outcome, stdout, stderr, exitCode, signal, truncated };
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) fail('administrative result exceeds its encoded budget', 413);
  return result;
}

/** Results may arrive after expiry or revocation. This acknowledges observation,
 * never renewed execution authority. Retry cannot replace an immutable result. */
export function completeAdministrationCommand(env, caller, q, o = {}) {
  const boxId = administrativeBox(env, caller, { reporting: true }), result = commandResult(q.result);
  const sealer = o.sealer ?? ageSealer(env, deliveryDir(env)), resultHash = hash(result);
  return transaction(env, o, (j, at) => {
    const { r, s } = operationFor(j, q.operation, boxId), worker = workerFor(s, q.worker);
    if (!r.admission || !same(r.admission.worker, worker) || typeof q.ticket !== 'string' || hash(q.ticket) !== r.admission.ticketHash) fail('administrative result does not match its admission', 403);
    if (r.result) {
      if (r.result.hash !== resultHash) fail('administrative command already has another result');
      return publicOperation(r);
    }
    if (!['admitted', 'stop-requested'].includes(r.state)) fail('administrative command cannot accept a result');
    const sealed = sealer.seal(Buffer.from(JSON.stringify(result))).toString('base64');
    const saved = clock(o);
    if (saved < at) fail('administration clock moved backwards; result remains unacknowledged', 503);
    j.highWater = saved;
    r.result = { hash: resultHash, sealed, at: saved, outcome: result.outcome, exitCode: result.exitCode, signal: result.signal };
    r.state = result.outcome === 'unknown' ? 'unknown' : result.outcome === 'not-started' ? 'cancelled' : result.exitCode === 0 ? 'finished' : 'failed';
    return publicOperation(r);
  });
}

export function administrationResult(env, caller, q, o = {}) {
  const sealer = o.sealer ?? ageSealer(env, deliveryDir(env));
  return transaction(env, o, j => {
    const r = j.operations[q.operation], s = r && j.scopes[r.scope];
    if (!s) fail('no such administrative command', 404);
    access(env, s, caller, q, o);
    if (!r.result) return { operation: publicOperation(r), ready: false };
    const plain = sealer.open(Buffer.from(r.result.sealed, 'base64'));
    if (plain.length > 512 * 1024) fail('administrative result exceeds its encoded budget', 503);
    const result = commandResult(JSON.parse(plain.toString('utf8')));
    if (hash(result) !== r.result.hash || result.outcome !== r.result.outcome || result.exitCode !== r.result.exitCode || result.signal !== r.result.signal)
      fail('administrative result cannot be reconciled', 503);
    return { operation: publicOperation(r), ready: true, result };
  });
}

export function endAdministration(env, caller, q, o = {}) {
  return transaction(env, o, (j, at) => {
    const s = scopeOf(j, q.scope); access(env, s, caller, q, o);
    if (!['revoked', 'finished', 'denied', 'expired'].includes(s.state)) stop(j, s, caller.kind === 'owner' ? 'revoked' : 'finished', at);
    return publicScope(s);
  });
}
