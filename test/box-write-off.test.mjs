// A box gone dark mid-turn (t-2057): the owner writes off its houses, and their conversations go on elsewhere.
// Its bodies are retired as terminated without history (their notice says effects may already have happened), the
// next body goes to a house on a box that's up, and if the dark box comes back it's told to stop them and nothing they
// say is taken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, loadConv, tick } from '../src/delivery.mjs';
import { load, update } from '../src/state.mjs';
import { WRITE_OFF_AFTER_MS, api, writeOffBox } from '../src/control.mjs';
import { bodySync } from '../src/houserunner.mjs';
import { cvOf, hasAge, houseWorld, world } from './delivery-world.mjs';

const wait = async (fn) => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
const owner = { kind: 'owner' };

test('only the household owner writes off a box, only one silent long enough, never loom\'s own', () => {
  const h = houseWorld();
  const fx = { now: () => new Date(), mint: () => 'loom_' + 't'.repeat(31), revoke: () => {} };
  assert.equal(api(h.env, fx, { caller: owner, path: 'add-box', body: { name: 'far', mayHost: '*' } }).status, 200);
  const far = Object.entries(load(h.env).boxes).find(([, b]) => b.name === 'far')[0];
  update(h.env, (s) => {
    s.boxes[far].lastSeen = new Date(Date.now() - 60_000).toISOString();
    s.houses['h-7'] = { id: 'h-7', agent: 'art', box: far, state: 'running', tokenLabel: 'house-h-7', nativeHistory: { v: 1, complete: false } };
    s.houses['h-8'] = { id: 'h-8', agent: 'art', box: far, state: 'running', service: 'bridge' };
  });
  // No API path does it: only the owner's Allow on a card (dark-box.mjs).
  assert.equal(api(h.env, fx, { caller: owner, path: 'box-write-off', body: { name: 'far' } }).status, 404);
  assert.throws(() => writeOffBox(h.env, fx, { name: 'far' }), /heard from in the last/);
  assert.throws(() => writeOffBox(h.env, fx, { name: 'one' }), /loom's own machine/);
  update(h.env, (s) => { s.boxes[far].lastSeen = new Date(Date.now() - WRITE_OFF_AFTER_MS - 1000).toISOString(); });
  assert.throws(() => writeOffBox(h.env, fx, { name: 'far', lastSeen: '2026-01-01T00:00:00.000Z' }), /heard from since/);
  const r = { body: writeOffBox(h.env, fx, { name: 'far' }) };
  const s = load(h.env);
  assert.equal(s.houses['h-7'].state, 'lost');
  assert.deepEqual(s.houses['h-7'].nativeHistory, { v: 1, complete: true, writtenOff: true });
  assert.equal(s.houses['h-8'].state, 'running', 'a service moves with a forced service move, not this');
  // The box comes back: told to stop it; its reports are noted, never taken; it asks nothing more once it says it stopped.
  const box = { kind: 'piece', subject: far };
  const polled = api(h.env, fx, { caller: box, path: 'poll', body: {} }).body;
  assert.ok(polled.stop.includes('h-7'));
  assert.ok(!polled.active.includes('h-7'));
  assert.equal(api(h.env, fx, { caller: box, path: 'report', body: { id: 'h-7', state: 'running' } }).body.state, 'lost');
  assert.equal(api(h.env, fx, { caller: box, path: 'collection-status', body: { id: 'h-7', phase: 'native' } }).status, 409);
  api(h.env, fx, { caller: box, path: 'report', body: { id: 'h-7', state: 'stopped' } });
  assert.equal(load(h.env).houses['h-7'].state, 'lost');
  assert.ok(!api(h.env, fx, { caller: box, path: 'poll', body: {} }).body.stop.includes('h-7'));
});

for (const harness of ['claude', 'codex']) test(`${harness}: a conversation mid-turn on a box that went dark goes on in a house on a box that's up`, { skip: !hasAge }, async () => {
  const w = world(), h = houseWorld({ harness });
  const cv = cvOf('art', 'slack', 'dm:dark-box');
  const o = { ...w.o, runner: () => h.hr, accounts: h.accounts, sealer: h.sealer };
  const fx = { now: () => new Date(), mint: () => 'loom_' + 't'.repeat(31), revoke: () => {} };
  let host, drained;
  const first = deliver(h.env, w.msg('dm:dark-box', 'start the long job'), { ...o, onDrain: (p) => { drained = p; } });
  try {
    await wait(() => load(h.env).houses['h-1']); host = h.host(); await first; await drained;
    await wait(() => loadConv(h.env, cv)?.body);
    const before = loadConv(h.env, cv);
    assert.ok(before.body?.includes('h-1'), JSON.stringify(before.body));
    // h-1's box is "far", and far goes dark: its host stops being heard (it's still "working" as far as its last report).
    assert.equal(api(h.env, fx, { caller: owner, path: 'add-box', body: { name: 'far', mayHost: '*' } }).status, 200);
    const far = Object.entries(load(h.env).boxes).find(([, b]) => b.name === 'far')[0];
    const path = join(h.env.LOOM_BOX_DATA, 'delivery/hosts', 'art@p-loren.json');
    const record = readFileSync(path, 'utf8');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(record), house: 'h-999' })); await host; host = undefined; writeFileSync(path, record);
    update(h.env, (s) => {
      s.houses['h-1'].box = far; s.houses['h-1'].nativeHistory = { v: 1, complete: false };
      s.boxes[far].lastSeen = new Date(Date.now() - WRITE_OFF_AFTER_MS - 1000).toISOString();
    });
    // Held while nobody has said it's over: a stale report isn't proof.
    w.clock.advance(1001); await tick(h.env, o);
    assert.equal(loadConv(h.env, cv).body, before.body);
    // The owner writes it off.
    const r = { body: writeOffBox(h.env, fx, { name: 'far', houses: ['h-1'] }) };
    assert.deepEqual(r.body.writtenOff, ['h-1']);
    w.clock.advance(1001); await tick(h.env, o); await tick(h.env, o);
    const after = loadConv(h.env, cv);
    assert.notEqual(after.body, before.body, 'the dark box\'s body is retired');
    assert.equal(after.nativeLossCount, 1);
    assert.equal(after.runLog.findLast((x) => x.run === before.run).contextLost, true);
    // A late word from the written-off house is told to leave, and nothing it says is kept.
    // Its work goes on: kept, marked as reconciliation context, and its next house is asked for on a box that's up.
    assert.equal(after.control?.state, undefined, 'not held: the owner\'s write-off is no hold');
    assert.ok(after.queue.length >= 1 && after.queue.every((x) => x.reconciliation === true || !x.reconciliation));
    assert.ok(after.queue.some((x) => x.reconciliation === true), 'its interrupted work comes back as reconciliation context');
    const next = Object.values(load(h.env).houses).filter((x) => x.id !== 'h-1' && x.agent === 'art');
    assert.ok(next.length && next.every((x) => x.box !== far && x.state === 'wanted'), JSON.stringify(next));
    const late = bodySync(h.env, { kind: 'agent', agent: 'art', house: 'h-1' }, { hostKey: 'x'.repeat(48), report: { bodies: {} } }, { sealer: h.sealer });
    assert.equal(late.exit, true);
  } finally { if (host) { const p = join(h.env.LOOM_BOX_DATA, 'delivery/hosts', 'art@p-loren.json'); const rec = readFileSync(p, 'utf8'); writeFileSync(p, JSON.stringify({ ...JSON.parse(rec), house: 'h-999' })); await host; } await first; }
});

test('the owner is asked once per agent and stretch of silence; his Allow writes off exactly the houses on the card', async () => {
  const { askDarkBoxes, writeOffApproved, writeOffAsk } = await import('../src/dark-box.mjs');
  const h = houseWorld();
  const asked = [], spent = [], withdrawn = [], states = {};
  h.env.LOOM_RUNTIME_TEST_APPROVALS = { request: (target, x) => { asked.push([target, x]); const id = `a-0000000${asked.length}`; states[id] = 'pending'; return id; },
    withdraw: (id) => { withdrawn.push(id); states[id] = 'withdrawn'; }, state: (id) => states[id] ?? 'gone' };
  const spend = (env, id, kind, target, agent, o) => { spent.push([id, kind, target, agent, o?.onBehalf]); states[id] = 'used'; return ''; };
  const fx = { now: () => new Date(), mint: () => 'loom_' + 't'.repeat(31), revoke: () => {} };
  assert.equal(api(h.env, fx, { caller: owner, path: 'add-box', body: { name: 'far', mayHost: '*' } }).status, 200);
  const far = Object.entries(load(h.env).boxes).find(([, b]) => b.name === 'far')[0];
  const last = new Date(Date.now() - WRITE_OFF_AFTER_MS - 60_000).toISOString();
  const T = (agent) => `${agent}:${far}@${Math.floor(Date.parse(last) / 1000)}`;
  update(h.env, (s) => {
    s.boxes[far].lastSeen = last;
    for (const [id, agent] of [['h-7', 'art'], ['h-9', 'mark'], ['h-11', 'art']]) s.houses[id] = { id, agent, box: far, state: 'running' };
  });
  // h-11's own body host still reports (the box's process died, its container didn't): it's running, never on a card.
  const hosts = join(h.env.LOOM_BOX_DATA, 'delivery', 'hosts');
  mkdirSync(hosts, { recursive: true });
  writeFileSync(join(hosts, 'art@p-dana.json'), JSON.stringify({ house: 'h-11', report: { at: Date.now(), house: 'h-11', bodies: {} } }));
  const convs = [{ conversation: 'cv-00000000000a', agent: 'art', body: 'claude:h-7-b0000001' }, { conversation: 'cv-00000000000b', agent: 'art', body: 'codex:h-7-b0000002' },
    { conversation: 'cv-00000000000c', agent: 'mark', body: 'claude:h-9-b0000003' }, { conversation: 'cv-00000000000d', agent: 'art', body: 'claude:h-9-b0000004' },
    { conversation: 'cv-00000000000e', agent: 'art', body: 'claude:h-11-b0000005' }];
  await askDarkBoxes(h.env, { convs });
  await askDarkBoxes(h.env, { convs });
  assert.deepEqual(asked.map((x) => x[0]).sort(), [T('art'), T('mark')], 'one card each, once; another agent\'s house and a house still reporting aren\'t counted');
  const art = asked.find((x) => x[0] === T('art'))[1];
  assert.equal(art.kind, 'box-write-off');
  assert.match(art.ask, /far.*silent for 11 minutes.*Art's 2 conversations/);
  assert.ok(art.ask.length <= 140);
  assert.match(art.details, /houses there: h-7;/);
  const aid = load(h.env).writeOffAsks[`art:${far}`].approval;
  const fields = { id: aid, agent: 'art', target: T('art') };
  // Never anyone else's Allow, never a body's, never for another agent's card, another stretch of silence or a stale one.
  assert.equal(writeOffApproved(h.env, fx, { kind: 'owner', agents: ['art'] }, fields, spend).ok, false);
  assert.equal(writeOffApproved({ ...h.env, HOUSE_ID: 'h-3' }, fx, owner, fields, spend).ok, false);
  assert.equal(writeOffApproved(h.env, fx, owner, { ...fields, agent: 'mark' }, spend).ok, false);
  assert.equal(writeOffApproved(h.env, fx, owner, { ...fields, id: 'a-0000ffff' }, spend).ok, false);
  assert.equal(writeOffApproved(h.env, fx, owner, { ...fields, target: `art:${far}@12345` }, spend).ok, false);
  assert.equal(spent.length, 0, 'nothing is spent for a refused one');
  states[aid] = 'allowed';
  // A house created after the card isn't on it: only the card's houses go.
  update(h.env, (s) => { s.houses['h-13'] = { id: 'h-13', agent: 'art', box: far, state: 'wanted' }; });
  const r = writeOffApproved(h.env, fx, owner, fields, spend);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(spent, [[aid, 'box-write-off', T('art'), 'art', 'owner']]);
  const st = load(h.env);
  assert.equal(st.houses['h-7'].state, 'lost');
  assert.equal(st.houses['h-11'].state, 'running', 'still reporting: not written off');
  assert.equal(st.houses['h-13'].state, 'wanted', 'not on the card');
  assert.equal(st.houses['h-9'].state, 'running', 'mark\'s house waits for his own card');
  // Applied: its ask goes, with no withdraw.
  await askDarkBoxes(h.env, { convs });
  assert.equal(load(h.env).writeOffAsks[`art:${far}`], undefined);
  assert.deepEqual(withdrawn, []);
  // Mark's card expires allowed and unapplied: asked again, as a new card.
  const markAid = load(h.env).writeOffAsks[`mark:${far}`].approval;
  states[markAid] = 'expired';
  await askDarkBoxes(h.env, { convs });
  assert.equal(load(h.env).writeOffAsks[`mark:${far}`], undefined, 'refiled on the next pass, never beside the old one');
  await askDarkBoxes(h.env, { convs });
  const again = load(h.env).writeOffAsks[`mark:${far}`].approval;
  assert.notEqual(again, markAid);
  // One of its houses heard again: the card no longer says what an Allow would do, so it's taken back and asked anew.
  update(h.env, (s) => { s.houses['h-15'] = { id: 'h-15', agent: 'mark', box: far, state: 'running' }; });
  const convs2 = [...convs, { conversation: 'cv-00000000000f', agent: 'mark', body: 'claude:h-15-b0000006' }];
  await askDarkBoxes(h.env, { convs: convs2 });
  assert.ok(withdrawn.includes(again));
  await askDarkBoxes(h.env, { convs: convs2 });
  const grown = load(h.env).writeOffAsks[`mark:${far}`];
  assert.deepEqual(grown.houses, ['h-15', 'h-9']);
  writeFileSync(join(hosts, 'mark@p-dana.json'), JSON.stringify({ house: 'h-15', report: { at: Date.now(), house: 'h-15', bodies: {} } }));
  await askDarkBoxes(h.env, { convs: convs2 });
  assert.ok(withdrawn.includes(grown.approval), 'shrunk: taken back, not left to stall');
  await askDarkBoxes(h.env, { convs: convs2 });
  const shrunk = load(h.env).writeOffAsks[`mark:${far}`];
  assert.deepEqual(shrunk.houses, ['h-9']);
  // The box comes back: its card is withdrawn, and that Allow no longer applies.
  update(h.env, (s) => { s.boxes[far].lastSeen = new Date().toISOString(); });
  assert.match(writeOffAsk(h.env, { agent: 'mark', box: far, target: T('mark'), approval: shrunk.approval }).why, /heard from/);
  await askDarkBoxes(h.env, { convs: convs2 });
  assert.ok(withdrawn.includes(shrunk.approval));
  assert.equal(load(h.env).writeOffAsks[`mark:${far}`], undefined);
});

test('a card that can\'t be taken back is never reused for other houses; a No waits, then asks again', async () => {
  const { askDarkBoxes, writeOffAsk, DENIED_FOR } = await import('../src/dark-box.mjs');
  const h = houseWorld();
  const asked = [], states = {};
  let canWithdraw = false;
  h.env.LOOM_RUNTIME_TEST_APPROVALS = { request: (target) => { asked.push(target); const id = `a-0000000${asked.length}`; states[id] = 'pending'; return id; },
    withdraw: (id) => { if (!canWithdraw) return false; states[id] = 'withdrawn'; return true; }, state: (id) => states[id] ?? 'gone' };
  const fx = { now: () => new Date(), mint: () => 'loom_' + 't'.repeat(31), revoke: () => {} };
  assert.equal(api(h.env, fx, { caller: owner, path: 'add-box', body: { name: 'far', mayHost: '*' } }).status, 200);
  const far = Object.entries(load(h.env).boxes).find(([, b]) => b.name === 'far')[0];
  update(h.env, (s) => {
    s.boxes[far].lastSeen = new Date(Date.now() - WRITE_OFF_AFTER_MS - 60_000).toISOString();
    for (const id of ['h-1', 'h-2']) s.houses[id] = { id, agent: 'art', box: far, state: 'running' };
  });
  const one = [{ conversation: 'cv-00000000000a', agent: 'art', body: 'claude:h-1-b0000001' }];
  const two = [...one, { conversation: 'cv-00000000000b', agent: 'art', body: 'claude:h-2-b0000002' }];
  await askDarkBoxes(h.env, { convs: one });
  const first = load(h.env).writeOffAsks[`art:${far}`];
  assert.deepEqual(first.houses, ['h-1']);
  // h-2 goes quiet too, but the first card can't be taken back: it stays exactly as filed, and nothing new is filed.
  await askDarkBoxes(h.env, { convs: two });
  await askDarkBoxes(h.env, { convs: two });
  assert.equal(asked.length, 1);
  assert.deepEqual(load(h.env).writeOffAsks[`art:${far}`].houses, ['h-1']);
  assert.equal(writeOffAsk(h.env, { agent: 'art', box: far, target: first.target, approval: first.approval }).ask.houses.join(), 'h-1');
  // Taken back: then, on the next pass, a new card with both.
  canWithdraw = true;
  await askDarkBoxes(h.env, { convs: two });
  assert.equal(asked.length, 1);
  await askDarkBoxes(h.env, { convs: two });
  const second = load(h.env).writeOffAsks[`art:${far}`];
  assert.deepEqual(second.houses, ['h-1', 'h-2']);
  assert.notEqual(second.approval, first.approval);
  // He says No: it waits, then asks again after DENIED_FOR.
  states[second.approval] = 'denied';
  await askDarkBoxes(h.env, { convs: two });
  await askDarkBoxes(h.env, { convs: two, nowMs: Date.now() + 3_600_000 });
  assert.equal(load(h.env).writeOffAsks[`art:${far}`].approval, second.approval);
  await askDarkBoxes(h.env, { convs: two, nowMs: Date.now() + DENIED_FOR + 1000 });
  await askDarkBoxes(h.env, { convs: two, nowMs: Date.now() + DENIED_FOR + 2000 });
  assert.notEqual(load(h.env).writeOffAsks[`art:${far}`].approval, second.approval);
});

test('a retry after a filing that may have landed files exactly the houses it first reserved', async () => {
  const { askDarkBoxes } = await import('../src/dark-box.mjs');
  const h = houseWorld();
  const asked = [], states = {};
  h.env.LOOM_RUNTIME_TEST_APPROVALS = { request: (target, x) => { asked.push(x.details); states['a-00000001'] = 'pending'; return 'a-00000001'; },
    withdraw: (id) => { states[id] = 'withdrawn'; return true; }, state: (id) => states[id] ?? 'gone' };
  const fx = { now: () => new Date(), mint: () => 'loom_' + 't'.repeat(31), revoke: () => {} };
  assert.equal(api(h.env, fx, { caller: owner, path: 'add-box', body: { name: 'far', mayHost: '*' } }).status, 200);
  const far = Object.entries(load(h.env).boxes).find(([, b]) => b.name === 'far')[0];
  const last = new Date(Date.now() - WRITE_OFF_AFTER_MS - 60_000).toISOString();
  const target = `art:${far}@${Math.floor(Date.parse(last) / 1000)}`;
  update(h.env, (s) => {
    s.boxes[far].lastSeen = last;
    for (const id of ['h-1', 'h-2']) s.houses[id] = { id, agent: 'art', box: far, state: 'running' };
    // A filing for h-1 timed out an hour ago (it may have landed): only its reservation is left.
    s.writeOffAsks = { [`art:${far}`]: { at: new Date(Date.now() - 3_600_000).toISOString(), target, houses: ['h-1'] } };
  });
  const two = [{ conversation: 'cv-00000000000a', agent: 'art', body: 'claude:h-1-b0000001' }, { conversation: 'cv-00000000000b', agent: 'art', body: 'claude:h-2-b0000002' }];
  await askDarkBoxes(h.env, { convs: two });
  assert.match(asked[0], /houses there: h-1;/);
  assert.deepEqual(load(h.env).writeOffAsks[`art:${far}`].houses, ['h-1']);
  // With its id now, the change is taken up: taken back, then both asked about.
  await askDarkBoxes(h.env, { convs: two });
  assert.equal(states['a-00000001'], 'withdrawn');
  await askDarkBoxes(h.env, { convs: two });
  assert.match(asked.at(-1), /houses there: h-1, h-2;/);
  assert.deepEqual(load(h.env).writeOffAsks[`art:${far}`].houses, ['h-1', 'h-2']);
});

test('a house written off in the middle of its offline collection retires as a loss, not held for a receipt', async () => {
  const { HouseRunner } = await import('../src/houserunner.mjs');
  const { SessionHistoryMissing } = await import('../src/sessions.mjs');
  const h = houseWorld();
  const fx = { now: () => new Date(), mint: () => 'loom_' + 't'.repeat(31), revoke: () => {} };
  assert.equal(api(h.env, fx, { caller: owner, path: 'add-box', body: { name: 'far', mayHost: '*' } }).status, 200);
  const far = Object.entries(load(h.env).boxes).find(([, b]) => b.name === 'far')[0];
  update(h.env, (s) => {
    s.boxes[far].lastSeen = new Date(Date.now() - WRITE_OFF_AFTER_MS - 1000).toISOString();
    s.houses['h-5'] = { id: 'h-5', agent: 'art', box: far, state: 'running', nativeHistory: { v: 1, complete: false, plan: 'p1' }, collection: { phase: 'native' } };
  });
  const hosts = join(h.env.LOOM_BOX_DATA, 'delivery', 'hosts');
  mkdirSync(hosts, { recursive: true });
  writeFileSync(join(hosts, 'art.json'), JSON.stringify({ house: 'h-5', offlineCollection: { plan: 'p1', complete: false, done: {} }, report: { at: 0, house: 'h-5', bodies: {} } }));
  const hr = new HouseRunner(h.env, 'claude', { sealer: h.sealer, poll: 10 });
  const body = { id: 'h-5-b0000009', agent: 'art', house: 'h-5' };
  assert.deepEqual(hr.finalInbox(body), { ready: false }, 'before: waiting on a receipt the dark box will never send');
  writeOffBox(h.env, fx, { name: 'far', houses: ['h-5'] });
  assert.equal(hr.finalInbox(body), undefined);
  assert.equal(hr.pending(body), false);
  assert.equal(hr.unheard(body), null);
  await assert.rejects(hr.pack(body, { deferAck: true }), SessionHistoryMissing);
});
