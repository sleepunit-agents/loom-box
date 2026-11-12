import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { contextCapOf, lastContext, handoffText, HANDOFF_MARKER } from '../src/context-cap.mjs';
import { world } from './delivery-world.mjs';
import { setModels } from '../src/models.mjs';
import { deliver, tick, loadConv, saveConv, contextBoundary } from '../src/delivery.mjs';
// Advance the real staged protocol: no synthetic admission acknowledgment.
async function beat(w, o = w.o) {
  await tick(w.env, o);
  const { listConvs } = await import('../src/delivery.mjs');
  for (const c of listConvs(w.env)) if (c.contextSuccessor) {
    const stage = c.contextSuccessor;
    const final = w.runner.final;
    w.runner.final = b => b.id === stage.r.body.split(':')[1] ? `LOOM_CONTEXT_ACCEPT ${stage.contextPrepare.digest}` : final?.(b);
    w.runner.finish(stage.r.body);
    try { await tick(w.env, o); } finally { w.runner.final = final; }
  }
}
test('cap defaults only to scheduled and agent work, explicit off; usage is current input not cumulative', () => {
  assert.equal(contextCapOf({}, { kind: 'scheduled' }), 150000);
  assert.equal(contextCapOf({}, { kind: 'agent' }), 150000);
  assert.equal(contextCapOf({}, { kind: 'live' }), null);
  for (const raw of ['-1', '19999', '2000001', '1.5', 'bad']) assert.equal(contextCapOf({ LOOM_RUNTIME_CONTEXT_CAP: raw }, { kind: 'agent' }), null);
  for (const kind of ['scheduled', 'agent']) for (const raw of ['20000', '175000', '2000000']) assert.equal(contextCapOf({ LOOM_RUNTIME_CONTEXT_CAP: raw }, { kind }), Number(raw));
  assert.equal(contextCapOf({ LOOM_RUNTIME_CONTEXT_CAP: 'off' }, { kind: 'agent' }), null);
  assert.equal(contextCapOf({ LOOM_RUNTIME_CONTEXT_CAP: '175000' }, { kind: 'agent' }), 175000);
  assert.equal(lastContext('codex', JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 160000 }, total_token_usage: { input_tokens: 9000000 } } } })), 160000);
  assert.equal(lastContext('claude', JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 140000, cache_creation_input_tokens: 15000 } } })), 155010);
  assert.equal(handoffText('normal completion'), null);
  for (const text of [HANDOFF_MARKER, HANDOFF_MARKER + '  ', HANDOFF_MARKER + 'x'.repeat(12001), 'LOOM_CONTEXT_HANDOFFwrong\ntext', ' LOOM_CONTEXT_HANDOFF\ntext']) assert.equal(handoffText(text), null);
  assert.equal(handoffText(HANDOFF_MARKER + 'x'.repeat(12000)).length, 12000);
  assert.equal(handoffText(HANDOFF_MARKER + 'Real handoff'), 'Real handoff');
});
test('one request, durable note, archived transcript and fresh start instead of resume', async () => {
  const w = world({}, { inboxDir: true });
  const models = [], originalStart = w.runner.start;
  w.runner.start = options => { models.push(options.model); return originalStart(options); };

  // world uses a live venue: provide an agent venue for the same trusted test source.
  w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('context', 'Complete the work'), w.o);
  let c = loadConv(w.env, first.conversation);
  assert.ok(c.body);
  w.runner.context = () => 160000;
  w.runner.final = () => HANDOFF_MARKER + 'Goal: complete work. Done: report. Left: deploy. HEAD abc; PR 1.';
  await beat(w);
  c = loadConv(w.env, first.conversation);
  const originalPrincipal = structuredClone(c.actsFor);
  assert.ok(c.contextCap, JSON.stringify({ kind: c.kind, log: w.log }));
  await beat(w);
  assert.equal(w.log.filter(x => x[0] === 'feed').length, 1);
  setModels(w.env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }, { id: 'sonnet', harness: 'claude', family: 'anthropic' }], agent: 'art', prefer: ['sonnet'] });
  mkdirSync(join(w.env.LOOM_BOX_DATA, 'delivery/slots'), { recursive: true });
  c.home = { harness: 'claude', session: 'parked-session', until: '2027-01-01T00:00:00Z', rules: c.bodyRules };
  writeFileSync(join(w.env.LOOM_BOX_DATA, 'delivery/slots', `${c.conversation}.home.age`), w.o.sealer.seal(Buffer.from(JSON.stringify({ files: [] }))));
  saveConv(w.env, c);
  const oldBody = c.body;
  await deliver(w.env, w.msg('context', 'Pending follow-up survives rotation'), w.o);
  w.runner.finish(oldBody);
  await beat(w);
  c = loadConv(w.env, first.conversation);
  assert.equal(c.contextHandoffs.length, 1);
  assert.deepEqual(c.actsFor, originalPrincipal);
  assert.equal(c.contextModel.model, 'opus');
  assert.equal(models.at(-1), 'opus');
  assert.ok(existsSync(c.contextHandoffs[0].archive));
  assert.notEqual(c.body, oldBody);
  assert.equal(w.log.filter(x => x[0] === 'resume').length, 1);
  assert.notEqual(w.log.find(x => x[0] === 'resume')[2], 's-' + oldBody?.split(':')[1]);
  assert.equal(w.log.filter(x => x[0] === 'start').length, 2, JSON.stringify(c));
  assert.match(w.log.filter(x => x[0] === 'start')[1][2], /Goal: complete work/);
  assert.match(w.log.filter(x => x[0] === 'resume').at(-1)[4], /Pending follow-up survives rotation/);
});
test('spawned handoff never becomes its final report; fresh job returns the actual result', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const w = world();
  const r = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Do the work' }, w.o);
  let c = loadConv(w.env, r.handle);
  const old = c.body;
  w.runner.context = () => 160000;
  w.runner.final = () => HANDOFF_MARKER + 'Done report; remaining deploy; PR 1, HEAD abc.';
  await beat(w);
  w.runner.finish(old);
  await beat(w);
  c = loadConv(w.env, r.handle);
  assert.equal(c.spawn.report, undefined);
  assert.notEqual(c.body, old);
  assert.equal((await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', action: 'result', handle: r.handle }, w.o)).state, 'pending');
  w.runner.context = () => 1000;
  w.runner.final = () => 'Deployed successfully';
  w.runner.finish(c.body);
  await beat(w);
  const result = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', action: 'result', handle: r.handle }, w.o);
  assert.equal(result.report, 'Deployed successfully');
});

test('saved handoff rotates after native final is gone (controller restart)', async () => {
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('restart-cap', 'Do job'), w.o);
  let c = loadConv(w.env, first.conversation);
  w.runner.context = () => 160000;
  await beat(w);
  c = loadConv(w.env, first.conversation);
  c.contextCap.note = w.o.sealer.seal(Buffer.from('Saved durable handoff; finish job from HEAD abc')).toString('base64');
  saveConv(w.env, c);
  w.runner.final = () => null;
  w.runner.finish(c.body);
  await beat(w);
  c = loadConv(w.env, first.conversation);
  assert.equal(c.contextHandoffs.length, 1);
  assert.ok(c.body);
  assert.match(w.log.filter(x => x[0] === 'start').at(-1)[2], /Saved durable handoff/);
});

test('request intent is durable before inbox accepts the handoff (restart window)', async () => {
  const w = world({}, { inboxDir: true }); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('request-crash', 'Do job'), w.o);
  w.runner.context = () => 160000;
  const originalFeed = w.runner.feed;
  w.runner.feed = (body, message) => {
    originalFeed(body, message);
    const c = loadConv(w.env, first.conversation);
    assert.equal(c.contextCap.body, c.body);
    assert.equal(c.contextCap.requested, false);
    throw Error('controller died after inbox acceptance');
  };
  await beat(w);
  let c = loadConv(w.env, first.conversation);
  assert.equal(c.starting, undefined, 'a transient feed exception cannot strand the live controller marker');
  w.runner.final = () => HANDOFF_MARKER + 'Continue the job from saved branch';
  w.runner.finish(c.body);
  await beat(w);
  c = loadConv(w.env, first.conversation);
  assert.equal(c.contextHandoffs.length, 1);
  assert.ok(c.body);
});

test('two rotations retain sender-derived guest denies and standing restrictions', async () => {
  const w = world();
  w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  w.o.gates = () => ({ people: { loren: { tier: 1, restrict: 'Never publish anything' }, mike: { tier: 1, restrict: 'Never change billing' } } });
  w.o.policy = () => ({ guest_deny: ['mcp__secret'], briefs: { guest: 'house/guest.md' } });
  w.o.card = () => 'Guest card'; w.o.cwd = w.env.HOME;
  mkdirSync(join(w.env.HOME, 'house'), { recursive: true });
  writeFileSync(join(w.env.HOME, 'house/guest.md'), 'Guest floor');
  const first = await deliver(w.env, w.msg('guest-cap', 'Do permitted work'), w.o);
  assert.equal(first.body, 'started');
  w.runner.context = () => 160000;
  w.runner.final = () => HANDOFF_MARKER + 'Continue permitted job at HEAD abc';
  for (let i = 0; i < 2; i++) {
    let c = loadConv(w.env, first.conversation);
    await beat(w);
    assert.ok(c.body, JSON.stringify({c, log:w.log}));
    w.runner.finish(c.body);
    await beat(w);
    c = loadConv(w.env, first.conversation);
    assert.ok(c.body);
    assert.equal(c.bodyRules.guest, true);
    assert.ok(w.runner.denies[c.body.split(':')[1]].includes('mcp__secret'));
    assert.match(w.log.filter(x => x[0] === 'start').at(-1)[2].map ? JSON.stringify(w.log.filter(x => x[0] === 'start').at(-1)[2]) : w.log.filter(x => x[0] === 'start').at(-1)[2], /Never publish anything/);
  }
});

test('archive interruption after native retirement retries from persisted receipt and note', async () => {
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('archive-interrupt', 'Do original job'), w.o);
  let c = loadConv(w.env, first.conversation);
  const old = c.body, native = w.runner.transcript('s-' + old.split(':')[1]);
  const archive = join(w.env.LOOM_BOX_DATA, 'delivery', 'slots', `${c.conversation}.age.context-${c.run}`);
  w.runner.context = () => 160000;
  w.runner.final = () => HANDOFF_MARKER + 'Durable original handoff: finish PR 3';
  await beat(w);
  mkdirSync(archive, { recursive: true }); // rename must fail after retirement committed.
  w.runner.finish(old);
  await beat(w);
  c = loadConv(w.env, first.conversation);
  assert.equal(c.body, old); assert.equal(c.starting, undefined);
  assert.equal(c.retiring.type, 'context-rotate'); assert.ok(c.nativeRetirement);
  assert.ok(c.contextCap.note); assert.equal(existsSync(native), false);
  rmSync(archive, { recursive: true });
  w.runner.final = () => null; // the original native output is no longer available.
  await beat(w, { ...w.o });
  c = loadConv(w.env, first.conversation);
  assert.notEqual(c.body, old); assert.equal(c.contextHandoffs.length, 1);
  const packed = JSON.parse(w.o.sealer.open(readFileSync(archive)).toString());
  assert.ok(packed.files.some(f => Buffer.from(f.data, 'base64').toString().includes('Do original job')));
  assert.match(w.log.filter(x => x[0] === 'start').at(-1)[2], /Durable original handoff/);
});

test('oversized or missing native history holds rotation until a valid archive can be kept', async () => {
  for (const mode of ['oversized', 'missing']) {
    const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
    const first = await deliver(w.env, w.msg('archive-' + mode, 'Keep job history'), w.o);
    let c = loadConv(w.env, first.conversation); const old = c.body;
    const native = w.runner.transcript('s-' + old.split(':')[1]);
    if (mode === 'oversized') writeFileSync(native, Buffer.alloc(6 * 1024 * 1024 + 1)); else rmSync(native);
    w.runner.context = () => 160000; w.runner.final = () => HANDOFF_MARKER + 'Preserve this note';
    await beat(w); w.runner.finish(old); await beat(w);
    c = loadConv(w.env, first.conversation);
    assert.equal(c.body, old); assert.equal(c.contextHandoffs, undefined); assert.ok(c.contextCap.note);
    if (mode === 'oversized') assert.ok(existsSync(native), 'never remove the only oversized history');
    writeFileSync(native, 'restored session history');
    await beat(w, { ...w.o });
    c = loadConv(w.env, first.conversation); assert.notEqual(c.body, old);
    assert.ok(existsSync(c.contextHandoffs[0].archive));
  }
});

test('follow-up arriving before the tick rotates a finished handoff before any resume', async () => {
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('handoff-arrival', 'Original work'), w.o);
  const old = loadConv(w.env, first.conversation).body;
  w.runner.context = () => 160000; w.runner.final = () => HANDOFF_MARKER + 'Continue at saved HEAD';
  await beat(w); w.runner.finish(old);
  await deliver(w.env, w.msg('handoff-arrival', 'Follow-up before next tick'), w.o);
  await beat(w);
  const c = loadConv(w.env, first.conversation);
  assert.notEqual(c.body, old); assert.equal(c.contextHandoffs.length, 1);
  assert.ok(w.log.filter(x => x[0] === 'resume').every(x => x[2] !== 's-' + old.split(':')[1]));
  assert.match(w.log.filter(x => x[0] === 'start').at(-1)[2], /Continue at saved HEAD/);
  assert.match(w.log.filter(x => x[0] === 'resume').at(-1)[4], /Follow-up before next tick/);
});

test('real Claude and Codex runners discover current context in native transcripts', async () => {
  const { ClaudeRunner, CodexRunner } = await import('../src/runners.mjs');
  const { scratch } = await import('./scratch.mjs');
  const root = scratch('context-native-');
  const projects = join(root, 'projects'), sessions = join(root, 'sessions');
  mkdirSync(join(projects, 'project'), { recursive: true }); mkdirSync(join(sessions, '2026/11/10'), { recursive: true });
  const claudeFile = join(projects, 'project/session-claude.jsonl');
  const codexFile = join(sessions, '2026/11/10/rollout-fixture-session-codex.jsonl');
  writeFileSync(claudeFile, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 140000, cache_creation_input_tokens: 15000 } } }) + '\n');
  writeFileSync(codexFile, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 160000 }, total_token_usage: { input_tokens: 9000000 } } } }) + '\n');
  const c = new ClaudeRunner({ projectsDir: projects, jobsDir: join(root, 'jobs') });
  const x = new CodexRunner({ sessionsDir: sessions, runsDir: join(root, 'runs') });
  assert.equal(c.context({ id: 'body-claude', slot: { session: 'session-claude' } }), 155010);
  assert.equal(x.context({ id: 'body-codex', slot: { session: 'session-codex' } }), 160000);
  writeFileSync(codexFile, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 170000 } } } }) + '\n');
  assert.equal(x.context({ id: 'body-codex', slot: { session: 'session-codex' } }), 170000);
});


test('missing, malformed and unreadable requested handoffs hold visibly instead of completing', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  for (const mode of ['missing', 'empty', 'oversized', 'bad-marker', 'unreadable', 'saved-oversized']) {
    const w = world();
    const result = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Do not lose unfinished work' }, w.o);
    let c = loadConv(w.env, result.handle);
    const old = c.body;
    w.runner.context = () => 160000;
    await beat(w);
    c = loadConv(w.env, result.handle);
    if (mode === 'unreadable') {
      c.contextCap.note = Buffer.from('not sealed').toString('base64');
      const open = w.o.sealer.open;
      w.o.sealer.open = blob => { if (blob.toString() === 'not sealed') throw Error('cannot decrypt'); return open(blob); };
    }
    if (mode === 'saved-oversized') c.contextCap.note = w.o.sealer.seal(Buffer.from('x'.repeat(12001))).toString('base64');
    saveConv(w.env, c);
    w.runner.final = () => mode === 'missing' ? null : mode === 'oversized' ? HANDOFF_MARKER + 'x'.repeat(12001) : mode === 'bad-marker' ? 'LOOM_CONTEXT_HANDOFFwrong\nunfinished' : HANDOFF_MARKER;
    w.runner.finish(old);
    await beat(w);
    c = loadConv(w.env, result.handle);
    assert.equal(c.body, old, mode);
    assert.equal(c.spawn.report, undefined, mode);
    assert.equal(c.contextHandoffs, undefined, mode);
    assert.match(c.waiting, /context handoff held:/, mode);
    assert.equal((await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', action: 'result', handle: result.handle }, w.o)).state, 'pending', mode);
    // Recovery uses the same predecessor's valid note, without dropping history.
    delete c.contextCap.note; saveConv(w.env, c);
    w.runner.final = () => HANDOFF_MARKER + 'Recovered note: continue the unfinished work';
    await beat(w);
    c = loadConv(w.env, result.handle);
    assert.notEqual(c.body, old, mode);
    assert.equal(c.contextHandoffs.length, 1, mode);
  }
});


test('missing or malformed predecessor model metadata holds before native retirement', async () => {
  for (const model of [undefined, '', ' ', {}, 'bad\nmodel']) {
    const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
    const first = await deliver(w.env, w.msg('model-hold', 'Keep the same model'), w.o);
    let c = loadConv(w.env, first.conversation); const old = c.body;
    const file = join(w.env.LOOM_BOX_DATA, 'bodies', old.replace(':', '-') + '.json');
    const record = JSON.parse(readFileSync(file));
    writeFileSync(file, JSON.stringify({ ...record, model }));
    const native = w.runner.transcript('s-' + old.split(':')[1]);
    w.runner.context = () => 160000;
    w.runner.final = () => HANDOFF_MARKER + 'Continue the job safely';
    await beat(w); w.runner.finish(old); await beat(w);
    c = loadConv(w.env, first.conversation);
    assert.equal(c.body, old); assert.equal(c.contextHandoffs, undefined);
    assert.ok(existsSync(native)); assert.ok(c.contextCap.note);
    assert.equal(w.log.filter(x => x[0] === 'start').length, 1);
    writeFileSync(file, JSON.stringify(record));
    await beat(w);
    c = loadConv(w.env, first.conversation);
    assert.notEqual(c.body, old); assert.equal(c.contextModel.model, record.model);
  }
});

test('successor reads and acknowledges before predecessor retirement, including restart and pending messages', async () => {
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('accept-order', 'Finish original task'), w.o);
  const old = loadConv(w.env, first.conversation).body;
  const native = w.runner.transcript('s-' + old.split(':')[1]);
  w.runner.context = () => 160000;
  w.runner.final = () => HANDOFF_MARKER + 'Saved handoff for successor';
  await tick(w.env, w.o); w.runner.finish(old);
  w.runner.failStart = 'successor unavailable';
  await tick(w.env, w.o);
  let c = loadConv(w.env, first.conversation);
  assert.equal(c.body, old); assert.ok(existsSync(native)); assert.equal(w.log.filter(x => x[0] === 'end').length, 0);
  assert.match(c.waiting, /successor could not start/);
  w.runner.failStart = null;
  await tick(w.env, { ...w.o }, undefined, new Map());
  c = loadConv(w.env, first.conversation);
  assert.ok(c.contextSuccessor); assert.equal(c.body, old);
  const stage = c.contextSuccessor;
  await deliver(w.env, w.msg('accept-order', 'Follow-up while accepting'), w.o);
  await tick(w.env, w.o);
  assert.equal(w.log.filter(x => x[0] === 'end').length, 0);
  assert.ok(existsSync(native));
  w.runner.finish(stage.r.body); w.runner.final = () => 'wrong acknowledgment';
  await tick(w.env, w.o);
  c = loadConv(w.env, first.conversation);
  assert.equal(c.body, old); assert.match(c.waiting, /acknowledgment/); assert.ok(existsSync(native));
  w.runner.final = b => b.id === stage.r.body.split(':')[1] ? `LOOM_CONTEXT_ACCEPT ${stage.contextPrepare.digest}` : null;
  await tick(w.env, { ...w.o }, undefined, new Map());
  c = loadConv(w.env, first.conversation);
  assert.notEqual(c.body, old); assert.equal(c.contextHandoffs.length, 1);
  assert.ok(w.log.findIndex(x => x[0] === 'start' && x[1] === stage.r.body.split(':')[1]) < w.log.findIndex(x => x[0] === 'end' && x[1] === old.split(':')[1]));
  assert.match(w.log.filter(x => x[0] === 'resume').at(-1)[4], /Follow-up while accepting/);
});

test('missing and malformed bodyRules hold before successor launch or retirement', async () => {
  for (const rules of [undefined, {}, { guest: false }, { guest: false, key: 'k', deny: null, readers: [] }]) {
    const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
    const first = await deliver(w.env, w.msg('missing-rules', 'Keep restrictions'), w.o);
    let c = loadConv(w.env, first.conversation); const old = c.body, saved = c.bodyRules;
    w.runner.context = () => 160000; w.runner.final = () => HANDOFF_MARKER + 'Continue safely';
    await tick(w.env, w.o); w.runner.finish(old);
    c = loadConv(w.env, first.conversation); c.bodyRules = rules; saveConv(w.env, c);
    await tick(w.env, w.o); c = loadConv(w.env, first.conversation);
    assert.equal(c.body, old); assert.equal(c.contextSuccessor, undefined); assert.match(c.waiting, /bodyRules/);
    assert.equal(w.log.filter(x => x[0] === 'end').length, 0); assert.equal(w.log.filter(x => x[0] === 'start').length, 1);
    c.bodyRules = saved; saveConv(w.env, c); await beat(w);
    assert.equal(loadConv(w.env, first.conversation).contextHandoffs.length, 1);
  }
});

test('authenticated task-boundary rotates below cap, persists note and refuses wrong holder', async () => {
  const w = world({ LOOM_RUNTIME_CONTEXT_CAP: 'off' }); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('boundary', 'Do multiple tasks'), w.o);
  let c = loadConv(w.env, first.conversation); const old = c.body, id = old.split(':')[1];
  const proof = { conversation: c.conversation, key: w.runner.envs[id].LOOM_BODY_KEY, session: 's-' + id, note: 'Task one complete. Next: task two at HEAD abc.' };
  assert.throws(() => contextBoundary(w.env, { ...proof, key: 'wrong' }, w.o), /only the body/);
  assert.throws(() => contextBoundary(w.env, { ...proof, session: 'other' }, w.o), /another session/);
  assert.throws(() => contextBoundary(w.env, { ...proof, note: '' }, w.o), /nonempty/);
  assert.throws(() => contextBoundary(w.env, proof, { ...w.o, caller: { kind: 'agent', agent: 'mark' } }), /own body/);
  assert.equal(contextBoundary(w.env, proof, w.o).state, 'handoff-saved');
  c = loadConv(w.env, first.conversation); assert.equal(c.contextCap.boundary, true);
  w.runner.context = () => 1000; w.runner.final = () => null;
  await tick(w.env, w.o); assert.equal(loadConv(w.env, first.conversation).contextSuccessor, undefined, 'predecessor must finish its safe boundary first');
  w.runner.finish(old); await beat(w, { ...w.o });
  c = loadConv(w.env, first.conversation); assert.notEqual(c.body, old); assert.equal(c.contextHandoffs.length, 1);
  assert.match(w.log.filter(x => x[0] === 'resume').at(-1)[4], /Task one complete/);
});

test('randomized sealing keeps the saved handoff and accepts its plaintext digest across ticks', async () => {
  const { randomBytes } = await import('node:crypto');
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const original = w.o.sealer;
  w.o.sealer = { seal: b => Buffer.concat([randomBytes(16), original.seal(b)]), open: b => original.open(b.subarray(16)) };
  const first = await deliver(w.env, w.msg('random-seal', 'Continue securely'), w.o);
  const old = loadConv(w.env, first.conversation).body;
  w.runner.context = () => 160000; w.runner.final = () => HANDOFF_MARKER + 'Same note despite randomized encryption';
  await tick(w.env, w.o); w.runner.finish(old); await tick(w.env, w.o);
  let c = loadConv(w.env, first.conversation); const note = c.contextCap.note, stage = c.contextSuccessor;
  await tick(w.env, { ...w.o });
  assert.equal(loadConv(w.env, first.conversation).contextCap.note, note);
  w.runner.finish(stage.r.body); w.runner.final = () => `LOOM_CONTEXT_ACCEPT ${stage.contextPrepare.digest}`;
  await tick(w.env, { ...w.o });
  c = loadConv(w.env, first.conversation); assert.notEqual(c.body, old); assert.equal(c.contextHandoffs.length, 1);
});

test('owner reset cancels the staged successor before conversation work can restart', async () => {
  const { resetPrincipal } = await import('../src/delivery.mjs');
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('reset-stage', 'Original work'), w.o);
  const old = loadConv(w.env, first.conversation).body;
  w.runner.context = () => 160000; w.runner.final = () => HANDOFF_MARKER + 'Do not survive owner reset';
  await tick(w.env, w.o); w.runner.finish(old); await tick(w.env, w.o);
  const stage = loadConv(w.env, first.conversation).contextSuccessor;
  assert.ok(stage); assert.equal(resetPrincipal(w.env, first.conversation).ok, true);
  await tick(w.env, w.o);
  const c = loadConv(w.env, first.conversation);
  assert.equal(c.contextSuccessor, undefined);
  assert.ok(w.log.some(x => x[0] === 'end' && x[1] === stage.r.body.split(':')[1]));
  assert.equal(c.contextHandoffs, undefined);
});

test('non-default profile metadata holds without dropping the restriction marker', async () => {
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('profile-floor', 'Retain work profile'), w.o);
  let c = loadConv(w.env, first.conversation); const old = c.body;
  c.profile = 'work'; saveConv(w.env, c);
  w.runner.context = () => 160000; w.runner.final = () => HANDOFF_MARKER + 'Keep profile';
  await tick(w.env, w.o); w.runner.finish(old); await tick(w.env, w.o);
  c = loadConv(w.env, first.conversation);
  assert.equal(c.body, old); assert.equal(c.profile, 'work'); assert.equal(c.contextSuccessor, undefined);
  assert.match(c.waiting, /profile-aware/); assert.equal(w.log.filter(x => x[0] === 'end').length, 0);
});

test('a removed standing restriction during successor acceptance holds before retirement', async () => {
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  let restrict = 'Never publish';
  w.o.gates = () => ({ people: { loren: { tier: 2, restrict } } });
  const first = await deliver(w.env, w.msg('changed-standing', 'Original work'), w.o);
  const old = loadConv(w.env, first.conversation).body;
  w.runner.context = () => 160000; w.runner.final = () => HANDOFF_MARKER + 'Preserve standing floor';
  await tick(w.env, w.o); w.runner.finish(old); await tick(w.env, w.o);
  const stage = loadConv(w.env, first.conversation).contextSuccessor;
  w.runner.finish(stage.r.body); w.runner.final = () => `LOOM_CONTEXT_ACCEPT ${stage.contextPrepare.digest}`;
  restrict = ''; await tick(w.env, w.o);
  const c = loadConv(w.env, first.conversation);
  assert.equal(c.body, old); assert.match(c.waiting, /standing restrictions changed/);
  assert.equal(w.log.filter(x => x[0] === 'end').length, 0);
});

test('a later rotation refuses malformed current rules even when an older saved floor exists', async () => {
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('later-floor', 'Several tasks'), w.o);
  w.runner.context = () => 160000; w.runner.final = () => HANDOFF_MARKER + 'Next task';
  await tick(w.env, w.o); w.runner.finish(loadConv(w.env, first.conversation).body); await beat(w);
  let c = loadConv(w.env, first.conversation); const old = c.body;
  assert.ok(c.contextFloor); assert.match(w.log.filter(x => x[0] === 'resume').at(-1)[4], /context-boundary --note/);
  await tick(w.env, w.o); w.runner.finish(old);
  c = loadConv(w.env, first.conversation); c.bodyRules = {}; saveConv(w.env, c);
  await tick(w.env, w.o); c = loadConv(w.env, first.conversation);
  assert.equal(c.body, old); assert.equal(c.contextHandoffs.length, 1); assert.match(c.waiting, /bodyRules/);
});


test('context profile declaration and native floor survive acceptance, restart, resume and a second rotation', async () => {
  const { jobProfileKey, minimalProfile } = await import('../src/work-profile.mjs');
  const { readBody } = await import('../src/bodies.mjs');
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const file = join(w.env.HOME, 'profiles.json'); w.env.LOOM_RUNTIME_JOB_PROFILES = file;
  const declaration = { ...minimalProfile(), tools: ['Read'] };
  const key = jobProfileKey({ agent: 'art', venue: 'slack', kind: 'agent', place: 'context-profile' });
  writeFileSync(file, JSON.stringify({ v: 1, jobs: { [key]: declaration } }));
  const first = await deliver(w.env, w.msg('context-profile', 'Do work'), w.o);
  let c = loadConv(w.env, first.conversation), old = c.body;
  assert.deepEqual(JSON.parse(readBody(w.env, old).profile), declaration);
  const floor = { deny: ['Read(/private-a)'], disabled: ['blocked'] };
  w.runner.floors[old.split(':')[1]] = floor;
  w.runner.context = () => 160000; w.runner.final = () => HANDOFF_MARKER + 'Keep restrictions';
  await tick(w.env, w.o); w.runner.finish(old);
  // Controller options reconstructed; declaration store now widens. The frozen selection wins.
  writeFileSync(file, JSON.stringify({ v: 1, jobs: { [key]: { ...declaration, tools: ['Read', 'Bash'] } } }));
  await beat(w, { ...w.o });
  c = loadConv(w.env, first.conversation);
  assert.notEqual(c.body, old, JSON.stringify(c));
  assert.deepEqual(c.contextNativeFloor, floor);
  const id = c.body.split(':')[1];
  assert.deepEqual(JSON.parse(w.runner.envs[id].LOOM_BODY_PROFILE), declaration);
  assert.deepEqual(w.runner.floors[id], floor);
  assert.equal(readBody(w.env, c.body).profile, c.contextProfile.body);
  // The accepted session accumulates additional native restrictions before rotating again.
  w.runner.floors[id] = { deny: [...floor.deny, 'Bash(rm *)'], disabled: [...floor.disabled, 'later'] };
  old = c.body;
  w.runner.final = () => HANDOFF_MARKER + 'Second rotation';
  await tick(w.env, { ...w.o }); w.runner.finish(old); await beat(w, { ...w.o });
  c = loadConv(w.env, first.conversation);
  assert.notEqual(c.body, old, JSON.stringify(c));
  assert.equal(c.contextHandoffs.length, 2);
  assert.deepEqual(w.runner.floors[c.body.split(':')[1]], { deny: ['Read(/private-a)', 'Bash(rm *)'], disabled: ['blocked', 'later'] });
  assert.deepEqual(JSON.parse(w.runner.envs[c.body.split(':')[1]].LOOM_BODY_PROFILE), declaration);
});

for (const missing of [null, { deny: 'bad', disabled: [] }, { deny: [], disabled: [], unknown: true }, { deny: [], disabled: [], runtimeUnknown: true }]) test(`context native provenance ${JSON.stringify(missing)} stays visibly minimal before unavailable secrets`, async () => {
  const { readBody } = await import('../src/bodies.mjs');
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('unknown-context', 'Do work'), w.o);
  let c = loadConv(w.env, first.conversation), old = c.body;
  // A frozen declaration with an unavailable secret must not resolve it on the unknown path.
  const path = join(w.env.LOOM_BOX_DATA, 'bodies', old.replace(':', '-') + '.json');
  const rec = readBody(w.env, old);
  const declaration = { v: 1, mcp: [], tools: ['Read'], skills: [], secrets: ['UNAVAILABLE'] };
  writeFileSync(path, JSON.stringify({ ...rec, profile: JSON.stringify(declaration), ...(missing?.runtimeUnknown ? { restrictionUnknown: true } : {}) }));
  w.runner.profileFloor = () => missing;
  w.runner.context = () => 160000; w.runner.final = () => HANDOFF_MARKER + 'Unknown provenance';
  await tick(w.env, w.o); w.runner.finish(old); await beat(w, { ...w.o });
  c = loadConv(w.env, first.conversation);
  assert.notEqual(c.body, old, JSON.stringify(c));
  let env = w.runner.envs[c.body.split(':')[1]];
  assert.deepEqual(JSON.parse(env.LOOM_BODY_PROFILE).secrets, []);
  assert.deepEqual(JSON.parse(env.LOOM_BODY_PROFILE).tools, []);
  assert.match(env.LOOM_BODY_PROFILE_PROBLEM, /minimal/);
  assert.equal(readBody(w.env, c.body).restrictionUnknown, true);
  assert.equal(c.contextNativeFloor.unknown, true);
  old = c.body; w.runner.final = () => HANDOFF_MARKER + 'Still unknown';
  await tick(w.env, { ...w.o }); w.runner.finish(old); await beat(w, { ...w.o });
  c = loadConv(w.env, first.conversation);
  assert.notEqual(c.body, old, JSON.stringify(c));
  env = w.runner.envs[c.body.split(':')[1]];
  assert.deepEqual(JSON.parse(env.LOOM_BODY_PROFILE).tools, []);
  assert.match(env.LOOM_BODY_PROFILE_PROBLEM, /minimal/);
});

test('a runner without native floor support holds context rotation without stopping the predecessor', async () => {
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('old-profile-runner', 'Work'), w.o);
  const old = loadConv(w.env, first.conversation).body;
  delete w.runner.profileFloor;
  w.runner.context = () => 160000; w.runner.final = () => HANDOFF_MARKER + 'Need support';
  await tick(w.env, w.o); w.runner.finish(old); await tick(w.env, w.o);
  const c = loadConv(w.env, first.conversation);
  assert.equal(c.body, old); assert.equal(c.contextSuccessor, undefined);
  assert.match(c.waiting, /profile-aware/);
  assert.equal(w.log.filter(x => x[0] === 'end').length, 0);
});
