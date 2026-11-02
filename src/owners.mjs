// Whose box, whose agent (docs/model-accounts.md, "Whose box runs whose agent"): an agent's houses and bodies run
// only on boxes its own owner owns, so a box's logins, signed in with that owner's subscriptions, do that owner's
// work. A box's owner may lend it to another member's agent, by name.
//
// The members are loom's (docs/specs/owners.md): $LOOM_HOME/household.json `members`, each {person, agents}, where
// agents is "*" (a household owner) or a list. An agent's owners are the members who list it by name; an agent no
// one lists is the household owners'. A household with no members file reads as one owner with every agent, so on
// it every box is every agent's, as before.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOGIN_NAMES } from './logins.mjs';

const PERSON = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The household's members: [{person, agents: '*' | [agent]}]. */
export function membersOf(env = process.env) {
  const p = join(env.LOOM_HOME || join(env.HOME || homedir(), '.config', 'loom'), 'household.json');
  let d = null;
  try { if (existsSync(p)) d = JSON.parse(readFileSync(p, 'utf-8')); } catch { d = null; }
  const ms = Array.isArray(d?.members) ? d.members.filter((m) => m && PERSON.test(m.person ?? '') && (m.agents === '*' || Array.isArray(m.agents)))
    .map((m) => ({ person: m.person, agents: m.agents === '*' ? '*' : m.agents.filter((a) => typeof a === 'string') })) : [];
  if (ms.length) return ms;
  const owner = typeof d?.owner === 'string' && PERSON.test(d.owner) ? d.owner : 'owner';
  return [{ person: owner, agents: '*' }];
}

/** The household owners: the members with every agent. */
export const householdOwners = (members) => members.filter((m) => m.agents === '*').map((m) => m.person);

/** An agent's owners: the members who name it, else the household owners. */
export function ownersOf(members, agent) {
  const named = members.filter((m) => Array.isArray(m.agents) && m.agents.includes(agent)).map((m) => m.person);
  return named.length ? named : householdOwners(members);
}

/** A box's owner: who it says (who let it in), else the first household owner (boxes from before owners). */
export function boxOwner(box, members) {
  if (typeof box?.owner === 'string' && PERSON.test(box.owner) && members.some((m) => m.person === box.owner)) return box.owner;
  return householdOwners(members)[0] ?? members[0]?.person ?? 'owner';
}

/** Whether the agent's own owner owns the box (a loan doesn't count): only then may its houses have the box's logins. */
export const ownsBox = (box, agent, members) => ownersOf(members, agent).includes(boxOwner(box, members));

/** The box logins an agent's houses may have: the owner's grant, else all for a household owner's own agent, else none. */
export function loginsOf(a, agent, members) {
  if (Array.isArray(a?.logins)) return a.logins;
  return ownersOf(members, agent).some((p) => householdOwners(members).includes(p)) ? [...LOGIN_NAMES] : [];
}

/**
 * The one rule for whether an agent's work may run on a box's login for a harness: the box is live and logged in to
 * it, the agent's owner owns the box, and the owner granted the agent that login. The model resolver offers an
 * account by it (accounts.mjs) and the claim mounts a login by it (control.mjs), so neither offers what the other
 * won't give.
 */
export function mayUseLogin(box, agentCfg, agent, harness, members) {
  return !box?.revoked && !!box?.harnesses?.[harness]?.loggedIn && !box.harnesses[harness].unhealthy
    && ownsBox(box, agent, members) && loginsOf(agentCfg, agent, members).includes(harness);
}

/** Whether a box runs this agent's work: its owner owns the agent, or lent it the box by name. */
export function ownersAllow(box, agent, members) {
  if (!members) return true;
  if (Array.isArray(box?.lentTo) && box.lentTo.includes(agent)) return true;
  return ownersOf(members, agent).includes(boxOwner(box, members));
}
