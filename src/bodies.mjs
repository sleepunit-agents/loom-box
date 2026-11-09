// Bodies (loom docs/specs/agent-runtime.md, sections 3 and 4): whoever needs a body asks the runtime for one. It
// picks the model (models.mjs), starts the body on that model's harness (runners.mjs), and keeps a record of it on
// this machine, so the body can be fed, resumed and ended by its id.
//
//   startBody   {agent, brief, venue, venueKind?, prefer?, avoid?, cwd?, deny?, guest?} → the body's record, with why
//               that model (a brief is text, or parts naming the agent's files: briefs.mjs; avoid: harnesses not to use)
//   feedBody    a message mid-turn, where the harness allows
//   resumeBody  a body (or a slot) continued, on a model of the same harness
//   endBody     stopped
//   listBodies  every body this machine started, and how each is doing
//
// A body's id is <harness>:<the harness's own id> (claude:99553cf9, codex:5e0c1a2b). Records are this machine's own
// (<LOOM_BOX_DATA>/bodies), 0600 in a 0700 dir, and hold no brief and no message: the agent, venue, model, harness
// and slot only, and `switched` ({from, why, until?}) when the body is a harness switch: on another harness than the
// agent's preferred one, because that one's account is out (models.mjs, fallback; t-1907).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { accountsFrom } from './accounts.mjs';
import { checkParts, composeBrief, isParts } from './briefs.mjs';
import { resolveFor } from './models.mjs';
import { runnerFor } from './runners.mjs';
import { StateError } from './state.mjs';
/** Core's Comms venue (loom docs/specs/comms.md): its bodies' tool steps are read as activity cards; no other's are. */
const COMMS_VENUE = 'loom';

const MAX_BRIEF = 200_000;
const REF = /^(claude|codex):([A-Za-z0-9-]{4,64})$/;

const dir = (env) => join(env.LOOM_BOX_DATA || join(env.HOME || homedir(), '.local', 'share', 'loom-box'), 'bodies');
const file = (env, ref) => join(dir(env), `${ref.replace(':', '-')}.json`);
const fail = (m, status = 400) => { throw new StateError(m, status); };

function save(env, rec) {
  mkdirSync(dir(env), { recursive: true, mode: 0o700 });
  writeFileSync(file(env, rec.body), JSON.stringify(rec, null, 1) + '\n', { mode: 0o600 });
}

export function readBody(env, ref) {
  if (!REF.test(ref ?? '')) fail('a body is <harness>:<id>, like claude:99553cf9');
  try { return JSON.parse(readFileSync(file(env, ref), 'utf-8')); } catch { fail(`no body ${ref} on this machine`, 404); }
}

/** What the runtime's own parts are made of, so a test (or a caller) can hand in fakes. */
const deps = (env, o) => ({ accounts: o.accounts ?? accountsFrom(env), runner: o.runner ?? ((h) => runnerFor(h, env)), now: o.now ?? (() => new Date()), fetchImpl: o.fetchImpl });

const brief = (b) => {
  if (isParts(b)) {
    try { b = checkParts(b); } catch (e) { fail(e.message); }
    if (b.reduce((n, p) => n + (p.text?.length ?? 0), 0) > MAX_BRIEF) fail(`a brief is at most ${MAX_BRIEF} characters`);
    return b;
  }
  if (typeof b !== 'string' || !b.trim()) fail('a body needs a brief');
  if (b.length > MAX_BRIEF) fail(`a brief is at most ${MAX_BRIEF} characters`);
  return b;
};

/**
 * The brief as the runner takes it: a house's runner carries parts to its host, which reads the agent's files in its
 * repo; any other runner gets the text, its files read here from the body's cwd (briefs.mjs). Fails closed.
 */
function forRunner(runner, b, cwd) {
  if (!isParts(b) || runner.remote) return b;
  try { return composeBrief(b, cwd); } catch (e) { fail(e.message, 422); }
}

/** A pick's fallback (models.mjs), as a body's record keeps it. */
const switchedOf = (pick) => (pick.fallback ? { switched: { from: pick.fallback.from, why: String(pick.fallback.why ?? '').slice(0, 300), ...(pick.fallback.account ? { account: pick.fallback.account } : {}), ...(pick.fallback.until ? { until: pick.fallback.until } : {}) } } : {});

export async function startBody(env, { agent, brief: b, venue, venueKind, prefer = [], avoid = [], cwd, deny = [], place, guest, local, seat, activity = false }, o = {}) {
  const d = deps(env, o);
  const text = brief(b);
  if (typeof venue !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(venue)) fail('which venue (wake, relay, session, discord, slack, …)');
  const pick = await resolveFor(env, { agent, venue, venueKind, prefer, avoid, conversation: o.bodyEnv?.LOOM_BODY_CONVERSATION, accounts: d.accounts, now: d.now(), fetchImpl: d.fetchImpl });
  const runner = d.runner(pick.harness, !!local);
  // Comms and interactive terminal bodies expose their native tool steps as activity cards (activity.mjs).
  // Whose house (t-1952): a house's runner seats it there; a local one has no houses.
  o.beforeStart?.();
  const body = await runner.start({ agent, brief: forRunner(runner, text, cwd), model: pick.model, cwd, env: o.bodyEnv, deny, ...(seat ? { seat } : {}), ...((venue === COMMS_VENUE || activity) ? { activity: true } : {}) });
  const rec = {
    body: `${body.harness}:${body.id}`, agent, venue, kind: pick.kind, ...(place ? { place: String(place).slice(0, 200) } : {}),
    // What it was started with of its rules (tool names, never the brief): for the owner's `loom runtime bodies`.
    ...(deny.length ? { deny: [...deny] } : {}), ...(guest ? { guest: true } : {}), ...(local ? { local: true } : {}),
    harness: body.harness, model: pick.model, family: pick.family, ...(pick.account ? { account: pick.account } : {}), ...(pick.accountKey ? { accountKey: pick.accountKey } : {}), ...switchedOf(pick),
    started: d.now().toISOString(), instance: randomBytes(12).toString('hex'), ...(body.slot ? { slot: body.slot } : {}), ...(body.house ? { house: body.house } : {}), ...(body.seat ? { seat: body.seat } : {}),
  };
  save(env, rec);
  return { ...rec, why: pick.why, preferred: pick.preferred };
}

export function feedBody(env, ref, message, o = {}) {
  const rec = readBody(env, ref);
  if (typeof message?.text !== 'string' || !message.text) fail('a message has text');
  return deps(env, o).runner(rec.harness, rec.local).feed({ id: ref.split(':')[1], ...rec }, message);
}

/** A body continued: by its id (its slot, from the harness), or by a slot ({harness, session}) another machine kept. */
export async function resumeBody(env, { body: ref, slot, agent, venue, venueKind, brief: b, prefer = [], cwd, deny = [], files, guest, local, seat, activity = false }, o = {}) {
  const d = deps(env, o);
  let rec = null;
  if (ref) {
    rec = readBody(env, ref);
    slot = d.runner(rec.harness, rec.local).slotOf({ id: ref.split(':')[1], ...rec }) ?? rec.slot;
    if (!slot) fail(`${ref} has no slot yet: its harness hasn't said which session it is`, 409);
  }
  if (!slot || !['claude', 'codex'].includes(slot.harness) || typeof slot.session !== 'string' || !slot.session) fail('resume takes a body, or a slot {harness, session}');
  const who = rec?.agent ?? agent;
  const where = rec?.venue ?? venue;
  // A resume keeps the slot's harness; its model is chosen again, among that harness's (quota may have moved).
  const pick = await resolveFor(env, { agent: who, venue: where, venueKind: rec?.kind ?? venueKind, prefer: [...prefer, ...(rec ? [rec.model] : [])], harness: slot.harness, conversation: o.bodyEnv?.LOOM_BODY_CONVERSATION, accounts: d.accounts, now: d.now(), fetchImpl: d.fetchImpl });
  const here = !!(local ?? rec?.local);
  const runner = d.runner(slot.harness, here);
  o.beforeStart?.();
  const body = await runner.resume(slot, { agent: who, brief: forRunner(runner, brief(b), cwd), model: pick.model, cwd, env: o.bodyEnv, deny, ...(seat ? { seat } : {}), ...(files ? { files } : {}), ...((where === COMMS_VENUE || activity) ? { activity: true } : {}) });
  const next = {
    body: `${body.harness}:${body.id}`, agent: who, venue: where, kind: pick.kind, ...(rec?.place ? { place: rec.place } : {}),
    ...(deny.length ? { deny: [...deny] } : {}), ...(guest ? { guest: true } : {}), ...(here ? { local: true } : {}),
    harness: body.harness, model: pick.model, family: pick.family, ...(pick.account ? { account: pick.account } : {}), ...(pick.accountKey ? { accountKey: pick.accountKey } : {}), ...switchedOf(pick),
    started: d.now().toISOString(), instance: randomBytes(12).toString('hex'), slot: body.slot ?? slot, ...(ref ? { resumed: ref } : {}), ...(body.house ? { house: body.house } : {}), ...(body.seat ? { seat: body.seat } : {}),
  };
  save(env, next);
  return { ...next, why: pick.why, preferred: pick.preferred };
}

export function endBody(env, ref, o = {}) {
  const rec = readBody(env, ref);
  deps(env, o).runner(rec.harness, rec.local).end({ id: ref.split(':')[1], ...rec }, o.bodyEnv);
  save(env, { ...rec, ended: (o.now ?? (() => new Date()))().toISOString() });
  return { body: ref, ended: true };
}

export function listBodies(env, o = {}) {
  const d = deps(env, o);
  if (!existsSync(dir(env))) return [];
  const out = [];
  for (const f of readdirSync(dir(env)).filter((n) => n.endsWith('.json')).sort()) {
    let rec;
    try { rec = JSON.parse(readFileSync(join(dir(env), f), 'utf-8')); } catch { continue; }
    if (!REF.test(rec?.body ?? '')) continue;
    let status = 'unknown';
    try { status = rec.ended ? 'ended' : d.runner(rec.harness, rec.local).status({ id: rec.body.split(':')[1], ...rec }); } catch { /* a runner that can't say */ }
    out.push({ ...rec, status });
  }
  return out;
}

/** Forget an ended body's record (the harness keeps its own session until its slot goes: delivery's, t-1744). */
export function forgetBody(env, ref) {
  readBody(env, ref);
  rmSync(file(env, ref), { force: true });
  return { body: ref, forgotten: true };
}
