// Agent-to-agent relay (loom docs/specs/agent-runtime.md, section 5, "Agent-to-agent relay"; test 6). The runtime's
// half of test 6 is here: an unpaired relay is refused unless it carries an allowed approval from the approvals piece,
// and with no approvals piece installed it's refused; a paired one delivers (on the runtime's `relay` venue, from the
// agent, starting the other agent's body through the runner interface: test 1's relay case). Core's half (the tool is
// in an agent's MCP session only when the runtime offers it) is in loom's suite (src/offered-tools.integration.test.ts).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliver, deliveryDir } from '../src/delivery.mjs';
import { GRANTS, KEY, setRelay } from '../src/grants.mjs';
import { approvalsInstalled, appendRelay, readRelays, relay, relayNotices, relayText, relayTool, relaysOf, TOOL } from '../src/relay.mjs';
import { runFor } from '../src/gates-api.mjs';
import { memStore } from '../src/store.mjs';
import { plain, world } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';

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
    assert.match(r.text, /^r-[0-9a-f]{8}: mark has it\.$/);
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
