// The runtime's `run` path for an agent's bodies (loom docs/extensions.md, "The API": POST /api/runtime/run {argv}):
// `gates people` (its own agent's gates, {doc, rev}) and `gates propose …` / `propose-person …` (one person for the
// owner to allow). A body only ever reaches its own agent's: the agent is the caller's, never an argument.
import { loomStore } from './store.mjs';
import { gatesOf, propose, proposeFlags } from './gates.mjs';

const ok = (stdout) => ({ exit: 0, stdout, stderr: '' });
const no = (stderr, exit = 1) => ({ exit, stdout: '', stderr: `${stderr}\n` });

export function runFor(env, caller, argv, store = loomStore(env)) {
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) return no('argv is a list of strings', 2);
  const [a, b, ...rest] = argv;
  if (a === 'gates' && b === 'people' && rest.length === 0) return ok(`${JSON.stringify(gatesOf(store, caller.agent))}\n`);
  const tail = a === 'propose-person' ? [b, ...rest].filter((x) => x !== undefined) : a === 'gates' && b === 'propose' ? rest : null;
  if (tail) {
    const flags = proposeFlags(tail);
    if (typeof flags === 'string') return no(flags, 2);
    const r = propose(store, caller, flags);
    return r.ok ? ok(`${r.message}\n`) : no(`propose-person: ${r.message}`);
  }
  return no('the runtime answers a body: gates people | gates propose --slug S --entry JSON [--why W] [--then-relay-say T --then-relay-via slack]', 2);
}
