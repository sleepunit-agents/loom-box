import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';
import { acceptJobUsage, numericJob, mergeJobUsage, reportHouseJobs, reportBoxJobs } from '../src/box-job-usage.mjs';
import { api } from '../src/control.mjs';
import { load } from '../src/state.mjs';
const at = '2026-11-12T14:00:00.000Z';
const row = (session = 'session-a', n = 10) => ({ session, harness: 'claude', models: ['claude-test'], calls: 1, start: at, end: at, durationSeconds: 0, startingContext: n, averageContext: n, peakContext: n, lastContext: n, cacheWriteCalls: 0, cacheRead: 0, cacheCreate: 0, uncached: n, output: 2, totalTokens: n + 2, malformedLines: 0, counterResets: 0 });
const fx = { now: () => new Date(at) };
function setup() {
  const env = { HOME: scratch('box-usage-'), LOOM_BOX_LOCAL_NAME: 'local' };
  const owner = { kind: 'owner' }, agent = { kind: 'agent', agent: 'art' };
  assert.equal(api(env, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo: 'https://github.com/x/art.git' } }).status, 200);
  const h = api(env, fx, { caller: agent, path: 'up', body: { task: 'test' } }).body;
  return { env, owner, agent, h, box: { kind: 'piece', subject: 'local' } };
}
test('allowlist drops paths, native calls, prompt and extra fields; invalid numbers rejected', () => {
  assert.deepEqual(numericJob({ ...row(), file: '/private/path', content: 'PRIVATE', nativeCalls: 'SECRET' }), row());
  for (const bad of [{ calls: -1 }, { cacheRead: Infinity }, { totalTokens: 1 }, { models: ['model with prompt text'] }, { start: 'yesterday' }, { session: '../escape' }]) assert.throws(() => numericJob({ ...row(), ...bad }));
});
test('poll attributes to enrolled caller and recorded house, dedupes retries and stale copies', () => {
  const { env, box, h } = setup();
  const send = report => api(env, fx, { caller: box, path: 'poll', body: { jobUsage: report } });
  const report = { house: h.id, jobs: [{ ...row(), agent: 'mark', box: 'other', content: 'SECRET' }] };
  assert.equal(send(report).status, 200); assert.equal(send(report).status, 200);
  assert.equal(send({ house: h.id, jobs: [row('session-a', 1)] }).status, 200);
  const kept = Object.values(load(env).boxes.local.jobUsage);
  assert.equal(kept.length, 1); assert.equal(kept[0].agent, 'art'); assert.equal(kept[0].totalTokens, 12);
  assert.doesNotMatch(JSON.stringify(kept), /SECRET|other|mark/);
  assert.equal(send({ house: 'h-999', jobs: [row()] }).status, 403);
  assert.equal(send({ house: h.id, jobs: Array(101).fill(row()) }).status, 400);
  assert.equal(api(env, fx, { caller: { kind: 'piece', subject: 'unknown' }, path: 'poll', body: { jobUsage: report } }).status, 403);
});
test('a box cannot report a house assigned to another box; invalid batch is atomic', () => {
  const s = { boxes: { a: {}, b: {} }, houses: { 'h-1': { box: 'b', agent: 'art' } } };
  assert.throws(() => acceptJobUsage(s, 'a', { house: 'h-1', jobs: [row()] }, at));
  assert.throws(() => acceptJobUsage(s, 'b', { house: 'h-1', jobs: [row(), { ...row(), totalTokens: -1 }] }, at));
  assert.equal(s.boxes.b.jobUsage, undefined);
});
test('native scanner sends numbers in bounded chunks, skips symlinks and propagates refusal', async () => {
  const root = scratch('box-usage-native-'), dir = join(root, 'h-1');
  mkdirSync(join(dir, 'native', 'claude-projects'), { recursive: true });
  const transcript = session => JSON.stringify({ type: 'assistant', sessionId: session, timestamp: at, message: { id: 'msg', model: 'claude-test', content: 'PRIVATE PROMPT', usage: { input_tokens: 10, output_tokens: 2 } } });
  for (let i = 0; i < 101; i++) writeFileSync(join(dir, 'native', 'claude-projects', `${i}.jsonl`), transcript(`session-${i}`));
  const calls = [];
  await reportBoxJobs({ call: async (path, body) => { calls.push({ path, body }); } }, root);
  assert.deepEqual(calls.map(c => c.body.jobUsage.jobs.length), [100, 1]);
  assert.equal(calls[0].path, 'poll');
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE|claude-projects|file|content/);
  await assert.rejects(reportHouseJobs({ call: async () => { throw Error('offline'); } }, 'h-1', dir), /offline/);
  assert.match(readFileSync(join(dir, 'native', 'claude-projects', '0.jsonl'), 'utf8'), /PRIVATE/);
});
test('merged ranking filters before limiting, Central start day, same-box local deduplication', () => {
  const reports = [{ ...row(), agent: 'art', box: 'local', boxName: 'Art machine', source: 'box' }, { ...row('other', 50), agent: 'mark', box: 'b', boxName: 'wunder' }];
  const result = mergeJobUsage([row()], reports, { day: '2026-11-12', localBox: 'local', limit: 1, agent: 'art' });
  assert.equal(result.measuredJobs, 1); assert.equal(result.jobs[0].agent, 'art');
  assert.equal(mergeJobUsage([], reports, { day: 'all', box: 'wunder' }).jobs[0].session, 'other');
  assert.equal(mergeJobUsage([], reports, { day: '2026-11-11' }).jobs.length, 0);
  assert.throws(() => mergeJobUsage([], [], { timezone: 'bad' }));
});
test('API serves retained reports, limits agents to their own and refuses boxes', async () => {
  const { env, owner, agent, box, h } = setup();
  api(env, fx, { caller: box, path: 'poll', body: { jobUsage: { house: h.id, jobs: [row()] } } });
  const r = await api(env, fx, { caller: owner, path: 'job-usage', body: { day: 'all' } });
  assert.equal(r.status, 200); assert.equal(r.body.jobs[0].box, 'local'); assert.equal(r.body.jobs[0].totalTokens, 12);
  assert.equal((await api(env, fx, { caller: agent, path: 'job-usage', body: { day: 'all' } })).body.jobs.length, 1);
  assert.equal((await api(env, fx, { caller: { kind: 'agent', agent: 'mark' }, path: 'job-usage', body: { day: 'all' } })).body.jobs.length, 0);
  assert.equal((await api(env, fx, { caller: agent, path: 'job-usage', body: { agent: 'mark' } })).status, 403);
  assert.equal((await api(env, fx, { caller: box, path: 'job-usage', body: {} })).status, 403);
});

test('retained slot enriches session with conversation and preserves agent isolation', async () => {
  const { saveConv } = await import('../src/delivery.mjs');
  const { env, owner, h, box } = setup();
  saveConv(env, { conversation: 'cv-123456abcdef', agent: 'art', slot: { harness: 'claude', session: 'session-a' } });
  api(env, fx, { caller: box, path: 'poll', body: { jobUsage: { house: h.id, jobs: [row()] } } });
  const r = await api(env, fx, { caller: owner, path: 'job-usage', body: { day: 'all' } });
  assert.equal(r.body.jobs[0].conversation, 'cv-123456abcdef');
  assert.equal(r.body.jobs[0].currentRun, undefined);
});

test('default CLI routes filters to the runtime rather than scanning its own house', async () => {
  const { createServer } = await import('node:http');
  const { spawn, spawnSync } = await import('node:child_process');
  const dir = scratch('usage-cli-'), tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, 'test-token');
  let request;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    request = { url: req.url, body: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jobs: [{ box: 'remote-box' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, ['src/cli.mjs', 'usage', 'jobs', '--agent', 'art', '--box', 'wunder', '--day', 'all', '--limit', '1'], { cwd: new URL('..', import.meta.url), env: { ...process.env, LOOM_URL: `http://127.0.0.1:${server.address().port}/mcp`, LOOM_TOKEN_FILE: tokenFile } });
    let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr); assert.equal(JSON.parse(stdout).jobs[0].box, 'remote-box');
    const offline = spawnSync(process.execPath, ['src/cli.mjs', 'usage', 'jobs', '--root', dir, '--agent', 'art'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(offline.status, 2); assert.match(offline.stderr, /require the runtime report/);
    assert.match(request.url, /\/job-usage$/); assert.deepEqual(request.body, { agent: 'art', box: 'wunder', day: 'all', limit: 1 });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('standalone body owns local native history; local box name filters and current-run enriches', async () => {
  const { commitPreparedBody } = await import('../src/bodies.mjs');
  const { saveConv } = await import('../src/delivery.mjs');
  const { update } = await import('../src/state.mjs');
  const { env, agent } = setup();
  update(env, s => { s.boxes.local.name = 'Art machine'; });
  const file = join(env.HOME, '.claude', 'projects', 'session.jsonl');
  mkdirSync(join(env.HOME, '.claude', 'projects'), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: 'assistant', sessionId: 'session-a', timestamp: at, message: { id: 'msg', model: 'claude-test', usage: { input_tokens: 10, output_tokens: 2 } } }));
  const native = { harness: 'claude', session: 'session-a' };
  commitPreparedBody(env, { metadata: { agent: 'art', harness: 'claude', local: true, instance: 'a'.repeat(24) } }, { id: 'abcdef12', harness: 'claude', slot: native }, at);
  const query = () => api(env, fx, { caller: agent, path: 'job-usage', body: { box: 'Art machine', day: 'all' } });
  const standalone = await query(); assert.equal(standalone.body.jobs.length, 1);
  assert.equal(standalone.body.jobs[0].agent, 'art'); assert.equal(standalone.body.jobs[0].totalTokens, 12); assert.equal(standalone.body.jobs[0].boxName, 'Art machine');
  saveConv(env, { conversation: 'cv-123456abcdef', agent: 'art', body: 'claude:abcdef12', run: 'run-123456abcdef' });
  const associated = (await query()).body.jobs[0];
  assert.equal(associated.conversation, 'cv-123456abcdef'); assert.equal(associated.currentRun, 'run-123456abcdef');
});
