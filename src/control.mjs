// The control plane's half of the runtime (loom docs/specs/runtime.md): what
// each caller may ask of it. It runs on the machine loom runs on, reached
// through loom's piece API (POST /api/<piece>/<path>: box, or runtime under its new name) by boxes and bodies, and
// through the page (ui act) by the owner.
//
// It is not a scheduler. A house goes where it's told (a box), or to the one
// permitted box that has what it needs, or to the agent's primary. If that
// doesn't name exactly one box, it says why and starts nothing.
import { ownCommit } from './version.mjs';
import { pieceName } from './piece.mjs';
import { randomBytes } from 'node:crypto';
import { AGENT_NAME, BOX_NAME, SECRET_NAME, StateError, load, localBoxName, nextHouseId, update } from './state.mjs';
import { joinPoll, joinRequest } from './enroll.mjs';
import { MAX_PARTS, PART_RAW, drop, partsOf, putPart, putWhole, readPart } from './blobs.mjs';
import { parsePortGrant, parseTailnetGrant } from './house.mjs';
import { CODE, LOGIN_NAMES } from './logins.mjs';
import { boxOwner, membersOf, ownersAllow } from './owners.mjs';

const TERMINAL = new Set(['done', 'failed', 'stopped', 'lost']);
const LIVE = new Set(['wanted', 'starting', 'running', 'stopping']);
/** How many claims in a row may fail before the house does. */
export const MAX_CLAIM_TRIES = 5;
/** What the runtime used to issue from a subscriptions broker: gone (docs/model-accounts.md). A box logs in itself. */
const SUB_SOURCE = /^sub:/;
const FACT = /^[a-z][a-z0-9-]{0,31}(:[A-Za-z0-9._ +-]{1,64})?$/;
const MAX_TASK = 8000;
const MAX_LOG = 4000;

const fail = (message, status = 400) => { throw new StateError(message, status); };
const now = (effects) => (effects.now ? effects.now() : new Date()).toISOString();

export const boxCredLabel = (name) => `box · ${name}`;
/** A box's credential label: its own (new boxes: `box · <name> (<id>)`), else the old `box · <id>`. */
const credLabelOf = (s, id) => s.boxes[id]?.credLabel ?? boxCredLabel(id);

/**
 * A box's id: loom's own, four groups of six hex digits (Jonathan, 2026-10-27: "to loom
 * it's something that looks like 4 hex colors put together"). Its name is only what it's
 * called: any name, even one another box has. A box from before ids keeps its name as its id.
 */
export const BOX_ID = /^[0-9a-f]{6}(-[0-9a-f]{6}){3}$/;
export function newBoxId() {
  return Array.from({ length: 4 }, () => randomBytes(3).toString('hex')).join('-');
}

/** What a box is called (its name, or its id for one from before names). */
export const boxNameOf = (s, id) => s.boxes[id]?.name ?? id;

/** Its name, and when another live box has that name too, the start of its id to tell them apart. */
export function boxLabelOf(s, id) {
  const n = boxNameOf(s, id);
  const twin = Object.entries(s.boxes).some(([o, b]) => o !== id && !b.revoked && (b.name ?? o) === n);
  return twin ? `${n} (${id.slice(0, 6)})` : n;
}

/**
 * The box someone means: its id, or a name only one live box has. Two live boxes with that
 * name: say so, with their ids, rather than pick one.
 */
export function resolveBox(s, ref) {
  if (typeof ref !== 'string' || !ref) fail('which box: its name or its id');
  // An id (or a box from before ids, keyed by its name) is exact and wins: no name can make it ambiguous.
  if (s.boxes[ref] && !s.boxes[ref].revoked) return ref;
  const named = Object.entries(s.boxes).filter(([, b]) => !b.revoked && b.name === ref).map(([id]) => id);
  if (named.length === 1) return named[0];
  if (named.length > 1) fail(`${named.length} boxes are named ${ref}: say which by id (${named.join(', ')})`, 409);
  fail(`no box named ${ref}`, 404);
}

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
export const houseTokenLabel = (h, boxName = h.box) => `${h.agent} · house ${h.id} on ${boxName}`;

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

/**
 * Whether a box may host an agent: the box's own grant (who it may host), and whose box it is (owners.mjs): an
 * agent's work runs only on a box its owner owns, or one lent to it. `members` is the household's (membersOf).
 */
export const mayHost = (box, agent, members) => !box.revoked && (box.mayHost === '*' || (Array.isArray(box.mayHost) && box.mayHost.includes(agent)))
  && ownersAllow(box, agent, members);

/** The agent's primary: what the owner set, if that box is still usable, else the control plane's own box. */
export function primaryOf(s, agent, env) {
  const p = s.primaries[agent];
  if (p && s.boxes[p] && mayHost(s.boxes[p], agent, membersOf(env))) return p;
  return localBoxName(env);
}

/** Where a house goes, or a StateError saying why nowhere. */
export function placeHouse(s, agent, { box, needs = [] }, env) {
  const members = membersOf(env);
  const permitted = Object.entries(s.boxes).filter(([, b]) => mayHost(b, agent, members)).map(([n]) => n);
  if (box) {
    const id = resolveBox(s, box);
    if (!ownersAllow(s.boxes[id], agent, members)) fail(`${boxNameOf(s, id)} is ${boxOwner(s.boxes[id], members)}'s box, and ${agent} isn't their agent (a box's owner can lend it: box-lend)`, 403);
    if (!mayHost(s.boxes[id], agent, members)) fail(`${boxNameOf(s, id)} may not host ${agent}`, 403);
    const missing = needs.filter((n) => !meets(factsOf(s.boxes[id]), n));
    if (missing.length) fail(`${boxNameOf(s, id)} doesn't have ${missing.join(', ')}`, 409);
    return id;
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
    if (fits.length > 1) fail(`several boxes have ${needs.join(', ')}: ${fits.map((id) => boxLabelOf(s, id)).join(', ')}. Name one`, 409);
    return fits[0];
  }
  const primary = primaryOf(s, agent, env);
  // The fallback primary is loom's own box: refused too when it isn't the agent's owner's.
  if (!mayHost(s.boxes[primary] ?? { mayHost: '*' }, agent, members)) fail(`no box of ${agent}'s owner may host it: name one, or have a box lent to ${agent}`, 409);
  return primary;
}

function str(v, what, max = 200) {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) fail(`${what} must be text (${max} characters at most)`);
  return v.trim();
}

function listOf(v, what, re, max = 16) {
  if (v === undefined || v === null || v === '') return [];
  const a = typeof v === 'string' ? v.split(/[\s,]+/).filter(Boolean) : v;
  if (!Array.isArray(a) || a.length > max || !a.every((x) => typeof x === 'string' && re.test(x))) {
    fail(`${what}: up to ${max}, lowercase words like gpu or rig:5090, separated by commas`);
  }
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
  if (BOX_ID.test(n)) fail('that looks like a box id; a name is what you call it');
  const may = mayHostValue(mh);
  // Everything checked before the credential is minted: a box that isn't added never leaves one live.
  const ls = listOf(labels, 'labels', FACT);
  let token, minted;
  try {
    return update(env, (s) => {
      // Its id is loom's; its name is only what it's called (another box may have it too).
      retryRevokes(s, effects);
      let id;
      do id = newBoxId(); while (s.boxes[id]);
      const label = `box · ${n} (${id})`;
      token = effects.mint(['--piece', `${pieceName(env)}/${id}`], label);
      minted = label;
      s.boxes[id] = { name: n, credLabel: label, mayHost: may, facts: [], labels: ls, created: now(effects), joined: null, lastSeen: null };
      return { box: id, name: n, token };
    });
  } catch (err) {
    // Minted, then failed (the save, a clock): the box wasn't added, so neither is its credential.
    if (token && minted) { try { effects.revoke(minted); } catch { /* listed by the token store; the owner can revoke it */ } }
    throw err;
  }
}

export function revokeBox(env, effects, { name }) {
  return update(env, (s) => {
    const id = resolveBox(s, name);
    const b = s.boxes[id];
    if (b.local) fail(`${boxNameOf(s, id)} is loom's own machine; it can't be revoked`, 409);
    revokeOrQueue(s, effects, credLabelOf(s, id));
    b.revoked = now(effects);
    // Its houses lose their tokens with it (runtime.md, "Credentials").
    for (const h of Object.values(s.houses)) {
      if (h.box !== id || TERMINAL.has(h.state)) continue;
      if (h.tokenLabel) revokeOrQueue(s, effects, h.tokenLabel);
      h.state = 'lost'; h.updated = now(effects); h.note = 'its box was revoked';
    }
    for (const [agent, p] of Object.entries(s.primaries)) if (p === id) delete s.primaries[agent];
    return { box: id, name: boxNameOf(s, id), revoked: true };
  });
}

export function setMayHost(env, effects, { name, mayHost: mh }) {
  const may = mayHostValue(mh);
  return update(env, (s) => {
    const id = resolveBox(s, name);
    s.boxes[id].mayHost = may;
    return { box: id, name: boxNameOf(s, id), mayHost: may };
  });
}

export function setPrimary(env, effects, { agent, box }) {
  const a = str(agent, 'an agent', 40);
  if (!AGENT_NAME.test(a)) fail('an agent name is lowercase letters, digits and dashes');
  return update(env, (s) => {
    if (!box || box === localBoxName(env)) { delete s.primaries[a]; return { agent: a, primary: localBoxName(env) }; }
    const id = resolveBox(s, box);
    if (s.boxes[id].local) { delete s.primaries[a]; return { agent: a, primary: id }; }
    if (!mayHost(s.boxes[id], a, membersOf(env))) fail(`${boxNameOf(s, id)} isn't a box that may host ${a}`, 409);
    s.primaries[a] = id;
    return { agent: a, primary: id };
  });
}

/**
 * How an agent's house is made: its repo, the house file in it (house.mjs:
 * the image and where things land), whether its house may run nested
 * containers, which ports it may publish on a box, which tailnets (a box's tailscaled socket) it may use, and which secrets a house of it gets, by the name the house file
 * uses and the secrets-store name they come from. Kept here, not read from
 * the repo, so neither a box nor the repo can widen it.
 */
export function setAgent(env, effects, { agent, repo, houseFile, nested, gpu, branch, repoSecret, secrets, ports, tailnets }) {
  const a = str(agent, 'an agent', 40);
  if (!AGENT_NAME.test(a)) fail('an agent name is lowercase letters, digits and dashes');
  const r = str(repo, 'the repo', 400);
  if (!/^(https:\/\/[^\s]+|git@[^\s:]+:[^\s]+|\/[^\s]+)$/.test(r)) fail('the repo is an https:// or git@ URL (or an absolute path)');
  const file = str(houseFile || 'house/house.json', 'the house file', 200);
  if (file.startsWith('/') || file.split('/').some((p) => p === '..' || p === '.' || p === '') || !/^[A-Za-z0-9._/-]+$/.test(file)) fail('the house file is a path inside the repo, like house/house.json');
  const nest = nested === true || nested === 'true' || nested === 'yes';
  // The box's GPU in its houses (t-1616): the owner's grant, like nested containers.
  const gp = gpu === true || gpu === 'true' || gpu === 'yes';
  const br = branch ? str(branch, 'the branch', 100) : null;
  if (br && !/^[A-Za-z0-9._/-]+$/.test(br)) fail('the branch name has odd characters');
  const rs = repoSecret ? str(repoSecret, 'the repo secret', 64) : null;
  if (rs && !SECRET_NAME.test(rs)) fail('the repo secret is a secrets-store name');
  let sec = secrets ?? {};
  if (typeof sec === 'string') sec = Object.fromEntries(sec.split(/[\s,]+/).filter(Boolean).map((p) => { const [k, v] = p.split('='); return [k, v ?? k]; }));
  if (typeof sec !== 'object' || Array.isArray(sec) || Object.keys(sec).length > 32
      || !Object.entries(sec).every(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && SECRET_NAME.test(v))) {
    if (Object.values(sec).some((v) => typeof v === 'string' && SUB_SOURCE.test(v))) {
      fail('sub:<provider> is gone: a box logs in to Claude or Codex itself (its page, Log in), and a house that wants the login says "logins" in its house file. An API key is a plain secret: anthropic-api-key=<store name>');
    }
    fail('secrets map the name a house sees to a secrets-store name (github-token=github-art-e-fish-token; an API key: anthropic-api-key=<store name>)');
  }
  let pt = ports ?? [];
  if (typeof pt === 'string') pt = pt.split(/[\s,]+/).filter(Boolean);
  if (!Array.isArray(pt) || pt.length > 8) fail('ports is a list of up to 8');
  pt = pt.map(parsePortGrant);
  if (pt.some((g) => !g)) fail('a port grant is a number from 1024 (bound on loopback), or an address and a port, like 0.0.0.0:7401');
  if (new Set(pt.map((g) => g.port)).size !== pt.length) fail('each port is granted once');
  let tn = tailnets ?? [];
  if (typeof tn === 'string') tn = tn.split(/[\s,]+/).filter(Boolean);
  if (!Array.isArray(tn) || tn.length > 4) fail('tailnets is a list of up to 4');
  tn = tn.map(parseTailnetGrant);
  if (tn.some((g) => !g)) fail('a tailnet grant is a name and a tailscaled socket on the box, like fleet=/run/tailscale-fleet/tailscaled.sock');
  if (new Set(tn.map((g) => g.name)).size !== tn.length) fail('each tailnet is granted once');
  return update(env, (s) => {
    s.agents[a] = { repo: r, houseFile: file, nested: nest, gpu: gp, branch: br, repoSecret: rs, secrets: sec, ports: pt, tailnets: tn };
    return { agent: a, ...s.agents[a] };
  });
}

// ------------------------------------------------------- owner and agents

/**
 * Whether a caller sees, and may act on, an agent's houses and services (loom
 * docs/specs/owners.md): a household owner every agent's; an agent owner (an owner
 * caller with a list of agents) their agents'; an agent its own.
 */
export function sees(caller, agent) {
  if (caller.kind === 'owner') return !Array.isArray(caller.agents) || caller.agents.includes(agent);
  return caller.kind === 'agent' && caller.agent === agent;
}

/** The household's owner: everything that isn't one agent's (boxes, enrolling, an agent's settings) is theirs. */
export const householdOwner = (caller) => caller.kind === 'owner' && !Array.isArray(caller.agents);

/** Who a record says acted: the agent, the member who's an owner, or 'owner'. */
const actor = (caller) => (caller.kind === 'agent' ? caller.agent : typeof caller.who === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(caller.who) ? caller.who : 'owner');

export function up(env, effects, caller, { agent, box, needs, task, session, slot }) {
  let a;
  if (caller.kind === 'agent') {
    if (agent && agent !== caller.agent) fail(`this token is ${caller.agent}'s; it can only ask for its own house`, 403);
    a = caller.agent;
  } else {
    a = str(agent, 'an agent', 40);
  }
  if (!AGENT_NAME.test(a)) fail('an agent name is lowercase letters, digits and dashes');
  if (!sees(caller, a)) fail(`${a} isn't one of your agents`, 403);
  // A session house has no task: it waits for someone to attach (loom box session).
  const sess = session === true;
  const t = sess ? '(an interactive session)' : str(task, 'the task', MAX_TASK);
  const n = listOf(needs, 'needs', FACT);
  // A slot: a lane's own bookkeeping, restored into the house and saved when it ends.
  const sl = slot === undefined || slot === null || slot === '' ? null : str(slot, 'the slot', 40);
  if (sl && !SERVICE_NAME.test(sl)) fail('a slot name is lowercase letters, digits and dashes, like tending');
  if (box !== undefined && box !== null && box !== '' && !BOX_NAME.test(box)) fail('no box by that name', 404);
  return update(env, (s) => {
    if (!s.agents[a]) fail(`${a} has no house yet: the owner sets its repo on the Boxes page`, 409);
    // One house holds a slot at a time: two would each start from the same state and the later save would win.
    const holder = sl && Object.values(s.houses).find((x) => x.agent === a && x.slot === sl && LIVE.has(x.state));
    if (holder) fail(`${holder.id} holds ${a}'s ${sl} slot; one house at a time`, 409);
    const where = placeHouse(s, a, { box: box || undefined, needs: n }, env);
    const id = nextHouseId(s);
    const at = now(effects);
    s.houses[id] = { id, agent: a, box: where, task: t, needs: n, state: 'wanted', created: at, updated: at, by: actor(caller), ...(sess ? { session: true } : {}), ...(sl ? { slot: sl } : {}) };
    return { id, agent: a, box: where, boxName: boxLabelOf(s, where), state: 'wanted', ...(sess ? { session: true } : {}), ...(sl ? { slot: sl } : {}) };
  });
}

export function down(env, effects, caller, { id }) {
  return update(env, (s) => {
    const h = s.houses[id];
    if (!h || !sees(caller, h.agent)) fail(`no house ${id}`, 404);
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
  const members = membersOf(env);
  const houses = Object.values(s.houses)
    .filter((h) => sees(caller, h.agent))
    .sort((x, y) => Number(y.id.slice(2)) - Number(x.id.slice(2)))
    .slice(0, 50)
    .map(houseView);
  // Boxes are the household's: its owner sees them all, with their grants; anyone else, the live ones that may host their agents.
  const mine = caller.kind === 'agent' ? [caller.agent] : Array.isArray(caller.agents) ? caller.agents : null;
  const boxes = Object.entries(s.boxes)
    .filter(([, b]) => householdOwner(caller) || (!b.revoked && mine?.some((a) => mayHost(b, a, members))))
    .map(([id, b]) => ({ id, name: b.name ?? id, local: !!b.local, facts: factsOf(b), lastSeen: b.lastSeen, harnesses: harnessesOf(b),
      ...(householdOwner(caller) ? { mayHost: b.mayHost, owner: boxOwner(b, members), lentTo: b.lentTo ?? [], revoked: b.revoked ?? null, created: b.created } : {}) }));
  const primary = caller.kind === 'agent' ? primaryOf(s, caller.agent, env) : undefined;
  const services = Object.entries(s.services ?? {})
    .filter(([, v]) => sees(caller, v.agent))
    .map(([key, v]) => ({ service: key, agent: v.agent, name: v.name, box: v.box, want: v.want, moveTo: v.moveTo ?? null, house: v.house, state: s.houses[v.house]?.state ?? null, restarts: v.restarts ?? 0, stateSaved: s.serviceState?.[key]?.at ?? null }));
  const sessions = Object.entries(s.remotes ?? {}).filter(([a]) => sees(caller, a))
    .map(([a, r]) => remoteView(a, r));
  return { boxes, houses, services, remotes: sessions, ...(primary ? { primary } : {}) };
}

// ------------------------------------------------------------------ boxes

function boxOf(s, caller) {
  const b = s.boxes[caller.subject];
  // A revoked box's credential is revoked too, so this is belt and braces.
  if (!b || b.revoked) fail('this box is not enrolled', 403);
  return b;
}

/** A box says who it is and what it has. Facts are its own report; labels are the owner's. */
export function hello(env, effects, caller, { facts, harnesses }) {
  const f = listOf(facts, 'facts', FACT, 32);
  const hs = harnessReport(harnesses);
  return update(env, (s) => {
    const b = boxOf(s, caller);
    b.facts = f;
    if (hs) b.harnesses = stamp(hs, now(effects));
    b.lastSeen = now(effects);
    b.joined ??= b.lastSeen;
    return { box: caller.subject, name: b.name ?? caller.subject, mayHost: b.mayHost };
  });
}

/** What this box should be running: houses to start, and houses to stop. */
const SESSION_KEY = /^(box:[^\0]{1,120}|house:h-\d{1,9})$/;

export function poll(env, effects, caller, { facts, sessions, harnesses, usage } = {}) {
  const f = facts === undefined ? null : listOf(facts, 'facts', FACT, 32);
  const hs = harnessReport(harnesses);
  const us = usageReport(usage);
  // Its remote sessions, working or idle, as the box sampled them: only well-formed keys, a few.
  const busy = sessions && typeof sessions === 'object' && !Array.isArray(sessions)
    ? Object.fromEntries(Object.entries(sessions).filter(([k, v]) => SESSION_KEY.test(k) && typeof v === 'boolean').slice(0, 20)) : null;
  return update(env, (s) => {
    const b = boxOf(s, caller);
    if (f) b.facts = f;
    if (hs) b.harnesses = stamp(hs, now(effects));
    for (const [h, r] of Object.entries(us ?? {})) (b.usage ??= {})[h] = r;
    // Only sessions this box runs: its houses, and the box sessions placed on it (it can't speak for another's).
    if (busy) {
      const ours = (k) => k.startsWith('house:') ? s.houses[k.slice(6)]?.box === caller.subject
        : Object.values(s.remotes ?? {}).some((r) => r.box === caller.subject && `box:${r.name}` === k);
      b.sessions = { at: now(effects), busy: Object.fromEntries(Object.entries(busy).filter(([k]) => ours(k))) };
    }
    b.lastSeen = now(effects);
    // Boxes poll every few seconds: the natural place to finish any revoke that failed.
    retryRevokes(s, effects);
    const mine = Object.values(s.houses).filter((h) => h.box === caller.subject);
    const members = membersOf(env);
    expireLogins(s, effects);
    return {
      // Logins the owner started from the box's page: the CLI's own login, run here (logins.mjs). A pasted code goes
      // to the box once and is gone from loom's state.
      logins: Object.values(s.logins ?? {}).filter((l) => l.box === caller.subject && (l.state === 'wanted' || l.code || l.state === 'cancel'))
        .map((l) => {
          const out = { id: l.id, harness: l.harness, state: l.state, ...(l.code ? { code: l.code } : {}) };
          delete l.code;
          if (l.state === 'wanted') l.state = 'starting';
          if (l.state === 'cancel') l.state = 'failed';
          return out;
        }),
      start: mine.filter((h) => h.state === 'wanted' && mayHost(b, h.agent, members) && !(h.notBefore && Date.parse(h.notBefore) > Date.parse(now(effects)))).map((h) => {
        const a = s.agents[h.agent] || {};
        return { id: h.id, agent: h.agent, task: h.task, service: h.service ?? null, slot: h.slot ?? null, session: !!h.session, repo: a.repo, houseFile: a.houseFile || 'house/house.json', branch: a.branch ?? null,
          // A house asked for with a GPU need gets the box's GPU (t-1616).
          gpu: (h.needs ?? []).some((n) => /^gpu(:|$)/.test(n)) };
      }),
      stop: mine.filter((h) => h.state === 'stopping').map((h) => h.id),
      // Taken by this box and not over: one the box doesn't have (it restarted) is lost.
      active: mine.filter((h) => ['starting', 'running', 'stopping'].includes(h.state)).map((h) => h.id),
      // Its box sessions: up or down, as the owner wants them.
      remotes: Object.entries(s.remotes ?? {}).filter(([, r]) => r.box === caller.subject)
        .map(([agent, r]) => ({ agent, dir: r.dir, name: r.name, want: r.want, state: r.state })),
      // The loom-box loom runs (version.mjs): a box on another one installs this one.
      ...(ownCommit() ? { version: ownCommit() } : {}),
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
    if (!mayHost(s.boxes[caller.subject], h.agent, membersOf(env))) fail(`this box may not host ${h.agent}`, 403);
    const a = s.agents[h.agent];
    if (!a) fail(`${h.agent} has no house config`, 409);
    const label = houseTokenLabel(h, boxNameOf(s, h.box));
    // Never mint under a label that's still waiting to be revoked: the revoke would take the new token.
    retryRevokes(s, effects);
    if ((s.pendingRevokes ?? []).includes(label)) fail(`an old token for ${id} isn't revoked yet; try again shortly`, 409);
    // A service house's token says so (agent:<a>/<service>): a piece can tell
    // the agent's bridge from its other bodies (t-1591, shuttle's relay-take).
    // ...and names its house, so a piece can grant this house alone (the secrets piece's requests).
    const role = ['--agent', h.agent, ...(h.service ? ['--service', h.service] : []), '--house', h.id];
    let token;
    try {
      token = effects.mint(role, label);
    } catch (err) {
      // A live token under this house's own label: a mint that was killed after loom wrote it (its caller's timeout,
      // 2026-10-30), so no claim ever got it. The house is still waiting to start, so nothing is using it: revoke it
      // and mint again, once. Anything else, or the same again, fails the claim as before.
      if (!/a live token is already labeled/.test(String(err?.message))) throw err;
      effects.revoke(label);
      token = effects.mint(role, label);
    }
    try {
      const secrets = {};
      for (const [as, from] of Object.entries(a.secrets || {})) {
        // A mapping from before the brokers went (sub:<provider>): nothing is issued; the house file's logins say
        // which of the box's own logins it uses.
        if (SUB_SOURCE.test(from)) continue;
        secrets[as] = effects.secret(from);
      }
      // Which of this box's logins are logged in, by harness: the box's own report.
      const logins = Object.entries(s.boxes[caller.subject].harnesses ?? {}).filter(([, v]) => v.loggedIn).map(([k]) => k);
      const repoAuth = a.repoSecret ? effects.secret(a.repoSecret) : null;
      h.state = 'starting'; h.tokenLabel = label; h.updated = now(effects);
      const key = stateKeyOf(h);
      const saved = key ? stateMeta(env, s, key) : undefined;
      // The state itself comes after, a part at a time (state-part): just its shape here.
      const state = saved ? { bytes: saved.bytes, sha256: saved.sha256, parts: partsOf(saved.bytes) } : null;
      return { id, agent: h.agent, token, secrets, logins, repoAuth, nested: !!a.nested, gpu: !!a.gpu, ports: (a.ports ?? []).map(parsePortGrant).filter(Boolean), tailnets: (a.tailnets ?? []).map(parseTailnetGrant).filter(Boolean), ...(h.service ? { service: h.service } : {}), ...(h.slot ? { slot: h.slot } : {}), ...(key ? { state } : {}) };
    } catch (err) {
      // The house stays waiting; the token it was about to get goes (or is queued to).
      revokeOrQueue(s, effects, label);
      const e = err instanceof StateError ? err : new StateError(`couldn't get ${h.agent}'s house secrets: ${err.message}`, 500);
      // Not forever: a house that can't be claimed MAX_CLAIM_TRIES times running
      // fails, saying why, so whatever asked for it (a wake, a service) sees it.
      h.claimTries = (h.claimTries ?? 0) + 1;
      if (h.claimTries >= MAX_CLAIM_TRIES) {
        h.state = 'failed'; h.updated = now(effects);
        h.log = `the box couldn't claim it ${h.claimTries} times: ${e.message}`;
        if (h.service) serviceHouseEnded(s, h, effects);
      }
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
/** One part of a saved state, as base64: inside loom's 1 MB body cap (src/blobs.mjs). */
export const MAX_STATE_BYTES = Math.ceil(PART_RAW / 3) * 4;

/**
 * A service's saved state, in parts (src/blobs.mjs): a part checked and
 * decoded, or the reason it can't be. Each part is base64 of up to PART_RAW
 * bytes; `parts` is how many there are in all (at most MAX_PARTS).
 */
function checkPart({ state, part = 0, parts = 1 }) {
  if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) fail(`a service's state comes in 1 to ${MAX_PARTS} parts`, 413);
  if (!Number.isInteger(part) || part < 0 || part >= parts) fail(`part ${part} isn't one of ${parts}`);
  if (typeof state !== 'string' || state.length > MAX_STATE_BYTES || !/^[A-Za-z0-9+/=]*$/.test(state)) fail(`each part of a service's state is base64, ${MAX_STATE_BYTES} bytes at most`, 413);
  return { buf: Buffer.from(state, 'base64'), part, parts };
}

/** A part in; once all of them are, the state the service starts from next time. */
function keepPart(env, s, key, from, box, at, { buf, part, parts }) {
  let whole;
  try { whole = putPart(env, key, from, part, parts, buf); } catch (e) { if (e instanceof RangeError) fail("a service's state is 48 MB at most", 413); throw e; }
  if (!whole) return { part, parts, saved: false };
  s.serviceState ??= {};
  const old = s.serviceState[key];
  s.serviceState[key] = { from, box, at, ...whole };
  if (old?.file && old.file !== whole.file) drop(env, old);
  return { part, parts, saved: true, bytes: whole.bytes };
}

/** A service's saved state, moved out of state.json into its own file if it's still an old inline one. */
function stateMeta(env, s, key) {
  const v = s.serviceState?.[key];
  if (v && typeof v.data === 'string') {
    const { data, ...rest } = v;
    s.serviceState[key] = { ...rest, ...putWhole(env, key, v.from ?? 'old', Buffer.from(data, 'base64')) };
  }
  return s.serviceState?.[key];
}
export const serviceKey = (agent, name) => `${agent}/${name}`;
export const slotKey = (agent, slot) => `${agent}/slot:${slot}`;
/** Where a house's state is kept: its service's, its slot's, or nowhere. */
const stateKeyOf = (h) => (h.service ? serviceKey(h.agent, h.service) : h.slot ? slotKey(h.agent, h.slot) : null);

/** Whether this house, now, speaks for that state: a service's current house, or the slot's live holder. */
function speaksFor(s, h) {
  if (!['starting', 'running', 'stopping'].includes(h.state)) return false;
  if (h.service) return s.services?.[serviceKey(h.agent, h.service)]?.house === h.id;
  return !!h.slot;
}

function serviceOf(s, caller, { agent, name }) {
  const a = caller.kind === 'agent' ? caller.agent : agent;
  if (caller.kind === 'agent' && agent && agent !== caller.agent) fail(`this token is ${caller.agent}'s`, 403);
  if (AGENT_NAME.test(a ?? '') && !sees(caller, a)) fail(`${a} isn't one of your agents`, 403);
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
      if (!householdOwner(caller)) fail('forcing a move is the household owner\'s call', 403);
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

/**
 * Restart a service: a hand-off to the box it's already on. Its house stops,
 * and a fresh one starts once it has (never two at once), with no back-off:
 * the owner asked for it. A house not running yet is already a fresh start.
 */
export function serviceRestart(env, effects, caller, body) {
  return update(env, (s) => {
    const { key } = serviceOf(s, caller, body);
    const svc = s.services?.[key];
    if (!svc || svc.want !== 'up') fail(`${key} isn't up`, 404);
    const h = s.houses[svc.house];
    if (!h || TERMINAL.has(h.state) || h.state === 'wanted') return { service: key, house: svc.house, restarting: false };
    svc.moveTo = svc.box;
    if (h.state !== 'stopping') { h.state = 'stopping'; h.updated = now(effects); }
    return { service: key, house: h.id, restarting: true };
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

/** A box saves a service's state when its house stops: a gzipped tarball, in parts. */
export function saveState(env, effects, caller, body) {
  return update(env, (s) => {
    boxOf(s, caller);
    const { id } = body;
    const h = s.houses[id];
    if (!h || h.box !== caller.subject || !stateKeyOf(h)) fail(`no house ${id} with state for this box`, 404);
    // Only the service's current house (or the slot's holder), while it's up,
    // speaks for its state: not one written off by a forced move, not an old one ending late.
    if (!speaksFor(s, h)) fail(`${id} isn't ${h.service ?? h.slot}'s live house any more; its state isn't kept`, 409);
    return keepPart(env, s, stateKeyOf(h), id, caller.subject, now(effects), checkPart(body));
  });
}

/** A box reads part of the state a service house it just claimed starts from. */
export function statePart(env, _effects, caller, { id, part }) {
  return update(env, (s) => {
    boxOf(s, caller);
    const h = s.houses[id];
    if (!h || h.box !== caller.subject || !stateKeyOf(h)) fail(`no house ${id} with state for this box`, 404);
    // Between its claim and its start: the one moment the box needs it.
    if (h.state !== 'starting') fail(`house ${id} is ${h.state}; its state was for starting it`, 409);
    const meta = stateMeta(env, s, stateKeyOf(h));
    if (!meta) fail(`${h.service ?? h.slot} has no saved state`, 404);
    if (!Number.isInteger(part) || part < 0 || part >= partsOf(meta.bytes)) fail(`no part ${part}`, 404);
    return { part, parts: partsOf(meta.bytes), data: readPart(env, meta, part).toString('base64') };
  });
}

/** The owner hands a service its starting state (moving a bridge that ran outside the runtime in), in parts. */
export function seedState(env, effects, body) {
  const { agent, name, slot } = body;
  if (!AGENT_NAME.test(agent ?? '') || !SERVICE_NAME.test(name ?? '')) fail('seed-state takes an agent and a service (or slot) name');
  const part = checkPart(body);
  return update(env, (s) => {
    const key = slot ? slotKey(agent, name) : serviceKey(agent, name);
    const h = slot ? Object.values(s.houses).find((x) => x.agent === agent && x.slot === name && LIVE.has(x.state)) : s.houses[s.services?.[key]?.house];
    if (h && LIVE.has(h.state)) fail(`${key} is in use by ${h.id}: its own state wins; let it end first`, 409);
    return { service: key, ...keepPart(env, s, key, 'seed', null, now(effects), part) };
  });
}

/** The owner reads a service's saved state back (moving a bridge out of the runtime), a part at a time. */
export function savedState(env, { agent, name, part = 0, slot }) {
  return update(env, (s) => {
    const key = slot ? slotKey(agent, name) : serviceKey(agent, name);
    const v = stateMeta(env, s, key);
    if (!v) fail(`no saved state for ${agent}/${name}`, 404);
    if (!Number.isInteger(part) || part < 0 || part >= partsOf(v.bytes)) fail(`no part ${part}`, 404);
    return { service: key, at: v.at, from: v.from, bytes: v.bytes, sha256: v.sha256, part, parts: partsOf(v.bytes), state: readPart(env, v, part).toString('base64') };
  });
}

// ---------------------------------------------------------------- the API

// ------------------------------------------------------------------ box sessions

/**
 * A box session: one Claude Code remote-control session for an agent, run on a
 * box itself (not in a house) and driven from claude.ai/code, brought up when
 * the work needs the machine and taken down after. The owner's alone: it has
 * the box's whole reach. Its name says what it is: "<agent> on <box> (box session)".
 */
const REMOTE_STATES = new Set(['starting', 'running', 'stopped', 'failed']);
const ABS_DIR = /^\/[A-Za-z0-9._\/-]{0,300}$/;
export const remoteName = (agent, box) => `${agent} on ${box} (box session)`;
const remoteView = (agent, r) => ({ agent, box: r.box, dir: r.dir, name: r.name, want: r.want, state: r.state, url: r.url ?? null, since: r.since, error: r.error ?? null });

export function remoteUp(env, effects, { agent, box, dir }) {
  return update(env, (s) => {
    if (!AGENT_NAME.test(agent ?? '')) fail('an agent name is lowercase letters, digits and dashes');
    if (!s.agents[agent]) fail(`${agent} has no house yet: the owner sets its repo on the Boxes page`, 409);
    s.remotes ??= {};
    const prev = s.remotes[agent];
    const b = placeHouse(s, agent, { box: box || prev?.box || undefined }, env);
    if (prev?.want === 'up' && prev.box !== b) fail(`${agent}'s box session is up on ${prev.box}: take it down first`, 409);
    if (prev?.want === 'up') return remoteView(agent, prev);
    const d = dir || (prev?.box === b ? prev.dir : undefined);
    if (!d || !ABS_DIR.test(d) || d.split('/').some((x) => x === '..' || x === '.')) fail('a box session needs the folder it works in on that box: an absolute path');
    s.remotes[agent] = { box: b, dir: d, name: remoteName(agent, boxNameOf(s, b)), want: 'up', state: 'starting', url: null, since: now(effects), error: null };
    return remoteView(agent, s.remotes[agent]);
  });
}

export function remoteDown(env, effects, { agent }) {
  return update(env, (s) => {
    const r = s.remotes?.[agent];
    if (!r || r.want !== 'up') fail(`${agent} has no box session up`, 404);
    r.want = 'down';
    r.since = now(effects);
    return remoteView(agent, r);
  });
}

/** A box says how its session for an agent is: starting, running (with its link), stopped, failed (why). */
export function remoteReport(env, effects, caller, { agent, state, url, error }) {
  return update(env, (s) => {
    boxOf(s, caller);
    const r = s.remotes?.[agent];
    if (!r || r.box !== caller.subject) fail(`no box session for ${agent} on this box`, 404);
    if (!REMOTE_STATES.has(state)) fail('a box session is starting, running, stopped or failed');
    if (url != null && !/^https:\/\/claude\.ai\/code\?environment=env_[A-Za-z0-9]{1,64}$/.test(url)) fail('not a remote-control link');
    r.state = state;
    if (url !== undefined) r.url = url;
    r.error = state === 'failed' ? String(error ?? '').slice(0, 400) : null;
    if (state === 'stopped' || state === 'failed') r.url = null;
    return { ok: true };
  });
}

// ------------------------------------------------------------- model logins (docs/model-accounts.md)
//
// A box reports which harnesses it has and whether each is logged in (the CLI's own status command); the owner
// logs a box in from its page, which runs the CLI's own login on that box (logins.mjs). Only states, a link and a
// one-time code pass through here; no credential does.

const ACCOUNT = /^[a-z]+-[0-9a-f]{10}$/;
const LOGIN_ID = /^l-[0-9a-f]{12}$/;
const LOGIN_TTL_MS = 20 * 60_000;
const WINDOW = /^[0-9]+[hd](_[a-z0-9]+)?$/;
const word = (v, max = 40) => (typeof v === 'string' && /^[A-Za-z0-9 ._()+-]{1,80}$/.test(v) ? v.slice(0, max) : undefined);
const epoch = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e11 ? Math.floor(v) : undefined);

/** A box's harness report, checked: {claude: {installed, loggedIn, method?, plan?, account?}, …}, or null. */
function harnessReport(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const h of LOGIN_NAMES) {
    const r = v[h];
    if (!r || typeof r !== 'object') continue;
    out[h] = { installed: !!r.installed, loggedIn: !!r.installed && !!r.loggedIn,
      ...(word(r.method) ? { method: word(r.method) } : {}), ...(word(r.plan) ? { plan: word(r.plan) } : {}),
      ...(typeof r.account === 'string' && ACCOUNT.test(r.account) ? { account: r.account } : {}) };
  }
  return out;
}
const stamp = (hs, at) => Object.fromEntries(Object.entries(hs).map(([k, v]) => [k, { ...v, checked: at }]));

/** A usage reading, checked: {windows: {"7d": 0.6}, resets: {"7d": epoch}, checked: epoch, plan?, limited?}, or null. */
function readingOf(r) {
  if (!r || typeof r !== 'object') return null;
  const windows = {}, resets = {};
  for (const [w, x] of Object.entries(r.windows && typeof r.windows === 'object' ? r.windows : {}).slice(0, 8)) {
    if (WINDOW.test(w) && typeof x === 'number' && x >= 0 && x <= 1) windows[w] = x;
  }
  for (const [w, x] of Object.entries(r.resets && typeof r.resets === 'object' ? r.resets : {}).slice(0, 8)) if (WINDOW.test(w) && epoch(x)) resets[w] = epoch(x);
  if (!Object.keys(windows).length) return null;
  return { windows, resets, checked: epoch(r.checked) ?? Math.floor(Date.now() / 1000), ...(word(r.plan) ? { plan: word(r.plan) } : {}), ...(r.limited ? { limited: true } : {}) };
}
function usageReport(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const h of LOGIN_NAMES) { const r = readingOf(v[h]); if (r) out[h] = r; }
  return out;
}

/** A box's harnesses, for a list: states only. */
export const harnessesOf = (b) => Object.fromEntries(Object.entries(b.harnesses ?? {}).map(([k, v]) => [k, { installed: !!v.installed, loggedIn: !!v.loggedIn, ...(v.method ? { method: v.method } : {}), ...(v.plan ? { plan: v.plan } : {}), ...(v.account ? { account: v.account } : {}), ...(v.checked ? { checked: v.checked } : {}) }]));

/** A login nobody finished goes, and so does a finished one after a while. */
function expireLogins(s, effects) {
  const t = Date.parse(now(effects));
  for (const [id, l] of Object.entries(s.logins ?? {})) {
    const age = t - Date.parse(l.updated ?? l.created);
    if (age > LOGIN_TTL_MS) {
      if (['done', 'failed'].includes(l.state)) delete s.logins[id];
      else { l.state = 'failed'; l.error = 'No sign-in in time; start again.'; delete l.code; l.updated = now(effects); }
    }
  }
}

/** The owner starts a login on a box: the box runs the CLI's own login there on its next poll. */
export function loginStart(env, effects, { box, harness }) {
  if (!LOGIN_NAMES.includes(harness)) fail(`harness is one of ${LOGIN_NAMES.join(', ')}`);
  return update(env, (s) => {
    const id = resolveBox(s, box);
    const b = s.boxes[id];
    if (b.revoked) fail(`${boxNameOf(s, id)} is revoked`, 409);
    if (b.harnesses && b.harnesses[harness] && !b.harnesses[harness].installed) fail(`${boxNameOf(s, id)} doesn't have ${harness} installed`, 409);
    s.logins ??= {};
    expireLogins(s, effects);
    for (const l of Object.values(s.logins)) {
      if (l.box === id && l.harness === harness && !['done', 'failed'].includes(l.state)) return { id: l.id, box: id, harness, state: l.state, again: true };
    }
    const lid = `l-${randomBytes(6).toString('hex')}`;
    s.logins[lid] = { id: lid, box: id, harness, state: 'wanted', created: now(effects), updated: now(effects) };
    return { id: lid, box: id, harness, state: 'wanted' };
  });
}

/** The owner pastes the code the provider's page showed: it waits here for the box's next poll, then it's gone. */
export function loginCode(env, effects, { id, code }) {
  const c = typeof code === 'string' ? code.trim() : '';
  if (!CODE.test(c)) fail('That doesn\'t look like the code the sign-in page showed.');
  return update(env, (s) => {
    const l = s.logins?.[id];
    if (!LOGIN_ID.test(id ?? '') || !l) fail('That sign-in is gone; start again.', 404);
    if (l.state !== 'waiting' || l.kind !== 'paste-code') fail(`That sign-in isn't waiting for a code (it's ${l.state}).`, 409);
    l.code = c; l.state = 'checking'; l.updated = now(effects);
    return { id, state: l.state };
  });
}

export function loginCancel(env, effects, { id }) {
  return update(env, (s) => {
    const l = s.logins?.[id];
    if (!l) fail('That sign-in is gone.', 404);
    if (!['done', 'failed'].includes(l.state)) { l.state = 'cancel'; delete l.code; l.updated = now(effects); }
    return { id, state: l.state };
  });
}

/** One login, for the page: never its code. */
export function loginView(env, id) {
  const l = load(env).logins?.[id];
  if (!l) return null;
  const { code: _c, ...rest } = l;
  return rest;
}

/** The box says how a login is going: its link (and a device code), then done or failed. */
export function loginReport(env, effects, caller, { id, state, link, userCode, kind, error, harnesses }) {
  if (!['waiting', 'done', 'failed'].includes(state)) fail('a login is waiting, done or failed');
  if (link !== undefined && !(typeof link === 'string' && /^https:\/\/(claude\.com|claude\.ai|auth\.openai\.com)\/\S{1,2000}$/.test(link))) fail('not a sign-in link');
  if (userCode !== undefined && !(typeof userCode === 'string' && /^[A-Z0-9]{4}-[A-Z0-9]{4,5}$/.test(userCode))) fail('not a device code');
  const hs = harnessReport(harnesses);
  return update(env, (s) => {
    const b = boxOf(s, caller);
    const l = s.logins?.[id];
    if (!l || l.box !== caller.subject) fail(`no login ${id} for this box`, 404);
    if (hs) b.harnesses = stamp(hs, now(effects));
    if (['done', 'failed'].includes(l.state)) return { ok: true };
    l.state = state; l.updated = now(effects);
    if (link) l.link = link;
    if (userCode) l.userCode = userCode;
    if (kind === 'paste-code' || kind === 'device') l.kind = kind;
    if (state === 'failed') { l.error = String(error ?? 'it didn\'t work').slice(0, 300); delete l.code; }
    if (state !== 'waiting') delete l.link;
    return { ok: true };
  });
}

/** A box's owner lends it to another member's agents (by name), or takes it back (an empty list). */
export function lendBox(env, effects, { name, agents }) {
  const list = listOf(agents, 'agents', AGENT_NAME, 40);
  return update(env, (s) => {
    const id = resolveBox(s, name);
    if (list.length) s.boxes[id].lentTo = list; else delete s.boxes[id].lentTo;
    return { box: id, name: boxNameOf(s, id), lentTo: list };
  });
}

/** Whose a box is: a member (owners.mjs). Boxes from before owners are the first household owner's. */
export function setBoxOwner(env, effects, { name, owner }) {
  const members = membersOf(env);
  if (!members.some((m) => m.person === owner)) fail(`${owner} isn't a member of this household`);
  return update(env, (s) => {
    const id = resolveBox(s, name);
    s.boxes[id].owner = owner;
    return { box: id, name: boxNameOf(s, id), owner };
  });
}

/**
 * A house tells the runtime how full its account is, from its own harness's run output (logins.mjs: Claude Code's
 * rate_limit_event, Codex's token_count): recorded on the house's box, for that harness's login there.
 */
export function usage(env, effects, caller, { harness, reading }) {
  if (caller.kind !== 'agent' || !caller.house) fail('usage comes from a house', 403);
  if (!LOGIN_NAMES.includes(harness)) fail(`harness is one of ${LOGIN_NAMES.join(', ')}`);
  const r = readingOf(reading);
  if (!r) fail('a reading is {windows: {"7d": 0.6}, resets?, checked?}');
  return update(env, (s) => {
    const h = s.houses[caller.house];
    if (!h || h.agent !== caller.agent || !['starting', 'running'].includes(h.state)) fail('no such house running', 404);
    const b = s.boxes[h.box];
    if (!b) fail('the house\'s box is gone', 404);
    (b.usage ??= {})[harness] = r;
    return { ok: true, box: h.box };
  });
}

const OWNER_ONLY = {
  'add-box': addBox, 'revoke-box': revokeBox, 'may-host': setMayHost, 'set-primary': setPrimary, 'set-agent': setAgent,
  'seed-state': seedState, 'saved-state': (env, _fx, b) => savedState(env, b),
  'remote-up': remoteUp, 'remote-down': remoteDown,
  'login-start': loginStart, 'login-code': loginCode, 'login-cancel': loginCancel, 'box-lend': lendBox, 'box-owner': setBoxOwner,
};
const BOX_ONLY = { hello, poll, claim, report, 'save-state': saveState, 'state-part': statePart, 'remote-report': remoteReport, 'login-report': loginReport };

/** One API call, as loom's piece API hands it over: {caller, path, body} → {status, body}. */
export function api(env, effects, { caller, path, body }) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  try {
    if (!caller || typeof caller.kind !== 'string') fail('no caller', 401);
    // A box with no credential yet, asking to join (loom passes no-token calls only on these paths).
    if (caller.kind === 'stranger') {
      if (path === 'join-request') return { status: 200, body: joinRequest(env, effects, caller, b) };
      if (path === 'join-poll') return { status: 200, body: joinPoll(env, effects, caller, b) };
      fail('a box with no credential can only ask to join', 403);
    }
    if (BOX_ONLY[path]) {
      if (caller.kind !== 'piece' || !BOX_NAME.test(caller.subject ?? '')) fail(`${path} is for boxes`, 403);
      return { status: 200, body: BOX_ONLY[path](env, effects, caller, b) };
    }
    if (caller.kind === 'piece') fail(`a box can't ${path || 'do that'}`, 403);
    if (caller.kind !== 'owner' && caller.kind !== 'agent') fail('not for you', 403);
    if (path === 'up') return { status: 200, body: up(env, effects, caller, b) };
    if (path === 'down') return { status: 200, body: down(env, effects, caller, b) };
    if (path === 'list' || path === '') return { status: 200, body: list(env, caller) };
    if (path === 'usage') return { status: 200, body: usage(env, effects, caller, b) };
    if (path === 'service-up') return { status: 200, body: serviceUp(env, effects, caller, b) };
    if (path === 'service-down') return { status: 200, body: serviceDown(env, effects, caller, b) };
    if (path === 'service-move') return { status: 200, body: serviceMove(env, effects, caller, b) };
    if (OWNER_ONLY[path]) {
      if (!householdOwner(caller)) fail(`${path} is the household owner's`, 403);
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
