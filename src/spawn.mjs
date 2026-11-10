// Runtime-owned parentage: clients never supply a principal or return address.
import { randomBytes } from 'node:crypto';
import { bodyPrincipal, deliver, depsOf, loadConv, seatMoved } from './delivery.mjs';
import { originOf } from './relay.mjs';
import { principalOf } from './principal.mjs';
import { detectLoop } from './loops.mjs';
import { AGENT_NAME, StateError, load } from './state.mjs';
import { readModels, readRoles, roleOf } from './models.mjs';
export const SPAWN_DEPTH = 8;
export function spawnCap(env) {
  const n = Number(env.LOOM_RUNTIME_SPAWN_LIMIT ?? 3);
  return Number.isInteger(n) && n >= 1 && n <= 32 ? n : 3;
}
// A refusal, said to the asker: over the API a 4xx with these words, never the runtime's opaque 500.
const no = (s) => { throw new StateError(`spawn: ${s}`, 403); };
function asking(env, caller, q, o) {
  if (caller.kind === 'owner') return null;
  if (caller.kind !== 'agent') no('only an agent body or the local owner can ask');
  const c = originOf(env, caller, q.conversation, q);
  if (c && (c.resetPending || seatMoved(env, c))) no('the asking conversation changed principal or house');
  if (!c) no('cannot identify the asking conversation; use the shell with its body proof');
  if (q.key) {
    const p = bodyPrincipal(env, { ...q, conversation: c.conversation }, { ...o, caller });
    if (!p.ok) no(p.reason);
  }
  return c;
}
export async function spawnCall(env, caller, q = {}, o = {}) {
  const d = depsOf(env, o);
  // The work roles this body can ask for (t-2036, t-2039): read, never edited, here. Only what a body needs to choose.
  if (q.action === 'roles' && (caller.kind === 'owner' || caller.kind === 'agent')) {
    const cat = readRoles(env);
    return { version: cat.version, roles: cat.roles.map((r) => ({ id: r.id, description: r.description, eligible: r.eligible, ...Object.fromEntries(['needs', 'note', 'input', 'output', 'dossier', 'failover'].filter((k) => r[k] !== undefined).map((k) => [k, r[k]])) })) };
  }
  const parent = asking(env, caller, q, o);
  const agent = parent?.agent ?? q.agent;
  if (!AGENT_NAME.test(agent ?? '')) no('name the agent with --agent');
  if (q.agent && q.agent !== 'self' && q.agent !== agent) no('a body spawns only itself');
  const action = q.action ?? 'start';
  if (action !== 'start') {
    const c = loadConv(env, q.handle);
    if (!c?.spawn || c.agent !== agent) no('no such spawn');
    if (caller.kind !== 'owner' && c.spawn.origin !== parent?.conversation && c.conversation !== parent?.conversation) no('only the asking conversation can use this handle');
    if (c.resetPending || c.actsFor?.reset !== undefined || JSON.stringify(principalOf(env, c)) !== JSON.stringify(c.spawn.principal)) no('the spawned principal has changed: something not the asker\'s joined it after it started (a relay\'s answer from another agent, a wake loom couldn\'t say was yours, or a reset), so its report isn\'t returned as the asker\'s; read it in its own conversation');
    if (parent && (parent.actsFor?.reset !== c.spawn.parentReset || JSON.stringify(principalOf(env, parent)) !== JSON.stringify(c.spawn.principal))) no('the asking principal has changed');
    if (action === 'result') return { handle: c.conversation, state: c.spawn.report ? 'done' : c.spawn.failed ? 'failed' : c.paused ? 'paused' : 'pending', ...(c.spawn.assignment ? { assignment: { model: c.spawn.assignment.model, harness: c.spawn.assignment.harness, ...(c.spawn.assignment.role ? { role: c.spawn.assignment.role } : {}) } } : {}), ...(c.spawn.report ? { report: d.sealer.open(Buffer.from(c.spawn.report, 'base64')).toString('utf-8') } : {}), ...(c.spawn.failed ? { reason: c.spawn.failed } : {}) };
    if (action !== 'say') no('action is start, result, say or roles');
    if (typeof q.text !== 'string' || !q.text.trim() || q.text.length > 40000) no('text is 1–40000 characters');
    return deliver(env, { source: 'runtime', id: o.deliveryId ?? `say-${randomBytes(12).toString('hex')}`, agent, venue: c.venue, place: c.place, from: { kind: 'agent', id: agent }, kind: 'message', at: d.now().toISOString(), text: q.text }, { ...o, spawnSender: { principal: c.spawn.principal, origin: parent?.conversation, parentReset: parent?.actsFor?.reset } });
  }
  if (typeof q.brief !== 'string' || !q.brief.trim() || q.brief.length > 40000) no('brief is 1–40000 characters');
  if (q.prefer !== undefined && (typeof q.prefer !== 'string' || q.prefer.length > 100)) no('prefer is a model name');
  if (q.title !== undefined && (typeof q.title !== 'string' || !q.title.trim() || q.title.length > 80)) no('title is 1–80 characters');
  if (q.failover !== undefined && typeof q.failover !== 'boolean') no('failover is true or false');
  // A worker role (t-2036): checked against the catalog now, and the version it was admitted under kept with the job,
  // so a later catalog edit never changes it. Its eligible models are only ever narrowed by the agent's own allow list.
  let role;
  if (q.role !== undefined) {
    if (typeof q.role !== 'string') no('role is a role\'s id (loom runtime roles)');
    try { const r = roleOf(load(env), q.role); role = { id: r.id, version: r.version, eligible: r.eligible, ...(Array.isArray(r.needs) && r.needs.length ? { needs: r.needs } : {}), ...(r.failover ? { failover: true } : {}) }; } catch (e) { no(e.message); }
    if (!role.eligible.length) no(`role ${role.id} has no eligible model`);
    // Refused now, not left to fail at its start: a role whose models are all outside what this agent may use.
    const allow = readModels(env).agents[agent]?.allow;
    if (allow?.length && !role.eligible.some((id) => allow.includes(id))) no(`${agent} may use none of role ${role.id}'s models (${role.eligible.join(', ')})`);
  }
  const depth = (parent?.spawn?.depth ?? 0) + 1;
  const loop = detectLoop({ spawnDepth: depth });
  if (loop) no(`spawn chain hit the loop guard: ${loop.reason}; return to the asker`);
  const actsFor = o.taskJob ? structuredClone(o.taskJob.actsFor) : parent ? structuredClone(parent.actsFor) : { owner: true, people: [], unknown: false };
  delete actsFor.reset; delete actsFor.resetBy; delete actsFor.resetSig;
  const principal = principalOf(env, { agent, actsFor });
  const id = o.taskJob ? `job-${o.taskJob.house}` : `sp-${randomBytes(12).toString('hex')}`;
  const metadata = { depth, principal, ...(o.taskJob?.interactive ? { interactive: true } : {}), ...(o.taskJob ? { job: { house: o.taskJob.house, ...(o.taskJob.origin ? { origin: o.taskJob.origin } : {}) } } : {}), ...(parent ? { origin: parent.conversation, origin_run: parent.run } : {}), floor: o.taskJob?.floor ?? (parent?.bodyRules ? { guest: parent.bodyRules.guest, deny: parent.bodyRules.deny, readers: parent.bodyRules.readers } : null), parentReset: parent?.actsFor?.reset, ...(role ? { role } : {}), ...((q.failover ?? role?.failover) ? { failover: true } : {}), ruleSource: o.taskJob?.ruleSource ?? parent?.spawn?.ruleSource ?? (parent ? { conversation: parent.conversation, agent, venue: parent.venue, place: parent.place, label: parent.label, kind: parent.kind, persons: [...new Set([...(parent.bodyRules?.persons ?? []), ...(parent.bodyRules?.members ?? []), ...(parent.actsFor?.people ?? []), ...(parent.actsFor?.owners ?? [])])] } : null), prefer: q.prefer, created: d.now().toISOString() };
  const r = await deliver(env, { source: 'runtime', id, agent, venue: 'spawn', place: id, label: q.title ?? 'Spawn', from: { kind: 'agent', id: agent }, kind: 'message', at: d.now().toISOString(), text: q.brief }, { ...o, spawnInit: { metadata, actsFor, parentBody: parent?.body, parentRun: parent?.run } });
  if (r.status) no(r.error);
  return { handle: r.conversation, ...r };
}
export async function spawnTool(env, argv, input) {
  const flag = (f) => { const i = argv.indexOf(f); return i < 0 ? undefined : argv[i + 1]; };
  try {
    const raw = JSON.parse(input || '{}');
    const q = Object.fromEntries(['action', 'brief', 'prefer', 'role', 'failover', 'title', 'conversation', 'handle', 'text'].filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
    const r = await spawnCall(env, { kind: 'agent', agent: flag('--agent'), house: flag('--house'), service: flag('--service') }, q, { detach: true });
    return { text: JSON.stringify(r) };
  } catch (e) { return { text: e.message, isError: true }; }
}
