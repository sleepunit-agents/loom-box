import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnCall, SPAWN_DEPTH } from '../src/spawn.mjs';
import { deliver, deliveryDir, loadConv, saveConv, tick } from '../src/delivery.mjs';
import { judge } from '../src/loops.mjs';
import { principalOf } from '../src/principal.mjs';
import { world } from './delivery-world.mjs';
const coreTurnPath = join(process.env.LOOM_DIST || join(homedir(), 'Code', 'loom', 'dist'), 'backends', 'conversations.js');
const parseCoreTurn = existsSync(coreTurnPath) ? (await import(coreTurnPath)).parseTurn : null;
const owner = { kind: 'owner' };
const start = (w, q = {}) => spawnCall(w.env, owner, { agent: 'art', brief: 'Reply ok', ...q }, w.o);
const proof = (w, cv) => {
  const c = loadConv(w.env, cv);
  return { conversation: cv, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(cv) };
};

test('spawn finishes, survives reload, and result returns the sealed final report', async () => {
  const w = world();
  w.runner.final = () => 'ok';
  const turn = w.core.turn.bind(w.core);
  w.core.turn = async (t) => {
    if (t.kind === 'reply') {
      const { agent, key, ...input } = t;
      if (parseCoreTurn) parseCoreTurn(input, agent);
      else if (!t.outcome) throw new Error('core requires a reply outcome');
    }
    return turn(t);
  };
  const r = await start(w, { title: 'spawn test' });
  const c = loadConv(w.env, r.handle);
  assert.equal(c.kind, 'agent');
  assert.equal(c.label, 'spawn test');
  assert.equal(r.body, 'started');
  assert.equal((await spawnCall(w.env, owner, { agent: 'art', action: 'result', handle: r.handle }, w.o)).state, 'pending');
  w.runner.finish(c.body, { failed: false, worked: false });
  await tick(w.env, w.o);
  assert.equal(judge(loadConv(w.env, r.handle).runLog.at(-1)).failed, null, 'a final report counts as a reply even without tool work');
  assert.equal(loadConv(w.env, r.handle).spawn.recordedRun, loadConv(w.env, r.handle).spawn.reportRun, 'the report is accepted by core before it is shown in Comms');
  const result = await spawnCall(w.env, owner, { agent: 'art', action: 'result', handle: r.handle }, w.o);
  assert.equal(result.state, 'done');
  assert.equal(result.report, 'ok');
  assert.doesNotMatch(readFileSync(join(deliveryDir(w.env), 'conversations', `${r.handle}.json`), 'utf8'), /:\s*"ok"/);
});

test('say reaches a running spawn through runner.feed', async () => {
  const w = world();
  const r = await start(w);
  const say = await spawnCall(w.env, owner, { agent: 'art', action: 'say', handle: r.handle, text: 'Change it to yes' }, w.o);
  assert.equal(say.body, 'fed');
  assert.ok(w.log.some((l) => l[0] === 'feed' && l[2].includes('Change it to yes')));
  assert.equal(principalOf(w.env, loadConv(w.env, r.handle)).owner, true);
});

test('principal is preserved, return address is fixed, unrelated conversations cannot read or steer', async () => {
  const w = world();
  const parent = await deliver(w.env, w.msg('dm:loren', 'do this'), w.o);
  const caller = { kind: 'agent', agent: 'art' };
  const p = proof(w, parent.conversation);
  const r = await spawnCall(w.env, caller, { ...p, brief: 'help', origin: 'cv-aaaaaaaaaaaa', principal: { owner: true } }, w.o);
  const child = loadConv(w.env, r.handle);
  assert.deepEqual(principalOf(w.env, child), principalOf(w.env, loadConv(w.env, parent.conversation)));
  assert.equal(child.spawn.origin, parent.conversation);
  const other = await deliver(w.env, w.msg('dm:other', 'unrelated'), w.o);
  await assert.rejects(spawnCall(w.env, caller, { ...proof(w, other.conversation), action: 'result', handle: r.handle }, w.o), /asking conversation/);
  await assert.rejects(spawnCall(w.env, caller, { ...p, key: 'forged', brief: 'bad' }, w.o), /match|asking conversation/);
  w.runner.final = () => 'report for loren';
  w.runner.finish(child.body);
  await tick(w.env, w.o);
  assert.ok(loadConv(w.env, parent.conversation).queue.some((x) => x.untilIdle));
  assert.ok(w.core.audits.some((a) => a.conversation === parent.conversation && a.text.includes('report for loren')));
  assert.equal(loadConv(w.env, r.handle).spawn.returned, true);
});

test('per-agent spawn cap queues extras, then tick starts them when room opens', async () => {
  const w = world({ LOOM_RUNTIME_SPAWN_LIMIT: '1' });
  const a = await start(w);
  const b = await start(w);
  assert.equal(a.body, 'started');
  assert.equal(b.body, 'queued');
  assert.match(b.reason, /spawn cap/);
  w.runner.finish(loadConv(w.env, a.handle).body);
  w.runner.final = () => 'ok';
  await tick(w.env, w.o);
  assert.ok(loadConv(w.env, b.handle).body);
});

test('spawn chains cannot reset parentage to bypass the loop guard', async () => {
  const w = world({ LOOM_RUNTIME_SPAWN_LIMIT: '32', LOOM_RUNTIME_BUSY_LIMIT: '32' });
  let r = await start(w);
  for (let n = 1; n < SPAWN_DEPTH; n++) {
    r = await spawnCall(w.env, { kind: 'agent', agent: 'art' }, { ...proof(w, r.handle), brief: `generation ${n}`, depth: 0 }, w.o);
  }
  await assert.rejects(spawnCall(w.env, { kind: 'agent', agent: 'art' }, { ...proof(w, r.handle), brief: 'one more', depth: 0 }, w.o), /loop guard/);
});

test('MCP inference refuses a body whose principal is being reset or moved', async () => {
  const w = world();
  const r = await deliver(w.env, w.msg('dm:guest', 'help'), w.o);
  const c = loadConv(w.env, r.conversation);
  c.resetPending = true;
  saveConv(w.env, c);
  await assert.rejects(spawnCall(w.env, { kind: 'agent', agent: 'art' }, { conversation: c.conversation, brief: 'try owner work' }, w.o), /changed principal/);
});

test('principal reset invalidates handles and automatic returns', async () => {
  const w = world();
  const r = await deliver(w.env, w.msg('dm:guest', 'help'), w.o);
  const p = proof(w, r.conversation);
  const caller = { kind: 'agent', agent: 'art' };
  const child = await spawnCall(w.env, caller, { ...p, brief: 'child job' }, w.o);
  const c = loadConv(w.env, child.handle);
  c.actsFor = { owner: true, people: [], unknown: false, reset: 'now' };
  saveConv(w.env, c);
  for (const action of ['say', 'result']) await assert.rejects(spawnCall(w.env, caller, { ...p, action, handle: child.handle, text: 'do owner work' }, w.o), /spawned principal has changed/);
  w.runner.final = () => 'private owner report';
  w.runner.finish(c.body);
  await tick(w.env, w.o);
  assert.equal(loadConv(w.env, child.handle).spawn.returned, undefined);
  assert.equal(w.core.audits.some((a) => a.conversation === r.conversation && a.text.includes('private owner report')), false);
});

test('spawn retains guest denies and standing restriction from its original venue', async () => {
  const w = world();
  w.o.gates = () => ({ people: { loren: { tier: 1, restrict: 'Never publish anything' } } });
  w.o.policy = () => ({ guest_deny: ['mcp__secret'], briefs: { guest: 'house/guest.md' }, guest_places: { slack: { 'dm:guest': ['loren'] } } });
  w.o.card = () => 'Guest card';
  mkdirSync(join(w.env.HOME, 'house'), { recursive: true });
  writeFileSync(join(w.env.HOME, 'house/guest.md'), 'Guest floor');
  w.o.cwd = w.env.HOME;
  const r = await deliver(w.env, w.msg('dm:guest', 'do this'), w.o);
  assert.equal(r.body, 'started');
  const c = await spawnCall(w.env, { kind: 'agent', agent: 'art' }, { ...proof(w, r.conversation), brief: 'do this elsewhere' }, w.o);
  assert.equal(c.body, 'started');
  const child = loadConv(w.env, c.handle);
  assert.equal(child.bodyRules.guest, true);
  assert.ok(w.runner.denies[child.body.split(':')[1]].includes('mcp__secret'));
  const brief = w.log.filter((x) => x[0] === 'start').at(-1)[2];
  assert.ok(JSON.stringify(brief).includes('Never publish anything'));
});

test('return enqueue rejects a reset completed during core IO, even to the same principal', async () => {
  const w = world();
  const parent = await deliver(w.env, w.msg('dm:loren-race', 'do this'), w.o);
  const r = await spawnCall(w.env, { kind: 'agent', agent: 'art' }, { ...proof(w, parent.conversation), brief: 'help' }, w.o);
  w.runner.final = () => 'pre-reset report';
  w.runner.finish(loadConv(w.env, r.handle).body);
  const audit = w.core.audit.bind(w.core);
  w.core.audit = async (a) => {
    await audit(a);
    if (a.conversation === parent.conversation && a.text.includes('pre-reset report')) {
      const c = loadConv(w.env, parent.conversation);
      c.actsFor.reset = 'completed while return was in flight';
      saveConv(w.env, c);
    }
  };
  await tick(w.env, w.o);
  assert.equal(loadConv(w.env, r.handle).spawn.returned, undefined);
  assert.equal(loadConv(w.env, parent.conversation).queue.some((x) => x.id?.startsWith('spawn-return')), false);
});

test('same-principal child reset invalidates the previous handle', async () => {
  const w = world();
  const r = await start(w);
  const c = loadConv(w.env, r.handle);
  c.actsFor.reset = 'new generation';
  saveConv(w.env, c);
  await assert.rejects(spawnCall(w.env, owner, { agent: 'art', handle: r.handle, action: 'result' }, w.o), /principal has changed/);
});
