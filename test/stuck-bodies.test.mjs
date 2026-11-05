// t-1858: a body the runtime starts on loom's machine (a local wake's, an alert triage) runs with nobody at its
// terminal. One that stops on a permission prompt would wait forever (d35895b1, 2026-11-04: an alert triage for
// art-chain-check, hours). The tick sees it waiting (`claude agents --json`: status waiting, waitingFor a permission
// prompt), and after LOOM_RUNTIME_STUCK_AFTER minutes (default 10), counted from when it first saw it waiting, stops
// it (its session kept in its slot), notes it on the task its label names, tells the owner, and says it once.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliver, deliveryNotices, loadConv, stuckAfterOf, tick } from '../src/delivery.mjs';
import { ClaudeRunner } from '../src/runners.mjs';
import { lastToolUse, redact } from '../src/stuck.mjs';
import { cvOf, fakeRunner, world } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LOCAL = JSON.stringify({ agents: ['art'], cwd: '/home/art/Art', args: ['--dangerously-skip-permissions'] });
const MIN = 60_000;

function setup(extra = {}) {
  const w = world({ LOOM_RUNTIME_LOCAL_BODIES: LOCAL, ...extra });
  const localLog = [];
  const localRunner = fakeRunner(localLog, scratch('rt-stuck-'));
  w.o.runner = (h, local) => (local ? localRunner : w.runner);
  const alerts = [];
  w.o.alert = (_e, a) => alerts.push(a);
  const comments = [];
  w.o.comment = (task, text) => { comments.push([task, text]); return true; };
  const lwake = (place, text, label) => w.msg(place, text, { venue: 'wake', from: { kind: 'schedule' }, kind: 'wake', source: 'clock', local: true, label });
  const conv = (place) => loadConv(w.env, cvOf('art', 'wake', place));
  const idOf = (place) => conv(place).body.split(':')[1];
  const ended = (id) => localLog.some((l) => l[0] === 'end' && l[1] === id);
  return { w, localRunner, localLog, alerts, comments, lwake, conv, idOf, ended };
}

describe('a local body stuck on a permission prompt', () => {
  test('waiting past the threshold: stopped, noted on its task, said once; one still working is left alone', async () => {
    const { w, localRunner, alerts, comments, lwake, conv, idOf, ended } = setup();
    await deliver(w.env, lwake('wake:w-stuck', 'run the chain check', 't-40 round 12'), w.o);
    await deliver(w.env, lwake('wake:w-busy', 'a long build', 't-41 build'), w.o);
    const stuck = idOf('wake:w-stuck');
    const busy = idOf('wake:w-busy');
    localRunner.waits[stuck] = { tool: 'Bash', what: 'taskstore comment t-40 "a `quoted` thing" Authorization: Bearer abcdefghijklmnop' };

    await tick(w.env, w.o);                   // first seen waiting: the clock starts here
    w.clock.advance(9 * MIN);
    await tick(w.env, w.o);
    assert.equal(ended(stuck), false, 'not before its 10 minutes');
    assert.equal(alerts.length, 0);

    w.clock.advance(2 * MIN);
    await tick(w.env, w.o);
    assert.equal(ended(stuck), true, 'stopped past its 10 minutes');
    assert.equal(ended(busy), false, 'a working body is never touched');
    assert.equal(conv('wake:w-stuck').body, undefined);
    assert.ok(conv('wake:w-stuck').slot, 'its session kept: the conversation resumes');

    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].source, 'runtime-stuck');
    assert.equal(alerts[0].facts.minutes, 11);
    assert.equal(JSON.stringify(alerts[0]).includes('Bearer'), false, 'the alert shows none of the command');

    assert.equal(comments.length, 1);
    assert.equal(comments[0][0], 't-40');
    assert.match(comments[0][1], /permission prompt/);
    assert.match(comments[0][1], /Bash/);
    assert.equal(comments[0][1].includes('abcdefghijklmnop'), false, 'its command is redacted');

    assert.equal(deliveryNotices(w.env, w.clock.now().getTime()).filter((n) => /permission prompt/.test(n.text)).length, 1);
    // Its run was a failure, on the conversation's record (loops.mjs counts it).
    assert.match(conv('wake:w-stuck').runLog.at(-1).fail, /permission prompt/);

    w.clock.advance(10 * MIN);
    await tick(w.env, w.o);
    assert.equal(alerts.length, 1, 'said once');
    assert.equal(comments.length, 1);
  });

  test('waiting, then working again: the clock starts over', async () => {
    const { w, localRunner, lwake, idOf, ended } = setup();
    await deliver(w.env, lwake('wake:w-1', 'go', 'lane'), w.o);
    const id = idOf('wake:w-1');
    localRunner.waits[id] = { tool: 'Bash', what: 'x' };
    await tick(w.env, w.o);
    w.clock.advance(8 * MIN);
    delete localRunner.waits[id];
    await tick(w.env, w.o);
    localRunner.waits[id] = { tool: 'Bash', what: 'x' };
    w.clock.advance(4 * MIN);
    await tick(w.env, w.o);
    assert.equal(ended(id), false, '4 minutes this time, not 12');
  });

  test('an alert triage (no task in its label): stopped and the owner hears, with no comment', async () => {
    const { w, localRunner, comments, lwake, idOf, ended } = setup();
    await deliver(w.env, lwake('alert:art-chain-check', 'art-chain-check: 2 dead chains', undefined), w.o);
    const id = idOf('alert:art-chain-check');
    localRunner.waits[id] = { tool: 'Bash', what: 'x' };
    await tick(w.env, w.o);
    w.clock.advance(10 * MIN);
    await tick(w.env, w.o);
    assert.equal(ended(id), true);
    assert.equal(comments.length, 0);
    assert.equal(deliveryNotices(w.env, w.clock.now().getTime()).filter((n) => /permission prompt/.test(n.text)).length, 1);
  });

  test('LOOM_RUNTIME_STUCK_AFTER: minutes, default 10; 0 or off is never', async () => {
    assert.equal(stuckAfterOf({}), 10 * MIN);
    assert.equal(stuckAfterOf({ LOOM_RUNTIME_STUCK_AFTER: '3' }), 3 * MIN);
    assert.equal(stuckAfterOf({ LOOM_RUNTIME_STUCK_AFTER: 'nonsense' }), 10 * MIN);
    for (const off of ['0', 'off', 'never']) assert.equal(stuckAfterOf({ LOOM_RUNTIME_STUCK_AFTER: off }), null);
    const { w, localRunner, lwake, idOf, ended } = setup({ LOOM_RUNTIME_STUCK_AFTER: 'off' });
    await deliver(w.env, lwake('wake:w-1', 'go', 'lane'), w.o);
    const id = idOf('wake:w-1');
    localRunner.waits[id] = { tool: 'Bash', what: 'x' };
    await tick(w.env, w.o);
    w.clock.advance(60 * MIN);
    await tick(w.env, w.o);
    assert.equal(ended(id), false);
  });
});

describe('the Claude runner says when a body waits on a permission prompt', () => {
  test('from `claude agents --json`: status waiting and waitingFor a permission prompt; and what it waits on', () => {
    const D = scratch('rt-stuck-harness-');
    const env = { ...process.env, FAKE_HARNESS: D };
    const projects = join(D, 'projects');
    const r = new ClaudeRunner({ claude: join(here, 'fake-claude.mjs'), jobsDir: join(D, 'jobs'), projectsDir: projects, sleep: () => {} });
    const a = r.start({ brief: 'one', cwd: D, env });
    const b = r.start({ brief: 'two', cwd: D, env });
    const agents = JSON.parse(readFileSync(join(D, 'agents.json'), 'utf-8'));
    for (const x of agents) if (x.id === a.id) Object.assign(x, { status: 'waiting', waitingFor: 'permission prompt' });
    for (const x of agents) if (x.id === b.id) Object.assign(x, { status: 'busy', waitingFor: 'permission prompt' });
    writeFileSync(join(D, 'agents.json'), JSON.stringify(agents));
    const session = a.slot.session;
    mkdirSync(join(projects, '-home-art-Art'), { recursive: true });
    writeFileSync(join(projects, '-home-art-Art', `${session}.jsonl`), [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } }),
      'not json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'now' }, { type: 'tool_use', name: 'Bash', input: { command: 'git push https://user:ghp_abcdefghijklmnopqrstuvwx@github.com/x' } }] } }),
    ].join('\n') + '\n');
    const wa = r.waiting({ id: a.id }, env);
    assert.equal(wa.tool, 'Bash');
    assert.match(wa.what, /^git push/);
    assert.equal(r.waiting({ id: b.id }, env), null, 'busy is not waiting');
    assert.equal(r.waiting({ id: 'ffffffff' }, env), null, 'not listed');
  });

  test('redact and lastToolUse', () => {
    assert.equal(redact('curl -H "Authorization: Bearer abc.def" https://u:p@x.io/?token=zzz').includes('abc.def'), false);
    assert.equal(redact('git push https://user:ghp_abcdefghijklmnopqrstuvwx@github.com/x').includes('ghp_'), false);
    assert.deepEqual(lastToolUse('/does/not/exist'), { tool: '', what: '' });
  });
});
