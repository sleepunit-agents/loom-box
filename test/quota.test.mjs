// Out of quota (t-1907): an agent keeps answering when its harness's account runs out.
//   - the resolver respects holds and windows' reset times; when nothing is out, its preference order is unchanged;
//   - the harnesses' structured refusals are read (never prose), and a Codex body keeps an MCP deny list;
//   - an out-of-quota reading during a resume starts a body on the other harness, from the digests, its slot parked
//     as home, and the conversation goes back once that harness has room again;
//   - a turn refused mid-way holds its account and is retried once on the other harness; never a second retry, and
//     "all out" is said plainly in the conversation and alerted;
//   - one Inbox FYI per switch, the agent's card, the Comms reply's "on Codex", the trace.
import { putWakeFor } from '../src/principal.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAccounts, hasRoom, holdAccount, roomAt, staticAccounts, supposeOut } from '../src/accounts.mjs';
import { readBody } from '../src/bodies.mjs';
import { deliver, deliveryDir, deliveryNotices, loadConv, readFallbacks, tick } from '../src/delivery.mjs';
import { claudeRefusal, codexRefusal, lastRefusal, refusedUntil } from '../src/logins.mjs';
import { judge } from '../src/loops.mjs';
import { resolveModel, setModels } from '../src/models.mjs';
import { ClaudeRunner, CodexRunner, codexDeny } from '../src/runners.mjs';
import { load } from '../src/state.mjs';
import { trace } from '../src/trace.mjs';
import { withFallbacks } from '../src/ui.mjs';
import { scratch } from './scratch.mjs';
import { cvOf, fakeRunner, plain, world } from './delivery-world.mjs';

const OPUS = { id: 'opus', harness: 'claude', family: 'anthropic' };
const GPT = { id: 'gpt', harness: 'codex', family: 'openai' };
const acct = (name, provider, usage = {}) => ({ name, label: name === 'max' ? 'Claude Max (jonathan\'s)' : 'Codex Pro (jonathan\'s)', provider, harness: provider === 'anthropic' ? 'claude' : 'codex', kind: 'login', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage });
const NOW = Date.parse('2026-11-06T12:00:00Z');
const S = Math.floor(NOW / 1000);

// ─── The resolver ───────────────────────────────────────────────────────────

test('the resolver respects resets_at: a full window past its reset has room; a hold until its reset has none', () => {
  const full = acct('max', 'anthropic', { '7d': 0.99, reset_7d: S + 3600 });
  assert.equal(hasRoom(full, undefined, NOW), false);
  assert.equal(roomAt(full, undefined, NOW), S + 3600);
  // The reading is from before its reset: once that's passed, the window has reset.
  assert.equal(hasRoom(full, undefined, NOW + 3601_000), true);
  assert.equal(roomAt(full, undefined, NOW + 3601_000), null);
  // A hold (a provider's refusal) wins over a reading that shows room, until its time.
  const held = acct('max', 'anthropic', { '7d': 0.5, held: S + 600 });
  assert.equal(hasRoom(held, undefined, NOW), false);
  assert.equal(roomAt(held, undefined, NOW), S + 600);
  assert.equal(hasRoom(held, undefined, NOW + 601_000), true);
  // Through the resolver: Claude held, so Codex, and it's a fallback; once the hold is over, Claude again.
  const models = [OPUS, GPT];
  const accounts = { accounts: [held, acct('pro', 'openai', { '7d': 0 })] };
  const r = resolveModel({ agent: 'art', kind: 'live', models, accounts, now: NOW });
  assert.equal(r.model, 'gpt');
  assert.deepEqual(r.preferred, { model: 'opus', harness: 'claude' });
  assert.equal(r.fallback.from, 'claude');
  assert.equal(r.fallback.until, S + 600);
  assert.equal(r.fallback.account, 'Claude Max (jonathan\'s)');
  assert.match(r.why.join('\n'), /Claude Max \(jonathan's\) out of quota \(its provider refused a turn\) until 2026-11-06T12:10:00/);
  const later = resolveModel({ agent: 'art', kind: 'live', models, accounts, now: NOW + 601_000 });
  assert.equal(later.model, 'opus');
  assert.equal(later.fallback, undefined);
});

test('when nothing is out, the preference order is unchanged, and nothing is a fallback', () => {
  const accounts = { accounts: [acct('max', 'anthropic', { '7d': 0.89 }), acct('pro', 'openai', { '7d': 0 })] };
  for (const [settings, prefer, want] of [[{}, [], 'opus'], [{ prefer: ['gpt'] }, [], 'gpt'], [{ prefer: ['opus'] }, ['gpt'], 'gpt'], [{ allow: ['gpt'] }, [], 'gpt']]) {
    const r = resolveModel({ agent: 'art', kind: 'live', models: [OPUS, GPT], settings, prefer, accounts, now: NOW });
    assert.equal(r.model, want, JSON.stringify(settings));
    assert.equal(r.fallback, undefined);
    assert.equal(r.preferred.model, want);
  }
  // Art's live numbers (Claude Max 7d 89%, Codex Pro 0%), and no preference: the list's first, as before.
  assert.match(resolveModel({ agent: 'art', kind: 'live', models: [OPUS, GPT], accounts, now: NOW }).why.join('\n'), /opus: first allowed with quota/);
});

test('avoid keeps a harness out for one body; every account out is a 409 naming each, with its reset', () => {
  const accounts = { accounts: [acct('max', 'anthropic'), acct('pro', 'openai', { '7d': 0.98, reset_7d: S + 7200 })] };
  assert.equal(resolveModel({ agent: 'art', kind: 'live', models: [OPUS, GPT], accounts, avoid: ['codex'], now: NOW }).model, 'opus');
  try {
    resolveModel({ agent: 'art', kind: 'live', models: [OPUS, GPT], accounts, avoid: ['claude'], now: NOW });
    assert.fail('expected all out');
  } catch (e) {
    assert.equal(e.status, 409);
    assert.deepEqual(e.out, [{ harness: 'claude' }, { harness: 'codex', account: 'Codex Pro (jonathan\'s)', until: S + 7200 }]);
  }
});

test('holds: written to the state by account name, capped, and applied to the accounts the boxes report', () => {
  const env = { HOME: scratch('rt-hold-'), LOOM_BOX_HOME: undefined };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  holdAccount(env, { name: 'owner:claude-abc', until: S + 99 * 86400, why: 'refused' }, NOW);
  holdAccount(env, { name: 'gone', until: S - 5 }, NOW - 7200_000);
  const s = load(env);
  assert.equal(s.quotaHolds['owner:claude-abc'].until, S + 8 * 86400, 'at most 8 days');
  // A hold with no reset: 30 minutes, doubled for each one in a day (a condition that doesn't lift isn't tried every
  // half hour); one past its time is dropped a day after, as the next is written.
  holdAccount(env, { name: 'x' }, NOW);
  assert.equal(load(env).quotaHolds.x.until, S + 1800);
  holdAccount(env, { name: 'x' }, NOW + 1801_000);
  assert.equal(load(env).quotaHolds.x.until, S + 1801 + 3600);
  holdAccount(env, { name: 'x' }, NOW + 5402_000);
  assert.equal(load(env).quotaHolds.x.until, S + 5402 + 7200);
  holdAccount(env, { name: 'x', until: S + 9000 }, NOW + 5402_000);
  assert.equal(load(env).quotaHolds.x.blind, undefined, 'a refusal with a reset ends the streak');
  holdAccount(env, { name: 'y' }, NOW + 86400_000 * 2);
  assert.equal(load(env).quotaHolds.gone, undefined);
  // deriveAccounts applies a hold to its account, until its time.
  const st = { accountSalt: 'salt', agents: { art: {} }, boxes: { b1: { local: true, harnesses: { claude: { loggedIn: true, account: 'a' } }, usage: { claude: { box: { windows: { '7d': 0.5 }, checked: S } } } } } };
  const name = deriveAccounts(st, { nowMs: NOW }).accounts[0].name;
  st.quotaHolds = { [name]: { until: S + 60, why: 'claude refused a turn' } };
  assert.equal(hasRoom(deriveAccounts(st, { nowMs: NOW }).accounts[0], undefined, NOW), false);
  assert.equal(deriveAccounts(st, { nowMs: NOW + 61_000 }).accounts[0].usage.held, undefined);
  // `models resolve --suppose-out claude`: as if Claude's were out, nothing held for real.
  const sup = supposeOut(staticAccounts({ accounts: [acct('max', 'anthropic'), acct('pro', 'openai')] }), ['claude'], NOW);
  assert.equal(resolveModel({ agent: 'art', kind: 'live', models: [OPUS, GPT], accounts: sup.list(), now: NOW }).model, 'gpt');
});

// ─── The harnesses' structured refusals ─────────────────────────────────────

const claudeError = (error) => ({ type: 'assistant', isApiErrorMessage: true, error, message: { model: '<synthetic>', content: [{ type: 'text', text: 'You\'ve hit your limit · resets 3pm' }] } });

test('refusals are read from structured fields: Claude Code\'s API error entry, a rejected rate_limit_event, Codex\'s codex_error_info', () => {
  assert.deepEqual(claudeRefusal(claudeError('rate_limit')), { code: 'rate_limit' });
  assert.deepEqual(claudeRefusal(claudeError('billing_error')), { code: 'billing_error' });
  assert.equal(claudeRefusal(claudeError('authentication_failed')), null, 'a login problem isn\'t quota');
  // Prose alone is never a refusal.
  assert.equal(claudeRefusal({ type: 'assistant', message: { content: [{ type: 'text', text: 'usage limit reached' }] } }), null);
  assert.deepEqual(claudeRefusal({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } }), { code: 'rate_limit' });
  assert.equal(claudeRefusal({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), null);
  assert.deepEqual(codexRefusal({ type: 'event_msg', payload: { type: 'error', message: 'You\'ve hit your usage limit.', codex_error_info: 'usage_limit_exceeded' } }), { code: 'usage_limit_exceeded' });
  assert.deepEqual(codexRefusal({ type: 'event_msg', payload: { type: 'error', codex_error_info: { usage_limit_exceeded: {} } } }), { code: 'usage_limit_exceeded' });
  assert.equal(codexRefusal({ type: 'event_msg', payload: { type: 'error', message: 'usage limit', codex_error_info: 'internal_server_error' } }), null);
  assert.deepEqual(codexRefusal({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 100, window_minutes: 300 }, rate_limit_reached_type: 'primary' } } }), { code: 'usage_limit_exceeded' });
  // The refusal that ended a turn: the last, with only bookkeeping after it; real work after it means it didn't.
  const l = (...xs) => xs.map((x) => JSON.stringify(x)).join('\n');
  assert.deepEqual(lastRefusal('claude', l({ type: 'user' }, claudeError('rate_limit'), { type: 'system' })), { code: 'rate_limit' });
  // A later turn (a prompt) that died with no output doesn't inherit the earlier turn's refusal; a tool result isn't a prompt.
  assert.equal(lastRefusal('claude', l(claudeError('rate_limit'), { type: 'user', message: { content: 'next message' } })), null);
  assert.deepEqual(lastRefusal('claude', l(claudeError('rate_limit'), { type: 'user', message: { content: [{ type: 'tool_result' }] } })), { code: 'rate_limit' });
  const ce = { type: 'event_msg', payload: { type: 'error', codex_error_info: 'usage_limit_exceeded' } };
  assert.equal(lastRefusal('codex', l(ce, { type: 'event_msg', payload: { type: 'user_message' } })), null);
  assert.equal(lastRefusal('claude', l(claudeError('rate_limit'), { type: 'assistant', message: { content: [] } })), null);
  // When it has room again: the full window's reset, else the soonest ahead (which one refused isn't known).
  assert.equal(refusedUntil({ windows: { '5h': 0.4, '7d': 0.99 }, resets: { '5h': S + 100, '7d': S + 9000 } }, S), S + 9000);
  assert.equal(refusedUntil({ windows: { '5h': 0.4, '7d': 0.8 }, resets: { '5h': S + 100, '7d': S + 9000 } }, S), S + 100);
  assert.equal(refusedUntil(null, S), undefined);
});

test('a runner\'s turn() says limited, and when: Claude Code from its transcript and status line; Codex from its rollout', () => {
  // The runner reads its status line against the real clock, so this reading is from now, not NOW: a fixed reading went stale at 2026-11-07 12:00Z and its reset was dropped.
  const T = Math.floor(Date.now() / 1000);
  const D = scratch('rt-limited-');
  // Claude: its job's turn is over, its transcript ends on the API error, its status line kept the reading.
  const jobs = join(D, 'jobs'), projects = join(D, 'projects'), usage = join(D, 'usage');
  mkdirSync(join(jobs, 'abcd1234'), { recursive: true });
  mkdirSync(join(projects, '-home-art-Art'), { recursive: true });
  mkdirSync(usage, { recursive: true });
  writeFileSync(join(jobs, 'abcd1234', 'state.json'), JSON.stringify({ state: 'done', tempo: 'idle', sessionId: 'sess-1234' }));
  const tx = join(projects, '-home-art-Art', 'sess-1234.jsonl');
  writeFileSync(tx, [{ type: 'user' }, { type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }] } }, claudeError('rate_limit')].map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(usage, 'sess-1234.json'), JSON.stringify({ at: T, reading: { windows: { '5h': 0.3, '7d': 1 }, resets: { '5h': T + 100, '7d': T + 86400 } } }));
  const cr = new ClaudeRunner({ jobsDir: jobs, projectsDir: projects, usageDir: usage });
  assert.deepEqual(cr.turn({ id: 'abcd1234' }), { failed: true, worked: null, limited: true, error: 'its provider refused it (rate_limit)', resets: T + 86400 });
  // The next turn worked: not limited.
  writeFileSync(tx, readFileSync(tx, 'utf-8') + JSON.stringify({ type: 'user' }) + '\n' + JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n');
  assert.equal(cr.turn({ id: 'abcd1234' }).limited, undefined);
  // Codex: turn.failed on exec's stdout (a message only), and the rollout's error event with its codex_error_info.
  const runs = join(D, 'runs'), sessions = join(D, 'codex', 'sessions');
  // The runner reads its reset against the real clock: ahead of it.
  const R = Math.floor(Date.now() / 1000) + 5000;
  mkdirSync(join(runs, 'k1'), { recursive: true });
  mkdirSync(join(sessions, '2026', '11', '06'), { recursive: true });
  writeFileSync(join(runs, 'k1', 'events.jsonl'), [{ type: 'thread.started', thread_id: 'th-77' }, { type: 'turn.failed', error: { message: 'You\'ve hit your usage limit.' } }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(sessions, '2026', '11', '06', 'rollout-2026-11-06T12-00-00-th-77.jsonl'), [
    { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 100, window_minutes: 10080, resets_at: R } } } },
    { type: 'event_msg', payload: { type: 'error', message: 'You\'ve hit your usage limit.', codex_error_info: 'usage_limit_exceeded' } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const xr = new CodexRunner({ runsDir: runs, sessionsDir: sessions });
  const t = xr.turn({ id: 'k1' });
  assert.equal(t.limited, true);
  assert.equal(t.resets, R);
  // A turn that failed for something else isn't limited.
  writeFileSync(join(sessions, '2026', '11', '06', 'rollout-2026-11-06T12-00-00-th-77.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'error', codex_error_info: 'context_window_exceeded' } }) + '\n');
  assert.equal(xr.turn({ id: 'k1' }).limited, undefined);
  // A limited run isn't a crash loop's failure (loops.mjs).
  assert.equal(judge({ turn: { failed: true, limited: true, worked: false }, posts: [] }).failed, null);
});

test('a Codex body turns every denied MCP server off, wherever it is defined or not; a tool-level deny refuses', async () => {
  assert.deepEqual(codexDeny(['mcp__handoff', 'mcp__claude_ai_Gmail', 'mcp__loom']).args, [
    '-c', 'mcp_servers.claude_ai_Gmail={enabled=false, command="false"}',
    '-c', 'mcp_servers.handoff={enabled=false, command="false"}',
    '-c', 'mcp_servers.loom={enabled=false, command="false"}']);
  // What Codex can't be trusted to keep: one tool of a server, a built-in, a name that isn't one.
  for (const d of ['mcp__loom__note_write', 'WebFetch', 'mcp__a b', 'mcp__']) assert.match(codexDeny([d]).error, /can't deny/, d);
  // Launched: a server in the real home's config, in a profile there, under the body env's CODEX_HOME, or in no config
  // at all, is in no config the body's Codex reads (its made home's), and is turned off on its command line too.
  const h = (() => { const D = scratch('rt-codexdeny-'); return { D, env: { ...process.env, FAKE_HARNESS: D } }; })();
  mkdirSync(join(h.D, 'other'), { recursive: true });
  mkdirSync(join(h.D, 'repo'), { recursive: true });
  writeFileSync(join(h.D, 'other', 'config.toml'), 'profile = "p"\n[mcp_servers."inbodyhome"]\nurl = "http://y"\n[mcp_servers.kept]\ncommand = "k"\n[profiles.p.mcp_servers.inprofile]\ncommand = "x"\n');
  writeFileSync(join(h.D, 'other', 'p.config.toml'), '[mcp_servers.inprofile]\ncommand = "x"\n');
  const r = new CodexRunner({ codex: join(dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs'), runsDir: join(h.D, 'runs'), codexHome: join(h.D, 'home'), sessionsDir: join(h.D, 'home', 'sessions'), systemDir: join(h.D, 'etc') });
  const deny = ['mcp__inprofile', 'mcp__inbodyhome', 'mcp__nowhere'];
  const b = r.start({ brief: 'x', model: 'm', cwd: join(h.D, 'repo'), env: { ...h.env, CODEX_HOME: join(h.D, 'other') }, deny });
  const until = Date.now() + 5000;
  while (!existsSync(join(h.D, 'argv.log')) && Date.now() < until) await new Promise((res) => setTimeout(res, 20));
  const { args, home } = JSON.parse(readFileSync(join(h.D, 'argv.log'), 'utf-8').trim().split('\n')[0]);
  for (const n of ['inprofile', 'inbodyhome', 'nowhere']) assert.ok(args.includes(`mcp_servers.${n}={enabled=false, command="false"}`), n);
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf-8').replace(/^#.*\n/gm, '').trim(), '[mcp_servers.kept]\ncommand = "k"');
  r.end(b);
  assert.throws(() => r.start({ brief: 'x', model: 'm', cwd: h.D, env: h.env, deny: ['mcp__loom__note_write'] }), /can't deny mcp__loom__note_write/);
});

// ─── Delivery ───────────────────────────────────────────────────────────────

/** The delivery world with two harnesses: Claude (opus, on Max) and Codex (gpt, on Pro), each its own fake runner. */
function twoHarnesses() {
  const w = world();
  setModels(w.env, { list: [OPUS, GPT], agent: 'art', prefer: ['opus'] });
  const codex = fakeRunner(w.log, join(w.env.HOME, 'cx'), 'codex');
  const max = acct('max', 'anthropic');
  const pro = acct('pro', 'openai');
  const accounts = staticAccounts({ accounts: [max, pro] });
  const alerts = [];
  w.o.runner = (h) => (h === 'codex' ? codex : w.runner);
  w.o.accounts = accounts;
  w.o.alert = (_e, a) => { alerts.push(a); return true; };
  const conv = (place = 'dm:U1') => loadConv(w.env, cvOf('art', 'slack', place));
  const starts = () => w.log.filter((l) => l[0] === 'start' || l[0] === 'resume');
  const fyis = (re) => deliveryNotices(w.env, w.clock.now().getTime()).filter((n) => re.test(n.text));
  return { ...w, codex, max, pro, accounts, alerts, conv, starts, fyis };
}

test('an out-of-quota reading during a resume starts a body on the other harness, from the digests; it goes home once there is room', async () => {
  const w = twoHarnesses();
  await deliver(w.env, w.msg('dm:U1', 'first'), w.o);
  const c1 = w.conv();
  assert.match(c1.body, /^claude:/);
  w.runner.finish(c1.body);
  // Claude Max reads full now, until an hour from now.
  w.max.usage = { '7d': 0.99, reset_7d: Math.floor(w.clock.now().getTime() / 1000) + 3600 };
  await deliver(w.env, w.msg('dm:U1', 'second'), w.o);
  const c2 = w.conv();
  assert.match(c2.body, /^codex:/, 'a fresh body on Codex');
  const [kind, , brief] = w.starts().at(-1);
  assert.equal(kind, 'start', 'started, not resumed: Codex can\'t continue a Claude session');
  assert.match(brief, /read it with conversation\(\{id: "cv-[0-9a-f]{12}"\}\) \(its digests\)/);
  assert.match(brief, /session ran on Claude, whose account is out of quota for now/);
  assert.ok(plain(brief).endsWith('loren: second'));
  // Its Claude slot is kept, as home; the body's record says it's a switch.
  assert.equal(c2.home.harness, 'claude');
  assert.ok(existsSync(join(deliveryDir(w.env), 'slots', `${c2.conversation}.home.age`)));
  assert.equal(c2.slot, undefined);
  const rec = readBody(w.env, c2.body);
  assert.equal(rec.switched.from, 'claude');
  assert.match(rec.switched.why, /Claude Max \(jonathan's\) out of quota/);
  assert.equal(c2.runLog.at(-1).switched.from, 'claude');
  // One FYI for the switch; the card says "on Codex".
  assert.equal(w.fyis(/^Art is answering on Codex: Claude Max \(jonathan's\) is out until /).length, 1);
  assert.equal(readFallbacks(w.env).art.to, 'codex');
  assert.deepEqual(withFallbacks({}, readFallbacks(w.env), {}, w.clock.now().getTime()).art.readings[0].value, 'on Codex');
  // Still out: the next message resumes the Codex session, and no second FYI.
  w.codex.finish(c2.body);
  await deliver(w.env, w.msg('dm:U1', 'third'), w.o);
  assert.equal(w.starts().at(-1)[0], 'resume');
  assert.match(w.conv().body, /^codex:/);
  assert.equal(w.fyis(/answering on Codex/).length, 1, 'one FYI per switch, not per message');
  // The trace shows the switch.
  const t = await trace(w.env, { agents: '*' }, { conversation: c2.conversation, run: c2.run });
  assert.ok(t.steps.some((x) => x.step === 'switched' && /switched from claude to codex/.test(x.words)));
  // The window resets: the next message goes home, to the Claude session, told to read what it missed.
  w.codex.finish(w.conv().body);
  w.clock.advance(3601_000);
  await deliver(w.env, w.msg('dm:U1', 'fourth'), w.o);
  const back = w.starts().at(-1);
  assert.equal(back[0], 'resume');
  assert.equal(back[2], c1.slot?.session ?? readBody(w.env, c1.body).slot.session, 'its own Claude session');
  assert.match(back[4], /it was answered on Codex, because this harness's account was out of quota/);
  const c4 = w.conv();
  assert.match(c4.body, /^claude:/);
  assert.equal(c4.home, undefined);
  assert.equal(c4.fallback, undefined);
  assert.equal(c4.runLog.at(-1).home, true);
  assert.equal(w.fyis(/^Art is back on Claude/).length, 1);
  assert.equal(readFallbacks(w.env).art, undefined);
});

test('a mid-turn rate-limit refusal holds the account and retries that turn once on the other harness', async () => {
  const w = twoHarnesses();
  await deliver(w.env, w.msg('dm:U1', 'what did we decide about the pond?'), w.o);
  const c1 = w.conv();
  const resets = Math.floor(w.clock.now().getTime() / 1000) + 5400;
  // The body refused partway: its turn is over, limited.
  w.runner.finish(c1.body, { failed: true, worked: true, limited: true, resets, error: 'its provider refused it (rate_limit)' });
  await tick(w.env, w.o);
  // Held at once, until the reset: the readings still show room.
  assert.deepEqual(w.accounts.holds.map((h) => [h.name, h.until]), [['max', resets]]);
  assert.equal(hasRoom(w.max, undefined, w.clock.now().getTime()), false);
  const c2 = w.conv();
  assert.match(c2.body, /^codex:/);
  const [kind, , brief] = w.starts().at(-1);
  assert.equal(kind, 'start');
  assert.match(brief, /was cut off partway through: its provider refused it for a usage limit/);
  assert.ok(plain(brief).endsWith('loren: what did we decide about the pond?'), 'the same turn, again');
  assert.equal(c2.runLog.at(-1).retryOf, c1.run);
  assert.equal(c2.runLog.find((r) => r.run === c1.run).quotaDone, true);
  assert.equal(c2.home.harness, 'claude');
  assert.equal(w.starts().filter((x) => x[0] === 'start').length, 2, 'one retry');
  const t = await trace(w.env, { agents: '*' }, { conversation: c2.conversation, run: c1.run });
  assert.ok(t.steps.some((x) => /refused its turn for a usage limit/.test(x.words)));
});

test('no second retry: a retry refused too is said plainly in the conversation and alerted; all out answers each message, alerts once', async () => {
  const w = twoHarnesses();
  const loom = (text) => w.msg('th:abcdefghij', text, { venue: 'loom', label: 'Comms' });
  await deliver(w.env, loom('ship it?'), w.o);
  const cv = cvOf('art', 'loom', 'th:abcdefghij');
  const s = Math.floor(w.clock.now().getTime() / 1000);
  w.runner.finish(loadConv(w.env, cv).body, { failed: true, limited: true, resets: s + 3600 });
  await tick(w.env, w.o);
  const retry = loadConv(w.env, cv);
  assert.match(retry.body, /^codex:/);
  // The retry is refused too.
  w.codex.finish(retry.body, { failed: true, limited: true, resets: s + 7200 });
  await tick(w.env, w.o);
  assert.equal(w.starts().filter((x) => x[0] === 'start').length, 2, 'never a third body for that turn');
  assert.deepEqual(w.accounts.holds.map((h) => h.name), ['max', 'pro']);
  const said = w.core.commsCalls.filter((b) => b.op === 'post');
  assert.equal(said.length, 1);
  assert.match(said[0].text, /^I couldn't finish answering this: my model accounts ran out of quota partway through \(Claude Max \(jonathan's\) is out until .+; Codex Pro \(jonathan's\) is out until .+\)\. Ask me again after /);
  assert.equal(w.alerts.length, 1);
  assert.equal(w.alerts[0].source, 'runtime-quota');
  // Everything out: a new message starts nothing, and is answered plainly; the owner hears of it once.
  await deliver(w.env, loom('anyone there?'), w.o);
  await deliver(w.env, loom('hello?'), w.o);
  assert.equal(w.starts().filter((x) => x[0] === 'start').length, 2);
  const posts = w.core.commsCalls.filter((b) => b.op === 'post').map((b) => b.text);
  assert.equal(posts.filter((p) => p.startsWith('I can\'t answer right now: every model account I may use is out of quota')).length, 2);
  assert.equal(w.alerts.length, 2, 'the retry\'s alert, then one for all out');
  // Room again: the next message starts a body, and all-out is over.
  w.clock.advance(7201_000);
  await deliver(w.env, loom('now?'), w.o);
  assert.match(loadConv(w.env, cv).body, /^claude:/);
  assert.equal(loadConv(w.env, cv).allOut, undefined);
});

test('a Comms reply from a switched body says it\'s on Codex (its channel line); one from the preferred harness says nothing', async () => {
  const w = twoHarnesses();
  w.max.usage = { held: Math.floor(w.clock.now().getTime() / 1000) + 600 };
  await deliver(w.env, w.msg('th:abcdefghij', 'hi', { venue: 'loom', label: 'Comms' }), w.o);
  const cv = cvOf('art', 'loom', 'th:abcdefghij');
  assert.match(loadConv(w.env, cv).body, /^codex:/);
  const session = (h, c) => (h === 'codex' ? w.codex : w.runner).slotOf({ id: loadConv(w.env, c).body.split(':')[1] }).session;
  const r = await w.send({ conversation: cv, text: 'hello from codex', session: session('codex', cv), key: Object.values(w.codex.envs).at(-1).LOOM_BODY_KEY }, { ...w.o, caller: { kind: 'agent', agent: 'art' }, onSend: () => {} });
  assert.equal(r.accepted, true);
  await new Promise((res) => setTimeout(res, 50));
  const post = w.core.commsCalls.filter((b) => b.op === 'post').at(-1);
  assert.equal(post.on, 'Codex');
  // A fresh conversation while nothing is out: no "on".
  w.max.usage = {};
  await deliver(w.env, w.msg('th:bcdefghijk', 'hi', { venue: 'loom', label: 'Comms' }), w.o);
  const cv2 = cvOf('art', 'loom', 'th:bcdefghijk');
  assert.match(loadConv(w.env, cv2).body, /^claude:/);
  await w.send({ conversation: cv2, text: 'hello from claude', session: session('claude', cv2), key: Object.values(w.runner.envs).at(-1).LOOM_BODY_KEY }, { ...w.o, caller: { kind: 'agent', agent: 'art' }, onSend: () => {} });
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(w.core.commsCalls.filter((b) => b.op === 'post').at(-1).on, undefined);
  // A fresh body on Claude, while the first conversation is still on Codex: the agent isn't "back" yet (one FYI each
  // way per switch, not one per conversation's run).
  assert.equal(w.fyis(/answering on Codex/).length, 1);
  assert.equal(w.fyis(/back on Claude/).length, 0);
  assert.equal(readFallbacks(w.env).art.to, 'codex');
});

test('when nothing is out, delivery runs as before: the preferred harness, no switch, no FYI', async () => {
  const w = twoHarnesses();
  await deliver(w.env, w.msg('dm:U1', 'hello'), w.o);
  const c = w.conv();
  assert.match(c.body, /^claude:/);
  assert.equal(readBody(w.env, c.body).switched, undefined);
  assert.equal(c.home, undefined);
  assert.deepEqual(readFallbacks(w.env), {});
  assert.equal(deliveryNotices(w.env, w.clock.now().getTime()).length, 0);
  assert.equal(w.accounts.holds.length, 0);
});

test('a body whose deny list Codex can\'t keep never falls back to Codex; with Claude out it says so plainly', async () => {
  const w = twoHarnesses();
  w.o.policy = () => ({ deny: ['mcp__loom__note_write'] });
  w.max.usage = { held: Math.floor(w.clock.now().getTime() / 1000) + 600 };
  await deliver(w.env, w.msg('th:abcdefghij', 'hi', { venue: 'loom', label: 'Comms' }), w.o);
  assert.equal(w.starts().length, 0, 'no unrestricted Codex body');
  const said = w.core.commsCalls.filter((b) => b.op === 'post').at(-1).text;
  assert.match(said, /^I can't answer right now: every model account I may use is out of quota \(Claude Max \(jonathan's\) is out until .+\)\. Codex can't keep this conversation's tool limits, so I can't answer on it here\./);
  assert.match(w.alerts[0].facts.cant, /codex can't keep its deny list/);
  // A server-level deny Codex keeps: it falls back as any body does.
  const w2 = twoHarnesses();
  w2.o.policy = () => ({ deny: ['mcp__handoff'] });
  w2.codex.wontRun = () => null;
  w2.max.usage = { held: Math.floor(w2.clock.now().getTime() / 1000) + 600 };
  await deliver(w2.env, w2.msg('dm:U1', 'hi'), w2.o);
  assert.match(w2.conv().body, /^codex:/);
  assert.deepEqual(w2.codex.denies[w2.conv().body.split(':')[1]], ['mcp__handoff']);
  // One this runtime's Codex won't run here (runners.mjs, wontRun: a config layer its made home can't replace, or
  // LOOM_RUNTIME_CODEX_PROFILE): kept off Codex as well, asked with the body's deny list, cwd and env.
  const w3 = twoHarnesses();
  const asked = [];
  w3.codex.wontRun = (deny, cwd, env) => { asked.push({ deny, cwd, key: !!env?.LOOM_BODY_KEY }); return 'Codex would read /x/.codex/config.toml too'; };
  w3.o.policy = () => ({ deny: ['mcp__handoff'] });
  w3.max.usage = { held: Math.floor(w3.clock.now().getTime() / 1000) + 600 };
  await deliver(w3.env, w3.msg('dm:U1', 'hi'), w3.o);
  assert.equal(w3.starts().length, 0, 'no Codex body where its deny list could be undone');
  assert.deepEqual(asked.map((a) => a.deny), [['mcp__handoff']]);
  assert.equal(asked[0].cwd, w3.o.cwd);
  assert.equal(asked[0].key, true, 'with the body\'s env (its run key)');
  assert.match(w3.alerts[0].facts.cant, /codex can't keep its deny list here: Codex would read \/x\/\.codex\/config\.toml too/, 'the reason reaches the owner');
  // Refused there while Claude has room: the body runs on Claude, as it would anyway.
  const w4 = twoHarnesses();
  w4.codex.wontRun = () => 'Codex would read /x/.codex/config.toml too';
  w4.o.policy = () => ({ deny: ['mcp__handoff'] });
  await deliver(w4.env, w4.msg('dm:U1', 'hi'), w4.o);
  assert.match(w4.conv().body, /^claude:/);
});

test('a body on loom\'s machine never falls back to Codex (its guards are Claude Code hooks there) unless the owner says so (t-1921)', async () => {
  const LOCAL = (more = {}) => JSON.stringify({ agents: ['art'], cwd: '/home/art/Art', ...more });
  for (const [lb, want] of [[LOCAL(), null], [LOCAL({ codex: true }), 'codex']]) {
    const w = world({ LOOM_RUNTIME_LOCAL_BODIES: lb });
    setModels(w.env, { list: [OPUS, GPT], agent: 'art', prefer: ['opus'] });
    const localClaude = fakeRunner(w.log, join(w.env.HOME, 'lc'), 'claude');
    const localCodex = fakeRunner(w.log, join(w.env.HOME, 'lx'), 'codex');
    const max = acct('max', 'anthropic', { held: Math.floor(w.clock.now().getTime() / 1000) + 600 });
    w.o.accounts = staticAccounts({ accounts: [max, acct('pro', 'openai')] });
    w.o.runner = (h, local) => (local ? (h === 'codex' ? localCodex : localClaude) : w.runner);
    const alerts = [];
    w.o.alert = (_e, a) => { alerts.push(a); return true; };
    const wake = w.msg('alert:test', 'look at this', { venue: 'wake', from: { kind: 'schedule' }, kind: 'wake', source: 'clock', local: true });
    // The clock's word first, as it fires one (t-1952): set on loom's machine, the owner's.
    putWakeFor(deliveryDir(w.env), { agent: wake.agent, place: wake.place, id: wake.id, for: 'owner' });
    await deliver(w.env, wake, w.o);
    const c = loadConv(w.env, cvOf('art', 'wake', 'alert:test'));
    if (want) {
      assert.match(c.body, /^codex:/, 'the owner let it: Codex, as any body falls back');
      continue;
    }
    assert.equal(c.body, undefined);
    assert.equal(w.log.filter((l) => l[0] === 'start').length, 0, 'no Codex body on loom\'s machine');
    assert.match(alerts[0].facts.cant, /runs only on Claude Code, whose hooks there keep its guards/);
  }
});

test('a Codex that won\'t run a body in its house (only its host can tell, at the start) is passed over in the same delivery (t-1924)', async () => {
  const w = twoHarnesses();
  setModels(w.env, { list: [OPUS, GPT], agent: 'art', prefer: ['gpt'] });
  w.codex.failStart = "codex won't run this body here: Codex would read /home/art/Art/.codex/config.toml too, a config the runtime can't replace";
  const warned = [];
  w.o.warn = (m) => warned.push(m);
  const a = await deliver(w.env, w.msg('dm:U1', 'hi'), w.o);
  assert.equal(a.body, 'started', 'never a failed start');
  assert.match(w.conv().body, /^claude:/, 'on Claude, off Codex');
  assert.equal(w.conv().retryAt, undefined);
  assert.ok(warned.some((m) => /starting it off Codex/.test(m)));
  // Any other failed start is one, as before.
  const w2 = twoHarnesses();
  setModels(w2.env, { list: [OPUS, GPT], agent: 'art', prefer: ['gpt'] });
  w2.codex.failStart = 'no box may host art';
  const b = await deliver(w2.env, w2.msg('dm:U1', 'hi'), w2.o);
  assert.notEqual(b.body, 'started');
  assert.equal(w2.starts().length, 0);
});

test('a refusal holds only the account the body ran on, not another of the same label', async () => {
  const w = twoHarnesses();
  // A second Claude Max login of the same owner: the same label, another account.
  const max2 = { ...acct('max', 'anthropic'), name: 'max-2' };
  w.accounts.list().accounts.push(max2);
  await deliver(w.env, w.msg('dm:U1', 'hi'), w.o);
  const c = w.conv();
  assert.equal(readBody(w.env, c.body).accountKey, 'max');
  w.runner.finish(c.body, { failed: true, limited: true, resets: Math.floor(w.clock.now().getTime() / 1000) + 600 });
  await tick(w.env, w.o);
  assert.deepEqual(w.accounts.holds.map((h) => h.name), ['max']);
  // The other login has room: the retry avoids Claude for that turn, the next turn may use it.
  assert.equal(hasRoom(max2, undefined, w.clock.now().getTime()), true);
});

test('a refused turn whose messages weren\'t sealed (no age) is failed and said, never silently dropped', async () => {
  const w = twoHarnesses();
  w.o.sealer = { seal: () => { throw new Error('no age'); }, open: () => { throw new Error('no age'); } };
  const a = await deliver(w.env, w.msg('dm:U1', 'hi'), w.o);
  assert.equal(a.body, 'started');
  const c = w.conv();
  const key = Object.keys(c.outcomes)[0];
  w.runner.finish(c.body, { failed: true, limited: true });
  await tick(w.env, w.o);
  assert.equal(w.starts().length, 1, 'nothing to run again');
  assert.match(w.conv().outcomes[key].reason, /can't keep its text to run it again \(no age\)/);
});

test('`models resolve --json --suppose-out` prints JSON (the flag never shadows the printer)', async () => {
  const { spawnSync } = await import('node:child_process');
  const D = scratch('rt-cli-');
  const env = { ...process.env, HOME: D, LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_DATA: join(D, 'data'), LOOM_RUNTIME_SCORECARDS: 'off' };
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
  for (const extra of [[], ['--suppose-out', 'claude']]) {
    const r = spawnSync(process.execPath, [cli, 'models', 'resolve', '--agent', 'art', '--venue', 'slack', '--json', ...extra], { env, encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).model, r.stdout);
  }
});

test('a parked home session that was told a person\'s standing authority goes home only under the same rules (t-1745)', async () => {
  const w = twoHarnesses();
  const gates = { people: { phil: { name: 'Phil', tier: 2, grant: 'May have fleet setup run on his ask.' } } };
  Object.assign(w.o, {
    policy: () => ({ deny: ['mcp__handoff'] }), gates: () => gates, card: () => null,
    venues: () => ({ slack: { kind: 'live', send: [process.execPath, join(dirname(fileURLToPath(import.meta.url)), 'fake-send.mjs')] } }),
    adapter: async (argv, c, args) => (args[0] === '--describe' ? { ok: true, venue: 'DPHIL', members: ['phil'] } : { ok: true }),
  });
  const phil = (text) => w.msg('dm:UPHIL', text, { from: { kind: 'person', slug: 'phil' } });
  await deliver(w.env, phil('first'), w.o);
  const conv = () => w.conv('dm:UPHIL');
  assert.equal(conv().bodyRules.grantFor, 'phil');
  w.runner.finish(conv().body);
  w.max.usage = { '7d': 0.99, reset_7d: Math.floor(w.clock.now().getTime() / 1000) + 3600 };
  await deliver(w.env, phil('second'), w.o);
  assert.match(conv().body, /^codex:/);
  assert.equal(conv().home.rules.grantFor, 'phil', 'the parked home holds phil\'s authority');
  w.codex.finish(conv().body);
  w.clock.advance(3601_000);
  // Room on Claude again, but what comes is a relay, not phil: never the session that held his authority.
  await deliver(w.env, w.msg('dm:UPHIL', 'a relay for phil', { from: { kind: 'agent', id: 'mark' } }), w.o);
  const last = w.starts().at(-1);
  assert.notEqual(last[0] === 'resume' && last[2] === readBody(w.env, conv().body)?.slot?.session, true);
  assert.equal(conv().runLog.at(-1).home, undefined, 'not resumed from home');
  assert.equal(plain(last[0] === 'start' ? last[2] : last[4]).includes('Standing authority'), false);
});
