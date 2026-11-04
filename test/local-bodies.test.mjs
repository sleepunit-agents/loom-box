// t-1830: a wake that needs loom's machine (`<!-- house: local -->`, which the clock sends only for a wake set on loom's
// machine or one the owner approved) has its body there, in its conversation, when the owner lets that agent's
// (LOOM_RUNTIME_LOCAL_BODIES); repeats feed the same conversation; a house's wake never joins it. And the owner's
// alert command hears of what the runtime notices (failed starts, loop pauses, a bridge down), never for an alert's
// own conversation.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, loadConv, localBodiesOf, tick } from '../src/delivery.mjs';
import { alertCall, raiseAlert } from '../src/alerthook.mjs';
import { readBody } from '../src/bodies.mjs';
import { cvOf, fakeRunner, world } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';

const MARK = '<!-- house: local -->';
const LOCAL = JSON.stringify({ agents: ['art'], cwd: '/home/art/Art', claude: '/home/art/.local/bin/claude', args: ['--dangerously-skip-permissions'], path: '/home/art/Art/bin:/usr/bin' });

/** A world whose runner function says which kind of runner it was asked for: a house's, or a local one. */
function setup(extra = { LOOM_RUNTIME_LOCAL_BODIES: LOCAL }) {
  const w = world(extra);
  const localLog = [];
  const localRunner = fakeRunner(localLog, scratch('rt-local-'));
  const asked = [];
  w.o.runner = (h, local) => { asked.push(!!local); return local ? localRunner : w.runner; };
  const wake = (place, text) => w.msg(place, text, { venue: 'wake', from: { kind: 'schedule' }, kind: 'wake', source: 'clock' });
  return { w, localRunner, localLog, asked, wake, conv: (place) => loadConv(w.env, cvOf('art', 'wake', place)) };
}

describe('local bodies', () => {
  test('the setting: agents and an absolute cwd, or none', () => {
    assert.deepEqual(localBodiesOf({ LOOM_RUNTIME_LOCAL_BODIES: LOCAL }), { agents: ['art'], cwd: '/home/art/Art', claude: '/home/art/.local/bin/claude', args: ['--dangerously-skip-permissions'], path: '/home/art/Art/bin:/usr/bin' });
    for (const bad of [undefined, '', 'nope', '[]', '{"agents":["art"]}', '{"agents":[],"cwd":"/x"}', '{"agents":["art"],"cwd":"rel"}']) {
      assert.equal(localBodiesOf({ LOOM_RUNTIME_LOCAL_BODIES: bad }), null, String(bad));
    }
  });

  test('a local wake starts its body on the local runner, in the agent\'s folder, with its PATH; a repeat joins it', async () => {
    const { w, localRunner, localLog, wake, conv } = setup();
    const a = await deliver(w.env, wake('alert:test', `${MARK}\ntest: scratch dir over 1 GB`), w.o);
    assert.equal(a.body, 'started');
    const c = conv('alert:test');
    assert.equal(c.local, true);
    assert.equal(readBody(w.env, c.body).local, true);
    assert.equal(w.log.filter((l) => l[0] === 'start').length, 0, 'nothing in a house');
    assert.equal(localLog.filter((l) => l[0] === 'start').length, 1);
    const id = c.body.split(':')[1];
    assert.equal(localRunner.envs[id].PATH, '/home/art/Art/bin:/usr/bin');
    // The same source again while it works: fed to the same body (or waiting for it), never a second body.
    const b = await deliver(w.env, wake('alert:test', `${MARK}\ntest: scratch dir over 1 GB (again)`), w.o);
    assert.equal(b.conversation, a.conversation);
    assert.ok(['fed', 'queued'].includes(b.body), b.body);
    assert.equal(localLog.filter((l) => l[0] === 'start').length, 1);
    // Its turn over: the next one resumes the same conversation's body, locally.
    localRunner.finish(c.body);
    await tick(w.env, w.o);
    const d = await deliver(w.env, wake('alert:test', `${MARK}\nthird`), w.o);
    assert.equal(d.conversation, a.conversation);
    assert.equal(w.log.filter((l) => ['start', 'resume'].includes(l[0])).length, 0, 'never a house');
  });

  test('refused (403) when the owner runs no local bodies for the agent: nothing written', async () => {
    const { w, wake, conv } = setup({});
    const a = await deliver(w.env, wake('alert:test', `${MARK}\nx`), w.o);
    assert.equal(a.status, 403);
    assert.match(a.error, /no local bodies for art/);
    assert.equal(conv('alert:test'), null);
    assert.equal(w.log.filter((l) => l[0] === 'turn').length, 0);
  });

  test('a house wake never joins a local conversation, nor a local wake a house one; the owner\'s reply joins either', async () => {
    const { w, wake, conv } = setup();
    assert.equal((await deliver(w.env, wake('alert:test', `${MARK}\nx`), w.o)).body, 'started');
    const h = await deliver(w.env, wake('alert:test', 'a house wake, steered here'), w.o);
    assert.equal(h.status, 403);
    assert.match(h.error, /run on loom's machine/);
    assert.equal((await deliver(w.env, wake('wake:w-1', 'a house wake'), w.o)).body, 'started');
    const l = await deliver(w.env, wake('wake:w-1', `${MARK}\nnow local`), w.o);
    assert.equal(l.status, 403);
    assert.match(l.error, /in a house/);
    const owner = w.msg('alert:test', 'yes, restart it', { venue: 'wake', source: 'loom' });
    const r = await deliver(w.env, owner, w.o);
    assert.equal(r.conversation, conv('alert:test').conversation);
  });

  test('a marker on another venue, or in a person\'s message, is just words', async () => {
    const { w, asked } = setup();
    const a = await deliver(w.env, w.msg('C1', `${MARK} please`), w.o);
    assert.equal(a.body, 'started');
    assert.ok(!asked.includes(true));
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
