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
    return s.models;
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
function resolveRoom({ agent, m, accounts, now }) {
  const provider = providerOf(m.family);
  if (!provider) return { ok: true };
  if (!accounts) return { ok: true, unread: true };
  // Only an account the model's own harness can run on: a Claude login runs Claude Code, not Codex.
  const mine = accountsFor(accounts, agent, provider).filter((a) => !a.harness || a.harness === m.harness);
  const acct = mine.find((a) => hasRoom(a, m.window, now));
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
export function resolveModel({ agent, kind, models, all = models, settings = {}, accounts, scorecards = [], prefer = [], since, avoid = [], now = Date.now() }) {
  const why = [];
  const allowed = settings.allow?.length ? models.filter((m) => settings.allow.includes(m.id)) : models;
  if (!allowed.length) fail(`${agent} may use none of the runtime's models`, 409);
  // 1. Hard limits: allowed, and an account with quota left (a local model needs none).
  const room = new Map();
  // An avoided harness has no room for this body; its own reason (out of quota) when it has one.
  for (const m of allowed) {
    const q = resolveRoom({ agent, m, accounts, now });
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
  const preferred = choose(allAllowed.length ? allAllowed : allowed, false);
  if (!room.has(preferred.id)) {
    const sub = resolveRoom({ agent, m: preferred, accounts, now });
    room.set(preferred.id, sub);
  }
  if (!usable.length) {
    const e = new StateError(`no model is left for ${agent}: ${why.join('; ')}`, 409);
    e.out = allowed.map((m) => room.get(m.id).out).filter(Boolean).filter((o, i, all) => all.findIndex((x) => x.harness === o.harness && x.account === o.account) === i);
    throw e;
  }
  const pick = choose(usable, true);
  const r = room.get(pick.id);
  const gone = room.get(preferred.id);
  const fallback = pick.harness !== preferred.harness && !gone.ok
    ? { from: preferred.harness, ...(gone.out?.account ? { account: gone.out.account } : {}), ...(gone.out?.until ? { until: gone.out.until } : {}), why: gone.reason }
    : null;
  if (fallback) why.push(`a fallback: ${preferred.id} (${preferred.harness}) is preferred, and ${gone.reason}`);
  // accountKey: which account, for the runtime's own records (a hold); never told to a body.
  return { model: pick.id, harness: pick.harness, family: pick.family, kind, ...(r.account ? { account: r.account } : {}), ...(r.accountKey ? { accountKey: r.accountKey } : {}), why,
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
export async function resolveFor(env, { agent, venue, venueKind: told, prefer = [], harness, conversation, avoid = [], accounts, now = new Date(), fetchImpl } = {}) {
  if (!AGENT.test(agent ?? '')) fail('which agent');
  const kind = venueKind(venue, told);
  const { list: all, agents } = readModels(env);
  // A resume keeps its harness: its slot is that harness's session.
  const list = harness ? all.filter((m) => m.harness === harness) : all;
  if (!list.length) fail(`the runtime has no ${harness} model`, 409);
  let listed = null;
  // `none` is a household that doesn't want quota read; off the control plane there are no box reports to read.
  try { listed = accounts.kind === 'none' ? null : accounts.list(); } catch { listed = null; }
  const since = sinceDay(now);
  const cards = await fetchScorecards(env, { kind, since, fetchImpl });
  const choice = readModelChoice(env, agent, conversation).effective;
  const settings = agents[agent] ?? {};
  const resolve = (models, universe, order) => resolveModel({ agent, kind, models, all: universe, settings, accounts: listed, scorecards: cards.rows, prefer: order, since, avoid, now: now.getTime() });
  let r;
  if (!harness && choice !== 'auto') {
    const wanted = all.filter((m) => m.harness === choice);
    try { r = resolve(wanted, wanted, prefer); }
    catch (e) { if (!(e instanceof StateError && e.status === 409)) throw e; }
    if (!r) r = resolve(list, all, [...wanted.map((m) => m.id), ...prefer]);
    r.why.unshift(`owner preference: ${choice}${conversation ? ' for this conversation' : ''}`);
  } else r = resolve(list, all, prefer);
  if (cards.error) r.why.push(cards.error);
  return r;
}
