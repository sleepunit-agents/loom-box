// Agent grants (loom docs/specs/agent-runtime.md, "6. Permissions"): which agent may use which piece, and which
// path of it. The runtime is the household's grants authority: it offers `grants` (package.json), so core asks
// `loom-runtime grants ask` with {agent, piece, path} on stdin before an agent's call to any piece, and before it
// forwards a delivery a piece makes for an agent (path `deliver`). It has 2 s to answer {allow: true} or
// {allow: false, reason}; core fails closed on anything else (loom src/grants.ts).
//
// The grants are one owner-written document in the runtime's own store, collection `grants`, key `household`:
//
//   {v: 1, pieces: {<piece>: {<agent> | "*": [<path pattern>, ...]}}, relay: {<agent>: [<agent>, ...]}, seeded?: {...}}
//
// A path pattern is "*" (every path), an exact path ("run", "people/art"), or a prefix ending in "/*". "*" for an
// agent is every agent of the household. A piece with no entry is no agent's. `relay` is who may relay to whom
// (the pairing rules, agent-runtime.md "Agent-to-agent relay": imported once from household.json's `relay` by the
// seed, the owner's on the Permissions page since; household.json's is never read for them again).
//
// Until the owner seeds it (`loom runtime grants seed`), there's no document, and every ask is allowed: each piece
// decides by its own agent list, exactly as before the runtime was the authority. The seed reads every installed
// piece's own agent list (a setting named *_AGENTS) and imports it, and every other piece gets every agent, so
// nothing that worked before stops working at the switch; the pieces' own lists still apply after.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { StoreError } from './store.mjs';

export const GRANTS = 'grants';
export const KEY = 'household';
const PIECE = /^[a-z][a-z0-9-]{0,39}$/;
const AGENT = /^[a-z][a-z0-9-]{0,39}$/;
const PATTERN = /^(\*|[A-Za-z0-9._:@-]+(\/[A-Za-z0-9._:@-]+)*(\/\*)?)$/;

export class GrantsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Why a grants document isn't one, or null. */
export function grantsProblem(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'the grants are a JSON object';
  if (doc.v !== 1) return 'v is 1';
  const bad = Object.keys(doc).find((k) => !['v', 'pieces', 'relay', 'seeded', '_comment'].includes(k));
  if (bad) return `the grants have v, pieces, relay (and seeded): not ${bad}`;
  if (!doc.pieces || typeof doc.pieces !== 'object' || Array.isArray(doc.pieces)) return 'pieces maps a piece to its grants';
  for (const [p, g] of Object.entries(doc.pieces)) {
    if (!PIECE.test(p)) return `${p} isn't a piece's name`;
    if (!g || typeof g !== 'object' || Array.isArray(g)) return `${p}'s grants map an agent (or *) to its paths`;
    for (const [a, paths] of Object.entries(g)) {
      if (a !== '*' && !AGENT.test(a)) return `${p}: ${a} isn't an agent's name (or *)`;
      if (!Array.isArray(paths) || paths.length > 50 || !paths.every((x) => typeof x === 'string' && x.length <= 200 && PATTERN.test(x))) {
        return `${p}: ${a}'s paths are up to 50 patterns: *, a path, or a prefix ending in /*`;
      }
    }
  }
  if (doc.relay !== undefined) {
    if (!doc.relay || typeof doc.relay !== 'object' || Array.isArray(doc.relay)) return 'relay maps an agent to the agents it may relay to';
    for (const [a, to] of Object.entries(doc.relay)) {
      if (!AGENT.test(a) || !Array.isArray(to) || !to.every((x) => typeof x === 'string' && AGENT.test(x))) return `relay: ${a} maps to a list of agents`;
    }
  }
  return null;
}

const matches = (pattern, path) => pattern === '*' || pattern === path || (pattern.endsWith('/*') && (path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1))));

/**
 * A path core may ask about: '' or segments of core's own path characters ([A-Za-z0-9._~-], as loom's /api route takes
 * them), never `.` or `..`, never empty, no backslash or percent-encoding. Core asks with exactly the path it forwards
 * (loom src/transport/http-server.ts), so anything else is no path of a real call, and a prefix grant must never
 * match it (tasks/../secrets).
 */
const SEGMENT = /^[A-Za-z0-9._~-]{1,200}$/;
export const canonicalPath = (path) => path === '' || (path.length <= 1000 && path.split('/').every((x) => SEGMENT.test(x) && x !== '.' && x !== '..'));

/** The answer to one ask, from the grants document (null: there are none yet). */
export function decide(doc, ask) {
  const { agent, piece, path } = ask ?? {};
  if (typeof agent !== 'string' || typeof piece !== 'string' || typeof path !== 'string') return { allow: false, reason: 'the ask is {agent, piece, path}' };
  if (!canonicalPath(path)) return { allow: false, reason: `${JSON.stringify(path.slice(0, 80))} isn't a path a call can have (no . or .. segments, no empty ones, no \\ or %)` };
  if (!AGENT.test(agent) || !PIECE.test(piece)) return { allow: false, reason: 'the ask names an agent and a piece by their names' };
  if (doc == null) return { allow: true };
  const why = grantsProblem(doc);
  // A document the runtime can't read is no grant at all: refuse, saying so, rather than guess.
  if (why) return { allow: false, reason: `the runtime's grants can't be read (${why}); the owner fixes them on the runtime's page` };
  const g = Object.hasOwn(doc.pieces, piece) ? doc.pieces[piece] : undefined;
  if (!g) return { allow: false, reason: `no agent is granted ${piece}: the owner grants it on the runtime's page (Permissions)` };
  const paths = [...(Object.hasOwn(g, agent) ? g[agent] : []), ...(Object.hasOwn(g, '*') ? g['*'] : [])];
  if (!paths.length) return { allow: false, reason: `${agent} isn't granted ${piece}: the owner grants it on the runtime's page (Permissions)` };
  if (!paths.some((p) => matches(p, path))) return { allow: false, reason: `${agent} is granted ${piece} for ${paths.join(', ')}, not ${path}` };
  return { allow: true };
}

/** `loom-runtime grants ask`: the offer core runs. Reads the document once; any failure is core's 503 (exit 1). */
export function ask(store, input) {
  let q;
  try { q = JSON.parse(input); } catch { return { allow: false, reason: 'the ask isn\'t JSON' }; }
  const got = store.get(GRANTS, KEY);
  return decide(got?.doc ?? null, q);
}

/**
 * May `from` relay to `to` without asking? The runtime's pairing rules only (agent-runtime.md: pairing moves out of
 * household.json; the seed imported its pairs once). No grants, no pairs: every relay asks the owner.
 */
export function paired(doc, from, to) {
  const rules = doc?.relay ?? {};
  return Array.isArray(rules[from]) && rules[from].includes(to);
}

// ---------------------------------------------------------------- the seed

const loomHome = (env) => env.LOOM_HOME || join(env.HOME || homedir(), '.config', 'loom');
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };

/**
 * Each installed piece's own agent list, as it decides today: {piece: {agents: [..] | '*', from}}. A managed piece's
 * list is its setting named *_AGENTS (its value, else its declared default); a piece with none, or one found on PATH,
 * decides without a list the runtime can read, so it gets every agent and its own code goes on deciding.
 */
export function currentLists(env, { pieces } = {}) {
  const home = loomHome(env);
  const all = pieces ?? listPieces(env);
  const out = {};
  for (const p of all) {
    if (!PIECE.test(p.name ?? '')) continue;
    const owner = p.managed?.partOf ?? p.name;
    const rec = readJson(join(home, 'pieces', owner, 'piece.json'));
    const values = readJson(join(home, 'pieces', owner, 'settings.json')) ?? {};
    const decl = (rec?.loom?.settings ?? []).find((s) => typeof s?.name === 'string' && /_AGENTS$/.test(s.name));
    if (!decl) { out[p.name] = { agents: '*', from: rec ? 'no agent list: it decides itself' : 'not a managed piece: it decides itself' }; continue; }
    const raw = typeof values[decl.name] === 'string' ? values[decl.name] : typeof decl.default === 'string' ? decl.default : '';
    const agents = raw.split(',').map((a) => a.trim()).filter((a) => AGENT.test(a));
    out[p.name] = agents.length ? { agents, from: `${decl.name}=${agents.join(',')}` } : { agents: '*', from: `${decl.name} is empty: it decides itself` };
  }
  return out;
}

function listPieces(env) {
  const r = spawnSync(env.LOOM_BIN || 'loom', ['pieces', '--json'], { env, encoding: 'utf-8', timeout: 20_000 });
  if (r.status !== 0) throw new GrantsError(`loom pieces: ${(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`}`, 503);
  return JSON.parse(r.stdout);
}

/** The grants that keep today's behaviour: each piece's own list, the runtime's own every agent's, household.json's pairs. */
export function seedDoc(env, { pieces, now = new Date() } = {}) {
  const lists = currentLists(env, { pieces });
  const doc = { v: 1, pieces: {}, relay: {}, seeded: { at: now.toISOString(), from: {} } };
  for (const [p, l] of Object.entries(lists).sort(([a], [b]) => a.localeCompare(b))) {
    doc.pieces[p] = l.agents === '*' ? { '*': ['*'] } : Object.fromEntries(l.agents.map((a) => [a, ['*']]));
    doc.seeded.from[p] = l.from;
  }
  const h = readJson(join(loomHome(env), 'household.json'));
  for (const [a, to] of Object.entries(h?.relay ?? {})) {
    if (AGENT.test(a) && Array.isArray(to)) doc.relay[a] = to.filter((x) => typeof x === 'string' && AGENT.test(x));
  }
  return doc;
}

/** `grants seed`: the owner's. Refuses over grants already there unless --force; --dry-run writes nothing. */
export function seed(env, store, { force = false, dryRun = false, pieces } = {}) {
  const doc = seedDoc(env, { pieces });
  const cur = store.get(GRANTS, KEY);
  if (dryRun) return { written: false, doc, existing: !!cur };
  if (cur && !force) throw new GrantsError('the runtime already has grants; --force replaces them with today\'s lists', 409);
  try {
    const rev = store.put(GRANTS, KEY, doc, cur ? cur.rev : 0);
    return { written: true, rev, doc };
  } catch (e) {
    if (e instanceof StoreError && e.status === 403) throw new GrantsError(`the grants are the owner's: run this as the owner on loom's machine (${e.message})`, 403);
    throw e;
  }
}

/** One piece's grant changed by the owner (the page's form): agents '*' or a list, paths a list. */
export function setPiece(store, { piece, agents, paths = ['*'] }) {
  if (!PIECE.test(piece ?? '')) throw new GrantsError('that isn\'t a piece\'s name');
  const cur = store.get(GRANTS, KEY);
  const doc = cur?.doc ? structuredClone(cur.doc) : { v: 1, pieces: {}, relay: {} };
  const list = agents === '*' ? ['*'] : [...new Set(agents)];
  if (!list.length) delete doc.pieces[piece];
  else doc.pieces[piece] = Object.fromEntries(list.map((a) => [a, [...paths]]));
  const why = grantsProblem(doc);
  if (why) throw new GrantsError(why);
  return store.put(GRANTS, KEY, doc, cur ? cur.rev : 0);
}

/**
 * One agent added to one piece's grant, everyone else's kept (`dryRun`: checked, not written) (t-1970: the owner's Allow on a `grant` approval). With no
 * grants document yet there's nothing to add to: every agent may already use every piece, and writing one now would
 * take every other piece away from every agent. So: {changed: false, why} there, and where the agent already has it.
 */
export function addGrant(store, { piece, agent, paths = ['*'] }, { dryRun = false } = {}) {
  if (!PIECE.test(piece ?? '')) throw new GrantsError('that isn\'t a piece\'s name');
  if (!AGENT.test(agent ?? '')) throw new GrantsError('that isn\'t an agent\'s name');
  if (!grantPathsOk(paths)) throw new GrantsError('paths are *, a path, or a prefix ending in /*');
  const cur = store.get(GRANTS, KEY);
  if (!cur?.doc) return { changed: false, none: true, why: 'no grants yet: every agent may use every piece' };
  const doc = structuredClone(cur.doc);
  const g = Object.hasOwn(doc.pieces ?? {}, piece) ? { ...doc.pieces[piece] } : {};
  const have = [...(Object.hasOwn(g, agent) ? g[agent] : []), ...(Object.hasOwn(g, '*') ? g['*'] : [])];
  if (have.includes('*') || paths.every((p) => have.includes(p))) return { changed: false, why: `${agent} may already use ${piece}${have.includes('*') ? '' : ` for ${paths.join(', ')}`}` };
  const mine = Object.hasOwn(g, agent) ? g[agent] : [];
  g[agent] = paths.includes('*') ? ['*'] : [...new Set([...mine, ...paths])];
  doc.pieces = { ...(doc.pieces ?? {}), [piece]: g };
  const why = grantsProblem(doc);
  if (why) throw new GrantsError(why);
  if (dryRun) return { changed: true, dryRun: true };
  return { changed: true, rev: store.put(GRANTS, KEY, doc, cur.rev) };
}

/** Paths a grant from an approval may add: 1-50 patterns, each one with real segments. */
export const grantPathsOk = (paths) => Array.isArray(paths) && paths.length > 0 && paths.length <= 50
  && paths.every((x) => typeof x === 'string' && x.length <= 200 && PATTERN.test(x) && canonicalPattern(x));

/** A pattern whose segments are real ones (no . or .., none empty): what a grant from an approval may add. */
const canonicalPattern = (p) => p === '*' || canonicalPath(p.endsWith('/*') ? p.slice(0, -2) : p);

/** What `agent` may use, piece by piece, from the grants (null: none yet, so everything). [{piece, paths}] sorted. */
export function usableBy(doc, agent) {
  if (doc == null) return null;
  return Object.entries(doc.pieces ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([piece, g]) => ({
    piece, paths: [...new Set([...(Object.hasOwn(g, agent) ? g[agent] : []), ...(Object.hasOwn(g, '*') ? g['*'] : [])])],
  }));
}

/** Who `agent` may relay to without asking, set by the owner (the Permissions page): the household's other agents. */
export function setRelay(store, { agent, to, agents }) {
  if (!AGENT.test(agent ?? '') || !agents.includes(agent)) throw new GrantsError(`no agent ${agent} in this household`);
  const bad = to.filter((a) => a === agent || !agents.includes(a));
  if (bad.length) throw new GrantsError(`${bad.join(', ')}: not another agent of this household`);
  const cur = store.get(GRANTS, KEY);
  if (!cur?.doc) throw new GrantsError('no grants yet: seed them first (loom runtime grants seed)', 409);
  const doc = structuredClone(cur.doc);
  doc.relay = { ...(doc.relay ?? {}) };
  if (to.length) doc.relay[agent] = [...new Set(to)].sort();
  else delete doc.relay[agent];
  const why = grantsProblem(doc);
  if (why) throw new GrantsError(why);
  return store.put(GRANTS, KEY, doc, cur.rev);
}

/** The household's household.json (its agents, its owner). */
export function householdOf(env) { return readJson(join(loomHome(env), 'household.json')); }

export const grantsExistSync = (p) => existsSync(p);
