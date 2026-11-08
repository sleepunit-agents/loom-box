// One house per steering principal (t-1952): the owner's work in his house, anyone else's in theirs, an unknown
// principal's in a house of that conversation alone. A body in one principal's house can't use another's run key or
// session; a principal that changes reseats the body; the houses for other people are capped, and at the cap a body
// waits instead of sharing one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, setAgent } from '../src/control.mjs';
import { startBody } from '../src/bodies.mjs';
import { runBodyHost } from '../src/bodyhost.mjs';
import { deliver, loadConv, resetPrincipal, tick } from '../src/delivery.mjs';
import { HouseRunner, hostOf, seatRoom, sweepSeats } from '../src/houserunner.mjs';
import { setModels } from '../src/models.mjs';
import { seatOf } from '../src/principal.mjs';
import { ageSealer } from '../src/sealed.mjs';
import { load, update } from '../src/state.mjs';
import { scratch } from './scratch.mjs';
import { cvOf, hasAge, sleep, until, world } from './delivery-world.mjs';
import { staticAccounts } from '../src/accounts.mjs';

/** A household whose owner is jonathan (owners.mjs): his word is the owner's. */
function household(env) {
  const dir = join(env.HOME, '.config', 'loom');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }] }));
  return env;
}

const person = (slug) => ({ from: { kind: 'person', slug } });
const keyOf = (w, cv) => w.runner.envs[loadConv(w.env, cv).body.split(':')[1]].LOOM_BODY_KEY;
const fx = { now: () => new Date() };

test('a seat is the principal\'s: the owner\'s, one person\'s, or (anything else) that conversation\'s alone', () => {
  assert.equal(seatOf({ for: 'jonathan', owner: true }, 'cv-000000000001'), 'owner');
  assert.equal(seatOf({ for: null, owner: true }, 'cv-000000000001'), 'owner', 'several owners are still the owner');
  assert.equal(seatOf({ for: 'loren', owner: false }, 'cv-000000000001'), 'p-loren');
  // Unknown, several people, nothing heard: never shared, never the owner's.
  assert.equal(seatOf({ for: null, owner: false, unknown: true }, 'cv-000000000001'), 'u-cv-000000000001');
  assert.equal(seatOf({ for: null, owner: false, people: ['loren', 'daniel'] }, 'cv-000000000002'), 'u-cv-000000000002');
  assert.equal(seatOf({ for: null, owner: false, people: [] }, 'cv-000000000003'), 'u-cv-000000000003');
  assert.throws(() => seatOf({ for: null, owner: false }, 'nope'));
});

test('a body in one principal\'s house can\'t speak, ask its principal, or ask its place with another\'s run key and session', async () => {
  const w = world();
  household(w.env);
  w.runner.houses = { owner: 'h-1', 'p-loren': 'h-2' };
  await deliver(w.env, w.msg('dm:J', 'ship it', person('jonathan')), w.o);
  await deliver(w.env, w.msg('dm:L', 'can you look at on-pond 220?', person('loren')), w.o);
  const J = cvOf('art', 'slack', 'dm:J');
  const L = cvOf('art', 'slack', 'dm:L');
  const [bj, bl] = [loadConv(w.env, J), loadConv(w.env, L)];
  // Seated by principal: Jonathan's in his house, Loren's in hers.
  assert.deepEqual([w.runner.seats[bj.body.split(':')[1]], w.runner.seats[bl.body.split(':')[1]]], ['owner', 'p-loren']);
  assert.deepEqual([bj.bodyRules.seat, bl.bodyRules.seat], ['owner', 'p-loren']);

  // Loren's body, set on posing as Jonathan's: it somehow has his conversation's key and session. From her house
  // (core names the caller's house from its token), every proof is refused.
  const stolen = { conversation: J, key: keyOf(w, J), session: w.sessionFor(J) };
  const fromLoren = { kind: 'agent', agent: 'art', house: 'h-2' };
  const sent = await api(w.env, fx, { caller: fromLoren, path: 'send', body: { ...stolen, text: 'merged, as Jonathan asked' } });
  assert.equal(sent.status, 409);
  assert.match(sent.body.reason, /h-2 isn't its body's house/);
  const who = await api(w.env, fx, { caller: fromLoren, path: 'principal', body: stolen });
  assert.equal(who.status, 409);
  assert.equal(who.body.statement, undefined, 'no statement of the owner\'s for her house');
  const place = await api(w.env, fx, { caller: fromLoren, path: 'run', body: { argv: ['place', '--conversation', J], key: stolen.key, session: stolen.session } });
  assert.notEqual(place.body.exit, 0);
  // The relay's return address (relay.mjs, originOf) takes the same proof: her house never claims his conversation.
  const { originOf } = await import('../src/relay.mjs');
  assert.throws(() => originOf(w.env, fromLoren, J, { key: stolen.key, session: stolen.session }), /held by a body in your house/);
  // Nor a caller with no house at all (an agent token outside every house), for a house body.
  const none = await api(w.env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'principal', body: stolen });
  assert.equal(none.status, 409);

  // His own body, in his house, with the same proof: answered.
  const own = await api(w.env, fx, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: 'principal', body: stolen });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.owner, true);
  // And hers, in hers.
  const hers = await api(w.env, fx, { caller: fromLoren, path: 'principal', body: { conversation: L, key: keyOf(w, L), session: w.sessionFor(L) } });
  assert.deepEqual([hers.status, hers.body.for], [200, 'loren']);
});

test('a principal that changes reseats the body in the right house: never fed where it was; its own session goes with it', async () => {
  const w = world();
  household(w.env);
  w.runner.houses = { owner: 'h-1', 'p-loren': 'h-2' };
  const J = cvOf('art', 'slack', 'group:G');
  await deliver(w.env, w.msg('group:G', 'here is the plan', person('jonathan')), w.o);
  const first = loadConv(w.env, J).body;
  assert.equal(w.runner.seats[first.split(':')[1]], 'owner');
  // Mid-turn, Loren writes into the owner's place: the body in his house is ended, and the conversation resumes in hers.
  const n = w.log.length;
  await deliver(w.env, w.msg('group:G', 'and merge mine too', person('loren')), w.o);
  const after = w.log.slice(n);
  assert.ok(after.some((l) => l[0] === 'end' && l[1] === first.split(':')[1]), 'the owner\'s body is ended');
  assert.equal(after.some((l) => l[0] === 'feed'), false, 'her message is never fed to the body in his house');
  const second = loadConv(w.env, J).body;
  assert.notEqual(second, first);
  assert.equal(w.runner.seats[second.split(':')[1]], 'p-loren');
  // The conversation's own session goes with it (it's this conversation's, which she's now steering); nothing of any
  // other conversation's does. Her message is in the resumed body's brief.
  const resumed = after.find((l) => l[0] === 'resume');
  assert.ok(resumed, 'resumed from its own slot, in her house');
  assert.match(resumed[4], /merge mine too/);

  // The owner says it's his again (--reset), and writes: back to his house, the same way.
  w.runner.finish(second);
  assert.equal(resetPrincipal(w.env, J).ok, true);
  const m = w.log.length;
  await deliver(w.env, w.msg('group:G', 'mine from here', person('jonathan')), w.o);
  const third = loadConv(w.env, J).body;
  assert.notEqual(third, second);
  assert.equal(w.runner.seats[third.split(':')[1]], 'owner');
  assert.equal(w.log.slice(m).some((l) => l[0] === 'feed'), false, 'nothing fed in her house');

  // A slot from one seat isn't resumed in another: an evicted owner's body leaves a slot; then Loren writes.
  const K = cvOf('art', 'slack', 'group:K');
  await deliver(w.env, w.msg('group:K', 'one', person('jonathan')), w.o);
  w.runner.finish(loadConv(w.env, K).body);
  await tick(w.env, w.o);
  w.clock.advance(11 * 60_000);
  await tick(w.env, w.o);
  assert.ok(loadConv(w.env, K).slot, 'evicted with a slot');
  assert.equal(loadConv(w.env, K).slot.rules.seat, 'owner');
  const k = w.log.length;
  await deliver(w.env, w.msg('group:K', 'two', person('loren')), w.o);
  assert.ok(w.log.slice(k).some((l) => l[0] === 'resume'), 'its slot resumes where its principal is now');
  assert.equal(w.runner.seats[loadConv(w.env, K).body.split(':')[1]], 'p-loren');
});

test('houses for other people are capped per agent: at the cap a body waits (the owner\'s never does), and starts once one idles out', async () => {
  const w = world({ LOOM_RUNTIME_SEAT_HOUSES: '1' });
  household(w.env);
  w.runner.houses = { owner: 'h-1', 'p-loren': 'h-2', 'p-dana': 'h-5' };
  setAgent(w.env, fx, { agent: 'art', repo: 'https://example.com/art.git' });
  // Dana's house is up, at work.
  update(w.env, (s) => { s.houses['h-5'] = { id: 'h-5', agent: 'art', kind: 'body-host', seat: 'p-dana', state: 'running', task: 'loom-runtime body-host --piece box --host-key x' }; });
  assert.match(seatRoom(w.env, 'art', 'p-loren'), /already has 1 house at work for other people \(the cap is 1/);
  assert.equal(seatRoom(w.env, 'art', 'owner'), null);
  assert.equal(seatRoom(w.env, 'art', 'p-dana'), null, 'a seat whose house is up is in it (its record names it)', );
  const L = cvOf('art', 'slack', 'dm:L');
  const out = await deliver(w.env, w.msg('dm:L', 'hello?', person('loren')), w.o);
  assert.equal(out.body, 'queued');
  assert.match(out.reason, /the cap is 1/);
  assert.equal(loadConv(w.env, L).body, undefined, 'no body, and none sharing Dana\'s house');
  assert.equal(w.kinds().includes('start'), false);
  // The owner's work is never held by the cap.
  await deliver(w.env, w.msg('dm:J', 'ping', person('jonathan')), w.o);
  assert.ok(loadConv(w.env, cvOf('art', 'slack', 'dm:J')).body);
  // Dana's house idles out: the next tick starts Loren's body, in her own house.
  update(w.env, (s) => { s.houses['h-5'].state = 'stopped'; });
  await tick(w.env, w.o);
  const b = loadConv(w.env, L).body;
  assert.ok(b);
  assert.equal(w.runner.seats[b.split(':')[1]], 'p-loren');
});

test('in houses: each seat gets its own house, and a house\'s host is handed only its own seat\'s bodies', { skip: !hasAge && 'age isn\'t installed' }, async () => {
  const D = scratch('rt-perhouse-');
  const env = { PATH: process.env.PATH, HOME: D, LOOM_HOME: join(D, 'loomhome'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_DATA: join(D, 'data'), LOOM_RUNTIME_SCORECARDS: 'off' };
  mkdirSync(env.LOOM_HOME, { recursive: true });
  const sealer = ageSealer(env, join(env.LOOM_BOX_DATA, 'delivery'));
  setAgent(env, fx, { agent: 'art', repo: 'https://example.com/art.git' });
  update(env, (s) => { const k = Object.keys(s.boxes).find((x) => s.boxes[x].local); s.boxes[k].harnesses = { claude: { loggedIn: true } }; });
  setModels(env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }], agent: 'art', prefer: ['opus'] });
  const accounts = staticAccounts({ accounts: [{ name: 'max', provider: 'anthropic', harness: 'claude', kind: 'login', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage: {} }] });
  const hr = new HouseRunner(env, 'claude', { poll: 10, sealer, claimMs: 5000, warmMs: 5000 });
  // Each house is its own container: its own home (keys dir), its own runner and its own record of what it started.
  const houses = {};
  const hostIn = (house) => {
    const home = join(D, house);
    mkdirSync(home, { recursive: true });
    const started = [];
    const st = {};
    let n = 0;
    const local = {
      harness: 'claude', roots: { sess: home }, envs: {},
      inbox: { pending: () => [], taken: () => [], close() {}, remove() {} },
      async start(o) { const id = `b${house.slice(2)}00000${n++}`; st[id] = 'working'; started.push({ id, key: o.env?.LOOM_BODY_KEY, brief: o.brief }); return { id, harness: 'claude' }; },
      status: (b) => st[b.id] ?? 'unknown', slotOf: (b) => ({ harness: 'claude', session: `s-${b.id}` }),
      feed() { return { fed: true }; }, end(b) { st[b.id] = 'ended'; },
      sessionFiles: () => ({ keep: [], drop: [] }),
    };
    const client = async (p, b) => { const r = await api(env, fx, { caller: { kind: 'agent', agent: 'art', house }, path: p, body: b }); if (r.status !== 200) throw new Error(r.body.error); return r.body; };
    const hostKey = /--host-key ([0-9a-f]{48})/.exec(load(env).houses[house]?.task ?? '')?.[1];
    houses[house] = { started, home, done: runBodyHost({ client, runner: () => local, env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/run/loom/login/claude', PATH: '/usr/bin', HOME: home }, hostKey, sleep: () => sleep(10), beats: 400, idleS: 0 }) };
  };
  const startIn = async (seat, conversation, house) => {
    const p = startBody(env, { agent: 'art', venue: 'slack', brief: `for ${seat}`, seat }, { runner: () => hr, accounts, bodyEnv: { LOOM_BODY_KEY: `key-of-${seat}`, LOOM_BODY_CONVERSATION: conversation } });
    await until(() => load(env).houses[house]);
    hostIn(house);
    return p;
  };
  const a = await startIn('owner', 'cv-00000000000a', 'h-1');
  const b = await startIn('p-loren', 'cv-00000000000b', 'h-2');
  assert.deepEqual([a.house, a.seat, b.house, b.seat], ['h-1', 'owner', 'h-2', 'p-loren']);
  // Two houses, each marked with its seat for the owner's listing.
  assert.deepEqual(['h-1', 'h-2'].map((h) => load(env).houses[h].seat), ['owner', 'p-loren']);
  // The owner's record is <agent>.json as always; hers is her seat's own.
  assert.equal(hostOf(env, 'art').house, 'h-1');
  assert.equal(hostOf(env, 'art', 'p-loren').house, 'h-2');
  // Each house's host was handed only its own seat's body: its key never reached the other house.
  assert.deepEqual(houses['h-1'].started.map((x) => x.key), ['key-of-owner']);
  assert.deepEqual(houses['h-2'].started.map((x) => x.key), ['key-of-p-loren']);
  // Each conversation's key file is in its own house's home (bodyhost.mjs, keyFile), never the other's.
  const keys = (h) => { try { return readdirSync(join(houses[h].home, '.local', 'state', 'loom-runtime', 'keys')); } catch { return []; } };
  assert.deepEqual([keys('h-1'), keys('h-2')], [['cv-00000000000a.key'], ['cv-00000000000b.key']]);
  // Status and feeding go through the body's own seat's record.
  const ref = (x) => ({ id: x.body.split(':')[1], agent: 'art', house: x.house, seat: x.seat, harness: 'claude' });
  await until(() => hr.status(ref(a)) === 'working' && hr.status(ref(b)) === 'working');
  // A third seat at a cap of one other house: refused at the house, never seated in hers.
  env.LOOM_RUNTIME_SEAT_HOUSES = '1';
  await assert.rejects(startBody(env, { agent: 'art', venue: 'slack', brief: 'x', seat: 'u-cv-00000000000c' }, { runner: () => hr, accounts, bodyEnv: { LOOM_BODY_KEY: 'k', LOOM_BODY_CONVERSATION: 'cv-00000000000c' } }), /the cap is 1/);
  assert.equal(load(env).houses['h-3'], undefined);
  hr.end(ref(a)); hr.end(ref(b));
  await Promise.all(Object.values(houses).map((h) => h.done));
  // Her house over, her seat's record goes; the owner's stays.
  update(env, (s) => { s.houses['h-2'].state = 'stopped'; });
  sweepSeats(env);
  assert.equal(existsSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art@p-loren.json')), false);
  assert.equal(existsSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art.json')), true);
});
