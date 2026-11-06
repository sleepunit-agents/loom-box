// Model accounts (docs/model-accounts.md; loom docs/specs/agent-runtime.md, section 2): a view, never a store.
//
// Nobody configures an account here. Each box reports which harnesses it has and whether each is logged in (the
// CLI's own status command, logins.mjs), and how full the account is, from what its harness wrote about its own
// runs. An account is what those reports have in common: boxes logged in to the same account (the same short hash
// of what the status command says) share one account, and so one quota. A box whose status names no account
// (Codex's) is an account of its own. An API key is just a secret in the secrets store, mapped into an agent's
// houses under the name `anthropic-api-key` or `openai-api-key`; it counts as an account for that agent everywhere.
//
// The list (what models.mjs reads):
//   {accounts: [{name, provider, harness, kind: 'login'|'api-key', label, plan, boxes: [id], agents: [agent],
//                credentials: [{kind, status}], usage: {"5h": 0.4, "7d": 0.2, reset_7d, checked, held?}}]}
// `agents` is which agents the account may do work for: the agents whose owner owns one of its boxes (owners.mjs).
// Nothing here ever holds a credential.
//
// **One login, one quota** (t-1913). Boxes on one account are one entry, wherever it's listed (accounts, usage, the
// resolver), keyed by what the box's CLI says the account is (logins.mjs, identify). Its usage is every copy's
// readings, box- or house-taken, from any of its boxes, merged by one rule (mergeUsage):
//   - per window, the newest reading (by `checked`) is the account's: usage only rises within a window, so a newer
//     reading is the truth, whether it's higher or (after a reset) lower; a box's own reading doesn't outrank a newer
//     house reading;
//   - a copy that read nothing adds nothing: an unread box can't mask a known-full reading (it's one quota);
//   - a full reading whose reset time has passed counts as reset (windowNow), with nothing newer to say otherwise;
//   - only an account with no reading at all fails open (has room), as it did: its first turn reads it, and a refusal
//     holds it at once.
//
// A **hold** (t-1907): an account its provider has just refused for a usage limit (a body's turn ended on one,
// runners.mjs `turn().limited`) has no room until the refusal's reset, whatever the readings say. Readings come from
// status lines and rollouts, after a turn, so they lag: a hold closes that gap the moment a refusal is seen.
// state.json `quotaHolds`: {<account name>: {until (s), at (s), why}}; one past its `until` is gone.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, stateDir, update } from './state.mjs';
import { LOGIN_HARNESSES } from './logins.mjs';
import { boxOwner, mayUseLogin, membersOf } from './owners.mjs';
import { setting } from './piece.mjs';

export const PROVIDERS = /^(anthropic|openai|google|mistral)$/;
/** A usage window this full counts as out of room. */
export const FULL = 0.97;
/** A box not seen for this long doesn't count: its login can't run anything now. */
export const STALE_MS = 10 * 60_000;
const API_KEY = /^(anthropic|openai)-api-key$/;

export class AccountsError extends Error {}

const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const windowOk = (k) => /^[0-9]+[hd](_[a-z0-9]+)?$/.test(k);

/**
 * Usage readings, newest per window, flattened to {"7d": 0.6, reset_7d: …, checked}: the rule above. On a tie in
 * `checked`, the fuller reading (two copies read at the same second can't both be right; the fuller one can't
 * overspend).
 */
function mergeUsage(readings) {
  const u = {};
  const at = {};
  for (const r of readings) {
    if (!r || typeof r !== 'object') continue;
    const t = typeof r.checked === 'number' ? r.checked : 0;
    for (const [w, v] of Object.entries(r.windows ?? {})) {
      if (!windowOk(w) || typeof v !== 'number') continue;
      if (at[w] !== undefined && (at[w] > t || (at[w] === t && u[w] >= v))) continue;
      at[w] = t; u[w] = v;
      delete u[`reset_${w}`];
      if (typeof r.resets?.[w] === 'number') u[`reset_${w}`] = r.resets[w];
    }
    if (t > (u.checked ?? 0)) u.checked = t;
  }
  return u;
}

const checkedOf = (r) => (r && typeof r.checked === 'number' ? r.checked : 0);
function newestFrom(box, house) {
  const b = Math.max(-1, ...box.map(checkedOf)), h = Math.max(-1, ...house.map(checkedOf));
  return b < 0 && h < 0 ? null : b >= h ? 'box' : 'house';
}

/** The accounts, from the state's box reports and agents' secrets. Pure but for the clock. */
export function deriveAccounts(s, { members, nowMs = Date.now() } = {}) {
  const agents = Object.keys(s.agents ?? {});
  const by = new Map();
  for (const [id, b] of Object.entries(s.boxes ?? {})) {
    if (b.revoked) continue;
    // A box not seen lately can't run anything now: its logins offer nothing.
    if (!(b.local || (b.lastSeen && nowMs - Date.parse(b.lastSeen) < STALE_MS))) continue;
    const fresh = true;
    for (const [h, st] of Object.entries(b.harnesses ?? {})) {
      const def = LOGIN_HARNESSES[h];
      if (!def || !st?.loggedIn) continue;
      // The account's key: its box's owner, and a hash salted with this household's own secret of what the box
      // reported (or of the box, when its CLI names no account). A box chooses what it reports, so the owner in front
      // keeps one box from merging into another owner's account; the salt keeps the hash meaningless elsewhere.
      const owner = boxOwner(b, members ?? [{ person: 'owner', agents: '*' }]);
      const name = `${owner}:${h}-${createHash('sha256').update(`${s.accountSalt ?? ''}\0${owner}\0${st.account ?? `box:${id}`}`).digest('hex').slice(0, 10)}`;
      const a = by.get(name) ?? { name, owner, provider: def.provider, harness: h, kind: 'login', label: '', plan: '', method: st.method ?? '', boxes: [], agents: new Set(), boxReadings: [], houseReadings: [], fresh: false };
      a.boxes.push(id);
      a.fresh ||= !!fresh;
      if (st.plan && !a.plan) a.plan = String(st.plan);
      // A box's usage for a harness: its own reading ({box}) and a house's ({house}); an old flat one is the box's.
      const u = b.usage?.[h];
      const slot = u && (u.box || u.house) ? u : u?.windows ? { box: u } : {};
      if (slot.box) a.boxReadings.push(slot.box);
      if (slot.house) a.houseReadings.push(slot.house);
      const plan = slot.box?.plan ?? slot.house?.plan;
      if (plan && !a.plan) a.plan = plan;
      // The same rule the claim mounts a login by (owners.mjs, mayUseLogin): never offer what a house won't be given.
      for (const ag of agents) if (mayUseLogin(b, s.agents[ag], ag, h, members ?? [{ person: 'owner', agents: '*' }])) a.agents.add(ag);
      by.set(name, a);
    }
  }
  const accounts = [...by.values()].map((a) => ({
    name: a.name, provider: a.provider, harness: a.harness, kind: 'login',
    // What anyone but the household owner sees of an account: this label, never its key.
    label: `${LOGIN_HARNESSES[a.harness].label}${a.plan ? ` ${cap(a.plan)}` : ''} (${a.owner}'s)`,
    plan: a.plan, boxes: a.boxes.sort(), agents: [...a.agents].sort(),
    credentials: [{ kind: 'login', status: a.fresh ? 'valid' : 'unknown' }],
    // Every copy's readings, box- or house-taken, on every box of the account: the newest per window (above).
    usage: mergeUsage([...a.boxReadings, ...a.houseReadings]),
    // Where the newest reading came from (a box's own, or a house's).
    usageFrom: newestFrom(a.boxReadings, a.houseReadings),
  }));
  // Holds: an account its provider refused for a usage limit, until that limit resets (above).
  const nowS = Math.floor(nowMs / 1000);
  for (const a of accounts) {
    const h = s.quotaHolds?.[a.name];
    if (h && Number.isFinite(h.until) && h.until > nowS) a.usage = { ...a.usage, held: h.until, ...(typeof h.why === 'string' ? { heldWhy: h.why.slice(0, 200) } : {}) };
  }
  // API keys: a secret mapped into an agent's houses as anthropic-api-key or openai-api-key.
  for (const [ag, cfg] of Object.entries(s.agents ?? {})) {
    for (const as of Object.keys(cfg.secrets ?? {})) {
      const m = API_KEY.exec(as);
      if (!m) continue;
      const name = `${m[1]}-api-key-${ag}`;
      const h = s.quotaHolds?.[name];
      accounts.push({ name, provider: m[1], harness: m[1] === 'anthropic' ? 'claude' : 'codex', kind: 'api-key',
        label: `${cap(m[1])} API key (${ag})`, plan: 'API', boxes: [], agents: [ag], credentials: [{ kind: 'api-key', status: 'unknown' }],
        usage: h && Number.isFinite(h.until) && h.until > nowS ? { held: h.until } : {} });
    }
  }
  return { accounts: accounts.sort((x, y) => x.name.localeCompare(y.name)) };
}

/** A usage window's reading, now: a window whose reset time has passed has reset (its reading is from before). */
function windowNow(u, w, nowS) {
  const v = u[w];
  const reset = u[`reset_${w}`];
  return typeof reset === 'number' && reset <= nowS ? 0 : v;
}

/**
 * Whether an account has room: not held (a provider's refusal, until its reset), and every window it reports (and
 * `window`, a model's own, if it names one) under FULL. A window past its reset time has room again: the reading that
 * filled it is from before (otherwise an account read as full would stay full until a body ran on it, and none would).
 */
export function hasRoom(account, window, nowMs = Date.now()) {
  const u = account.usage ?? {};
  const nowS = Math.floor(nowMs / 1000);
  if (typeof u.held === 'number' && u.held > nowS) return false;
  // A reading that isn't a number is no room (fail closed, as `v < FULL` was).
  const full = (k) => { const v = windowNow(u, k, nowS); return typeof v !== 'number' || v >= FULL; };
  const general = Object.keys(u).filter((k) => windowOk(k) && !k.includes('_')).every((k) => !full(k));
  return general && (!window || u[window] === undefined || !full(window));
}

/**
 * When an account has room again (seconds), as far as it's known: the latest of its hold and its full windows'
 * resets. Null when it has room now, or when what's full says no reset.
 */
export function roomAt(account, window, nowMs = Date.now()) {
  if (hasRoom(account, window, nowMs)) return null;
  const u = account.usage ?? {};
  const nowS = Math.floor(nowMs / 1000);
  const times = [];
  if (typeof u.held === 'number' && u.held > nowS) times.push(u.held);
  for (const k of Object.keys(u).filter((x) => windowOk(x) && (!x.includes('_') || x === window))) {
    const v = windowNow(u, k, nowS);
    if (typeof v === 'number' && v < FULL) continue;
    const r = u[`reset_${k}`];
    if (typeof r !== 'number') return null;
    times.push(r);
  }
  return times.length ? Math.max(...times) : null;
}

/** How long a hold lasts when the refusal says no reset time: the next turn on it finds out again. */
export const HOLD_DEFAULT_S = 30 * 60;
/** A hold is never longer than this (a 7-day window's reset, and a little). */
export const HOLD_MAX_S = 8 * 86400;

/**
 * Hold an account (by name), until `until` (seconds): its provider refused it for a usage limit. When the refusal names
 * no reset (an API key's credit gone has none), HOLD_DEFAULT_S, doubled for each hold of it with no reset in the last
 * day: a condition that doesn't lift isn't tried again every half hour (each try sends a conversation home and back).
 * Kept in state.json; holds past their time are dropped as each one is written, a streak's after a day.
 */
export function holdAccount(env, { name, until, why }, nowMs = Date.now()) {
  if (typeof name !== 'string' || !name || name.length > 120) throw new AccountsError('hold which account');
  const nowS = Math.floor(nowMs / 1000);
  const known = Number.isFinite(until) && until > nowS;
  return update(env, (s) => {
    // Kept while held, and a day after (for the no-reset streak).
    const holds = Object.fromEntries(Object.entries(s.quotaHolds ?? {}).filter(([, h]) => Number.isFinite(h?.until) && h.until + 86400 > nowS));
    const prev = holds[name];
    const streak = known ? 0 : (prev?.blind ?? 0) + (prev && prev.at > nowS - 86400 ? 1 : 0);
    const end = Math.min(nowS + HOLD_MAX_S, known ? Math.floor(until) : nowS + HOLD_DEFAULT_S * 2 ** Math.min(streak, 12));
    holds[name] = { until: Math.max(end, prev?.until > nowS ? prev.until : 0), at: nowS, ...(known ? {} : { blind: streak }), ...(typeof why === 'string' && why ? { why: why.slice(0, 200) } : {}) };
    s.quotaHolds = holds;
    return { name, until: holds[name].until };
  });
}

/** Usage: each account's windows, when they reset, and whether it has room. */
export function usageOf({ accounts }, nowMs = Date.now()) {
  return accounts.map((a) => {
    const windows = {}, resets = {};
    for (const [k, v] of Object.entries(a.usage)) {
      if (k.startsWith('reset_')) resets[k.slice(6)] = v;
      else if (windowOk(k)) windows[k] = v;
    }
    const at = roomAt(a, undefined, nowMs);
    return { account: a.name, provider: a.provider, label: a.label, windows, resets, ...(a.usage.checked ? { checked: a.usage.checked } : {}),
      ...(a.usage.held ? { held: a.usage.held, ...(a.usage.heldWhy ? { heldWhy: a.usage.heldWhy } : {}) } : {}), room: hasRoom(a, undefined, nowMs), ...(at ? { roomAt: at } : {}) };
  });
}

/**
 * The accounts a body ran on: by its record's account key (accountKey, the resolver's), else (a record from before)
 * every one of the agent's on that harness with its label.
 */
export function accountsOfRecord({ accounts }, rec) {
  if (rec?.accountKey) return accounts.filter((a) => a.name === rec.accountKey);
  return accounts.filter((a) => a.harness === rec?.harness && (a.label ?? a.name) === rec?.account && (a.agents ?? []).includes(rec?.agent));
}

/** An agent's accounts for a provider: the ones that may do its work, logged-in boxes' first, then its API keys. */
export function accountsFor({ accounts }, agent, provider) {
  return accounts.filter((a) => a.provider === provider && a.agents.includes(agent) && a.credentials.some((c) => c.status !== 'expired'))
    .sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === 'login' ? -1 : 1));
}

/** The runtime's accounts: the view over its own state. */
export function stateAccounts(env, { now = () => Date.now() } = {}) {
  const provider = {
    kind: 'boxes',
    list() {
      // Off the control plane (a body in a house) there are no box reports to read: say so, and the resolver fails open.
      if (!existsSync(join(stateDir(env), 'state.json'))) throw new AccountsError('no box reports here (this isn\'t the control plane)');
      return deriveAccounts(load(env), { members: membersOf(env), nowMs: now() });
    },
    usage: () => usageOf(provider.list(), now()),
    hold: (h) => holdAccount(env, h, now()),
  };
  return provider;
}

/** No accounts: quota isn't read (LOOM_RUNTIME_ACCOUNTS=none). */
export const noAccounts = { kind: 'none', list: () => ({ accounts: [] }), usage: () => [] };

/** An in-memory list: for tests. */
export function staticAccounts({ accounts = [] } = {}) {
  const list = { accounts };
  const holds = [];
  return {
    kind: 'static', list: () => list, usage: () => usageOf(list), holds,
    // A hold, as the state's would apply it: on the account itself.
    hold(h) {
      holds.push(h);
      const a = accounts.find((x) => x.name === h.name);
      if (a) a.usage = { ...a.usage, held: Math.max(a.usage?.held ?? 0, h.until ?? Math.floor(Date.now() / 1000) + HOLD_DEFAULT_S) };
      return { name: h.name, until: a?.usage.held };
    },
  };
}

/**
 * The accounts as they'd be if some harnesses' accounts were out (`models resolve --suppose-out codex`): for the
 * owner to see what the resolver would do then, without spending a real account.
 */
export function supposeOut(provider, harnesses, nowMs = Date.now()) {
  const until = Math.floor(nowMs / 1000) + HOLD_DEFAULT_S;
  const out = (l) => ({ accounts: l.accounts.map((a) => (harnesses.includes(a.harness) ? { ...a, usage: { ...a.usage, held: until, heldWhy: 'supposed out (--suppose-out)' } } : a)) });
  return { kind: provider.kind, list: () => out(provider.list()), usage: () => usageOf(out(provider.list()), nowMs) };
}

/**
 * The household's accounts: the boxes' reports (the default), or `none` (LOOM_RUNTIME_ACCOUNTS=none: a household
 * that doesn't want quota read). There is no command to plug in: accounts aren't configured, they're reported.
 */
export function accountsFrom(env = process.env, opts = {}) {
  const v = setting(env, 'ACCOUNTS');
  if (v === 'none') return noAccounts;
  if (v && v !== 'boxes') throw new AccountsError('LOOM_RUNTIME_ACCOUNTS is unset (the boxes\' reports) or none');
  return stateAccounts(env, opts);
}
