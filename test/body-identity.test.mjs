// t-2053: a body's identity is its own conversation's, never a reused session's environment.
//
// Claude Code's daemon keeps pre-started `bg-spare` sessions and hands one to the next `claude --bg`. A spare keeps the
// environment it was started under, so a body briefed for conversation B can run with A's LOOM_BODY_CONVERSATION and
// LOOM_BODY_KEY (observed live in run-ee1166751028 and in this fix's own body). Its harness session id
// (CLAUDE_CODE_SESSION_ID) is its own. These tests hold: the house says which conversation each session holds, the
// body's CLI reads that and never the stale environment, and the runtime takes no key without its session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyConversation, bodyKeyFor, keepKey, keepSession, runBodyHost } from '../src/bodyhost.mjs';
import { bodyPrincipal, deliver, loadConv, send } from '../src/delivery.mjs';
import { cvOf, world } from './delivery-world.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const A = 'cv-aaaaaaaaaaaa', B = 'cv-bbbbbbbbbbbb';
const home = () => mkdtempSync(join(tmpdir(), 'rt-identity-'));

test('a session the house says holds B reads B, whatever its environment says', () => {
  const HOME = home();
  keepSession({ HOME }, 'sess-bbbb', B);
  const env = { HOME, LOOM_BODY_CONVERSATION: A, LOOM_BODY_KEY: 'key-a', CLAUDE_CODE_SESSION_ID: 'sess-bbbb' };
  assert.equal(bodyConversation(env, { sleep: () => assert.fail('no wait when its own is known') }), B);
});

test('a reused session whose environment names another session\'s conversation waits for its own, never answers with it', () => {
  const HOME = home();
  keepSession({ HOME }, 'sess-aaaa', A);       // the spare's first body held A
  const env = { HOME, LOOM_BODY_CONVERSATION: A, LOOM_BODY_KEY: 'key-a', CLAUDE_CODE_SESSION_ID: 'sess-bbbb' };
  // Nothing comes for it: no conversation (refused), never A's.
  let waited = 0;
  assert.equal(bodyConversation(env, { waitMs: 1000, sleep: (ms) => { waited += ms; } }), undefined);
  assert.equal(waited, 1000);
  // Its host writes its own while it waits: B.
  let n = 0;
  assert.equal(bodyConversation(env, { waitMs: 15000, sleep: () => { if (++n === 3) keepSession({ HOME }, 'sess-bbbb', B); } }), B);
  assert.equal(n, 3);
});

test('with no word from its house, a body\'s environment stands; with no session, too', () => {
  const HOME = home();
  assert.equal(bodyConversation({ HOME, LOOM_BODY_CONVERSATION: A, CLAUDE_CODE_SESSION_ID: 'sess-1234' }, { sleep: () => assert.fail('no wait') }), A);
  assert.equal(bodyConversation({ HOME, LOOM_BODY_CONVERSATION: A }), A);
  assert.equal(bodyConversation({ HOME, LOOM_BODY_CONVERSATION: 'nope' }), undefined);
  keepSession({ HOME }, 'sess-1234', A);
  assert.equal(bodyConversation({ HOME, LOOM_BODY_CONVERSATION: A, CLAUDE_CODE_SESSION_ID: 'sess-1234' }), A);
});

test('the environment\'s key is never handed out as another conversation\'s', () => {
  const HOME = home();
  const env = { HOME, LOOM_BODY_CONVERSATION: A, LOOM_BODY_KEY: 'key-a' };
  assert.equal(bodyKeyFor(env, A), 'key-a');
  assert.equal(bodyKeyFor(env, B), undefined, 'A\'s key is no proof for B');
  keepKey(env, B, 'key-b');
  assert.equal(bodyKeyFor(env, B), 'key-b');
});

/** A house host serving two starts in turn, with one environment for both, as a daemon's reused spare would. */
async function hostTwo(HOME) {
  const started = [];
  const runner = {
    start(o) { const n = started.length; const id = ['aaaa1111', 'bbbb2222'][n]; started.push({ id, env: o.env }); return { id, harness: 'claude', slot: { harness: 'claude', session: `sess-${id}` } }; },
    status: () => 'working', slotOf: (b) => ({ harness: 'claude', session: `sess-${b.id}` }),
  };
  const asks = [
    { req: { r1: { harness: 'claude', key: 'key-a', conversation: A, brief: 'for A' } } },
    { req: { r2: { harness: 'claude', key: 'key-b', conversation: B, brief: 'for B' } } },
    { exit: true },
  ];
  let i = 0;
  const client = async () => asks[Math.min(i++, asks.length - 1)];
  await runBodyHost({ client, runner: () => runner, env: { HOME, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/run/loom/login/claude' }, hostKey: 'boot', sleep: async () => {}, beats: 10, idleS: 0 });
  return started;
}

function principalFromBody(env, port) {
  return new Promise((ok) => execFile(process.execPath, [join(ROOT, 'src/cli.mjs'), 'principal'], {
    env: { PATH: process.env.PATH, LOOM_URL: `http://127.0.0.1:${port}/mcp`, LOOM_RUNTIME_PIECE: 'runtime', ...env },
  }, (err, stdout, stderr) => ok({ code: err ? err.code : 0, stdout, stderr })));
}

test('a body briefed for B, in a reused session that kept A\'s environment, asks as B with B\'s key and its own session', async () => {
  const HOME = home();
  const started = await hostTwo(HOME);
  // The host handed each start its own identity; it's the harness's reuse that loses it.
  assert.deepEqual(started.map((s) => [s.env.LOOM_BODY_CONVERSATION, s.env.LOOM_BODY_KEY]), [[A, 'key-a'], [B, 'key-b']]);
  writeFileSync(join(HOME, 'tok'), 'housetoken\n');
  const seen = [];
  const server = createServer((req, res) => { let b = ''; req.on('data', (x) => { b += x; }); req.on('end', () => { seen.push(JSON.parse(b)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, conversation: JSON.parse(b).conversation, owner: true, statement: 'a.b' })); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    // B's body: the spare's environment is A's (its first claim), its session is its own.
    const r = await principalFromBody({ HOME, LOOM_TOKEN_FILE: join(HOME, 'tok'), LOOM_BODY_CONVERSATION: A, LOOM_BODY_KEY: 'key-a', CLAUDE_CODE_SESSION_ID: 'sess-bbbb2222' }, server.address().port);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(seen, [{ conversation: B, key: 'key-b', session: 'sess-bbbb2222' }]);
    // A's body still reads A.
    await principalFromBody({ HOME, LOOM_TOKEN_FILE: join(HOME, 'tok'), LOOM_BODY_CONVERSATION: A, LOOM_BODY_KEY: 'key-a', CLAUDE_CODE_SESSION_ID: 'sess-aaaa1111' }, server.address().port);
    assert.deepEqual(seen[1], { conversation: A, key: 'key-a', session: 'sess-aaaa1111' });
  } finally { server.close(); }
});

test('a reused spare can\'t act as the previous conversation: the runtime takes no key without its own session', async () => {
  const w = world();
  await deliver(w.env, w.msg('dm:A', 'one'), w.o);
  await deliver(w.env, w.msg('dm:B', 'two'), w.o);
  const ca = loadConv(w.env, cvOf('art', 'slack', 'dm:A'));
  const cb = loadConv(w.env, cvOf('art', 'slack', 'dm:B'));
  const keyA = w.runner.envs[ca.body.split(':')[1]].LOOM_BODY_KEY;
  // B's body (another session), holding A's key from its stale environment: refused for A.
  const asA = bodyPrincipal(w.env, { conversation: ca.conversation, key: keyA, session: w.sessionFor(cb.conversation) }, w.o);
  assert.equal(asA.ok, false);
  assert.match(asA.reason, /another session/);
  // A key with no session the runner can name: refused (it used to pass on the key alone).
  const blind = { ...w.o, runner: () => ({ ...w.runner, slotOf: () => null }) };
  // Nor kept on its body's record (a house's host hasn't reported it yet).
  const recFile = join(w.env.LOOM_BOX_DATA, 'bodies', `${ca.body.replace(':', '-')}.json`);
  const rec = JSON.parse(readFileSync(recFile, 'utf-8'));
  delete rec.slot;
  writeFileSync(recFile, JSON.stringify(rec));
  const noSession = await send(w.env, { conversation: ca.conversation, text: 'as A', key: keyA, session: 'sess-anything' }, blind);
  assert.equal(noSession.ok, false);
  assert.match(noSession.reason, /session can't be told yet/);
  assert.match(bodyPrincipal(w.env, { conversation: ca.conversation, key: keyA, session: 'sess-anything' }, blind).reason, /session can't be told yet/);
  rec.slot = { harness: 'claude', session: w.sessionFor(ca.conversation) };
  writeFileSync(recFile, JSON.stringify(rec));
  // A's own body, its own session: proved, and for the owner its conversation was the owner's.
  const own = bodyPrincipal(w.env, { conversation: ca.conversation, key: keyA, session: w.sessionFor(ca.conversation) }, w.o);
  assert.equal(own.ok, true, own.reason);
});

test('an owner\'s spawn, its body in a reused session with another conversation\'s environment, still proves itself the owner\'s', async () => {
  const { spawnCall } = await import('../src/spawn.mjs');
  const w = world();
  await deliver(w.env, w.msg('dm:A', 'one'), w.o);             // the first body: the spare's environment is its
  const first = loadConv(w.env, cvOf('art', 'slack', 'dm:A'));
  const child = await spawnCall(w.env, { kind: 'owner', agents: ['art'] }, { agent: 'art', brief: 'owner work' }, w.o);
  const c = loadConv(w.env, child.handle);
  assert.ok(c.body, 'the spawn has a body');
  const stale = w.runner.envs[first.body.split(':')[1]];
  const keepsA = { HOME: w.env.HOME, LOOM_BODY_CONVERSATION: stale.LOOM_BODY_CONVERSATION, LOOM_BODY_KEY: stale.LOOM_BODY_KEY, CLAUDE_CODE_SESSION_ID: w.sessionFor(c.conversation) };
  // What it asked as before this fix: A's conversation, as its own session. Refused, so its merges asked.
  assert.equal(bodyPrincipal(w.env, { conversation: keepsA.LOOM_BODY_CONVERSATION, key: bodyKeyFor(keepsA, keepsA.LOOM_BODY_CONVERSATION), session: keepsA.CLAUDE_CODE_SESSION_ID }, w.o).ok, false);
  // Its house says which conversation its session holds (bodyhost.mjs): it asks as the spawn, the owner's.
  keepKey(keepsA, c.conversation, w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY);
  keepSession(keepsA, keepsA.CLAUDE_CODE_SESSION_ID, c.conversation);
  const cv = bodyConversation(keepsA);
  assert.equal(cv, c.conversation);
  const p = bodyPrincipal(w.env, { conversation: cv, key: bodyKeyFor(keepsA, cv), session: keepsA.CLAUDE_CODE_SESSION_ID }, w.o);
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.owner, true, 'approvals reads owner: true, so a sleepunit-agents merge is "do"');
});

test('a host maps a session it learns only on a later beat, and forgets it when the body is stopped', async () => {
  const HOME = home();
  let known = false, ended = false;
  const runner = {
    start() { return { id: 'cccc3333', harness: 'claude' }; },               // the start names no session
    status: () => (ended ? 'ended' : 'working'), end() { ended = true; }, stopped: () => true,
    slotOf: () => (known ? { harness: 'claude', session: 'sess-cccc3333' } : null),
  };
  const env = { HOME, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/run/loom/login/claude' };
  const body = { HOME, LOOM_BODY_CONVERSATION: A, CLAUDE_CODE_SESSION_ID: 'sess-cccc3333' };
  keepSession({ HOME }, 'sess-aaaa1111', A);                                 // its spare's environment's conversation is another session's
  const seen = [];
  let i = 0;
  const client = async () => {
    i++;
    if (i === 1) return { req: { r1: { harness: 'claude', key: 'key-b', conversation: B, brief: 'for B' } } };
    if (i === 2) { seen.push(bodyConversation(body, { waitMs: 0 })); known = true; return {}; }
    if (i === 3) return {};
    if (i === 4) { seen.push(bodyConversation(body, { waitMs: 0 })); return { stop: { cccc3333: { at: 'stop-1' } } }; }
    if (i === 5) { seen.push(bodyConversation(body, { waitMs: 0 })); return { exit: true }; }
    return { exit: true };
  };
  await runBodyHost({ client, runner: () => runner, env, hostKey: 'boot', sleep: async () => {}, beats: 10, idleS: 0 });
  // Unmapped and its environment another session's: none (never A). Mapped on a beat: B. Stopped: none again.
  assert.deepEqual(seen, [undefined, B, undefined]);
});

test('a Codex body\'s own environment stands while its thread is unmapped: it is never a reused spare', () => {
  const HOME = home();
  keepSession({ HOME }, 'sess-old-claude', A);
  assert.equal(bodyConversation({ HOME, LOOM_BODY_CONVERSATION: A, CODEX_THREAD_ID: 'thread-1234' }, { sleep: () => assert.fail('no wait') }), A);
});

test('a reused spare whose environment names an ended conversation waits for its own entry rather than answering with it', () => {
  const HOME = home();
  keepSession({ HOME }, 'sess-other', B);                                  // the house keeps a map
  const env = { HOME, LOOM_BODY_CONVERSATION: A, CLAUDE_CODE_SESSION_ID: 'sess-spare' };   // A: no holder any more
  let n = 0;
  assert.equal(bodyConversation(env, { sleep: () => { if (++n === 2) keepSession({ HOME }, 'sess-spare', B); } }), B);
  // Nothing ever comes: the environment's, as before, and the runtime decides.
  assert.equal(bodyConversation({ ...env, CLAUDE_CODE_SESSION_ID: 'sess-never' }, { waitMs: 500, sleep: () => {} }), A);
});
