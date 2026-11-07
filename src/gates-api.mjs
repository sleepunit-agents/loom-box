// The runtime's `run` path for an agent's bodies (loom docs/extensions.md, "The API": POST /api/runtime/run {argv}):
// `gates people` (its own agent's gates, {doc, rev}) and `gates propose …` / `propose-person …` (one person for the
// owner to allow). A body only ever reaches its own agent's: the agent is the caller's, never an argument.
import { loomStore } from './store.mjs';
import { annotate, gatesOf, propose, proposeFlags } from './gates.mjs';
import { coreFrom } from './core.mjs';

const ok = (stdout) => ({ exit: 0, stdout, stderr: '' });
const no = (stderr, exit = 1) => ({ exit, stdout: '', stderr: `${stderr}\n` });

export async function runFor(env, caller, argv, store = loomStore(env), core = coreFrom(env, { timeoutMs: 8_000 }), relayDeps = undefined, proof = {}) {
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) return no('argv is a list of strings', 2);
  const [a, b, ...rest] = argv;
  // The now board's one read: the caller's bridges (nowboard.mjs).
  if (a === 'now') return (await import('./nowboard.mjs')).runNow(env, caller, argv);
  // A relay from a house's CLI (the same as the relay tool, as this caller), and its agent's relays.
  if (a === 'relay' || a === 'relays') {
    const r = await import('./relay.mjs');
    const args = argv.slice(1);
    const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
    if (a === 'relays') return ok(r.relaysOf(env, caller.agent, flag('--thread')));
    const bad = args.filter((x, i) => x.startsWith('--') && !['--to', '--say', '--why', '--reply-to', '--from', '--approval', '--conversation'].includes(x) && !(i > 0 && args[i - 1].startsWith('--')));
    if (bad.length) return no(`relay: no flag ${bad[0]} (it takes --to, --say, --why, --reply-to, --from, --approval, --conversation)`, 2);
    const t = { to: flag('--to'), say: flag('--say'), why: flag('--why'), reply_to: flag('--reply-to'), from: flag('--from'), approval: flag('--approval'), conversation: flag('--conversation'),
      // The calling body's proof that it holds that conversation (its run's key and harness session), from the request
      // body, never argv: the house CLI sends them (cli.mjs), and relay.mjs's originOf checks them as `send` does.
      ...(typeof proof.key === 'string' ? { key: proof.key } : {}), ...(typeof proof.session === 'string' ? { session: proof.session } : {}) };
    try { return ok(`${(await r.relay(env, caller, t, relayDeps ?? r.depsOf(env))).text}\n`); } catch (e) {
      if (e instanceof r.RelayError) return no(e.message);
      throw e;
    }
  }
  if (a === 'gates' && b === 'people' && rest.length === 0) return ok(`${JSON.stringify(gatesOf(store, caller.agent))}\n`);
  const tail = a === 'propose-person' ? [b, ...rest].filter((x) => x !== undefined) : a === 'gates' && b === 'propose' ? rest : null;
  if (tail) {
    const flags = proposeFlags(tail);
    if (typeof flags === 'string') return no(flags, 2);
    const r = propose(store, caller, flags);
    // What Allow would do to a person card, for the Inbox to show (the Allow checks again).
    if (r.ok) await annotate(store, core, caller.agent, r.pid);
    return r.ok ? ok(`${r.message}\n`) : no(`propose-person: ${r.message}`);
  }
  return no('the runtime answers a body: relay --to A --say T [--why W] [--reply-to r-…] [--from discord:#x] [--approval a-…] | relays [--thread r-…] | gates people | gates propose --slug S --entry JSON [--why W] [--then-relay-say T --then-relay-via slack]', 2);
}
