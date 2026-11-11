import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { contextCapOf, lastContext, handoffText, HANDOFF_MARKER } from '../src/context-cap.mjs';
import { world } from './delivery-world.mjs';
import { setModels } from '../src/models.mjs';
import { deliver, tick, loadConv, saveConv } from '../src/delivery.mjs';
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
  await tick(w.env, w.o);
  c = loadConv(w.env, first.conversation);
  const originalPrincipal = structuredClone(c.actsFor);
  assert.ok(c.contextCap, JSON.stringify({ kind: c.kind, log: w.log }));
  await tick(w.env, w.o);
  assert.equal(w.log.filter(x => x[0] === 'feed').length, 1);
  setModels(w.env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }, { id: 'sonnet', harness: 'claude', family: 'anthropic' }], agent: 'art', prefer: ['sonnet'] });
  mkdirSync(join(w.env.LOOM_BOX_DATA, 'delivery/slots'), { recursive: true });
  c.home = { harness: 'claude', session: 'parked-session', until: '2027-01-01T00:00:00Z', rules: c.bodyRules };
  writeFileSync(join(w.env.LOOM_BOX_DATA, 'delivery/slots', `${c.conversation}.home.age`), w.o.sealer.seal(Buffer.from(JSON.stringify({ files: [] }))));
  saveConv(w.env, c);
  const oldBody = c.body;
  await deliver(w.env, w.msg('context', 'Pending follow-up survives rotation'), w.o);
  w.runner.finish(oldBody);
  await tick(w.env, w.o);
  c = loadConv(w.env, first.conversation);
  assert.equal(c.contextHandoffs.length, 1);
  assert.deepEqual(c.actsFor, originalPrincipal);
  assert.equal(c.contextModel.model, 'opus');
  assert.equal(models.at(-1), 'opus');
  assert.ok(existsSync(c.contextHandoffs[0].archive));
  assert.notEqual(c.body, oldBody);
  assert.equal(w.log.filter(x => x[0] === 'resume').length, 0);
  assert.equal(w.log.filter(x => x[0] === 'start').length, 2, JSON.stringify(c));
  assert.match(w.log.filter(x => x[0] === 'start')[1][2], /Goal: complete work/);
  assert.match(w.log.filter(x => x[0] === 'start')[1][2], /Pending follow-up survives rotation/);
});
test('spawned handoff never becomes its final report; fresh job returns the actual result', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const w = world();
  const r = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Do the work' }, w.o);
  let c = loadConv(w.env, r.handle);
  const old = c.body;
  w.runner.context = () => 160000;
  w.runner.final = () => HANDOFF_MARKER + 'Done report; remaining deploy; PR 1, HEAD abc.';
  await tick(w.env, w.o);
  w.runner.finish(old);
  await tick(w.env, w.o);
  c = loadConv(w.env, r.handle);
  assert.equal(c.spawn.report, undefined);
  assert.notEqual(c.body, old);
  assert.equal((await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', action: 'result', handle: r.handle }, w.o)).state, 'pending');
  w.runner.context = () => 1000;
  w.runner.final = () => 'Deployed successfully';
  w.runner.finish(c.body);
  await tick(w.env, w.o);
  const result = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', action: 'result', handle: r.handle }, w.o);
  assert.equal(result.report, 'Deployed successfully');
});

test('saved handoff rotates after native final is gone (controller restart)', async () => {
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('restart-cap', 'Do job'), w.o);
  let c = loadConv(w.env, first.conversation);
  w.runner.context = () => 160000;
  await tick(w.env, w.o);
  c = loadConv(w.env, first.conversation);
  c.contextCap.note = w.o.sealer.seal(Buffer.from('Saved durable handoff; finish job from HEAD abc')).toString('base64');
  saveConv(w.env, c);
  w.runner.final = () => null;
  w.runner.finish(c.body);
  await tick(w.env, w.o);
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
  await tick(w.env, w.o);
  let c = loadConv(w.env, first.conversation);
  assert.equal(c.starting, undefined, 'a transient feed exception cannot strand the live controller marker');
  w.runner.final = () => HANDOFF_MARKER + 'Continue the job from saved branch';
  w.runner.finish(c.body);
  await tick(w.env, w.o);
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
    if (i === 1) await deliver(w.env, w.msg('guest-cap', 'Another sender follows up', { from: { kind: 'person', slug: 'mike' } }), w.o);
    let c = loadConv(w.env, first.conversation);
    await tick(w.env, w.o);
    w.runner.finish(c.body);
    await tick(w.env, w.o);
    c = loadConv(w.env, first.conversation);
    assert.ok(c.body);
    assert.equal(c.bodyRules.guest, true);
    assert.ok(w.runner.denies[c.body.split(':')[1]].includes('mcp__secret'));
    if (i === 1) assert.match(w.log.filter(x => x[0] === 'start').at(-1)[2], /Never change billing/);
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
  await tick(w.env, w.o);
  mkdirSync(archive, { recursive: true }); // rename must fail after retirement committed.
  w.runner.finish(old);
  await tick(w.env, w.o);
  c = loadConv(w.env, first.conversation);
  assert.equal(c.body, old); assert.equal(c.starting, undefined);
  assert.equal(c.retiring.type, 'context-rotate'); assert.ok(c.nativeRetirement);
  assert.ok(c.contextCap.note); assert.equal(existsSync(native), false);
  rmSync(archive, { recursive: true });
  w.runner.final = () => null; // the original native output is no longer available.
  await tick(w.env, { ...w.o }, undefined, new Map());
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
    await tick(w.env, w.o); w.runner.finish(old); await tick(w.env, w.o);
    c = loadConv(w.env, first.conversation);
    assert.equal(c.body, old); assert.equal(c.contextHandoffs, undefined); assert.ok(c.contextCap.note);
    if (mode === 'oversized') assert.ok(existsSync(native), 'never remove the only oversized history');
    writeFileSync(native, 'restored session history');
    await tick(w.env, { ...w.o }, undefined, new Map());
    c = loadConv(w.env, first.conversation); assert.notEqual(c.body, old);
    assert.ok(existsSync(c.contextHandoffs[0].archive));
  }
});

test('follow-up arriving before the tick rotates a finished handoff before any resume', async () => {
  const w = world(); w.o.venues = () => ({ slack: { kind: 'agent', send: ['adapter'] } });
  const first = await deliver(w.env, w.msg('handoff-arrival', 'Original work'), w.o);
  const old = loadConv(w.env, first.conversation).body;
  w.runner.context = () => 160000; w.runner.final = () => HANDOFF_MARKER + 'Continue at saved HEAD';
  await tick(w.env, w.o); w.runner.finish(old);
  await deliver(w.env, w.msg('handoff-arrival', 'Follow-up before next tick'), w.o);
  const c = loadConv(w.env, first.conversation);
  assert.notEqual(c.body, old); assert.equal(c.contextHandoffs.length, 1);
  assert.equal(w.log.filter(x => x[0] === 'resume').length, 0);
  assert.match(w.log.filter(x => x[0] === 'start').at(-1)[2], /Continue at saved HEAD/);
  assert.match(w.log.filter(x => x[0] === 'start').at(-1)[2], /Follow-up before next tick/);
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
    await tick(w.env, w.o);
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
    await tick(w.env, w.o);
    c = loadConv(w.env, result.handle);
    assert.equal(c.body, old, mode);
    assert.equal(c.spawn.report, undefined, mode);
    assert.equal(c.contextHandoffs, undefined, mode);
    assert.match(c.waiting, /context handoff held:/, mode);
    assert.equal((await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', action: 'result', handle: result.handle }, w.o)).state, 'pending', mode);
    // Recovery uses the same predecessor's valid note, without dropping history.
    delete c.contextCap.note; saveConv(w.env, c);
    w.runner.final = () => HANDOFF_MARKER + 'Recovered note: continue the unfinished work';
    await tick(w.env, w.o);
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
    await tick(w.env, w.o); w.runner.finish(old); await tick(w.env, w.o);
    c = loadConv(w.env, first.conversation);
    assert.equal(c.body, old); assert.equal(c.contextHandoffs, undefined);
    assert.ok(existsSync(native)); assert.ok(c.contextCap.note);
    assert.equal(w.log.filter(x => x[0] === 'start').length, 1);
    writeFileSync(file, JSON.stringify(record));
    await tick(w.env, w.o);
    c = loadConv(w.env, first.conversation);
    assert.notEqual(c.body, old); assert.equal(c.contextModel.model, record.model);
  }
});
