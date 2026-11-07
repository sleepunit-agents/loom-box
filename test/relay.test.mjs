// Agent-to-agent relay (loom docs/specs/agent-runtime.md, section 5, "Agent-to-agent relay"; test 6). The runtime's
// half of test 6 is here: an unpaired relay is refused unless it carries an allowed approval from the approvals piece,
// and with no approvals piece installed it's refused; a paired one delivers (on the runtime's `relay` venue, from the
// agent, starting the other agent's body through the runner interface: test 1's relay case). Core's half (the tool is
// in an agent's MCP session only when the runtime offers it) is in loom's suite (src/offered-tools.integration.test.ts).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliver, deliveryDir, loadConv, tick } from '../src/delivery.mjs';
import { GRANTS, KEY, setRelay } from '../src/grants.mjs';
import { approvalsInstalled, appendRelay, readRelays, relay, relayNotices, relayText, relayTool, relaysOf, TOOL } from '../src/relay.mjs';
import { originOf } from '../src/relay.mjs';
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
      spend: (aid, target, caller) => {
        spent.push({ aid, target, caller });
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
    await assert.rejects(relay(w.env, art, { to: 'fez', say: 'hi' }, d), /doesn't pair art with fez .*approvals request --kind relay --target art->fez/);
    assert.equal(delivered.length, 0);
    await assert.rejects(relay(w.env, art, { to: 'fez', say: 'hi', approval: 'a-00000001' }, d), /approval a-00000001 isn't allowed for a relay from art to fez: a-00000001 allows nothing/);
    assert.equal(delivered.length, 0);
    const ok = await relay(w.env, art, { to: 'fez', say: 'hi', approval: 'a-0000000f' }, d);
    assert.match(ok.text, /fez has it/);
    assert.equal(delivered.length, 1);
    // Spent as the calling body: its agent, house and service (the approvals piece matches who asked).
    assert.deepEqual(spent.at(-1), { aid: 'a-0000000f', target: 'art->fez', caller: art });
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
    assert.match((await runFor(w.env, art, ['relays'], memStore(), undefined, d)).stdout, /art -> mark/);
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
  await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'checked it', reply_to: q.text.slice(0, 10) }, d);
  assert.equal(delivered.at(-1).venue, 'relay');
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
  assert.equal(originOf(w.env, caller, first.conversation).conversation, first.conversation);
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
    const proof = { key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(origins[from]) };
    const result = await relay(w.env, { agent: from }, { to, say: `Thanks, got it! (${i})`, conversation: origins[from], ...proof, ...(last ? { reply_to: last } : {}) }, d);
    last = result.text.slice(0, 10);
    for (const cv of Object.values(origins)) {
      const c = loadConv(w.env, cv);
      if (c.body) w.runner.finish(c.body, { failed: false, worked: true });
    }
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
    const q = await relay(w.env, { agent: 'art' }, { to: 'mark', say: 'review this', conversation: owner, key: keyOf(w, owner), session: w.sessionFor(owner) }, d);
    assert.match(q.text, new RegExp(`Replies return to ${owner}`));
    assert.equal(JSON.stringify(readRelays(w.env, w.clock.now().getTime())).includes(keyOf(w, owner)), false, 'the key is never kept');
    await relay(w.env, { agent: 'mark' }, { to: 'art', say: 'reviewed', reply_to: q.text.slice(0, 10) }, d);
    const turn = w.core.turns.at(-1);
    assert.equal(turn.conversation, owner);
    assert.deepEqual(turn.from, { kind: 'agent', id: 'mark' }, 'a peer, never the owner');
    assert.equal(loadConv(w.env, owner).queue.at(-1).owner, undefined);
  });

  test('a guest venue\'s own conversation is a fine return address for its own asks; a finished one is not', async () => {
    const { w } = relayWorld();
    const { owner, guest } = await twoAtWork(w);
    assert.equal(originOf(w.env, { agent: 'art' }, guest)?.conversation, guest);
    const c = JSON.parse(readFileSync(convFile(w, owner))); c.runLog.at(-1).end = Date.now(); writeFileSync(convFile(w, owner), JSON.stringify(c));
    asGuest(w, owner);
    assert.equal(originOf(w.env, { agent: 'art' }, owner), null, 'no body is at work there to have asked');
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
