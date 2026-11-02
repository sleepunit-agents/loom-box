// Bodies in the agent's own warm house (loom docs/specs/bridges.md, "Bodies before the one service"; agent-runtime.md,
// section 5), ported from shuttle's bodies.py: delivery says who to wake and for what; a body host in the agent's
// house (bodyhost.mjs) wakes them, with that house's harness, its login, its repo, its secrets and its agent's token.
// The runtime never runs a body on loom's own machine.
//
// The control plane's side is HouseRunner: the runner interface (runners.mjs) over a house. Each agent has one host
// record, <data>/delivery/hosts/<agent>.json:
//   house    the agent's warm house (asked for through `up`, placed by placement.mjs)
//   report   the host's last sync: {at, house, bodies: {id: {harness, status, session, feedable}}, done: {rid: {id}|{error}}}
//   req      bodies to start: {rid: {at, sealed}}  (the brief, the model, its run's key, a resume's session files: sealed)
//   stop     {id: {pack}}: bodies to end (pack: send their session files back first, for a slot)
//   inbox    {id: [{key, sealed}]}: follow-ups for a body mid-turn
// and packed/<id>.age: a body's session files, sent back in parts by its host, sealed whole.
//
// The host reaches it through the piece API, `body-sync`, as its house's own token (an agent caller with its house):
// an agent's host sees only its own agent's record, and only the house the record names (or a live house of that
// agent, adopted when the record names none).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LIVE, up } from './control.mjs';
import { pieceName } from './piece.mjs';
import { bodyBox } from './placement.mjs';
import { RunnerError } from './runners.mjs';
import { ageSealer } from './sealed.mjs';
import { AGENT_NAME, StateError, load, withLock } from './state.mjs';

/** A host report older than this: no host (its house is gone, or its host stopped). */
export const HOST_STALE_MS = 30_000;
/** How long a start waits for the house (a cold one is about 10 s, plus the image) and then for the body. */
export const WARM_MS = 150_000;
export const CLAIM_MS = 60_000;
/** A packed session travels in parts this big (base64), inside loom's piece API body cap. */
export const PART_CHARS = 360 * 1024;
const RID = /^[0-9a-f]{16}$/;
/** A body ref's id part, as bodies.mjs takes it: a house's body id (house, dash, the harness's id) fits it, or is refused. */
export const MAX_BODY_ID = 64;
const BODY_REF = new RegExp(`^[A-Za-z0-9-]{4,${MAX_BODY_ID}}$`);
const BODY_ID = /^[A-Za-z0-9-]{4,64}$/;
const HOUSE = /^h-[0-9]{1,9}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A part transfer that hasn't finished in this long is given up, and swept. */
export const PARTS_MS = 3_600_000;
/** A request given up on (its claim wait ran out) is remembered this long, so a body its house starts late is stopped. */
const CANCEL_MS = 600_000;

/**
 * What waits in the host record for its house, sealed: a request (its brief) and a follow-up. Without age, these alone
 * are held in the clear (0600), only until the house takes them, so delivery still works; nothing else is kept then
 * (no slot, no queue: the next body starts fresh). `P:` marks one held that way.
 */
function transit(sealer) {
  return {
    seal(b) { try { return `A:${sealer.seal(b).toString('base64')}`; } catch { return `P:${Buffer.from(b).toString('base64')}`; } },
    open(t) { return String(t).startsWith('P:') ? Buffer.from(t.slice(2), 'base64') : sealer.open(Buffer.from(String(t).replace(/^A:/, ''), 'base64')); },
  };
}

/**
 * Transfers nobody will finish or collect: part transfers older than an hour (their parts are sealed, but a stopped
 * transfer never completes), and a session sent back that no pack() collected within the claim window (a pack that
 * gave up waiting). No slot ever references a packed file: a slot is its own file, sealed again by delivery.
 */
export function sweepTransfers(env, nowMs = Date.now(), fileNowMs = Date.now()) {
  const ls = (d) => { try { return readdirSync(d); } catch { return []; } };
  const parts = join(hostsDir(env), 'parts');
  for (const a of ls(parts)) for (const h of ls(join(parts, a))) for (const id of ls(join(parts, a, h))) {
    const dir = join(parts, a, h, id);
    const at = readJson(join(dir, 'at.json'));
    if (typeof at !== 'number' || nowMs - at >= PARTS_MS) rmSync(dir, { recursive: true, force: true });
  }
  const packed = join(hostsDir(env), 'packed');
  for (const a of ls(packed)) for (const h of ls(join(packed, a))) for (const f of ls(join(packed, a, h))) {
    const p = join(packed, a, h, f);
    // By its file's own time: a packed file is a file, and its clock is the disk's.
    try { if (fileNowMs - statSync(p).mtimeMs >= 2 * CLAIM_MS) rmSync(p, { force: true }); } catch { /* gone */ }
  }
}

// The body host's own credential (never a body's): its house's task carries a one-time boot key; its first sync trades
// it for the host's key, held only in the host process's memory. A body in the house has its agent's token and its
// run's key, and neither reaches body-sync.
const keyHash = (k) => createHash('sha256').update(String(k)).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const dataDir = (env) => env.LOOM_BOX_DATA || join(env.HOME || '', '.local', 'share', 'loom-box');
const hostsDir = (env) => join(dataDir(env), 'delivery', 'hosts');
const hostFile = (env, agent) => join(hostsDir(env), `${agent}.json`);
// Every path is the agent's and the house's own, and an id is checked before it names one.
const safe = (agent, house, id) => AGENT_NAME.test(agent ?? '') && HOUSE.test(house ?? '') && BODY_ID.test(id ?? '');
const packedFile = (env, agent, house, id) => { if (!safe(agent, house, id)) throw new StateError('not a body of a house', 400); return join(hostsDir(env), 'packed', agent, house, `${id}.age`); };
const partDir = (env, agent, house, id) => { if (!safe(agent, house, id)) throw new StateError('not a body of a house', 400); return join(hostsDir(env), 'parts', agent, house, id); };
/**
 * A body's id, as the runtime knows it: its house's id, then the id the house's harness gave it. House ids are never
 * reused, so no house can report an id that's another house's body (another agent's, or its own agent's earlier house).
 */
export const bodyIdOf = (house, raw) => `${house}-${raw}`;
const rawOf = (body) => (body?.house && HOUSE.test(body.house) && String(body.id).startsWith(`${body.house}-`) ? String(body.id).slice(body.house.length + 1) : null);

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
function writeJson(p, v) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(v) + '\n', { mode: 0o600 });
  renameSync(tmp, p);
}

const hostLocked = (env, f) => withLock(hostsDir(env), 'lock', f, 'the body hosts', 10_000);
const loadHost = (env, agent) => readJson(hostFile(env, agent)) ?? { agent, req: {}, stop: {}, inbox: {} };
export const hostOf = loadHost;
const houseLive = (env, id) => { try { return LIVE.has(load(env).houses[id]?.state) && load(env).houses[id]; } catch { return false; } };
const fresh = (h, now) => !!h.report && now - h.report.at < HOST_STALE_MS && h.report.house === h.house;

/** What a house runs as its task to be the agent's body host. */
export const hostTask = (env, bootKey) => `loom-runtime body-host --piece ${pieceName(env)} --host-key ${bootKey}`;

// ─── The host's sync (the piece API's `body-sync`) ─────────────────────────

function cleanReport(r) {
  const bodies = {};
  for (const [id, b] of Object.entries(r?.bodies ?? {}).slice(0, 64)) {
    if (!BODY_ID.test(id) || !b || typeof b !== 'object') continue;
    bodies[id] = {
      harness: ['claude', 'codex'].includes(b.harness) ? b.harness : 'unknown',
      status: ['working', 'idle', 'ended', 'unknown'].includes(b.status) ? b.status : 'unknown',
      ...(typeof b.session === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(b.session) ? { session: b.session } : {}),
      feedable: b.feedable === true,
      pending: Array.isArray(b.pending) ? b.pending.filter((k) => typeof k === 'string' && k.length <= 64).slice(0, 64) : [],
    };
  }
  const done = {};
  for (const [rid, d] of Object.entries(r?.done ?? {}).slice(0, 64)) {
    if (!RID.test(rid) || !d || typeof d !== 'object') continue;
    if (typeof d.id === 'string' && BODY_ID.test(d.id)) done[rid] = { id: d.id };
    else done[rid] = { error: String(d.error ?? 'its host couldn\'t start it').slice(0, 300) };
  }
  return { bodies, done };
}

/**
 * POST /api/<piece>/body-sync {report: {bodies, done, packed: {id: {part, parts, data}}}}, from an agent's house:
 * its report goes into its agent's host record, and it's answered what to start, stop and feed.
 */
export function bodySync(env, caller, body, o = {}) {
  if (caller?.kind !== 'agent' || !AGENT_NAME.test(caller.agent ?? '')) throw new StateError('body-sync is a body host\'s, in its agent\'s house', 403);
  const agent = caller.agent;
  // Which house this is, only from its token (core gives the caller's house): never from what it says.
  const house = caller.house;
  if (!HOUSE.test(house ?? '')) throw new StateError('body-sync comes from a house, and this token names none', 403);
  const sealer = o.sealer ?? ageSealer(env, join(dataDir(env), 'delivery'));
  const t = transit(sealer);
  const now = (o.now ?? (() => new Date()))().getTime();
  return hostLocked(env, () => {
    const h = loadHost(env, agent);
    if (h.house !== house) return { exit: true, reason: `${agent}'s bodies are ${h.house ?? 'nowhere'}'s now` };
    // Only the body host, with its own key: never a body (an agent's token in the house is all a body has).
    const given = keyHash(body?.hostKey ?? '');
    let issued;
    if (!(h.hostHash && sameHash(given, h.hostHash))) {
      if (!(h.bootHash && sameHash(given, h.bootHash))) throw new StateError('body-sync takes the body host\'s own key: a body in the house has none', 403);
      // The boot key, once: traded for the host's own key, which only the host process holds.
      issued = randomBytes(24).toString('hex');
      h.hostHash = keyHash(issued);
      delete h.bootHash;
    }
    const { bodies, done } = cleanReport(body?.report);
    // An id this house already gave one request is never another's (a second claim of the same body is refused).
    h.claimed ??= {};
    for (const [rid, d] of Object.entries(done)) {
      if (!d.id || !h.req?.[rid]) continue;
      if (h.claimed[d.id] && h.claimed[d.id] !== rid) done[rid] = { error: `${house} reported ${d.id} for a second request` };
      else h.claimed[d.id] = rid;
    }
    h.report = { at: now, house, bodies, done };
    // A request given up on whose body the house started late: stopped, never run.
    h.cancel ??= {};
    for (const [rid, at] of Object.entries(h.cancel)) {
      if (done[rid]?.id) { (h.stop ??= {})[done[rid].id] = { pack: false, at: now }; delete h.cancel[rid]; } else if (now - at > CANCEL_MS) delete h.cancel[rid];
    }
    // Follow-ups the house says it took leave the record; until then they're sent again (and it hears each once).
    for (const [id, keys] of Object.entries(body?.report?.inboxAck ?? {})) {
      if (!BODY_ID.test(id) || !Array.isArray(keys) || !h.inbox?.[id]) continue;
      h.inbox[id] = h.inbox[id].filter((x) => !keys.includes(x.key));
      if (!h.inbox[id].length) delete h.inbox[id];
    }
    // A packed session, in parts: each sealed as it comes (never on disk in the clear), then opened and sealed whole.
    const got = [];
    for (const [id, p] of Object.entries(body?.report?.packed ?? {}).slice(0, 8)) {
      if (!BODY_ID.test(id) || !Number.isSafeInteger(p?.part) || !Number.isSafeInteger(p?.parts) || p.part < 0 || p.part >= p.parts) continue;
      // A pack nobody's waiting for any more (its stop was dropped): its parts are acknowledged and thrown away, so its
      // house finishes the transfer and can idle out.
      if (!h.stop?.[id]?.pack) { got.push([id, p.part]); continue; }
      if (!Number.isSafeInteger(p?.part) || !Number.isSafeInteger(p?.parts) || p.parts < 1 || p.parts > 64 || p.part < 0 || p.part >= p.parts || typeof p.data !== 'string' || p.data.length > PART_CHARS) continue;
      const dir = partDir(env, agent, house, id);
      let sealedPart;
      try { sealedPart = sealer.seal(Buffer.from(p.data)); } catch { continue; } // no key: not kept (and not acked)
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!existsSync(join(dir, 'at.json'))) writeJson(join(dir, 'at.json'), now);
      writeFileSync(join(dir, `${p.part}.age`), sealedPart, { mode: 0o600 });
      got.push([id, p.part]);
      const files = Array.from({ length: p.parts }, (_, i) => join(dir, `${i}.age`));
      if (files.every((f) => existsSync(f))) {
        const whole = Buffer.from(files.map((f) => sealer.open(readFileSync(f)).toString()).join(''), 'base64');
        const f = packedFile(env, agent, house, id);
        mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
        writeFileSync(f, sealer.seal(whole), { mode: 0o600 });
        rmSync(dir, { recursive: true, force: true });
      }
    }
    // A stop is done once its body is gone from the report (and its pack, if it was asked for, is in).
    for (const id of Object.keys(h.stop ?? {})) {
      const gone = !bodies[id] || bodies[id].status === 'ended';
      if (gone && (!h.stop[id].pack || existsSync(packedFile(env, agent, house, id)) || now - h.stop[id].at > CLAIM_MS)) delete h.stop[id];
    }
    const req = {};
    for (const [rid, r] of Object.entries(h.req ?? {})) {
      if (done[rid] || h.cancel[rid]) continue;
      try { req[rid] = JSON.parse(t.open(r.sealed).toString('utf-8')); } catch { /* its text is gone: never started */ }
    }
    const inbox = {};
    for (const [id, items] of Object.entries(h.inbox ?? {})) {
      inbox[id] = items.flatMap((x) => { try { return [{ id: x.key, text: t.open(x.sealed).toString('utf-8') }]; } catch { return []; } });
    }
    writeJson(hostFile(env, agent), h);
    return { req, stop: h.stop ?? {}, inbox, acked: got, ...(issued ? { hostKey: issued } : {}) };
  });
}

// ─── The runner interface over a house ──────────────────────────────────────

/**
 * A runner whose bodies run in their agent's warm house. Its start asks for the house when there's none (placed
 * on a box its owner owns, with the harness logged in), waits for its host, hands it the request and waits for the
 * body; feeding, ending and status go through the host record. `remote`: a slot's files travel with the resume.
 */
export class HouseRunner {
  remote = true;

  constructor(env, harness, o = {}) {
    Object.assign(this, { env, harness, sealer: o.sealer ?? ageSealer(env, join(dataDir(env), 'delivery')), now: o.now ?? (() => new Date()), up: o.up ?? up, warmMs: o.warmMs ?? WARM_MS, claimMs: o.claimMs ?? CLAIM_MS, poll: o.poll ?? 250 });
    this.transit = transit(this.sealer);
  }

  /** Whether the runtime's key works here (age is installed): without it, no session is kept (no slot). */
  canSeal() {
    if (this.sealable === undefined) { try { this.sealer.seal(Buffer.from('?')); this.sealable = true; } catch { this.sealable = false; } }
    return this.sealable;
  }

  host(agent) { return loadHost(this.env, agent); }

  /** The agent's house with its body host up: asked for when there's none. */
  async warm(agent) {
    const end = Date.now() + this.warmMs;
    for (;;) {
      const now = this.now().getTime();
      const h = this.host(agent);
      if (fresh(h, now)) return h.house;
      if (!h.house || !houseLive(this.env, h.house)) {
        const s = load(this.env);
        const at = bodyBox(s, agent, this.harness, this.env);
        if (!at.box) throw new RunnerError(at.reason);
        const boot = randomBytes(24).toString('hex');
        const r = this.up(this.env, { now: () => this.now() }, { kind: 'owner' }, { agent, box: at.box, task: hostTask(this.env, boot) });
        // A new house: what was asked of the last one (and what it claimed) isn't this one's, nor is its host's key.
        hostLocked(this.env, () => { const x = loadHost(this.env, agent); x.house = r.id; delete x.report; delete x.hostHash; x.bootHash = keyHash(boot); x.req = {}; x.stop = {}; x.inbox = {}; x.claimed = {}; writeJson(hostFile(this.env, agent), x); });
      }
      if (Date.now() > end) throw new RunnerError(`${agent}'s house ${h.house ?? ''} didn't start its body host in ${this.warmMs / 1000} s`);
      await sleep(this.poll);
    }
  }

  async launch(o, resume) {
    if (!AGENT_NAME.test(o.agent ?? '')) throw new RunnerError('a body in a house is some agent\'s: say which');
    const house = await this.warm(o.agent);
    const rid = randomBytes(8).toString('hex');
    const ask = { harness: this.harness, model: o.model, deny: o.deny ?? [], brief: o.brief, key: o.env?.LOOM_BODY_KEY, ...(resume ? { resume: resume.session, files: o.files ?? [] } : {}) };
    hostLocked(this.env, () => {
      const h = loadHost(this.env, o.agent);
      (h.req ??= {})[rid] = { at: this.now().getTime(), sealed: this.transit.seal(Buffer.from(JSON.stringify(ask))) };
      writeJson(hostFile(this.env, o.agent), h);
    });
    const end = Date.now() + this.claimMs;
    try {
      for (;;) {
        const d = this.host(o.agent).report?.done?.[rid];
        if (d?.id) {
          const id = bodyIdOf(house, d.id);
          // The composed id must still be a body ref (bodies.mjs REF: 4-64 of [A-Za-z0-9-]): the house's id takes room.
          if (!BODY_REF.test(id)) throw new RunnerError(`${house} reported a body id too long to be one here (${d.id.length} characters; at most ${MAX_BODY_ID - house.length - 1})`);
          if (existsSync(join(dataDir(this.env), 'bodies', `${this.harness}-${id}.json`))) throw new RunnerError(`${house} reported ${d.id}, which is already a body's`);
          return { id, harness: this.harness, model: o.model, house, ...(resume ? { slot: resume } : {}) };
        }
        if (d?.error) throw new RunnerError(d.error);
        if (Date.now() > end) {
          // Given up on: should its house start it late, that body is stopped, never run (bodySync, h.cancel).
          hostLocked(this.env, () => { const h = loadHost(this.env, o.agent); (h.cancel ??= {})[rid] = this.now().getTime(); writeJson(hostFile(this.env, o.agent), h); });
          throw new RunnerError(`${o.agent}'s body host didn't start the body in ${this.claimMs / 1000} s`);
        }
        await sleep(this.poll);
      }
    } finally {
      hostLocked(this.env, () => { const h = loadHost(this.env, o.agent); delete h.req?.[rid]; writeJson(hostFile(this.env, o.agent), h); });
    }
  }

  start(o) { return this.launch(o); }
  resume(slot, o) {
    if (slot?.harness !== this.harness || !slot.session) throw new RunnerError(`a ${this.harness} body resumes from a ${this.harness} slot`);
    return this.launch(o, slot);
  }

  entry(body) {
    const raw = rawOf(body);
    const h = this.host(body.agent);
    if (!raw || !fresh(h, this.now().getTime()) || h.house !== body.house) return null;
    return h.report.bodies[raw] ?? { status: 'ended' };
  }

  status(body) { return this.entry(body)?.status ?? 'unknown'; }
  /** Its harness is still there: its house's host reports it. */
  alive(body) { const e = this.entry(body); return !!e && e.status !== 'ended'; }
  slotOf(body) { const s = this.entry(body)?.session; return s ? { harness: this.harness, session: s } : null; }

  feed(body, message) {
    const e = this.entry(body);
    if (e?.status !== 'working') return { fed: false, reason: 'its turn is over: resume it' };
    if (!e.feedable) return { fed: false, reason: 'its house\'s harness has no inbox, so a body hears nothing mid-turn' };
    hostLocked(this.env, () => {
      const h = loadHost(this.env, body.agent);
      if (h.house !== body.house) return;
      ((h.inbox ??= {})[rawOf(body)] ??= []).push({ key: message.id, sealed: this.transit.seal(Buffer.from(String(message.text))) });
      writeJson(hostFile(this.env, body.agent), h);
    });
    return { fed: true };
  }

  /**
   * The follow-ups fed to a body that it may never have heard: the ones its house hasn't acknowledged, and the ones its
   * house says are still in its inbox. Null when its host can't say (gone, or stale): then every one fed is unheard.
   */
  unheard(body) {
    const raw = rawOf(body);
    const h = this.host(body.agent);
    if (!raw || !fresh(h, this.now().getTime()) || h.house !== body.house) return null;
    return [...new Set([...(h.inbox?.[raw] ?? []).map((x) => x.key), ...(h.report.bodies[raw]?.pending ?? [])])];
  }

  /** Its follow-ups, gone from the record (the runtime keeps its own copies). */
  forgetInbox(body) {
    const raw = rawOf(body);
    if (!raw) return;
    hostLocked(this.env, () => { const h = loadHost(this.env, body.agent); if (h.inbox?.[raw]) { delete h.inbox[raw]; writeJson(hostFile(this.env, body.agent), h); } });
  }

  end(body) {
    const raw = rawOf(body);
    if (!body.agent || !raw) return;
    hostLocked(this.env, () => {
      const h = loadHost(this.env, body.agent);
      if (h.house !== body.house) return;
      (h.stop ??= {})[raw] ??= { pack: false, at: this.now().getTime() };
      writeJson(hostFile(this.env, body.agent), h);
    });
  }

  /** Its session's files, from its house: it's stopped there and its host sends them back. [] when its house is gone. */
  async pack(body) {
    const raw = rawOf(body);
    if (!raw) return [];
    // No key here: no slot, at once. It's stopped, and its session stays in its house (thrown away with it).
    if (!this.canSeal()) { this.end(body); return null; }
    const f = packedFile(this.env, body.agent, body.house, raw);
    if (!this.alive(body) && !existsSync(f)) return [];
    const asked = hostLocked(this.env, () => {
      const h = loadHost(this.env, body.agent);
      // Its house isn't the agent's house now: nothing there to ask, and nothing to wait for.
      if (h.house !== body.house) return false;
      (h.stop ??= {})[raw] = { pack: true, at: this.now().getTime() };
      writeJson(hostFile(this.env, body.agent), h);
      return true;
    });
    if (!asked) return [];
    const end = Date.now() + this.claimMs;
    while (!existsSync(f)) {
      if (Date.now() > end || !fresh(this.host(body.agent), this.now().getTime())) throw new RunnerError(`${body.agent}'s house didn't send ${body.id}'s session back`);
      await sleep(this.poll);
    }
    try { return JSON.parse(this.sealer.open(readFileSync(f)).toString('utf-8')); } finally { rmSync(f, { force: true }); }
  }
}
