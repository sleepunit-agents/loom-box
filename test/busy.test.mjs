// Is a remote session mid-turn (t-1624): its --sdk-url process's CPU between two samples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUSY_TICKS_PER_S, sessionTicks, sessionsBusy } from '../src/busy.mjs';
import { agentReports } from '../src/ui.mjs';
import { scratch } from './scratch.mjs';

function proc(root, pid, ppid, argv, ticks = 0, start = 1000) {
  mkdirSync(join(root, String(pid), 'task', String(pid)), { recursive: true });
  writeFileSync(join(root, String(pid), 'cmdline'), argv.join('\0') + '\0');
  // comm with a space and a paren in it, as a real one can have; utime, stime, then starttime (field 22).
  writeFileSync(join(root, String(pid), 'stat'), `${pid} (a (b) c) S ${ppid} 0 0 0 0 0 0 0 0 0 ${ticks} 0 0 0 0 0 0 0 ${start} 0`);
  writeFileSync(join(root, String(pid), 'task', String(pid), 'children'), '');
  if (ppid !== 1) {
    const f = join(root, String(ppid), 'task', String(ppid), 'children');
    try { writeFileSync(f, `${readFileSync(f, 'utf-8')} ${pid}`); } catch { /* parent made later */ }
  }
}

test('a session is found by what runs it: a box session by its name, one in a house by the house', () => {
  const root = scratch('loom-box-proc-');
  proc(root, 10, 1, ['/home/art/.local/bin/claude', 'remote-control', '--name', 'art on loom (box session)']);
  proc(root, 11, 10, ['/x/versions/2.1.310', '--print', '--sdk-url', 'https://api.anthropic.com/v1/code/sessions/cse_1'], 500);
  proc(root, 20, 1, ['/usr/bin/conmon', '--api-version', '1', '-n', 'loom-house-h-45']);
  proc(root, 21, 20, ['/run/podman-init', '--']);
  proc(root, 22, 21, ['claude', 'remote-control', '--name', 'art-house']);
  proc(root, 23, 22, ['/x/versions/2.1.309', '--print', '--sdk-url', 'https://api.anthropic.com/v1/code/sessions/cse_2'], 70);
  proc(root, 30, 1, ['claude', '-p']);
  // The box session's MCP server started with it; a bash started minutes later is a tool running.
  proc(root, 12, 11, ['python3', 'spotify-mcp'], 0, 1050);
  assert.deepEqual(sessionTicks(root), { 'box:art on loom (box session)': { ticks: 500, tools: 0 }, 'house:h-45': { ticks: 70, tools: 0 } });
  proc(root, 13, 11, ['/bin/bash', '-c', 'sleep 60'], 0, 1000 + 300 * 100);
  assert.equal(sessionTicks(root)['box:art on loom (box session)'].tools, 1);
});

test('busy is CPU between two samples a minute apart; the first sample, or a stale one, says nothing', () => {
  const file = join(scratch('loom-box-cpu-'), 'session-cpu.json');
  const t = (ticks, tools = 0) => ({ ticks, tools });
  assert.deepEqual(sessionsBusy(file, { now: 0, ticks: { a: t(100), b: t(100) } }), {});
  const busy = sessionsBusy(file, { now: 60_000, ticks: { a: t(100 + 60 * BUSY_TICKS_PER_S), b: t(103), c: t(5) } });
  assert.deepEqual(busy, { a: true, b: false });
  assert.deepEqual(sessionsBusy(file, { now: 60_000 + 3_600_000, ticks: { a: t(9999) } }), {}, 'an hour on is no answer');
  assert.deepEqual(sessionsBusy(file, { now: 60_000 + 3_660_000, ticks: { a: t(9999, 1) } }), { a: true }, 'a tool running is working, even with no CPU');
});

test('Home\'s card: a busy remote session makes the agent working, and the reading says busy or idle', () => {
  const s = { boxes: { loom: { local: true } }, agents: { art: {} }, houses: { 'h-45': { id: 'h-45', agent: 'art', box: 'loom', service: 'remote', state: 'running' } },
    services: { 'art/remote': { agent: 'art', name: 'remote', want: 'up', house: 'h-45' } },
    remotes: { art: { box: 'loom', want: 'up', state: 'running', name: 'art on loom (box session)' } } };
  const idle = agentReports(s, Date.now(), { 'box:art on loom (box session)': false, 'house:h-45': false });
  assert.equal(idle.art.state, undefined);
  assert.equal(idle.art.readings.find((r) => r.label === 'Remote').value, 'box session on loom · idle · house session · idle');
  const busy = agentReports(s, Date.now(), { 'box:art on loom (box session)': true, 'house:h-45': false });
  assert.deepEqual([busy.art.state, busy.art.reason], ['working', 'in a remote session: box session on loom']);
  assert.equal(agentReports(s, Date.now(), {}).art.readings.find((r) => r.label === 'Remote').value, 'box session on loom · house session', 'unknown: no word');
});

test('another box reports its own sessions with its poll; loom shows them while the word is fresh', async () => {
  const { api } = await import('../src/control.mjs');
  const { reportedBusy } = await import('../src/ui.mjs');
  const home = scratch('loom-box-rb-');
  const env = { HOME: home, LOOM_BOX_HOME: join(home, 'state'), LOOM_BOX_LOCAL_NAME: 'loom' };
  let t = Date.parse('2026-10-28T01:00:00Z');
  const fx = { now: () => new Date(t), mint: () => 'loom_' + 'x'.repeat(40), revoke: () => {}, secret: () => '' };
  const owner = { kind: 'owner' };
  const id = api(env, fx, { caller: owner, path: 'add-box', body: { name: 'one' } }).body.box;
  const { load, update } = await import('../src/state.mjs');
  // h-9 runs on one, h-7 on loom; one's box session is placed on it.
  update(env, (s) => {
    s.houses['h-9'] = { id: 'h-9', agent: 'art', box: id, state: 'running' };
    s.houses['h-7'] = { id: 'h-7', agent: 'art', box: 'loom', state: 'running' };
    s.remotes = { art: { box: id, want: 'up', state: 'running', name: 'art on one (box session)' } };
  });
  const r = api(env, fx, { caller: { kind: 'piece', subject: id }, path: 'poll', body: { facts: [], sessions: { 'box:art on one (box session)': true, 'house:h-9': false, 'house:h-7': true, 'bad key': true, 'house:h-8': 'yes' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(reportedBusy(load(env), t), { 'box:art on one (box session)': true, 'house:h-9': false }, 'not h-7: that house is loom\'s');
  assert.deepEqual(reportedBusy(load(env), t + 10 * 60_000), {}, 'stale');
});
