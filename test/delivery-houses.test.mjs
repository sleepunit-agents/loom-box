// Bodies in the agent's own house, end to end (agent-runtime.md section 5, bridges.md "Bodies before the one service"):
// `loom-runtime deliver` (the offer's argv) asks for the agent's warm house, placed on a box its owner owns with the
// harness logged in; the house's body host (`loom-runtime body-host`, its task) wakes the body with the house's own
// runner and environment; the body answers with `loom runtime send` through the piece API, as its own agent, with its
// run's key. loom is a stand-in: core's routes, and the piece API forwarding to this piece's api() with the caller its
// token stands for. The house is a process with the house's environment (no podman here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, setAgent } from '../src/control.mjs';
import { readBody } from '../src/bodies.mjs';
import { loadConv } from '../src/delivery.mjs';
import { hostOf } from '../src/houserunner.mjs';
import { load, update } from '../src/state.mjs';
import { scratch } from './scratch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.mjs');
const cvOf = (agent, venue, place) => `cv-${createHash('sha256').update(`${agent}\0${venue}\0${place}`).digest('hex').slice(0, 12)}`;
const hasAge = spawnSync('age', ['--version']).status === 0;
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const until = async (f, ms = 20_000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 100)); } };

const TOKENS = { runtime: 'loom_runtime_test_token_xxxxxxxx', art: 'loom_house_art_test_token_xxxxxx', mark: 'loom_house_mark_test_token_xxxxx' };

/** loom, standing in: core's routes as the runtime, and this piece's API as the caller each token is. */
async function loomServer(env) {
  const seen = [];
  const seqs = {};
  const callers = { [TOKENS.art]: { kind: 'agent', agent: 'art', house: 'h-1' }, [TOKENS.mark]: { kind: 'agent', agent: 'mark', house: 'h-9' } };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (x) => { raw += x; });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      seen.push({ path: req.url, token, body });
      res.setHeader('content-type', 'application/json');
      const send = (status, v) => { res.statusCode = status; res.end(JSON.stringify(v)); };
      if (req.url.startsWith('/api/loom/')) {
        if (token !== TOKENS.runtime) return send(403, { error: 'forbidden: core\'s routes take the runtime token' });
        if (req.url === '/api/loom/conversations/turn') { const cv = cvOf(body.agent, body.venue, body.place); return send(200, { conversation: cv, seq: (seqs[cv] = (seqs[cv] ?? 0) + 1) }); }
        if (req.url === '/api/loom/audit') return send(200, { conversation: body.conversation, seq: body.seq });
        if (req.url === '/api/loom/venues') return send(200, { venues: [{ name: 'slack', kind: 'live', piece: 'slack', send: [process.execPath, join(here, 'fake-send.mjs')] }] });
        return send(404, { error: 'not-found' });
      }
      const m = /^\/api\/box\/([a-z-]+)$/.exec(req.url);
      if (!m || !callers[token]) return send(403, { error: 'forbidden' });
      const out = await api(env, { now: () => new Date() }, { caller: callers[token], path: m[1], body });
      return send(out.status, out.body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((r) => server.close(r)) };
}

const run = (args, input, env, cwd) => new Promise((resolve) => {
  const p = spawn(process.execPath, [cli, ...args], { env, cwd });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (x) => { stdout += x; });
  p.stderr.on('data', (x) => { stderr += x; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
  p.stdin.end(input ?? '');
});

test('a delivered body is a session in its agent\'s own house: placed, woken by the house\'s host, answering as its agent', { skip: !hasAge && 'age isn\'t installed' }, async () => {
  const D = scratch('rt-houses-');
  // The control plane, on loom's machine: the runtime's own env, with things a body must never get.
  const env = {
    PATH: process.env.PATH, HOME: join(D, 'loom'), LOOM_HOME: join(D, 'loom', '.config', 'loom'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_DATA: join(D, 'data'),
    LOOM_RUNTIME_TOKEN_FILE: join(D, 'runtime-token'), LOOM_RUNTIME_ACCOUNTS: 'none', LOOM_RUNTIME_SCORECARDS: 'off',
    ANTHROPIC_API_KEY: 'sk-ant-runtimes-own', CLAUDE_CONFIG_DIR: join(D, 'loom', '.claude'), FOO_SECRET: 'hunter2',
  };
  mkdirSync(env.LOOM_HOME, { recursive: true });
  writeFileSync(env.LOOM_RUNTIME_TOKEN_FILE, `${TOKENS.runtime}\n`);
  const loom = await loomServer(env);
  env.LOOM_RUNTIME_LOOM_URL = loom.url;
  const S = scratch('rt-houses-send-');
  process.env.FAKE_SEND = S;
  // Art's house is how the owner set it; the box isn't logged in to Claude yet.
  setAgent(env, { now: () => new Date() }, { agent: 'art', repo: 'https://example.com/art.git' });
  const local = () => Object.keys(load(env).boxes).find((k) => load(env).boxes[k].local);
  try {
    const msg = (id, place, text) => JSON.stringify({ source: 'slack', id, agent: 'art', venue: 'slack', place, label: 'Loren (DM)', from: { kind: 'person', slug: 'loren' }, kind: 'message', at: new Date().toISOString(), text });
    // No box reports Claude logged in: no house is asked for, and the body is failed, saying why.
    const none = JSON.parse((await run(['deliver'], msg('1.1', 'dm:U0', 'anyone?'), env)).stdout);
    assert.equal(none.seq, 1);
    await until(() => loadConv(env, none.conversation)?.outcomes && Object.values(loadConv(env, none.conversation).outcomes)[0]?.body === 'failed');
    assert.match(Object.values(loadConv(env, none.conversation).outcomes)[0].reason, /no box owned by art's owner reports claude logged in/);
    assert.deepEqual(Object.keys(load(env).houses), []);

    // The box logs in (its own report, as the accounts work writes it): now the delivery asks for Art's house there.
    update(env, (s) => { s.boxes[local()].harnesses = { claude: { loggedIn: true } }; });
    const a = JSON.parse((await run(['deliver'], msg('1.2', 'dm:U1', 'are we still on for Thursday?'), env)).stdout);
    assert.deepEqual([a.conversation, a.seq], [cvOf('art', 'slack', 'dm:U1'), 1]);
    await until(() => load(env).houses['h-1']);
    const house = load(env).houses['h-1'];
    assert.deepEqual([house.agent, house.box, house.task], ['art', local(), 'loom-runtime body-host --piece box']);

    // The house: its own environment (its agent's token, its box's harness login), nothing of the runtime's.
    const H = join(D, 'house');
    mkdirSync(join(H, 'work'), { recursive: true });
    writeFileSync(join(H, 'token'), `${TOKENS.art}\n`);
    const houseEnv = { PATH: process.env.PATH, HOME: H, LOOM_URL: loom.url, LOOM_TOKEN_FILE: join(H, 'token'), HOUSE_ID: 'h-1', HOUSE_AGENT: 'art',
      FAKE_HARNESS: H, LOOM_RUNTIME_CLAUDE: join(here, 'fake-claude.mjs'), LOOM_RUNTIME_CLAUDE_JOBS: join(H, 'jobs'), LOOM_RUNTIME_ACCOUNTS: 'none' };
    const host = spawn(process.execPath, [cli, 'body-host', '--piece', 'box', '--beats', '60'], { env: houseEnv, cwd: join(H, 'work'), stdio: 'ignore' });
    try {
      await until(() => loadConv(env, a.conversation)?.body);
      const c = loadConv(env, a.conversation);
      assert.match(c.body, /^claude:h-1-[0-9a-f]{8}$/, 'its id is its house\'s, then its harness\'s');
      assert.equal(readBody(env, c.body).house, 'h-1');
      // It ran in the house: `claude --bg` there, with the brief on stdin (never argv), in the house's environment.
      const argv = readFileSync(join(H, 'argv.log'), 'utf-8');
      assert.ok(argv.includes('"--bg"'));
      assert.equal(argv.includes('Thursday'), false);
      const [bodyEnv] = lines(join(H, 'env.log'));
      for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'FOO_SECRET', 'LOOM_RUNTIME_TOKEN_FILE', 'LOOM_BOX_DATA']) assert.equal(bodyEnv.names.includes(k), false, k);
      assert.ok(bodyEnv.names.includes('LOOM_TOKEN_FILE'), 'its own agent\'s token, the house\'s');
      assert.match(bodyEnv.key, /^[0-9a-f]{48}$/);
      assert.ok(hostOf(env, 'art').report.bodies[c.body.split(':')[1].replace(/^h-1-/, '')]);

      // The body answers as a real one does: `loom runtime send`, its env only its house's token and its run's key.
      const bodyCli = { PATH: process.env.PATH, HOME: H, LOOM_URL: loom.url, LOOM_TOKEN_FILE: join(H, 'token'), LOOM_BODY_KEY: bodyEnv.key };
      const ok = await run(['send', '--conversation', a.conversation, '--piece', 'box', '--text', 'Yes, Thursday at 3.'], '', bodyCli, H);
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      assert.equal(JSON.parse(ok.stdout).ok, true);
      assert.deepEqual(lines(join(S, 'calls.log')).map((x) => [x.argv, x.text]), [[['--place', 'dm:U1', '--agent', 'art'], 'Yes, Thursday at 3.']]);
      const reply = loom.seen.filter((x) => x.path === '/api/loom/conversations/turn').at(-1).body;
      assert.deepEqual([reply.kind, reply.outcome, reply.from, reply.run], ['reply', 'answered', { kind: 'agent', id: 'art' }, c.run]);
      // Another agent's house, even holding Art's body's key, can't speak in Art's conversation.
      writeFileSync(join(H, 'mark-token'), `${TOKENS.mark}\n`);
      const no = await run(['send', '--conversation', a.conversation, '--piece', 'box', '--text', 'posing'], '', { ...bodyCli, LOOM_TOKEN_FILE: join(H, 'mark-token') }, H);
      assert.equal(no.status, 1);
      assert.match(JSON.parse(no.stdout).reason, /only art's own body/);
      // And Art's house with a wrong key can't either.
      const wrong = await run(['send', '--conversation', a.conversation, '--piece', 'box', '--text', 'x'], '', { ...bodyCli, LOOM_BODY_KEY: 'f'.repeat(48) }, H);
      assert.equal(wrong.status, 1);
      assert.equal(lines(join(S, 'calls.log')).length, 1);
    } finally { host.kill(); }
  } finally {
    delete process.env.FAKE_SEND;
    await loom.close();
  }
});

test('a house\'s body leaves its slot: its host packs the session in parts and sends it back; a resume puts it back first', { skip: !hasAge && 'age isn\'t installed' }, async () => {
  const { HouseRunner } = await import('../src/houserunner.mjs');
  const { runBodyHost } = await import('../src/bodyhost.mjs');
  const D = scratch('rt-house-slot-');
  const env = { PATH: process.env.PATH, HOME: D, LOOM_HOME: join(D, 'loomhome'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_DATA: join(D, 'data') };
  mkdirSync(env.LOOM_HOME, { recursive: true });
  setAgent(env, { now: () => new Date() }, { agent: 'art', repo: 'https://example.com/art.git' });
  update(env, (s) => { const k = Object.keys(s.boxes).find((x) => s.boxes[x].local); s.boxes[k].harnesses = { claude: { loggedIn: true } }; });
  // Inside the house: a local runner whose sessions are files (a big one, so it travels back in several parts).
  const roots = { sess: join(D, 'house', 'sess') };
  mkdirSync(roots.sess, { recursive: true });
  const tfile = (s) => join(roots.sess, `${s}.jsonl`);
  const seen = [];
  const st = {};
  const session = {};
  let n = 0;
  const local = {
    harness: 'claude', roots, inbox: null,
    start(o) { const id = `b000000${n++}`; st[id] = 'working'; session[id] = `s-${id}`; writeFileSync(tfile(session[id]), 'x'.repeat(900 * 1024)); seen.push(['start', o.env.LOOM_BODY_KEY]); return { id, harness: 'claude' }; },
    resume(slot, o) { const id = `b000000${n++}`; st[id] = 'working'; session[id] = slot.session; seen.push(['resume', slot.session, existsSync(tfile(slot.session)) ? readFileSync(tfile(slot.session)).length : 0, o.env.LOOM_BODY_KEY]); return { id, harness: 'claude' }; },
    status: (b) => st[b.id] ?? 'unknown',
    slotOf: (b) => (session[b.id] ? { harness: 'claude', session: session[b.id] } : null),
    feed: () => ({ fed: false, reason: 'no inbox' }),
    end(b) { st[b.id] = 'ended'; },
    sessionFiles: (slot) => ({ keep: slot && existsSync(tfile(slot.session)) ? [{ root: 'sess', rel: `${slot.session}.jsonl` }] : [], drop: [] }),
  };
  const caller = { kind: 'agent', agent: 'art', house: 'h-1' };
  const client = async (p, b) => { const r = await api(env, { now: () => new Date() }, { caller, path: p, body: b }); if (r.status !== 200) throw new Error(r.body.error); return r.body; };
  const hr = new HouseRunner(env, 'claude', { poll: 10 });
  // The start asks for Art's house; the house (and so its host) comes up once it's been asked for.
  const starting = hr.start({ agent: 'art', brief: 'hi', model: 'opus', env: { LOOM_BODY_KEY: 'k1' } });
  await until(() => load(env).houses['h-1']);
  const host = runBodyHost({ client, runner: () => local, sleep: () => new Promise((r) => setTimeout(r, 10)), beats: 3000, idleS: 0 });
  try {
    const b = await starting;
    assert.equal(b.house, 'h-1');
    assert.deepEqual(seen[0], ['start', 'k1'], 'its run\'s key, and only that, from the runtime');
    const body = { id: b.id, agent: 'art', house: 'h-1', harness: 'claude' };
    await until(() => hr.status(body) === 'working');
    const raw = b.id.replace(/^h-1-/, '');
    assert.equal(b.id, `h-1-${raw}`);
    assert.deepEqual(hr.slotOf(body), { harness: 'claude', session: `s-${raw}` });
    const files = await hr.pack(body);
    assert.equal(files.length, 1);
    assert.equal(Buffer.from(files[0].data, 'base64').length, 900 * 1024, 'whole, after travelling in parts');
    assert.equal(existsSync(tfile(`s-${raw}`)), false, 'and gone from the house');
    const r = await hr.resume({ harness: 'claude', session: `s-${raw}` }, { agent: 'art', brief: 'again', model: 'opus', env: { LOOM_BODY_KEY: 'k2' }, files });
    assert.ok(r.id);
    assert.deepEqual(seen.at(-1), ['resume', `s-${raw}`, 900 * 1024, 'k2'], 'its session was back in place before the resume');
  } finally {
    // The host leaves when the runtime says its agent's bodies are another house's.
    writeFileSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art.json'), JSON.stringify({ agent: 'art', house: 'h-2', req: {}, stop: {}, inbox: {} }));
    await host;
  }
});

test('a house is who its token says: one that names another house is refused, and syncs, claims or overwrites nothing of it', async () => {
  const { HouseRunner, bodySync } = await import('../src/houserunner.mjs');
  const { runBodyHost } = await import('../src/bodyhost.mjs');
  const D = scratch('rt-house-id-');
  const env = { PATH: process.env.PATH, HOME: D, LOOM_HOME: join(D, 'loomhome'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_DATA: join(D, 'data') };
  mkdirSync(env.LOOM_HOME, { recursive: true });
  for (const a of ['art', 'mark']) setAgent(env, { now: () => new Date() }, { agent: a, repo: `https://example.com/${a}.git` });
  update(env, (s) => { const k = Object.keys(s.boxes).find((x) => s.boxes[x].local); s.boxes[k].harnesses = { claude: { loggedIn: true } }; });
  // Every house's harness gives its first body the same id: only the house in front of it keeps them apart.
  const localRunner = () => { const st = {}; return { harness: 'claude', roots: {}, inbox: null, start() { st.b0000000 = 'working'; return { id: 'b0000000', harness: 'claude' }; }, status: (b) => st[b.id] ?? 'unknown', slotOf: () => null, end() {}, feed: () => ({ fed: false }) }; };
  const hostFor = (agent, house) => {
    const r = localRunner();
    const client = async (p, b) => { const x = await api(env, { now: () => new Date() }, { caller: { kind: 'agent', agent, house }, path: p, body: b }); if (x.status !== 200) throw new Error(x.body.error); return x.body; };
    return runBodyHost({ client, runner: () => r, sleep: () => new Promise((res) => setTimeout(res, 10)), beats: 400, idleS: 0 });
  };
  const hr = new HouseRunner(env, 'claude', { poll: 10 });
  const { startBody } = await import('../src/bodies.mjs');
  const { setModels } = await import('../src/models.mjs');
  const { staticAccounts } = await import('../src/accounts.mjs');
  env.LOOM_RUNTIME_SCORECARDS = 'off';
  setModels(env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }], agent: 'art', prefer: ['opus'] });
  setModels(env, { agent: 'mark', prefer: ['opus'] });
  const o = { runner: () => hr, accounts: staticAccounts({ accounts: [{ name: 'max', provider: 'anthropic', credentials: [{ kind: 'k', status: 'valid' }], usage: {} }] }) };
  const artStart = startBody(env, { agent: 'art', venue: 'slack', brief: 'hi art' }, o);
  await until(() => load(env).houses['h-1']);
  const artHost = hostFor('art', 'h-1');
  const art = await artStart;
  const markStart = startBody(env, { agent: 'mark', venue: 'slack', brief: 'hi mark' }, o);
  await until(() => load(env).houses['h-2']);
  const markHost = hostFor('mark', 'h-2');
  const mark = await markStart;
  // The same harness id in two houses: two bodies, and art's record is still art's.
  assert.deepEqual([art.body, mark.body], ['claude:h-1-b0000000', 'claude:h-2-b0000000']);
  assert.equal(readBody(env, 'claude:h-1-b0000000').agent, 'art');
  // A house whose token names no house, or that names another house in what it sends, is refused or told to leave.
  assert.throws(() => bodySync(env, { kind: 'agent', agent: 'art' }, { house: 'h-1', report: {} }), /this token names none/);
  const before = JSON.stringify(hostOf(env, 'art').report.bodies);
  const other = bodySync(env, { kind: 'agent', agent: 'art', house: 'h-7' }, { house: 'h-1', report: { bodies: { b0000000: { harness: 'claude', status: 'ended' } }, done: {} } });
  assert.equal(other.exit, true);
  assert.equal(JSON.stringify(hostOf(env, 'art').report.bodies), before, 'art\'s house\'s report stands');
  // A malformed id is never a record or a path.
  const { readdirSync } = await import('node:fs');
  bodySync(env, { kind: 'agent', agent: 'art', house: 'h-1' }, { report: { bodies: { '../../x': { status: 'working' } }, done: {}, packed: { '../../x': { part: 0, parts: 1, data: 'AA' } } } });
  assert.equal(readdirSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts')).some((n) => n.includes('x')), false);
  assert.equal(existsSync(join(env.LOOM_BOX_DATA, 'x.age')), false);
  // The same house reporting its body's id again, for another request: refused, art's first body untouched.
  await assert.rejects(startBody(env, { agent: 'art', venue: 'slack', brief: 'again' }, o), /reported b0000000 (for a second request|, which is already a body's)/);
  assert.equal(readBody(env, 'claude:h-1-b0000000').agent, 'art');
  // Both hosts leave once their records name other houses.
  for (const [a, h] of [['art', 'h-8'], ['mark', 'h-9']]) writeFileSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts', `${a}.json`), JSON.stringify({ agent: a, house: h, req: {}, stop: {}, inbox: {} }));
  await Promise.all([artHost, markHost]);
});
