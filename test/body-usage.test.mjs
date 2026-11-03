// Usage from the runtime's own bodies (t-1754): a `claude --bg` body's status line keeps its account's rate limits
// (statusline.mjs), a Codex body's thread rollout has its token_count, and the body host reports each when a body's
// turn ends, through the house's `usage` path (as a house run-task does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { capture, keptReading, readingFromStatusline } from '../src/statusline.mjs';
import { ClaudeRunner, CodexRunner } from '../src/runners.mjs';
import { runBodyHost } from '../src/bodyhost.mjs';
import { scratch } from './scratch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SESSION = '8ceb41de-fb50-4965-9855-7d716ec8d1cc';
// What Claude Code 2.1.317 gave a background session's status line (trimmed: the rest is never kept).
const STATUS = { session_id: SESSION, transcript_path: '/home/x/.claude/projects/p/s.jsonl', cwd: '/home/x/work', model: { id: 'claude-haiku-4-5' },
  cost: { total_cost_usd: 0.01 }, rate_limits: { five_hour: { used_percentage: 12, resets_at: 1793720000 }, seven_day: { used_percentage: 10, resets_at: 1794265200 } } };

test('a status line\'s rate_limits are a reading; only that is kept, by its session, 0600', () => {
  assert.deepEqual(readingFromStatusline(STATUS), { windows: { '5h': 0.12, '7d': 0.1 }, resets: { '5h': 1793720000, '7d': 1794265200 } });
  assert.equal(readingFromStatusline({ session_id: SESSION, rate_limits: null }), null, 'the first line of a session has none yet');
  const dir = join(scratch('rt-sl-'), 'usage');
  assert.deepEqual(capture(dir, JSON.stringify(STATUS), 1793700000_000)?.session, SESSION);
  const f = join(dir, `${SESSION}.json`);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const kept = JSON.parse(readFileSync(f, 'utf-8'));
  assert.deepEqual(Object.keys(kept).sort(), ['at', 'reading']);
  assert.ok(!readFileSync(f, 'utf-8').includes('/home/x'), 'no path, model or cost: the reading alone');
  assert.deepEqual(keptReading(dir, SESSION), { windows: { '5h': 0.12, '7d': 0.1 }, resets: { '5h': 1793720000, '7d': 1794265200 }, checked: 1793700000 });
  assert.equal(capture(dir, JSON.stringify({ ...STATUS, session_id: '../../etc/x' })), null);
  assert.equal(capture(dir, 'not json'), null);
  assert.equal(keptReading(dir, '../x'), null);
});

test('a Claude body\'s status line is the runtime\'s: run as Claude Code runs it, it keeps the reading the runner reads back', () => {
  const D = scratch('rt-sl-run-');
  const r = new ClaudeRunner({ claude: join(here, 'fake-claude.mjs'), jobsDir: join(D, 'jobs'), usageDir: join(D, 'usage'), sleep: () => {} });
  const b = r.start({ brief: 'hi', model: 'm', cwd: D, env: { ...process.env, FAKE_HARNESS: D } });
  const at = readFileSync(join(D, 'argv.log'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)).find((a) => a[0] === '--bg');
  const settings = JSON.parse(at[at.indexOf('--settings') + 1]);
  assert.equal(settings.statusLine.type, 'command');
  // Claude Code runs it through a shell, the session's JSON on stdin; it prints the line it shows.
  const out = spawnSync('sh', ['-c', settings.statusLine.command], { input: JSON.stringify({ ...STATUS, session_id: b.slot.session }), encoding: 'utf-8' });
  assert.equal(out.status, 0);
  assert.equal(out.stdout.trim(), '5h 12% · 7d 10%');
  assert.deepEqual(r.usage(b).windows, { '5h': 0.12, '7d': 0.1 });
  // Garbage in: the line is empty and the session goes on.
  assert.equal(spawnSync('sh', ['-c', settings.statusLine.command], { input: 'nope', encoding: 'utf-8' }).status, 0);
  // Args that bring their own --settings keep theirs (Claude Code takes one); no usage dir, no status line.
  assert.deepEqual(new ClaudeRunner({ args: ['--settings', '{}'], usageDir: join(D, 'usage') }).statusLine(), []);
  assert.deepEqual(new ClaudeRunner({ usageDir: '' }).statusLine(), []);
  assert.deepEqual(new ClaudeRunner({ usageDir: "/tmp/it's" }).statusLine(), [], 'never a path a shell reads as more than a word');
});

test('a Codex body\'s usage: the last token_count in its thread\'s rollout', () => {
  const D = scratch('rt-cx-usage-');
  const r = new CodexRunner({ runsDir: join(D, 'runs'), sessionsDir: join(D, 'sessions') });
  mkdirSync(join(D, 'runs', 'k1'), { recursive: true });
  writeFileSync(join(D, 'runs', 'k1', 'events.jsonl'), `${JSON.stringify({ type: 'thread.started', thread_id: 'th-0123' })}\n`);
  const day = join(D, 'sessions', '2026', '11', '03');
  mkdirSync(day, { recursive: true });
  const tc = (pct) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 10080, resets_at: 1794000000 }, plan_type: 'pro' } } });
  writeFileSync(join(day, 'rollout-2026-11-03T04-00-00-th-0123.jsonl'), [tc(4), JSON.stringify({ type: 'response_item' }), tc(7)].join('\n') + '\n');
  const u = r.usage({ id: 'k1' });
  assert.deepEqual([u.windows, u.resets, u.plan], [{ '7d': 0.07 }, { '7d': 1794000000 }, 'pro']);
  assert.equal(typeof u.checked, 'number');
  assert.equal(r.usage({ id: 'nothing' }), null);
});

/** A body host against a stand-in runtime: one start asked, then nothing; `turns` is the body's status, beat by beat. */
async function host({ turns, readings, usageFails = false }) {
  const sent = [], logs = [];
  let beat = 0, asked = false;
  const client = async (path, body) => {
    if (path === 'usage') { if (usageFails) throw new Error('no such house running'); sent.push(body); return { ok: true }; }
    if (path !== 'body-sync') throw new Error(path);
    if (!asked) { asked = true; return { req: { r1: { harness: 'claude', brief: 'hi', model: 'm' } } }; }
    return { req: { r1: { harness: 'claude', brief: 'hi', model: 'm' } } };
  };
  const runner = () => ({
    start: () => ({ id: 'b1', harness: 'claude', slot: { harness: 'claude', session: 's-1' } }),
    status: () => turns[Math.min(beat, turns.length - 1)],
    slotOf: () => ({ harness: 'claude', session: 's-1' }),
    usage: (b) => { assert.equal(b.slot.session, 's-1'); return readings[Math.min(beat, readings.length - 1)]; },
  });
  await runBodyHost({ client, runner, env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/run/loom/login/claude' }, hostKey: 'k', sleep: async () => { beat += 1; }, beats: turns.length + 1, idleS: 0, log: (m) => logs.push(m) });
  return { sent, logs };
}

test('the body host reports a body\'s usage when its turn ends, once per reading', async () => {
  const r1 = { windows: { '7d': 0.1 }, resets: { '7d': 1794265200 }, checked: 1793700000 };
  const r2 = { windows: { '7d': 0.12 }, resets: { '7d': 1794265200 }, checked: 1793700600 };
  // Started, working, idle (a turn over: sent), idle, working again (fed), idle (sent: a new reading), idle.
  const { sent, logs } = await host({ turns: ['working', 'working', 'idle', 'idle', 'working', 'idle', 'idle'], readings: [r1, r1, r1, r1, r2, r2, r2] });
  assert.deepEqual(sent, [{ harness: 'claude', reading: r1 }, { harness: 'claude', reading: r2 }]);
  assert.ok(logs.includes('usage from b1: claude 7d 10%'));
});

test('a turn over with no reading sends nothing; a refused report is logged, and the host goes on', async () => {
  const none = await host({ turns: ['working', 'idle', 'idle'], readings: [null] });
  assert.deepEqual(none.sent, []);
  const r = { windows: { '5h': 0.5 }, resets: {} };
  const refused = await host({ turns: ['working', 'idle'], readings: [r], usageFails: true });
  assert.deepEqual(refused.sent, []);
  assert.ok(refused.logs.some((l) => /^couldn't report b1's usage: no such house running/.test(l)));
  // A reading without a time is stamped when it's sent.
  const stamped = await host({ turns: ['working', 'idle'], readings: [r] });
  assert.equal(typeof stamped.sent[0].reading.checked, 'number');
});

test('loom runtime usage statusline: the same keeping as a CLI verb (for a body host that isn\'t the runtime\'s: shuttle\'s)', () => {
  const D = scratch('rt-sl-cli-');
  const env = { ...process.env, LOOM_RUNTIME_USAGE_DIR: join(D, 'usage') };
  delete env.LOOM_URL;
  const r = spawnSync(process.execPath, [join(here, '..', 'src', 'cli.mjs'), 'usage', 'statusline'], { input: JSON.stringify(STATUS), env, encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '5h 12% · 7d 10%');
  assert.deepEqual(keptReading(join(D, 'usage'), SESSION).windows, { '5h': 0.12, '7d': 0.1 });
});
