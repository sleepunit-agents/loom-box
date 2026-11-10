// t-2103: a body's run key (LOOM_BODY_KEY) is good only for its run. Once the run ends (its body retired, evicted,
// released, interrupted or stopped), every call that takes a body's proof refuses that key, even with the old body's
// own session; the conversation's next run gets a fresh key, and the old one stays refused. Its hash goes off the
// conversation's record, and on loom's machine its key file (bodyhost.mjs, keyFile) goes too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { bodyPrincipal, continuationCall, deliver, deliveryDir, heldConv, holdsRun, loadConv, releaseBody, send, tick } from '../src/delivery.mjs';
import { putWakeFor } from '../src/principal.mjs';
import { bodyKeyFor, keepKey, keyFile } from '../src/bodyhost.mjs';
import { fileOf } from '../src/files.mjs';
import { cvOf, fakeRunner, world } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';

const idOf = (ref) => ref.split(':')[1];

/** Every call that takes a body's proof, asked with `proof`: true where it took it. */
async function proofs(w, cv, proof) {
  const sent = await send(w.env, { conversation: cv, text: 'hello', ...proof }, w.o);
  const principal = bodyPrincipal(w.env, { conversation: cv, ...proof }, w.o);
  let cont;
  try { continuationCall(w.env, { action: 'issue', conversation: cv, ...proof }, w.o); cont = true; } catch (e) { cont = !/only the body holding/.test(e.message) ? `threw: ${e.message}` : false; }
  const file = await fileOf(w.env, cv, 'F1', 0, proof, undefined, { ...w.o, venues: async () => ({}) });
  return {
    send: sent.accepted === true,
    principal: principal.ok === true,
    continuation: cont,
    // The relay's origin proof (relay.mjs, originOf and its approval's principal), and `place` (gates-api.mjs).
    holdsRun: holdsRun(w.env, cv, proof, w.o),
    heldConv: !!heldConv(w.env, cv, proof, w.o),
    // A proven body gets past the proof to the venue (which keeps no files here); an unproven one doesn't.
    file: !/only the body holding/.test(file.reason ?? ''),
  };
}
const ALL = { send: true, principal: true, continuation: true, holdsRun: true, heldConv: true, file: true };
const NONE = { send: false, principal: false, continuation: false, holdsRun: false, heldConv: false, file: false };

/** A conversation's first run, its key and session as its body was given them. */
async function firstRun() {
  const w = world();
  await deliver(w.env, w.msg('dm:A', 'one'), w.o);
  const cv = cvOf('art', 'slack', 'dm:A');
  const c = loadConv(w.env, cv);
  const key = w.runner.envs[idOf(c.body)].LOOM_BODY_KEY;
  const session = w.sessionFor(cv);
  assert.ok(key && session);
  assert.deepEqual(await proofs(w, cv, { key, session }), ALL, 'its own run takes its key');
  return { w, cv, key, session, body: c.body };
}

/** After the run ends: its key, with its session, proves nothing; the record keeps no hash of it. */
async function dead(w, cv, key, session) {
  const c = loadConv(w.env, cv);
  assert.equal(c.body, undefined, 'its run is over: no body holds the conversation');
  assert.equal(c.sendKey, undefined, 'the ended run\'s key is off the record');
  assert.deepEqual(await proofs(w, cv, { key, session }), NONE);
}

/** The conversation's next run: a fresh key, which works; the old one, from either session, stays refused. */
async function nextRun(w, cv, key, session) {
  await deliver(w.env, w.msg('dm:A', 'again'), w.o);
  const c = loadConv(w.env, cv);
  assert.ok(c.body, 'a new run holds it');
  const key2 = w.runner.envs[idOf(c.body)].LOOM_BODY_KEY;
  const session2 = w.sessionFor(cv);
  assert.notEqual(key2, key, 'a new run is given a new key');
  assert.deepEqual(await proofs(w, cv, { key: key2, session: session2 }), ALL);
  assert.deepEqual(await proofs(w, cv, { key, session: session2 }), NONE, 'the old key, in the new session');
  assert.deepEqual(await proofs(w, cv, { key, session }), NONE, 'the old key, in the old session');
}

test('a body that ended on its own: its key dies with its run, and its next run has another', async () => {
  const { w, cv, key, session, body } = await firstRun();
  w.runner.dead.add(idOf(body));
  await tick(w.env, w.o);
  await dead(w, cv, key, session);
  await nextRun(w, cv, key, session);
});

test('a body evicted idle: its key dies with its run', async () => {
  const { w, cv, key, session, body } = await firstRun();
  w.runner.finish(body);
  await tick(w.env, w.o);
  w.clock.advance(24 * 3600_000);
  await tick(w.env, w.o);
  await dead(w, cv, key, session);
  await nextRun(w, cv, key, session);
});

test('a body the owner ended (body end): its key dies with its run', async () => {
  const { w, cv, key, session, body } = await firstRun();
  assert.deepEqual(releaseBody(w.env, body), [cv]);
  await dead(w, cv, key, session);
  await nextRun(w, cv, key, session);
});

test('while its run holds the conversation, its key proves that conversation and no other', async () => {
  // Mid-turn its key is good: that's the run it was made for. It never proves another conversation, in any session.
  const { w, cv, key, session } = await firstRun();
  const other = cvOf('art', 'slack', 'dm:B');
  await deliver(w.env, w.msg('dm:B', 'two'), w.o);
  assert.deepEqual(await proofs(w, other, { key, session }), NONE, 'never another conversation\'s');
  assert.deepEqual(await proofs(w, other, { key, session: w.sessionFor(other) }), NONE);
  assert.deepEqual(await proofs(w, cv, { key, session }), ALL);
});

test('on loom\'s machine, an ended run\'s key file goes with it, and a newer run\'s is kept', async () => {
  const LOCAL = JSON.stringify({ agents: ['art'], cwd: '/home/art/Art', claude: '/home/art/.local/bin/claude', args: [], path: '/usr/bin' });
  const w = world({ LOOM_RUNTIME_LOCAL_BODIES: LOCAL });
  const local = fakeRunner([], scratch('rt-local-'));
  w.o.runner = (_h, isLocal) => (isLocal ? local : w.runner);
  const lwake = (text) => {
    const m = w.msg('alert:x', text, { venue: 'wake', from: { kind: 'schedule' }, kind: 'wake', source: 'clock', local: true });
    putWakeFor(deliveryDir(w.env), { agent: m.agent, place: m.place, id: m.id, for: 'owner' });
    return m;
  };
  await deliver(w.env, lwake('disk at 90%'), w.o);
  const cv = cvOf('art', 'wake', 'alert:x');
  const c = loadConv(w.env, cv);
  assert.equal(c.local, true);
  const key = local.envs[idOf(c.body)].LOOM_BODY_KEY;
  const session = local.slotOf({ id: idOf(c.body) }).session;
  const f = keyFile(w.env, cv);
  assert.equal(bodyKeyFor(w.env, cv), key, 'its CLI reads its run\'s key from the keys dir');
  assert.equal(holdsRun(w.env, cv, { key, session }, w.o), true);
  local.dead.add(idOf(c.body));
  await tick(w.env, w.o);
  assert.equal(loadConv(w.env, cv).body, undefined);
  assert.equal(existsSync(f), false, 'the ended run\'s key file is gone');
  assert.equal(holdsRun(w.env, cv, { key, session }, w.o), false);
  await deliver(w.env, lwake('disk at 95%'), w.o);
  const c2 = loadConv(w.env, cv);
  const key2 = local.envs[idOf(c2.body)].LOOM_BODY_KEY;
  assert.notEqual(key2, key);
  assert.equal(bodyKeyFor(w.env, cv), key2, 'the new run\'s file is its own');
  assert.equal(holdsRun(w.env, cv, { key, session: local.slotOf({ id: idOf(c2.body) }).session }, w.o), false);
});

test('on loom\'s machine, a key file that already holds another key is not the ended run\'s to remove', async () => {
  const LOCAL = JSON.stringify({ agents: ['art'], cwd: '/home/art/Art', claude: '/home/art/.local/bin/claude', args: [], path: '/usr/bin' });
  const w = world({ LOOM_RUNTIME_LOCAL_BODIES: LOCAL });
  const local = fakeRunner([], scratch('rt-local-'));
  w.o.runner = (_h, isLocal) => (isLocal ? local : w.runner);
  const m = w.msg('alert:y', 'disk at 90%', { venue: 'wake', from: { kind: 'schedule' }, kind: 'wake', source: 'clock', local: true });
  putWakeFor(deliveryDir(w.env), { agent: m.agent, place: m.place, id: m.id, for: 'owner' });
  await deliver(w.env, m, w.o);
  const cv = cvOf('art', 'wake', 'alert:y');
  const c = loadConv(w.env, cv);
  // Another key written over it before the run's end (a newer launch's): kept, while the ended run's hash still goes.
  keepKey(w.env, cv, 'n'.repeat(32));
  local.dead.add(idOf(c.body));
  await tick(w.env, w.o);
  const after = loadConv(w.env, cv);
  assert.equal(after.body, undefined);
  assert.equal(after.sendKey, undefined);
  assert.equal(readFileSync(keyFile(w.env, cv), 'utf-8').trim(), 'n'.repeat(32));
});
