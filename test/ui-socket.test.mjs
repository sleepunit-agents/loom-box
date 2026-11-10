// The manifest from the delivery service over a local socket (ui-socket.mjs, t-2114), and the store reads it keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { mkdtempSync, statSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveManifest, socketPath, stablePrint, VERSION, STALE_MS, ACTIVE_MS, MAX_UNREAD } from '../src/ui-socket.mjs';
import { keptReads, memStore, storeSignature } from '../src/store.mjs';

const home = () => mkdtempSync(join(tmpdir(), 'uisock-'));
const quiet = () => {};

/** One connection: send lines, read the answers (or see it closed). */
function client(path) {
  const c = createConnection(path);
  c.setEncoding('utf-8');
  let buf = '';
  const waiting = [];
  let closed = false;
  c.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); waiting.shift()?.(JSON.parse(l)); } });
  c.on('close', () => { closed = true; for (const w of waiting.splice(0)) w(null); });
  c.on('error', () => {});
  return {
    ask: (line) => new Promise((resolve) => { waiting.push(resolve); c.write(line + '\n'); }),
    closed: () => closed,
    end: () => c.destroy(),
    ready: new Promise((r) => c.once('connect', r)),
  };
}

test('answers the manifest from memory, 0600 in a 0700 dir, with the version it runs', async () => {
  const h = home();
  const env = { LOOM_PIECE_HOME: h };
  let n = 0;
  const s = await serveManifest(env, { compute: () => `{"v":2,"n":${++n}}\n`, changed: async () => {}, log: quiet });
  assert.ok(s);
  assert.equal(s.path, join(h, 'run', 'ui.sock'));
  assert.equal(statSync(join(h, 'run')).mode & 0o777, 0o700);
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
  const c = client(s.path);
  await c.ready;
  const a = await c.ask(JSON.stringify({ id: 1, op: 'manifest', version: VERSION }));
  assert.deepEqual({ ...a, at: 0 }, { id: 1, ok: true, version: VERSION, at: 0, stdout: '{"v":2,"n":1}\n' });
  // Asked again at once: the same answer, not computed again.
  const b = await c.ask(JSON.stringify({ id: 2, op: 'manifest', version: VERSION }));
  assert.equal(b.id, 2);
  assert.equal(b.stdout, '{"v":2,"n":1}\n');
  assert.equal(n, 1);
  c.end();
  await s.close();
});

test('anything but a manifest request closes the connection, unanswered', async () => {
  const h = home();
  const s = await serveManifest({ LOOM_PIECE_HOME: h }, { compute: () => '{}\n', changed: async () => {}, log: quiet });
  for (const bad of ['nope', JSON.stringify({ id: 1, op: 'page' }), JSON.stringify({ id: 'x', op: 'manifest' }), JSON.stringify({ id: -1, op: 'manifest' }), JSON.stringify({ id: 1, op: 'manifest', grant: 'g' }).replace('"manifest"', '"api"')]) {
    const c = client(s.path);
    await c.ready;
    assert.equal(await c.ask(bad), null, bad);
    assert.ok(c.closed());
  }
  // A line past the limit with no newline: closed too.
  const c = createConnection(s.path);
  await new Promise((r) => c.once('connect', r));
  const closed = new Promise((r) => c.once('close', r));
  c.on('error', () => {});
  c.write('x'.repeat(4096));
  await closed;
  await s.close();
});

test('an answer past STALE_MS is computed again; a tick computes while loom asks and says when it moved', async () => {
  const h = home();
  let t = 1_000_000;
  let body = { v: 2, agents: { art: { readings: [], idle: { observedAt: 'a' } } } };
  let n = 0;
  const moved = [];
  const s = await serveManifest({ LOOM_PIECE_HOME: h }, { compute: () => { n++; return JSON.stringify(body) + '\n'; }, changed: async () => { moved.push(t); }, now: () => t, log: quiet });
  // Nobody asked yet: a tick computes nothing, and says loom isn't asking (the heartbeat stays on).
  assert.equal(await s.tick(), false);
  assert.equal(n, 0);
  const c = client(s.path);
  await c.ready;
  await c.ask(JSON.stringify({ id: 1, op: 'manifest', version: VERSION }));
  assert.equal(n, 1);
  t += STALE_MS;
  await c.ask(JSON.stringify({ id: 2, op: 'manifest', version: VERSION }));
  assert.equal(n, 2);
  // Only the idle clock moved: computed, not "moved".
  body = { v: 2, agents: { art: { readings: [], idle: { observedAt: 'b' } } } };
  assert.equal(await s.tick(), true);
  assert.equal(n, 3);
  assert.deepEqual(moved, []);
  // Something real moved: core hears.
  body = { v: 2, agents: { art: { readings: [], doing: [{ text: 'x' }] } } };
  assert.equal(await s.tick(), true);
  assert.equal(moved.length, 1);
  // Two minutes without loom asking: ticks stop computing, and the heartbeat comes back.
  t += ACTIVE_MS;
  assert.equal(await s.tick(), false);
  assert.equal(n, 4);
  c.end();
  await s.close();
});

test('no socket without a piece home, past the path limit, over a symlinked dir, or while another answers', async () => {
  assert.equal(socketPath({}), null);
  assert.equal(socketPath({ LOOM_PIECE_HOME: 'relative' }), null);
  assert.equal(socketPath({ LOOM_PIECE_HOME: `/${'x'.repeat(120)}` }), null);
  assert.equal(await serveManifest({}, { compute: () => '', changed: async () => {}, log: quiet }), null);
  const h = home();
  mkdirSync(join(h, 'elsewhere'));
  symlinkSync(join(h, 'elsewhere'), join(h, 'run'));
  assert.equal(await serveManifest({ LOOM_PIECE_HOME: h }, { compute: () => '', changed: async () => {}, log: quiet }), null);
  const h2 = home();
  const first = await serveManifest({ LOOM_PIECE_HOME: h2 }, { compute: () => '{}\n', changed: async () => {}, log: quiet });
  assert.ok(first);
  assert.equal(await serveManifest({ LOOM_PIECE_HOME: h2 }, { compute: () => '{}\n', changed: async () => {}, log: quiet }), null);
  await first.close();
  // A file in the way, not a socket: left alone.
  const h3 = home();
  mkdirSync(join(h3, 'run'), { mode: 0o700 });
  writeFileSync(join(h3, 'run', 'ui.sock'), 'x');
  assert.equal(await serveManifest({ LOOM_PIECE_HOME: h3 }, { compute: () => '', changed: async () => {}, log: quiet }), null);
});

test('a stale socket file left by a dead service is replaced', async () => {
  const h = home();
  const a = await serveManifest({ LOOM_PIECE_HOME: h }, { compute: () => '{}\n', changed: async () => {}, log: quiet });
  // Closed without unlinking, as a killed process leaves it.
  await new Promise((r) => { a.close().then(r); });
  const b = await serveManifest({ LOOM_PIECE_HOME: h }, { compute: () => '{"b":1}\n', changed: async () => {}, log: quiet });
  assert.ok(b);
  const c = client(b.path);
  await c.ready;
  assert.equal((await c.ask(JSON.stringify({ id: 7, op: 'manifest' }))).stdout, '{"b":1}\n');
  c.end();
  await b.close();
});

test('stablePrint leaves out only the idle clock', () => {
  assert.equal(stablePrint('{"agents":{"a":{"idle":{"observedAt":"1"},"x":1}}}'), '{"agents":{"a":{"x":1}}}');
  assert.equal(stablePrint('not json'), 'not json');
});

test('keptReads: one read per signature, a write or a moved store reads again, no signature keeps nothing', () => {
  const st = memStore();
  st.put('gate-proposals', 'art.1', { agent: 'art' });
  let reads = 0;
  const counted = { piece: 'runtime', get: (c, k) => { reads++; return st.get(c, k); }, list: (c, p) => { reads++; return st.list(c, p); }, put: (...a) => st.put(...a), del: (...a) => st.del(...a) };
  let sig = 's1';
  let t = 0;
  const k = keptReads(counted, { signature: () => sig, now: () => t });
  assert.equal(k.list('gate-proposals').length, 1);
  assert.equal(k.list('gate-proposals').length, 1);
  assert.equal(reads, 1);
  // A caller that changes what it got back changes only its copy.
  k.list('gate-proposals')[0].doc.agent = 'mark';
  assert.equal(k.list('gate-proposals')[0].doc.agent, 'art');
  sig = 's2';
  k.list('gate-proposals');
  assert.equal(reads, 2);
  k.put('gate-proposals', 'art.2', { agent: 'art' });
  assert.equal(k.list('gate-proposals').length, 2);
  assert.equal(reads, 3);
  t += 30_000;
  k.list('gate-proposals');
  assert.equal(reads, 4);
  sig = '';
  k.list('gate-proposals');
  k.list('gate-proposals');
  assert.equal(reads, 6);
});

test('storeSignature moves with the store files and is empty without them', () => {
  const h = home();
  const env = { LOOM_HOME: h, LOOM_PIECE_NAME: 'runtime' };
  assert.equal(storeSignature(env), '');
  mkdirSync(join(h, 'commons', 'stores'), { recursive: true });
  writeFileSync(join(h, 'commons', 'stores', 'runtime.db'), 'a');
  const a = storeSignature(env);
  assert.ok(a);
  writeFileSync(join(h, 'commons', 'stores', 'runtime.db-wal'), 'ab');
  assert.notEqual(storeSignature(env), a);
});

test('keptReads keeps nothing read while a write landed (the signature moved during the read)', () => {
  const st = memStore();
  let sig = 's1';
  let reads = 0;
  const racing = { piece: 'runtime', list: (c, p) => { reads++; sig = `s${reads + 1}`; return st.list(c, p); }, get: () => null, put: () => 1, del: () => {} };
  const k = keptReads(racing, { signature: () => sig, now: () => 0 });
  k.list('gate-proposals');
  k.list('gate-proposals');
  assert.equal(reads, 2);
});

test('since: an answer older than core\'s last move is computed again; an ask for another version keeps the heartbeat', async () => {
  const h = home();
  let t = 1_000_000;
  let n = 0;
  const s = await serveManifest({ LOOM_PIECE_HOME: h }, { compute: () => `{"n":${++n}}\n`, changed: async () => {}, now: () => t, log: quiet });
  const c = client(s.path);
  await c.ready;
  // Another version's ask: answered (core will refuse it) but not loom reading this socket.
  await c.ask(JSON.stringify({ id: 1, op: 'manifest', version: '/old/cli.mjs@1' }));
  assert.equal(await s.tick(), false);
  t += 10;
  const a = await c.ask(JSON.stringify({ id: 2, op: 'manifest', version: VERSION, since: t - 5 }));
  assert.equal(a.stdout, '{"n":2}\n');
  assert.equal((await c.ask(JSON.stringify({ id: 3, op: 'manifest', version: VERSION, since: t - 5 }))).stdout, '{"n":2}\n');
  assert.equal(await s.tick(), true);
  c.end();
  await s.close();
});

test('a client that asks and never reads is cut off before the service holds MAX_UNREAD of answers', async () => {
  const h = home();
  const big = `{"x":"${'y'.repeat(256 * 1024)}"}\n`;
  const s = await serveManifest({ LOOM_PIECE_HOME: h }, { compute: () => big, changed: async () => {}, log: quiet });
  const c = createConnection(s.path);
  await new Promise((r) => c.once('connect', r));
  c.on('error', () => {});
  const closed = new Promise((r) => c.once('close', r));
  c.write(`${JSON.stringify({ id: 1, op: 'manifest', version: VERSION })}\n`.repeat(Math.ceil(4 * MAX_UNREAD / big.length) + 64));
  // Unread, a socket hears no end: once it's had time to fill, read (and drop) what came, then the server's close shows.
  await new Promise((r) => setTimeout(r, 300));
  let got = 0;
  c.on('data', (d) => { got += d.length; });
  let timer;
  await Promise.race([closed, new Promise((_, no) => { timer = setTimeout(() => no(new Error('not cut off')), 5000); })]);
  clearTimeout(timer);
  assert.ok(got < 4 * MAX_UNREAD);
  await s.close();
});
