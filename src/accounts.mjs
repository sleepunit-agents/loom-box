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
//                credentials: [{kind, status}], usage: {"5h": 0.4, "7d": 0.2, reset_7d, checked}}]}
// `agents` is which agents the account may do work for: the agents whose owner owns one of its boxes (owners.mjs).
// Nothing here ever holds a credential.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, stateDir } from './state.mjs';
import { LOGIN_HARNESSES } from './logins.mjs';
import { membersOf, ownersAllow } from './owners.mjs';
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

/** Usage readings, newest per window, flattened to {"7d": 0.6, reset_7d: …, checked}. */
function mergeUsage(readings) {
  const u = {};
  const at = {};
  for (const r of readings) {
    if (!r || typeof r !== 'object') continue;
    const t = typeof r.checked === 'number' ? r.checked : 0;
    for (const [w, v] of Object.entries(r.windows ?? {})) {
      if (!windowOk(w) || typeof v !== 'number') continue;
      if (at[w] !== undefined && at[w] > t) continue;
      at[w] = t; u[w] = v;
      delete u[`reset_${w}`];
      if (typeof r.resets?.[w] === 'number') u[`reset_${w}`] = r.resets[w];
    }
    if (t > (u.checked ?? 0)) u.checked = t;
  }
  return u;
}

/** The accounts, from the state's box reports and agents' secrets. Pure but for the clock. */
export function deriveAccounts(s, { members, nowMs = Date.now() } = {}) {
  const agents = Object.keys(s.agents ?? {});
  const by = new Map();
  for (const [id, b] of Object.entries(s.boxes ?? {})) {
    if (b.revoked) continue;
    const fresh = b.local || (b.lastSeen && nowMs - Date.parse(b.lastSeen) < STALE_MS);
    for (const [h, st] of Object.entries(b.harnesses ?? {})) {
      const def = LOGIN_HARNESSES[h];
      if (!def || !st?.loggedIn) continue;
      const name = st.account ?? `${h}-box-${id.replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
      const a = by.get(name) ?? { name, provider: def.provider, harness: h, kind: 'login', label: '', plan: '', method: st.method ?? '', boxes: [], agents: new Set(), readings: [], fresh: false };
      a.boxes.push(id);
      a.fresh ||= !!fresh;
      if (st.plan && !a.plan) a.plan = String(st.plan);
      if (b.usage?.[h]) { a.readings.push(b.usage[h]); if (b.usage[h].plan && !a.plan) a.plan = b.usage[h].plan; }
      for (const ag of agents) if (ownersAllow(b, ag, members)) a.agents.add(ag);
      by.set(name, a);
    }
  }
  const accounts = [...by.values()].map((a) => ({
    name: a.name, provider: a.provider, harness: a.harness, kind: 'login',
    label: `${LOGIN_HARNESSES[a.harness].label}${a.plan ? ` ${cap(a.plan)}` : ''} · ${a.name.slice(-6)}`,
    plan: a.plan, boxes: a.boxes.sort(), agents: [...a.agents].sort(),
    credentials: [{ kind: 'login', status: a.fresh ? 'valid' : 'unknown' }],
    usage: mergeUsage(a.readings),
  }));
  // API keys: a secret mapped into an agent's houses as anthropic-api-key or openai-api-key.
  for (const [ag, cfg] of Object.entries(s.agents ?? {})) {
    for (const as of Object.keys(cfg.secrets ?? {})) {
      const m = API_KEY.exec(as);
      if (!m) continue;
      accounts.push({ name: `${m[1]}-api-key-${ag}`, provider: m[1], harness: m[1] === 'anthropic' ? 'claude' : 'codex', kind: 'api-key',
        label: `${cap(m[1])} API key (${ag})`, plan: 'API', boxes: [], agents: [ag], credentials: [{ kind: 'api-key', status: 'unknown' }], usage: {} });
    }
  }
  return { accounts: accounts.sort((x, y) => x.name.localeCompare(y.name)) };
}

/** Whether an account has room: every window it reports (and `window`, a model's own, if it names one) under FULL. */
export function hasRoom(account, window) {
  const u = account.usage ?? {};
  const general = Object.entries(u).filter(([k]) => windowOk(k) && !k.includes('_')).every(([, v]) => v < FULL);
  return general && (!window || u[window] === undefined || u[window] < FULL);
}

/** Usage: each account's windows, when they reset, and whether it has room. */
export function usageOf({ accounts }) {
  return accounts.map((a) => {
    const windows = {}, resets = {};
    for (const [k, v] of Object.entries(a.usage)) {
      if (k.startsWith('reset_')) resets[k.slice(6)] = v;
      else if (k !== 'checked') windows[k] = v;
    }
    return { account: a.name, provider: a.provider, label: a.label, windows, resets, ...(a.usage.checked ? { checked: a.usage.checked } : {}), room: hasRoom(a) };
  });
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
    usage: () => usageOf(provider.list()),
  };
  return provider;
}

/** No accounts: quota isn't read (LOOM_RUNTIME_ACCOUNTS=none). */
export const noAccounts = { kind: 'none', list: () => ({ accounts: [] }), usage: () => [] };

/** An in-memory list: for tests. */
export function staticAccounts({ accounts = [] } = {}) {
  const list = { accounts };
  return { kind: 'static', list: () => list, usage: () => usageOf(list) };
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
