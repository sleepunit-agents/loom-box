// Model accounts (loom docs/specs/agent-runtime.md, section 2): the household's accounts with model providers,
// what each has left, and a credential issued into a house (`sub:<provider>` in an agent's house secrets).
//
// The runtime holds the accounts through a seam, an **accounts provider**. This package defines the interface and
// talks to a provider; it carries no provider's sign-in code. How a household signs in to its accounts, refreshes
// them and reads their usage is the provider's, and it may be private to that household. The one shipped here runs a
// configured command (LOOM_RUNTIME_ACCOUNTS, an argv as JSON), by default `loom subscriptions`, the household's
// subscriptions code where it lives today.
//
// The interface:
//   list()                          → {accounts: [Account], assign: {agent: [account name, …]}}
//   usage()                         → [{account, provider, windows: {"5h": 0.4, "7d": 0.2, …}, resets, checked, room}]
//   issue(agent, provider, kind?)   → {account, name, value}: what one of the agent's houses runs on, now
//
// An Account is {name, provider, label, plan, owner, credentials: [{kind, status, expires?, checked?}], usage}:
// names and states only. Nothing here ever holds a credential's value except issue's answer, which goes straight
// into a house's secrets (control.mjs, claim).
//
// A command provider answers two verbs:
//   <argv> accounts --json                        the list, as above, on stdout ({v: 1, accounts, assign})
//   <argv> issue <agent> <provider> [--kind <k>]  the value on stdout; `issued <account>/<name>` on stderr
import { spawnSync } from 'node:child_process';
import { setting } from './piece.mjs';

export const PROVIDERS = /^(anthropic|openai|google|mistral)$/;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const CRED_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KIND = /^[a-z][a-z0-9-]{0,23}$/;
const WINDOW = /^[0-9]+[hd](_[a-z0-9]+)?$/;
/** A usage window this full counts as out of room (the subscriptions code's own line). */
export const FULL = 0.97;

export class AccountsError extends Error {}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A provider's list, checked and cut down to names and states: whatever else it carries is dropped. */
export function checkList(raw) {
  const accounts = [];
  for (const a of Array.isArray(raw?.accounts) ? raw.accounts : []) {
    if (!a || !NAME.test(a.name ?? '') || !PROVIDERS.test(a.provider ?? '')) continue;
    const credentials = (Array.isArray(a.credentials) ? a.credentials : []).slice(0, 16)
      .filter((c) => c && KIND.test(c.kind ?? ''))
      .map((c) => ({ kind: c.kind, status: ['valid', 'expired', 'unknown'].includes(c.status) ? c.status : 'unknown',
        ...(num(c.expires) ? { expires: num(c.expires) } : {}), ...(num(c.checked) ? { checked: num(c.checked) } : {}) }));
    const usage = {};
    for (const [k, v] of Object.entries(a.usage && typeof a.usage === 'object' ? a.usage : {})) {
      if ((WINDOW.test(k) || /^reset_[0-9]+[hd](_[a-z0-9]+)?$/.test(k) || k === 'checked') && num(v) !== undefined) usage[k] = v;
    }
    accounts.push({ name: a.name, provider: a.provider, label: str(a.label, 80) || a.name, plan: str(a.plan, 40), owner: str(a.owner, 60), credentials, usage });
  }
  const assign = {};
  for (const [agent, order] of Object.entries(raw?.assign && typeof raw.assign === 'object' ? raw.assign : {})) {
    if (NAME.test(agent) && Array.isArray(order)) assign[agent] = order.filter((n) => typeof n === 'string' && NAME.test(n)).slice(0, 16);
  }
  return { accounts, assign };
}

/** Whether an account has room: every window it reports (and `window`, a model's own, if it names one) under FULL. */
export function hasRoom(account, window) {
  const u = account.usage ?? {};
  const general = ['5h', '7d'].every((w) => u[w] === undefined || u[w] < FULL);
  return general && (!window || u[window] === undefined || u[window] < FULL);
}

/** Usage, from a list: each account's windows, when they reset, and whether it has room. */
export function usageOf({ accounts }) {
  return accounts.map((a) => {
    const windows = {}, resets = {};
    for (const [k, v] of Object.entries(a.usage)) {
      if (k.startsWith('reset_')) resets[k.slice(6)] = v;
      else if (k !== 'checked') windows[k] = v;
    }
    return { account: a.name, provider: a.provider, windows, resets, ...(a.usage.checked ? { checked: a.usage.checked } : {}), room: hasRoom(a) };
  });
}

/**
 * An agent's accounts for a provider, in its order: the ones assigned to it, else every account of that provider
 * (the subscriptions code's own rule, `pick`). A usable one has a credential that isn't expired.
 */
export function accountsFor({ accounts, assign }, agent, provider) {
  const ofProvider = accounts.filter((a) => a.provider === provider);
  const order = (assign[agent] ?? []).map((n) => ofProvider.find((a) => a.name === n)).filter(Boolean);
  return (order.length ? order : [...ofProvider].sort((x, y) => x.name.localeCompare(y.name)))
    .filter((a) => a.credentials.some((c) => c.status !== 'expired'));
}

/** A provider that runs a command (an argv): the household's own accounts code, wherever it lives. */
export function commandAccounts(argv, { env = process.env, run = spawnSync } = {}) {
  if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string' && a)) throw new AccountsError('the accounts command is an argv: a JSON list of strings');
  const call = (args, timeout) => {
    const r = run(argv[0], [...argv.slice(1), ...args], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
    if (r.error) throw new AccountsError(`the accounts command (${argv.join(' ')}): ${r.error.message}`);
    return r;
  };
  let listed;
  const provider = {
    kind: 'command',
    argv,
    list() {
      if (listed) return listed;
      const r = call(['accounts', '--json'], 20_000);
      if (r.status !== 0) throw new AccountsError(`the accounts command can't list: ${(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`}`);
      let raw;
      try { raw = JSON.parse(r.stdout); } catch { throw new AccountsError('the accounts command listed something that isn\'t JSON'); }
      listed = checkList(raw);
      return listed;
    },
    usage() { return usageOf(provider.list()); },
    issue(agent, prov, kind) {
      const r = call(['issue', agent, prov, ...(kind ? ['--kind', kind] : [])], 40_000);
      if (r.status !== 0) throw new AccountsError(`issuing ${agent}'s ${prov} credential: ${(r.stderr || '').trim().split('\n').pop()}`);
      const m = /issued ([a-z0-9-]+)\/([A-Za-z0-9._-]+)/.exec(r.stderr || '');
      return { account: m ? m[1] : 'unknown', name: m && CRED_NAME.test(m[2]) ? m[2] : 'unknown', value: r.stdout };
    },
  };
  return provider;
}

/** No accounts: a household that hasn't plugged a provider in. Nothing to list, nothing issued. */
export const noAccounts = {
  kind: 'none',
  list: () => ({ accounts: [], assign: {} }),
  usage: () => [],
  issue(agent, provider) { throw new AccountsError(`no accounts provider is set (LOOM_RUNTIME_ACCOUNTS), so nothing can issue ${agent}'s ${provider} credential`); },
};

/** An in-memory provider: a fixed list and an issue function. For tests, and for a piece that hands the runtime its accounts in-process. */
export function staticAccounts({ accounts = [], assign = {} } = {}, issue) {
  const list = checkList({ accounts, assign });
  return { kind: 'static', list: () => list, usage: () => usageOf(list), issue: issue ?? noAccounts.issue };
}

/**
 * The household's provider: LOOM_RUNTIME_ACCOUNTS, an argv as JSON (`["loom-accounts"]`), or `none`. Unset, it's
 * `loom subscriptions`, which is what box called before the runtime held the accounts.
 */
export function accountsFrom(env = process.env, opts = {}) {
  const v = setting(env, 'ACCOUNTS');
  if (v === 'none') return noAccounts;
  if (v) {
    let argv;
    try { argv = JSON.parse(v); } catch { throw new AccountsError('LOOM_RUNTIME_ACCOUNTS is an argv as JSON, like ["loom", "subscriptions"], or none'); }
    return commandAccounts(argv, { env, ...opts });
  }
  return commandAccounts([env.LOOM_BOX_LOOM || 'loom', 'subscriptions'], { env, ...opts });
}
