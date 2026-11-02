// The second cold review of loom-box#48: each finding pinned by a test that failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { staticAccounts } from '../src/accounts.mjs';
import { startBody } from '../src/bodies.mjs';
import { runBodyHost } from '../src/bodyhost.mjs';
import { api, setAgent } from '../src/control.mjs';
import { CoreError } from '../src/core.mjs';
import { deliver, deliveryDir, loadConv, tick } from '../src/delivery.mjs';
import { HouseRunner, bodySync, hostOf } from '../src/houserunner.mjs';
import { setModels } from '../src/models.mjs';
import { ageSealer } from '../src/sealed.mjs';
import { load, update } from '../src/state.mjs';
import { cvOf, hasAge, here, pkg, testSealer, world } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';

const until = async (f, ms = 5000) => { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every file under a dir, read: for "nothing of it is on disk in the clear". */
function everything(dir) {
  const out = [];
  const walk = (d) => { for (const n of (() => { try { return readdirSync(d); } catch { return []; } })()) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out.push(readFileSync(p)); } };
  walk(dir);
  return Buffer.concat(out);
}

/** The control plane and one agent's house, in this process: a HouseRunner, and a body host with a local fake runner. */
function houseWorld({ sealer, claimMs = 5000, warmMs = 5000 } = {}) {
  const D = scratch('rt-r2-house-');
  const env = { PATH: process.env.PATH, HOME: D, LOOM_HOME: join(D, 'loomhome'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_DATA: join(D, 'data'), LOOM_RUNTIME_SCORECARDS: 'off' };
  // The runtime's own key, as body-sync (through api()) opens what HouseRunner sealed.
  sealer ??= ageSealer(env, join(env.LOOM_BOX_DATA, 'delivery'));
  mkdirSync(env.LOOM_HOME, { recursive: true });
  setAgent(env, { now: () => new Date() }, { agent: 'art', repo: 'https://example.com/art.git' });
  update(env, (s) => { const k = Object.keys(s.boxes).find((x) => s.boxes[x].local); s.boxes[k].harnesses = { claude: { loggedIn: true } }; });
  setModels(env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }], agent: 'art', prefer: ['opus'] });
  const fed = [];
  const ended = [];
  const st = {};
  let n = 0;
  const local = {
    harness: 'claude', roots: {}, startDelay: 0,
    inbox: { pending: () => [], taken: () => [], close() {}, remove() {} },
    async start() { if (local.startDelay) await sleep(local.startDelay); const id = `b000000${n++}`; st[id] = 'working'; return { id, harness: 'claude' }; },
    status: (b) => st[b.id] ?? 'unknown', slotOf: (b) => ({ harness: 'claude', session: `s-${b.id}` }),
    feed(b, m) { fed.push([b.id, m.id, m.text]); return { fed: true }; },
    end(b) { ended.push(b.id); st[b.id] = 'ended'; },
    sessionFiles: () => ({ keep: [], drop: [] }),
  };
  const hr = new HouseRunner(env, 'claude', { poll: 10, sealer, claimMs, warmMs });
  let drop = () => false;
  const stops = [];
  const host = () => {
    let stopped = false;
    const client = async (p, b) => {
      const r = await api(env, { now: () => new Date() }, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: p, body: b });
      if (r.status !== 200) throw new Error(r.body.error);
      if (drop(r.body)) throw new Error('the answer was lost on its way back');
      return r.body;
    };
    const done = runBodyHost({ client, runner: () => local, sleep: () => sleep(10), beats: 100_000, idleS: 0, now: () => (stopped ? Infinity : Date.now()) });
    stops.push(() => { stopped = true; return done; });
    return done;
  };
  // A host leaves at once when told its bodies are another house's: how a test ends one.
  const kill = async () => {
    const h = hostOf(env, 'art');
    writeFileSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art.json'), JSON.stringify({ ...h, house: 'h-999' }));
    await sleep(80);
    writeFileSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art.json'), JSON.stringify({ ...hostOf(env, 'art'), house: h.house }));
  };
  return { D, env, hr, local, fed, ended, host, kill, setDrop: (f) => { drop = f; }, sealer,
    accounts: staticAccounts({ accounts: [{ name: 'max', provider: 'anthropic', credentials: [{ kind: 'k', status: 'valid' }], usage: {} }] }) };
}

async function bodyInHouse(w) {
  const starting = startBody(w.env, { agent: 'art', venue: 'slack', brief: 'hi' }, { runner: () => w.hr, accounts: w.accounts });
  await until(() => load(w.env).houses['h-1']);
  const host = w.host();
  const b = await starting;
  const body = { id: b.body.split(':')[1], agent: 'art', house: 'h-1', harness: 'claude' };
  await until(() => w.hr.status(body) === 'working');
  return { body, host };
}

test('1. a follow-up handed to a house leaves the runtime only once the house says it took it: a lost answer loses nothing', { skip: !hasAge && 'age isn\'t installed' }, async () => {
  const w = houseWorld();
  const { body } = await bodyInHouse(w);
  // The sync answer carrying the follow-up is lost on its way back to the house.
  let lost = 0;
  w.setDrop((a) => { if (lost || !Object.values(a.inbox ?? {}).some((x) => x.length)) return false; lost += 1; return true; });
  assert.deepEqual(w.hr.feed(body, { id: 'k1', text: 'one more thing' }), { fed: true });
  await until(() => w.fed.length >= 1, 3000);
  await sleep(100);
  assert.deepEqual(w.fed, [[body.id.replace(/^h-1-/, ''), 'k1', 'one more thing']], 'heard once, after the lost answer');
  assert.equal(lost, 1);
  await until(() => !(hostOf(w.env, 'art').inbox?.[body.id.replace(/^h-1-/, '')] ?? []).length);
  await w.kill();
});

test('1b. a follow-up a house never acknowledged is the runtime\'s still: when its body\'s host dies, it\'s recovered for the next body', { skip: !hasAge && 'age isn\'t installed' }, async () => {
  const w = houseWorld({ claimMs: 3000, warmMs: 3000 });
  const { body } = await bodyInHouse(w);
  // The house goes quiet (its answers never get there) before the follow-up reaches it.
  w.setDrop(() => true);
  w.hr.feed(body, { id: 'k2', text: 'are you there?' });
  await sleep(100);
  assert.deepEqual(w.hr.unheard(body), ['k2'], 'never acknowledged: still the runtime\'s');
  // Its host dies (no report for longer than a host is stale): it can't say what it heard, so everything fed is unheard.
  const now = w.hr.now;
  w.hr.now = () => new Date(Date.now() + 60_000);
  assert.equal(w.hr.unheard(body), null);
  w.hr.now = now;
  // It comes back: it takes the follow-up, and acknowledges it.
  w.setDrop(() => false);
  await until(() => w.fed.some((f) => f[1] === 'k2'), 3000);
  await until(() => Array.isArray(w.hr.unheard(body)) && !w.hr.unheard(body).includes('k2'), 3000);
  await w.kill();
});

test('1c. a house body that dies with follow-ups it never acknowledged: they go to the next body, from the runtime\'s copies', async () => {
  const w = world();
  // The runner is a house's, as far as delivery can tell: no local inbox; it says what its house left unheard.
  Object.assign(w.runner, { remote: true, unheard: () => null, forgetInbox() {}, pack: async () => [] });
  const A = cvOf('art', 'slack', 'dm:A');
  await deliver(w.env, w.msg('dm:A', 'one'), w.o);
  assert.equal((await deliver(w.env, w.msg('dm:A', 'two, in flight'), w.o)).body, 'fed');
  const id = loadConv(w.env, A).body.split(':')[1];
  w.runner.dead.add(id);
  await tick(w.env, w.o);
  const next = w.log.filter((l) => l[0] === 'start').at(-1);
  assert.notEqual(next[1], id);
  assert.ok(next[2].endsWith('loren: two, in flight'), 'the next body has it');
});

test('2a. a body that leaves no session files leaves no slot: the next message starts fresh, from digests', async () => {
  const w = world();
  const A = cvOf('art', 'slack', 'dm:A');
  await deliver(w.env, w.msg('dm:A', 'one'), w.o);
  const c = loadConv(w.env, A);
  w.runner.finish(c.body);
  // Its harness kept nothing (or nothing that fits): an empty pack.
  const { rmSync } = await import('node:fs');
  rmSync(w.runner.transcript(`s-${c.body.split(':')[1]}`));
  w.clock.advance(601_000);
  await tick(w.env, w.o);
  w.clock.advance(601_000);
  await tick(w.env, w.o);
  assert.equal(loadConv(w.env, A).body, undefined);
  assert.equal(loadConv(w.env, A).slot, undefined, 'no slot that could never resume');
  const r = await deliver(w.env, w.msg('dm:A', 'two'), w.o);
  assert.equal(r.body, 'started');
  assert.ok(w.log.at(-1)[2].includes(`read it with conversation({id: "${A}"})`));
});

test('2b. a slot that won\'t resume is cleared, and the same delivery starts a fresh body', async () => {
  const w = world();
  const A = cvOf('art', 'slack', 'dm:A');
  await deliver(w.env, w.msg('dm:A', 'one'), w.o);
  w.runner.finish(loadConv(w.env, A).body);
  w.clock.advance(601_000);
  await tick(w.env, w.o);
  w.clock.advance(601_000);
  await tick(w.env, w.o);
  assert.ok(loadConv(w.env, A).slot, 'a slot, with its session');
  w.runner.failResume = 'that session is gone';
  const r = await deliver(w.env, w.msg('dm:A', 'two'), w.o);
  assert.equal(r.body, 'started');
  assert.equal(loadConv(w.env, A).slot, undefined);
  assert.equal(existsSync(join(deliveryDir(w.env), 'slots', `${A}.age`)), false);
  assert.ok(w.log.at(-1)[2].endsWith('loren: two'));
});

test('3. a session coming back in parts is never on disk in the clear, and a transfer that stops is swept after an hour', async () => {
  const D = scratch('rt-r2-parts-');
  const env = { HOME: D, LOOM_BOX_DATA: join(D, 'data'), LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_LOCAL_NAME: 'one' };
  const hosts = join(env.LOOM_BOX_DATA, 'delivery', 'hosts');
  mkdirSync(hosts, { recursive: true });
  writeFileSync(join(hosts, 'art.json'), JSON.stringify({ agent: 'art', house: 'h-1', req: {}, stop: { b0000000: { pack: true, at: Date.now() } }, inbox: {} }));
  const secret = Buffer.from(JSON.stringify([{ root: 'projects', rel: 'x.jsonl', data: Buffer.from('THE TRANSCRIPT, IN THE CLEAR').toString('base64') }])).toString('base64');
  const t0 = new Date('2026-11-02T12:00:00Z');
  const r = bodySync(env, { kind: 'agent', agent: 'art', house: 'h-1' }, { report: { bodies: { b0000000: { harness: 'claude', status: 'ended' } }, done: {}, packed: { b0000000: { part: 0, parts: 2, data: secret.slice(0, 40) } } } }, { sealer: testSealer, now: () => t0 });
  assert.deepEqual(r.acked, [['b0000000', 0]]);
  const disk = everything(hosts);
  assert.equal(disk.includes(Buffer.from(secret.slice(0, 40))), false, 'the part is sealed as it arrives');
  // The transfer never finishes: an hour on, the tick sweeps it.
  const w = world();
  await tick(env, { ...w.o, now: () => new Date(t0.getTime() + 59 * 60_000) });
  assert.ok(readdirSync(join(hosts, 'parts', 'art', 'h-1')).length);
  await tick(env, { ...w.o, now: () => new Date(t0.getTime() + 61 * 60_000) });
  assert.deepEqual(readdirSync(join(hosts, 'parts', 'art', 'h-1')), []);
});

test('4. a body that takes 5 s to start doesn\'t hold the source past its 2 s', async () => {
  const w = world();
  w.runner.delay = 5000;
  let drained;
  const t0 = Date.now();
  const r = await deliver(w.env, w.msg('dm:S', 'slow'), { ...w.o, onDrain: (p) => { drained = p; } });
  assert.ok(Date.now() - t0 < 2500, `answered in ${Date.now() - t0} ms`);
  assert.ok(['started', 'queued'].includes(r.body), JSON.stringify(r));
  await drained;
  assert.equal(Object.values(loadConv(w.env, cvOf('art', 'slack', 'dm:S')).outcomes)[0].body, 'started', 'and it did start');
});

test('5. without age, the body is still reached from a detached worker (its text on a pipe, never a file), with no slot', async () => {
  const w = world({ LOOM_AGE: '/nonexistent/age', LOOM_AGE_KEYGEN: '/nonexistent/age-keygen' });
  const { sealer: _s, ...o } = w.o;
  const workers = [];
  const t0 = Date.now();
  const r = await deliver(w.env, w.msg('dm:N', 'no age here'), { ...o, detach: true, spawnWorker: (cv, mem) => workers.push([cv, [...mem.values()]]) });
  assert.ok(Date.now() - t0 < 2500);
  assert.deepEqual(workers, [[cvOf('art', 'slack', 'dm:N'), ['no age here']]], 'detached, with its text in memory');
  assert.equal(r.body, 'queued');
  assert.equal(w.log.filter((l) => l[0] === 'start').length, 0, 'nothing ran inline');
  assert.equal(everything(deliveryDir(w.env)).includes(Buffer.from('no age here')), false);
  // The worker, given the text on stdin: it reaches the body (here a house, where no box is logged in: failed, said why).
  const cv = cvOf('art', 'slack', 'dm:N');
  const key = loadConv(w.env, cv).queue[0].key;
  const child = spawn(process.execPath, [join(here, '..', 'src', 'cli.mjs'), 'deliver', 'tick', '--conversation', cv, '--stdin'], { env: { ...w.env, LOOM_RUNTIME_ACCOUNTS: 'none' }, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end(JSON.stringify({ [key]: 'no age here' }));
  await new Promise((res) => child.on('close', res));
  const out = loadConv(w.env, cv).outcomes[key];
  assert.equal(out.body, 'failed');
  assert.match(out.reason, /no box owned by art's owner/, 'it had the text (else: its messages\' text is gone)');
  // A house's body packed without age: no slot, at once, never a wait.
  const hw = houseWorld({ sealer: ageSealer({ LOOM_AGE: '/nonexistent/age', LOOM_AGE_KEYGEN: '/nonexistent/age-keygen' }, scratch('rt-r2-noage-')) });
  const t1 = Date.now();
  assert.equal(await hw.hr.pack({ id: 'h-1-b0000000', agent: 'art', house: 'h-1', harness: 'claude' }), null);
  assert.ok(Date.now() - t1 < 500);
});

test('6. a turn write that timed out may have landed: the retry finds it (by its audit entry) instead of writing it twice', async () => {
  const w = world();
  // Core writes the turn, then the answer never comes back.
  const turn = w.core.turn;
  let landed = 0;
  w.core.turn = async (t) => { const r = await turn(t); if (landed++ === 0) throw new CoreError('core didn\'t answer conversations/turn: no answer in 5s', 503); return r; };
  const m = w.msg('dm:T', 'did it land?');
  const first = await deliver(w.env, m, w.o);
  assert.equal(first.status, 503);
  assert.equal(w.core.turns.length, 1);
  const again = await deliver(w.env, m, w.o);
  assert.deepEqual([again.seq, again.body], [1, 'started']);
  assert.equal(w.core.turns.length, 1, 'no second turn');
  assert.deepEqual(w.core.audits.map((a) => [a.seq, a.text]), [[1, 'did it land?']], 'its text, once, on the turn that landed');
  // One that really didn't land: the retry writes it.
  w.core.down = true;
  const m2 = w.msg('dm:T', 'this one didn\'t');
  assert.equal((await deliver(w.env, m2, w.o)).status, 503);
  w.core.down = false;
  assert.equal((await deliver(w.env, m2, w.o)).seq, 2);
  assert.equal(w.core.turns.length, 2);
});

test('7. the runtime declares the relay venue (kind agent) in its loom block', async () => {
  assert.deepEqual(pkg.loom.venues, { relay: { label: 'Relay', kind: 'agent' } });
  const dist = join(process.env.HOME, 'Code', 'loom', 'dist', 'cli', 'pieces-managed.js');
  if (existsSync(dist)) {
    const m = await import(dist);
    const r = m.parseLoomBlock(pkg.loom, 'runtime', Object.keys(pkg.bin));
    assert.notEqual(typeof r, 'string', r);
  }
});

test('8. no memory gate: only busy bodies make a message wait', async () => {
  const w = world();
  w.o.memAvailableMb = () => 10;
  assert.equal((await deliver(w.env, w.msg('dm:M', 'hi'), w.o)).body, 'started');
});

test('9. a start whose claim wait runs out is stopped, should its house start it late: it never runs', { skip: !hasAge && 'age isn\'t installed' }, async () => {
  const w = houseWorld({ claimMs: 150 });
  const starting = startBody(w.env, { agent: 'art', venue: 'slack', brief: 'hi' }, { runner: () => w.hr, accounts: w.accounts });
  await until(() => load(w.env).houses['h-1']);
  w.local.startDelay = 400;
  w.host();
  await assert.rejects(starting, /didn't start the body in/);
  await until(() => w.ended.length === 1, 3000);
  assert.deepEqual(w.ended, ['b0000000'], 'the late body was ended by its host');
  await w.kill();
});

test('10. a warm resume that fails leaves no transcript in the clear: the old session is sealed first, then a fresh body', async () => {
  const w = world();
  const A = cvOf('art', 'slack', 'dm:A');
  await deliver(w.env, w.msg('dm:A', 'one'), w.o);
  const old = loadConv(w.env, A).body;
  const tr = w.runner.transcript(`s-${old.split(':')[1]}`);
  w.runner.finish(old);
  w.runner.failResume = 'overloaded';
  const r = await deliver(w.env, w.msg('dm:A', 'two'), w.o);
  assert.equal(r.body, 'started');
  assert.equal(existsSync(tr), false, 'its transcript isn\'t left on disk');
  assert.equal(everything(deliveryDir(w.env)).includes(Buffer.from('transcript of')), false);
});
