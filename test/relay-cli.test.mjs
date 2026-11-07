import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';

// Exercise the installed CLI entry point, not only runFor: the missing dispatch
// made a documented command print usage before it could reach its working API.
test('relay and relays CLI forward through the authenticated piece API and preserve failures', async (t) => {
  const calls = [];
  let answer = { exit: 0, stdout: 'r-12345678 art -> mark\n', stderr: '' };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answer));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const dir = scratch('relay-cli-');
  const token = join(dir, 'token'); writeFileSync(token, 'test-house-token');
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.mjs'), ...args], { env: { ...process.env, LOOM_RUNTIME_PIECE: 'runtime', LOOM_URL: `http://127.0.0.1:${server.address().port}/mcp`, LOOM_TOKEN_FILE: token } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exit) => resolve({ exit, stdout, stderr }));
  });
  assert.equal((await run(['relays', '--thread', 'r-12345678'])).exit, 0);
  assert.equal(calls[0].path, '/api/runtime/run');
  assert.equal(calls[0].authorization, 'Bearer test-house-token');
  assert.deepEqual(calls[0].body.argv, ['relays', '--thread', 'r-12345678']);
  answer = { exit: 1, stdout: '', stderr: 'relay: denied\n' };
  const failed = await run(['relay', '--to', 'art', '--say', 'review please']);
  assert.equal(failed.exit, 1);
  assert.match(failed.stderr, /relay: denied/);
  assert.deepEqual(calls[1].body.argv, ['relay', '--to', 'art', '--say', 'review please']);
});

test('place CLI forwards its own conversation and proof in the call\'s body, and needs a conversation (t-1745)', async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    calls.push({ path: req.url, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ exit: 0, stdout: '{"venue":"slack"}\n', stderr: '' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const dir = scratch('place-cli-');
  const token = join(dir, 'token'); writeFileSync(token, 'test-house-token');
  const run = (extra) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.mjs'), 'place'], { env: { ...process.env, LOOM_RUNTIME_PIECE: 'runtime', LOOM_URL: `http://127.0.0.1:${server.address().port}/mcp`, LOOM_TOKEN_FILE: token, LOOM_RUNTIME_KEYS_DIR: dir, LOOM_BODY_KEY: 'k'.repeat(48), CLAUDE_CODE_SESSION_ID: 'sess-1234', ...extra } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exit) => resolve({ exit, stdout, stderr }));
  });
  const ok = await run({ LOOM_BODY_CONVERSATION: 'cv-0123456789ab' });
  assert.equal(ok.exit, 0, ok.stderr);
  assert.equal(ok.stdout, '{"venue":"slack"}\n');
  assert.equal(calls[0].path, '/api/runtime/run');
  assert.deepEqual(calls[0].body.argv, ['place', '--conversation', 'cv-0123456789ab']);
  assert.equal(calls[0].body.session, 'sess-1234');
  assert.equal(typeof calls[0].body.key, 'string', 'the run key rides in the body, never argv');
  const none = await run({ LOOM_BODY_CONVERSATION: '' });
  assert.equal(none.exit, 2);
  assert.equal(calls.length, 1, 'no conversation: nothing asked');
});
