import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';

test('continuation CLI carries holder proof on issue/enqueue/status and preserves HTTP refusal', async (t) => {
  const calls = []; let status = 200;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const b of req) text += b;
    calls.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(text) });
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(status === 200 ? { state: 'pending' } : { error: 'wrong holder' }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const dir = scratch('continuation-cli-'), token = join(dir, 'token'); writeFileSync(token, 'house-token');
  const run = (action) => new Promise(resolve => {
    const p = spawn(process.execPath, [join(import.meta.dirname, '../src/cli.mjs'), 'continuation', action, '--handle', `cont-${'a'.repeat(64)}`, '--id', 'final'], { env: { ...process.env, LOOM_RUNTIME_PIECE: 'runtime', LOOM_URL: `http://127.0.0.1:${server.address().port}/mcp`, LOOM_TOKEN_FILE: token, LOOM_RUNTIME_KEYS_DIR: dir, LOOM_BODY_CONVERSATION: 'cv-0123456789ab', LOOM_BODY_KEY: 'k'.repeat(48), CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: 'codex-session' } });
    let stderr = ''; p.stderr.on('data', b => stderr += b); p.stdout.resume(); p.stdin.end('report');
    p.once('close', exit => resolve({ exit, stderr }));
  });
  for (const action of ['issue', 'enqueue', 'status']) {
    assert.equal((await run(action)).exit, 0);
    const c = calls.at(-1);
    assert.equal(c.path, `/api/runtime/continuation-${action}`); assert.equal(c.auth, 'Bearer house-token');
    assert.equal(c.body.session, 'codex-session'); assert.equal(c.body.key, 'k'.repeat(48));
    assert.equal(c.body.conversation, 'cv-0123456789ab');
    assert.equal(c.body.text, action === 'enqueue' ? 'report' : undefined);
  }
  status = 403; const refusal = await run('status'); assert.notEqual(refusal.exit, 0); assert.match(refusal.stderr, /wrong holder/);
});
