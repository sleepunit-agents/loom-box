// Model choice (loom docs/specs/agent-runtime.md, sections 2 and 4): the models the runtime can run, and one
// resolver that picks the model for a body.
//
// The **model list** says, for each model, which harness runs it and its **family**, a fixed string: `anthropic`,
// `openai`, `google`, `mistral`, or `local:<name>` for a model the household runs itself. Grading reads families
// (conversations.md, Review). Each agent may have **settings**: the models it may use (`allow`, default all) and
// its preference among them (`prefer`, in order).
//
// The resolver, in order:
//   1. hard limits: the models the agent may use, whose accounts have quota left;
//   2. the agent's preference among those;
//   3. scorecards demote the preference when another allowed model's `graded` value for the venue kind is at
//      least 1.0 higher.
// It replaces the clock's WAKE_MODEL and the bridges piece's model resolver.
//
// What it would have picked with every account's quota ignored is its **preferred** pick. A pick on another harness
// than that one is a **fallback** (t-1907): the agent answering on Codex because Claude's account is out. The caller
// can also `avoid` harnesses for one body (a turn its provider just refused, retried elsewhere).
import { readFileSync } from 'node:fs';
import { accountsFor, hasRoom, roomAt } from './accounts.mjs';
import { StateError, load, update } from './state.mjs';
import { setting } from './piece.mjs';

export const FAMILY = /^(anthropic|openai|google|mistral|local:[a-z0-9][a-z0-9._-]{0,39})$/;
export const HARNESSES = ['claude', 'codex'];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/;
const AGENT = /^[a-z][a-z0-9-]{0,39}$/;
export const VENUE_KINDS = ['live', 'scheduled', 'agent'];
/** The venues whose kind the runtime knows without being told (conversations.md: core's own, and the adapters'). */
export const VENUE_KIND = { session: 'live', discord: 'live', slack: 'live', loom: 'live', wake: 'scheduled', relay: 'agent' };
/** How much higher another model's graded value must be to demote the preference (the spec's 1.0). */
export const DEMOTE_BY = 1.0;
/** The scorecard window the resolver reads, and the fewest graded samples a model needs in it to count. */
export const SCORE_DAYS = 14;
export const MIN_GRADED = 5;

/** Until the owner sets a list: the models the clock and the bridges ran on before the runtime chose. */
export const DEFAULT_MODELS = [
  { id: 'claude-opus-5-5', harness: 'claude', family: 'anthropic', window: '7d_opus' },
  { id: 'claude-opus-5', harness: 'claude', family: 'anthropic', window: '7d_opus' },
  { id: 'claude-sonnet-5', harness: 'claude', family: 'anthropic', window: '7d_sonnet' },
];

const fail = (m, status = 400) => { throw new StateError(m, status); };

/** The provider whose accounts a family runs on; a local model needs none. */
export const providerOf = (family) => (family.startsWith('local:') ? null : family);

/** A model list, checked: [{id, harness, family, window?}]. */
export function checkModels(list) {
  if (!Array.isArray(list) || !list.length || list.length > 32) fail('the model list is 1 to 32 models');
  const seen = new Set();
  return list.map((m) => {
    if (!m || typeof m !== 'object') fail('a model is {id, harness, family}');
    if (!MODEL_ID.test(m.id ?? '')) fail(`a model's id is like claude-sonnet-5: ${JSON.stringify(m.id)}`);
    if (seen.has(m.id)) fail(`${m.id} is listed twice`);
    seen.add(m.id);
    if (!HARNESSES.includes(m.harness)) fail(`${m.id}: harness is one of ${HARNESSES.join(', ')}`);
    if (!FAMILY.test(m.family ?? '')) fail(`${m.id}: family is anthropic, openai, google, mistral or local:<name>, not ${JSON.stringify(m.family)}`);
    if (m.window !== undefined && !/^[0-9]+[hd](_[a-z0-9]+)?$/.test(m.window)) fail(`${m.id}: window is a usage window's name, like 7d_opus`);
    return { id: m.id, harness: m.harness, family: m.family, ...(m.window ? { window: m.window } : {}) };
  });
}

/** An agent's model settings, checked against the list: {allow?: [id], prefer?: [id]}. */
export function checkAgentModels(list, v) {
  const ids = new Set(list.map((m) => m.id));
  const out = {};
  for (const k of ['allow', 'prefer']) {
    if (v?.[k] === undefined) continue;
    if (!Array.isArray(v[k]) || v[k].length > 32) fail(`${k} is a list of model ids`);
    const bad = v[k].find((id) => !ids.has(id));
    if (bad) fail(`${k}: ${bad} isn't in the model list`);
    out[k] = [...new Set(v[k])];
  }
  return out;
}

/** The runtime's models: the owner's list (state.json `models`), else the defaults, and each agent's settings. */
export function modelsOf(s) {
  return { list: s.models?.list ?? DEFAULT_MODELS, agents: s.models?.agents ?? {} };
}

export function readModels(env) { return modelsOf(load(env)); }

/** Owner-selected harnesses: a thread overrides its agent; Auto inherits the agent. */
export function modelChoiceOf(s, agent, conversation) {
  const choices = s.modelChoices ?? {};
  const agentChoice = choices.agents?.[agent] ?? 'auto';
  const thread = conversation && choices.conversations?.[conversation];
  const threadChoice = thread?.agent === agent ? thread.harness : 'auto';
  return { agent, ...(conversation ? { conversation } : {}), agentChoice, threadChoice,
    effective: threadChoice !== 'auto' ? threadChoice : agentChoice };
}
export const readModelChoice = (env, agent, conversation) => modelChoiceOf(load(env), agent, conversation);

/** Low-level owner mutation; API/page callers verify the actual conversation and owner first. */
export function setModelChoice(env, { agent, conversation, harness }) {
  if (!AGENT.test(agent ?? '')) fail('which agent');
  if (!['auto', ...HARNESSES].includes(harness)) fail('model choice is auto, claude or codex');
  if (conversation !== undefined && !/^cv-[0-9a-f]{12}$/.test(conversation)) fail('which conversation');
  return update(env, (s) => {
    const available = modelsOf(s);
    const allowed = available.agents[agent]?.allow;
    if (harness !== 'auto' && !available.list.some((m) => m.harness === harness && (!allowed?.length || allowed.includes(m.id)))) fail(`no allowed ${harness} model for ${agent}`);
    const c = s.modelChoices ??= { agents: {}, conversations: {} };
    if (conversation) {
      if (harness === 'auto') delete c.conversations[conversation];
      else c.conversations[conversation] = { agent, harness };
    } else {
      if (harness === 'auto') delete c.agents[agent];
      else c.agents[agent] = harness;
    }
    return modelChoiceOf(s, agent, conversation);
  });
}

/** The owner sets the list, an agent's settings, or both. */
export function setModels(env, { list, agent, allow, prefer }) {
  return update(env, (s) => {
    const cur = modelsOf(s);
    const next = list !== undefined ? checkModels(list) : cur.list;
    const agents = { ...cur.agents };
    // A list that drops a model drops it from every agent's settings too.
    for (const [a, v] of Object.entries(agents)) {
      agents[a] = Object.fromEntries(Object.entries(v).map(([k, ids]) => [k, ids.filter((id) => next.some((m) => m.id === id))]));
    }
    if (agent !== undefined) {
      if (!AGENT.test(agent)) fail('which agent');
      agents[agent] = { ...agents[agent], ...checkAgentModels(next, { allow, prefer }) };
    }
    s.models = { list: next, agents };
    // …and from every role; a role left with nothing eligible stays, and says so when asked for (roleOf, resolveFor).
    if (s.roles?.list?.length) {
      const before = JSON.stringify(s.roles.list);
      s.roles.list = s.roles.list.map((r) => (r.models ? { ...r, models: r.models.filter((id) => next.some((m) => m.id === id)) } : r));
      if (JSON.stringify(s.roles.list) !== before) {
        const changed = { at: new Date().toISOString(), by: 'owner', what: 'the model list dropped models some roles named', version: s.roles.version + 1 };
        s.roles = { ...s.roles, version: changed.version, changed, log: [...(s.roles.log ?? []), changed].slice(-ROLE_LOG) };
      }
    }
    return s.models;
  });
}

// Worker roles (t-2036): the kinds of work an agent can ask the runtime for (coding, review, a light task…), each
// with the concrete models eligible for it. A role is not an agent: an agent asks for a role for a job it hands off
// (spawn.mjs), and the runtime picks the model. The catalog is the owner's, versioned: a job records the version it
// was admitted under, so a later edit never changes a running job. Nothing here is a closed list: roles are added and
// removed by the owner, and bodies read the catalog (`loom runtime roles`) rather than knowing it.
// A role never widens what an agent may use: its eligible models are intersected with the agent's `allow`, and every
// account, quota and grant rule still applies.
export const ROLE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const ROLE_TEXT = 400;
const ROLE_LOG = 20;
/** A box fact a role needs: control.mjs's FACT (a name, and an optional value to match). */
const NEED = /^[a-z][a-z0-9-]{0,31}(:[A-Za-z0-9._ +-]{1,64})?$/;

/** A role, checked against the model list: {id, description, models?: [id], families?: [family], needs?: [fact], note?, input?, output?, dossier?}. */
export function checkRole(list, r) {
  if (!r || typeof r !== 'object') fail('a role is {id, description, models}');
  if (!ROLE_ID.test(r.id ?? '')) fail(`a role's id is like coding or light-task: ${JSON.stringify(r.id)}`);
  if (typeof r.description !== 'string' || !r.description.trim() || r.description.length > ROLE_TEXT) fail(`${r.id}: description is 1 to ${ROLE_TEXT} characters`);
  const ids = new Set(list.map((m) => m.id));
  const out = { id: r.id, description: r.description.trim() };
  if (r.models !== undefined) {
    if (!Array.isArray(r.models) || r.models.length > 32) fail(`${r.id}: models is a list of model ids, most wanted first`);
    const bad = r.models.find((id) => !ids.has(id));
    if (bad) fail(`${r.id}: ${bad} isn't in the model list`);
    out.models = [...new Set(r.models)];
  }
  if (r.families !== undefined) {
    if (!Array.isArray(r.families) || r.families.length > 8) fail(`${r.id}: families is a list of model families`);
    const bad = r.families.find((f) => !FAMILY.test(f ?? ''));
    if (bad !== undefined) fail(`${r.id}: family ${JSON.stringify(bad)} is anthropic, openai, google, mistral or local:<name>`);
    out.families = [...new Set(r.families)];
  }
  if (!out.models?.length && !out.families?.length) fail(`${r.id}: name the models (or families) eligible for it`);
  for (const k of ['input', 'output', 'note']) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== 'string' || !r[k].trim() || r[k].length > ROLE_TEXT) fail(`${r.id}: ${k} is 1 to ${ROLE_TEXT} characters`);
    out[k] = r[k].trim();
  }
  // What a job of this role needs of its box (t-2092): box facts, as `loom runtime up --needs` takes them (gpu:5090,
  // a label). A role from before, whose needs was words, keeps them as its note: words place nothing.
  if (r.needs !== undefined) {
    if (typeof r.needs === 'string') {
      if (!r.needs.trim() || r.needs.length > ROLE_TEXT) fail(`${r.id}: needs is a list of box facts, like gpu:5090`);
      if (out.note === undefined) out.note = r.needs.trim();
    } else {
      if (!Array.isArray(r.needs) || r.needs.length > 8) fail(`${r.id}: needs is a list of at most 8 box facts, like gpu:5090`);
      const bad = r.needs.find((n) => typeof n !== 'string' || !NEED.test(n));
      if (bad !== undefined) fail(`${r.id}: ${JSON.stringify(bad)} isn't a box fact (like gpu:5090, or a box's label)`);
      if (r.needs.length) out.needs = [...new Set(r.needs)];
    }
  }
  if (r.dossier !== undefined) {
    if (!ROLE_ID.test(r.dossier)) fail(`${r.id}: dossier is a dossier's name, like code or review`);
    out.dossier = r.dossier;
  }
  if (r.failover !== undefined) {
    if (typeof r.failover !== 'boolean') fail(`${r.id}: failover is true or false`);
    out.failover = r.failover;
  }
  return out;
}

/** The models eligible for a role, most wanted first: its named models, then its families' in the list's order. */
export function eligibleOf(list, role) {
  const named = (role.models ?? []).map((id) => list.find((m) => m.id === id)).filter(Boolean);
  const more = list.filter((m) => (role.families ?? []).includes(m.family) && !named.includes(m));
  return [...named, ...more];
}

/** The catalog: {version, roles: [{…role, eligible: [id]}], changed?, log}. */
/**
 * A role as stored, read the way it's written now (t-2092): a role saved before needs were box facts kept them as
 * words, and is read with those words as its note and no needs; anything in a list that isn't a fact is dropped.
 */
function storedRole(x) {
  const { needs, ...rest } = x;
  if (typeof needs === 'string') return { ...rest, ...(rest.note === undefined && needs.trim() ? { note: needs.trim() } : {}) };
  const facts = Array.isArray(needs) ? needs.filter((n) => typeof n === 'string' && NEED.test(n)) : [];
  return facts.length ? { ...rest, needs: facts } : rest;
}

export function rolesOf(s) {
  const { list } = modelsOf(s);
  const r = s.roles ?? { version: 0, list: [], log: [] };
  return { version: r.version, roles: r.list.map((x) => ({ ...storedRole(x), eligible: eligibleOf(list, x).map((m) => m.id) })), ...(r.changed ? { changed: r.changed } : {}), log: r.log ?? [] };
}
export const readRoles = (env) => rolesOf(load(env));

/** One role of the catalog, with its version, or a 404 naming the ones there are. */
export function roleOf(s, id) {
  const cat = rolesOf(s);
  const r = cat.roles.find((x) => x.id === id);
  if (!r) fail(`no role ${JSON.stringify(id)}: the roles are ${cat.roles.map((x) => x.id).join(', ') || 'none yet (the owner adds them: loom runtime roles set)'}`, 404);
  return { ...r, version: cat.version };
}

/** The owner adds or replaces a role, or removes one; each edit is a new version, logged with who and why. */
export function setRole(env, { role, remove, why, by = 'owner', expect, keep = false }) {
  if (why !== undefined && (typeof why !== 'string' || why.length > ROLE_TEXT)) fail(`why is at most ${ROLE_TEXT} characters`);
  return update(env, (s) => {
    const { list } = modelsOf(s);
    const cur = s.roles ?? { version: 0, list: [], log: [] };
    // An edit made against a catalog the editor saw (the page's form): refused if it moved since, inside this write.
    if (expect !== undefined && String(cur.version) !== String(expect)) fail('the roles changed since you opened this: open it again', 409);
    let next, what;
    if (remove !== undefined) {
      if (!cur.list.some((x) => x.id === remove)) fail(`no role ${JSON.stringify(remove)}`, 404);
      next = cur.list.filter((x) => x.id !== remove);
      what = `removed ${remove}`;
    } else {
      // keep: what the form doesn't show (input, output, dossier) stays as it was.
      const prev = keep ? cur.list.find((x) => x.id === role?.id) : undefined;
      const r = checkRole(list, prev ? { ...Object.fromEntries(['input', 'output', 'dossier'].filter((k) => prev[k] !== undefined).map((k) => [k, prev[k]])), ...role } : role);
      const had = cur.list.some((x) => x.id === r.id);
      if (!had && cur.list.length >= 64) fail('the catalog holds at most 64 roles');
      next = had ? cur.list.map((x) => (x.id === r.id ? r : x)) : [...cur.list, r];
      what = `${had ? 'changed' : 'added'} ${r.id}`;
    }
    const version = cur.version + 1;
    const changed = { at: new Date().toISOString(), by, what, ...(why ? { why } : {}), version };
    s.roles = { version, list: next, changed, log: [...(cur.log ?? []), changed].slice(-ROLE_LOG) };
    return rolesOf(s);
  });
}

/** A venue's kind: told, or known. */
export function venueKind(venue, told) {
  if (told !== undefined) {
    if (!VENUE_KINDS.includes(told)) fail(`a venue kind is ${VENUE_KINDS.join(', ')}`);
    return told;
  }
  const k = VENUE_KIND[venue];
  if (!k) fail(`the runtime doesn't know venue ${JSON.stringify(venue)}'s kind: say it (--venue-kind ${VENUE_KINDS.join('|')})`);
  return k;
}

/**
 * A model's graded value for a venue kind, from scorecard rows (conversations.md: {day, model, family, harness,
 * kind, measure, value, n, same_family}): the mean of its `graded` rows in the window, weighted by n. Undefined
 * with fewer than MIN_GRADED samples: too few to move anything.
 */
export function gradedOf(rows, model, kind, { since } = {}) {
  let sum = 0, n = 0;
  for (const r of rows) {
    if (r?.measure !== 'graded' || r.model !== model || r.kind !== kind) continue;
    if (since && typeof r.day === 'string' && r.day < since) continue;
    const c = Number.isFinite(r.n) && r.n > 0 ? r.n : 0;
    if (!Number.isFinite(r.value) || !c) continue;
    sum += r.value * c; n += c;
  }
  return n >= MIN_GRADED ? sum / n : undefined;
}

/** Whether a model has an account with room for the agent: {ok, account?} or {ok: false, reason, out}. */
function resolveRoom({ agent, m, accounts, now, gate }) {
  const provider = providerOf(m.family);
  if (!provider) return { ok: true };
  if (!accounts) return { ok: true, unread: true };
  // Only an account the model's own harness can run on: a Claude login runs Claude Code, not Codex.
  const mine = accountsFor(accounts, agent, provider).filter((a) => !a.harness || a.harness === m.harness);
  const roomy = mine.filter((a) => hasRoom(a, m.window, now));
  // A new worker job (allocator.mjs, t-2037, when the owner turned it on): an account with room, but only room it can
  // take while leaving conversations their reserve until the reset. Of a model's accounts, the one with the most headroom
  // after the job; across models the role's and owner's order stands, and a model whose accounts are all kept for
  // conversations has no room, so the next eligible one (a Codex model, say) is chosen as an ordinary pick.
  if (gate && roomy.length) {
    const seen = roomy.map((a) => ({ a, v: gate(a, m.window) }));
    // An account with no reading (an API key, say) is admitted but ranked last: never ahead of a measured login.
    const tightest = (v) => (v.windows.length ? Math.max(...v.windows.map((r) => r.after + r.reserve)) : Infinity);
    // An account with no reading is admitted only while no measured account of this model is being held back: else
    // holding back the subscription would hand the job to a metered key (an API key never has a reading) instead of
    // the next model, or a wait.
    const held = seen.some((x) => !x.v.allow);
    const ok = seen.filter((x) => x.v.allow && (x.v.windows.length || !held)).sort((x, y) => { const a = tightest(x.v), b = tightest(y.v); return a < b ? -1 : a > b ? 1 : 0; });
    if (ok.length) {
      const pick = ok[0].a;
      return { ok: true, account: pick.label ?? pick.name, accountKey: pick.name, admission: ok[0].v.why };
    }
    const until = seen.every((x) => typeof x.v.until === 'number') ? Math.min(...seen.map((x) => x.v.until)) : undefined;
    return { ok: false, reserved: true, reason: seen.map((x) => `${x.a.label ?? x.a.name}: ${x.v.why}`).join('; '),
      out: { harness: m.harness, ...(until ? { until } : {}) } };
  }
  const acct = roomy[0];
  // A body is told the account's label, never its key.
  if (acct) return { ok: true, account: acct.label ?? acct.name, accountKey: acct.name };
  // When the soonest of its accounts has room again, as far as its readings and holds say.
  const back = mine.map((a) => roomAt(a, m.window, now)).filter((t) => t !== null);
  const until = back.length && back.length === mine.length ? Math.min(...back) : undefined;
  const held = mine.some((a) => a.usage?.held);
  return {
    ok: false,
    reason: mine.length ? `${mine.map((a) => a.label ?? a.name).join(', ')} out of quota${held ? ' (its provider refused a turn)' : ''}${until ? ` until ${new Date(until * 1000).toISOString()}` : ''}` : `no box of ${agent}'s owner is logged in to ${m.harness}, and ${agent} has no ${provider} API key`,
    out: { harness: m.harness, ...(mine.length ? { account: mine[0].label ?? mine[0].name } : {}), ...(until ? { until } : {}) },
  };
}

/**
 * Pick the model for a body. Pure: everything it reads is passed in.
 *   models     the model list
 *   settings   the agent's {allow?, prefer?}
 *   accounts   the accounts view ({accounts}, accounts.mjs: from the boxes' reports), or null when it can't be read
 *   scorecards rows from loom, [] when there are none
 *   prefer     a preference for this one body (the caller's), ahead of the agent's own
 * Returns {model, harness, family, account?, kind, why: [lines], preferred: {model, harness}, fallback?: {from, until?,
 * account?}}, or throws a StateError (409) naming why no model is left (its `out`: [{harness, account?, until?}]).
 *   avoid      harnesses this body may not use (a turn its provider refused there, retried once elsewhere)
 *   now        the clock, for holds and windows past their reset (accounts.mjs, hasRoom)
 *   all        the whole list, when `models` is only some of it (a resume's harness): the preferred pick is from it
 */
export function resolveModel({ agent, kind, models, all = models, settings = {}, accounts, scorecards = [], prefer = [], since, avoid = [], harnessChoice = 'auto', now = Date.now(), gate }) {
  const why = [];
  const allowed = settings.allow?.length ? models.filter((m) => settings.allow.includes(m.id)) : models;
  if (!allowed.length) fail(`${agent} may use none of the runtime's models`, 409);
  // 1. Hard limits: allowed, and an account with quota left (a local model needs none).
  const room = new Map();
  // An avoided harness has no room for this body; its own reason (out of quota) when it has one.
  for (const m of allowed) {
    const q = resolveRoom({ agent, m, accounts, now, gate });
    room.set(m.id, avoid.includes(m.harness) && q.ok ? { ok: false, reason: `${m.harness} avoided for this body`, out: { harness: m.harness } } : q);
  }
  if (!accounts) why.push('quota not checked: no box reports here (off the control plane, or LOOM_RUNTIME_ACCOUNTS=none); fails open, as the resolvers before did');
  const usable = allowed.filter((m) => room.get(m.id).ok);
  for (const m of allowed) if (!room.get(m.id).ok) why.push(`${m.id}: ${room.get(m.id).reason}`);
  const order = [...prefer, ...(settings.prefer ?? [])];
  // 2 and 3, over a set of models: the preference, then the scorecards.
  const choose = (set, say) => {
    let pick = order.map((id) => set.find((m) => m.id === id)).find(Boolean) ?? set[0];
    if (say) why.push(`${pick.id}: ${order.includes(pick.id) ? 'preferred' : 'first allowed with quota'}`);
    const mineScore = gradedOf(scorecards, pick.id, kind, { since });
    if (mineScore !== undefined) {
      const better = set.map((m) => ({ m, g: gradedOf(scorecards, m.id, kind, { since }) }))
        .filter((x) => x.m.id !== pick.id && x.g !== undefined && x.g - mineScore >= DEMOTE_BY)
        .sort((x, y) => y.g - x.g)[0];
      if (better) {
        if (say) why.push(`${pick.id} demoted for ${kind}: graded ${mineScore.toFixed(2)}, ${better.m.id} ${better.g.toFixed(2)}`);
        pick = better.m;
      }
    }
    return pick;
  };
  // What it would pick with quota ignored (and nothing avoided), from the whole list: a pick on another harness is a
  // fallback. Its room is read as any model's is.
  const allAllowed = settings.allow?.length ? all.filter((m) => settings.allow.includes(m.id)) : all;
  const chosen = allAllowed.filter((m) => m.harness === harnessChoice);
  const preferred = choose(chosen.length ? chosen : allAllowed.length ? allAllowed : allowed, false);
  if (!room.has(preferred.id)) {
    const sub = resolveRoom({ agent, m: preferred, accounts, now });
    room.set(preferred.id, sub);
  }
  if (!usable.length) {
    // A model with room that's kept for conversations: the job waits for it (a held job, its messages queued), rather
    // than being answered as out of quota, which it isn't.
    const reserved = allowed.some((m) => room.get(m.id).reserved);
    const e = new StateError(`${reserved ? `every model ${agent} may use for this job is kept for conversations until its reset` : `no model is left for ${agent}`}: ${why.join('; ')}`, 409);
    if (reserved) {
      e.reserved = true;
      const t = allowed.map((m) => room.get(m.id)).filter((q) => q.reserved && Number.isFinite(q.out?.until)).map((q) => q.out.until);
      if (t.length) e.until = Math.min(...t);
    }
    e.out = allowed.map((m) => room.get(m.id).out).filter(Boolean).filter((o, i, all) => all.findIndex((x) => x.harness === o.harness && x.account === o.account) === i);
    throw e;
  }
  const wanted = usable.filter((m) => m.harness === harnessChoice);
  const pick = choose(wanted.length ? wanted : usable, true);
  const r = room.get(pick.id);
  const gone = room.get(preferred.id);
  const fallback = pick.harness !== preferred.harness && !gone.ok
    ? { from: preferred.harness, ...(gone.out?.account ? { account: gone.out.account } : {}), ...(gone.out?.until ? { until: gone.out.until } : {}), why: gone.reason }
    : null;
  if (fallback) why.push(`a fallback: ${preferred.id} (${preferred.harness}) is preferred, and ${gone.reason}`);
  // accountKey: which account, for the runtime's own records (a hold); never told to a body.
  return { model: pick.id, harness: pick.harness, family: pick.family, kind, ...(r.account ? { account: r.account } : {}), ...(r.accountKey ? { accountKey: r.accountKey } : {}), ...(r.admission ? { admission: r.admission } : {}), why,
    preferred: { model: preferred.id, harness: preferred.harness }, ...(fallback ? { fallback } : {}) };
}

/** The first day of the scorecard window, YYYY-MM-DD. */
export const sinceDay = (now = new Date(), days = SCORE_DAYS) => new Date(now.getTime() - days * 86400_000).toISOString().slice(0, 10);

/**
 * Scorecard rows from loom: `GET /api/loom/scorecards` (conversations.md, Review; being built as t-1742). Where
 * from:
 *   LOOM_RUNTIME_SCORECARDS   a JSON file of rows (a stub, or a copy), or `off`;
 *   else loom's URL (LOOM_RUNTIME_LOOM_URL) with a runtime token (LOOM_RUNTIME_TOKEN_FILE).
 * Anything unreadable is no rows, said in `error`: scorecards only ever demote, so none is the safe answer.
 * Answers {rows, error?}. The route's answer may be {rows: […]} or a bare list.
 */
export async function fetchScorecards(env, { kind, since, fetchImpl = fetch } = {}) {
  const file = setting(env, 'SCORECARDS');
  if (file === 'off') return { rows: [], error: 'scorecards off' };
  const rowsOf = (d) => (Array.isArray(d) ? d : Array.isArray(d?.rows) ? d.rows : null);
  if (file) {
    try {
      const rows = rowsOf(JSON.parse(readFileSync(file, 'utf-8')));
      return rows ? { rows } : { rows: [], error: `${file} holds no rows` };
    } catch (e) { return { rows: [], error: `${file}: ${e.message}` }; }
  }
  const url = setting(env, 'LOOM_URL');
  const tokenFile = setting(env, 'TOKEN_FILE');
  if (!url || !tokenFile) return { rows: [], error: 'no scorecards: no LOOM_RUNTIME_TOKEN_FILE to read them with' };
  try {
    const base = url.replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
    const q = new URLSearchParams({ ...(kind ? { kind } : {}), ...(since ? { since } : {}) });
    const r = await fetchImpl(`${base}/api/loom/scorecards?${q}`, { headers: { authorization: `Bearer ${readFileSync(tokenFile, 'utf-8').trim()}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { rows: [], error: `scorecards: ${r.status}` };
    const rows = rowsOf(await r.json());
    return rows ? { rows } : { rows: [], error: 'scorecards: no rows in the answer' };
  } catch (e) { return { rows: [], error: `scorecards: ${e.message}` }; }
}

/** Resolve with what the runtime has: its list (only `harness`'s models, if named), the agent's settings, the accounts provider, loom's scorecards. */
//   role   a worker role's id (t-2036): only its eligible models, most wanted first after `prefer`
//   gate   a worker job's capacity admission (allocator.mjs capacityGate, t-2037): a new job's at its start, a pinned
//          job's at each resume (slice 4)
//   pin    a worker job's assigned model (t-2038): that model and no other; a job is never moved by a preference,
//          a new model or a quota reset. Out of quota, it waits (the 409 a caller treats as out of quota).
export async function resolveFor(env, { agent, venue, venueKind: told, prefer = [], harness, conversation, avoid = [], accounts, now = new Date(), fetchImpl, role, pin, gate } = {}) {
  if (!AGENT.test(agent ?? '')) fail('which agent');
  const kind = venueKind(venue, told);
  const s = load(env);
  const { list: everything, agents } = modelsOf(s);
  let all = everything;
  const head = [];
  if (pin) {
    all = everything.filter((m) => m.id === pin);
    if (!all.length) fail(`its assigned model ${pin} is no longer in the runtime's model list`, 410);
    head.push(`assigned model ${pin}: a worker job keeps the model it started on`);
  } else if (role) {
    // A job's role as it was admitted ({id, version, eligible}), or a role's id read from the catalog now.
    const r = typeof role === 'object' ? role : roleOf(s, role);
    all = r.eligible.map((id) => everything.find((m) => m.id === id)).filter(Boolean);
    if (!all.length) fail(`role ${r.id} has no eligible model left in the runtime's model list`, 409);
    prefer = [...prefer, ...r.eligible];
    head.push(`role ${r.id} (catalog v${r.version}): eligible ${r.eligible.join(', ')}`);
  }
  // A resume keeps its harness: its slot is that harness's session.
  const list = harness ? all.filter((m) => m.harness === harness) : all;
  if (!list.length) fail(`the runtime has no ${harness} model${pin || role ? ` for ${pin ? `assigned model ${pin}` : `role ${role.id ?? role}`}` : ''}`, 409);
  let listed = null;
  // `none` is a household that doesn't want quota read; off the control plane there are no box reports to read.
  try { listed = accounts.kind === 'none' ? null : accounts.list(); } catch { listed = null; }
  const since = sinceDay(now);
  const cards = await fetchScorecards(env, { kind, since, fetchImpl });
  // A pinned job has its model already: the owner's harness choice applies when a job is assigned, not after.
  const choice = pin ? 'auto' : modelChoiceOf(s, agent, conversation).effective;
  const r = resolveModel({ agent, kind, models: list, all, settings: agents[agent] ?? {}, accounts: listed,
    scorecards: cards.rows, prefer, since, avoid, harnessChoice: choice, now: now.getTime(), ...(gate ? { gate } : {}) });
  if (gate) r.why.push(`capacity: ${r.admission ?? 'admitted with the conversations\' reserve kept'}`);
  if (choice !== 'auto') r.why.unshift(`owner preference: ${choice}${conversation ? ' for this conversation' : ''}`);
  r.why.unshift(...head);
  if (role && !pin) r.role = typeof role === 'object' ? role.id : role;
  if (cards.error) r.why.push(cards.error);
  return r;
}
