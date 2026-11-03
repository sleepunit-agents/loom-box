// t-1760: a post that fails after its body's turn is over never starts a body of its own. Before the fix, its note was
// a message on the conversation's queue, so the tick resumed a body for it; that body posted, failed, and queued
// another note: a body per round, for as long as the venue refused (a venue in shadow mode refuses every post).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, deliveryNotices, loadConv, tick } from '../src/delivery.mjs';
import { cvOf, plain, testSealer, world } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';

const SHADOW = { ok: false, reason: 'loom-discord is in shadow mode: it posts nothing', permanent: true };

/** A world whose venue's send is fake-send.mjs, in its own dir; `post` sends as the conversation's body and waits for the post. */
function setup(extra) {
  const w = world(extra);
  const S = scratch('rt-postloop-');
  process.env.FAKE_SEND = S;
  const calls = () => (existsSync(join(S, 'calls.log')) ? readFileSync(join(S, 'calls.log'), 'utf-8').trim().split('\n').length : 0);
  const keyOf = (cv) => { const c = loadConv(w.env, cv); return w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY; };
  const post = async (cv, text) => { let p; const r = await w.send({ conversation: cv, text, key: keyOf(cv) }, { ...w.o, onSend: (x) => { p = x; } }); return { ...r, post: await p }; };
  const bodies = () => w.log.filter((l) => l[0] === 'start' || l[0] === 'resume');
  // Ticks over a few hours of the runtime's clock: whatever would start a body has its chance.
  const ticks = async (n = 8) => { for (let i = 0; i < n; i++) { w.clock.advance(20 * 60_000); await tick(w.env, w.o); } };
  return { w, S, calls, post, bodies, ticks };
}

test('a venue that refuses for good (shadow mode): not retried, no note queued, no new body; the owner told once a day', async () => {
  const { w, S, calls, post, bodies, ticks } = setup();
  writeFileSync(join(S, 'refuse'), JSON.stringify(SHADOW));
  assert.equal((await deliver(w.env, w.msg('dm:SH', 'hi'), w.o)).body, 'started');
  const cv = cvOf('art', 'slack', 'dm:SH');
  // Its turn is over, then its post is refused: the case that looped.
  w.runner.finish(loadConv(w.env, cv).body);
  const r = await post(cv, 'hello');
  assert.deepEqual([r.accepted, r.post.ok, r.post.permanent], [true, false, true]);
  assert.equal(calls(), 1, 'refused for good: never tried again');
  assert.equal(w.core.turns.at(-1).outcome, 'failed', 'its reply turn says failed');
  let c = loadConv(w.env, cv);
  assert.deepEqual([c.queue.length, c.postFail], [0, undefined], 'nothing queued for a body');
  assert.equal(c.refused.reason, SHADOW.reason);
  await ticks();
  assert.equal(bodies().length, 1, 'exactly one body: nothing followed the refusal');
  // Refused again the same day: counted, the owner not told twice.
  w.clock.advance(-8 * 20 * 60_000);
  const n = (t) => deliveryNotices(w.env, w.clock.now().getTime()).filter((x) => x.text.includes('refused a post for good') && x.meta.includes(cv)).length;
  assert.equal(n(), 1, 'one notice');
  assert.match(deliveryNotices(w.env, w.clock.now().getTime())[0].text, /shadow mode/);
  // A body mid-turn hears of it (fed, not queued), and nothing starts.
  await deliver(w.env, w.msg('dm:SH', 'again'), w.o);
  await post(cv, 'hello again');
  assert.ok(w.log.some((l) => l[0] === 'feed' && /nothing will post there/.test(l[2])), 'the body at work was told');
  c = loadConv(w.env, cv);
  assert.deepEqual([c.refused.count, c.queue.length, c.postFail], [2, 0, undefined]);
  assert.equal(n(), 1, 'still one notice that day');
  const had = bodies().length;
  w.runner.finish(c.body);
  await ticks();
  assert.equal(bodies().length, had, 'no body after it');
  delete process.env.FAKE_SEND;
});

test('a transient failure after the turn: no body for the note; one pending note (counted, the latest reason) rides with the next real message', async () => {
  const { w, S, post, bodies, ticks } = setup();
  assert.equal((await deliver(w.env, w.msg('dm:TR', 'hi'), w.o)).body, 'started');
  const cv = cvOf('art', 'slack', 'dm:TR');
  w.runner.finish(loadConv(w.env, cv).body);
  // Every post refused, not for good: each tried twice, and each failure is told.
  writeFileSync(join(S, 'fail'), '100');
  const a = await post(cv, 'one');
  const b = await post(cv, 'two');
  assert.equal(b.post.ok, false);
  let c = loadConv(w.env, cv);
  assert.equal(c.queue.length, 0, 'the note isn\'t on the queue: it\'s no delivery');
  assert.equal(c.postFail.count, 2, 'one note, counted');
  await ticks();
  assert.equal(bodies().length, 1, 'no body started for the note');
  // The next real message takes it along: one body, its brief has both.
  writeFileSync(join(S, 'fail'), '0');
  const before = bodies().length;
  await deliver(w.env, w.msg('dm:TR', 'are you there?'), w.o);
  assert.equal(bodies().length, before + 1, 'one body, for the real message');
  const brief = plain(bodies().at(-1).at(-1));
  assert.ok(brief.includes(`(couldn't post 2 of your messages in slack; the latest, ${b.ref}: the bot has no access to that channel)`), brief);
  assert.ok(!brief.includes(a.ref), 'only the latest is named');
  assert.ok(brief.includes('loren: are you there?'), brief);
  c = loadConv(w.env, cv);
  assert.deepEqual([c.postFail, c.queue.length], [undefined, 0], 'taken along, gone');
  assert.ok(!w.adapterCalls.some((x) => x.args.some((y) => /^note-/.test(y))), 'the adapter is never told of a note as a message');
  delete process.env.FAKE_SEND;
});

test('a post that fails while its body is still mid-turn is fed to it, and nothing waits', async () => {
  const { w, S, post, bodies, ticks } = setup();
  await deliver(w.env, w.msg('dm:LV', 'hi'), w.o);
  const cv = cvOf('art', 'slack', 'dm:LV');
  writeFileSync(join(S, 'fail'), '2');
  const r = await post(cv, 'x');
  assert.ok(w.log.some((l) => l[0] === 'feed' && l[2] === `(couldn't post your message ${r.ref} in slack: the bot has no access to that channel)`));
  assert.equal(loadConv(w.env, cv).postFail, undefined);
  w.runner.finish(loadConv(w.env, cv).body);
  await ticks();
  assert.equal(bodies().length, 1);
  delete process.env.FAKE_SEND;
});

test('a note an older runtime left on a queue (note-…, no mark) starts no body either, and rides with the next message', async () => {
  const { w, bodies, ticks } = setup();
  await deliver(w.env, w.msg('dm:OLD', 'hi'), w.o);
  const cv = cvOf('art', 'slack', 'dm:OLD');
  w.runner.finish(loadConv(w.env, cv).body);
  const c = loadConv(w.env, cv);
  const text = '(couldn\'t post your message out-aaaaaaaaaaaa in slack: no)';
  c.queue = [{ key: 'note-0123456789ab', id: 'note-0123456789ab', at: w.clock.now().toISOString(), from: { kind: 'unknown' }, kind: 'message', sealed: testSealer.seal(Buffer.from(text)).toString('base64') }];
  writeFileSync(join(w.env.LOOM_BOX_DATA, 'delivery', 'conversations', `${cv}.json`), JSON.stringify(c));
  await ticks();
  assert.equal(bodies().length, 1, 'no body for it');
  assert.equal(loadConv(w.env, cv).postFail.id, 'note-0123456789ab');
  await deliver(w.env, w.msg('dm:OLD', 'and now?'), w.o);
  assert.equal(bodies().length, 2);
  assert.ok(bodies().at(-1).at(-1).includes(text));
  delete process.env.FAKE_SEND;
});
