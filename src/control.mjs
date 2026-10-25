// The control plane's half of the runtime (loom docs/specs/runtime.md): what
// each caller may ask of it. It runs on the machine loom runs on, reached
// through loom's piece API (POST /api/box/<path>) by boxes and bodies, and
// through the page (ui act) by the owner.
//
// It is not a scheduler. A house goes where it's told (a box), or to the one
// permitted box that has what it needs, or to the agent's primary. If that
// doesn't name exactly one box, it says why and starts nothing.
import { AGENT_NAME, BOX_NAME, SECRET_NAME, StateError, load, localBoxName, nextHouseId, update } from './state.mjs';

const TERMINAL = new Set(['done', 'failed', 'stopped', 'lost']);
const LIVE = new Set(['wanted', 'starting', 'running', 'stopping']);
const FACT = /^[a-z][a-z0-9-]{0,31}(:[A-Za-z0-9._ +-]{1,64})?$/;
const MAX_TASK = 8000;
const MAX_LOG = 4000;

const fail = (message, status = 400) => { throw new StateError(message, status); };
const now = (effects) => (effects.now ? effects.now() : new Date()).toISOString();

export const boxCredLabel = (name) => `box · ${name}`;
export const houseTokenLabel = (h) => `${h.agent} · house ${h.id} on ${h.box}`;

/** "gpu:5090" is met by a fact "gpu:nvidia-geforce-rtx-5090"; a bare "jonathan-rig" by that exact label. */
export function meets(facts, need) {
  const [k, v] = need.includes(':') ? [need.slice(0, need.indexOf(':')), need.slice(need.indexOf(':') + 1).toLowerCase()] : [need, null];
  return (facts || []).some((f) => {
    const i = f.indexOf(':');
    const fk = i < 0 ? f : f.slice(0, i);
    if (fk !== k) return false;
    if (v === null) return true;
    return i >= 0 && f.slice(i + 1).toLowerCase().includes(v);
  });
}

/** What a box has: its own report plus the owner's labels for it. */
export const factsOf = (b) => [...(b.facts || []), ...(b.labels || [])];

export const mayHost = (box, agent) => !box.revoked && (box.mayHost === '*' || (Array.isArray(box.mayHost) && box.mayHost.includes(agent)));

/** The agent's primary: what the owner set, if that box is still usable, else the control plane's own box. */
export function primaryOf(s, agent, env) {
  const p = s.primaries[agent];
  if (p && s.boxes[p] && mayHost(s.boxes[p], agent)) return p;
  return localBoxName(env);
}

/** Where a house goes, or a StateError saying why nowhere. */
export function placeHouse(s, agent, { box, needs = [] }, env) {
  const permitted = Object.entries(s.boxes).filter(([, b]) => mayHost(b, agent)).map(([n]) => n);
  if (box) {
    if (!s.boxes[box]) fail(`no box named ${box}`, 404);
    if (!mayHost(s.boxes[box], agent)) fail(`${box} may not host ${agent}`, 403);
    const missing = needs.filter((n) => !meets(factsOf(s.boxes[box]), n));
    if (missing.length) fail(`${box} doesn't have ${missing.join(', ')}`, 409);
    return box;
  }
  if (needs.length) {
    const fits = permitted.filter((n) => needs.every((need) => meets(factsOf(s.boxes[n]), need)));
    if (!fits.length) {
      const nowhere = needs.filter((need) => !permitted.some((n) => meets(factsOf(s.boxes[n]), need)));
      fail(nowhere.length
        ? `no box that may host ${agent} has ${nowhere.join(', ')}`
        : `no one box that may host ${agent} has all of ${needs.join(', ')}`, 409);
    }
    const primary = primaryOf(s, agent, env);
    if (fits.includes(primary)) return primary;
    if (fits.length > 1) fail(`several boxes have ${needs.join(', ')}: ${fits.join(', ')}. Name one`, 409);
    return fits[0];
  }
  return primaryOf(s, agent, env);
}

function str(v, what, max = 200) {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) fail(`${what} must be text (${max} characters at most)`);
  return v.trim();
}

function listOf(v, what, re, max = 16) {
  if (v === undefined || v === null || v === '') return [];
  const a = typeof v === 'string' ? v.split(/[\s,]+/).filter(Boolean) : v;
  if (!Array.isArray(a) || a.length > max || !a.every((x) => typeof x === 'string' && re.test(x))) fail(`${what}: up to ${max}, each like ${re}`);
  return a;
}

function mayHostValue(v) {
  if (v === undefined || v === '' || v === '*' || v === 'anyone') return '*';
  return listOf(v, 'may host', AGENT_NAME, 40);
}

function houseView(h) {
  const { tokenLabel: _t, ...rest } = h;
  return rest;
}

// ------------------------------------------------------------- the owner's

export function addBox(env, effects, { name, mayHost: mh, labels }) {
  const n = str(name, 'a box name', 64).toLowerCase();
  if (!BOX_NAME.test(n)) fail('a box name is lowercase letters, digits, dots, dashes and underscores');
  const may = mayHostValue(mh);
  return update(env, (s) => {
    if (s.boxes[n] && !s.boxes[n].revoked) fail(`there's already a box named ${n}`, 409);
    const token = effects.mint(['--piece', `box/${n}`], boxCredLabel(n));
    s.boxes[n] = { mayHost: may, facts: [], labels: listOf(labels, 'labels', FACT), created: now(effects), joined: null, lastSeen: null };
    return { box: n, token };
  });
}

export function revokeBox(env, effects, { name }) {
  return update(env, (s) => {
    const b = s.boxes[name];
    if (!b || b.revoked) fail(`no box named ${name}`, 404);
    if (b.local) fail(`${name} is loom's own machine; it can't be revoked`, 409);
    try { effects.revoke(boxCredLabel(name)); } catch { /* already gone: the box is revoked either way */ }
    b.revoked = now(effects);
    // Its houses lose their tokens with it (runtime.md, "Credentials").
    for (const h of Object.values(s.houses)) {
      if (h.box !== name || TERMINAL.has(h.state)) continue;
      if (h.tokenLabel) try { effects.revoke(h.tokenLabel); } catch { /* best effort */ }
      h.state = 'lost'; h.updated = now(effects); h.note = 'its box was revoked';
    }
    for (const [agent, p] of Object.entries(s.primaries)) if (p === name) delete s.primaries[agent];
    return { box: name, revoked: true };
  });
}

export function setMayHost(env, effects, { name, mayHost: mh }) {
  const may = mayHostValue(mh);
  return update(env, (s) => {
    const b = s.boxes[name];
    if (!b || b.revoked) fail(`no box named ${name}`, 404);
    b.mayHost = may;
    return { box: name, mayHost: may };
  });
}

export function setPrimary(env, effects, { agent, box }) {
  const a = str(agent, 'an agent', 40);
  if (!AGENT_NAME.test(a)) fail('an agent name is lowercase letters, digits and dashes');
  return update(env, (s) => {
    if (!box || box === localBoxName(env)) { delete s.primaries[a]; return { agent: a, primary: localBoxName(env) }; }
    if (!s.boxes[box] || !mayHost(s.boxes[box], a)) fail(`${box} isn't a box that may host ${a}`, 409);
    s.primaries[a] = box;
    return { agent: a, primary: box };
  });
}

/**
 * How an agent's house is made: its repo, the command in it that runs a house
 * (given a task and a directory of secrets), and which secrets a house of it
 * gets, by the name the house sees them under and the secrets-store name they
 * come from. Kept here, not read from the repo, so a box can't widen it.
 */
export function setAgent(env, effects, { agent, repo, houseCmd, branch, repoSecret, secrets }) {
  const a = str(agent, 'an agent', 40);
  if (!AGENT_NAME.test(a)) fail('an agent name is lowercase letters, digits and dashes');
  const r = str(repo, 'the repo', 400);
  if (!/^(https:\/\/[^\s]+|git@[^\s:]+:[^\s]+|\/[^\s]+)$/.test(r)) fail('the repo is an https:// or git@ URL (or an absolute path)');
  const cmd = str(houseCmd ?? 'house/up', 'the house command', 200);
  if (cmd.startsWith('/') || cmd.split('/').some((p) => p === '..' || p === '') || !/^[A-Za-z0-9._/-]+$/.test(cmd)) fail('the house command is a path inside the repo, like house/up');
  const br = branch ? str(branch, 'the branch', 100) : null;
  if (br && !/^[A-Za-z0-9._/-]+$/.test(br)) fail('the branch name has odd characters');
  const rs = repoSecret ? str(repoSecret, 'the repo secret', 64) : null;
  if (rs && !SECRET_NAME.test(rs)) fail('the repo secret is a secrets-store name');
  let sec = secrets ?? {};
  if (typeof sec === 'string') sec = Object.fromEntries(sec.split(/[\s,]+/).filter(Boolean).map((p) => { const [k, v] = p.split('='); return [k, v ?? k]; }));
  if (typeof sec !== 'object' || Array.isArray(sec) || Object.keys(sec).length > 32
      || !Object.entries(sec).every(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && SECRET_NAME.test(v))) {
    fail('secrets map the name a house sees to a secrets-store name, like github-token=github-art-e-fish-token');
  }
  return update(env, (s) => {
    s.agents[a] = { repo: r, houseCmd: cmd, branch: br, repoSecret: rs, secrets: sec };
    return { agent: a, ...s.agents[a] };
  });
}

// ------------------------------------------------------- owner and agents

export function up(env, effects, caller, { agent, box, needs, task }) {
  let a;
  if (caller.kind === 'agent') {
    if (agent && agent !== caller.agent) fail(`this token is ${caller.agent}'s; it can only ask for its own house`, 403);
    a = caller.agent;
  } else {
    a = str(agent, 'an agent', 40);
  }
  if (!AGENT_NAME.test(a)) fail('an agent name is lowercase letters, digits and dashes');
  const t = str(task, 'the task', MAX_TASK);
  const n = listOf(needs, 'needs', FACT);
  if (box !== undefined && box !== null && box !== '' && !BOX_NAME.test(box)) fail('no box by that name', 404);
  return update(env, (s) => {
    if (!s.agents[a]) fail(`${a} has no house yet: the owner sets its repo and house command on the Boxes page`, 409);
    const where = placeHouse(s, a, { box: box || undefined, needs: n }, env);
    const id = nextHouseId(s);
    const at = now(effects);
    s.houses[id] = { id, agent: a, box: where, task: t, needs: n, state: 'wanted', created: at, updated: at, by: caller.kind === 'agent' ? caller.agent : 'owner' };
    return { id, agent: a, box: where, state: 'wanted' };
  });
}

export function down(env, effects, caller, { id }) {
  return update(env, (s) => {
    const h = s.houses[id];
    if (!h || (caller.kind === 'agent' && h.agent !== caller.agent)) fail(`no house ${id}`, 404);
    if (TERMINAL.has(h.state)) return houseView(h);
    if (h.state === 'wanted') h.state = 'stopped';
    else h.state = 'stopping';
    h.updated = now(effects);
    return houseView(h);
  });
}

export function list(env, caller) {
  const s = load(env);
  const houses = Object.values(s.houses)
    .filter((h) => caller.kind === 'owner' || (caller.kind === 'agent' && h.agent === caller.agent))
    .sort((x, y) => Number(y.id.slice(2)) - Number(x.id.slice(2)))
    .slice(0, 50)
    .map(houseView);
  const boxes = Object.entries(s.boxes)
    .filter(([, b]) => caller.kind === 'owner' || (!b.revoked && caller.kind === 'agent' && mayHost(b, caller.agent)))
    .map(([name, b]) => ({ name, local: !!b.local, facts: factsOf(b), lastSeen: b.lastSeen, ...(caller.kind === 'owner' ? { mayHost: b.mayHost, revoked: b.revoked ?? null, created: b.created } : {}) }));
  const primary = caller.kind === 'agent' ? primaryOf(s, caller.agent, env) : undefined;
  return { boxes, houses, ...(primary ? { primary } : {}) };
}

// ------------------------------------------------------------------ boxes

function boxOf(s, caller) {
  const b = s.boxes[caller.subject];
  // A revoked box's credential is revoked too, so this is belt and braces.
  if (!b || b.revoked) fail('this box is not enrolled', 403);
  return b;
}

/** A box says who it is and what it has. Facts are its own report; labels are the owner's. */
export function hello(env, effects, caller, { facts }) {
  const f = listOf(facts, 'facts', FACT, 32);
  return update(env, (s) => {
    const b = boxOf(s, caller);
    b.facts = f;
    b.lastSeen = now(effects);
    b.joined ??= b.lastSeen;
    return { box: caller.subject, mayHost: b.mayHost };
  });
}

/** What this box should be running: houses to start, and houses to stop. */
export function poll(env, effects, caller, { facts } = {}) {
  const f = facts === undefined ? null : listOf(facts, 'facts', FACT, 32);
  return update(env, (s) => {
    const b = boxOf(s, caller);
    if (f) b.facts = f;
    b.lastSeen = now(effects);
    const mine = Object.values(s.houses).filter((h) => h.box === caller.subject);
    return {
      start: mine.filter((h) => h.state === 'wanted' && mayHost(b, h.agent)).map((h) => {
        const a = s.agents[h.agent] || {};
        return { id: h.id, agent: h.agent, task: h.task, repo: a.repo, houseCmd: a.houseCmd, branch: a.branch ?? null };
      }),
      stop: mine.filter((h) => h.state === 'stopping').map((h) => h.id),
      // Taken by this box and not over: one the box doesn't have (it restarted) is lost.
      active: mine.filter((h) => ['starting', 'running', 'stopping'].includes(h.state)).map((h) => h.id),
    };
  });
}

/**
 * The box takes a house: once. It gets the house's loom token (agent:<agent>,
 * labeled for this house on this box) and the secrets that agent's houses get,
 * which the box hands to the house and nothing else (runtime.md,
 * "Credentials": bodies can't fetch secrets; boxes fetch them for houses).
 */
export function claim(env, effects, caller, { id }) {
  return update(env, (s) => {
    boxOf(s, caller);
    const h = s.houses[id];
    if (!h || h.box !== caller.subject) fail(`no house ${id} for this box`, 404);
    if (h.state !== 'wanted') fail(`house ${id} is ${h.state}, not waiting to start`, 409);
    if (!mayHost(s.boxes[caller.subject], h.agent)) fail(`this box may not host ${h.agent}`, 403);
    const a = s.agents[h.agent];
    if (!a) fail(`${h.agent} has no house config`, 409);
    const label = houseTokenLabel(h);
    const token = effects.mint(['--agent', h.agent], label);
    try {
      const secrets = {};
      for (const [as, from] of Object.entries(a.secrets || {})) secrets[as] = effects.secret(from);
      const repoAuth = a.repoSecret ? effects.secret(a.repoSecret) : null;
      h.state = 'starting'; h.tokenLabel = label; h.updated = now(effects);
      return { id, agent: h.agent, token, secrets, repoAuth };
    } catch (err) {
      try { effects.revoke(label); } catch { /* best effort */ }
      throw err;
    }
  });
}

const NEXT = {
  starting: new Set(['running', 'done', 'failed']),
  running: new Set(['done', 'failed']),
  stopping: new Set(['running', 'stopped', 'done', 'failed']),
};

/** The box reports on a house. Ending one revokes its token. */
export function report(env, effects, caller, { id, state, exit, log }) {
  return update(env, (s) => {
    boxOf(s, caller);
    const h = s.houses[id];
    if (!h || h.box !== caller.subject) fail(`no house ${id} for this box`, 404);
    if (!NEXT[h.state]?.has(state)) fail(`house ${id} can't go from ${h.state} to ${state}`, 409);
    // A house asked to stop stays "stopping" while it's still up.
    if (!(h.state === 'stopping' && state === 'running')) h.state = state;
    h.updated = now(effects);
    if (Number.isInteger(exit)) h.exit = exit;
    if (typeof log === 'string') h.log = log.slice(-MAX_LOG);
    if (TERMINAL.has(h.state) && h.tokenLabel) {
      try { effects.revoke(h.tokenLabel); } catch { /* already gone */ }
    }
    return houseView(h);
  });
}

// ---------------------------------------------------------------- the API

const OWNER_ONLY = {
  'add-box': addBox, 'revoke-box': revokeBox, 'may-host': setMayHost, 'set-primary': setPrimary, 'set-agent': setAgent,
};
const BOX_ONLY = { hello, poll, claim, report };

/** One API call, as loom's piece API hands it over: {caller, path, body} → {status, body}. */
export function api(env, effects, { caller, path, body }) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  try {
    if (!caller || typeof caller.kind !== 'string') fail('no caller', 401);
    if (BOX_ONLY[path]) {
      if (caller.kind !== 'piece' || !BOX_NAME.test(caller.subject ?? '')) fail(`${path} is for boxes`, 403);
      return { status: 200, body: BOX_ONLY[path](env, effects, caller, b) };
    }
    if (caller.kind === 'piece') fail(`a box can't ${path || 'do that'}`, 403);
    if (caller.kind !== 'owner' && caller.kind !== 'agent') fail('not for you', 403);
    if (path === 'up') return { status: 200, body: up(env, effects, caller, b) };
    if (path === 'down') return { status: 200, body: down(env, effects, caller, b) };
    if (path === 'list' || path === '') return { status: 200, body: list(env, caller) };
    if (OWNER_ONLY[path]) {
      if (caller.kind !== 'owner') fail(`${path} is the owner's`, 403);
      return { status: 200, body: OWNER_ONLY[path](env, effects, b) };
    }
    fail(`no such call: ${path}`, 404);
  } catch (err) {
    if (err instanceof StateError) return { status: err.status, body: { error: err.message } };
    // Not the caller's doing: core turns this into a 502. The detail stays in the daemon's log.
    process.stderr.write(`loom-box: ${err.stack || err}\n`);
    return { status: 500, body: { error: 'the runtime failed' } };
  }
}

export { LIVE, TERMINAL };
