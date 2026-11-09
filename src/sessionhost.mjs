// Interactive houses use the same allocated-house seat, delivery, native runners and sealed continuity as tasks.
// The terminal controller is the authenticated owner. An agent token inside the house never becomes a controller.
import { load, update, StateError } from './state.mjs';
import { sees } from './control.mjs';
import { registerTaskHost } from './houserunner.mjs';
import { spawnCall } from './spawn.mjs';
import { loadConv, depsOf, ownerConversationControl, ownerModelChoice } from './delivery.mjs';
import { readBody } from './bodies.mjs';
const fail = (message, status = 400) => { throw new StateError(message, status); };
const LIVE = new Set(['starting', 'running']);

export async function bootstrapSession(env, caller, o = {}) {
  if (caller.kind !== 'agent' || !caller.house || caller.service) fail('a session host uses its own house credential', 403);
  const h = load(env).houses?.[caller.house];
  if (!h?.session || h.agent !== caller.agent || !LIVE.has(h.state)) fail('not a running session house', 403);
  const host = registerTaskHost(env, h.agent, h.id, o);
  update(env, s => {
    const current = s.houses[h.id];
    if (!current?.session || !LIVE.has(current.state)) fail('the session house stopped', 409);
    current.kind = 'body-host'; current.seat = host.seat;
    current.sessionRuntime ??= { created: current.created || new Date().toISOString() };
  });
  const current = load(env).houses[h.id];
  const result = await spawnCall(env, { kind: 'owner' }, { agent: h.agent,
    title: `Terminal ${h.id}`, brief: 'This is an interactive terminal conversation. Greet the person briefly, then wait for their instructions. Later terminal messages are delivered through this same conversation. Keep all normal identity, tools, permissions and completion behavior.' }, {
    ...o, now: () => new Date(current.sessionRuntime.created), detach: o.detach ?? true,
    taskJob: { house: h.id, interactive: true, actsFor: h.taskActsFor ?? { owner: false, people: [], unknown: true }, ...h.taskSource },
  });
  update(env, s => { s.houses[h.id].sessionRuntime.conversation = result.handle; });
  return { hostKey: host.hostKey, conversation: result.handle };
}

export async function sessionCommand(env, caller, q = {}, o = {}) {
  if (caller.kind !== 'owner') fail('terminal control is the agent owner’s', 403);
  const h = load(env).houses?.[q.id];
  if (!h?.session || !sees(caller, h.agent)) fail('no such session house', 404);
  if (!LIVE.has(h.state)) fail('the session house is not running', 409);
  const cv = h.sessionRuntime?.conversation;
  const c = cv ? loadConv(env, cv) : null;
  if (!c?.spawn?.interactive || c.spawn.job?.house !== h.id || c.agent !== h.agent) fail('this house has no shared terminal host yet; rebuild it with the current runtime', 409);
  const action = q.action ?? 'status';
  if (action === 'send') {
    if (typeof q.message !== 'string' || !/^[0-9a-f]{16,64}$/.test(q.message)) fail('a terminal message needs its stable random id');
    return spawnCall(env, caller, { agent: h.agent, action: 'say', handle: cv, text: q.text }, { ...o, detach: o.detach ?? true, deliveryId: `terminal-${q.message}` });
  }
  if (action === 'interrupt' || action === 'resume') return ownerConversationControl(env, caller, { agent: h.agent, conversation: cv, action }, o);
  if (action === 'model') return ownerModelChoice(env, caller, { agent: h.agent, conversation: cv, harness: q.harness });
  if (action !== 'status') fail('terminal action is status, send, interrupt, resume or model');
  const d = depsOf(env, o);
  let cards = [], model;
  if (c.body) {
    try {
      const rec = readBody(env, c.body);
      cards = d.runner(rec.harness, rec.local).activity?.({ id: c.body.split(':')[1], ...rec }) ?? [];
      model = { harness: rec.harness, model: rec.model };
    } catch { /* unavailable reports never imply that the native body is finished */ }
  }
  const result = await spawnCall(env, caller, { agent: h.agent, action: 'result', handle: cv }, o);
  return { id: h.id, agent: h.agent, conversation: cv, run: c.run, queued: c.queue?.length ?? 0,
    working: !!(c.starting || c.body && !c.idleSince), control: c.control?.state, paused: c.paused,
    model, cards, reportRun: c.spawn.reportRun, ...result };
}
