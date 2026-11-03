// The review job (loom docs/specs/agent-runtime.md, section 7 and "Order" step 6; conversations.md, "Review"):
//   - it runs once a day at 04:00 in the household's time zone, from the runtime's own tick;
//   - graders are bare models of the families allowed to grade each entry, with room on a logged-in box;
//   - a run takes entries, posts scores and at most one finding per entry, and marks them done, so the 7-day sweep
//     finds nothing older on a normal day; with no family that has room, nothing is taken and the record says so;
//   - each agent's introspection is a wake delivered to that agent's own body.
// The resolver's use of scorecards (test 4) is pinned in models.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../src/core.mjs';
import { parseDelivery } from '../src/delivery.mjs';
import { GraderError, MAX_FINDING, cleanFinding, grade, graderInput, graderRunArgs, verdictOf } from '../src/grader.mjs';
import { dueDay, graderPool, introspectionMessage, localTime, pickGraders, producersOf, resetTick, reviewDir, reviewRuns, reviewTick, runReview } from '../src/review.mjs';
import { scratch } from './scratch.mjs';

const envOf = () => { const HOME = scratch('loom-review-'); return { HOME, LOOM_BOX_DATA: join(HOME, 'data'), LOOM_BOX_HOME: join(HOME, 'state'), LOOM_RUNTIME_PIECE: 'runtime' }; };

// ─── When ───────────────────────────────────────────────────────────────────

test('the review is due at 04:00 in the household\'s time zone, once a day', () => {
  assert.deepEqual(localTime(new Date('2026-11-03T09:30:00Z'), 'America/Chicago'), { day: '2026-11-03', hour: 3 });
  assert.equal(dueDay(new Date('2026-11-03T09:30:00Z'), 'America/Chicago', '2026-11-02'), null, '03:30 in Chicago: not yet');
  assert.equal(dueDay(new Date('2026-11-03T10:01:00Z'), 'America/Chicago', '2026-11-02'), '2026-11-03');
  assert.equal(dueDay(new Date('2026-11-03T23:00:00Z'), 'America/Chicago', '2026-11-03'), null, 'that day had its run');
  assert.equal(dueDay(new Date('2026-11-03T04:00:00Z'), 'UTC', null), '2026-11-03');
});

test('the tick: a first sight arms it for the next 04:00, then it starts each day\'s run once; off runs nothing', async () => {
  const env = envOf();
  const started = [];
  let config = { review: 'on', tz: 'Europe/Berlin' };
  const core = { reviewConfig: async () => config };
  const tick = (iso) => reviewTick(env, { now: new Date(iso), core, spawnRun: (d) => started.push(d), nowMs: Date.parse(iso) });
  resetTick();
  // Installed at 10:00 Berlin: no run on the spot.
  assert.deepEqual(await tick('2026-11-03T09:00:00Z'), { armed: '2026-11-03' });
  assert.equal(await tick('2026-11-03T20:00:00Z'), null);
  // 03:59 the next day, then 04:00 (03:00Z is 04:00 in Berlin in November).
  assert.equal(await tick('2026-11-04T02:59:00Z'), null);
  assert.deepEqual(await tick('2026-11-04T03:00:00Z'), { started: '2026-11-04' });
  assert.equal(await tick('2026-11-04T03:00:05Z'), null, 'once');
  assert.equal(await tick('2026-11-04T22:00:00Z'), null);
  // A service down at 04:00 catches up when it's back that day.
  assert.deepEqual(await tick('2026-11-05T14:00:00Z'), { started: '2026-11-05' });
  assert.deepEqual(started, ['2026-11-04', '2026-11-05']);
  // Off: nothing (the settings are read again after 10 minutes).
  config = { review: 'off', tz: 'Europe/Berlin' };
  resetTick();
  assert.deepEqual(await tick('2026-11-06T05:00:00Z'), { off: true });
  assert.deepEqual(started, ['2026-11-04', '2026-11-05']);
});

// ─── Who grades ─────────────────────────────────────────────────────────────

const G = (model, family, harness = family === 'anthropic' ? 'claude' : 'codex') => ({ model, family, harness, image: 'img' });

test('graders: two other families where the household has them, one where it has one, never the producer\'s', () => {
  const pool = [G('claude-opus-5', 'anthropic'), G('gpt-5', 'openai'), G('gemini-3', 'google', 'claude')];
  const fams = { families: ['anthropic', 'openai', 'google'] };
  assert.deepEqual(pickGraders({ family: 'anthropic' }, pool, fams).map((g) => g.family), ['openai', 'google']);
  assert.deepEqual(pickGraders({ family: 'openai' }, pool, { families: ['anthropic', 'openai'] }).map((g) => [g.family, g.sameFamily]), [['anthropic', false]]);
  // The other family has no room: no grader, and never the producer's own instead.
  assert.deepEqual(pickGraders({ family: 'anthropic' }, [G('claude-opus-5', 'anthropic')], { families: ['anthropic', 'openai'] }), { skip: 'no-room' });
  // Someone else's words (no family) are never scored.
  assert.deepEqual(pickGraders({ family: null }, pool, fams), { skip: 'unscorable' });
});

test('graders: a household of one family falls back to a different model of it, the one that produced the least', () => {
  const pool = [G('claude-opus-5-5', 'anthropic'), G('claude-opus-5', 'anthropic'), G('claude-sonnet-5', 'anthropic')];
  const producers = producersOf([
    { day: '2026-11-02', model: 'claude-opus-5-5', family: 'anthropic', measure: 'done_rate', n: 9 },
    { day: '2026-11-02', model: 'claude-opus-5', family: 'anthropic', measure: 'graded', n: 2 },
  ]);
  const [g, ...more] = pickGraders({ family: 'anthropic' }, pool, { families: ['anthropic'], producers });
  assert.equal(more.length, 0, 'one family: one score');
  assert.equal(g.model, 'claude-sonnet-5');
  assert.equal(g.sameFamily, true);
});

test('graders: a conversation with someone other than the owner is graded only by families that already processed it', () => {
  const pool = [G('claude-opus-5', 'anthropic'), G('gpt-5', 'openai')];
  const picked = pickGraders({ family: 'anthropic', only_families: ['anthropic'] }, pool, { families: ['anthropic', 'openai'] });
  assert.deepEqual(picked.map((g) => [g.family, g.sameFamily]), [['anthropic', true]]);
  assert.deepEqual(pickGraders({ family: 'anthropic', only_families: [] }, pool, { families: ['anthropic', 'openai'] }), { skip: 'no-room' });
});

test('the grader pool: models whose harness is logged in on loom\'s own box, a household owner\'s, with room', () => {
  const nowMs = Date.parse('2026-11-03T06:00:00Z');
  const box = (usage) => ({ local: true, owner: 'jo', harnesses: { claude: { loggedIn: true, account: 'acct' }, codex: { loggedIn: false } }, usage: { claude: { box: { windows: usage, checked: nowMs / 1000 } } } });
  const s = (b) => ({ v: 1, boxes: { loom: b }, agents: { art: { repo: 'x' } } });
  const models = [
    { id: 'claude-opus-5', harness: 'claude', family: 'anthropic', window: '7d_opus' },
    { id: 'claude-sonnet-5', harness: 'claude', family: 'anthropic', window: '7d_sonnet' },
    { id: 'gpt-5', harness: 'codex', family: 'openai' },
  ];
  const opts = { members: [{ person: 'jo', agents: '*' }, { person: 'kim', agents: ['pond'] }], models, nowMs, image: () => ({ image: 'loom-house-art:x' }), cred: () => null };
  const { pool, why } = graderPool({}, { ...opts, s: s(box({ '7d': 0.2, '7d_opus': 0.99 })) });
  assert.deepEqual(pool.map((g) => g.model), ['claude-sonnet-5'], 'opus\'s window is full, codex isn\'t logged in');
  assert.match(why.join('\n'), /claude-opus-5: .* no room/);
  assert.match(why.join('\n'), /gpt-5: loom isn't logged in to codex/);
  // A member's box (not a household owner's) doesn't grade household-wide.
  assert.deepEqual(graderPool({}, { ...opts, s: s({ ...box({}), owner: 'kim' }) }).pool, []);
});

// ─── The run ────────────────────────────────────────────────────────────────

/**
 * A fake core, keeping core's rules for a review run (loom src/review.ts, src/audit-take.ts): entries oldest first,
 * never handed out twice; scores only on entries with a family, only from household families, never the producer's
 * own while the household has another, two per ref and one per family; one finding per conversation per day.
 */
function fakeCore({ entries, families = ['anthropic'], config = { review: 'on', tz: 'UTC' } }) {
  const st = { entries: entries.map((e) => ({ ...e })), tokens: 0, scores: [], findings: [], findingDays: new Set(), takes: 0 };
  const err = (m, s) => { throw new CoreError(m, s); };
  const core = {
    reviewConfig: async () => config,
    reviewToken: async () => ({ token: `review-token-${++st.tokens}`, expires: null }),
    venues: async () => ({}),
  };
  const reviewer = (token) => ({
    async take(limit) {
      assert.match(token, /^review-token-/);
      st.takes += 1;
      return st.entries.filter((e) => !e.taken).slice(0, limit).map((e) => { e.taken = true; const { cv: _c, day: _d, taken: _t, done: _x, ...out } = e; return out; });
    },
    async score(ref, fam, score) {
      const e = st.entries.find((x) => x.ref === ref);
      if (!e?.family) err('not the agent\'s turn', 409);
      if (!families.includes(fam)) err(`no household agent runs a ${fam} model`, 403);
      if (e.only_families && !e.only_families.includes(fam)) err('not a family that processed it', 403);
      if (!e.only_families && fam === e.family && families.some((f) => f !== fam)) err('producer\'s family', 403);
      const mine = st.scores.filter((x) => x.ref === ref);
      if (mine.length >= 2 || mine.some((x) => x.fam === fam)) err('already scored', 409);
      st.scores.push({ ref, fam, score });
      return { ok: true };
    },
    async finding(ref, text) {
      const e = st.entries.find((x) => x.ref === ref);
      assert.ok(text.length <= MAX_FINDING && !text.includes('\n'));
      const k = `${e.cv}|${e.day}`;
      if (st.findingDays.has(k)) err('one finding per conversation per day', 409);
      st.findingDays.add(k);
      st.findings.push({ ref, text });
      return {};
    },
    async done(refs) { for (const r of refs) st.entries.find((x) => x.ref === r).done = true; return {}; },
  });
  return { st, core, reviewer };
}

const entry = (n, o = {}) => ({ ref: `r${n}`, agent: 'A1', venue: 'wake', kind: 'reply', family: 'anthropic', text: `sample ${n}`, cv: `cv${n}`, day: '2026-11-02', ...o });
const anthropicOnly = [{ id: 'claude-opus-5-5', harness: 'claude', family: 'anthropic' }, { id: 'claude-sonnet-5', harness: 'claude', family: 'anthropic' }];

test('a run takes entries, posts scores and at most one finding per entry, and marks what it processed done', async () => {
  const env = envOf();
  const { st, core, reviewer } = fakeCore({ entries: [
    entry(1), entry(2, { kind: 'wake', family: null }), entry(3, { cv: 'cv1' }), entry(4, { venue: 'discord', only_families: ['anthropic'] }), entry(5),
  ] });
  const graded = [];
  const r = await runReview(env, {
    core, reviewer, models: anthropicOnly, limit: 4, introspect: 'none', state: { agents: {} }, scorecards: async () => [{ model: 'claude-opus-5-5', family: 'anthropic', n: 3 }],
    pool: () => ({ pool: [G('claude-opus-5-5', 'anthropic'), G('claude-sonnet-5', 'anthropic')], why: [] }),
    grade: async (g, { venueKind, entry: e }) => { graded.push([g.model, venueKind, e.ref]); return { score: 4, finding: `finding on ${e.ref}` }; },
  });
  // Up to N: four taken; the fifth waits for tomorrow.
  assert.equal(r.taken, 4);
  assert.equal(st.entries[4].taken, undefined);
  // A different model of the one family, on each venue's kind.
  assert.deepEqual(graded, [['claude-sonnet-5', 'scheduled', 'r1'], ['claude-sonnet-5', 'scheduled', 'r3'], ['claude-sonnet-5', 'live', 'r4']]);
  assert.deepEqual(st.scores.map((x) => [x.ref, x.fam, x.score]), [['r1', 'anthropic', 4], ['r3', 'anthropic', 4], ['r4', 'anthropic', 4]]);
  // r3 is r1's conversation, the same day: core keeps the first finding and refuses the second.
  assert.deepEqual(st.findings.map((f) => f.ref), ['r1', 'r4']);
  assert.equal(r.findings_refused, 1);
  assert.deepEqual(st.entries.slice(0, 4).map((e) => e.done), [true, true, true, true]);
  assert.deepEqual({ graded: r.graded, unscorable: r.unscorable, done: r.done, scores: r.scores, graders: r.graders, same_family: r.same_family }, { graded: 3, unscorable: 1, done: 4, scores: 3, graders: { anthropic: 3 }, same_family: 3 });
  // The record keeps counts and families, never a sample, a finding's text or a token.
  const kept = readFileSync(join(reviewDir(env), 'runs.jsonl'), 'utf-8');
  assert.doesNotMatch(kept, /sample \d|finding on|review-token/);
  assert.equal(reviewRuns(env).length, 1);
});

test('two families: each sample is graded cross-family; a family core refuses falls back, and isn\'t asked again', async () => {
  const env = envOf();
  // The runtime's list has an openai model, but no household turn ever ran one: core refuses openai's scores.
  const { st, core, reviewer } = fakeCore({ entries: [entry(1), entry(2), entry(3, { family: 'openai' })], families: ['anthropic'] });
  const asked = [];
  const r = await runReview(env, {
    core, reviewer, introspect: 'none', state: { agents: {} }, scorecards: async () => [],
    models: [...anthropicOnly, { id: 'gpt-5', harness: 'codex', family: 'openai' }],
    pool: () => ({ pool: [G('claude-sonnet-5', 'anthropic'), G('gpt-5', 'openai')], why: [] }),
    grade: async (g, { entry: e }) => { asked.push([e.ref, g.family]); return { score: 3 }; },
  });
  assert.deepEqual(asked, [['r1', 'openai'], ['r1', 'anthropic'], ['r2', 'anthropic'], ['r3', 'anthropic']]);
  assert.deepEqual(st.scores.map((x) => [x.ref, x.fam]), [['r1', 'anthropic'], ['r2', 'anthropic'], ['r3', 'anthropic']]);
  assert.equal(r.done, 3);
});

test('no allowed family has room: nothing is taken, and the record says nothing was graded and why', async () => {
  const env = envOf();
  const { st, core, reviewer } = fakeCore({ entries: [entry(1)] });
  const r = await runReview(env, { core, reviewer, introspect: 'none', state: { agents: {} }, models: anthropicOnly, pool: () => ({ pool: [], why: ['claude-sonnet-5: Claude Max (jo\'s) has no room'] }), grade: async () => assert.fail('no grader runs') });
  assert.equal(st.takes, 0);
  assert.equal(st.tokens, 0, 'no review token minted for nothing');
  assert.equal(r.taken, 0);
  assert.match(r.nothing_graded, /no allowed family has room: claude-sonnet-5: .* no room/);
  assert.match(reviewRuns(env)[0].nothing_graded, /no allowed family has room/);
});

test('a grader that fails leaves its entry for the sweep; one that keeps failing isn\'t asked again in the run', async () => {
  const env = envOf();
  const { st, core, reviewer } = fakeCore({ entries: [entry(1), entry(2), entry(3), entry(4)] });
  let calls = 0;
  const r = await runReview(env, {
    core, reviewer, models: anthropicOnly, introspect: 'none', state: { agents: {} }, scorecards: async () => [],
    pool: () => ({ pool: [G('claude-sonnet-5', 'anthropic')], why: [] }),
    grade: async () => { calls += 1; throw new GraderError('the grader took longer than 180s'); },
  });
  assert.equal(calls, 3, 'three failures, then the model is out of the run');
  assert.deepEqual({ failed: r.failed, ungraded: r.ungraded, done: r.done }, { failed: 3, ungraded: 1, done: 1 });
  assert.deepEqual(st.entries.map((e) => !!e.done), [false, false, false, true]);
  assert.match(r.why.join('\n'), /anthropic grader: the grader took longer than 180s/);
  // And with every grader out, no more is claimed: a second batch's entries stay untaken.
  const big = fakeCore({ entries: Array.from({ length: 40 }, (_, i) => entry(i)) });
  const r2 = await runReview(env, { ...big, models: anthropicOnly, introspect: 'none', state: { agents: {} }, scorecards: async () => [], pool: () => ({ pool: [G('claude-sonnet-5', 'anthropic')], why: [] }), grade: async () => { throw new GraderError('x'); } });
  assert.equal(r2.taken, 25);
  assert.match(r2.why.join('\n'), /stopped: every grader kept failing/);
});

test('step 6\'s done: daily runs leave nothing older than a day for the 7-day sweep on a normal day', async () => {
  const env = envOf();
  const day = (d, n) => Array.from({ length: n }, (_, i) => entry(`${d}-${i}`, { day: `2026-11-0${d}`, family: i % 3 ? 'anthropic' : null, cv: `cv${d}-${i % 4}` }));
  const all = [...day(1, 30), ...day(2, 45), ...day(3, 20)];
  const { st, core, reviewer } = fakeCore({ entries: [] });
  for (const d of [1, 2, 3]) {
    // The day's entries arrive, then 04:00 the next day's run.
    st.entries.push(...all.filter((e) => e.day === `2026-11-0${d}`));
    await runReview(env, { core, reviewer, models: anthropicOnly, introspect: 'none', state: { agents: {} }, scorecards: async () => [], day: `2026-11-0${d + 1}`, pool: () => ({ pool: [G('claude-sonnet-5', 'anthropic')], why: [] }), grade: async () => ({ score: 5 }) });
    const left = st.entries.filter((e) => !e.done);
    assert.deepEqual(left, [], `after the ${d + 1}th's run, nothing waits for the sweep`);
  }
  assert.equal(st.scores.length, all.filter((e) => e.family).length);
  assert.ok(reviewRuns(env).every((r) => r.done === r.taken));
});

test('review "off" runs nothing; a command in its place gets the run\'s token on stdin, and the job doesn\'t run', async () => {
  const env = envOf();
  const off = fakeCore({ entries: [entry(1)], config: { review: 'off', tz: 'UTC' } });
  const r1 = await runReview(env, { ...off, models: anthropicOnly, introspect: 'all', state: { agents: { art: { repo: 'x' } } }, pool: () => assert.fail(), deliver: () => assert.fail('no introspection when off') });
  assert.equal(r1.off, true);
  assert.equal(off.st.takes, 0);
  const cmd = fakeCore({ entries: [entry(1)], config: { review: ['my-review', '--all'], tz: 'UTC' } });
  let ran;
  const r2 = await runReview(env, { ...cmd, models: anthropicOnly, state: { agents: {} }, pool: () => assert.fail(), runCommand: async (argv, token) => { ran = [argv, token]; return { exit: 0 }; } });
  assert.deepEqual(ran, [['my-review', '--all'], 'review-token-1']);
  assert.equal(r2.replaced, true);
  assert.doesNotMatch(readFileSync(join(reviewDir(env), 'runs.jsonl'), 'utf-8'), /review-token/);
});

test('a second run while one is going is refused', async () => {
  const env = envOf();
  const { core, reviewer } = fakeCore({ entries: [entry(1)] });
  let release;
  const slow = new Promise((r) => { release = r; });
  const first = runReview(env, { core, reviewer, models: anthropicOnly, introspect: 'none', state: { agents: {} }, scorecards: async () => [], pool: () => ({ pool: [G('claude-sonnet-5', 'anthropic')], why: [] }), grade: async () => { await slow; return { score: 2 }; } });
  // The lock is this process's: a second run here is refused only when another process holds it, so fake one.
  const { writeFileSync } = await import('node:fs');
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(reviewDir(env), 'run.lock'), JSON.stringify({ pid: process.ppid }));
  await assert.rejects(runReview(env, { core, reviewer, models: anthropicOnly, introspect: 'none', state: { agents: {} } }), /a review is already running/);
  writeFileSync(join(reviewDir(env), 'run.lock'), JSON.stringify({ pid: process.pid }));
  release();
  assert.equal((await first).graded, 1);
});

// ─── Introspection ──────────────────────────────────────────────────────────

test('introspection: each hosted agent gets a wake to its own body, through delivery; the record keeps only that it was delivered', async () => {
  const env = envOf();
  const { core, reviewer } = fakeCore({ entries: [] });
  const sent = [];
  const r = await runReview(env, {
    core, reviewer, models: anthropicOnly, scorecards: async () => [], state: { agents: { art: { repo: 'a' }, mark: { repo: 'm' }, ghost: {} } },
    now: () => new Date('2026-11-03T04:00:00Z'),
    pool: () => ({ pool: [G('claude-sonnet-5', 'anthropic')], why: [] }), grade: async () => ({ score: 3 }),
    deliver: async (m) => { sent.push(m); return { conversation: 'cv-000000000000', seq: 1, body: 'started' }; },
  });
  assert.deepEqual(sent.map((m) => m.agent), ['art', 'mark'], 'every agent the runtime hosts, and only those');
  for (const m of sent) {
    // A wake from the schedule, on core's wake venue, as the runtime: what the clock's wakes are, so it starts the
    // agent's own body in its own house.
    assert.deepEqual({ source: m.source, venue: m.venue, place: m.place, kind: m.kind, from: m.from, id: m.id }, { source: 'runtime', venue: 'wake', place: 'review', kind: 'wake', from: { kind: 'schedule' }, id: `review-2026-11-03-${m.agent}` });
    assert.doesNotThrow(() => parseDelivery(m));
    assert.match(m.text, /conversation_findings\(\{since: "2026-11-02T04:00:00.000Z"\}\)/);
    // Each agent's brief is the same words: nothing of one agent's day is in another's.
    assert.equal(m.text, sent[0].text);
  }
  assert.deepEqual(r.introspection, [{ agent: 'art', body: 'started' }, { agent: 'mark', body: 'started' }]);
  // By hand, one agent.
  const one = [];
  await runReview(env, { core, reviewer, models: anthropicOnly, introspect: 'art', state: { agents: { art: { repo: 'a' }, mark: { repo: 'm' } } }, pool: () => ({ pool: [], why: [] }), deliver: async (m) => { one.push(m.agent); return { body: 'fed' }; } });
  assert.deepEqual(one, ['art']);
  assert.throws(() => introspectionMessage(env, { agent: 'Not An Agent', day: 'd', since: 's', at: 'a' }), /which agent/);
});

// ─── The bare grader ────────────────────────────────────────────────────────

test('a bare grader: the CLI with no tools, MCP, settings or session, the box\'s login its only mount, the sample on stdin', () => {
  const env = envOf();
  const argv = graderRunArgs(env, { harness: 'claude', model: 'claude-sonnet-5', kind: 'live', image: 'loom-house-art:x', name: 'loom-grade-1' });
  const vols = argv.flatMap((a, i) => (argv[i - 1] === '-v' ? [a] : []));
  assert.deepEqual(vols, [`${join(env.LOOM_BOX_DATA, 'logins', 'claude')}:/run/loom/login/claude:rw,nosuid,nodev,noexec`]);
  assert.ok(argv.includes('--rm') && argv.includes('all') && !argv.includes('--privileged'));
  const script = argv.at(-1);
  for (const f of ["--tools ''", '--strict-mcp-config', "--setting-sources ''", '--disable-slash-commands', '--no-session-persistence', '--system-prompt', "--model 'claude-sonnet-5'"]) assert.ok(script.includes(f), f);
  assert.match(script, /Did the agent answer what was actually asked/);
  const cx = graderRunArgs(env, { harness: 'codex', model: 'gpt-5', kind: 'agent', image: 'img', name: 'n' }).at(-1);
  for (const f of ['--ephemeral', '--sandbox read-only', '--disable shell_tool', '--disable unified_exec', "web_search=\"disabled\""]) assert.ok(cx.includes(f), f);

  // One grading: the sample goes on stdin, never into argv, and the answer is checked.
  const calls = [];
  const run = (bin, a, o) => { calls.push({ a, input: o.input }); return { status: 0, stdout: JSON.stringify({ is_error: false, result: '{"score": 2, "finding": "Said it pushed\\nwithout saying where."}' }) }; };
  const v = grade(env, { harness: 'claude', model: 'claude-sonnet-5', image: 'img' }, { venueKind: 'live', entry: { kind: 'reply', text: 'SECRET-SAMPLE-WORDS' } }, { run, name: 'loom-grade-t' });
  assert.deepEqual(v, { score: 2, finding: 'Said it pushed without saying where.' });
  assert.ok(!calls[0].a.join(' ').includes('SECRET-SAMPLE-WORDS'));
  assert.match(calls[0].input, /SECRET-SAMPLE-WORDS/);
  // A timeout removes its container, and says nothing of the sample.
  const killed = [];
  assert.throws(() => grade(env, { harness: 'claude', model: 'm', image: 'img' }, { venueKind: 'live', entry: { text: 'SECRET' } }, { run: (b, a) => { killed.push(a); return a[0] === 'rm' ? {} : { error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM' }; }, name: 'loom-grade-x' }),
    (e) => e instanceof GraderError && !/SECRET/.test(e.message));
  assert.deepEqual(killed[1], ['rm', '-f', 'loom-grade-x']);
  assert.throws(() => graderInput({ text: 'x'.repeat(40_001) }), /1-40,000/);
});

test('a grader\'s answer: a whole score of 1-5, and a finding of one line, at most 200 characters, never key-like', () => {
  assert.deepEqual(verdictOf('```json\n{"score": 5}\n```'), { score: 5 });
  assert.deepEqual(verdictOf('Here you go: {"score": 1, "finding": "ok"} thanks'), { score: 1, finding: 'ok' });
  for (const bad of ['{"score": 6}', '{"score": 2.5}', '{"score": "4"}', 'no', '[]']) assert.throws(() => verdictOf(bad), GraderError, bad);
  const long = cleanFinding('word '.repeat(80));
  assert.ok(long.length <= MAX_FINDING && long.endsWith('…'));
  assert.equal(cleanFinding(`token sk-ant-${'a'.repeat(50)}`), undefined);
  assert.equal(cleanFinding('  \n '), undefined);
  assert.equal(cleanFinding('He wrote "Nobody calls me Danny" and the reply ignored it.'), 'He wrote "Nobody calls me Danny" and the reply ignored it.');
});

test('introspection through the runtime\'s own delivery: a turn on wake, then each agent\'s own body, started the normal way', async () => {
  const { world } = await import('./delivery-world.mjs');
  const { readBody } = await import('../src/bodies.mjs');
  const { loadConv } = await import('../src/delivery.mjs');
  const { deliver } = await import('../src/delivery.mjs');
  const w = world({ LOOM_RUNTIME_PIECE: 'runtime' });
  const { core, reviewer } = fakeCore({ entries: [] });
  const r = await runReview(w.env, {
    core, reviewer, models: anthropicOnly, scorecards: async () => [], state: { agents: { art: { repo: 'a' }, mark: { repo: 'm' } } }, now: w.clock.now,
    pool: () => ({ pool: [], why: [] }), deliver: (m) => deliver(w.env, m, w.o),
  });
  assert.deepEqual(r.introspection.map((x) => [x.agent, x.body]), [['art', 'started'], ['mark', 'started']]);
  // Recorded first, as every delivery is: a wake turn from the schedule, in each agent's own conversation.
  assert.deepEqual(w.core.turns.map((t) => [t.agent, t.venue, t.place, t.kind, t.from.kind, t.key]), [
    ['art', 'wake', 'review', 'wake', 'schedule', `runtime:review-${r.day}-art`], ['mark', 'wake', 'review', 'wake', 'schedule', `runtime:review-${r.day}-mark`]]);
  const starts = w.log.filter((l) => l[0] === 'start');
  assert.equal(starts.length, 2);
  for (const [agent, [, id, brief]] of [['art', starts[0]], ['mark', starts[1]]]) {
    assert.match(brief.split('\n')[0], new RegExp(`^You are ${agent}, `));
    assert.match(brief, /Daily review: your introspection/);
    // The body is the agent's own: its record names it, and the other agent appears nowhere in its brief.
    const cv = w.core.turns.find((t) => t.agent === agent).conversation;
    assert.equal(readBody(w.env, loadConv(w.env, cv).body).agent, agent);
    assert.equal(brief.includes(agent === 'art' ? 'mark' : 'art'), false);
    assert.ok(id);
  }
  // Once per agent per day: the same day's introspection again writes nothing and starts nothing.
  await runReview(w.env, { core, reviewer, models: anthropicOnly, state: { agents: { art: { repo: 'a' }, mark: { repo: 'm' } } }, now: w.clock.now, day: r.day, pool: () => ({ pool: [], why: [] }), deliver: (m) => deliver(w.env, m, w.o) });
  assert.equal(w.core.turns.length, 2);
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 2);
});

test('core knows a family the runtime doesn\'t: the producer\'s own family then doesn\'t grade, and the entry is done ungraded', async () => {
  const env = envOf();
  // The runtime's list is anthropic only; core has seen an openai turn too, so it refuses anthropic grading anthropic.
  const { st, core, reviewer } = fakeCore({ entries: [entry(1), entry(2)], families: ['anthropic', 'openai'] });
  let asked = 0;
  const r = await runReview(env, { core, reviewer, models: anthropicOnly, introspect: 'none', state: { agents: {} }, scorecards: async () => [], pool: () => ({ pool: [G('claude-sonnet-5', 'anthropic')], why: [] }), grade: async () => { asked += 1; return { score: 3 }; } });
  assert.equal(asked, 1, 'asked once; after core\'s refusal the fallback is off for the run');
  assert.deepEqual({ graded: r.graded, ungraded: r.ungraded, done: r.done, scores: st.scores.length }, { graded: 0, ungraded: 2, done: 2, scores: 0 });
});

test('a grading phase that fails still runs introspection; a token nearly out of time grades nothing more', async () => {
  const env = envOf();
  const { core, reviewer } = fakeCore({ entries: [entry(1)] });
  const broken = (t) => ({ ...reviewer(t), take: async () => { throw new CoreError('core didn\'t answer audit/take: connect ECONNREFUSED'); } });
  const sent = [];
  const r = await runReview(env, { core, reviewer: broken, models: anthropicOnly, state: { agents: { art: { repo: 'a' } } }, scorecards: async () => [], pool: () => ({ pool: [G('claude-sonnet-5', 'anthropic')], why: [] }), deliver: async (m) => { sent.push(m.agent); return { body: 'started' }; } });
  assert.match(r.error, /^grading: core didn't answer audit\/take/);
  assert.deepEqual(sent, ['art']);
  const late = fakeCore({ entries: [entry(1)] });
  const r2 = await runReview(env, { ...late, models: anthropicOnly, introspect: 'none', state: { agents: {} }, scorecards: async () => [], gradeForMs: 0, pool: () => ({ pool: [G('claude-sonnet-5', 'anthropic')], why: [] }), grade: async () => assert.fail('no grading past the token\'s time') });
  assert.deepEqual({ failed: r2.failed, done: r2.done }, { failed: 1, done: 0 });
});
