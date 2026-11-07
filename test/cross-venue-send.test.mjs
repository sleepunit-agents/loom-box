// t-1920: a body started on one venue sends a DM on another, whose new adapter is still in shadow. Before: the
// adapter refused it for good, `loom runtime send` had already answered {accepted}, and the run's digest said the DM
// went (cv-67406263d047, "I DM'd Loren in Slack"). Now: send waits for what the venue said, and a DM the adapter
// refuses as shadow is handed to the old bridge's relay (LEGACY_SEND), which is what posts there meanwhile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, deliveryNotices, loadConv, sendOutcome, sendStatus } from '../src/delivery.mjs';
import { cvOf, world } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';

const SLACK_SHADOW = { ok: false, reason: 'loom-slack is in shadow mode: it posts nothing', permanent: true, shadow: true };

function setup() {
  const w = world();
  const S = scratch('rt-xvenue-');
  process.env.FAKE_SEND = S;
  const gates = { people: { jonathan: { name: 'Jonathan', tier: 3, slack: { T1: ['U3'] } }, loren: { name: 'Loren', tier: 2, slack: { T1: ['U9'] } } }, agents: {} };
  const fake = [process.execPath, join(import.meta.dirname, 'fake-send.mjs')];
  Object.assign(w.o, {
    gates: () => gates,
    venues: () => ({ discord: { kind: 'live', send: fake }, slack: { kind: 'live', send: fake } }),
    adapter: async (argv, c, args) => (args[0] === '--describe' ? { ok: true, venue: c.place.split(':')[1] } : { ok: true }),
  });
  const calls = () => (existsSync(join(S, 'calls.log')) ? readFileSync(join(S, 'calls.log'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const start = async (place, text) => {
    const a = await deliver(w.env, w.msg(place, text, { venue: 'discord', label: '#pond', from: { kind: 'person', slug: 'jonathan' } }), w.o);
    const c = loadConv(w.env, a.conversation);
    return { cv: a.conversation, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY };
  };
  const sendNow = async (cv, key, b) => { let p; const r = await w.send({ conversation: cv, key, ...b }, { ...w.o, onSend: (x) => { p = x; } }); return { ...r, post: p ? await p : null }; };
  return { w, S, calls, start, sendNow };
}

test('a DM to a venue whose adapter is in shadow: handed back for the old bridge, not refused for good, nobody told it failed for good', async () => {
  const { w, S, calls, start, sendNow } = setup();
  writeFileSync(join(S, 'refuse'), JSON.stringify(SLACK_SHADOW));
  const { cv, key } = await start('channel:100', 'DM Loren that the build is green');
  const r = await sendNow(cv, key, { text: 'The build is green.', person: 'loren', via: 'slack' });
  assert.equal(r.accepted, true);
  assert.equal(calls().length, 1, 'the adapter was asked once, never retried');
  assert.deepEqual(calls()[0].argv, ['--place', 'dm:U9', '--agent', 'art']);
  assert.deepEqual(r.post.legacy, { piece: 'shuttle', via: 'slack', from: 'discord:#pond' });
  // Its sender learns this, and only this: nothing says it posted.
  assert.deepEqual(sendStatus(w.env, { conversation: cv, ref: r.ref }, { caller: { kind: 'agent', agent: 'art' } }),
    { done: true, ok: false, reason: SLACK_SHADOW.reason, legacy: { piece: 'shuttle', via: 'slack', from: 'discord:#pond' } });
  const c = loadConv(w.env, cv);
  assert.equal(c.refused, undefined, 'not kept as refused for good');
  assert.equal(deliveryNotices(w.env, w.clock.now().getTime()).filter((x) => /refused a post for good/.test(x.text)).length, 0);
  assert.equal(w.log.some((l) => l[0] === 'feed' && /nothing will post there/.test(l[2])), false, 'the body isn\'t told "don\'t try again"');
  // Another agent asks after it: no.
  assert.match(sendStatus(w.env, { conversation: cv, ref: r.ref }, { caller: { kind: 'agent', agent: 'mark' } }).reason, /only art/);
  delete process.env.FAKE_SEND;
});

test('a shadow refusal in the conversation\'s own place, or with no old bridge for that venue, stays refused for good', async () => {
  const { w, S, start, sendNow } = setup();
  // Discord in shadow: no old bridge posts DMs there for the runtime (LEGACY_SEND has no discord).
  writeFileSync(join(S, 'refuse'), JSON.stringify({ ...SLACK_SHADOW, reason: 'loom-discord is in shadow mode: it posts nothing' }));
  const { cv, key } = await start('channel:200', 'hi');
  const own = await sendNow(cv, key, { text: 'hello' });
  assert.equal(own.post.legacy, undefined);
  assert.deepEqual(sendStatus(w.env, { conversation: cv, ref: own.ref }), { done: true, ok: false, reason: 'loom-discord is in shadow mode: it posts nothing', permanent: true });
  assert.ok(loadConv(w.env, cv).refused, 'refused for good, as before');
  delete process.env.FAKE_SEND;
});

test('a post that went: its sender hears posted, with the venue\'s id; one still going: not done', async () => {
  const { w, start, sendNow } = setup();
  const { cv, key } = await start('channel:300', 'hi');
  const r = await sendNow(cv, key, { text: 'hello' });
  const s = sendStatus(w.env, { conversation: cv, ref: r.ref });
  assert.equal(s.done, true);
  assert.equal(s.ok, true);
  assert.match(s.id, /^p-/);
  assert.deepEqual(sendStatus(w.env, { conversation: cv, ref: 'out-000000000000' }), { done: false });
  assert.equal(sendStatus(w.env, { conversation: cv, ref: 'nope' }).ok, false);
  delete process.env.FAKE_SEND;
});

// sendOutcome: what `loom runtime send` answers the body.
const fast = { sleep: async () => {} };
const seq = (...answers) => { let i = 0; return async () => answers[Math.min(i++, answers.length - 1)]; };

test('send answers posted only once the venue took it, and waits for that', async () => {
  const a = await sendOutcome({ ...fast, status: seq({ done: false }, { done: false }, { done: true, ok: true, id: 'C1:1.2' }) }, { conversation: 'cv-000000000001', ref: 'out-000000000001', text: 'x' });
  assert.deepEqual(a, { ok: true, posted: true, ref: 'out-000000000001', id: 'C1:1.2' });
  assert.equal(a.accepted, undefined, 'never "accepted" alone');
});

test('a refused post comes back as an error with why; one never confirmed is not reported as sent', async () => {
  const no = await sendOutcome({ ...fast, status: seq({ done: true, ok: false, reason: 'loom-discord is in shadow mode: it posts nothing', permanent: true }) }, { conversation: 'cv-000000000001', ref: 'out-000000000001', text: 'x' });
  assert.deepEqual(no, { ok: false, ref: 'out-000000000001', reason: 'loom-discord is in shadow mode: it posts nothing', permanent: true });
  const late = await sendOutcome({ ...fast, status: seq({ done: false }) }, { conversation: 'cv-000000000001', ref: 'out-000000000001', text: 'x' }, { waitMs: 0 });
  assert.equal(late.ok, false);
  assert.equal(late.unconfirmed, true);
  assert.match(late.reason, /don't say it went/);
  const err = await sendOutcome({ ...fast, status: async () => { throw new Error('loom down'); } }, { conversation: 'cv-000000000001', ref: 'out-000000000001', text: 'x' });
  assert.deepEqual([err.ok, /loom down/.test(err.reason)], [false, true]);
});

test('a DM handed back for the old bridge: relayed as the agent, through that piece; said as on its way, not sent', async () => {
  const legacy = { piece: 'shuttle', via: 'slack', from: 'discord:#pond' };
  const relays = [];
  const relay = async (piece, argv) => { relays.push({ piece, argv }); return { exit: 0, stdout: 'r-1a2b3c4d: queued for Loren on slack; the body in that conversation takes it from here\n', stderr: '' }; };
  const a = await sendOutcome({ ...fast, relay, status: seq({ done: true, ok: false, reason: 'shadow', legacy }) }, { conversation: 'cv-000000000001', ref: 'out-000000000001', text: 'The build is green.', person: 'loren', via: 'slack' });
  assert.deepEqual(relays, [{ piece: 'shuttle', argv: ['relay', '--via', 'slack', '--person', 'loren', '--say', 'The build is green.', '--why', 'a message for them from another conversation of mine', '--from', 'discord:#pond'] }]);
  assert.deepEqual([a.ok, a.posted, a.relay], [true, false, 'r-1a2b3c4d']);
  assert.match(a.note, /not that it was sent/);
  // The old bridge's relay says no: an error, with its words.
  const no = await sendOutcome({ ...fast, relay: async () => ({ exit: 1, stdout: '', stderr: 'relay: the same words already went to Loren on slack within the hour\n' }), status: seq({ done: true, ok: false, reason: 'shadow', legacy }) }, { conversation: 'cv-000000000001', ref: 'out-000000000001', text: 'x', person: 'loren', via: 'slack' });
  assert.equal(no.ok, false);
  assert.match(no.reason, /relay refused it: the same words already went/);
  assert.match(no.reason, /Nothing posted/);
  // A piece API that refuses the caller (403): an error too.
  const forbidden = await sendOutcome({ ...fast, relay: async () => ({ ok: false, error: "these bridges are art's; another agent relays through its own" }), status: seq({ done: true, ok: false, reason: 'shadow', legacy }) }, { conversation: 'cv-000000000001', ref: 'out-000000000001', text: 'x', person: 'loren', via: 'slack' });
  assert.deepEqual([forbidden.ok, /another agent relays/.test(forbidden.reason)], [false, true]);
  // On loom's machine (no piece API) there's no relay: said plainly.
  const local = await sendOutcome({ ...fast, relay: null, status: seq({ done: true, ok: false, reason: 'shadow', legacy }) }, { conversation: 'cv-000000000001', ref: 'out-000000000001', text: 'x', person: 'loren', via: 'slack' });
  assert.equal(local.ok, false);
  assert.match(local.reason, /nothing posted/);
});
