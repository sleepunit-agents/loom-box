// The box runtime's part of each agent's card on loom's Home (t-1623): working while a task house runs, unavailable
// while a service it wants up is down, broken when one keeps failing; and its bridges, remote sessions and tasks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentReports, factWords, houseName, houseTask, manifest, plainNote, taskLine } from '../src/ui.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';

const now = Date.parse('2026-10-27T18:40:00Z');
const ago = (m) => new Date(now - m * 60_000).toISOString();
const state = (over = {}) => ({
  boxes: { loom: { local: true }, '7f9310-ae6ddf-977603-b257bf': { name: 'one' } },
  agents: { art: {}, mark: {} },
  houses: {
    'h-79': { id: 'h-79', agent: 'art', box: 'loom', service: 'discord', state: 'running', created: ago(600), updated: ago(600) },
    'h-103': { id: 'h-103', agent: 'art', box: 'loom', service: 'slack', state: 'running', created: ago(600), updated: ago(600) },
    'h-107': { id: 'h-107', agent: 'mark', box: 'loom', service: 'discord', state: 'running', created: ago(600), updated: ago(600) },
    'h-121': { id: 'h-121', agent: 'art', box: '7f9310-ae6ddf-977603-b257bf', state: 'running', created: ago(8), updated: ago(7), started: ago(7),
      task: JSON.stringify({ prompt: 'You are Art, waking from a self-set alarm in a fresh house (loom-box) (wake id w-7ffa48, kind wake, set 2026-10-27 08:37:39, note: t-1486: pond rollup (part a)). This session…' }) },
    'h-122': { id: 'h-122', agent: 'art', box: 'loom', state: 'starting', created: ago(1), updated: ago(1), task: 'check CI' },
  },
  services: {
    'art/discord': { agent: 'art', name: 'discord', want: 'up', house: 'h-79', restarts: 0 },
    'art/slack': { agent: 'art', name: 'slack', want: 'up', house: 'h-103', restarts: 0 },
    'mark/discord': { agent: 'mark', name: 'discord', want: 'up', house: 'h-107', restarts: 0 },
  },
  remotes: { art: { box: 'loom', want: 'up', state: 'running' } },
  ...over,
});

test('working: the running task, by its wake note, on its box (by name); bridges, remote and tasks as readings', () => {
  const r = agentReports(state(), now);
  assert.deepEqual(r.art.state, 'working');
  // In words: no wake id leading, no house id; the task id after the note's words.
  assert.equal(r.art.reason, 'Pond rollup (part a) (t-1486) · a house on one · 7m');
  assert.deepEqual(r.art.readings, [
    { label: 'Bridges', value: 'discord ✓  slack ✓', tone: 'ok' },
    { label: 'Remote', value: 'box session on loom' },
    { label: 'Tasks', value: '2 running', detail: 'Wake: pond rollup (part a) (t-1486) on one, check CI on loom' },
  ]);
  // Mark: up, not busy: the box runtime says nothing of his state, only his bridge.
  assert.deepEqual(r.mark, { readings: [{ label: 'Bridges', value: 'discord ✓', tone: 'ok' }] });
});

test('a service down past its grace is unavailable; one that keeps failing is broken; a fresh restart is neither', () => {
  const s = state();
  s.houses['h-107'] = { ...s.houses['h-107'], state: 'starting', updated: ago(2) };
  assert.equal(agentReports(s, now).mark.state, undefined, 'starting two minutes ago: still coming up');
  s.houses['h-107'].updated = ago(14);
  assert.deepEqual([agentReports(s, now).mark.state, agentReports(s, now).mark.reason], ['unavailable', 'discord is down']);
  assert.equal(agentReports(s, now).mark.readings[0].value, 'discord ✗');
  assert.equal(agentReports(s, now).mark.readings[0].tone, 'bad');
  s.houses['h-107'].state = 'failed';
  s.services['mark/discord'].restarts = 3;
  assert.deepEqual([agentReports(s, now).mark.state, agentReports(s, now).mark.reason], ['broken', 'discord keeps failing (3 restarts)']);
});

test('a task line falls back to the task itself, and loom\'s manifest carries the reports', () => {
  assert.equal(taskLine('check CI on loom#274'), 'check CI on loom#274');
  const home = scratch('loom-box-ar-');
  const m = manifest({ HOME: home, LOOM_BOX_HOME: join(home, 'state'), LOOM_BOX_LOCAL_NAME: 'loom' });
  assert.deepEqual(m.agents, {});
});

test('FYI for loom\'s Inbox: a box that joined this week, a task house that failed today (with its last line)', async () => {
  const { boxNotices } = await import('../src/ui.mjs');
  const s = state();
  s.boxes['7f9310-ae6ddf-977603-b257bf'].joined = ago(60);
  s.boxes['7f9310-ae6ddf-977603-b257bf'].facts = ['cpus:64', 'runtime:podman', 'gpu:nvidia-geforce-rtx-5090'];
  s.houses['h-121'] = { ...s.houses['h-121'], state: 'failed', updated: ago(5), log: 'working…\nFailed to authenticate: OAuth token revoked.\n' };
  s.houses['h-90'] = { id: 'h-90', agent: 'art', box: 'loom', state: 'failed', updated: ago(3 * 24 * 60), task: 'old' };
  const n = boxNotices(s, now);
  assert.deepEqual(n.map((x) => x.text), ['Art\'s house failed: pond rollup (part a) (t-1486)', 'one joined loom']);
  assert.equal(n[0].meta, 'Failed to authenticate: OAuth token revoked.');
  assert.equal(n[1].meta, '64 CPUs · NVIDIA GeForce RTX 5090');
});

test('doing (loom\'s summary card): each running task house by its note, a lane apart from a wake, and a remote session mid-turn', () => {
  const s = state();
  s.houses['h-130'] = { id: 'h-130', agent: 'art', box: 'loom', state: 'running', created: ago(3), started: ago(2),
    task: JSON.stringify({ prompt: 'You are Art, waking from a self-set alarm in a fresh house (loom-box) (wake id w-ab12cd, kind schedule, set 2026-10-27 08:00:00, note: schedule reflect: nightly retro). Go.' }) };
  s.remotes.art.name = 'art';
  const r = agentReports(s, now, { 'box:art': true });
  assert.deepEqual(r.art.doing, [
    { text: 'Reflect: nightly retro', kind: 'lane', where: 'a house on loom', since: ago(2) },   // newest first
    { text: 'Pond rollup (part a) (t-1486)', kind: 'task', where: 'a house on one', since: ago(7) },
    { text: 'A remote session', kind: 'session', where: 'box session on loom' },
  ]);
  // Starting isn't doing yet; an idle session isn't either; and Mark, with nothing going, has no doing at all.
  assert.ok(!r.art.doing.some((d) => d.text === 'check CI'));
  assert.ok(!r.art.doing.some((d) => /\b[hw]-[0-9a-f]+\b/.test(`${d.text} ${d.where}`)), 'no house or wake id in doing');
  assert.equal(agentReports(s, now, { 'box:art': false }).art.doing.length, 2);
  assert.equal(r.mark.doing, undefined);
});

test('a house\'s row says its task in a line: a lane or a wake by its note, a service as itself, never the raw prompt', () => {
  const s = state();
  const lane = { id: 'h-130', box: 'loom', task: JSON.stringify({ prompt: 'You are Art, waking from a self-set alarm in a fresh house (loom-box) (wake id w-ab12cd, kind schedule, set 2026-10-27 08:00:00, note: schedule reflect: nightly retro). Go.' }) };
  assert.equal(houseTask(lane, s), 'Reflect lane: nightly retro');
  assert.equal(houseTask(s.houses['h-121'], s), 'Wake: pond rollup (part a) (t-1486)');
  assert.equal(houseTask(s.houses['h-79'], s), 'Art\'s Discord bridge');
  assert.equal(houseTask(s.houses['h-122'], s), 'check CI');
  assert.ok(!houseTask(lane, s).includes('prompt'));
});

test('a house is named by what it is, never its id: a bridge, a house session, a wake by its note, a lane in words', () => {
  const wake = (note, kind = 'wake') => ({ id: 'h-398', agent: 'art', box: 'loom',
    task: JSON.stringify({ prompt: `You are Art, waking (wake id w-6b2931, kind ${kind}, set 2026-10-30 08:00:00, note: ${note}). Go.` }) });
  assert.equal(houseName({ id: 'h-390', agent: 'art', service: 'discord' }), 'Art\'s Discord bridge');
  assert.equal(houseName({ id: 'h-394', agent: 'art', service: 'remote' }), 'Art\'s house session');
  assert.equal(houseName({ id: 'h-395', agent: 'art', service: 'pond' }), 'Art\'s pond');
  assert.equal(houseName(wake('t-1689 cadence runner build round 1')), 'Wake: cadence runner build round 1 (t-1689)');
  // An approval's id is dropped from the clock's "unparked" line; the agent's note stays as written.
  assert.equal(houseName(wake('unparked (a-24e194de allowed): homelab DNS health check (Jonathan #homelab)')),
    'Wake: unparked (allowed): homelab DNS health check (Jonathan #homelab)');
  assert.equal(houseName(wake('schedule knowledge-verify', 'schedule')), 'Knowledge verify lane');
  assert.equal(plainNote('t-397 PR122 nudge-watch round 7'), 'PR122 nudge-watch round 7 (t-397)');
  assert.equal(plainNote('a note with no ids'), 'a note with no ids');
});

test('Home\'s doing line in words: no wake id leading, no house id, "just now" under a minute', () => {
  const s = state();
  s.houses['h-398'] = { id: 'h-398', agent: 'art', box: 'loom', state: 'running', created: ago(6), started: ago(5),
    task: JSON.stringify({ prompt: 'You are Art, waking (wake id w-6b2931, kind wake, set 2026-10-30 08:00:00, note: t-1689 cadence runner build round 1). Go.' }) };
  s.houses['h-121'].state = 'stopped';
  const r = agentReports(s, now);
  assert.equal(r.art.reason, 'Cadence runner build round 1 (t-1689) · a house on loom · 5m');
  assert.deepEqual(r.art.doing[0], { text: 'Cadence runner build round 1 (t-1689)', kind: 'task', where: 'a house on loom', since: ago(5) });
  s.houses['h-398'].started = new Date(now - 20_000).toISOString();
  assert.match(agentReports(s, now).art.reason, / · just now$/);
});

test('a box\'s facts in words: "Linux · x86-64 · 64 CPUs · 94 GB · NVIDIA GeForce RTX 5090"; an unknown one as it is', () => {
  assert.equal(['os:linux', 'arch:x86_64', 'cpus:64', 'mem:94g', 'gpu:nvidia-geforce-rtx-5090'].map(factWords).join(' · '),
    'Linux · x86-64 · 64 CPUs · 94 GB · NVIDIA GeForce RTX 5090');
  assert.equal(factWords('mem:16g'), '16 GB');
  assert.equal(factWords('jonathan-rig'), 'jonathan-rig');
});
