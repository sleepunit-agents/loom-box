// `loom runtime grants …` and `loom runtime gates …`: the runtime's permissions (loom docs/specs/agent-runtime.md,
// section 6) at loom's machine. See grants.mjs and gates.mjs.
//
//   grants ask                      core's ask (the `grants` offer): {agent, piece, path} on stdin → {allow, reason?}
//   grants list [--json]            the grants, and who may relay to whom
//   grants seed [--dry-run] [--force]   the owner's: today's agent lists, imported (nothing that works stops working)
//   grants set <piece> <agent,agent|*> [--paths p,p]   the owner's: one piece's grant
//   grants paired <from> <to>       may <from> relay to <to>? (exit 0 yes, 1 no)
//   gates people --agent <a> [--json]     an agent's gates ({doc, rev}), as its bridges read them
//   gates status [--json]                 {agent: rev} of the gates the runtime holds
//   gates propose --agent <a> --from <who> --stdin   shuttle's hand-off: {slug, entry, why?, then-relay-say?, then-relay-via?} on stdin
//   gates export --json                   the runtime's gates, in the export's shape
//   gates import [--force] < export       the owner's run: `loom shuttle gates export --json | loom runtime gates import`
//   gates follow-merge <from> <into>      the owner's: after a card merge made elsewhere, every agent's gates follow
//   policy --agent <a> [--json]           an agent's body policy ({doc, rev}): deny lists, brief files (policy.mjs)
//   policy set --agent <a> < policy       the owner's run: set it, whole
import { loomStore } from './store.mjs';
import { ask, GRANTS, KEY, paired, householdOf, seed, setPiece } from './grants.mjs';
import { AGENT as AGENT_NAME, annotate, exportGates, followMerge, gatesOf, importGates, ownersRunOf, propose, status } from './gates.mjs';
import { coreFrom } from './core.mjs';
import { policyOf, setPolicy } from './policy.mjs';

class Fail extends Error { constructor(m, code = 1) { super(m); this.code = code; } }
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
async function readStdin() { let s = ''; for await (const d of process.stdin) s += d; return s; }

/** The grant loom put in this process's environment, read (not checked: core checks it when the store is written). */
export function grantIn(env) {
  const t = env.LOOM_STORE_GRANT;
  if (!t || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) return undefined;
  try { return JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf-8')); } catch { return undefined; }
}

export async function grantsCli(rest, env, { store = loomStore(env), stdin = readStdin } = {}) {
  const [sub, ...args] = rest;
  switch (sub) {
    case 'ask': {
      // Any failure reading the grants is an exit 1, which core turns into its 503 (fail closed).
      out(ask(store, await stdin()));
      return;
    }
    case 'list': {
      const g = store.get(GRANTS, KEY);
      if (args.includes('--json')) return out(g ? { ...g.doc, rev: g.rev } : null);
      if (!g) { process.stdout.write('No grants yet: each piece decides by its own agent list. `loom runtime grants seed` imports them.\n'); return; }
      for (const [p, by] of Object.entries(g.doc.pieces)) process.stdout.write(`${p}\t${Object.entries(by).map(([a, ps]) => `${a}: ${ps.join(',')}`).join('; ')}\n`);
      for (const [a, to] of Object.entries(g.doc.relay ?? {})) process.stdout.write(`relay ${a} → ${to.join(', ') || '(no one)'}\n`);
      return;
    }
    case 'seed': {
      const r = seed(env, store, { force: args.includes('--force'), dryRun: args.includes('--dry-run') });
      if (args.includes('--json') || r.written === false) return out(r);
      process.stdout.write(`seeded the grants (rev ${r.rev}): ${Object.entries(r.doc.seeded.from).map(([p, f]) => `${p} (${f})`).join('; ')}\n`);
      return;
    }
    case 'set': {
      const [piece, who] = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
      if (!piece || !who) throw new Fail('usage: loom runtime grants set <piece> <agent,agent|*> [--paths p,p]', 2);
      const rev = setPiece(store, { piece, agents: who === '*' ? '*' : who.split(',').filter(Boolean), paths: (flag(args, '--paths') || '*').split(',').filter(Boolean) });
      process.stdout.write(`saved ${piece}'s grant (rev ${rev})\n`);
      return;
    }
    case 'paired': {
      const [from, to] = args;
      if (!from || !to) throw new Fail('usage: loom runtime grants paired <from> <to>', 2);
      const ok = paired(store.get(GRANTS, KEY)?.doc, from, to);
      process.stdout.write(`${ok ? 'paired' : 'not paired'}\n`);
      if (!ok) throw new Fail('', 1);
      return;
    }
    default: throw new Fail('usage: loom runtime grants ask | list | seed | set | paired', 2);
  }
}

export async function gatesCli(rest, env, { store = loomStore(env), core = coreFrom(env, { timeoutMs: 10_000 }), stdin = readStdin } = {}) {
  const [sub, ...args] = rest;
  const json = args.includes('--json');
  switch (sub) {
    case 'people': {
      const agent = flag(args, '--agent');
      out(gatesOf(store, agent));
      return;
    }
    case 'status': out(status(store)); return;
    case 'propose': {
      // From shuttle (a body's propose-person, handed on): exactly --agent A --from F --stdin, and the proposal as one
      // JSON object on stdin. Nothing the body wrote is a flag here, so it can't name another agent or sender.
      if (args.length !== 5 || args[0] !== '--agent' || args[2] !== '--from' || args[4] !== '--stdin') {
        throw new Fail('usage: loom runtime gates propose --agent <a> --from <who> --stdin  < {slug, entry, why?, then-relay-say?, then-relay-via?}', 2);
      }
      const [, agent, , from] = args;
      if (!AGENT_NAME.test(agent)) throw new Fail('that isn\'t an agent', 2);
      let flags;
      try { flags = JSON.parse(await stdin()); } catch { throw new Fail('propose-person: the proposal on stdin isn\'t JSON', 2); }
      if (!flags || typeof flags !== 'object' || Array.isArray(flags) || !Object.values(flags).every((v) => typeof v === 'string')) {
        throw new Fail('propose-person: the proposal is one JSON object of strings', 2);
      }
      const r = propose(store, { agent, service: from }, flags);
      if (!r.ok) throw new Fail(`propose-person: ${r.message}`, 1);
      await annotate(store, core, agent, r.pid);
      process.stdout.write(`${r.message}\n`);
      return;
    }
    case 'export': out(exportGates(store)); return;
    case 'import': {
      const r = await importGates(store, core, await stdin(), { owner: ownersRunOf(env, grantIn(env)), force: args.includes('--force') });
      if (json) return out(r);
      for (const [a, what] of Object.entries(r.agents)) process.stdout.write(`${a}: ${what}\n`);
      if (r.cards) process.stdout.write(`${r.cards}\n`);
      return;
    }
    case 'follow-merge': {
      const [from, into] = args;
      if (!from || !into) throw new Fail('usage: loom runtime gates follow-merge <from> <into>', 2);
      const own = ownersRunOf(env, grantIn(env));
      if (own !== true) throw new Fail(`follow-merge is the owner's run only (${own})`, 5);
      const done = followMerge(store, from, into);
      process.stdout.write(done.length ? `${done.join('\n')}\n` : `no agent's gates have ${from}\n`);
      return;
    }
    default: throw new Fail('usage: loom runtime gates people | status | propose | export | import | follow-merge', 2);
  }
}

/**
 * `loom runtime policy --agent a [--json]`: an agent's policy ({doc, rev}); `policy set --agent a < doc`: the owner's
 * run sets it, whole (policy.mjs): what every body may not use, a guest venue's bodies too, and the agent's brief files.
 */
export async function policyCli(rest, env, { store = loomStore(env), stdin = readStdin } = {}) {
  const set = rest[0] === 'set';
  const args = set ? rest.slice(1) : rest;
  const agent = flag(args, '--agent');
  if (!agent) throw new Fail('usage: loom runtime policy --agent <a> [--json] | policy set --agent <a> < policy', 2);
  if (!set) { out(policyOf(store, agent)); return; }
  const own = ownersRunOf(env, grantIn(env));
  if (own !== true) throw new Fail(`policy set is the owner's run only (${own})`, 5);
  let doc;
  try { doc = JSON.parse(await stdin()); } catch { throw new Fail('policy set: the policy on stdin isn\'t JSON', 2); }
  try { out({ rev: setPolicy(store, agent, doc) }); } catch (e) { throw new Fail(`policy set: ${e.message}`, 1); }
}

export { Fail as PermsFail };
