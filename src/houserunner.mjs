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
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const BODY_ID = /^[A-Za-z0-9-]{4,64}$/;
const HOUSE = /^h-[0-9]{1,9}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = (env) => env.LOOM_BOX_DATA || join(env.HOME || '', '.local', 'share', 'loom-box');
const hostsDir = (env) => join(dataDir(env), 'delivery', 'hosts');
const hostFile = (env, agent) => join(hostsDir(env), `${agent}.json`);
const packedFile = (env, id) => join(hostsDir(env), 'packed', `${id}.age`);
const partFile = (env, id, i) => join(hostsDir(env), 'parts', id, String(i));

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
export const hostTask = (env) => `loom-runtime body-host --piece ${pieceName(env)}`;

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
  const house = caller.house ?? body?.house;
  if (!HOUSE.test(house ?? '')) throw new StateError('body-sync comes from a house (its token names it)', 403);
  const sealer = o.sealer ?? ageSealer(env, join(dataDir(env), 'delivery'));
  const now = (o.now ?? (() => new Date()))().getTime();
  return hostLocked(env, () => {
    const h = loadHost(env, agent);
    const live = houseLive(env, house);
    if (!h.house && live && live.agent === agent) h.house = house;
    if (h.house !== house) return { exit: true, reason: `${agent}'s bodies are ${h.house ?? 'nowhere'}'s now` };
    const { bodies, done } = cleanReport(body?.report);
    h.report = { at: now, house, bodies, done };
    // A packed session, in parts: kept as they come, then sealed whole.
    const got = [];
    for (const [id, p] of Object.entries(body?.report?.packed ?? {}).slice(0, 8)) {
      if (!BODY_ID.test(id) || !h.stop?.[id]?.pack || !Number.isSafeInteger(p?.part) || !Number.isSafeInteger(p?.parts) || p.parts < 1 || p.parts > 64 || p.part < 0 || p.part >= p.parts || typeof p.data !== 'string' || p.data.length > PART_CHARS) continue;
      writeJson(partFile(env, id, p.part), p.data);
      got.push([id, p.part]);
      const all = Array.from({ length: p.parts }, (_, i) => readJson(partFile(env, id, i)));
      if (all.every((x) => typeof x === 'string')) {
        const whole = Buffer.from(all.join(''), 'base64');
        mkdirSync(dirname(packedFile(env, id)), { recursive: true, mode: 0o700 });
        writeFileSync(packedFile(env, id), sealer.seal(whole), { mode: 0o600 });
        rmSync(join(hostsDir(env), 'parts', id), { recursive: true, force: true });
      }
    }
    // A stop is done once its body is gone from the report (and its pack, if it was asked for, is in).
    for (const id of Object.keys(h.stop ?? {})) {
      const gone = !bodies[id] || bodies[id].status === 'ended';
      if (gone && (!h.stop[id].pack || existsSync(packedFile(env, id)) || now - h.stop[id].at > CLAIM_MS)) delete h.stop[id];
    }
    const req = {};
    for (const [rid, r] of Object.entries(h.req ?? {})) {
      if (done[rid]) continue;
      try { req[rid] = JSON.parse(sealer.open(Buffer.from(r.sealed, 'base64')).toString('utf-8')); } catch { /* its text is gone: never started */ }
    }
    const inbox = {};
    for (const [id, items] of Object.entries(h.inbox ?? {})) {
      inbox[id] = items.flatMap((x) => { try { return [{ id: x.key, text: sealer.open(Buffer.from(x.sealed, 'base64')).toString('utf-8') }]; } catch { return []; } });
    }
    // Handed to the house: the follow-ups live in its inbox now, not here.
    h.inbox = {};
    writeJson(hostFile(env, agent), h);
    return { req, stop: h.stop ?? {}, inbox, acked: got };
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
        const r = this.up(this.env, { now: () => this.now() }, { kind: 'owner' }, { agent, box: at.box, task: hostTask(this.env) });
        hostLocked(this.env, () => { const x = loadHost(this.env, agent); x.house = r.id; delete x.report; writeJson(hostFile(this.env, agent), x); });
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
      (h.req ??= {})[rid] = { at: this.now().getTime(), sealed: this.sealer.seal(Buffer.from(JSON.stringify(ask))).toString('base64') };
      writeJson(hostFile(this.env, o.agent), h);
    });
    const end = Date.now() + this.claimMs;
    try {
      for (;;) {
        const d = this.host(o.agent).report?.done?.[rid];
        if (d?.id) return { id: d.id, harness: this.harness, model: o.model, house, ...(resume ? { slot: resume } : {}) };
        if (d?.error) throw new RunnerError(d.error);
        if (Date.now() > end) throw new RunnerError(`${o.agent}'s body host didn't start the body in ${this.claimMs / 1000} s`);
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
    const h = this.host(body.agent);
    if (!fresh(h, this.now().getTime()) || h.house !== (body.house ?? h.house)) return null;
    return h.report.bodies[body.id] ?? { status: 'ended' };
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
      ((h.inbox ??= {})[body.id] ??= []).push({ key: message.id, sealed: this.sealer.seal(Buffer.from(String(message.text))).toString('base64') });
      writeJson(hostFile(this.env, body.agent), h);
    });
    return { fed: true };
  }

  end(body) {
    if (!body.agent) return;
    hostLocked(this.env, () => {
      const h = loadHost(this.env, body.agent);
      (h.stop ??= {})[body.id] ??= { pack: false, at: this.now().getTime() };
      writeJson(hostFile(this.env, body.agent), h);
    });
  }

  /** Its session's files, from its house: it's stopped there and its host sends them back. [] when its house is gone. */
  async pack(body) {
    if (!this.alive(body) && !existsSync(packedFile(this.env, body.id))) return [];
    hostLocked(this.env, () => {
      const h = loadHost(this.env, body.agent);
      (h.stop ??= {})[body.id] = { pack: true, at: this.now().getTime() };
      writeJson(hostFile(this.env, body.agent), h);
    });
    const end = Date.now() + this.claimMs;
    while (!existsSync(packedFile(this.env, body.id))) {
      if (Date.now() > end || !fresh(this.host(body.agent), this.now().getTime())) throw new RunnerError(`${body.agent}'s house didn't send ${body.id}'s session back`);
      await sleep(this.poll);
    }
    const f = packedFile(this.env, body.id);
    try { return JSON.parse(this.sealer.open(readFileSync(f)).toString('utf-8')); } finally { rmSync(f, { force: true }); }
  }
}
