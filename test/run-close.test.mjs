// A body's end closes its run (t-1958): a conversation whose body was ended (reseated, resumed warm) no longer counts
// as at work (relay.mjs, atWork), so an unproven relay from the conversation that is at work gets its answer back. One
// whose end failed may still be mid-turn: its run stays open, as #99's review asked. And a read-only list of the runs
// left open before this, whose body is gone (staleRuns), for the day's sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, deliveryDir, loadConv, staleRuns } from '../src/delivery.mjs';
import { cvOf, world } from './delivery-world.mjs';

function household(env) {
  const dir = join(env.HOME, '.config', 'loom');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }] }));
  return env;
}
const person = (slug) => ({ from: { kind: 'person', slug } });
const runOf = (c, ref) => c.runLog.findLast((r) => r.body === ref);

/** Mid-turn in the owner's place, Loren writes: the body in his house is ended and the conversation reseated. */
async function reseated(o = {}) {
  const w = world();
  household(w.env);
  w.runner.houses = { owner: 'h-1', 'p-loren': 'h-2' };
  if (o.endFails) w.runner.end = () => { throw new Error('its house is unreachable'); };
  if (o.stopOnly) w.runner.end = () => {};
  const J = cvOf('art', 'slack', 'group:G');
  await deliver(w.env, w.msg('group:G', 'here is the plan', person('jonathan')), w.o);
  const first = loadConv(w.env, J).body;
  assert.equal(Number.isFinite(runOf(loadConv(w.env, J), first).end), false, 'mid-turn, its run is open');
  // Her house can't start one now: no next run opens (openRun would close the old one), so the end alone must.
  w.runner.failStart = 'her house is at its cap';
  await deliver(w.env, w.msg('group:G', 'and merge mine too', person('loren')), w.o);
  return { w, J, first };
}

test('a body ended mid-turn (its conversation moved house) closes the run it held', async () => {
  const { w, J, first } = await reseated();
  const c = loadConv(w.env, J);
  assert.equal(c.body, undefined, 'no body on its record');
  assert.ok(w.log.some((l) => l[0] === 'end' && l[1] === first.split(':')[1]), 'the owner\'s body is ended');
  assert.ok(Number.isFinite(runOf(c, first).end), 'the ended body\'s run is closed');
  assert.deepEqual(staleRuns(w.env), [], 'nothing left open');
});

test('a body whose stop was only asked for (its house carries it out later) keeps its run open', async () => {
  // A house's end writes a stop for its host and returns (houserunner.mjs, end): the record says ended, the body works.
  const { w, J, first } = await reseated({ stopOnly: true });
  const c = loadConv(w.env, J);
  assert.equal(c.body, undefined);
  assert.equal(Number.isFinite(runOf(c, first).end), false, 'still mid-turn as its harness says: its run stays open');
});

test('a body whose end failed keeps its run open: it may still be mid-turn', async () => {
  const { w, J, first } = await reseated({ endFails: true });
  const c = loadConv(w.env, J);
  assert.equal(c.body, undefined, 'its record lost the body (as a reseat does)');
  assert.equal(Number.isFinite(runOf(c, first).end), false, 'its run stays open: the body may still be mid-turn');
  assert.deepEqual(staleRuns(w.env).map((x) => [x.conversation, x.bodyState]), [[J, 'live']], 'and the dry run says so');
});

test('staleRuns lists open runs whose body is gone, and changes nothing', async () => {
  const w = world();
  household(w.env);
  const J = cvOf('art', 'slack', 'group:G');
  await deliver(w.env, w.msg('group:G', 'one', person('jonathan')), w.o);
  const K = cvOf('art', 'slack', 'group:K');
  await deliver(w.env, w.msg('group:K', 'two', person('jonathan')), w.o);
  // J as the old code left it: its body ended and lost from the record, its run still open.
  const f = join(deliveryDir(w.env), 'conversations', `${J}.json`);
  const c = JSON.parse(readFileSync(f));
  const ref = c.body;
  const bf = join(w.env.LOOM_BOX_DATA, 'bodies', `${ref.replace(':', '-')}.json`);
  writeFileSync(bf, JSON.stringify({ ...JSON.parse(readFileSync(bf)), ended: new Date().toISOString() }));
  delete c.body;
  writeFileSync(f, JSON.stringify(c));
  const before = readFileSync(f, 'utf-8');
  const l = staleRuns(w.env);
  assert.deepEqual(l.map((x) => [x.conversation, x.body, x.bodyState]), [[J, ref, 'ended']], 'K is at work: never listed');
  assert.equal(readFileSync(f, 'utf-8'), before, 'read only');
});
