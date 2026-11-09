import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bootstrapScriptTask, bootstrapTask, downTask, taskStatus, upTask } from '../src/taskhost.mjs';
import { api, setAgent } from '../src/control.mjs';
import { HouseRunner } from '../src/houserunner.mjs';
import { runBodyHost } from '../src/bodyhost.mjs';
import { ageSealer } from '../src/sealed.mjs';
import { bodyPrincipal, deliver, deliveryDir, loadConv, tick } from '../src/delivery.mjs';
import { readBody } from '../src/bodies.mjs';
import { load, update } from '../src/state.mjs';
import { setModels } from '../src/models.mjs';
import { staticAccounts } from '../src/accounts.mjs';
import { world, fakeRunner, hasAge } from './delivery-world.mjs';
const until = async fn => { const end = Date.now() + 15000; while (!fn()) { if (Date.now() > end) throw Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };

for (const script of [false, true]) for (const harness of ['claude', 'codex']) test(`an allocated ${script ? 'script' : 'task'} uses ${harness} through common delivery in its original house, with slot and report`, { skip: !hasAge }, async () => {
  const w = world();
  w.o.sealer = ageSealer(w.env, deliveryDir(w.env));
  if (harness === 'codex') {
    setModels(w.env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }, { id: 'gpt', harness: 'codex', family: 'openai' }] });
    w.o.accounts = staticAccounts({ accounts: [
      { name: 'max', provider: 'anthropic', harness: 'claude', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage: { '5h': 1 } },
      { name: 'pro', provider: 'openai', harness: 'codex', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage: {} },
    ] });
  }
  setAgent(w.env, {}, { agent: 'art', repo: 'https://example.com/art.git' });
  const allocated = { id: 'h-7', agent: 'art', box: 'gpu-box', needs: ['gpu:5090'], slot: 'tending', state: 'starting', build: 'loom-house-art:aaaaaaaaaaaabbbbbbbb', task: script ? JSON.stringify({ prompt: 'run: /home/mark/bin/continuity', model: 'opus' }) : 'Report only.', taskActsFor: { owner: true, people: [], unknown: false } };
  update(w.env, s => { s.houses['h-7'] = allocated; s.builds = { art: { id: 'loom-house-art:ccccccccccccdddddddd', at: new Date().toISOString() } }; });
  const hr = new HouseRunner(w.env, harness, { sealer: w.o.sealer, poll: 5, up() { throw Error('must never allocate another house'); } });
  const o = { ...w.o, runner: () => hr, spawnWorker() {}, detach: true };
  const caller = { kind: 'agent', agent: 'art', house: 'h-7' };
  const bootTask = () => script ? bootstrapScriptTask(w.env, caller, { brief: 'MODEL-PORTION-ONLY. Report only.' }, o) : bootstrapTask(w.env, caller, o);
  const boot = await bootTask();
  const retry = await bootTask();
  if (!script) await assert.rejects(bootstrapScriptTask(w.env, caller, { brief: 'changed' }, o), /different/);
  if (script) {
    await assert.rejects(bootstrapScriptTask(w.env, caller, { brief: 'changed' }, o), /different/);
    await assert.rejects(bootstrapTask(w.env, caller, o), /different/);
  }
  assert.equal(retry.hostKey, boot.hostKey, 'a lost bootstrap response is retriable before host sync');
  assert.equal(retry.conversation, boot.conversation, 'one task, one conversation');
  const h = load(w.env).houses['h-7'];
  assert.deepEqual([h.box, h.needs, h.slot], [allocated.box, allocated.needs, allocated.slot]);
  assert.equal(h.seat, 'j-h-7');
  const native = fakeRunner(w.log, join(w.env.HOME, 'native'), harness);
  native.final = () => 'ALLOCATED-HOUSE-REPORT';
  let leave = false;
  const client = async (path, body) => {
    const r = await api(w.env, {}, { caller, path, body });
    if (r.status !== 200) throw Error(r.body.error);
    return leave ? { ...r.body, exit: true } : r.body;
  };
  const reportedRunning = setTimeout(() => update(w.env, s => { s.houses['h-7'].state = 'running'; }), 100);
  const host = runBodyHost({ client, runner: () => native, hostKey: boot.hostKey,
    env: { HOME: join(w.env.HOME, 'house'), CLAUDE_SECURESTORAGE_CONFIG_DIR: '/run/loom/login/claude', LOOM_LOGIN_CODEX: '/run/loom/login/codex' }, idleS: 0, beats: 3000, sleep: () => new Promise(r => setTimeout(r, 5)) });
  try {
    await tick(w.env, o);
    const c = loadConv(w.env, boot.conversation);
    assert.equal(c.body.startsWith(`${harness}:h-7-`), true);
    assert.equal(c.spawn.job.house, 'h-7');
    assert.equal(readBody(w.env, c.body).model, harness === 'codex' ? 'gpt' : 'opus');
    if (harness === 'codex') assert.equal(readBody(w.env, c.body).switched.from, 'claude', 'the shared quota resolver chose the fallback');
    assert.equal(w.log.filter(x => x[0] === 'start').length, 1);
    if (script) {
      const prompt = JSON.stringify(w.log.find(x => x[0] === 'start')[2]);
      assert.match(prompt, /MODEL-PORTION-ONLY/);
      assert.equal(c.spawn.prefer, 'opus', 'the original task keeps its model preference through the shared resolver');
      assert.doesNotMatch(prompt, /run: \/home\/mark/);
    }
    await assert.rejects(bootTask(), /already running/, 'a body cannot recover the host key');
    const raw = c.body.replace(`${harness}:h-7-`, `${harness}:`);
    const nativeId = raw.split(':')[1];
    await until(() => hr.slotOf({ id: c.body.split(':')[1], agent: 'art', house: 'h-7', seat: 'j-h-7' }));
    const principal = bodyPrincipal(w.env, { conversation: c.conversation, key: native.envs[nativeId].LOOM_BODY_KEY, session: native.slotOf({ id: nativeId }).session }, { ...o, caller });
    assert.equal(principal.ok, true, principal.reason);
    assert.equal(principal.owner, true, 'identity and tools see the task’s real principal in its dedicated house');

    native.finish(raw, { worked: true, failed: false });
    await until(() => hr.turn({ id: c.body.split(':')[1], agent: 'art', house: 'h-7', seat: 'j-h-7' }));
    await tick(w.env, o);
    const result = await taskStatus(w.env, caller, o);
    assert.deepEqual(result, { done: true, ok: true, report: 'ALLOCATED-HOUSE-REPORT' });
    assert.ok(loadConv(w.env, boot.conversation).slot, 'the common runtime collected the session before house exit');
  } finally { clearTimeout(reportedRunning); leave = true; await host; }
});

test('task bootstrap refuses owner, other-agent, service and session callers', async () => {
  const w = world();
  update(w.env, s => { s.houses['h-7'] = { id: 'h-7', agent: 'art', state: 'running', task: 'work' }; });
  for (const caller of [{ kind: 'owner' }, { kind: 'agent', agent: 'mark', house: 'h-7' }, { kind: 'agent', agent: 'art', house: 'h-7', service: 'bridge' }]) {
    await assert.rejects(bootstrapTask(w.env, caller, w.o), /task|credential/);
  }
  update(w.env, s => { s.houses['h-7'].session = true; });
  await assert.rejects(bootstrapTask(w.env, { kind: 'agent', agent: 'art', house: 'h-7' }, w.o), /raw-task/);
});

test('raw task requests retain a proven parent principal and never promote unproved agent calls', async () => {
  const w = world(); setAgent(w.env, {}, { agent: 'art', repo: 'https://example.com/art.git' });
  const raw = await upTask(w.env, {}, { kind: 'agent', agent: 'art' }, { task: 'work' });
  assert.equal(load(w.env).houses[raw.id].taskActsFor.unknown, true);
  const parent = await deliver(w.env, w.msg('parent', 'work'), w.o);
  const c = loadConv(w.env, parent.conversation);
  const key = w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY;
  const proof = { conversation: parent.conversation, key, session: w.sessionFor(parent.conversation) };
  const child = await upTask(w.env, {}, { kind: 'owner' }, { agent: 'art', task: 'help', ...proof });
  assert.deepEqual(load(w.env).houses[child.id].taskActsFor, c.actsFor);
  await assert.rejects(upTask(w.env, {}, { kind: 'owner' }, { agent: 'art', task: 'help', ...proof, key: 'wrong' }), /holding/);
  await assert.rejects(upTask(w.env, {}, { kind: 'owner' }, { agent: 'mark', task: 'help', ...proof }), /own agent/);
});

test('the allocating parent can cancel its task but another principal house cannot', async () => {
  const w = world();
  update(w.env, s => { s.houses['h-7'] = { id: 'h-7', agent: 'art', state: 'running', kind: 'body-host', seat: 'j-h-7', job: { house: 'h-7' }, taskFromHouse: 'h-1', task: 'private task' }; });
  await assert.rejects(downTask(w.env, {}, { kind: 'agent', agent: 'art', house: 'h-2' }, { id: 'h-7' }), /no house/);
  const result = await downTask(w.env, {}, { kind: 'agent', agent: 'art', house: 'h-1' }, { id: 'h-7' });
  assert.equal(result.state, 'stopping');
  assert.equal('taskFromHouse' in result, false);
});

 test('script task briefs are bounded and keep an unproved principal unknown', async () => {
  const w = world();
  update(w.env, s => { s.houses['h-7'] = { id: 'h-7', agent: 'art', state: 'running', task: 'run: script', taskSource: { origin: 'cv-aaaaaaaaaaaa', floor: { guest: true, deny: ['Write'] }, ruleSource: { venue: 'slack', place: 'guest-room', persons: ['guest'] } } }; });
  const caller = { kind: 'agent', agent: 'art', house: 'h-7' };
  for (const brief of ['', ' ', 42, 'x'.repeat(200001)]) await assert.rejects(bootstrapScriptTask(w.env, caller, { brief }, w.o), /brief/);
  for (const who of [{ kind: 'owner' }, { ...caller, agent: 'mark' }, { ...caller, service: 'bridge' }]) await assert.rejects(bootstrapScriptTask(w.env, who, { brief: 'work' }, w.o), /task|credential/);
  const boot = await bootstrapScriptTask(w.env, caller, { brief: 'private model portion' }, { ...w.o, detach: true, spawnWorker() {} });
  assert.equal(loadConv(w.env, boot.conversation).actsFor.unknown, true);
  assert.equal(loadConv(w.env, boot.conversation).actsFor.owner, false);
  const c = loadConv(w.env, boot.conversation);
  assert.deepEqual(c.spawn.floor, { guest: true, deny: ['Write'] });
  assert.equal(c.spawn.job.origin, 'cv-aaaaaaaaaaaa');
  assert.equal(c.spawn.ruleSource.place, 'guest-room');
  assert.equal(JSON.stringify(load(w.env).houses['h-7']).includes('private model portion'), false, 'the derived brief is not copied into house metadata');
});
