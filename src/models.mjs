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
import { readFileSync } from 'node:fs';
import { accountsFor, hasRoom } from './accounts.mjs';
import { StateError, load, update } from './state.mjs';
import { setting } from './piece.mjs';

export const FAMILY = /^(anthropic|openai|google|mistral|local:[a-z0-9][a-z0-9._-]{0,39})$/;
export const HARNESSES = ['claude', 'codex'];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/;
const AGENT = /^[a-z][a-z0-9-]{0,39}$/;
export const VENUE_KINDS = ['live', 'scheduled', 'agent'];
/** The venues whose kind the runtime knows without being told (conversations.md: core's own, and the adapters'). */
export const VENUE_KIND = { session: 'live', discord: 'live', slack: 'live', wake: 'scheduled', relay: 'agent' };
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

/**
 * Pick the model for a body. Pure: everything it reads is passed in.
 *   models     the model list
 *   settings   the agent's {allow?, prefer?}
 *   accounts   the accounts provider's list ({accounts, assign}), or null when there's none or it couldn't be read
 *   scorecards rows from loom, [] when there are none
 *   prefer     a preference for this one body (the caller's), ahead of the agent's own
 * Returns {model, harness, family, account?, kind, why: [lines]}, or throws a StateError (409) naming why no model
 * is left.
 */
export function resolveModel({ agent, kind, models, settings = {}, accounts, scorecards = [], prefer = [], since }) {
  const why = [];
  const allowed = settings.allow?.length ? models.filter((m) => settings.allow.includes(m.id)) : models;
  if (!allowed.length) fail(`${agent} may use none of the runtime's models`, 409);
  // 1. Hard limits: allowed, and an account with quota left (a local model needs none).
  const room = new Map();
  for (const m of allowed) {
    const provider = providerOf(m.family);
    if (!provider) { room.set(m.id, { ok: true }); continue; }
    if (!accounts) { room.set(m.id, { ok: true, unread: true }); continue; }
    const mine = accountsFor(accounts, agent, provider);
    const acct = mine.find((a) => hasRoom(a, m.window));
    room.set(m.id, acct ? { ok: true, account: acct.name } : { ok: false, reason: mine.length ? `${mine.map((a) => a.name).join(', ')} out of quota` : `no ${provider} account for ${agent}` });
  }
  if (!accounts) why.push('quota not checked: no account list (no provider, or it couldn\'t be read); fails open, as the resolvers before did');
  const usable = allowed.filter((m) => room.get(m.id).ok);
  for (const m of allowed) if (!room.get(m.id).ok) why.push(`${m.id}: ${room.get(m.id).reason}`);
  if (!usable.length) fail(`no model is left for ${agent}: ${why.join('; ')}`, 409);
  // 2. The preference: this body's, then the agent's, then the list's order.
  const order = [...prefer, ...(settings.prefer ?? [])];
  let pick = order.map((id) => usable.find((m) => m.id === id)).find(Boolean) ?? usable[0];
  why.push(`${pick.id}: ${order.includes(pick.id) ? 'preferred' : 'first allowed with quota'}`);
  // 3. Scorecards: another usable model graded at least DEMOTE_BY higher for this kind takes its place.
  const mineScore = gradedOf(scorecards, pick.id, kind, { since });
  if (mineScore !== undefined) {
    const better = usable.map((m) => ({ m, g: gradedOf(scorecards, m.id, kind, { since }) }))
      .filter((x) => x.m.id !== pick.id && x.g !== undefined && x.g - mineScore >= DEMOTE_BY)
      .sort((x, y) => y.g - x.g)[0];
    if (better) {
      why.push(`${pick.id} demoted for ${kind}: graded ${mineScore.toFixed(2)}, ${better.m.id} ${better.g.toFixed(2)}`);
      pick = better.m;
    }
  }
  const r = room.get(pick.id);
  return { model: pick.id, harness: pick.harness, family: pick.family, kind, ...(r.account ? { account: r.account } : {}), why };
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
export async function resolveFor(env, { agent, venue, venueKind: told, prefer = [], harness, accounts, now = new Date(), fetchImpl } = {}) {
  if (!AGENT.test(agent ?? '')) fail('which agent');
  const kind = venueKind(venue, told);
  const { list: all, agents } = readModels(env);
  // A resume keeps its harness: its slot is that harness's session.
  const list = harness ? all.filter((m) => m.harness === harness) : all;
  if (!list.length) fail(`the runtime has no ${harness} model`, 409);
  let listed = null;
  // No provider (`none`) is a household whose harnesses keep their own logins: quota isn't the runtime's to check.
  try { listed = accounts.kind === 'none' ? null : accounts.list(); } catch { listed = null; }
  const since = sinceDay(now);
  const cards = await fetchScorecards(env, { kind, since, fetchImpl });
  const r = resolveModel({ agent, kind, models: list, settings: agents[agent] ?? {}, accounts: listed, scorecards: cards.rows, prefer, since });
  if (cards.error) r.why.push(cards.error);
  return r;
}
