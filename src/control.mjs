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

/**
 * Revoke a token, or remember to. A revoke that fails (loom's token file busy,
 * say) must not leave a house's or a box's token live, so it's queued and
 * retried on every later call until it goes. "No live token" means it's gone.
 */
function revokeOrQueue(s, effects, label) {
  try { effects.revoke(label); } catch (err) {
    if (/no live token/i.test(String(err?.message))) return;
    s.pendingRevokes ??= [];
    if (!s.pendingRevokes.includes(label)) s.pendingRevokes.push(label);
  }
}

function retryRevokes(s, effects) {
  const pending = s.pendingRevokes ?? [];
  s.pendingRevokes = [];
  for (const label of pending) revokeOrQueue(s, effects, label);
}
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
    retryRevokes(s, effects);
    if ((s.pendingRevokes ?? []).includes(boxCredLabel(n))) fail(`${n}'s old credential isn't revoked yet; try again shortly`, 409);
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
    revokeOrQueue(s, effects, boxCredLabel(name));
    b.revoked = now(effects);
    // Its houses lose their tokens with it (runtime.md, "Credentials").
    for (const h of Object.values(s.houses)) {
      if (h.box !== name || TERMINAL.has(h.state)) continue;
      if (h.tokenLabel) revokeOrQueue(s, effects, h.tokenLabel);
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
 * How an agent's house is made: its repo, the house file in it (house.mjs:
 * the image and where things land), whether its house may run nested
 * containers, and which secrets a house of it gets, by the name the house file
 * uses and the secrets-store name they come from. Kept here, not read from
 * the repo, so neither a box nor the repo can widen it.
 */
export function setAgent(env, effects, { agent, repo, houseFile, nested, branch, repoSecret, secrets }) {
  const a = str(agent, 'an agent', 40);
  if (!AGENT_NAME.test(a)) fail('an agent name is lowercase letters, digits and dashes');
  const r = str(repo, 'the repo', 400);
  if (!/^(https:\/\/[^\s]+|git@[^\s:]+:[^\s]+|\/[^\s]+)$/.test(r)) fail('the repo is an https:// or git@ URL (or an absolute path)');
  const file = str(houseFile || 'house/house.json', 'the house file', 200);
  if (file.startsWith('/') || file.split('/').some((p) => p === '..' || p === '.' || p === '') || !/^[A-Za-z0-9._/-]+$/.test(file)) fail('the house file is a path inside the repo, like house/house.json');
  const nest = nested === true || nested === 'true' || nested === 'yes';
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
    s.agents[a] = { repo: r, houseFile: file, nested: nest, branch: br, repoSecret: rs, secrets: sec };
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
    if (!s.agents[a]) fail(`${a} has no house yet: the owner sets its repo on the Boxes page`, 409);
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
    if (h.service && LIVE.has(h.state)) fail(`${id} is the ${h.service} service's house: take the service down (service-down) or move it`, 409);
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
  const services = Object.entries(s.services ?? {})
    .filter(([, v]) => caller.kind === 'owner' || (caller.kind === 'agent' && v.agent === caller.agent))
    .map(([key, v]) => ({ service: key, agent: v.agent, name: v.name, box: v.box, want: v.want, moveTo: v.moveTo ?? null, house: v.house, state: s.houses[v.house]?.state ?? null, restarts: v.restarts ?? 0, stateSaved: s.serviceState?.[key]?.at ?? null }));
  return { boxes, houses, services, ...(primary ? { primary } : {}) };
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
    // Boxes poll every few seconds: the natural place to finish any revoke that failed.
    retryRevokes(s, effects);
    const mine = Object.values(s.houses).filter((h) => h.box === caller.subject);
    return {
      start: mine.filter((h) => h.state === 'wanted' && mayHost(b, h.agent) && !(h.notBefore && Date.parse(h.notBefore) > Date.parse(now(effects)))).map((h) => {
        const a = s.agents[h.agent] || {};
        return { id: h.id, agent: h.agent, task: h.task, service: h.service ?? null, repo: a.repo, houseFile: a.houseFile || 'house/house.json', branch: a.branch ?? null };
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
    // Never mint under a label that's still waiting to be revoked: the revoke would take the new token.
    retryRevokes(s, effects);
    if ((s.pendingRevokes ?? []).includes(label)) fail(`an old token for ${id} isn't revoked yet; try again shortly`, 409);
    const token = effects.mint(['--agent', h.agent], label);
    try {
      const secrets = {};
      for (const [as, from] of Object.entries(a.secrets || {})) secrets[as] = effects.secret(from);
      const repoAuth = a.repoSecret ? effects.secret(a.repoSecret) : null;
      h.state = 'starting'; h.tokenLabel = label; h.updated = now(effects);
      const saved = h.service ? s.serviceState?.[serviceKey(h.agent, h.service)] : undefined;
      return { id, agent: h.agent, token, secrets, repoAuth, nested: !!a.nested, ...(h.service ? { service: h.service, state: saved?.data ?? null } : {}) };
    } catch (err) {
      // The house stays waiting; the token it was about to get goes (or is queued to).
      revokeOrQueue(s, effects, label);
      const e = err instanceof StateError ? err : new StateError(`couldn't get ${h.agent}'s house secrets: ${err.message}`, 500);
      e.saveState = true;
      throw e;
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
    if (state === 'running') h.started ??= h.updated;
    if (Number.isInteger(exit)) h.exit = exit;
    if (typeof log === 'string') h.log = log.slice(-MAX_LOG);
    if (TERMINAL.has(h.state) && h.tokenLabel) revokeOrQueue(s, effects, h.tokenLabel);
    if (TERMINAL.has(h.state) && h.service) serviceHouseEnded(s, h, effects);
    return houseView(h);
  });
}

// --------------------------------------------------------------- services
//
// A service is a long-lived house: no task, kept up, restarted if it dies,
// and at most one live house at a time, anywhere (runtime.md, "Decided
// 2026-10-25": two copies of a bridge answer every message). Moving one is a
// hand-off: the old box stops it and says so, and only then does the new box
// get it. Its state (a bridge's read position) travels through loom: the box
// saves it when the house stops, and the next box gets it when it claims.

const SERVICE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const RESTART_BASE_MS = 5_000;
const RESTART_MAX_MS = 300_000;
export const MAX_STATE_BYTES = 700_000; // base64 of the tarball, inside loom's 1 MB body cap
export const serviceKey = (agent, name) => `${agent}/${name}`;

function serviceOf(s, caller, { agent, name }) {
  const a = caller.kind === 'agent' ? caller.agent : agent;
  if (caller.kind === 'agent' && agent && agent !== caller.agent) fail(`this token is ${caller.agent}'s`, 403);
  if (!AGENT_NAME.test(a ?? '')) fail('an agent name is lowercase letters, digits and dashes');
  if (!SERVICE_NAME.test(name ?? '')) fail('a service name is lowercase letters, digits and dashes, like discord');
  return { a, key: serviceKey(a, name) };
}

function startService(s, svc, effects, delayMs = 0) {
  const id = nextHouseId(s);
  const at = now(effects);
  s.houses[id] = {
    id, agent: svc.agent, box: svc.box, service: svc.name, task: `(service ${svc.name})`, needs: [], state: 'wanted', created: at, updated: at, by: 'service',
    ...(delayMs ? { notBefore: new Date(Date.parse(at) + delayMs).toISOString() } : {}),
  };
  svc.house = id;
  return id;
}

/** Bring a service up (on its box, or the agent's primary), or say where it already is. */
export function serviceUp(env, effects, caller, body) {
  return update(env, (s) => {
    const { a, key } = serviceOf(s, caller, body);
    if (!s.agents[a]) fail(`${a} has no house yet: the owner sets its repo on the Boxes page`, 409);
    s.services ??= {};
    const svc = s.services[key];
    if (svc?.want === 'up') return { service: key, box: svc.box, house: svc.house, state: s.houses[svc.house]?.state };
    const box = placeHouse(s, a, { box: body.box || svc?.box || undefined }, env);
    const next = { agent: a, name: body.name, box, want: 'up', restarts: 0, created: svc?.created ?? now(effects) };
    s.services[key] = next;
    const id = startService(s, next, effects);
    return { service: key, box, house: id, state: 'wanted' };
  });
}

/** Take a service down: its house stops, and nothing restarts it. */
export function serviceDown(env, effects, caller, body) {
  return update(env, (s) => {
    const { key } = serviceOf(s, caller, body);
    const svc = s.services?.[key];
    if (!svc) fail(`no service ${key}`, 404);
    svc.want = 'down';
    delete svc.moveTo;
    const h = s.houses[svc.house];
    if (h && LIVE.has(h.state)) { h.state = h.state === 'wanted' ? 'stopped' : 'stopping'; h.updated = now(effects); }
    return { service: key, want: 'down', house: svc.house, state: h?.state };
  });
}

/**
 * Move a service to another box: a hand-off. Its house there starts only once
 * the old box has said this one stopped. `force` is for an old box that's gone
 * for good: its house is written off and its token revoked without waiting.
 * If that box is in fact still up, two copies run until it's revoked too, so
 * it's the owner's call, never the default.
 */
export function serviceMove(env, effects, caller, body) {
  return update(env, (s) => {
    const { a, key } = serviceOf(s, caller, body);
    const svc = s.services?.[key];
    if (!svc || svc.want !== 'up') fail(`${key} isn't up`, 404);
    const to = placeHouse(s, a, { box: body.box }, env);
    if (to === svc.box && !svc.moveTo) return { service: key, box: to, moving: false };
    const h = s.houses[svc.house];
    if (!h || TERMINAL.has(h.state) || h.state === 'wanted') {
      // Nothing is running it anywhere: just put it there.
      if (h && h.state === 'wanted') { h.state = 'stopped'; h.updated = now(effects); }
      svc.box = to; delete svc.moveTo;
      const id = startService(s, svc, effects);
      return { service: key, box: to, house: id, moving: false };
    }
    if (body.force === true || body.force === 'true') {
      if (caller.kind !== 'owner') fail('forcing a move is the owner\'s call', 403);
      if (h.tokenLabel) revokeOrQueue(s, effects, h.tokenLabel);
      h.state = 'lost'; h.note = `written off by a forced move to ${to}`; h.updated = now(effects);
      svc.box = to; delete svc.moveTo;
      const id = startService(s, svc, effects);
      return { service: key, box: to, house: id, moving: false, forced: true };
    }
    svc.moveTo = to;
    if (h.state !== 'stopping') { h.state = 'stopping'; h.updated = now(effects); }
    return { service: key, box: svc.box, moveTo: to, house: h.id, moving: true };
  });
}

/** When a service's house ends: move it, restart it (backing off), or leave it down. */
function serviceHouseEnded(s, h, effects) {
  const svc = s.services?.[serviceKey(h.agent, h.service)];
  if (!svc || svc.house !== h.id) return;
  if (svc.want !== 'up') return;
  if (svc.moveTo) {
    svc.box = svc.moveTo; delete svc.moveTo; svc.restarts = 0;
    startService(s, svc, effects);
    return;
  }
  // A clean stop the owner didn't ask for, or a crash: up again, more slowly each time.
  const ranMs = Date.parse(h.updated) - Date.parse(h.started ?? h.created);
  svc.restarts = ranMs > 10 * 60_000 ? 1 : (svc.restarts ?? 0) + 1;
  startService(s, svc, effects, Math.min(RESTART_BASE_MS * 2 ** (svc.restarts - 1), RESTART_MAX_MS));
}

/** A box saves a service's state when its house stops (base64 of a tarball). */
export function saveState(env, effects, caller, { id, state }) {
  return update(env, (s) => {
    boxOf(s, caller);
    const h = s.houses[id];
    if (!h || h.box !== caller.subject || !h.service) fail(`no service house ${id} for this box`, 404);
    if (typeof state !== 'string' || state.length > MAX_STATE_BYTES || !/^[A-Za-z0-9+/=]*$/.test(state)) fail(`a service's state is base64, ${MAX_STATE_BYTES} bytes at most`, 413);
    s.serviceState ??= {};
    s.serviceState[serviceKey(h.agent, h.service)] = { from: id, box: caller.subject, at: now(effects), data: state };
    return { saved: state.length };
  });
}

// ---------------------------------------------------------------- the API

const OWNER_ONLY = {
  'add-box': addBox, 'revoke-box': revokeBox, 'may-host': setMayHost, 'set-primary': setPrimary, 'set-agent': setAgent,
};
const BOX_ONLY = { hello, poll, claim, report, 'save-state': saveState };

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
    if (path === 'service-up') return { status: 200, body: serviceUp(env, effects, caller, b) };
    if (path === 'service-down') return { status: 200, body: serviceDown(env, effects, caller, b) };
    if (path === 'service-move') return { status: 200, body: serviceMove(env, effects, caller, b) };
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
