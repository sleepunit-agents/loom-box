// The runtime's `run` path for an agent's bodies (loom docs/extensions.md, "The API": POST /api/runtime/run {argv}):
// `gates people` (its own agent's gates, {doc, rev}) and `gates propose …` / `propose-person …` (one person for the
// owner to allow). A body only ever reaches its own agent's: the agent is the caller's, never an argument.
import { grantsFor, GRANTS, KEY } from './grants.mjs';
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
    };
    const p = { ...(typeof proof.key === 'string' ? { key: proof.key } : {}), ...(typeof proof.session === 'string' ? { session: proof.session } : {}) };
    try { return ok(`${(await r.relay(env, caller, t, relayDeps ?? r.depsOf(env), p)).text}\n`); } catch (e) {
      if (e instanceof r.RelayError) return no(e.message);
      throw e;
    }
  }
  // A host verb (hostverbs.mjs, t-2096): a fixed step on loom's machine, for a body doing the owner's own work.
  if (a === 'host') {
    const h = await import('./hostverbs.mjs');
    const r = b === 'result' ? h.hostResult(env, caller, rest, proof, await hostDeps(env)) : await h.hostRequest(env, caller, argv.slice(1), proof, await hostDeps(env));
    return r.ok ? ok(`${JSON.stringify(r)}\n`) : no(r.reason, r.usage ? 2 : 1);
  }
  if (a === 'grants' && b === 'list' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--json'))) {
    try { return ok(`${JSON.stringify(grantsFor(store.get(GRANTS, KEY)?.doc, caller.agent))}\n`); }
    catch (e) { return no(e.message); }
  }
  if (a === 'gates' && b === 'people' && rest.length === 0) return ok(`${JSON.stringify(gatesOf(store, caller.agent))}\n`);
  // A body's own place (t-1745): the conversation it proves it holds (its run's key and harness session, as `send` and
  // a relay prove it), and where that is: its venue, place and label, and the people in it as its rules took them
  // (policy.mjs, members). A tool scoped by who a body works for (Art's pond-field) asks this, never the body's word.
  if (a === 'place') {
    const args = argv.slice(1);
    if (args.length !== 2 || args[0] !== '--conversation' || !/^cv-[0-9a-f]{12}$/.test(args[1])) return no('place --conversation cv-… (this body\'s own)', 2);
    const r = await placeOf(env, args[1], proof, caller.agent, caller);
    return r.ok ? ok(`${JSON.stringify(r.place)}\n`) : no(r.reason);
  }
  // A file someone sent the body's own conversation (files.mjs, t-1961): proved as `place` is, one part at a time.
  if (a === 'file') {
    const args = argv.slice(1);
    const f = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
    if (args.length !== 6 || !/^cv-[0-9a-f]{12}$/.test(f('--conversation') ?? '') || f('--id') === undefined || !/^[0-9]{1,4}$/.test(f('--part') ?? '')) return no('file --conversation cv-… (this body\'s own) --id ID --part N', 2);
    const r = await (await import('./files.mjs')).fileOf(env, f('--conversation'), f('--id'), Number(f('--part')), proof, caller);
    return r.ok ? ok(`${JSON.stringify(r)}\n`) : no(r.reason);
  }
  const tail = a === 'propose-person' ? [b, ...rest].filter((x) => x !== undefined) : a === 'gates' && b === 'propose' ? rest : null;
  if (tail) {
    const flags = proposeFlags(tail);
    if (typeof flags === 'string') return no(flags, 2);
    const r = propose(store, caller, flags);
    // What Allow would do to a person card, for the Inbox to show (the Allow checks again).
    if (r.ok) await annotate(store, core, caller.agent, r.pid);
    return r.ok ? ok(`${r.message}\n`) : no(`propose-person: ${r.message}`);
  }
  return no('the runtime answers a body: host <verb> … --conversation cv-… [--approval a-…] | host result hx-… --conversation cv-… | place --conversation cv-… | file --conversation cv-… --id ID --part N | relay --to A --say T [--why W] [--reply-to r-…] [--from discord:#x] [--approval a-…] [--conversation cv-…] | relays [--thread r-…] | grants list [--json] | gates people | gates propose --slug S --entry JSON [--why W] [--then-relay-say T --then-relay-via slack]', 2);
}

/**
 * A body's own place (t-1745): only for the body proving it holds `cv` in its current run (its run's key and harness
 * session, as `send` proves it; delivery.mjs holdsRun), and only its own agent's (`agent`, when a house asks).
 * {ok, place: {conversation, agent, venue, place, label?, members, membersAt?, principal}} or {ok: false, reason}.
 * `members` is who was in the place when the body's rules were made (`membersAt`). An adapter names members only for
 * places whose membership can't change under a body (policy.mjs), and a body is reseated when a person outside them
 * writes (delivery.mjs, needsReseat), so it holds for the body's run. `principal` is whom it
 * works for now (principal.mjs), and `ownerSpoke` whether the owner ever spoke there (principalOf names a lone non-owner
 * even then): a tool scoped by a person checks both name that same one and that the owner never spoke.
 */
export async function placeOf(env, cv, proof = {}, agent = undefined, caller = undefined) {
  const d = await import('./delivery.mjs');
  const { principalOf } = await import('./principal.mjs');
  const c = d.loadConv(env, cv);
  if (!c || (agent !== undefined && c.agent !== agent) || !d.holdsRun(env, cv, proof, { caller })) return { ok: false, reason: `place: only the body holding ${cv} in its current run asks where it is` };
  const p = principalOf(env, c);
  return { ok: true, place: { conversation: c.conversation, agent: c.agent, venue: c.venue, place: c.place, ...(c.label !== undefined ? { label: c.label } : {}), members: c.bodyRules?.members ?? [], ...(c.bodyRules?.membersAt ? { membersAt: c.bodyRules.membersAt } : {}), principal: { for: p.for, owner: p.owner, ownerSpoke: c.actsFor?.owner === true, ...(p.unknown ? { unknown: true } : {}) } } };
}

/** What a host verb's caller check reads (hostverbs.mjs, ownerBody): the proof, whose work it is, and whose its house is. */
async function hostDeps(env) {
  const { heldConv } = await import('./delivery.mjs');
  const { principalOf } = await import('./principal.mjs');
  const { housePrincipal } = await import('./control.mjs');
  const { load } = await import('./state.mjs');
  return {
    heldConv, principalOf,
    housePrincipal: (id) => { const s = load(env); const h = s.houses?.[id]; return h ? housePrincipal(s, h, env) : null; },
  };
}
