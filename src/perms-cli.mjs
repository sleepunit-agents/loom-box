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
//   gates propose --agent <a> [--from <who>] --slug S --entry JSON [--why W] [--then-relay-say T --then-relay-via slack]
//   gates export --json                   the runtime's gates, in the export's shape
//   gates import [--force] < export       the owner's run: `loom shuttle gates export --json | loom runtime gates import`
//   gates follow-merge <from> <into>      the owner's: after a card merge made elsewhere, every agent's gates follow
import { loomStore } from './store.mjs';
import { ask, GRANTS, KEY, paired, householdOf, seed, setPiece } from './grants.mjs';
import { exportGates, followMerge, gatesOf, importGates, ownersRunOf, propose, proposeFlags, status } from './gates.mjs';
import { coreFrom } from './core.mjs';

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
      const ok = paired(store.get(GRANTS, KEY)?.doc, householdOf(env), from, to);
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
      const agent = flag(args, '--agent'), from = flag(args, '--from');
      const rest2 = [];
      for (let i = 0; i < args.length; i++) { if (args[i] === '--agent' || args[i] === '--from') { i++; continue; } rest2.push(args[i]); }
      const flags = proposeFlags(rest2);
      if (typeof flags === 'string') throw new Fail(flags, 2);
      const r = propose(store, { agent, service: from }, flags);
      if (!r.ok) throw new Fail(`propose-person: ${r.message}`, 1);
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

export { Fail as PermsFail };
