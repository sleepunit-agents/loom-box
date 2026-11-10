// One house per conversation (t-1952, t-2061): the owner's work, a person's or an unknown principal's, each in a house
// of that conversation alone. A body in one house can't use another's run key or session, even the same principal's;
// a principal that changes reseats the body; the houses for other people are capped, and at the cap a body waits
// instead of sharing one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, setAgent } from '../src/control.mjs';
import { startBody } from '../src/bodies.mjs';
import { runBodyHost } from '../src/bodyhost.mjs';
import { deliver, loadConv, resetPrincipal, tick } from '../src/delivery.mjs';
import { HouseRunner, hostOf, seatRoom, sweepSeats } from '../src/houserunner.mjs';
import { setModels } from '../src/models.mjs';
import { seatOf, otherSeatHouses } from '../src/principal.mjs';
import { ageSealer } from '../src/sealed.mjs';
import { load, update } from '../src/state.mjs';
import { scratch } from './scratch.mjs';
import { cvOf, hasAge, here, sleep, until, world } from './delivery-world.mjs';
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
// The fake runner's houses by whose work a seat is: each conversation's seat (`owner.cv-…`, `p-loren.cv-…`) to the
// house a test names for its principal, so a test about two principals reads as before.
const byWhom = (m) => new Proxy({}, { get: (_, k) => (typeof k === 'string' ? m[k] ?? m[k.replace(/\.cv-[0-9a-f]{12}$/, '')] : undefined) });

test('a seat is its conversation\'s alone, and says whose: the owner\'s, one person\'s, or (anything else) unknown', () => {
  assert.equal(seatOf({ for: 'jonathan', owner: true }, 'cv-000000000001'), 'owner.cv-000000000001');
  assert.equal(seatOf({ for: null, owner: true }, 'cv-000000000001'), 'owner.cv-000000000001', 'several owners are still the owner');
  assert.equal(seatOf({ for: 'loren', owner: false }, 'cv-000000000001'), 'p-loren.cv-000000000001');
  assert.notEqual(seatOf({ owner: true }, 'cv-000000000001'), seatOf({ owner: true }, 'cv-000000000002'), 'two of his conversations never share one');
  // Unknown, several people, nothing heard: never shared, never the owner's.
  assert.equal(seatOf({ for: null, owner: false, unknown: true }, 'cv-000000000001'), 'u-cv-000000000001');
  assert.equal(seatOf({ for: null, owner: false, people: ['loren', 'daniel'] }, 'cv-000000000002'), 'u-cv-000000000002');
  assert.equal(seatOf({ for: null, owner: false, people: [] }, 'cv-000000000003'), 'u-cv-000000000003');
  assert.throws(() => seatOf({ for: null, owner: false }, 'nope'));
  assert.throws(() => seatOf({ owner: true }, 'nope'), 'the owner\'s too is a conversation\'s');
});

test('a body in one principal\'s house can\'t speak, ask its principal, or ask its place with another\'s run key and session', async () => {
  const w = world();
  household(w.env);
  w.runner.houses = byWhom({ owner: 'h-1', 'p-loren': 'h-2' });
  await deliver(w.env, w.msg('dm:J', 'ship it', person('jonathan')), w.o);
  await deliver(w.env, w.msg('dm:L', 'can you look at on-pond 220?', person('loren')), w.o);
  const J = cvOf('art', 'slack', 'dm:J');
  const L = cvOf('art', 'slack', 'dm:L');
  const [bj, bl] = [loadConv(w.env, J), loadConv(w.env, L)];
  // Seated by principal: Jonathan's in his house, Loren's in hers.
  assert.deepEqual([w.runner.seats[bj.body.split(':')[1]], w.runner.seats[bl.body.split(':')[1]]], [`owner.${J}`, `p-loren.${L}`]);
  assert.deepEqual([bj.bodyRules.seat, bl.bodyRules.seat], [`owner.${J}`, `p-loren.${L}`]);

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
  assert.match(JSON.stringify(place.body), /only the body holding/);
  // From his own house the same proof answers where it is: it's the house that was refused, nothing else.
  const placeOwn = await api(w.env, fx, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: 'run', body: { argv: ['place', '--conversation', J], key: stolen.key, session: stolen.session } });
  assert.equal(placeOwn.body.exit, 0, JSON.stringify(placeOwn.body));
  // Nor does a body learn from the house listing whose work its agent's other houses are for.
  setAgent(w.env, fx, { agent: 'art', repo: 'https://example.com/art.git' });
  update(w.env, (s) => { s.houses['h-2'] = { id: 'h-2', agent: 'art', kind: 'body-host', seat: `p-loren.${L}`, state: 'running', task: 'loom-runtime body-host --piece box --host-key x' }; });
  const listed = await api(w.env, fx, { caller: fromLoren, path: 'list', body: {} });
  assert.equal(JSON.stringify(listed.body.houses).includes('p-loren'), false);
  const owners = await api(w.env, fx, { caller: { kind: 'owner' }, path: 'list', body: {} });
  assert.equal(owners.body.houses.find((h) => h.id === 'h-2').seat, `p-loren.${L}`, 'the owner reads it');
  // The relay's return address (relay.mjs, originOf) takes the same proof: her house never claims his conversation.
  const { originOf } = await import('../src/relay.mjs');
  assert.throws(() => originOf(w.env, fromLoren, J, { key: stolen.key, session: stolen.session }), /held by a body in your house/);
  // Nor a caller with no house at all (an agent token outside every house), for a house body: not for its principal,
  // and not as a relay's return address (there no older check stands in front: a houseless caller is eligible).
  const none = await api(w.env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'principal', body: stolen });
  assert.equal(none.status, 409);
  const { holdsRun } = await import('../src/delivery.mjs');
  assert.equal(holdsRun(w.env, J, stolen, { ...w.o, caller: { kind: 'agent', agent: 'art' } }), false);
  assert.equal(holdsRun(w.env, J, stolen, { ...w.o, caller: fromLoren }), false);
  assert.equal(holdsRun(w.env, J, stolen, { ...w.o, caller: { kind: 'agent', agent: 'art', house: 'h-1' } }), true);
  // Refused outright, however many conversations are at work: a houseless caller holds no house body's conversation.
  assert.throws(() => originOf(w.env, { kind: 'agent', agent: 'art' }, J, { key: stolen.key, session: stolen.session }), /held by a body in your house/);
  assert.throws(() => originOf(w.env, { kind: 'agent', agent: 'art' }, L, {}), /held by a body in your house/);

  // His own body, in his house, with the same proof: answered.
  const own = await api(w.env, fx, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: 'principal', body: stolen });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.owner, true);
  // And hers, in hers.
  const hers = await api(w.env, fx, { caller: fromLoren, path: 'principal', body: { conversation: L, key: keyOf(w, L), session: w.sessionFor(L) } });
  assert.deepEqual([hers.status, hers.body.for], [200, 'loren']);
});

test('a principal that changes reseats the body in the right house: never fed where it was; its session never into a person\'s house', async () => {
  const w = world();
  household(w.env);
  w.runner.houses = byWhom({ owner: 'h-1', 'p-loren': 'h-2' });
  const J = cvOf('art', 'slack', 'group:G');
  await deliver(w.env, w.msg('group:G', 'here is the plan', person('jonathan')), w.o);
  const first = loadConv(w.env, J).body;
  assert.equal(w.runner.seats[first.split(':')[1]], `owner.${J}`);
  // Mid-turn, Loren writes into the owner's place: the body in his house is ended, and the conversation resumes in hers.
  const n = w.log.length;
  await deliver(w.env, w.msg('group:G', 'and merge mine too', person('loren')), w.o);
  const after = w.log.slice(n);
  assert.ok(after.some((l) => l[0] === 'end' && l[1] === first.split(':')[1]), 'the owner\'s body is ended');
  assert.equal(after.some((l) => l[0] === 'feed'), false, 'her message is never fed to the body in his house');
  const second = loadConv(w.env, J).body;
  assert.notEqual(second, first);
  assert.equal(w.runner.seats[second.split(':')[1]], `p-loren.${J}`);
  // His session stays out of her house (her other conversations' bodies run there): a fresh body, her message in it.
  assert.equal(after.some((l) => l[0] === 'resume'), false, 'never resumed in her house');
  assert.match(after.find((l) => l[0] === 'start')[2], /merge mine too/);
  assert.equal(loadConv(w.env, J).slot, undefined);

  // The owner says it's his again (--reset), and writes: back to his house, fresh (her session isn't his house's).
  w.runner.finish(second);
  assert.equal(resetPrincipal(w.env, J).ok, true);
  const m = w.log.length;
  await deliver(w.env, w.msg('group:G', 'mine from here', person('jonathan')), w.o);
  const third = loadConv(w.env, J).body;
  assert.notEqual(third, second);
  assert.equal(w.runner.seats[third.split(':')[1]], `owner.${J}`);
  assert.equal(w.log.slice(m).some((l) => l[0] === 'feed'), false, 'nothing fed in her house');
  assert.equal(w.log.slice(m).some((l) => l[0] === 'resume'), false, 'her session never resumes in his house');

  // A slot from one seat isn't resumed in a person's: an evicted owner's body leaves a slot; then Loren writes.
  const K = cvOf('art', 'slack', 'group:K');
  await deliver(w.env, w.msg('group:K', 'one', person('jonathan')), w.o);
  w.runner.finish(loadConv(w.env, K).body);
  await tick(w.env, w.o);
  w.clock.advance(11 * 60_000);
  await tick(w.env, w.o);
  assert.ok(loadConv(w.env, K).slot, 'evicted with a slot');
  assert.equal(loadConv(w.env, K).slot.rules.seat, `owner.${K}`);
  const k = w.log.length;
  await deliver(w.env, w.msg('group:K', 'two', person('loren')), w.o);
  assert.equal(w.log.slice(k).some((l) => l[0] === 'resume'), false, 'the owner\'s session never resumes in her house');
  assert.equal(w.runner.seats[loadConv(w.env, K).body.split(':')[1]], `p-loren.${K}`);

  // A session a person steered goes nowhere but her house: not into the conversation's own unknown house (a second
  // person wrote), so Loren's context never reaches Daniel's work.
  const M = cvOf('art', 'slack', 'group:M');
  await deliver(w.env, w.msg('group:M', 'one', person('loren')), w.o);
  assert.equal(w.runner.seats[loadConv(w.env, M).body.split(':')[1]], `p-loren.${M}`);
  const j = w.log.length;
  await deliver(w.env, w.msg('group:M', 'two', person('daniel')), w.o);
  assert.equal(w.log.slice(j).some((l) => l[0] === 'resume'), false, 'dropped, not carried');
  const fresh = w.log.slice(j).find((l) => l[0] === 'start');
  assert.equal(w.runner.seats[fresh[1]], `u-${M}`);
  assert.match(fresh[2], /two/);

  // The owner's session may narrow into the conversation's own house (another agent's answer to his thread): carried.
  const O = cvOf('art', 'slack', 'group:O');
  await deliver(w.env, w.msg('group:O', 'ask mark', person('jonathan')), w.o);
  const i = w.log.length;
  await deliver(w.env, w.msg('group:O', 'mark says yes', { from: { kind: 'agent', id: 'mark' } }), w.o);
  const carried = w.log.slice(i).find((l) => l[0] === 'resume');
  assert.ok(carried, 'his session follows into a house of its own');
  assert.equal(w.runner.seats[carried[1]], `u-${O}`);
});

test('a relay\'s answer into a person\'s conversation waits for the turn, then reaches a fresh body in the conversation\'s own house', async () => {
  const w = world();
  household(w.env);
  w.runner.houses = new Proxy({}, { get: () => 'h-1' });
  const L = cvOf('art', 'slack', 'dm:LR');
  await deliver(w.env, w.msg('dm:LR', 'ask mark about it', person('loren')), w.o);
  const first = loadConv(w.env, L).body;
  // Mark's answer, returned to the turn that asked (relay.mjs; untilIdle): not fed mid-turn, nothing reseated yet.
  await deliver(w.env, w.msg('dm:LR', 'mark: it is fine', { from: { kind: 'agent', id: 'mark' } }), { ...w.o, deferPeer: true });
  assert.equal(loadConv(w.env, L).body, first);
  assert.equal(w.log.some((l) => l[0] === 'feed'), false);
  w.runner.finish(first);
  await tick(w.env, w.o);
  const second = loadConv(w.env, L).body;
  assert.notEqual(second, first);
  assert.equal(w.runner.seats[second.split(':')[1]], `u-${L}`);
  // Loren's session stays in her house; the answer isn't lost: the fresh body has it.
  const s = w.log.find((l) => l[0] === 'start' && l[1] === second.split(':')[1]);
  assert.ok(s, 'a fresh body, not her session');
  assert.match(s[2], /it is fine/);
});

test('the session carry rule: only its own seat, or from the owner\'s into the conversation\'s own house', async () => {
  const { carriesSession } = await import('../src/principal.mjs');
  const cv = 'cv-00000000000e';
  const other = 'cv-00000000000f';
  // Per conversation (t-2061): its own seat; the owner's own into its unknown house; a shared house from before into
  // this conversation's own house of the same principal. Never into another conversation's.
  assert.equal(carriesSession(`owner.${cv}`, `owner.${cv}`, cv), true);
  assert.equal(carriesSession(`owner.${cv}`, `u-${cv}`, cv), true);
  assert.equal(carriesSession('owner', `owner.${cv}`, cv), true, 'out of the shared owner house into its own');
  assert.equal(carriesSession(undefined, `owner.${cv}`, cv), true);
  assert.equal(carriesSession('p-loren', `p-loren.${cv}`, cv), true, 'out of her shared house into this conversation\'s own of hers');
  assert.equal(carriesSession('owner', `owner.${other}`, cv), false, 'never into another conversation\'s house');
  assert.equal(carriesSession(`owner.${other}`, `owner.${cv}`, cv), false);
  assert.equal(carriesSession(`owner.${cv}`, 'owner', cv), false, 'never back into a shared house');
  assert.equal(carriesSession(`owner.${cv}`, `p-loren.${cv}`, cv), false, 'never into a person\'s');
  assert.equal(carriesSession('p-loren', `p-dana.${cv}`, cv), false);
  assert.equal(carriesSession(`p-loren.${cv}`, `owner.${cv}`, cv), false);
  assert.equal(carriesSession(`p-loren.${cv}`, `u-${cv}`, cv), false);
  assert.equal(carriesSession('owner', 'owner', cv), true);
  assert.equal(carriesSession(undefined, 'owner', cv), true, 'none recorded is the owner\'s');
  assert.equal(carriesSession('p-loren', 'p-loren', cv), true);
  assert.equal(carriesSession('owner', `u-${cv}`, cv), true);
  assert.equal(carriesSession('owner', 'p-loren', cv), false, 'never into a person\'s house');
  assert.equal(carriesSession('p-loren', `u-${cv}`, cv), false, 'never out of one');
  assert.equal(carriesSession('p-loren', 'owner', cv), false, 'his house never inherits a session someone else steered');
  assert.equal(carriesSession(`u-${cv}`, 'owner', cv), false);
  assert.equal(carriesSession('owner', 'u-cv-00000000000f', cv), false, 'another conversation\'s house is no house of its own');
});

test('a resume that meets the cap at its house waits, its slot kept; up() counts the cap in the write that makes a house', async () => {
  const w = world();
  household(w.env);
  w.runner.houses = byWhom({ owner: 'h-1', 'p-loren': 'h-2' });
  const L = cvOf('art', 'slack', 'dm:L');
  await deliver(w.env, w.msg('dm:L', 'one', person('loren')), w.o);
  w.runner.finish(loadConv(w.env, L).body);
  await tick(w.env, w.o);
  w.clock.advance(11 * 60_000);
  await tick(w.env, w.o);
  assert.ok(loadConv(w.env, L).slot);
  // Another seat's house came up between plan's look and the house's (houserunner.mjs, warm: seatFull).
  const resume = w.runner.resume;
  w.runner.resume = () => { throw Object.assign(new Error('art already has 4 houses at work for other people (the cap is 4, LOOM_RUNTIME_SEAT_HOUSES): it waits for one to idle out'), { seatFull: true, nativeNotStarted: true }); };
  const out = await deliver(w.env, w.msg('dm:L', 'two', person('loren')), w.o);
  assert.equal(out.body, 'queued');
  assert.match(out.reason, /the cap is 4/);
  assert.ok(loadConv(w.env, L).slot, 'its session is kept');
  assert.equal(loadConv(w.env, L).queue.length, 1);
  w.runner.resume = resume;
  await tick(w.env, w.o);
  assert.ok(w.log.some((l) => l[0] === 'resume'), 'resumed once there\'s room');

  // The cap at the state write itself: two asks at once can't both pass a look made before either.
  const env = { ...w.env, LOOM_RUNTIME_SEAT_HOUSES: '1' };
  setAgent(env, fx, { agent: 'art', repo: 'https://example.com/art.git' });
  const { up } = await import('../src/control.mjs');
  const task = 'loom-runtime body-host --piece box --host-key 00';
  up(env, fx, { kind: 'owner' }, { agent: 'art', task }, { kind: 'body-host', seat: 'p-loren' });
  assert.throws(() => up(env, fx, { kind: 'owner' }, { agent: 'art', task }, { kind: 'body-host', seat: 'p-dana' }), (e) => e.seatFull === true && /the cap is 1/.test(e.message));
  assert.ok(up(env, fx, { kind: 'owner' }, { agent: 'art', task }, { kind: 'body-host', seat: 'owner.cv-00000000a001' }).id, 'the owner\'s never capped');
  assert.ok(up(env, fx, { kind: 'owner' }, { agent: 'art', task }, { kind: 'body-host', seat: 'owner.cv-00000000a002' }).id, 'however many of his conversations');
  // A seat that isn't one is refused, never recorded as the owner's.
  assert.throws(() => up(env, fx, { kind: 'owner' }, { agent: 'art', task }, { kind: 'body-host', seat: 'Bad Seat' }), /seat is owner/);
  assert.throws(() => up(env, fx, { kind: 'owner' }, { agent: 'art', task }, { kind: 'body-host', seat: 'owner.cv-nope' }), /seat is owner/);
});

test('the owner\'s reset: refused to a body, signed, and the session that heard what came before is dropped', async () => {
  const w = world();
  household(w.env);
  const { resetPrincipal } = await import('../src/delivery.mjs');
  const { resetSigned } = await import('../src/principal.mjs');
  const { deliveryDir } = await import('../src/delivery.mjs');
  const L = cvOf('art', 'slack', 'dm:RS');
  await deliver(w.env, w.msg('dm:RS', 'one', person('loren')), w.o);
  const first = loadConv(w.env, L).body;
  w.runner.finish(first);
  await tick(w.env, w.o);
  w.clock.advance(11 * 60_000);
  await tick(w.env, w.o);
  await deliver(w.env, w.msg('dm:RS', 'two', person('loren')), w.o);
  assert.ok(loadConv(w.env, L).body);
  assert.equal(resetPrincipal(w.env, L).ok, true);
  const c = loadConv(w.env, L);
  assert.equal(resetSigned(deliveryDir(w.env), c), true);
  assert.equal(c.actsFor.resetBy, 'owner');
  assert.equal(c.slot, undefined);
  assert.equal(c.resetPending, true);
  // The body that heard Loren is ended before the owner's next message, and nothing resumes her session.
  const n = w.log.length;
  await deliver(w.env, w.msg('dm:RS', 'mine now', person('jonathan')), w.o);
  assert.ok(w.log.slice(n).some((l) => l[0] === 'end'));
  assert.equal(w.log.slice(n).some((l) => l[0] === 'feed' || l[0] === 'resume'), false);
  assert.equal(w.runner.seats[loadConv(w.env, L).body.split(':')[1]], `owner.${L}`);
  assert.equal(loadConv(w.env, L).resetPending, undefined);
  // The CLI refuses a reset from any body's environment (a house's, or a local body's run key or conversation).
  const { spawnSync } = await import('node:child_process');
  const cli = join(here, '..', 'src', 'cli.mjs');
  for (const extra of [{ LOOM_BODY_KEY: 'k' }, { LOOM_BODY_CONVERSATION: L }, { HOUSE_ID: 'h-1' }]) {
    const r = spawnSync(process.execPath, [cli, 'principal', '--reset', '--conversation', L], { env: { PATH: process.env.PATH, HOME: w.env.HOME, LOOM_BOX_DATA: w.env.LOOM_BOX_DATA, ...extra }, encoding: 'utf-8' });
    assert.notEqual(r.status, 0, JSON.stringify(extra));
    assert.match(r.stdout + r.stderr, /never a body's/);
  }
  // A body that unsets all of them (env -u) is still refused: the owner confirms at the controlling terminal, which a
  // body has none of (a new session here, as `claude --bg` and a detached worker are), and piping the id in is no use.
  const before = JSON.stringify(loadConv(w.env, L).actsFor);
  const bare = spawnSync(process.execPath, [cli, 'principal', '--reset', '--conversation', L], { env: { PATH: process.env.PATH, HOME: w.env.HOME, LOOM_BOX_DATA: w.env.LOOM_BOX_DATA }, input: `${L}\n`, detached: true, encoding: 'utf-8' });
  assert.notEqual(bare.status, 0);
  assert.match(bare.stdout + bare.stderr, /at a terminal/);
  assert.equal(JSON.stringify(loadConv(w.env, L).actsFor), before, 'nothing reset');
});

test('down: an agent stops a body host\'s house only from one of the same seat; no answer names a seat but the owner\'s', async () => {
  const w = world();
  setAgent(w.env, fx, { agent: 'art', repo: 'https://example.com/art.git' });
  const task = 'loom-runtime body-host --piece box --host-key x';
  update(w.env, (s) => {
    s.houses['h-1'] = { id: 'h-1', agent: 'art', kind: 'body-host', seat: 'owner', state: 'running', task };
    s.houses['h-2'] = { id: 'h-2', agent: 'art', kind: 'body-host', seat: 'p-loren', state: 'running', task };
    s.houses['h-3'] = { id: 'h-3', agent: 'art', kind: 'body-host', seat: 'p-loren', state: 'running', task };
  });
  const as = (house) => ({ kind: 'agent', agent: 'art', house });
  const r1 = await api(w.env, fx, { caller: as('h-2'), path: 'down', body: { id: 'h-1' } });
  assert.equal(r1.status, 404, 'her house never stops his');
  assert.equal(load(w.env).houses['h-1'].state, 'running');
  const r2 = await api(w.env, fx, { caller: as('h-2'), path: 'down', body: { id: 'h-3' } });
  assert.equal(r2.status, 200);
  assert.equal('seat' in r2.body, false, 'the answer names no seat');
  const r3 = await api(w.env, fx, { caller: { kind: 'owner' }, path: 'down', body: { id: 'h-1' } });
  assert.equal(r3.status, 200);
});

test('a body seated before this change (its rules name no seat, or the shared owner house) moves to its conversation\'s own house', async () => {
  const { seatMoved } = await import('../src/delivery.mjs');
  const env = household(world().env);
  const old = (actsFor, seat) => ({ conversation: 'cv-00000000001a', agent: 'art', body: 'claude:h-1-x', bodyRules: { guest: false, ...(seat ? { seat } : {}) }, actsFor });
  assert.equal(seatMoved(env, old({ owner: false, people: ['loren'], unknown: false })), true, 'Loren\'s: out of the owner\'s house');
  assert.equal(seatMoved(env, old({ owner: false, people: [], unknown: true })), true, 'unknown: out');
  // t-2061: his too, out of the house his other conversations share, into one of its own.
  const his = { owner: true, owners: ['jonathan'], people: [], unknown: false };
  assert.equal(seatMoved(env, old(his)), true, 'his, from before seats: out of the shared house');
  assert.equal(seatMoved(env, old(his, 'owner')), true, 'his, in the shared owner house: out');
  assert.equal(seatMoved(env, old(his, 'owner.cv-00000000001a')), false, 'his, in its own: stays');
  assert.equal(seatMoved(env, old({ owner: false, people: ['loren'], unknown: false }, 'p-loren')), true, 'hers, in her shared house: out');
});

test('the cap counts seats, not houses: a seat\'s draining house and its new one are one', async () => {
  const { seatCapProblem } = await import('../src/principal.mjs');
  const task = 'loom-runtime body-host --piece box --host-key x';
  const s = { houses: {
    'h-1': { agent: 'art', kind: 'body-host', seat: 'p-a', state: 'running', task },
    'h-2': { agent: 'art', kind: 'body-host', seat: 'p-a', state: 'running', task },
  } };
  assert.equal(seatCapProblem({ LOOM_RUNTIME_SEAT_HOUSES: '2' }, s, 'art', 'p-c'), null);
  s.houses['h-3'] = { agent: 'art', kind: 'body-host', seat: 'p-b', state: 'running', task };
  assert.match(seatCapProblem({ LOOM_RUNTIME_SEAT_HOUSES: '2' }, s, 'art', 'p-c'), /2 houses at work/);
});

test('the cap\'s release never stops a house just handed to a start', async () => {
  const { releaseEmptySeatHouses } = await import('../src/houserunner.mjs');
  const w = world();
  setAgent(w.env, fx, { agent: 'art', repo: 'https://example.com/art.git' });
  const dir = join(w.env.LOOM_BOX_DATA, 'delivery', 'hosts');
  mkdirSync(dir, { recursive: true });
  update(w.env, (s) => { s.houses['h-5'] = { id: 'h-5', agent: 'art', kind: 'body-host', seat: 'p-y', state: 'running', task: 'loom-runtime body-host --piece box --host-key x' }; });
  const now = Date.now();
  const rec = { agent: 'art', seat: 'p-y', house: 'h-5', report: { at: now, house: 'h-5', bodies: {}, done: {} }, req: {}, stop: {}, inbox: {} };
  writeFileSync(join(dir, 'art@p-y.json'), JSON.stringify({ ...rec, handedAt: now }));
  assert.deepEqual(releaseEmptySeatHouses(w.env, 'art', 'p-x', now), [], 'handed out: kept');
  writeFileSync(join(dir, 'art@p-y.json'), JSON.stringify(rec));
  assert.deepEqual(releaseEmptySeatHouses(w.env, 'art', 'p-x', now), ['h-5'], 'empty and not handed out: let go');
});

test('a body whose conversation moved house can\'t speak or get a statement there; the owner\'s own may finish its turn', async () => {
  const w = world();
  household(w.env);
  w.runner.houses = byWhom({ owner: 'h-1', 'p-loren': 'h-2' });
  const { resetPrincipal } = await import('../src/delivery.mjs');
  // Loren's DM, her body at work in her house; the owner resets it (before writing in it himself).
  const L = cvOf('art', 'slack', 'dm:MV');
  await deliver(w.env, w.msg('dm:MV', 'hi', person('loren')), w.o);
  const proof = { conversation: L, key: keyOf(w, L), session: w.sessionFor(L) };
  const hers = { kind: 'agent', agent: 'art', house: 'h-2' };
  assert.equal((await api(w.env, fx, { caller: hers, path: 'principal', body: proof })).status, 200);
  assert.equal(resetPrincipal(w.env, L).ok, true);
  const p = await api(w.env, fx, { caller: hers, path: 'principal', body: proof });
  assert.equal(p.status, 409, 'no statement for the owner to the body in her house');
  assert.equal(p.body.statement, undefined);
  const hs = await w.send({ ...proof, text: 'done, as the owner' }, { ...w.o, caller: hers });
  assert.equal(hs.accepted, undefined);
  assert.match(hs.reason, /doesn't match|moved to another principal's house/);
  const { holdsRun } = await import('../src/delivery.mjs');
  // The owner's thread with a relay's answer waiting on its turn: his body may still send its reply, but asks no
  // principal (the conversation's is unknown now) and proves no place.
  const O = cvOf('art', 'slack', 'dm:MO');
  await deliver(w.env, w.msg('dm:MO', 'ask mark', person('jonathan')), w.o);
  const po = { conversation: O, key: keyOf(w, O), session: w.sessionFor(O) };
  await deliver(w.env, w.msg('dm:MO', 'mark: yes', { from: { kind: 'agent', id: 'mark' } }), { ...w.o, deferPeer: true });
  const his = { kind: 'agent', agent: 'art', house: 'h-1' };
  const sent = await w.send({ ...po, text: 'asked mark' }, { ...w.o, caller: his });
  assert.equal(sent.accepted, true, JSON.stringify(sent));
  assert.equal((await api(w.env, fx, { caller: his, path: 'principal', body: po })).status, 409);
  assert.equal(holdsRun(w.env, O, po, { ...w.o, caller: his }), false);
});

test('a session that heard people resumes only under the same rules key (sameRules, apart from seats)', async () => {
  const { sameRules } = await import('../src/policy.mjs');
  assert.equal(sameRules({ guest: false, grantFor: 'phil', key: 'a' }, { guest: false, key: 'b' }), false);
  assert.equal(sameRules({ guest: false, members: ['phil'], key: 'a' }, { guest: false, members: ['phil'], key: 'a' }), true);
  assert.equal(sameRules({ guest: false }, { guest: true }), false);
});

test('a seat record whose house was just asked for is never swept; one whose house is over is', () => {
  const w = world();
  setAgent(w.env, fx, { agent: 'art', repo: 'https://example.com/art.git' });
  const dir = join(w.env.LOOM_BOX_DATA, 'delivery', 'hosts');
  mkdirSync(dir, { recursive: true });
  update(w.env, (s) => { s.houses['h-7'] = { id: 'h-7', agent: 'art', kind: 'body-host', seat: 'p-loren', state: 'wanted', task: 'loom-runtime body-host --piece box --host-key x' }; });
  writeFileSync(join(dir, 'art@p-loren.json'), JSON.stringify({ agent: 'art', seat: 'p-loren', house: 'h-7', req: {}, stop: {}, inbox: {} }));
  writeFileSync(join(dir, 'art@p-dana.json'), JSON.stringify({ agent: 'art', seat: 'p-dana', house: 'h-3', req: {}, stop: {}, inbox: {} }));
  sweepSeats(w.env);
  assert.equal(existsSync(join(dir, 'art@p-loren.json')), true);
  assert.equal(existsSync(join(dir, 'art@p-dana.json')), false);
});

test('a local body (loom\'s machine) is the owner\'s work only: a person other than the owner writing there gets no body', async () => {
  const { seatMoved } = await import('../src/delivery.mjs');
  const env = household(world().env);
  const c = { conversation: 'cv-00000000000d', agent: 'art', local: true, body: 'claude:x0000001', actsFor: { owner: true, owners: [], people: [], unknown: false } };
  assert.equal(seatMoved(env, c), false, 'a wake the clock said is the owner\'s');
  c.actsFor = { owner: true, owners: ['jonathan'], people: [], unknown: false };
  assert.equal(seatMoved(env, c), false, 'and his Reply');
  c.actsFor = { owner: false, people: [], unknown: true };
  assert.equal(seatMoved(env, c), true, 'a wake with no word from the clock: unknown, foreign');
  c.actsFor = { owner: true, owners: ['jonathan'], people: [], unknown: false };
  c.actsFor.people = ['loren'];
  assert.equal(seatMoved(env, c), true, 'someone else wrote');
  c.actsFor = { owner: false, people: [], unknown: true };
  assert.equal(seatMoved(env, c), true, 'unknown is foreign: fail closed');
  // The owner's reset vouches for it only signed, as the runtime makes it on his word (resetPrincipal): a reset
  // string anyone wrote vouches for nothing.
  const { resetActsFor } = await import('../src/principal.mjs');
  const { deliveryDir } = await import('../src/delivery.mjs');
  c.actsFor = { owner: false, people: [], unknown: false, reset: '2026-11-08T00:00:00Z' };
  assert.equal(seatMoved(env, c), true, 'an unsigned reset: foreign');
  resetActsFor(env, c, '2026-11-08T00:00:00Z', { dir: deliveryDir(env), by: 'owner' });
  assert.equal(seatMoved(env, c), false, 'signed: the owner\'s');
  c.actsFor.reset = '2026-11-09T00:00:00Z';
  assert.equal(seatMoved(env, c), true, 'a signature is for its own reset only');
  resetActsFor(env, c, '2026-11-08T00:00:00Z', { dir: deliveryDir(env), by: 'owner' });
  c.actsFor.people = ['loren'];
  assert.equal(seatMoved(env, c), true);
});

test('houses for other people are capped per agent: at the cap a body waits (the owner\'s never does), and starts once one idles out', async () => {
  const w = world({ LOOM_RUNTIME_SEAT_HOUSES: '1' });
  household(w.env);
  w.runner.houses = byWhom({ owner: 'h-1', 'p-loren': 'h-2', 'p-dana': 'h-5' });
  setAgent(w.env, fx, { agent: 'art', repo: 'https://example.com/art.git' });
  // Dana's house is up, at work.
  update(w.env, (s) => { s.houses['h-5'] = { id: 'h-5', agent: 'art', kind: 'body-host', seat: 'p-dana', state: 'running', task: 'loom-runtime body-host --piece box --host-key x' }; });
  assert.match(seatRoom(w.env, 'art', 'p-loren'), /already has 1 house at work for other people \(the cap is 1/);
  assert.equal(seatRoom(w.env, 'art', 'owner.cv-00000000b001'), null);
  assert.equal(seatRoom(w.env, 'art', 'p-dana'), null, 'its own house isn\'t one of the others');
  // A seat whose record names a house that's up: in it, whatever the count.
  mkdirSync(join(w.env.LOOM_BOX_DATA, 'delivery', 'hosts'), { recursive: true });
  update(w.env, (s) => { s.houses['h-6'] = { id: 'h-6', agent: 'art', kind: 'body-host', seat: 'p-eve', state: 'running', task: 'loom-runtime body-host --piece box --host-key x' }; });
  writeFileSync(join(w.env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art@p-eve.json'), JSON.stringify({ agent: 'art', seat: 'p-eve', house: 'h-6', req: {}, stop: {}, inbox: {} }));
  assert.equal(seatRoom(w.env, 'art', 'p-eve'), null);
  update(w.env, (s) => { delete s.houses['h-6']; });
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
  assert.equal(w.runner.seats[b.split(':')[1]], `p-loren.${L}`);
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
  // Core is told which one conversation each house holds, before the house is handed anything (t-2061).
  const bindings = [];
  const hr = new HouseRunner(env, 'claude', { poll: 10, sealer, claimMs: 5000, warmMs: 5000, bindHouse: async (b) => { bindings.push(b); } });
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
  // At the cap, the start that finds it full is a wait (seatFull), not a failure: at warm()'s own look, and at up()'s
  // write when a start raced past that look.
  const capEnv = { ...env, LOOM_RUNTIME_SEAT_HOUSES: '1' };
  update(env, (s) => { s.houses['h-50'] = { id: 'h-50', agent: 'art', kind: 'body-host', seat: 'p-zed', state: 'running', task: 'loom-runtime body-host --piece box --host-key x' }; });
  const capped = new HouseRunner(capEnv, 'claude', { poll: 10, sealer, claimMs: 500, warmMs: 500 });
  await assert.rejects(capped.warm('art', 'p-amy'), (e) => e.seatFull === true && /the cap is 1/.test(e.message));
  const raced = new HouseRunner(capEnv, 'claude', { poll: 10, sealer, claimMs: 500, warmMs: 500, up: () => { throw Object.assign(new Error('art already has 1 house at work for other people (the cap is 1, LOOM_RUNTIME_SEAT_HOUSES): it waits for one to idle out'), { status: 409, seatFull: true }); } });
  update(env, (s) => { delete s.houses['h-50']; });
  await assert.rejects(raced.warm('art', 'p-amy'), (e) => e.seatFull === true);
  // And a start the runtime's plan didn't hold: its error is that wait too (the real up(), the cap counted in its write).
  update(env, (s) => { s.houses['h-50'] = { id: 'h-50', agent: 'art', kind: 'body-host', seat: 'p-zed', state: 'running', task: 'loom-runtime body-host --piece box --host-key x' }; });
  const { up: realUp } = await import('../src/control.mjs');
  assert.throws(() => realUp(capEnv, fx, { kind: 'owner' }, { agent: 'art', task: 'loom-runtime body-host --piece box --host-key 00' }, { kind: 'body-host', seat: 'p-amy' }), (e) => e.seatFull === true);
  update(env, (s) => { delete s.houses['h-50']; });
  // A body holding a conversation never goes to a shared house from before, nor to another conversation's (t-2061).
  await assert.rejects(startBody(env, { agent: 'art', venue: 'slack', brief: 'x', seat: 'owner' }, { runner: () => hr, accounts, bodyEnv: { LOOM_BODY_KEY: 'k', LOOM_BODY_CONVERSATION: 'cv-00000000000a' } }), /house of its conversation alone/);
  await assert.rejects(startBody(env, { agent: 'art', venue: 'slack', brief: 'x', seat: 'owner.cv-00000000000b' }, { runner: () => hr, accounts, bodyEnv: { LOOM_BODY_KEY: 'k', LOOM_BODY_CONVERSATION: 'cv-00000000000a' } }), /never runs in cv-00000000000b's house/);
  assert.equal(load(env).houses['h-1'], undefined, 'no house was asked for either');
  const a = await startIn('owner.cv-00000000000a', 'cv-00000000000a', 'h-1');
  const b = await startIn('p-loren.cv-00000000000b', 'cv-00000000000b', 'h-2');
  assert.deepEqual([a.house, a.seat, b.house, b.seat], ['h-1', 'owner.cv-00000000000a', 'h-2', 'p-loren.cv-00000000000b']);
  // Two houses, each marked with its seat for the owner's listing.
  assert.deepEqual(['h-1', 'h-2'].map((h) => load(env).houses[h].seat), ['owner.cv-00000000000a', 'p-loren.cv-00000000000b']);
  assert.deepEqual(bindings, [{ agent: 'art', house: 'h-1', conversation: 'cv-00000000000a' }, { agent: 'art', house: 'h-2', conversation: 'cv-00000000000b' }]);
  // Each seat's record is its own: <agent>@<seat>.json.
  assert.equal(hostOf(env, 'art', 'owner.cv-00000000000a').house, 'h-1');
  assert.equal(hostOf(env, 'art', 'p-loren.cv-00000000000b').house, 'h-2');
  assert.equal(hostOf(env, 'art').house, undefined, 'the shared owner record from before holds nothing');
  // Each house's host was handed only its own seat's body: its key never reached the other house.
  assert.deepEqual(houses['h-1'].started.map((x) => x.key), ['key-of-owner.cv-00000000000a']);
  assert.deepEqual(houses['h-2'].started.map((x) => x.key), ['key-of-p-loren.cv-00000000000b']);
  // Each conversation's key file is in its own house's home (bodyhost.mjs, keyFile), never the other's.
  const keys = (h) => { try { return readdirSync(join(houses[h].home, '.local', 'state', 'loom-runtime', 'keys')); } catch { return []; } };
  assert.deepEqual([keys('h-1'), keys('h-2')].map((k) => k.filter((n) => n.endsWith('.key'))), [['cv-00000000000a.key'], ['cv-00000000000b.key']]);
  // And which conversation each body's session holds (t-2053), in its own house only.
  const held = (h) => { const d = join(houses[h].home, '.local', 'state', 'loom-runtime', 'keys', 'sessions'); try { return readdirSync(d).map((f) => readFileSync(join(d, f), 'utf-8')); } catch { return []; } };
  assert.deepEqual([held('h-1'), held('h-2')], [['cv-00000000000a'], ['cv-00000000000b']]);
  // Status and feeding go through the body's own seat's record.
  const ref = (x) => ({ id: x.body.split(':')[1], agent: 'art', house: x.house, seat: x.seat, harness: 'claude' });
  await until(() => hr.status(ref(a)) === 'working' && hr.status(ref(b)) === 'working');
  // A third seat at a cap of one other house: refused at the house, never seated in hers.
  env.LOOM_RUNTIME_SEAT_HOUSES = '1';
  await assert.rejects(startBody(env, { agent: 'art', venue: 'slack', brief: 'x', seat: 'u-cv-00000000000c' }, { runner: () => hr, accounts, bodyEnv: { LOOM_BODY_KEY: 'k', LOOM_BODY_CONVERSATION: 'cv-00000000000c' } }), (e) => e.seatFull === true && /the cap is 1/.test(e.message));
  assert.equal(load(env).houses['h-3'], undefined);
  hr.end(ref(a)); hr.end(ref(b));
  await Promise.all(Object.values(houses).map((h) => h.done));
  // At the cap, a house of another seat that holds no body is let go at once (its host reports every body ended).
  const { releaseEmptySeatHouses } = await import('../src/houserunner.mjs');
  await until(() => Object.values(hostOf(env, 'art', 'p-loren.cv-00000000000b').report?.bodies ?? {}).every((x) => x.status === 'ended'));
  update(env, (s) => { for (const h of ['h-1', 'h-2']) s.houses[h].state = 'running'; });   // as its box reports it (no box here)
  // (Its warm() hand-out was a while ago: as the record would read after a minute.)
  { const f = join(env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art@p-loren.cv-00000000000b.json'); const x = JSON.parse(readFileSync(f, 'utf-8')); delete x.handedAt; writeFileSync(f, JSON.stringify(x)); }
  assert.deepEqual(releaseEmptySeatHouses(env, 'art', 'u-cv-00000000000c'), ['h-2']);
  assert.equal(load(env).houses['h-2'].state, 'stopping');
  assert.deepEqual(releaseEmptySeatHouses(env, 'art', 'p-loren.cv-00000000000b'), [], 'never the asking seat\'s own, never the owner\'s');
  // Her house over, her seat's record goes; the owner's conversation's stays while its house is up.
  update(env, (s) => { s.houses['h-2'].state = 'stopped'; });
  sweepSeats(env);
  assert.equal(existsSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art@p-loren.cv-00000000000b.json')), false);
  assert.equal(existsSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art@owner.cv-00000000000a.json')), true);
});

// t-1974: the household's own wakes keep the owner's trust. The clock hands over whom each wake is for as it fires
// (`principal --wake`); the runtime seats its body by that, and by nothing else.
test('a lane wake fires with owner; a wake set from a Loren conversation fires for Loren; an unsigned wake stays unknown', async () => {
  const { handOverWake } = await import('../src/delivery.mjs');
  const w = world();
  household(w.env);
  w.runner.houses = byWhom({ owner: 'h-1', 'p-loren': 'h-2' });
  const wake = (place, id) => w.msg(place, 'the lane\'s words', { id, venue: 'wake', kind: 'wake', from: { kind: 'schedule' }, label: place });
  handOverWake(w.env, { agent: 'art', place: 'lane:plan-night', id: 'w-aaaaaa', for: 'owner' });
  handOverWake(w.env, { agent: 'art', place: 'wake:w-bbbbbb', id: 'w-bbbbbb', for: 'loren' });
  handOverWake(w.env, { agent: 'art', place: 'wake:w-cccccc', id: 'w-cccccc', for: '-' });
  for (const [place, id] of [['lane:plan-night', 'w-aaaaaa'], ['wake:w-bbbbbb', 'w-bbbbbb'], ['wake:w-cccccc', 'w-cccccc'], ['wake:w-dddddd', 'w-dddddd']]) {
    await deliver(w.env, wake(place, id), w.o);
  }
  const seat = (place) => { const c = loadConv(w.env, cvOf('art', 'wake', place)); return [c.bodyRules?.seat, w.runner.seats[c.body.split(':')[1]]]; };
  const cvA = cvOf('art', 'wake', 'lane:plan-night');
  const cvB = cvOf('art', 'wake', 'wake:w-bbbbbb');
  assert.deepEqual(seat('lane:plan-night'), [`owner.${cvA}`, `owner.${cvA}`], 'the owner\'s lane, in a house of its own');
  assert.deepEqual(seat('wake:w-bbbbbb'), [`p-loren.${cvB}`, `p-loren.${cvB}`], 'Loren\'s, in one of hers');
  const cvC = cvOf('art', 'wake', 'wake:w-cccccc');
  const cvD = cvOf('art', 'wake', 'wake:w-dddddd');
  assert.deepEqual(seat('wake:w-cccccc'), [`u-${cvC}`, `u-${cvC}`], 'the clock\'s unknown: a house of its own');
  assert.deepEqual(seat('wake:w-dddddd'), [`u-${cvD}`, `u-${cvD}`], 'no hand-over at all (unsigned): unknown, never the owner\'s');
});


test('a physically ended house awaiting collection is neither a live body host nor a guest capacity consumer',async()=>{
  const w=world(),now=Date.now(),dir=join(w.env.LOOM_BOX_DATA,'delivery','hosts');mkdirSync(dir,{recursive:true});
  update(w.env,s=>{s.houses['h-7']={id:'h-7',agent:'art',kind:'body-host',seat:'j-h-7',state:'running'};});
  writeFileSync(join(dir,'art@j-h-7.json'),JSON.stringify({house:'h-7',report:{at:now,house:'h-7',bodies:{b0000001:{status:'working',harness:'claude',session:'native-thread'}}},req:{},stop:{},inbox:{}}));
  const hr=new HouseRunner(w.env,'claude',{sealer:w.o.sealer,now:()=>new Date(now),up(){throw Error('must not allocate a different house');}});
  const body={id:'h-7-b0000001',agent:'art',house:'h-7',seat:'j-h-7'};
  assert.equal(hr.status(body),'working');
  update(w.env,s=>{s.houses['h-7'].collection={phase:'state'};s.houses['h-8']={id:'h-8',agent:'art',kind:'body-host',seat:'p-guest',state:'running',collection:{phase:'state'}};});
  assert.equal(hr.status(body),'ended','physical collection proves termination, without discarding the last report');assert.equal(hr.alive(body),false);assert.equal(hr.pending(body),false);
  assert.deepEqual(otherSeatHouses(load(w.env),'art','p-another'),[]);
  await assert.rejects(hr.warm('art','j-h-7'),/no longer running/);
  const file=join(dir,'art@j-h-7.json'),record=JSON.parse(readFileSync(file,'utf8'));
  record.report.at=now-60000;record.report.bodies.b0000001={status:'idle',harness:'claude',session:'native-thread',finalSealed:w.o.sealer.seal(Buffer.from('LAST COMPLETED REPORT')).toString('base64')};
  writeFileSync(file,JSON.stringify(record));
  assert.equal(hr.status(body),'ended');assert.equal(hr.final(body),'LAST COMPLETED REPORT','collection preserves the completed report even while state upload waits');
});

// t-2061: the owner's own conversations, each in a house of its own. Inside one house every body is root (it could read
// a sibling's key file, /proc environ, or plant hooks), so two of his threads in one house could pose as each other.
// Here each is its own container: with the other's run key and session in hand, every route that takes a conversation
// refuses it from the wrong house.
const perConversation = () => { const m = {}; let n = 0; return new Proxy({}, { get: (_, k) => (typeof k === 'string' ? (m[k] ??= `h-${++n}`) : undefined) }); };

test('two of the owner\'s conversations never share a house: one can\'t speak, ask, continue, relay or ask the host as the other', async () => {
  const w = world();
  household(w.env);
  w.runner.houses = perConversation();
  await deliver(w.env, w.msg('dm:A', 'ship it', person('jonathan')), w.o);
  await deliver(w.env, w.msg('group:B', 'read this page for me', person('jonathan')), w.o);
  const A = cvOf('art', 'slack', 'dm:A');
  const B = cvOf('art', 'slack', 'group:B');
  const seats = [A, B].map((cv) => loadConv(w.env, cv).bodyRules.seat);
  assert.deepEqual(seats, [`owner.${A}`, `owner.${B}`], 'both his, each its own');
  const houseOf = (cv) => w.runner.where({ seat: loadConv(w.env, cv).bodyRules.seat }).house;
  assert.notEqual(houseOf(A), houseOf(B));
  const inA = { kind: 'agent', agent: 'art', house: houseOf(A) };
  const inB = { kind: 'agent', agent: 'art', house: houseOf(B) };
  // B's body (say, a page it read told it to) holds A's key and session.
  const stolen = { conversation: A, key: keyOf(w, A), session: w.sessionFor(A) };
  const sent = await api(w.env, fx, { caller: inB, path: 'send', body: { ...stolen, text: 'merged, as you asked' } });
  assert.equal(sent.status, 409);
  assert.match(sent.body.reason, /isn't its body's house/);
  const who = await api(w.env, fx, { caller: inB, path: 'principal', body: stolen });
  assert.equal(who.status, 409);
  assert.equal(who.body.statement, undefined);
  for (const p of ['continuation-issue', 'continuation-status']) {
    const r = await api(w.env, fx, { caller: inB, path: p, body: stolen });
    assert.notEqual(r.body.ok, true, `${p}: ${JSON.stringify(r.body)}`);
    assert.match(JSON.stringify(r.body), /only the body holding|isn't its body's house/, p);
  }
  const place = await api(w.env, fx, { caller: inB, path: 'run', body: { argv: ['place', '--conversation', A], key: stolen.key, session: stolen.session } });
  assert.notEqual(place.body.exit, 0);
  const { originOf } = await import('../src/relay.mjs');
  assert.throws(() => originOf(w.env, inB, A, { key: stolen.key, session: stolen.session }), /held by a body in your house/);
  assert.equal(originOf(w.env, inB, undefined, {})?.conversation, B, 'unnamed, the only conversation in its house is its own');
  const { holdsRun, heldConv } = await import('../src/delivery.mjs');
  const { principalOf } = await import('../src/principal.mjs');
  assert.equal(holdsRun(w.env, A, stolen, { ...w.o, caller: inB }), false);
  const spawned = await api(w.env, fx, { caller: inB, path: 'spawn', body: { ...stolen, brief: 'do it as A' } });
  assert.notEqual(spawned.status, 200);
  // Host verbs (loom's machine, the owner's work only): B's house is the owner's too, and still can't ask as A.
  const { ownerBody } = await import('../src/hostverbs.mjs');
  const hd = { heldConv, principalOf, housePrincipal: () => ({ owner: true }), householdAgent: () => true };
  assert.ok(ownerBody(w.env, inB, A, stolen, hd).reason);
  assert.equal(ownerBody(w.env, inA, A, stolen, hd).c?.conversation, A, 'from its own house, the same proof stands');
  // From its own house, everything above is answered: it's the house that was refused, nothing else.
  assert.equal((await api(w.env, fx, { caller: inA, path: 'principal', body: stolen })).status, 200);
  assert.equal(holdsRun(w.env, A, stolen, { ...w.o, caller: inA }), true);
});

test('a body of the owner\'s in the shared house from before moves to its own: nothing it says there stands, its session goes with it', async () => {
  const w = world();
  household(w.env);
  w.runner.houses = perConversation();
  await deliver(w.env, w.msg('dm:OLD', 'one', person('jonathan')), w.o);
  const C = cvOf('art', 'slack', 'dm:OLD');
  const { saveConv } = await import('../src/delivery.mjs');
  // As a body seated before t-2061 reads: its rules name the shared owner house, and its body runs there.
  const c = loadConv(w.env, C);
  c.bodyRules = { ...c.bodyRules, seat: 'owner' };
  saveConv(w.env, c);
  const shared = { kind: 'agent', agent: 'art', house: w.runner.where({ seat: `owner.${C}` }).house };
  const proof = { conversation: C, key: keyOf(w, C), session: w.sessionFor(C) };
  // Its key and session could be any sibling's there: refused, even for its own reply.
  const sent = await w.send({ ...proof, text: 'done' }, { ...w.o, caller: shared });
  assert.equal(sent.accepted, undefined);
  assert.match(sent.reason, /moved to another principal's house/);
  assert.equal((await api(w.env, fx, { caller: shared, path: 'principal', body: proof })).status, 409);
  // Its next message ends it there and resumes it, session and all, in a house of its own.
  const first = loadConv(w.env, C).body;
  w.runner.finish(first);
  await tick(w.env, w.o);
  const n = w.log.length;
  await deliver(w.env, w.msg('dm:OLD', 'two', person('jonathan')), w.o);
  const second = loadConv(w.env, C).body;
  assert.notEqual(second, first);
  assert.equal(w.runner.seats[second.split(':')[1]], `owner.${C}`);
  assert.ok(w.log.slice(n).some((l) => l[0] === 'resume'), 'his session follows it into its own house');
});

test('a launch goes only to its own conversation\'s house (or its job\'s), never a shared one or another\'s', async () => {
  const { sharedSeatProblem } = await import('../src/houserunner.mjs');
  const env = (cv) => ({ LOOM_BODY_CONVERSATION: cv, LOOM_BODY_KEY: 'k' });
  const A = 'cv-0000000000a1', B = 'cv-0000000000b1';
  assert.equal(sharedSeatProblem({ seat: `owner.${A}`, env: env(A) }), null);
  assert.equal(sharedSeatProblem({ seat: `p-loren.${A}`, env: env(A) }), null);
  assert.equal(sharedSeatProblem({ seat: `u-${A}`, env: env(A) }), null);
  assert.equal(sharedSeatProblem({ seat: 'j-h-12', env: env(A) }), null, 'a job\'s house is its one conversation\'s');
  assert.match(sharedSeatProblem({ seat: 'owner', env: env(A) }), /conversation alone/);
  assert.match(sharedSeatProblem({ env: env(A) }), /conversation alone/, 'none named is the shared owner house: refused');
  assert.match(sharedSeatProblem({ seat: 'p-loren', env: env(A) }), /conversation alone/);
  assert.match(sharedSeatProblem({ seat: `owner.${B}`, env: env(A) }), /never runs in/);
  assert.match(sharedSeatProblem({ seat: `u-${B}`, env: env(A) }), /never runs in/);
  assert.equal(sharedSeatProblem({ seat: 'owner', env: {} }), null, 'a body holding no conversation proves nothing anywhere');
});

test('a house core won\'t bind to the conversation is handed nothing: the start didn\'t happen', { skip: !hasAge && 'age isn\'t installed' }, async () => {
  const D = scratch('rt-bind-');
  const env = { PATH: process.env.PATH, HOME: D, LOOM_HOME: join(D, 'loomhome'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_DATA: join(D, 'data'), LOOM_RUNTIME_SCORECARDS: 'off' };
  mkdirSync(env.LOOM_HOME, { recursive: true });
  const sealer = ageSealer(env, join(env.LOOM_BOX_DATA, 'delivery'));
  setAgent(env, fx, { agent: 'art', repo: 'https://example.com/art.git' });
  // Its house is up, its host reporting (as warm() waits for).
  const seat = 'owner.cv-0000000000c1';
  const now = Date.now();
  update(env, (s) => { s.houses['h-9'] = { id: 'h-9', agent: 'art', kind: 'body-host', seat, state: 'running', task: 'loom-runtime body-host --piece box --host-key x' }; });
  mkdirSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts'), { recursive: true });
  const f = join(env.LOOM_BOX_DATA, 'delivery', 'hosts', `art@${seat}.json`);
  writeFileSync(f, JSON.stringify({ agent: 'art', seat, house: 'h-9', houses: { 'h-9': { report: { at: now, house: 'h-9', bodies: {}, done: {}, caps: ['parts', 'native-admission', 'native-history'] } } }, report: { at: now, house: 'h-9', bodies: {}, done: {}, caps: ['parts', 'native-admission', 'native-history'] }, req: {}, stop: {}, inbox: {} }));
  const hr = new HouseRunner(env, 'claude', { poll: 10, sealer, claimMs: 300, warmMs: 300, now: () => new Date(now), bindHouse: async () => { throw new Error('conflict: h-9 holds cv-0000000000c2'); } });
  await assert.rejects(hr.launch({ agent: 'art', seat, brief: 'x', env: { LOOM_BODY_KEY: 'k', LOOM_BODY_CONVERSATION: 'cv-0000000000c1' } }), (e) => e.nativeNotStarted === true && /core didn't record that h-9 holds cv-0000000000c1/.test(e.message));
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf-8')).req, {}, 'nothing asked of the house');
});
