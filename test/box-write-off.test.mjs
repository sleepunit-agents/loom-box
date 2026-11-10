// A box gone dark mid-turn (t-2057): the owner writes off its houses, and their conversations go on elsewhere.
// Its bodies are retired as terminated without history (their notice says effects may already have happened), the
// next body goes to a house on a box that's up, and if the dark box comes back it's told to stop them and nothing they
// say is taken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, loadConv, tick } from '../src/delivery.mjs';
import { load, update } from '../src/state.mjs';
import { WRITE_OFF_AFTER_MS, api } from '../src/control.mjs';
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
  assert.equal(api(h.env, fx, { caller: { kind: 'agent', agent: 'art' }, path: 'box-write-off', body: { name: 'far' } }).status, 403);
  assert.equal(api(h.env, fx, { caller: { kind: 'owner', agents: ['art'] }, path: 'box-write-off', body: { name: 'far' } }).status, 403, 'a scoped owner token');
  assert.equal(api(h.env, fx, { caller: owner, path: 'box-write-off', body: { name: 'far' } }).status, 409, 'heard from a minute ago');
  assert.equal(api(h.env, fx, { caller: owner, path: 'box-write-off', body: { name: 'one' } }).status, 409, 'loom\'s own box');
  update(h.env, (s) => { s.boxes[far].lastSeen = new Date(Date.now() - WRITE_OFF_AFTER_MS - 1000).toISOString(); });
  const r = api(h.env, fx, { caller: owner, path: 'box-write-off', body: { name: 'far' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.writtenOff, ['h-7']);
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
    const r = api(h.env, fx, { caller: owner, path: 'box-write-off', body: { name: 'far' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
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

test('the owner is asked once per agent and dark box; his Allow writes off exactly that, and a box that\'s back withdraws it', async () => {
  const { askDarkBoxes, writeOffApproved, writeOffProblem } = await import('../src/dark-box.mjs');
  const h = houseWorld();
  const asked = [], spent = [], withdrawn = [];
  h.env.LOOM_RUNTIME_TEST_APPROVALS = { request: (target, x) => { asked.push([target, x]); return `a-0000000${asked.length}`; }, withdraw: (id) => withdrawn.push(id) };
  const spend = (env, id, kind, target, agent, o) => { spent.push([id, kind, target, agent, o?.onBehalf]); return ''; };
  const fx = { now: () => new Date(), mint: () => 'loom_' + 't'.repeat(31), revoke: () => {} };
  assert.equal(api(h.env, fx, { caller: owner, path: 'add-box', body: { name: 'far', mayHost: '*' } }).status, 200);
  const far = Object.entries(load(h.env).boxes).find(([, b]) => b.name === 'far')[0];
  update(h.env, (s) => {
    s.boxes[far].lastSeen = new Date(Date.now() - WRITE_OFF_AFTER_MS - 60_000).toISOString();
    s.houses['h-7'] = { id: 'h-7', agent: 'art', box: far, state: 'running' };
    s.houses['h-9'] = { id: 'h-9', agent: 'mark', box: far, state: 'running' };
  });
  const convs = [{ conversation: 'cv-00000000000a', agent: 'art', body: 'claude:h-7-b0000001' }, { conversation: 'cv-00000000000b', agent: 'art', body: 'codex:h-7-b0000002' },
    { conversation: 'cv-00000000000c', agent: 'mark', body: 'claude:h-9-b0000003' }, { conversation: 'cv-00000000000d', agent: 'art', body: 'claude:h-9-b0000004' }];
  const runtimeAs = (agent) => JSON.stringify({ kind: 'agent', agent, house: 'loom\'s runtime' });
  await askDarkBoxes(h.env, { convs, runtimeAs });
  await askDarkBoxes(h.env, { convs, runtimeAs });
  assert.deepEqual(asked.map((x) => x[0]).sort(), [`art:${far}`, `mark:${far}`], 'one card each, once; a body in another agent\'s house isn\'t counted');
  const art = asked.find((x) => x[0] === `art:${far}`)[1];
  assert.equal(art.kind, 'box-write-off');
  assert.match(art.ask, /far.*silent for 11 minutes.*Art's 2 conversations/);
  assert.ok(art.ask.length <= 140);
  const aid = load(h.env).writeOffAsks[`art:${far}`].approval;
  const fields = { id: aid, agent: 'art', target: `art:${far}` };
  // Never anyone else's Allow, never a body's, never for another agent's card or a stale one.
  assert.equal(writeOffApproved(h.env, fx, { kind: 'owner', agents: ['art'] }, fields, spend).ok, false);
  assert.equal(writeOffApproved({ ...h.env, HOUSE_ID: 'h-3' }, fx, owner, fields, spend).ok, false);
  assert.equal(writeOffApproved(h.env, fx, owner, { ...fields, agent: 'mark' }, spend).ok, false);
  assert.equal(writeOffApproved(h.env, fx, owner, { ...fields, id: 'a-0000ffff' }, spend).ok, false);
  assert.equal(spent.length, 0, 'nothing is spent for a refused one');
  const r = writeOffApproved(h.env, fx, owner, fields, spend);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(spent, [[aid, 'box-write-off', `art:${far}`, 'art', 'owner']]);
  assert.equal(load(h.env).houses['h-7'].state, 'lost');
  assert.equal(load(h.env).houses['h-9'].state, 'running', 'mark\'s house waits for his own card');
  // Applied: its ask goes, with no withdraw. Mark's box comes back: his card is withdrawn.
  await askDarkBoxes(h.env, { convs, runtimeAs });
  assert.equal(load(h.env).writeOffAsks[`art:${far}`], undefined);
  assert.deepEqual(withdrawn, []);
  update(h.env, (s) => { s.boxes[far].lastSeen = new Date().toISOString(); });
  assert.match(writeOffProblem(h.env, { agent: 'mark', box: far, approval: load(h.env).writeOffAsks[`mark:${far}`].approval }), /heard from/);
  await askDarkBoxes(h.env, { convs, runtimeAs });
  assert.deepEqual(withdrawn, ['a-00000002']);
  assert.equal(load(h.env).writeOffAsks[`mark:${far}`], undefined);
});
