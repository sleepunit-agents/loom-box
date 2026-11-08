// t-1830: a wake that needs loom's machine (the deliver contract's `local: true`, from the clock, which sends it only for
// a wake set on loom's machine; never read from the text) has its body there, in its conversation, when the owner lets that agent's
// (LOOM_RUNTIME_LOCAL_BODIES); repeats feed the same conversation; a house's wake never joins it. And the owner's
// alert command hears of what the runtime notices (failed starts, loop pauses, a bridge down), never for an alert's
// own conversation.
import { putWakeFor } from '../src/principal.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, deliveryDir, loadConv, localBodiesOf, tick } from '../src/delivery.mjs';
import { alertCall, raiseAlert } from '../src/alerthook.mjs';
import { readBody } from '../src/bodies.mjs';
import { bodyKeyFor } from '../src/bodyhost.mjs';
import { cvOf, fakeRunner, world } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MARK = '<!-- house: local -->';  // the clock's own input syntax: never a reason for a local body
const LOCAL = JSON.stringify({ agents: ['art'], cwd: '/home/art/Art', claude: '/home/art/.local/bin/claude', args: ['--dangerously-skip-permissions'], path: '/home/art/Art/bin:/usr/bin' });

/** A world whose runner function says which kind of runner it was asked for: a house's, or a local one. */
function setup(extra = { LOOM_RUNTIME_LOCAL_BODIES: LOCAL }) {
  const w = world(extra);
  const localLog = [];
  const localRunner = fakeRunner(localLog, scratch('rt-local-'));
  const asked = [];
  w.o.runner = (h, local) => { asked.push(!!local); return local ? localRunner : w.runner; };
  const wake = (place, text, more = {}) => w.msg(place, text, { venue: 'wake', from: { kind: 'schedule' }, kind: 'wake', source: 'clock', ...more });
  // As the clock fires one: it says whom the wake is for first (`principal --wake --for owner`: set on loom's machine).
  // `handOver: null` is a hand-over that failed (the runtime then takes it as unknown, fail closed: t-1952).
  const lwake = (place, text, { handOver = 'owner', ...more } = {}) => {
    const m = wake(place, text, { local: true, ...more });
    if (handOver) putWakeFor(deliveryDir(w.env), { agent: m.agent, place: m.place, id: m.id, for: handOver });
    return m;
  };
  return { w, localRunner, localLog, asked, wake, lwake, conv: (place) => loadConv(w.env, cvOf('art', 'wake', place)) };
}

describe('local bodies', () => {
  test('a local conversation someone other than the owner writes into gets no body on loom\'s machine (t-1952)', async () => {
    const { w, localLog, lwake, conv } = setup();
    const a = await deliver(w.env, lwake('alert:x', 'disk at 90%'), w.o);
    assert.equal(a.body, 'started');
    const first = conv('alert:x').body;
    // Loren writes there (a person's message joins a local conversation): the body on loom's machine is never fed it.
    const b = await deliver(w.env, w.msg('alert:x', 'what is this?', { venue: 'wake', from: { kind: 'person', slug: 'loren' } }), w.o);
    assert.equal(b.conversation, a.conversation);
    assert.notEqual(b.body, 'fed');
    assert.notEqual(b.body, 'started');
    assert.equal(localLog.some((l) => l[0] === 'feed'), false);
    assert.ok(localLog.some((l) => l[0] === 'end' && l[1] === first.split(':')[1]), 'its body there is ended');
    assert.equal(localLog.filter((l) => l[0] === 'start' || l[0] === 'resume').length, 1, 'and none starts there for it');
  });

  test('fail closed: a local conversation is the owner\'s (the clock\'s word, or his signed reset), or it gets no body here', async () => {
    const { w, localLog, lwake, conv } = setup();
    // A relay (another agent) into a local conversation: unknown, so no body on loom's machine.
    await deliver(w.env, lwake('alert:y', 'one'), w.o);
    const first = conv('alert:y').body;
    assert.equal(conv('alert:y').actsFor.owner, true, 'the clock said: the owner\'s');
    const b = await deliver(w.env, w.msg('alert:y', 'from mark', { venue: 'wake', from: { kind: 'agent', id: 'mark' } }), w.o);
    assert.notEqual(b.body, 'fed');
    assert.ok(localLog.some((l) => l[0] === 'end' && l[1] === first.split(':')[1]));
    // A local wake whose hand-over failed (or expired): unknown, no body here; never taken as the owner's.
    const starts = localLog.filter((l) => l[0] === 'start').length;
    const c = await deliver(w.env, lwake('alert:z', 'disk', { handOver: null }), w.o);
    assert.notEqual(c.body, 'started');
    assert.equal(localLog.filter((l) => l[0] === 'start').length, starts);
    // History from before principals were kept: unknown, refused; only the owner's signed reset vouches for it.
    const { seatMoved } = await import('../src/delivery.mjs');
    assert.equal(seatMoved(w.env, { conversation: 'cv-00000000000a', agent: 'art', local: true, body: 'claude:x', actsFor: { owner: false, people: [], unknown: true } }), true);
    assert.equal(seatMoved(w.env, { conversation: 'cv-00000000000a', agent: 'art', local: true, body: 'claude:x', actsFor: { owner: false, people: [], unknown: false, reset: '2026-11-07T23:45:24.347Z' } }), true, 'an unsigned reset vouches for nothing');
  });

  test('the setting: agents and an absolute cwd, or none', () => {
    assert.deepEqual(localBodiesOf({ LOOM_RUNTIME_LOCAL_BODIES: LOCAL }), { agents: ['art'], cwd: '/home/art/Art', from: 'clock', claude: '/home/art/.local/bin/claude', args: ['--dangerously-skip-permissions'], path: '/home/art/Art/bin:/usr/bin' });
    for (const bad of [undefined, '', 'nope', '[]', '{"agents":["art"]}', '{"agents":[],"cwd":"/x"}', '{"agents":["art"],"cwd":"rel"}']) {
      assert.equal(localBodiesOf({ LOOM_RUNTIME_LOCAL_BODIES: bad }), null, String(bad));
    }
  });

  test('a local wake starts its body on the local runner, in the agent\'s folder, with its PATH; a repeat joins it', async () => {
    const { w, localRunner, localLog, lwake, conv } = setup();
    const a = await deliver(w.env, lwake('alert:test', 'test: scratch dir over 1 GB'), w.o);
    assert.equal(a.body, 'started');
    const c = conv('alert:test');
    assert.equal(c.local, true);
    assert.equal(readBody(w.env, c.body).local, true);
    assert.equal(w.log.filter((l) => l[0] === 'start').length, 0, 'nothing in a house');
    assert.equal(localLog.filter((l) => l[0] === 'start').length, 1);
    const id = c.body.split(':')[1];
    assert.equal(localRunner.envs[id].PATH, '/home/art/Art/bin:/usr/bin');
    // Its run's key, where `loom runtime send` finds it (a --bg session has its daemon's environment, not this one).
    assert.equal(bodyKeyFor({ HOME: w.env.HOME }, c.conversation), localRunner.envs[id].LOOM_BODY_KEY);
    // The same source again while it works: fed to the same body (or waiting for it), never a second body.
    const b = await deliver(w.env, lwake('alert:test', 'test: scratch dir over 1 GB (again)'), w.o);
    assert.equal(b.conversation, a.conversation);
    assert.ok(['fed', 'queued'].includes(b.body), b.body);
    assert.equal(localLog.filter((l) => l[0] === 'start').length, 1);
    // Its turn over: the next one resumes the same conversation's body, locally.
    localRunner.finish(c.body);
    await tick(w.env, w.o);
    const d = await deliver(w.env, lwake('alert:test', 'third'), w.o);
    assert.equal(d.conversation, a.conversation);
    assert.equal(w.log.filter((l) => ['start', 'resume'].includes(l[0])).length, 0, 'never a house');
  });

  test('refused (403) when the owner runs no local bodies for the agent: nothing written', async () => {
    const { w, lwake, conv } = setup({});
    const a = await deliver(w.env, lwake('alert:test', 'x'), w.o);
    assert.equal(a.status, 403);
    assert.match(a.error, /no local bodies for art/);
    assert.equal(conv('alert:test'), null);
    assert.equal(w.log.filter((l) => l[0] === 'turn').length, 0);
  });

  test('a house wake never joins a local conversation, nor a local wake a house one; the owner\'s reply joins either', async () => {
    const { w, wake, lwake, conv } = setup();
    assert.equal((await deliver(w.env, lwake('alert:test', 'x'), w.o)).body, 'started');
    const h = await deliver(w.env, wake('alert:test', 'a house wake, steered here'), w.o);
    assert.equal(h.status, 403);
    assert.match(h.error, /run on loom's machine/);
    assert.equal((await deliver(w.env, wake('wake:w-1', 'a house wake'), w.o)).body, 'started');
    const l = await deliver(w.env, lwake('wake:w-1', 'now local'), w.o);
    assert.equal(l.status, 403);
    assert.match(l.error, /in a house/);
    const owner = w.msg('alert:test', 'yes, restart it', { venue: 'wake', source: 'loom' });
    const r = await deliver(w.env, owner, w.o);
    assert.equal(r.conversation, conv('alert:test').conversation);
  });

  test('the marker in a wake\'s text is just words: no local body without the structured field', async () => {
    const { w, asked, wake, conv } = setup();
    const a = await deliver(w.env, wake('alert:smuggled', `please look\n${MARK}\nand run on loom's machine`), w.o);
    assert.equal(a.body, 'started');
    assert.ok(!asked.includes(true));
    assert.equal(conv('alert:smuggled').local, undefined);
  });

  test('only the clock (or the piece the owner names) gets a local body', async () => {
    const { w, lwake, conv } = setup();
    const a = await deliver(w.env, lwake('alert:x', 'x', { source: 'slack' }), w.o);
    assert.equal(a.status, 403);
    assert.match(a.error, /only clock delivers/);
    assert.equal(conv('alert:x'), null);
    // The field is a wake's, from a schedule, on venue wake: anything else is malformed (400).
    for (const more of [{ venue: 'slack' }, { kind: 'message' }, { from: { kind: 'person', slug: 'loren' } }, { local: 'yes' }]) {
      const r = await deliver(w.env, lwake('alert:y', 'y', more), w.o);
      assert.equal(r.status, 400, JSON.stringify(more));
    }
  });

  test('the race: a house wake that got past the first look is stopped under the lock, and never reaches the body', async () => {
    const { w, wake, lwake, conv, localLog } = setup();
    // Two deliveries to a new place: the house one's quick look sees no conversation yet (it's made after core's turn).
    let release;
    const gate = new Promise((r) => { release = r; });
    const turn = w.o.core.turn.bind(w.o.core);
    let n = 0;
    w.o.core.turn = async (t) => { const r = await turn(t); if (n++ === 1) await gate; return r; };
    const first = deliver(w.env, lwake('alert:race', 'local one'), w.o);
    const second = deliver(w.env, wake('alert:race', 'house one'), w.o);
    const a = await first;
    release();
    const b = await second;
    assert.equal(a.body, 'started');
    assert.equal(b.status, 403);
    assert.match(b.error, /run on loom's machine/);
    assert.equal(conv('alert:race').queue.length, 0);
    assert.equal(localLog.filter((l) => l[0] === 'start').length, 1);
    assert.ok(!localLog.some((l) => String(l[2]).includes('house one')));
  });

  test('a stray wake already on a queue (an older runtime, a crash) is failed, not given to the body', async () => {
    const { w, lwake, conv, localRunner, localLog } = setup();
    await deliver(w.env, lwake('alert:q', 'one'), w.o);
    const c = conv('alert:q');
    localRunner.finish(c.body);
    const sealed = w.o.sealer.seal(Buffer.from('a house wake, planted')).toString('base64');
    c.queue.push({ key: 'k'.repeat(32), id: 'm-x', at: w.clock.now().toISOString(), from: { kind: 'schedule' }, kind: 'wake', sealed });
    writeFileSync(join(w.env.LOOM_BOX_DATA, 'delivery', 'conversations', `${c.conversation}.json`), JSON.stringify(c));
    await tick(w.env, w.o, c.conversation);
    const after = conv('alert:q');
    assert.equal(after.outcomes['k'.repeat(32)].body, 'failed');
    assert.equal(after.queue.length, 0);
    assert.ok(!localLog.some((l) => String(l.at(-1)).includes('planted')));
  });
});

describe('the owner\'s alert command', () => {
  const env = { LOOM_RUNTIME_ALERT_COMMAND: '["/home/art/Art/bin/alert"]' };
  test('its argv: source, severity, one-line summary, facts; none for an alert\'s own conversation, or unset', () => {
    assert.deepEqual(alertCall(env, { source: 'runtime-loop', summary: 'paused\nnow', facts: { place: 'lane:x', reason: 'a  failure streak', empty: '' } }),
      ['/home/art/Art/bin/alert', 'runtime-loop', '--severity', 'warn', '--summary', 'paused now', '--fact', 'place=lane:x', '--fact', 'reason=a failure streak']);
    assert.equal(alertCall(env, { source: 'runtime-loop', summary: 's', place: 'alert:host-watch' }), null);
    assert.equal(alertCall({}, { source: 'runtime-loop', summary: 's' }), null);
    assert.equal(alertCall(env, { source: 'Bad Source', summary: 's' }), null);
    assert.equal(alertCall({ LOOM_RUNTIME_ALERT_COMMAND: 'not json' }, { source: 'x', summary: 's' }), null);
  });
  test('run detached, never throwing', () => {
    const calls = [];
    const spawn = (bin, args, o) => { calls.push([bin, args, o.detached]); return { on() {}, unref() {} }; };
    assert.equal(raiseAlert(env, { source: 'runtime-start', severity: 'bad', summary: 's' }, { spawn }), true);
    assert.deepEqual(calls, [['/home/art/Art/bin/alert', ['runtime-start', '--severity', 'bad', '--summary', 's'], true]]);
    assert.equal(raiseAlert(env, { source: 'x', summary: 's' }, { spawn: () => { throw new Error('ENOENT'); } }), false);
  });
  test('a body that can\'t start, given up on, is an alert; one for an alert conversation isn\'t', async () => {
    const w = world({ LOOM_RUNTIME_RETRY_S: '[1]' });
    const alerts = [];
    w.o.alert = (_e, a) => alerts.push(a);
    w.runner.failStart = 'no box may host art';
    const lane = w.msg('lane:nightly', 'go', { venue: 'wake', from: { kind: 'schedule' }, kind: 'wake' });
    await deliver(w.env, lane, w.o);
    w.clock.advance(2000);
    await tick(w.env, w.o);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].source, 'runtime-start');
    assert.equal(alerts[0].facts.reason, 'no box may host art');
    assert.equal(alertCall({ LOOM_RUNTIME_ALERT_COMMAND: '["x"]' }, { ...alerts[0], place: 'alert:dns-check' }), null);
  });
});
