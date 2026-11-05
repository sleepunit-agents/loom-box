// A conversation's next message, after its house body's turn ended (t-1881, Jonathan's first Comms thread,
// 2026-11-05): its body is resumed in its house from its slot, and that is the conversation's one body. Claude Code
// resumes a session under the same job id it had (`claude --bg --resume <session>` gives back the session's own id),
// so a house reports the resumed body under the id its first body had. That id must be taken as the resume it is:
// never refused as "a second request" while the resumed body runs on in the house unknown to the runtime, with a
// fresh body started beside it for the same messages (two bodies, two replies, one conversation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, loadConv } from '../src/delivery.mjs';
import { hostOf } from '../src/houserunner.mjs';
import { load } from '../src/state.mjs';
import { readBody } from '../src/bodies.mjs';
import { cvOf, fakeCore, hasAge, houseWorld, until } from './delivery-world.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** The house's runner, resuming as Claude Code does: a session's body comes back under the session's own id. */
function claudeLikeResume(w) {
  const resumed = [];
  w.local.resume = async (slot, o) => {
    const id = String(slot.session).replace(/^s-/, '');
    resumed.push(id);
    w.local.briefs[id] = o.brief;
    w.local.envs[id] = o.env;
    // Its state is the job's again: working (its old turn's state is gone with the stop).
    w.local.status = ((prev) => (b) => (b.id === id && !w.local.endedAgain?.has(id) ? (w.local.after?.[id] ?? 'working') : prev(b)))(w.local.status);
    return { id, harness: 'claude' };
  };
  return resumed;
}

function opts(w) {
  const log = [];
  const core = fakeCore(log);
  return {
    log, core,
    o: {
      core, runner: () => w.hr, sealer: w.sealer, now: () => new Date(), warn: () => {}, accounts: w.accounts,
      venues: () => ({ loom: { kind: 'live', piece: 'loom', adapter: 'core' } }),
      policy: () => null, gates: () => ({ people: {} }), card: () => null, adapter: async () => ({ ok: true }),
    },
  };
}

const msg = (n, text) => ({ source: 'loom', id: `comms:th:aaaaaaaaaa:m${n}`, agent: 'art', venue: 'loom', place: 'th:aaaaaaaaaa', label: 'Testing Comms from loom',
  from: { kind: 'person', slug: 'jonathan' }, kind: 'message', at: new Date().toISOString(), text });

test('a follow-up after its house body\'s turn ended resumes that body, once: one body for the conversation, never a second beside it', { skip: !hasAge && 'age isn\'t installed' }, async () => {
  const w = houseWorld({ claimMs: 8000, warmMs: 8000 });
  const resumed = claudeLikeResume(w);
  const { o } = opts(w);
  const cv = cvOf('art', 'loom', 'th:aaaaaaaaaa');
  const first = deliver(w.env, msg(1, 'first'), o);
  await until(() => load(w.env).houses['h-1']);
  const host = w.host();
  try {
    await first;
    await until(() => loadConv(w.env, cv)?.body, 8000);
    const body1 = loadConv(w.env, cv).body;
    assert.equal(body1, 'claude:h-1-b0000000');
    // Its turn ends (a reply posted): idle, warm, in its house.
    const st = w.local.status;
    w.local.status = (b) => (b.id === 'b0000000' ? 'idle' : st(b));
    await until(() => hostOf(w.env, 'art').report?.bodies?.b0000000?.status === 'idle', 5000);
    // The owner's second message, then a third while its body is still coming back.
    const second = deliver(w.env, msg(2, 'second'), o);
    await until(() => loadConv(w.env, cv)?.starting || resumed.length, 5000);
    const third = deliver(w.env, msg(3, 'third'), o);
    await Promise.all([second, third]);
    await until(() => { const c = loadConv(w.env, cv); return !c.starting && !c.queue?.length && c.outcomes && Object.keys(c.outcomes).length >= 3 && Object.values(c.outcomes).every((x) => x.body !== 'queued'); }, 15_000);
    const c = loadConv(w.env, cv);
    // One body came back for both, the conversation's own: its session resumed, and no fresh start beside it.
    assert.deepEqual(resumed, ['b0000000'], 'its session was resumed once');
    assert.deepEqual(w.local.briefs.b0000001, undefined, 'no second body was started for the conversation');
    assert.equal(c.body, 'claude:h-1-b0000000', 'the resumed body is the conversation\'s');
    assert.equal(readBody(w.env, c.body).ended, undefined, 'and it is live, not the ended record of its first run');
    const outs = Object.values(c.outcomes).map((x) => x.body);
    assert.deepEqual(outs.sort(), ['resumed', 'resumed', 'started']);
    assert.ok(/second/.test(w.local.briefs.b0000000) && /third/.test(w.local.briefs.b0000000), 'both messages reached it');
    // Its house runs exactly the one body the runtime knows of.
    const live = Object.entries(hostOf(w.env, 'art').report.bodies).filter(([, b]) => b.status !== 'ended').map(([id]) => id);
    assert.deepEqual(live, ['b0000000']);
  } finally {
    await w.kill();
    await host;
  }
});
