// Where an agent's bodies may run (Jonathan's ruling, t-1753): only on a box owned by that agent's owner (or lent to
// it by name), that may host it, and that reports the body's harness logged in. The house's own harness login is the
// only credential a body uses.
//
// The box reports and the owners are being built beside this (loom-box branch accounts2: logins.mjs, owners.mjs).
// This reads the shapes that branch writes, and nothing else, so that when it lands this is the one function to point
// at its owners.mjs:
//   box.harnesses = {claude: {loggedIn: true, …}, codex: {…}}   the box's own report (claude auth status, codex login status)
//   box.owner = '<person>', box.lentTo = ['<agent>', …]           whose box it is, and who it's lent to
//   $LOOM_HOME/household.json members: [{person, agents: '*' | [agent]}]; none: one owner with every agent
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mayHost, primaryOf } from './control.mjs';

const PERSON = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function membersOf(env) {
  const p = join(env.LOOM_HOME || join(env.HOME || homedir(), '.config', 'loom'), 'household.json');
  let d = null;
  try { if (existsSync(p)) d = JSON.parse(readFileSync(p, 'utf-8')); } catch { d = null; }
  const ms = Array.isArray(d?.members) ? d.members.filter((m) => m && PERSON.test(m.person ?? '') && (m.agents === '*' || Array.isArray(m.agents))) : [];
  if (ms.length) return ms;
  return [{ person: typeof d?.owner === 'string' && PERSON.test(d.owner) ? d.owner : 'owner', agents: '*' }];
}

function ownersAllow(box, agent, members) {
  if (Array.isArray(box?.lentTo) && box.lentTo.includes(agent)) return true;
  const named = members.filter((m) => Array.isArray(m.agents) && m.agents.includes(agent)).map((m) => m.person);
  const owners = named.length ? named : members.filter((m) => m.agents === '*').map((m) => m.person);
  const first = members.find((m) => m.agents === '*')?.person ?? members[0]?.person;
  const boxOwner = typeof box?.owner === 'string' && members.some((m) => m.person === box.owner) ? box.owner : first;
  return owners.includes(boxOwner);
}

/**
 * The box an agent's body runs on for `harness`: its primary when that qualifies, else the one box that does.
 * {box} or {reason} (why none: said, never a guess).
 */
export function bodyBox(s, agent, harness, env) {
  const members = membersOf(env);
  const ok = (id) => {
    const b = s.boxes[id];
    return b && mayHost(b, agent) && ownersAllow(b, agent, members) && b.harnesses?.[harness]?.loggedIn === true;
  };
  const primary = primaryOf(s, agent, env);
  if (ok(primary)) return { box: primary };
  const fits = Object.keys(s.boxes).filter(ok).sort();
  if (fits.length) return { box: fits[0] };
  return { reason: `no box owned by ${agent}'s owner reports ${harness} logged in (log one in from its page, Boxes)` };
}
