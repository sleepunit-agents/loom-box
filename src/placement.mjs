// Where an agent's bodies may run (Jonathan's ruling, t-1753): the one rule loom-box#49 decides a box's logins by, so
// placing a body, offering an account (accounts.mjs) and mounting a login at claim (control.mjs) never disagree:
//   - the box may host the agent: its own grant, and its owner owns the agent or lent it the box (control.mjs mayHost);
//   - the box is logged in to the body's harness, and its login may do this agent's work: the agent's owner owns the
//     box (a loan doesn't count for a login) and granted the agent that login (owners.mjs mayUseLogin).
// The house's own harness login is the only credential a body uses. Its house must declare the harness it runs
// (its house file's "harnesses"): the box mounts only those logins, and the body host refuses one it has no login for.
import { boxUp, factsOf, mayHost, meets, preferenceOf } from './control.mjs';
import { mayUseLogin, membersOf } from './owners.mjs';

/** Whether an agent's body on `harness` may run on box `id`. */
export function mayRunBody(s, id, agent, harness, members) {
  const b = s.boxes?.[id];
  return !!b && mayHost(b, agent, members) && mayUseLogin(b, s.agents?.[agent], agent, harness, members);
}

/**
 * The box an agent's body runs on for `harness` (t-2048): the first box of its preference that's up and qualifies, else
 * any box that's up and qualifies, else (nothing up) the first that qualifies, which it waits for. With `needs` (box
 * facts, control.mjs meets), only a box that has them all qualifies.
 * {box} or {reason} (why none: said, never a guess).
 */
export function bodyBox(s, agent, harness, env, nowMs = Date.now(), needs = []) {
  const members = membersOf(env);
  // A body whose work needs something of its box (a worker role's needs, t-2092): only a box that has every one.
  const has = (id) => needs.every((n) => meets(factsOf(s.boxes?.[id] ?? {}), n));
  const fits = (id) => mayRunBody(s, id, agent, harness, members) && has(id);
  const up = (id) => boxUp(s.boxes?.[id], nowMs, agent);
  const pref = preferenceOf(s, agent, env);
  const all = Object.keys(s.boxes ?? {}).sort();
  const box = pref.find((id) => fits(id) && up(id)) ?? all.find((id) => fits(id) && up(id)) ?? pref.find(fits) ?? all.find(fits);
  if (box) return { box };
  if (needs.length && Object.keys(s.boxes ?? {}).some((id) => mayRunBody(s, id, agent, harness, members))) {
    const missing = needs.filter((n) => !Object.keys(s.boxes ?? {}).some((id) => mayRunBody(s, id, agent, harness, members) && meets(factsOf(s.boxes[id]), n)));
    return { reason: missing.length
      ? `no box that may run ${agent}'s ${harness} bodies has ${missing.join(', ')}`
      : `no one box that may run ${agent}'s ${harness} bodies has all of ${needs.join(', ')}` };
  }
  return { reason: `no box owned by ${agent}'s owner reports ${harness} logged in with a login ${agent} may use (log one in from its page, Boxes; grant the login on the agent's)` };
}
