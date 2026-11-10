// A raw task keeps its allocated house, box, requirements and saved-state slot. Only its execution moves
// through delivery and the common body host; this is not a second model runner or a placement workaround.
import { createHash } from 'node:crypto';
import { StateError, load, update } from './state.mjs';
import { down, isHostHouse, up } from './control.mjs';
import { bodyPrincipal, jobSeated, loadConv, ownerConversationControl } from './delivery.mjs';
import { registerTaskHost } from './houserunner.mjs';
import { spawnCall } from './spawn.mjs';
import { principalOf } from './principal.mjs';
const fail = (message, status = 400) => { throw new StateError(message, status); };
const copy = v => structuredClone(v);

export async function upTask(env, effects, caller, body) {
  let actsFor = caller.kind === 'owner' ? { owner: true, people: [], unknown: false } : { owner: false, people: [], unknown: true };
  let source;
  if (body.conversation !== undefined || body.key !== undefined || typeof body.session === 'string') {
    const parent = loadConv(env, body.conversation);
    const who = caller.kind === 'owner' && parent ? { kind: 'agent', agent: parent.agent } : caller;
    const p = bodyPrincipal(env, body, { caller: who });
    if (!p.ok || !parent || (body.agent && body.agent !== parent.agent)) fail(p.reason || 'a body asks for its own agent’s task', 403);
    body = { ...body, agent: parent.agent };
    actsFor = parent.actsFor ? copy(parent.actsFor) : { owner: false, people: p.people ?? [], unknown: true };
    source = { origin: parent.conversation,
      floor: { guest: parent.bodyRules?.guest === true, deny: parent.bodyRules?.deny ?? [] },
      ruleSource: parent.spawn?.ruleSource ?? { conversation: parent.conversation, agent: parent.agent, venue: parent.venue, place: parent.place, label: parent.label, kind: parent.kind,
        persons: [...new Set([...(parent.bodyRules?.persons ?? []), ...(parent.bodyRules?.members ?? []), ...(parent.actsFor?.people ?? []), ...(parent.actsFor?.owners ?? [])])] } };
  }
  return up(env, effects, caller, body, { actsFor, taskSource: source });
}

/** A parent may stop the task it allocated, including after a same-principal continuation. */
export async function downTask(env, effects, caller, body) {
  const h = load(env).houses?.[body.id];
  if (h?.job && caller.kind === 'agent' && caller.agent === h.agent) {
    let parent = !!h.taskFromHouse && h.taskFromHouse === caller.house;
    if (!parent && h.taskSource?.origin && body.conversation === h.taskSource.origin) {
      const p = bodyPrincipal(env, body, { caller });
      const expected = principalOf(env, { agent: h.agent, actsFor: h.taskActsFor });
      parent = p.ok === true && p.owner === expected.owner && p.for === expected.for && JSON.stringify(p.people) === JSON.stringify(expected.people);
    }
    if (parent) return down(env, effects, { kind: 'owner', agents: [caller.agent] }, body);
  }
  return down(env, effects, caller, body);
}

function ownTask(env, caller, stopping = false) {
  if (caller.kind !== 'agent' || !caller.house || caller.service) fail('a task host uses its own house credential', 403);
  const h = load(env).houses?.[caller.house];
  if (!h || h.agent !== caller.agent || h.service || h.session || !(stopping ? ['starting', 'running', 'stopping'] : ['starting', 'running']).includes(h.state) || (isHostHouse(h) && !h.job)) fail('this is not a running raw-task house', 403);
  return h;
}

/** A deterministic script may hand just its model portion to the same allocated-house runtime. */
export async function bootstrapScriptTask(env, caller, q = {}, o = {}) {
  ownTask(env, caller);
  if (typeof q.brief !== 'string' || !q.brief.trim() || q.brief.length > 200_000) fail('a script brief is nonempty text, at most 200000 characters');
  return bootstrapTask(env, caller, { ...o, scriptBrief: q.brief });
}

export async function bootstrapTask(env, caller, o = {}) {
  let h = ownTask(env, caller);
  const scriptHash = o.scriptBrief === undefined ? null : createHash('sha256').update(o.scriptBrief).digest('hex');
  // A lost response may replay the same operation; it cannot swap the model task or rerun the script itself.
  update(env, s => {
    const current = s.houses[h.id];
    if ((current.job?.scriptHash && current.job.scriptHash !== scriptHash) || (current.job && !current.job.scriptHash && scriptHash)) fail('this house already bootstrapped a different task', 409);
    if (scriptHash) current.job ??= { house: h.id, created: h.created || new Date().toISOString(), scriptHash };
  });
  // Only the entrypoint, before a body exists, gets the boot key. A lost bootstrap response can be retried
  // until the first authenticated body-sync trades it; it never exposes an established host's key.
  const host = registerTaskHost(env, h.agent, h.id, o);
  update(env, s => {
    const current = s.houses[h.id];
    if (!current || !['starting', 'running'].includes(current.state)) fail('the task house stopped', 409);
    current.kind = 'body-host'; current.seat = host.seat;
    current.job ??= { house: h.id, created: h.created || new Date().toISOString() };
  });
  h = load(env).houses[h.id];
  let brief = h.task, prefer;
  try {
    const task = JSON.parse(h.task);
    if (typeof task?.prompt === 'string') { brief = task.prompt; if (typeof task.model === 'string') prefer = task.model; }
  } catch { /* plain prompt */ }
  if (o.scriptBrief !== undefined) brief = o.scriptBrief;
  const result = await spawnCall(env, { kind: 'owner' }, { agent: h.agent, brief, prefer, title: `Task ${h.id}` }, {
    ...o, now: () => new Date(h.job.created), detach: o.detach ?? true,
    taskJob: { house: h.id, actsFor: h.taskActsFor ?? { owner: false, people: [], unknown: true }, ...h.taskSource },
  });
  update(env, s => { s.houses[h.id].job.conversation = result.handle; });
  return { hostKey: host.hostKey, conversation: result.handle };
}

/** The task process may cancel only the job captured for its own allocated house. */
export async function cancelTask(env, caller, o = {}) {
  const h = ownTask(env, caller, true);
  const c = h.job?.conversation ? loadConv(env, h.job.conversation) : null;
  if (!c?.spawn?.job || c.spawn.job.house !== h.id || c.agent !== h.agent) fail('this house has no task conversation', 409);
  return ownerConversationControl(env, { kind: 'owner', agents: [h.agent] }, { agent: h.agent, conversation: c.conversation, action: 'interrupt' }, { ...o, detach: o.detach ?? true });
}

export async function taskStatus(env, caller, o = {}) {
  const h = ownTask(env, caller, true);
  if (!h.job?.conversation) return { done: false };
  const c = loadConv(env, h.job.conversation);
  if (!c?.spawn?.job || c.spawn.job.house !== h.id) fail('the task conversation changed', 409);
  // Someone else joined its conversation (t-2081): it goes on in its principal's house, and this one, holding what was
  // issued for the job's own principal, is let go now rather than kept up until that conversation ends.
  if (!jobSeated(env, c)) return { done: true, ok: false, reason: 'someone other than whom the task was for joined its conversation; it goes on in its own house' };
  if (c.control?.state === 'held' && !c.body && !c.starting) return { done: true, ok: false, cancelled: true, reason: 'the task was cancelled after its session was collected' };
  // Delivery retires the idle task body and collects its session before the house exits and saves its state.
  if (c.body || c.starting || c.queue?.length) return { done: false };
  const result = await spawnCall(env, { kind: 'owner' }, { agent: h.agent, action: 'result', handle: c.conversation }, o);
  if (result.state === 'pending' && !c.retryAt && c.runLog?.at(-1)?.fail) return { done: true, ok: false, reason: c.runLog.at(-1).fail };
  return result.state === 'done' ? { done: true, ok: true, report: result.report }
    : result.state === 'failed' ? { done: true, ok: false, reason: result.reason } : { done: false };
}
