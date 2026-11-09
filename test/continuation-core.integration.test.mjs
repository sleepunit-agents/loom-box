import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { world } from './delivery-world.mjs';
import { continuationCall, deliver, deliveryDir, handOverWake, loadConv } from '../src/delivery.mjs';

// Run with CONTINUATION_CORE=/path/to/built/loom npm test. CI without the
// companion checkout reports a skip rather than substituting a fake core.
test('real core accepts runtime outbox, SIGKILL before receipt, fresh runtime retries one visible reply', { skip: !process.env.CONTINUATION_CORE, timeout: 45000 }, async (t) => {
  const w = world();
  const coreHome = join(w.env.HOME, 'real-core'); mkdirSync(coreHome);
  const server = fork(new URL('./fixtures/continuation-core.mjs', import.meta.url), [], { env: { ...process.env, LOOM_HOME: coreHome }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; server.stderr.on('data', b => errors += b);
  t.after(() => server.kill('SIGKILL'));
  const setup = await Promise.race([once(server, 'message').then(([x]) => x), once(server, 'exit').then(([c]) => { throw new Error(`core exited ${c}: ${errors}`); })]);
  w.env.LOOM_HOME = coreHome;
  const source = await deliver(w.env, w.msg(setup.place, 'owner', { source: 'loom', venue: 'loom', place: setup.place, from: { kind: 'person', slug: 'jonathan' } }), w.o);
  const args = (cv) => { const c = loadConv(w.env, cv); return { conversation: cv, key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(cv) }; };
  const grant = continuationCall(w.env, { ...args(source.conversation), action: 'issue' }, w.o);
  const firing = w.msg('wake:w-abcdef', 'follow up', { source: 'clock', venue: 'wake', id: 'w-abcdef', kind: 'wake', from: { kind: 'schedule' }, continuation: { handle: grant.handle, wake: 'w-abcdef' } });
  handOverWake(w.env, { agent: 'art', place: firing.place, id: firing.id, for: 'owner' });
  const child = await deliver(w.env, firing, w.o);
  const q = { ...args(child.conversation), handle: grant.handle, id: 'final' };
  const receipt = continuationCall(w.env, { ...q, action: 'enqueue', text: 'process crash report' }, w.o);
  let accepted; const acceptance = new Promise(r => { accepted = r; });
  let hold = true; const payloads = []; const answers = [];
  const proxy = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    payloads.push(JSON.parse(body));
    const answer = await fetch(`http://127.0.0.1:${setup.port}${req.url}`, { method: req.method, headers: { authorization: `Bearer ${setup.token}`, 'content-type': 'application/json' }, body });
    const text = await answer.text(); answers.push({ status: answer.status, text });
    if (hold) { accepted(); return; }
    res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(text);
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  writeFileSync(w.env.LOOM_RUNTIME_TOKEN_FILE, setup.token);
  const worker = (at = '2026-11-03T00:00:00Z') => spawn(process.execPath, ['--input-type=module', '-e', `
    import { drainContinuations } from './src/delivery.mjs';
    import { testSealer } from './test/delivery-world.mjs';
    await drainContinuations(JSON.parse(process.env.BENCH_ENV), { sealer: testSealer, now: () => new Date(${JSON.stringify(at)}), venues: () => ({ loom: { adapter: 'core' } }) });
  `], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, BENCH_ENV: JSON.stringify({ ...w.env, LOOM_RUNTIME_LOOM_URL: `http://127.0.0.1:${proxy.address().port}/mcp` }) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const first = worker(); t.after(() => first.kill('SIGKILL'));
  await acceptance;
  assert.equal(answers[0].status, 200, answers[0].text);
  const ended = once(first, 'exit'); first.kill('SIGKILL'); assert.equal((await ended)[1], 'SIGKILL');
  assert.equal(continuationCall(w.env, { ...q, action: 'status' }, w.o).state, 'pending');
  // Restart past the persisted retry time; same ref, run and optional on.
  hold = false;
  const second = worker('2026-11-04T00:00:00Z');
  t.after(() => second.kill('SIGKILL'));
  let secondErr = ''; second.stderr.on('data', b => secondErr += b);
  assert.equal((await once(second, 'exit'))[0], 0, secondErr);
  assert.deepEqual(payloads[1], payloads[0]); assert.deepEqual(answers[1], answers[0]);
  assert.equal(continuationCall(w.env, { ...q, action: 'status' }, w.o).state, 'delivered');
  // Full runtime boundary negatives: a borrowed session never queues, and
  // source reset after a valid queue prevents any real HTTP attempt.
  assert.throws(() => continuationCall(w.env, { ...q, action: 'enqueue', session: 'borrowed', id: 'stolen', text: 'no' }, w.o), /session/);
  continuationCall(w.env, { ...q, action: 'enqueue', id: 'reset', text: 'must never reach core' }, w.o);
  const changed = loadConv(w.env, source.conversation); changed.actsFor.reset = 'after-queue';
  writeFileSync(join(deliveryDir(w.env), 'conversations', `${source.conversation}.json`), JSON.stringify(changed));
  const negative = worker('2026-11-05T00:00:00Z'); t.after(() => negative.kill('SIGKILL'));
  assert.equal((await once(negative, 'exit'))[0], 0);
  assert.equal(payloads.length, 2);
  assert.throws(() => continuationCall(w.env, { ...q, action: 'status', id: 'reset' }, w.o), /reset|changed/);
  const { default: Sqlite } = await import(`${process.env.CONTINUATION_CORE}/node_modules/better-sqlite3/lib/index.js`);
  const db = new Sqlite(join(coreHome, 'comms.db'), { readonly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comms_messages WHERE id = ?').get(receipt.ref).n, 1); } finally { db.close(); }
});
