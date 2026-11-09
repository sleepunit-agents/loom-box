// A delivered body at work is on its agent's card (t-1945): a Comms thread, a bridge's chat, a wake, on Claude or
// Codex. The runtime's delivery state is the one record of it (workingConversations); the card's `doing` reads it,
// and the deliver loop tells core the moment the set moves (tellAtWork), so the card flips back to quiet within a tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staticAccounts } from '../src/accounts.mjs';
import { tellAtWork } from '../src/cli.mjs';
import { deliver, workingConversations } from '../src/delivery.mjs';
import { setModels } from '../src/models.mjs';
import { agentReports, convDoing } from '../src/ui.mjs';
import { cvOf, fakeRunner, world } from './delivery-world.mjs';

const thread = 'th:abcdefghij';
const commsMsg = (w) => ({ source: 'loom', id: `comms:${thread}:aaaaaaaaaaaaaaaa`, agent: 'mark', venue: 'loom', place: thread, label: 'Plan the garden',
  from: { kind: 'person', slug: 'jonathan' }, kind: 'message', at: w.clock.now().toISOString(), text: 'can you plan the garden?' });
const state = { boxes: {}, agents: { mark: {} }, houses: {}, services: {}, remotes: {} };

for (const harness of ['claude', 'codex']) {
  test(`a ${harness} body in a Comms thread: working on its card while it works, quiet once its turn is over`, async () => {
    const w = world();
    if (harness === 'codex') {
      w.runner = fakeRunner(w.log, w.env.HOME, 'codex');
      w.o.runner = () => w.runner;
      setModels(w.env, { list: [{ id: 'gpt', harness: 'codex', family: 'openai' }], agent: 'mark', prefer: ['gpt'] });
      w.o.accounts = staticAccounts({ accounts: [{ name: 'pro', provider: 'openai', harness: 'codex', kind: 'login', agents: ['mark'], credentials: [{ kind: 'login', status: 'valid' }], usage: {} }] });
    }
    const quiet = () => agentReports(state, w.clock.now().getTime(), {}, workingConversations(w.env, w.o, w.clock.now().getTime())).mark;
    assert.equal(quiet(), undefined, 'nothing at work: the runtime says nothing of mark');
    const a = await deliver(w.env, commsMsg(w), w.o);
    assert.equal(a.body, 'started');
    const cv = cvOf('mark', 'loom', thread);
    const ws = workingConversations(w.env, w.o, w.clock.now().getTime());
    assert.deepEqual(ws.map((x) => [x.agent, x.conversation, x.venue]), [['mark', cv, 'loom']]);
    const r = quiet();
    assert.equal(r.doing.length, 1);
    // The thread's title is its member's alone: never in the manifest; core puts it in for them.
    assert.deepEqual({ ...r.doing[0], since: undefined }, { text: 'In a Comms thread', kind: 'talk', where: 'Comms', conversation: cv, since: undefined });
    assert.ok(!JSON.stringify(r).includes('garden'), 'no title, no words');
    // Its turn over: the card says nothing at work.
    const [, id] = w.log.find((l) => l[0] === 'start');
    w.runner.finish(`${harness}:${id}`);
    assert.deepEqual(workingConversations(w.env, w.o, w.clock.now().getTime()), []);
    assert.equal(quiet(), undefined, 'quiet again');
  });
}

test('a wake and a bridge chat say only their venue and kind, never their label (it can name who or what)', () => {
  const wake = convDoing({ agent: 'art', conversation: 'cv-000000000001', venue: 'wake', kind: 'scheduled', place: 'w-1', label: 'Pond rollup for Loren' });
  assert.deepEqual(wake, { text: 'On a wake', kind: 'lane', conversation: 'cv-000000000001' });
  const slack = convDoing({ agent: 'art', conversation: 'cv-000000000002', venue: 'slack', kind: 'live', place: 'dm:U1', label: 'Loren (dm:U1)', since: Date.parse('2026-11-07T10:00:00Z') });
  assert.deepEqual(slack, { text: 'Working · Slack', kind: 'talk', conversation: 'cv-000000000002', since: '2026-11-07T10:00:00.000Z' });
  assert.ok(!JSON.stringify([wake, slack]).includes('Loren'));
});

test('core hears when what is at work moves, and only then', async () => {
  const w = world();
  const calls = [];
  const o = { core: { changed: async () => { calls.push(1); return { ok: true }; } }, deps: w.o };
  await tellAtWork(w.env, o);
  calls.length = 0;
  assert.equal(await tellAtWork(w.env, o), false, 'nothing moved: core isn\'t told');
  await deliver(w.env, commsMsg(w), w.o);
  assert.equal(await tellAtWork(w.env, o), true, 'a body started: core is told');
  assert.equal(await tellAtWork(w.env, o), false, 'still at work: told once');
  const [, id] = w.log.find((l) => l[0] === 'start');
  w.runner.finish(`claude:${id}`);
  assert.equal(await tellAtWork(w.env, o), true, 'its turn over: core is told');
  assert.equal(calls.length, 2);
});

test('complete jobs retain concurrent runs, queue waiting, and remove completed delivery work without labels', async () => {
  const { conversationJobs, loadConv, saveConv } = await import('../src/delivery.mjs');
  const w = world();
  for (const place of ['th:aaaaaaaaaa', 'th:bbbbbbbbbb']) {
    await deliver(w.env, { ...commsMsg(w), id: `comms:${place}:aaaaaaaaaaaaaaaa`, place }, w.o);
  }
  const jobs = () => conversationJobs(w.env, w.o, w.clock.now().getTime());
  assert.equal(jobs().filter((j) => j.status === 'running').length, 2);
  assert.ok(!JSON.stringify(jobs()).includes('garden'));
  const cv = cvOf('mark', 'loom', 'th:cccccccccc');
  saveConv(w.env, { conversation: cv, agent: 'mark', venue: 'loom', place: 'th:cccccccccc', queue: [{ key: 'pending' }] });
  assert.equal(jobs().find((j) => j.id === cv).status, 'waiting');
  for (const [, id] of w.log.filter((l) => l[0] === 'start')) w.runner.finish(`claude:${id}`);
  assert.equal(jobs().length, 1);
  const c = loadConv(w.env, cv); c.queue = []; saveConv(w.env, c);
  assert.deepEqual(jobs(), []);
});

test('house task references use explicit task text or wake note and exclude wrapper examples', async () => {
  const { houseTaskRefs } = await import('../src/ui.mjs');
  assert.deepEqual(houseTaskRefs('Fix t-2006 with t-2010; t-2006 again'), ['t-2006', 't-2010']);
  const prompt = 'You are Art (wake id w-abcdef, kind wake, set today, note: Continue t-2006). Instructions mention t-1975.';
  assert.deepEqual(houseTaskRefs(JSON.stringify({ prompt })), ['t-2006']);
  assert.deepEqual(houseTaskRefs('No task reference'), []);
});
