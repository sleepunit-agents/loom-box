// Scopes (t-1963, t-1964): a secret or tailnet the owner scopes goes only to the houses whose work may have it. The
// owner's own work gets everything; a person's, what's scoped to the projects the owner lets them steer; anyone
// loom can't name, only what isn't scoped. Withheld things are named to the box, which starts the house without them.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, claim, housePrincipal, inScope, up } from '../src/control.mjs';
import { load } from '../src/state.mjs';
import { withoutWithheld } from '../src/house.mjs';
import { scratch } from './scratch.mjs';

let env, fx;
const owner = { kind: 'owner' };
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const local = () => ({ kind: 'piece', subject: 'one' });

const ART = {
  agent: 'art', repo: 'https://github.com/x/art.git',
  secrets: { 'github-token': 'gh-art', 'discord-token': 'discord', 'pond-dev-service-token': 'pond-dev', 'alert-mention': 'alert-mention' },
  tailnets: ['fleet=/run/tailscale-fleet/tailscaled.sock'],
  scopes: ['github-token=owner', 'discord-token=owner', 'pond-dev-service-token=pond', 'tailnet:fleet=pond'],
  steers: ['patrick=pond'],
};

beforeEach(() => {
  env = { HOME: scratch('loom-box-scopes-'), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.XDG_RUNTIME_DIR = join(env.HOME, 'run');
  // The household: Jonathan owns everything; nobody else owns art (a former co-owner is a person like any other).
  mkdirSync(join(env.HOME, '.config', 'loom'), { recursive: true });
  writeFileSync(join(env.HOME, '.config', 'loom', 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }] }));
  let n = 0;
  fx = { now: () => new Date('2026-11-09T03:00:00Z'), mint: () => `loom_${'t'.repeat(30)}${n++}`, revoke: () => {}, secret: (name) => `value-of-${name}` };
  ok(call(owner, 'set-agent', ART));
});

/** A house for whose work, claimed by loom's own box: what it's given. */
function claimFor(own) {
  const h = up(env, fx, { kind: 'owner' }, { agent: 'art', task: own.kind === 'body-host' ? 'loom-runtime body-host --piece runtime --host-key k' : 'a task' }, own);
  return claim(env, fx, local(), { id: h.id, nativeHistory: 1 });
}

test('the owner\'s seat gets everything; a person\'s, their project\'s; an unknown one, only what isn\'t scoped', () => {
  const mine = claimFor({ kind: 'body-host', seat: 'owner' });
  assert.deepEqual(Object.keys(mine.secrets).sort(), ['alert-mention', 'discord-token', 'github-token', 'pond-dev-service-token']);
  assert.deepEqual(mine.tailnets.map((g) => g.name), ['fleet']);
  assert.equal(mine.withheld, undefined);

  const patrick = claimFor({ kind: 'body-host', seat: 'p-patrick' });
  assert.deepEqual(Object.keys(patrick.secrets).sort(), ['alert-mention', 'pond-dev-service-token']);
  assert.deepEqual(patrick.tailnets.map((g) => g.name), ['fleet']);
  assert.deepEqual(patrick.withheld, { secrets: ['github-token', 'discord-token'], tailnets: [] });

  for (const seat of ['p-loren', 'u-cv-0123456789ab']) {
    const guest = claimFor({ kind: 'body-host', seat });
    assert.deepEqual(Object.keys(guest.secrets), ['alert-mention'], seat);
    assert.deepEqual(guest.tailnets, [], seat);
    assert.deepEqual(guest.withheld, { secrets: ['github-token', 'discord-token', 'pond-dev-service-token'], tailnets: ['fleet'] }, seat);
  }
});

test('a task house is whose its taskActsFor says, and a record that can\'t say is unknown', () => {
  const s = { agents: {}, houses: {} };
  const task = (actsFor) => housePrincipal(s, { task: 'x', taskActsFor: actsFor }, env);
  assert.deepEqual(task({ owner: true, people: [], unknown: false }), { owner: true });
  assert.deepEqual(task({ owner: false, people: ['patrick'], unknown: false }), { person: 'patrick' });
  // The owner and Patrick both spoke: Patrick's, by the runtime's own rule (principalOf), never the owner's.
  assert.deepEqual(task({ owner: true, people: ['patrick'], unknown: false }), { person: 'patrick' });
  // Two people, anything unplaced, or nothing kept: unknown.
  for (const p of [{ owner: false, people: ['a', 'b'], unknown: false },
    { owner: true, people: [], unknown: true }, { owner: true, people: [] }, undefined, { owner: false, people: [], unknown: false }]) {
    assert.deepEqual(task(p), { unknown: true }, JSON.stringify(p));
  }
  // A house the owner asked for himself is his; an agent's own request for another is unknown (control.mjs up).
  const viaOwner = claimFor({});
  assert.equal(Object.keys(viaOwner.secrets).length, 4);
  const h = ok(call({ kind: 'agent', agent: 'art' }, 'up', { task: 'x' }));
  const viaAgent = claim(env, fx, local(), { id: h.id, nativeHistory: 1 });
  assert.deepEqual(Object.keys(viaAgent.secrets), ['alert-mention']);
  // owner can't be granted to anyone, and a project's scope never reaches someone not let steer it.
  const a = { steers: { patrick: ['pond'] } };
  assert.equal(inScope(a, { person: 'patrick' }, 'owner'), false);
  assert.equal(inScope(a, { person: 'patrick' }, 'jack-game'), false);
  assert.equal(inScope(a, { unknown: true }, 'pond'), false);
  assert.equal(inScope(a, { unknown: true }, undefined), true);
});

test('scopes are the owner\'s: kept when not given, checked against what the agent has, and never given to owner', () => {
  // Saved again without them (an older page, a CLI call that doesn't name them): kept, never dropped (that would widen).
  ok(call(owner, 'set-agent', { ...ART, scopes: undefined, steers: undefined }));
  assert.equal(load(env).agents.art.scopes['pond-dev-service-token'], 'pond');
  assert.deepEqual(load(env).agents.art.steers, { patrick: ['pond'] });
  // A scope for something the agent doesn't get is refused (a typo would leave the real one unscoped).
  assert.equal(call(owner, 'set-agent', { ...ART, scopes: ['pond-token=pond'] }).status, 400);
  assert.equal(call(owner, 'set-agent', { ...ART, scopes: ['tailnet:other=pond'] }).status, 400);
  assert.equal(call(owner, 'set-agent', { ...ART, steers: ['patrick=owner'] }).status, 400);
  assert.equal(call(owner, 'set-agent', { ...ART, steers: ['owner=pond'] }).status, 400);
  // none clears; only the household owner sets them at all.
  ok(call(owner, 'set-agent', { ...ART, scopes: 'none', steers: 'none' }));
  assert.deepEqual([load(env).agents.art.scopes, load(env).agents.art.steers], [undefined, undefined]);
  assert.notEqual(call({ kind: 'agent', agent: 'art' }, 'set-agent', ART).status, 200);
  assert.notEqual(call({ kind: 'owner', agents: ['art'] }, 'set-agent', ART).status, 200);
});

test('a service is its own principal: only what\'s scoped to it by name, and a body can\'t widen that', () => {
  // A service house (a chat bridge, people other than the owner steer it; any body may ask for one): unscoped things,
  // and what the owner scoped to that service by name.
  ok(call(owner, 'set-agent', { ...ART, scopes: ['github-token=owner+service:jobs', 'discord-token=owner', 'pond-dev-service-token=pond+service:jobs', 'tailnet:fleet=pond'] }));
  const s = load(env);
  assert.deepEqual(housePrincipal(s, { service: 'discord', task: null }, env), { service: 'discord' });
  const a = s.agents.art;
  assert.equal(inScope(a, { service: 'jobs' }, a.scopes['github-token']), true);
  assert.equal(inScope(a, { service: 'discord' }, a.scopes['github-token']), false);
  assert.equal(inScope(a, { service: 'jobs' }, a.scopes['tailnet:fleet']), false);
  // service:… never reaches a person, and owner never does.
  assert.equal(inScope({ steers: { jobs: ['pond'] } }, { person: 'jobs' }, 'service:jobs'), false);
  assert.equal(inScope({ steers: { constructor: ['pond'] } }, { person: 'toString' }, 'pond'), false);
  assert.equal(inScope({}, { person: 'constructor' }, 'pond'), false);
});

test('a job\'s seat is its house\'s; a body host that can\'t say whose is unknown', () => {
  const s = { agents: {}, houses: { 'h-7': { id: 'h-7', task: 'x', taskActsFor: { owner: true, people: [], unknown: false } },
    'h-8': { id: 'h-8', task: 'x', taskActsFor: { owner: false, people: [], unknown: true } } } };
  const host = (seat) => ({ kind: 'body-host', ...(seat ? { seat } : {}) });
  assert.deepEqual(housePrincipal(s, host('j-h-7'), env), { owner: true });
  assert.deepEqual(housePrincipal(s, host('j-h-8'), env), { unknown: true });
  assert.deepEqual(housePrincipal(s, host('j-h-9'), env), { unknown: true });
  assert.deepEqual(housePrincipal(s, host(), env), { unknown: true });
  // The real shape: the task house itself becomes the job's body host, its seat naming itself (taskhost.mjs).
  const self = { id: 'h-7', kind: 'body-host', seat: 'j-h-7', task: 'x', taskActsFor: { owner: true, people: [], unknown: false } };
  assert.deepEqual(housePrincipal({ agents: {}, houses: { 'h-7': self } }, self, env), { owner: true });
  // Another house's seat that is itself a body host: unknown.
  const other = { id: 'h-9', kind: 'body-host', seat: 'j-h-7' };
  assert.deepEqual(housePrincipal({ agents: {}, houses: { 'h-7': { ...self, seat: 'owner' }, 'h-9': other } }, other, env), { unknown: true });
});

test('a scope outlives its secret, two names for one secret are scoped alike, and a blank form keeps them', () => {
  const { 'pond-dev-service-token': _p, ...rest } = ART.secrets;
  ok(call(owner, 'set-agent', { ...ART, secrets: rest, scopes: undefined }));
  // Added back without naming a scope: it comes back scoped, never to every house.
  ok(call(owner, 'set-agent', { ...ART, scopes: undefined }));
  assert.equal(load(env).agents.art.scopes['pond-dev-service-token'], 'pond');
  assert.equal(claimFor({ kind: 'body-host', seat: 'p-loren' }).secrets['pond-dev-service-token'], undefined);
  // The same stored secret under another name: refused unless scoped alike.
  const twin = { ...ART.secrets, 'gh-ro': 'gh-art' };
  assert.equal(call(owner, 'set-agent', { ...ART, secrets: twin, scopes: undefined }).status, 400);
  ok(call(owner, 'set-agent', { ...ART, secrets: twin, scopes: [...ART.scopes, 'gh-ro=owner'] }));
  // The page's form sends blank fields: nothing changes. Only none clears.
  ok(call(owner, 'set-agent', { ...ART, scopes: '', steers: '' }));
  // Only the household owner sets them: not the agent, not an agent's owner.
  assert.notEqual(call({ kind: 'agent', agent: 'art' }, 'set-agent', { ...ART, scopes: 'none' }).status, 200);
  assert.notEqual(call({ kind: 'owner', agents: ['art'] }, 'set-agent', { ...ART, scopes: 'none' }).status, 200);
  assert.equal(load(env).agents.art.scopes['github-token'], 'owner');
  assert.deepEqual(load(env).agents.art.steers, { patrick: ['pond'] });
});

test('a task is read by today\'s owners: a former co-owner\'s words are a person\'s', () => {
  const s = { agents: {}, houses: {} };
  const task = (actsFor) => housePrincipal(s, { agent: 'art', task: 'x', taskActsFor: actsFor }, env);
  assert.deepEqual(task({ owner: true, owners: ['jonathan'], people: [], unknown: false }), { owner: true });
  assert.deepEqual(task({ owner: true, owners: ['mark'], people: [], unknown: false }), { person: 'mark' });
  assert.deepEqual(task({ owner: true, owners: ['mark', 'jonathan'], people: [], unknown: false }), { person: 'mark' });
});

test('nothing silently drops a scope: null or empty from the API, a rename, a second name for a tailnet', () => {
  for (const v of [null, [], {}]) {
    ok(call(owner, 'set-agent', { ...ART, scopes: v, steers: v }));
    assert.equal(load(env).agents.art.scopes['github-token'], 'owner', JSON.stringify(v));
    assert.deepEqual(load(env).agents.art.steers, { patrick: ['pond'] });
  }
  // github-token renamed github: the same store, so the scope must come along.
  const { 'github-token': gh, ...rest } = ART.secrets;
  assert.equal(call(owner, 'set-agent', { ...ART, secrets: { ...rest, github: gh }, scopes: undefined }).status, 400);
  ok(call(owner, 'set-agent', { ...ART, secrets: { ...rest, github: gh }, scopes: [...ART.scopes, 'github=owner'] }));
  // Two tailnet names on one socket: scoped alike, or refused.
  assert.equal(call(owner, 'set-agent', { ...ART, tailnets: [...ART.tailnets, 'fleet2=/run/tailscale-fleet/tailscaled.sock'], scopes: undefined }).status, 400);
});

test('the box starts a house without what was withheld, and only that', () => {
  const house = { secrets: { 'github-token': { file: 'github-token' }, 'pond-dev-service-token': { file: 'p' }, x: { env: 'X' } }, tailnets: { fleet: '/run/f.sock' }, env: {} };
  const said = [];
  const narrowed = withoutWithheld(house, { secrets: ['pond-dev-service-token', 'not-in-file'], tailnets: ['fleet'] }, (w) => said.push(w));
  assert.deepEqual(Object.keys(narrowed.secrets), ['github-token', 'x']);
  assert.deepEqual(narrowed.tailnets, {});
  assert.deepEqual(said, ['secret pond-dev-service-token, tailnet fleet']);
  assert.equal(withoutWithheld(house, undefined), house);
  assert.equal(withoutWithheld(house, { secrets: 'github-token' }), house);
});
