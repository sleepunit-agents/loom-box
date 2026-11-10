// Agent-to-agent relay (loom docs/specs/agent-runtime.md, section 5, "Agent-to-agent relay"; test 6). The runtime's
// half of test 6 is here: an unpaired relay is refused unless it carries an allowed approval from the approvals piece,
// and with no approvals piece installed it's refused; a paired one delivers (on the runtime's `relay` venue, from the
// agent, starting the other agent's body through the runner interface: test 1's relay case). Core's half (the tool is
// in an agent's MCP session only when the runtime offers it) is in loom's suite (src/offered-tools.integration.test.ts).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliver, deliveryDir, holdsRun, loadConv, tick } from '../src/delivery.mjs';
import { GRANTS, KEY, setRelay } from '../src/grants.mjs';
import { approvalsInstalled, appendRelay, readRelays, relay, relayNotices, relayText, relayTool, relaysOf, RETURN_MS, TOOL } from '../src/relay.mjs';
import { depsOf, originOf } from '../src/relay.mjs';
import { runFor } from '../src/gates-api.mjs';
import { memStore } from '../src/store.mjs';
import { plain, world } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'));

/** A relay's world: the delivery world, a grants document, an approvals piece that spends what `allowed` holds. */
function relayWorld({ pairs = { art: ['mark'], mark: ['art'] }, approvals = true, allowed = {} } = {}) {
  const w = world();
  // The threads that ask are their owner's (as a Comms thread is), so a session can follow its answer into the
  // conversation's own house (t-1952, carriesSession): the world's sender, loren, owns the household here.
  mkdirSync(join(w.env.HOME, '.config', 'loom'), { recursive: true });
  writeFileSync(join(w.env.HOME, '.config', 'loom', 'household.json'), JSON.stringify({ members: [{ person: 'loren', agents: '*' }] }));
  const store = memStore();
  store.put(GRANTS, KEY, { v: 1, pieces: {}, relay: pairs });
  const spent = [];
  const delivered = [];
  const d = {
    // Core's deliver route, as core forwards the runtime's own call: the source is the runtime.
    core: { deliver: async (b) => { delivered.push(b); const r = await deliver(w.env, { ...b, source: 'runtime' }, w.o); if (r.status) throw new Error(r.error); return r; } },
    returnDelivery: (b, o) => deliver(w.env, b, { ...w.o, ...o }),
    store: () => store,
    household: () => ({ v: 1, agents: ['art', 'mark', 'fez'], owner: 'jonathan' }),
    approvals: {
      installed: () => approvals,
      spend: (aid, target, caller, onBehalf) => {
        spent.push({ aid, target, caller, onBehalf });
        if (allowed[aid] !== target) return `${aid} allows nothing for ${target}`;
        delete allowed[aid];
        return '';
      },
    },
    now: () => w.clock.now().getTime(),
    append: (row) => appendRelay(w.env, row, w.clock.now().getTime()),
  };
  return { w, store, d, spent, delivered };
}

const art = { kind: 'agent', agent: 'art', house: 'h-12', service: 'discord' };

describe('test 6: relay', () => {
  test('a paired relay delivers on the relay venue, from the agent, and starts the other agent\'s body', async () => {
    const { w, d, delivered, spent } = relayWorld();
    const r = await relay(w.env, art, { to: 'mark', say: 'can you review loom#12?', why: 'a second pair of eyes' }, d);
    assert.match(r.text, /^r-[0-9a-f]{8}: mark has it\./);
    assert.equal(delivered.length, 1);
    const b = delivered[0];
    assert.equal(b.agent, 'mark');
    assert.equal(b.venue, 'relay');
    assert.equal(b.place, 'art');
    assert.deepEqual(b.from, { kind: 'agent', id: 'art' });
    assert.equal(b.kind, 'message');
    assert.equal(b.id, r.text.slice(0, 10));
    assert.equal(spent.length, 0, 'paired: no approval asked for');
    // The body started through the runner interface, with the relay's words, framed as a peer's request.
    const start = w.log.find((l) => l[0] === 'start');
    assert.ok(start, 'a body started');
    const brief = plain(start[2]);
    assert.ok(brief.includes('art: [Relay r-'), brief);
    assert.ok(brief.includes('another agent in this household, not Jonathan'));
    assert.ok(brief.includes('> can you review loom#12?'));
    assert.ok(brief.includes('the relay tool, with to "art" and reply_to "r-'));
    // Core has the turn first (delivery records first).
    assert.equal(w.core.turns.length, 1);
    assert.equal(w.core.turns[0].venue, 'relay');
    // The log keeps who and when, never the words.
    const kept = readFileSync(join(deliveryDir(w.env), 'relays.jsonl'), 'utf-8');
    assert.equal(kept.includes('review'), false);
    assert.equal(readRelays(w.env, w.clock.now().getTime())[0].conversation, w.core.turns[0].conversation);
  });

  test('an unpaired relay is refused without an approval, and goes once with an allowed one', async () => {
    const allowed = { 'a-0000000f': 'art->fez' };
    const { w, d, delivered, spent } = relayWorld({ allowed });
    await assert.rejects(relay(w.env, art, { to: 'fez', say: 'hi' }, d), /doesn't pair art with fez .*approvals request --kind relay --target art->fez .*--ask 'OK for Art to ask Fez about/);
    assert.equal(delivered.length, 0);
    await assert.rejects(relay(w.env, art, { to: 'fez', say: 'hi', approval: 'a-00000001' }, d), /approval a-00000001 isn't allowed for a relay from art to fez: a-00000001 allows nothing/);
    assert.equal(delivered.length, 0);
    const ok = await relay(w.env, art, { to: 'fez', say: 'hi', approval: 'a-0000000f' }, d);
    assert.match(ok.text, /fez has it/);
    assert.equal(delivered.length, 1);
    // Spent as the calling body: its agent, house and service (the approvals piece matches who asked).
    // Nothing proved which conversation asked: spent for someone loom can't name (t-1953), never the owner by default.
    assert.deepEqual(spent.at(-1), { aid: 'a-0000000f', target: 'art->fez', caller: art, onBehalf: '-' });
    // Spent: once.
    await assert.rejects(relay(w.env, art, { to: 'fez', say: 'hi again', approval: 'a-0000000f' }, d), /isn't allowed/);
    assert.equal(delivered.length, 1);
  });

  test('with no approvals piece installed, an unpaired relay is refused, approval or not', async () => {
    const { w, d, delivered, spent } = relayWorld({ approvals: false, allowed: { 'a-0000000f': 'art->fez' } });
    for (const extra of [{}, { approval: 'a-0000000f' }]) {
      await assert.rejects(relay(w.env, art, { to: 'fez', say: 'hi', ...extra }, d), /no approvals piece is installed/);
    }
    assert.equal(delivered.length, 0);
    assert.equal(spent.length, 0);
    // A paired one still goes.
    assert.match((await relay(w.env, art, { to: 'mark', say: 'hi' }, d)).text, /mark has it/);
  });

  test('pairing is the runtime\'s grants, never household.json; no grants, no pairs', async () => {
    const { w, d, store } = relayWorld({ pairs: {} });
    const hh = d.household;
    d.household = () => ({ ...hh(), relay: { art: ['mark'] } });
    await assert.rejects(relay(w.env, art, { to: 'mark', say: 'hi' }, d), /doesn't pair art with mark/);
    setRelay(store, { agent: 'art', to: ['mark'], agents: ['art', 'mark', 'fez'] });
    assert.match((await relay(w.env, art, { to: 'mark', say: 'hi' }, d)).text, /mark has it/);
    assert.throws(() => setRelay(store, { agent: 'art', to: ['art'], agents: ['art', 'mark'] }), /not another agent/);
    const empty = memStore();
    d.store = () => empty;
    await assert.rejects(relay(w.env, art, { to: 'mark', say: 'something new' }, d), /doesn't pair art with mark/);
  });
});

describe('a relay\'s shape', () => {
  test('an answer is a reply to a relay the other way; the same words within the hour are refused', async () => {
    const { w, d } = relayWorld();
    const first = (await relay(w.env, art, { to: 'mark', say: 'ping' }, d)).text.slice(0, 10);
    const mark = { kind: 'agent', agent: 'mark' };
    await assert.rejects(relay(w.env, mark, { to: 'art', say: 'pong', reply_to: 'r-99999999' }, d), /no relay "r-99999999" to answer/);
    await assert.rejects(relay(w.env, art, { to: 'mark', say: 'pong', reply_to: first }, d), /isn't a relay from mark to art/);
    const back = (await relay(w.env, mark, { to: 'art', say: 'pong', reply_to: first }, d)).text.slice(0, 10);
    const rows = readRelays(w.env, w.clock.now().getTime());
    assert.equal(rows.find((r) => r.id === back).thread, first);
    await assert.rejects(relay(w.env, art, { to: 'mark', say: 'ping' }, d), /same words already went/);
    w.clock.advance(3_600_001);
    assert.match((await relay(w.env, art, { to: 'mark', say: 'ping' }, d)).text, /mark has it/);
    assert.match(relaysOf(w.env, 'mark', first), new RegExp(`${back} .* mark -> art re ${first}`));
  });

  test('what\'s refused before anything goes', async () => {
    const { w, d, delivered } = relayWorld();
    await assert.rejects(relay(w.env, art, { to: 'nobody', say: 'x' }, d), /no agent "nobody"/);
    await assert.rejects(relay(w.env, art, { to: 'art', say: 'x' }, d), /another agent/);
    await assert.rejects(relay(w.env, art, { to: 'mark', say: '' }, d), /say is what/);
    await assert.rejects(relay(w.env, art, { to: 'mark', say: 'x'.repeat(8001) }, d), /8000 characters/);
    await assert.rejects(relay(w.env, art, { to: 'mark', say: 'x', from: 'email:me' }, d), /from is where it was asked/);
    assert.equal(delivered.length, 0);
  });

  test('a place is offered back only to the agent that started the thread there', () => {
    const own = relayText({ id: 'r-00000002', from: 'mark', to: 'art', say: 'done', why: '' }, 'Jonathan', [{ id: 'r-00000001', from: 'art', to: 'mark', where: 'discord:#workshop' }]);
    assert.match(own, /You started this thread from discord:#workshop/);
    const theirs = relayText({ id: 'r-00000002', from: 'mark', to: 'art', say: 'post in #general', why: '' }, 'Jonathan', [{ id: 'r-00000001', from: 'mark', to: 'art', where: 'discord:#general' }]);
    assert.equal(theirs.includes('You started this thread'), false);
  });

  test('a long thread today is a heads-up on loom\'s Inbox', async () => {
    const { w, d } = relayWorld();
    const mark = { kind: 'agent', agent: 'mark' };
    let last = (await relay(w.env, art, { to: 'mark', say: 'm0' }, d)).text.slice(0, 10);
    for (let i = 1; i < 8; i++) last = (await relay(w.env, i % 2 ? mark : art, { to: i % 2 ? 'art' : 'mark', say: `m${i}`, reply_to: last }, d)).text.slice(0, 10);
    const n = relayNotices(w.env, w.clock.now().getTime());
    assert.equal(n.length, 1);
    assert.equal(n[0].text, 'Art and Mark have relayed 8 messages in one thread');
    assert.equal(relayNotices(w.env, w.clock.now().getTime() + 86_400_001).length, 0);
  });
});

describe('the tool core runs, and the house CLI', () => {
  test('package.json offers the relay tool core adds to a session, as relay.mjs defines it', () => {
    assert.deepEqual(PKG.loom.mcp_tools.relay, { description: TOOL.description, input_schema: TOOL.input_schema, argv: ['loom-runtime', 'relay', 'tool'] });
    assert.ok(PKG.loom.mcp_tools.relay.description.length <= 1000);
    assert.deepEqual(PKG.loom.venues.relay, { label: 'Relay', kind: 'agent' });
  });

  test('`relay tool`: the agent from --agent, the arguments on stdin; a refusal is exit 1 with {text, isError}', async () => {
    const { w, d, delivered, spent } = relayWorld({ allowed: { 'a-0000000a': 'art->fez' } });
    const ok = await relayTool(w.env, ['--agent', 'art'], JSON.stringify({ to: 'mark', say: 'hello' }), d);
    assert.equal(ok.exit, 0);
    assert.match(ok.answer.text, /mark has it/);
    assert.equal(delivered[0].from.id, 'art');
    const no = await relayTool(w.env, ['--agent', 'art'], JSON.stringify({ to: 'fez', say: 'hello' }), d);
    assert.deepEqual([no.exit, no.answer.isError], [1, true]);
    await relayTool(w.env, ['--agent', 'art', '--house', 'h-3', '--service', 'slack'], JSON.stringify({ to: 'fez', say: 'hello', approval: 'a-0000000a' }), d);
    assert.deepEqual(spent.at(-1).caller, { kind: 'agent', agent: 'art', house: 'h-3', service: 'slack' });
    assert.deepEqual((await relayTool(w.env, ['--agent', 'art'], 'not json', d)).exit, 1);
  });

  test('from a house: `loom runtime relay` and `relays` as the caller\'s own agent', async () => {
    const { w, d } = relayWorld();
    const r = await runFor(w.env, art, ['relay', '--to', 'mark', '--say', 'from the CLI'], memStore(), undefined, d);
    assert.equal(r.exit, 0, r.stderr);
    assert.match(r.stdout, /mark has it/);
    const no = await runFor(w.env, art, ['relay', '--to', 'fez', '--say', 'x'], memStore(), undefined, d);
    assert.equal(no.exit, 1);
    assert.match(no.stderr, /doesn't pair/);
    assert.equal((await runFor(w.env, art, ['relay', '--to', 'mark', '--yell', 'x'], memStore(), undefined, d)).exit, 2);
    // From a house, relays are its own conversation's only, proved (t-2134): without the proof, nothing.
    const r2 = await runFor(w.env, art, ['relays'], memStore(), undefined, d);
    assert.equal(r2.exit, 1);
    assert.match(r2.stderr, /only its own conversation's, proved/);
    assert.match((await runFor(w.env, { kind: 'agent', agent: 'art' }, ['relays'], memStore(), undefined, d)).stdout, /art -> mark/, 'loom\'s machine: the agent\'s');
  });

  test('the approvals piece counts as installed in loom\'s pieces bin dir or on PATH', () => {
    const D = scratch('rt-relay-ap-');
    mkdirSync(join(D, 'pieces', 'runtime'), { recursive: true });
    mkdirSync(join(D, 'pieces', 'bin'), { recursive: true });
    assert.equal(approvalsInstalled({ LOOM_PIECE_HOME: join(D, 'pieces', 'runtime'), PATH: '/nonexistent' }), false);
    writeFileSync(join(D, 'pieces', 'bin', 'loom-approvals'), '');
    assert.equal(approvalsInstalled({ LOOM_PIECE_HOME: join(D, 'pieces', 'runtime'), PATH: '/nonexistent' }), true);
    assert.equal(approvalsInstalled({ PATH: join(D, 'pieces', 'bin') }), true);
  });
});

describe('relay return to the requesting session', () => {
  test('a reply resumes the original Comms body, retains peer framing and records the turn there', async () => {
    const { w, d, delivered } = relayWorld();
    const origin = await deliver(w.env, w.msg('th:origin', 'ask for a review', { venue: 'loom', source: 'loom' }), w.o);
    const before = loadConv(w.env, origin.conversation);
    const session = w.sessionFor(origin.conversation);
    w.runner.finish(before.body);
    const request = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'review this', conversation: origin.conversation }, d);
    const id = request.text.slice(0, 10);
    const reply = await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'looks good', reply_to: id }, d);
    assert.match(reply.text, /art has it/);
    assert.equal(delivered.length, 1, 'reply does not create a separate relay conversation');
    assert.equal(w.sessionFor(origin.conversation), session, 'same harness session resumes');
    const turn = w.core.turns.at(-1);
    assert.equal(turn.conversation, origin.conversation);
    assert.deepEqual(turn.from, { kind: 'agent', id: 'mark' });
    const feed = w.log.findLast((l) => l[0] === 'resume' || l[0] === 'feed');
    assert.ok(feed, JSON.stringify(w.log));
    assert.match(plain(feed[0] === 'resume' ? feed[4] : feed[2]), /another agent in this household/);
    assert.match(plain(feed[0] === 'resume' ? feed[4] : feed[2]), /looks good/);
    const rec = readRelays(w.env, w.clock.now().getTime()).at(-1);
    assert.equal(rec.conversation, origin.conversation);
  });

  test('foreign and unheld return addresses are refused before a relay or approval spend', async () => {
    const { w, d, delivered } = relayWorld();
    const origin = await deliver(w.env, w.msg('dm:origin', 'hello'), w.o);
    for (const caller of [{ agent: 'mark' }, { agent: 'art', house: 'h-other' }]) {
      await assert.rejects(relay(w.env, caller, { to: caller.agent === 'art' ? 'mark' : 'art', say: 'hello', conversation: origin.conversation }, d), /return conversation must be your own/);
    }
    assert.equal(delivered.length, 0);
  });

  test('a legacy relay without an origin still answers on the relay venue', async () => {
    const { w, d, delivered } = relayWorld();
    const q = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'question' }, d);
    await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'answer', reply_to: q.text.slice(0, 10) }, d);
    assert.equal(delivered.at(-1).venue, 'relay');
  });
});

test('a working origin queues its reply until the turn ends without starting a sibling body', async () => {
  const { w, d } = relayWorld();
  const first = await deliver(w.env, w.msg('th:active', 'review please', { venue: 'loom', source: 'loom' }), w.o);
  const body = loadConv(w.env, first.conversation).body;
  const q = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'check it', conversation: first.conversation }, d);
  await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'checked it', reply_to: q.text.slice(0, 10) }, d);
  assert.equal(loadConv(w.env, first.conversation).body, body);
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 2, 'one requesting body, one reviewing body');
  assert.equal(w.log.filter((l) => l[0] === 'feed').length, 0, 'no live injection');
  assert.equal(loadConv(w.env, first.conversation).queue.length, 1);
  w.runner.finish(body);
  await tick(w.env, w.o);
  const resumed = w.log.findLast((l) => l[0] === 'resume');
  assert.match(plain(resumed[4]), /checked it/);
  assert.deepEqual(loadConv(w.env, first.conversation).runLog.at(-1).relays.length, 1);
});

test('a missing origin falls back visibly to the legacy relay conversation', async () => {
  const { w, d, delivered } = relayWorld();
  const first = await deliver(w.env, w.msg('th:gone', 'hello', { venue: 'loom', source: 'loom' }), w.o);
  const q = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'check it', from: `loom:${first.conversation}` }, d);
  rmSync(join(deliveryDir(w.env), 'conversations', `${first.conversation}.json`));
  const a = await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'checked it', reply_to: q.text.slice(0, 10) }, d);
  assert.equal(delivered.at(-1).venue, 'relay');
  assert.match(a.text, new RegExp(`${first.conversation} is no longer kept; delivered to the relay conversation instead`));
  // A conversation named in from is the origin, never a place offered back to post in.
  assert.equal(readRelays(w.env, w.clock.now().getTime()).find((r) => r.id === q.text.slice(0, 10)).where, '');
});

test('implicit origin requires exactly one active conversation hosted in the calling house', async () => {
  const { w } = relayWorld();
  const caller = { agent: 'art', house: 'h-ours' };
  const host = (cv) => {
    const c = loadConv(w.env, cv);
    const path = join(w.env.LOOM_BOX_DATA, 'bodies', `${c.body.replace(':', '-')}.json`);
    const rec = JSON.parse(readFileSync(path)); rec.house = caller.house;
    writeFileSync(path, JSON.stringify(rec));
  };
  const first = await deliver(w.env, w.msg('dm:first', 'first'), w.o); host(first.conversation);
  assert.equal(originOf(w.env, caller).conversation, first.conversation);
  const second = await deliver(w.env, w.msg('dm:second', 'second'), w.o); host(second.conversation);
  assert.equal(originOf(w.env, caller), null, 'never chooses the newest conversation');
  // Named but unproven, with a sibling as trusted at work, it isn't taken either (round 2 of the cold review).
  assert.equal(originOf(w.env, caller, first.conversation), null);
});

test('returning replies to Comms still pauses a near-identical relay ping-pong loop', async () => {
  const { w, d } = relayWorld();
  const origins = {};
  for (const agent of ['art', 'mark']) {
    origins[agent] = (await deliver(w.env, w.msg(`th:${agent}`, 'review work', { agent, venue: 'loom', source: 'loom' }), w.o)).conversation;
  }
  let last;
  for (let i = 1; i <= 12; i++) {
    const [from, to] = i % 2 ? ['art', 'mark'] : ['mark', 'art'];
    // Each side relays from its thread's body, proving it (the house CLI's key and session).
    const c = loadConv(w.env, origins[from]);
    const proof = c.body ? { key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(origins[from]) } : {};
    const result = await relay(w.env, { agent: from }, { to, say: `Thanks, got it! (${i})`, conversation: origins[from], ...(last ? { reply_to: last } : {}) }, d, proof);
    last = result.text.slice(0, 10);
    // The sender's turn ends after it relays (it was at work when it asked); the answer then resumes it.
    const sent = loadConv(w.env, origins[from]);
    if (sent.body) w.runner.finish(sent.body, { failed: false, worked: true });
    await tick(w.env, w.o);
    w.clock.advance(60_000);
  }
  for (const cv of Object.values(origins)) assert.ok(w.core.turns.filter((t) => t.conversation === cv && t.from?.kind === 'agent').length >= 2, 'the replies came back to the threads');
  assert.ok(Object.values(origins).some((cv) => loadConv(w.env, cv).paused?.pattern === 'ping-pong'));
});

// Core names a caller's agent and house, never its conversation: a named return address is a claim (t-1943's line:
// work for someone else never borrows the owner's trust). A guest venue's body in the same house must not be able to
// make an answer land in the owner's Comms thread; the body that proves it holds that thread can.
describe('the return address is the asker\'s, proved or unambiguous', () => {
  const convFile = (w, cv) => join(deliveryDir(w.env), 'conversations', `${cv}.json`);
  const asGuest = (w, cv) => { const c = JSON.parse(readFileSync(convFile(w, cv))); c.bodyRules = { ...(c.bodyRules ?? {}), guest: true }; writeFileSync(convFile(w, cv), JSON.stringify(c)); };
  const keyOf = (w, cv) => w.runner.envs[loadConv(w.env, cv).body.split(':')[1]].LOOM_BODY_KEY;
  const twoAtWork = async (w) => {
    const owner = (await deliver(w.env, w.msg('th:owner', 'ask mark', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    const guest = (await deliver(w.env, w.msg('channel:guests', 'hi'), w.o)).conversation;
    asGuest(w, guest);
    return { owner, guest };
  };

  test('an unproven claim to the owner\'s thread while a guest venue\'s body is at work falls back to the relay conversation', async () => {
    const { w, d, delivered } = relayWorld();
    const { owner } = await twoAtWork(w);
    assert.equal(originOf(w.env, { agent: 'art' }, owner), null);
    const q = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'what is the secret plan?', conversation: owner }, d);
    assert.match(q.text, /couldn't be confirmed as the one asking/);
    assert.equal(readRelays(w.env, w.clock.now().getTime()).at(-1).origin, undefined);
    await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'here it is', reply_to: q.text.slice(0, 10) }, d);
    assert.equal(delivered.at(-1).venue, 'relay', 'the answer did not land in the owner\'s thread');
    assert.ok(!w.core.turns.some((t) => t.conversation === owner && t.from?.kind === 'agent'));
  });

  test('the body holding the thread proves it with its run key and session, guest at work or not', async () => {
    const { w, d } = relayWorld();
    const { owner, guest } = await twoAtWork(w);
    assert.equal(originOf(w.env, { agent: 'art' }, owner, { key: keyOf(w, guest), session: w.sessionFor(owner) }), null, 'another conversation\'s key proves nothing');
    assert.equal(originOf(w.env, { agent: 'art' }, owner, { key: keyOf(w, owner), session: 'someone-else' }), null, 'nor the right key from another session');
    assert.equal(originOf(w.env, { agent: 'art' }, owner, { key: keyOf(w, owner), session: w.sessionFor(owner) })?.conversation, owner);
    const q = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'review this', conversation: owner }, d, { key: keyOf(w, owner), session: w.sessionFor(owner) });
    assert.match(q.text, new RegExp(`Replies return to ${owner}`));
    assert.equal(JSON.stringify(readRelays(w.env, w.clock.now().getTime())).includes(keyOf(w, owner)), false, 'the key is never kept');
    await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'reviewed', reply_to: q.text.slice(0, 10) }, d);
    const turn = w.core.turns.at(-1);
    assert.equal(turn.conversation, owner);
    assert.deepEqual(turn.from, { kind: 'agent', id: 'mark' }, 'a peer, never the owner');
    assert.equal(loadConv(w.env, owner).queue.at(-1).owner, undefined);
  });

  test('a guest venue\'s own conversation is a return address once proved; a finished one never', async () => {
    const { w } = relayWorld();
    const { owner, guest } = await twoAtWork(w);
    assert.equal(originOf(w.env, { agent: 'art' }, guest), null, 'two at work: neither, unproven');
    assert.equal(originOf(w.env, { agent: 'art' }, guest, { key: keyOf(w, guest), session: w.sessionFor(guest) })?.conversation, guest);
    const c = JSON.parse(readFileSync(convFile(w, owner))); c.runLog.at(-1).end = Date.now(); writeFileSync(convFile(w, owner), JSON.stringify(c));
    asGuest(w, owner);
    assert.equal(originOf(w.env, { agent: 'art' }, owner), null, 'no body is at work there to have asked');
  });

  test('a body on loom\'s machine relays from its shell only with its proof (t-1953)', async () => {
    const dir = scratch('relay-local-');
    const env = { ...process.env, HOME: dir, LOOM_RUNTIME_PIECE: 'runtime', LOOM_BODY_CONVERSATION: 'cv-0123456789ab', LOOM_BODY_KEY: 'k-not-its-key', CLAUDE_CODE_SESSION_ID: 'sess-1' };
    delete env.LOOM_URL; delete env.LOOM_TOKEN_FILE;
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.mjs'), 'relay', '--to', 'mark', '--say', 'hi'], { env });
      let stderr = ''; child.stderr.on('data', (x) => { stderr += x; });
      child.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /can't prove it holds cv-0123456789ab/);
    assert.equal(readRelays({ ...env }, Date.now()).length, 0, 'nothing sent');
    // A real conversation of a body here, with the wrong key: refused at the proof itself.
    const { w } = relayWorld();
    const cv = (await deliver(w.env, w.msg('th:local', 'ask mark', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    assert.ok(loadConv(w.env, cv).body, 'a body holds it');
    const wrong = { ...process.env, ...w.env, LOOM_BODY_CONVERSATION: cv, LOOM_BODY_KEY: 'k-not-its-key', CLAUDE_CODE_SESSION_ID: 'sess-1' };
    delete wrong.LOOM_URL; delete wrong.LOOM_TOKEN_FILE;
    const r2 = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.mjs'), 'relay', '--to', 'mark', '--say', 'hi'], { env: wrong });
      let stderr = ''; child.stderr.on('data', (x) => { stderr += x; });
      child.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, new RegExp(`can't prove it holds ${cv}`));
    assert.equal(readRelays(w.env, w.clock.now().getTime()).length, 0, 'nothing sent');
  });

  test('the house CLI names its conversation and sends its proof in the call\'s body, never argv', async (t) => {
    const calls = [];
    const server = createServer(async (req, res) => {
      let body = ''; for await (const part of req) body += part;
      calls.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ exit: 0, stdout: 'ok\n', stderr: '' }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const dir = scratch('relay-proof-');
    writeFileSync(join(dir, 'token'), 'test-house-token');
    const cv = 'cv-0123456789ab';
    const env = { ...process.env, HOME: dir, LOOM_RUNTIME_PIECE: 'runtime', LOOM_URL: `http://127.0.0.1:${server.address().port}/mcp`, LOOM_TOKEN_FILE: join(dir, 'token'), LOOM_BODY_CONVERSATION: cv, LOOM_BODY_KEY: 'k-run-secret', CLAUDE_CODE_SESSION_ID: 'sess-1234' };
    delete env.CODEX_THREAD_ID;
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.mjs'), 'relay', '--to', 'mark', '--say', 'hi'], { env });
      let stderr = ''; child.stderr.on('data', (x) => { stderr += x; });
      child.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(calls[0].argv, ['relay', '--to', 'mark', '--say', 'hi', '--conversation', cv]);
    assert.equal(calls[0].key, 'k-run-secret');
    assert.equal(calls[0].session, 'sess-1234');
    const { w } = relayWorld();
    const r = await runFor(w.env, { kind: 'agent', agent: 'art' }, ['relay', '--to', 'mark', '--say', 'x', '--key', 'k'], memStore());
    assert.equal(r.exit, 2, '--key is not a flag: proof never rides in argv');
  });
});

describe('a relay approval is spent only for whom it was asked (t-1953)', () => {
  const proofOf = (w, cv) => ({ key: w.runner.envs[loadConv(w.env, cv).body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(cv) });
  test('a proven conversation spends for whom it acts: the owner\'s for the owner, a person\'s for that person', async () => {
    const { w, d, spent } = relayWorld({ allowed: { 'a-00000011': 'art->fez', 'a-00000012': 'art->fez', 'a-00000013': 'art->fez' } });
    // Loren owns the household here: her Comms thread is the owner's.
    const mine = (await deliver(w.env, w.msg('th:mine', 'ask fez', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    await relay(w.env, { agent: 'art' }, { to: 'fez', say: 'one', conversation: mine, approval: 'a-00000011' }, d, proofOf(w, mine));
    assert.equal(spent.at(-1).onBehalf, 'owner');
    // Dan isn't an owner: a conversation only he steered acts for him.
    const dans = (await deliver(w.env, w.msg('dm:dan', 'ask fez for me', { from: { kind: 'person', slug: 'dan' } }), w.o)).conversation;
    await relay(w.env, { agent: 'art' }, { to: 'fez', say: 'two', conversation: dans, approval: 'a-00000012' }, d, proofOf(w, dans));
    assert.equal(spent.at(-1).onBehalf, 'dan');
    // The same conversation named without proof (the MCP tool): someone loom can't name, and the refusal says how to prove it.
    d.approvals.spend = (aid, target, caller, onBehalf) => { spent.push({ aid, target, caller, onBehalf }); return onBehalf === 'owner' ? '' : `${aid} was asked for the owner; this body acts for someone loom can't name`; };
    await assert.rejects(relay(w.env, { agent: 'art' }, { to: 'fez', say: 'three', conversation: mine, approval: 'a-00000013' }, d), /someone loom can't name.*`loom runtime relay` proves it/);
    assert.equal(spent.at(-1).onBehalf, '-');
    // A proof for another conversation proves nothing about this one: spent (tried) for no one loom can name.
    const before = spent.length;
    await assert.rejects(relay(w.env, { agent: 'art' }, { to: 'fez', say: 'four', conversation: mine, approval: 'a-00000013' }, d, proofOf(w, dans)), /was asked for the owner/);
    assert.equal(spent.length, before + 1, 'it reached the spend');
    assert.equal(spent.at(-1).onBehalf, '-');
    // Several people steered it: no one person, so no one loom can name (fails closed; approvals then refuses).
    const both = (await deliver(w.env, w.msg('dm:group', 'ask fez', { from: { kind: 'person', slug: 'dan' } }), w.o)).conversation;
    await deliver(w.env, w.msg('dm:group', 'me too', { from: { kind: 'person', slug: 'eve' } }), w.o);
    assert.equal(holdsRun(w.env, both, proofOf(w, both)), true, 'proved: the - is whom it acts for, not a missing proof');
    await assert.rejects(relay(w.env, { agent: 'art' }, { to: 'fez', say: 'five', conversation: both, approval: 'a-00000013' }, d, proofOf(w, both)));
    assert.equal(spent.at(-1).onBehalf, '-');
    assert.equal(spent.length, before + 2);
  });

  test('the real spend passes --on-behalf to approvals use', () => {
    const dir = scratch('relay-spend-');
    const log = join(dir, 'argv');
    const bin = join(dir, 'loom');
    writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(bin, 0o755);
    assert.equal(depsOf({ LOOM_BIN: bin, PATH: process.env.PATH }).approvals.spend('a-00000021', 'art->fez', { kind: 'agent', agent: 'art' }, 'dan'), '');
    const argv = JSON.parse(readFileSync(log, 'utf-8'));
    assert.deepEqual(argv.slice(-2), ['--on-behalf', 'dan']);
    assert.deepEqual(argv.slice(0, 6), ['approvals', 'use', 'a-00000021', '--kind', 'relay', '--target']);
  });
});

describe('round 1 of the cold review: what the answer\'s sender can\'t choose', () => {
  test('the answering peer can\'t supply or replace the return address', async () => {
    const { w, d } = relayWorld();
    const asked = (await deliver(w.env, w.msg('th:asked', 'ask mark', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    const other = (await deliver(w.env, w.msg('th:other', 'something else', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    const marks = (await deliver(w.env, w.msg('th:marks', 'hi', { agent: 'mark', venue: 'loom', source: 'loom' }), w.o)).conversation;
    const proof = { key: w.runner.envs[loadConv(w.env, asked).body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(asked) };
    const q = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'question', conversation: asked }, d, proof);
    const id = q.text.slice(0, 10);
    for (const steer of [{ conversation: other }, { from: `loom:${other}` }, { from: other }]) {
      await assert.rejects(relay(w.env, { agent: 'mark' }, { to: 'art', say: `answer ${JSON.stringify(steer)}`, reply_to: id, ...steer }, d), /return conversation must be your own/);
    }
    // Naming its own conversation is fine, and changes where *its* answers go, never where this one does.
    await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'the answer', reply_to: id, conversation: marks }, d);
    const turn = w.core.turns.at(-1);
    assert.equal(turn.conversation, asked);
    assert.ok(!w.core.turns.some((t) => t.conversation === other && t.from?.kind === 'agent'));
  });

  test('a relay conversation is never a return address; a platform place ending in a cv id is only a place', async () => {
    const { w, d, delivered } = relayWorld({ pairs: { art: ['mark', 'fez'], mark: ['art'], fez: ['art'] } });
    await relay(w.env, { agent: 'fez' }, { to: 'art', say: 'hello art' }, d);
    const relayCv = readRelays(w.env, w.clock.now().getTime()).at(-1).conversation;
    assert.equal(loadConv(w.env, relayCv).venue, 'relay');
    assert.equal(originOf(w.env, { agent: 'art' }, relayCv), null);
    const r = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'from a channel', from: 'discord:#cv-0123456789ab' }, d);
    assert.match(r.text, /mark has it/);
    assert.equal(delivered.at(-1).venue, 'relay');
  });

  test('proof fails closed: no session named, or a run no longer at work, proves nothing', async () => {
    const { w } = relayWorld();
    const cv = (await deliver(w.env, w.msg('th:p', 'hi', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    const key = w.runner.envs[loadConv(w.env, cv).body.split(':')[1]].LOOM_BODY_KEY;
    assert.equal(holdsRun(w.env, cv, { key }), false);
    assert.equal(holdsRun(w.env, cv, { key, session: w.sessionFor(cv) }), true);
    w.runner.finish(loadConv(w.env, cv).body);
    await tick(w.env, w.o);
    assert.equal(originOf(w.env, { agent: 'art' }, cv, { key, session: w.sessionFor(cv) }), null);
  });

  test('the detached return path: the answer waits on disk, marked untilIdle, for a worker that knows nothing of it', async () => {
    const { w, d } = relayWorld();
    const spawned = [];
    d.returnDelivery = (b, o) => deliver(w.env, b, { ...w.o, ...o, detach: true, spawnWorker: (cv) => spawned.push(cv) });
    const cv = (await deliver(w.env, w.msg('th:det', 'ask mark', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    const body = loadConv(w.env, cv).body;
    const q = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'check', conversation: cv }, d);
    await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'checked', reply_to: q.text.slice(0, 10) }, d);
    assert.deepEqual(spawned, [cv]);
    assert.equal(loadConv(w.env, cv).queue.at(-1).untilIdle, true);
    await tick(w.env, w.o);
    assert.equal(w.log.filter((l) => l[0] === 'feed').length, 0, 'never fed mid-turn by the worker\'s plain tick');
    w.runner.finish(body);
    await tick(w.env, w.o);
    assert.match(plain(w.log.findLast((l) => l[0] === 'resume')[4]), /checked/);
  });

  test('the house CLI refuses to name a conversation other than its own', async () => {
    const dir = scratch('relay-other-');
    writeFileSync(join(dir, 'token'), 't');
    const env = { ...process.env, HOME: dir, LOOM_RUNTIME_PIECE: 'runtime', LOOM_URL: 'http://127.0.0.1:9/mcp', LOOM_TOKEN_FILE: join(dir, 'token'), LOOM_BODY_CONVERSATION: 'cv-0123456789ab', LOOM_BODY_KEY: 'k' };
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.mjs'), 'relay', '--to', 'mark', '--say', 'hi', '--conversation', 'cv-ba9876543210'], { env });
      let stderr = ''; child.stderr.on('data', (x) => { stderr += x; });
      child.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /this body's own/);
  });
});

describe('round 2 of the cold review', () => {
  const convFile = (w, cv) => join(deliveryDir(w.env), 'conversations', `${cv}.json`);
  const edit = (w, cv, f) => { const c = JSON.parse(readFileSync(convFile(w, cv))); f(c); writeFileSync(convFile(w, cv), JSON.stringify(c)); };
  const keyOf = (w, cv) => w.runner.envs[loadConv(w.env, cv).body.split(':')[1]].LOOM_BODY_KEY;

  test('a guest venue\'s body can\'t claim an ordinary conversation either (a DM with a person)', async () => {
    const { w } = relayWorld();
    const dm = (await deliver(w.env, w.msg('dm:robin', 'hi'), w.o)).conversation;
    const guest = (await deliver(w.env, w.msg('channel:guests', 'hi'), w.o)).conversation;
    edit(w, guest, (c) => { c.bodyRules = { guest: true }; });
    assert.equal(originOf(w.env, { agent: 'art' }, dm), null);
    assert.equal(originOf(w.env, { agent: 'art' }, guest), null, 'nor the reverse: the DM\'s body can\'t send an answer to the guests');
  });

  test('two conversations as trusted at work: neither can be claimed unproven', async () => {
    const { w } = relayWorld();
    const a = (await deliver(w.env, w.msg('th:a', 'one', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    await deliver(w.env, w.msg('th:b', 'two', { venue: 'loom', source: 'loom' }), w.o);
    assert.equal(originOf(w.env, { agent: 'art' }, a), null);
    assert.equal(originOf(w.env, { agent: 'art' }, a, { key: keyOf(w, a), session: w.sessionFor(a) })?.conversation, a, 'proved, it stands');
  });

  test('a key with no session the runner can name proves nothing (fail closed)', async () => {
    const { w } = relayWorld();
    const a = (await deliver(w.env, w.msg('th:a', 'one', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    await deliver(w.env, w.msg('th:b', 'two', { venue: 'loom', source: 'loom' }), w.o);
    const key = keyOf(w, a);
    // A body whose host hasn't reported a session yet: neither the runner nor its record names one.
    const ref = loadConv(w.env, a).body;
    assert.equal(holdsRun(w.env, a, { key, session: w.sessionFor(a) }, w.o), true, 'named, it proves');
    const path = join(w.env.LOOM_BOX_DATA, 'bodies', `${ref.replace(':', '-')}.json`);
    const rec = JSON.parse(readFileSync(path)); delete rec.slot; writeFileSync(path, JSON.stringify(rec));
    const slotOf = w.runner.slotOf;
    w.runner.slotOf = () => null;
    try {
      assert.equal(holdsRun(w.env, a, { key, session: 'anything-1' }, w.o), false);
      assert.equal(holdsRun(w.env, a, { key }, w.o), false);
    } finally { w.runner.slotOf = slotOf; }
  });

  test('the MCP tool never takes proof from its arguments', async () => {
    const { w, d } = relayWorld();
    const a = (await deliver(w.env, w.msg('th:a', 'one', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    await deliver(w.env, w.msg('th:b', 'two', { venue: 'loom', source: 'loom' }), w.o);
    const r = await relayTool(w.env, ['--agent', 'art'], JSON.stringify({ to: 'mark', say: 'hi', conversation: a, key: keyOf(w, a), session: w.sessionFor(a) }), d);
    assert.match(r.answer.text, /couldn't be confirmed/);
  });

  test('an answer more than 6 hours after the ask goes to the relay conversation, and says why', async () => {
    const { w, d, delivered } = relayWorld();
    const a = (await deliver(w.env, w.msg('th:a', 'ask', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    const q = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'q', conversation: a }, d);
    w.clock.advance(RETURN_MS + 1000);
    const r = await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'late answer', reply_to: q.text.slice(0, 10) }, d);
    assert.match(r.text, /asked over 6 hours ago/);
    assert.equal(delivered.at(-1).venue, 'relay');
  });

  test('an answer still needs the pairing, or an approval', async () => {
    const { w, d } = relayWorld({ pairs: { art: ['mark'] }, approvals: false });
    const q = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'q' }, d);
    await assert.rejects(relay(w.env, { agent: 'mark' }, { to: 'art', say: 'a', reply_to: q.text.slice(0, 10) }, d), /doesn't pair mark with art/);
  });

  test('briefs offer the return only where it can happen', async () => {
    const { w, d } = relayWorld();
    await deliver(w.env, w.msg('th:a', 'ask', { venue: 'loom', source: 'loom' }), w.o);
    assert.match(plain(w.log.find((l) => l[0] === 'start')[2] ?? ''), /loom runtime relay --to/);
    await relay(w.env, { agent: 'fez' }, { to: 'art', say: 'hello' }, d).catch(() => {});
    const relayStart = w.log.filter((l) => l[0] === 'start').map((l) => plain(l[2] ?? '')).find((t) => /on relay/.test(t));
    if (relayStart) assert.doesNotMatch(relayStart, /come back here/);
  });
});

describe('round 3 of the cold review', () => {
  test('a returned relay\'s id never reaches the venue\'s adapter as a message to mark', async () => {
    const { w, d } = relayWorld();
    const cv = (await deliver(w.env, w.msg('th:ack', 'ask mark', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    const q = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'q', conversation: cv }, d);
    await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'a', reply_to: q.text.slice(0, 10) }, d);
    w.runner.finish(loadConv(w.env, cv).body);
    await tick(w.env, w.o);
    assert.match(plain(w.log.findLast((l) => l[0] === 'resume')[4]), /\ba\b/);
    const named = w.core.commsCalls.flatMap((b) => b.messages ?? []);
    assert.ok(!named.some((m) => /^r-[0-9a-f]{8}$/.test(m)), JSON.stringify(named));
  });
});

describe('a body the record lost track of still counts', () => {
  // A reseat clears c.body with the run still open, even when ending that body failed and it is still mid-turn: until
  // the run is closed, that conversation could be the one making a claim (security reviews of #99).
  const caller = { agent: 'art', house: 'h-ours' };
  const setup = async () => {
    const { w } = relayWorld();
    const conv = async (place) => {
      const cv = (await deliver(w.env, w.msg(place, place, { venue: 'loom', source: 'loom' }), w.o)).conversation;
      const path = join(w.env.LOOM_BOX_DATA, 'bodies', `${loadConv(w.env, cv).body.replace(':', '-')}.json`);
      const rec = JSON.parse(readFileSync(path)); rec.house = caller.house; writeFileSync(path, JSON.stringify(rec));
      return cv;
    };
    const lose = (cv) => {
      const f = join(deliveryDir(w.env), 'conversations', `${cv}.json`);
      const c = JSON.parse(readFileSync(f)); delete c.body; writeFileSync(f, JSON.stringify(c));
    };
    return { w, conv, lose };
  };

  for (const who of [caller, { agent: 'art' }]) {
    test(`its open run still blocks a claim on another conversation (${who.house ? 'house' : 'no house'} caller)`, async () => {
      const { w, conv, lose } = await setup();
      const a = await conv('th:a');
      const b = await conv('th:b');
      lose(b);
      // A caller in no house is refused a house body's conversation outright (t-1952); one in the house gets none.
      if (who.house) assert.equal(originOf(w.env, who, a), null);
      else assert.throws(() => originOf(w.env, who, a), /held by a body in your house/);
      if (who.house) assert.equal(originOf(w.env, who), null, 'nor is a single one inferred');
    });
  }

  test('a conversation no body holds is never the return address, even alone', async () => {
    const { w, conv, lose } = await setup();
    const b = await conv('th:b');
    lose(b);
    assert.equal(originOf(w.env, { agent: 'art' }, b), null);
    assert.equal(originOf(w.env, caller, b), null, 'no return address, and the ask itself isn\'t refused');
    assert.equal(originOf(w.env, caller), null);
  });

  test('a body at work in another house doesn\'t block a house caller; one whose house can\'t be read does', async () => {
    const { w, conv } = await setup();
    const a = await conv('th:a');
    const other = (await deliver(w.env, w.msg('th:other', 'x', { venue: 'loom', source: 'loom' }), w.o)).conversation;
    const path = join(w.env.LOOM_BOX_DATA, 'bodies', `${loadConv(w.env, other).body.replace(':', '-')}.json`);
    const rec = JSON.parse(readFileSync(path)); rec.house = 'h-elsewhere'; writeFileSync(path, JSON.stringify(rec));
    assert.equal(originOf(w.env, caller, a)?.conversation, a);
    rmSync(path);
    assert.equal(originOf(w.env, caller, a), null);
  });

  test('alone and held, a house caller\'s conversation is still inferred', async () => {
    const { w, conv } = await setup();
    const a = await conv('th:a');
    assert.equal(originOf(w.env, caller)?.conversation, a);
    assert.equal(originOf(w.env, caller, a)?.conversation, a);
  });
});

describe('place: a body asks where it is (t-1745)', () => {
  test('only the body holding the conversation, proved by its key and session, hears its venue, place and members', async () => {
    const w = world();
    const cv = (await deliver(w.env, w.msg('dm:U1', 'hi', { venue: 'slack', label: 'DM with Phil', from: { kind: 'person', slug: 'phil' } }), w.o)).conversation;
    const c = loadConv(w.env, cv);
    const key = w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY;
    const session = w.sessionFor(cv);
    const r = await runFor(w.env, { kind: 'agent', agent: 'art' }, ['place', '--conversation', cv], memStore(), undefined, undefined, { key, session });
    assert.equal(r.exit, 0, JSON.stringify(r));
    assert.deepEqual(JSON.parse(r.stdout), { conversation: cv, agent: 'art', venue: 'slack', place: 'dm:U1', label: 'DM with Phil', members: [], principal: { for: 'phil', owner: false, ownerSpoke: false } });
    const no = async (caller, proof, argv = ['place', '--conversation', cv]) => (await runFor(w.env, caller, argv, memStore(), undefined, undefined, proof)).exit;
    assert.equal(await no({ kind: 'agent', agent: 'art' }, { key }), 1, 'no session: proves nothing');
    assert.equal(await no({ kind: 'agent', agent: 'art' }, { key, session: 'someone-else' }), 1, 'another session');
    assert.equal(await no({ kind: 'agent', agent: 'art' }, { key: 'f'.repeat(64), session }), 1, 'another key');
    assert.equal(await no({ kind: 'agent', agent: 'mark' }, { key, session }), 1, 'another agent');
    assert.equal(await no({ kind: 'agent', agent: 'art' }, { key, session }, ['place']), 2, 'it names its conversation');
  });
});

describe('place in a place with members (t-1745)', () => {
  test('its members, and when they were taken, come from the body\'s own rules', async () => {
    const w = world();
    const about = { 'group:G1': { venue: 'G1', members: ['phil', 'anton'] } };
    Object.assign(w.o, {
      gates: () => ({ people: { phil: { name: 'Phil', tier: 2 }, anton: { name: 'Anton', tier: 2 } } }),
      card: () => null,
      policy: () => ({}),
      venues: () => ({ slack: { kind: 'live', send: [process.execPath, join(import.meta.dirname, 'fake-send.mjs')] } }),
      adapter: async (argv, c, args) => (args[0] === '--describe' ? { ok: true, ...about[c.place] } : { ok: true }),
    });
    const cv = (await deliver(w.env, w.msg('group:G1', 'hi', { venue: 'slack', label: 'group DM', from: { kind: 'person', slug: 'phil' } }), w.o)).conversation;
    const c = loadConv(w.env, cv);
    const proof = { key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(cv) };
    const r = await runFor(w.env, { kind: 'agent', agent: 'art' }, ['place', '--conversation', cv], memStore(), undefined, undefined, proof);
    const p = JSON.parse(r.stdout);
    assert.deepEqual(p.members, ['phil', 'anton']);
    assert.equal(p.membersAt, c.bodyRules.membersAt);
    assert.match(p.membersAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(p.principal, { for: 'phil', owner: false, ownerSpoke: false });
  });
});

describe('relays and answers held to the house holding the conversation (t-2134)', () => {
  const inHouse = (w, cv, house) => {
    const c = loadConv(w.env, cv);
    const path = join(w.env.LOOM_BOX_DATA, 'bodies', `${c.body.replace(':', '-')}.json`);
    const rec = JSON.parse(readFileSync(path)); rec.house = house;
    writeFileSync(path, JSON.stringify(rec));
    return { key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(cv) };
  };

  test('a house lists only the relays its own conversation asked or was reached by', async () => {
    const { w, d } = relayWorld();
    const mine = (await deliver(w.env, w.msg('dm:mine', 'mine'), w.o)).conversation;
    const other = (await deliver(w.env, w.msg('dm:other', 'other'), w.o)).conversation;
    const proof = inHouse(w, mine, 'h-12');
    const caller = { kind: 'agent', agent: 'art', house: 'h-12' };
    await relay(w.env, caller, { to: 'mark', say: 'from mine', conversation: mine }, d, proof);
    await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'from elsewhere', why: 'elsewhere', conversation: other }, d);
    const listed = await runFor(w.env, caller, ['relays', '--conversation', mine], memStore(), undefined, d, proof);
    assert.equal(listed.exit, 0, listed.stderr);
    assert.match(listed.stdout, /art -> mark/);
    assert.doesNotMatch(listed.stdout, /elsewhere/);
    assert.equal(listed.stdout.trim().split('\n').length, 1);
    // Another conversation's id, or this one's without its proof: refused.
    assert.equal((await runFor(w.env, caller, ['relays', '--conversation', other], memStore(), undefined, d, proof)).exit, 1);
    assert.equal((await runFor(w.env, caller, ['relays', '--conversation', mine], memStore(), undefined, d, {})).exit, 1);
  });

  test('an answer from another house of the agent goes to the relay conversation, never the asker\'s', async () => {
    const { w, d, delivered } = relayWorld();
    const origin = await deliver(w.env, w.msg('th:origin', 'ask for a review', { venue: 'loom', source: 'loom' }), w.o);
    w.runner.finish(loadConv(w.env, origin.conversation).body);
    const id = (await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'review this', conversation: origin.conversation }, d)).text.slice(0, 10);
    const reached = readRelays(w.env, w.clock.now().getTime()).find((r) => r.id === id).conversation;
    const proofM = inHouse(w, reached, 'h-mark');
    const reply = await relay(w.env, { agent: 'mark', house: 'h-elsewhere' }, { to: 'art', say: 'looks good from elsewhere', reply_to: id }, d);
    assert.match(reply.text, /Only where the body of the conversation .* runs does an answer go into the asker's/);
    assert.equal(delivered.at(-1).venue, 'relay');
    assert.notEqual(w.core.turns.at(-1)?.conversation, origin.conversation);
    // Nor from loom's machine (no house) when the reached conversation's body runs in a house.
    const local = await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'looks good from loom\'s machine', reply_to: id }, d);
    assert.match(local.text, /Only where the body of the conversation/);
    // From that house, but not as that conversation (a sibling body there, which can't prove it): the relay conversation.
    const sibling = await relay(w.env, { agent: 'mark', house: 'h-mark' }, { to: 'art', say: 'a sibling answers', reply_to: id }, d);
    assert.match(sibling.text, /Only where the body of the conversation/);
    // As the conversation it reached, proved: returned to the asker's conversation.
    const back = await relay(w.env, { agent: 'mark', house: 'h-mark' }, { to: 'art', say: 'looks good', reply_to: id, conversation: reached }, d, proofM);
    assert.match(back.text, new RegExp(`Returned to ${origin.conversation}`));
    // Its house lists what reached it and its own answer from there; never the sibling's answer from elsewhere.
    const listed = await runFor(w.env, { kind: 'agent', agent: 'mark', house: 'h-mark' }, ['relays', '--conversation', reached], memStore(), undefined, d, proofM);
    assert.equal(listed.exit, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`${back.text.slice(0, 10)} `));
    assert.match(listed.stdout, new RegExp(`${id} `));
    assert.doesNotMatch(listed.stdout, new RegExp(sibling.text.slice(0, 10)));
    assert.equal(listed.stdout.trim().split('\n').length, 2, listed.stdout);
  });
});
