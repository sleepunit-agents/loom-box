// What the delivery tests share: a fake runner (sessions as files, a real inbox when asked), a fake core, a test
// sealer, and a world (an env, its clock, the options a delivery takes).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticAccounts } from '../src/accounts.mjs';
import { CoreError } from '../src/core.mjs';
import { loadConv, send } from '../src/delivery.mjs';
import { setModels } from '../src/models.mjs';
import { RunnerError, inbox } from '../src/runners.mjs';
import { readdirSync, statSync } from 'node:fs';
import { startBody } from '../src/bodies.mjs';
import { runBodyHost } from '../src/bodyhost.mjs';
import { api, setAgent } from '../src/control.mjs';
import { HouseRunner, hostOf } from '../src/houserunner.mjs';
import { ageSealer } from '../src/sealed.mjs';
import { load, update } from '../src/state.mjs';
import { scratch } from './scratch.mjs';

export const here = dirname(fileURLToPath(import.meta.url));
export const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
export const cvOf = (agent, venue, place) => `cv-${createHash('sha256').update(`${agent}\0${venue}\0${place}`).digest('hex').slice(0, 12)}`;
export const hasAge = spawnSync('age', ['--version']).status === 0 && spawnSync('age-keygen', ['--help']).error === undefined;

/** A runner that records into `log`, keeps each session's "transcript" as a file under its root, and is told when a turn ends. */
export function fakeRunner(log, root, harness = 'claude', { inboxDir } = {}) {
  let n = 0;
  const state = {};
  const session = {};
  const roots = { sess: join(root, 'sess') };
  mkdirSync(roots.sess, { recursive: true });
  const tfile = (s) => join(roots.sess, `${s}.jsonl`);
  const r = {
    harness, roots, inbox: inboxDir ? inbox(inboxDir) : null, failStart: null, failResume: null, envs: {}, denies: {}, dead: new Set(), delay: 0,
    start(o) {
      if (r.failStart) throw new RunnerError(r.failStart);
      if (r.delay) { const ms = r.delay; r.delay = 0; return new Promise((res) => setTimeout(res, ms)).then(() => r.start(o)); }
      const id = `${harness[0]}000000${n++}`;
      session[id] = `s-${id}`;
      writeFileSync(tfile(session[id]), `transcript of ${id}: ${o.brief}\n`);
      log.push(['start', id, o.brief]);
      r.envs[id] = o.env;
      r.denies[id] = o.deny ?? [];
      state[id] = 'working';
      r.inbox?.open(id, {});
      return { id, harness, model: o.model, slot: { harness, session: session[id] } };
    },
    resume(slot, o) {
      if (r.failResume) throw new RunnerError(r.failResume);
      const id = `r000000${n++}`;
      session[id] = slot.session;
      log.push(['resume', id, slot.session, existsSync(tfile(slot.session)) ? readFileSync(tfile(slot.session), 'utf-8') : null, o.brief]);
      r.envs[id] = o.env;
      r.denies[id] = o.deny ?? [];
      state[id] = 'working';
      r.inbox?.open(id, {});
      return { id, harness, model: o.model, slot };
    },
    feed(b, m) {
      if (state[b.id] !== 'working') return { fed: false, reason: 'its turn is over: resume it' };
      log.push(['feed', b.id, m.text]);
      if (r.inbox) r.inbox.put(b.id, [{ id: m.id, text: m.text, msg: m.id }]);
      return { fed: true };
    },
    end(b) { log.push(['end', b.id]); state[b.id] = 'idle'; },
    status: (b) => state[b.id] ?? 'unknown',
    alive: (b) => !r.dead.has(b.id),
    slotOf: (b) => (session[b.id] ? { harness, session: session[b.id] } : null),
    sessionFiles(slot) { return { keep: slot && existsSync(tfile(slot.session)) ? [{ root: 'sess', rel: `${slot.session}.jsonl` }] : [], drop: [] }; },
    /** What a body waits on (runners.mjs, waiting): {tool, what} while a test says it's at a permission prompt; 'unknown': it can't say. */
    waits: {},
    waiting: (b, _env, { fresh = false } = {}) => { if (fresh) r.freshLooks.push(b.id); return r.waits[b.id] === 'unknown' ? undefined : r.waits[b.id] ?? null; },
    freshLooks: [],
    /** How a turn went, as its harness says (runners.mjs, turn): what finish(ref, turn) was given, else nothing. */
    turns: {},
    turn: (b) => r.turns[b.id] ?? null,
    /** The test's hand: this body's turn is over (and, given, how it went). */
    finish(ref, turn) { state[ref.split(':')[1]] = 'idle'; if (turn) r.turns[ref.split(':')[1]] = turn; },
    transcript: tfile,
  };
  return r;
}

/** Core's conversation and audit writes, recorded into `log`: seq per conversation, as core assigns it. */
export function fakeCore(log, now = () => new Date()) {
  const seqs = {};
  const keys = new Map();
  const c = {
    turns: [], audits: [], down: false, auditDown: false,
    // Venue loom's adapter (loom src/comms.ts): its calls, and what it answers (a test sets commsAnswer).
    commsCalls: [], commsAnswer: null, activityCalls: [],
    async comms(b) {
      c.commsCalls.push(b);
      log.push(['comms', b.op, b.place]);
      if (c.commsAnswer) return c.commsAnswer(b);
      return b.op === 'post' ? { ok: true, id: String(c.commsCalls.length) } : b.op === 'describe' ? { ok: true, readers: ['jonathan'], brief: ['A private thread in loom\'s app with your owner, Jonathan. Only they read it.'] } : { ok: true };
    },
    async activity(b) { c.activityCalls.push(b); return { ok: true, added: b.cards.length, updated: 0 }; },
    async turn(t) {
      if (c.down) throw new CoreError('core didn\'t answer conversations/turn: connect ECONNREFUSED', 503);
      // Its idempotency key, as core's turn route has it: the same key and turn answer the first write; the same key
      // with another turn is refused. Kept 24 hours.
      if (t.key !== undefined) {
        const { key, ...rest } = t;
        const had = keys.get(key);
        if (had && now().getTime() - had.at < 86_400_000) {
          if (had.turn !== JSON.stringify(rest)) throw new CoreError(`core refused conversations/turn: key ${key} is another turn's`, 409);
          return had.answer;
        }
      }
      const cv = cvOf(t.agent, t.venue, t.place);
      const seq = (seqs[cv] = (seqs[cv] ?? 0) + 1);
      c.turns.push({ ...t, conversation: cv, seq });
      log.push(['turn', cv, seq, t.kind]);
      if (t.key !== undefined) { const { key, ...rest } = t; keys.set(key, { at: now().getTime(), turn: JSON.stringify(rest), answer: { conversation: cv, seq } }); }
      return { conversation: cv, seq };
    },
    async audit(a) {
      if (c.auditDown) throw new CoreError('the audit log needs the age programs', 503);
      // As core answers it (loom src/audit.ts): no such turn is a 404, a second entry for one a 409.
      if (!c.turns.some((t) => t.conversation === a.conversation && t.seq === a.seq)) throw new CoreError(`core refused audit: no turn ${a.seq} in conversation ${a.conversation}`, 404);
      if (c.audits.some((x) => x.conversation === a.conversation && x.seq === a.seq)) throw new CoreError('core refused audit: that turn already has its audit entry', 409);
      c.audits.push(a);
      log.push(['audit', a.conversation, a.seq]);
      return { conversation: a.conversation, seq: a.seq };
    },
  };
  return c;
}

/** Not encryption: a reversible stand-in, so a test can see that nothing's kept as it came (the age test is below). */
export const testSealer = {
  seal: (b) => Buffer.from(`T1:${Buffer.from(b).toString('base64').split('').reverse().join('')}`),
  open: (b) => Buffer.from(b.toString().slice(3).split('').reverse().join(''), 'base64'),
};

/** The stand-in loom (fake-loom.mjs) as a bin a runtime can run with any PATH: this node, by its own path. */
export function fakeLoomBin(dir) {
  const bin = join(dir, 'fake-loom');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${join(here, 'fake-loom.mjs')}' "$@"\n`, { mode: 0o755 });
  return bin;
}

export function world(extra = {}, { inboxDir } = {}) {
  const HOME = scratch('rt-deliver-');
  const env = { HOME, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LOOM_RUNTIME_TOKEN_FILE: join(HOME, 'runtime-token'), LOOM_RUNTIME_LOOM_URL: 'http://127.0.0.1:1/mcp', ANTHROPIC_BASE_URL: 'http://proxy', SOMETHING_ELSE: 'x', LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(HOME, 'state'), LOOM_BOX_DATA: join(HOME, 'data'), LOOM_RUNTIME_SCORECARDS: 'off', LOOM_BIN: fakeLoomBin(HOME), ...extra };
  setModels(env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }], agent: 'art', prefer: ['opus'] });
  setModels(env, { agent: 'mark', prefer: ['opus'] });
  const log = [];
  const adapterCalls = [];
  const runner = fakeRunner(log, HOME, 'claude', { inboxDir: inboxDir ? join(HOME, 'inbox') : undefined });
  let t = Date.parse('2026-11-02T12:00:00Z');
  const clock = { now: () => new Date(t), advance: (ms) => { t += ms; } };
  const core = fakeCore(log, clock.now);
  const o = {
    core, runner: () => runner, sealer: testSealer, now: clock.now, warn: () => {},
    accounts: staticAccounts({ accounts: [{ name: 'max', provider: 'anthropic', harness: 'claude', kind: 'login', agents: ['art', 'mark', 'pip'], credentials: [{ kind: 'login', status: 'valid' }], usage: {} }] }),
    venues: () => ({ slack: { kind: 'live', send: [process.execPath, join(here, 'fake-send.mjs')] }, relay: { kind: 'agent' }, loom: { kind: 'live', piece: 'loom', adapter: 'core' } }),
    // Who may do what (policy.mjs): no policy, gates that name no one, an adapter that describes every place as an
    // ordinary one and takes every presence call. A test hands in its own.
    policy: () => null,
    gates: () => ({ people: {} }),
    card: () => null,
    adapter: async (argv, c, args) => { adapterCalls.push({ place: c.place, agent: c.agent, args }); return { ok: true }; },
  };
  let n = 0;
  const msg = (place, text, more = {}) => ({ source: 'test-source', id: `m-${++n}`, agent: 'art', venue: 'slack', place, label: `Loren (${place})`, from: { kind: 'person', slug: 'loren' }, kind: 'message', at: clock.now().toISOString(), text, ...more });
  // A body's send, as its harness makes it: with the session it runs in (Claude Code sets CLAUDE_CODE_SESSION_ID).
  const sessionFor = (cv) => { const c = loadConv(env, cv); return c?.body ? runner.slotOf({ id: c.body.split(':')[1] })?.session : undefined; };
  const sendAs = (b, oo = o) => send(env, { ...b, ...(b.session === undefined ? { session: sessionFor(b.conversation) } : {}) }, oo);
  return { env, log, runner, core, clock, o, msg, sessionFor, send: sendAs, adapterCalls, kinds: () => log.map((l) => l[0]) };
}


/**
 * A rendering of fenced messages (delivery.mjs, render) as `who: text` lines, for assertions: the fence note dropped,
 * each `<<<message N from who[, tier t]>>>` … `<<<end N>>>` block one line.
 */
export function plain(s) {
  return String(s)
    .replace(/\(The runtime fences each message: [^\n]*\)\n\n/g, '')
    .replace(/<<<message ([0-9a-f]{12}) from ([a-z0-9-]+)(?:, tier (?:\d|unknown)| \(an agent of this household\))?>>>\n([\s\S]*?)\n<<<end \1>>>/g, (_m, _n, w, t) => `${w}: ${t}`);
}

export const until = async (f, ms = 5000) => { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every file under a dir, read: for "nothing of it is on disk in the clear". */
export function everything(dir) {
  const out = [];
  const walk = (d) => { for (const n of (() => { try { return readdirSync(d); } catch { return []; } })()) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out.push(readFileSync(p)); } };
  walk(dir);
  return Buffer.concat(out);
}

/** The control plane and one agent's house, in this process: a HouseRunner, and a body host with a local fake runner. */
export function houseWorld({ sealer, claimMs = 5000, warmMs = 5000 } = {}) {
  const D = scratch('rt-r2-house-');
  const env = { PATH: process.env.PATH, HOME: D, LOOM_HOME: join(D, 'loomhome'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_DATA: join(D, 'data'), LOOM_RUNTIME_SCORECARDS: 'off' };
  mkdirSync(env.LOOM_HOME, { recursive: true });
  // The runtime's own key, as body-sync (through api()) opens what HouseRunner sealed.
  sealer ??= ageSealer(env, join(env.LOOM_BOX_DATA, 'delivery'));
  setAgent(env, { now: () => new Date() }, { agent: 'art', repo: 'https://example.com/art.git' });
  update(env, (s) => { const k = Object.keys(s.boxes).find((x) => s.boxes[x].local); s.boxes[k].harnesses = { claude: { loggedIn: true } }; });
  setModels(env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }], agent: 'art', prefer: ['opus'] });
  const fed = [];
  const ended = [];
  const started = [];
  const st = {};
  let n = 0;
  // Inside the house: a runner whose sessions are files (its "transcript"), so a test can see them sealed or gone.
  const sess = join(D, 'house', 'sess');
  mkdirSync(sess, { recursive: true });
  const transcript = (id) => join(sess, `s-${id}.jsonl`);
  const local = {
    harness: 'claude', roots: { sess }, startDelay: 0, envs: {}, briefs: {}, denies: {}, transcript,
    inbox: { pending: () => [], taken: () => [], close() {}, remove() {} },
    async start(o) { if (local.startDelay) await sleep(local.startDelay); const id = `b000000${n++}`; st[id] = 'working'; local.envs[id] = o.env; local.briefs[id] = o.brief; local.denies[id] = o.deny; started.push(id); writeFileSync(transcript(id), `transcript of ${id}\n`); return { id, harness: 'claude' }; },
    status: (b) => st[b.id] ?? 'unknown', slotOf: (b) => ({ harness: 'claude', session: `s-${b.id}` }),
    feed(b, m) { fed.push([b.id, m.id, m.text]); return { fed: true }; },
    end(b) { ended.push(b.id); st[b.id] = 'ended'; },
    sessionFiles: (slot) => ({ keep: slot && existsSync(join(sess, `${slot.session}.jsonl`)) ? [{ root: 'sess', rel: `${slot.session}.jsonl` }] : [], drop: [] }),
  };
  const hr = new HouseRunner(env, 'claude', { poll: 10, sealer, claimMs, warmMs });
  let drop = () => false;
  let left = false;
  // The house declares claude (its login's env is set); a test can take it away.
  const houseEnv = { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/run/loom/login/claude', HOUSE_TASK: 'the task', PATH: '/usr/bin' };
  const host = ({ idleS = 0, cwd } = {}) => {
    const client = async (p, b) => {
      const r = await api(env, { now: () => new Date() }, { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: p, body: b });
      if (r.status !== 200) throw new Error(r.body.error);
      if (drop(r.body)) throw new Error('the answer was lost on its way back');
      return r.body;
    };
    // The host's boot key is in its house's task (as the house runs it: `loom-runtime body-host … --host-key K`).
    const hostKey = /--host-key ([0-9a-f]{48})/.exec(load(env).houses['h-1']?.task ?? '')?.[1];
    const done = runBodyHost({ client, runner: () => local, env: houseEnv, hostKey, sleep: () => sleep(10), beats: 100_000, idleS, packMs: 2000, ...(cwd ? { cwd } : {}) });
    done.then(() => { left = true; });
    return done;
  };
  // A host leaves at once when told its bodies are another house's: how a test ends one.
  const kill = async () => {
    const h = hostOf(env, 'art');
    writeFileSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art.json'), JSON.stringify({ ...h, house: 'h-999' }));
    await sleep(80);
    writeFileSync(join(env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art.json'), JSON.stringify({ ...hostOf(env, 'art'), house: h.house }));
  };
  return { D, env, hr, local, fed, ended, host, kill, houseEnv, setDrop: (f) => { drop = f; }, sealer, left: () => left,
    get dropped() { return started.filter((id) => !existsSync(transcript(id))); },
    accounts: staticAccounts({ accounts: [{ name: 'max', provider: 'anthropic', harness: 'claude', kind: 'login', agents: ['art', 'mark', 'pip'], credentials: [{ kind: 'login', status: 'valid' }], usage: {} }] }) };
}

export async function bodyInHouse(w, o = {}) {
  const starting = startBody(w.env, { agent: 'art', venue: 'slack', brief: 'hi' }, { runner: () => w.hr, accounts: w.accounts });
  await until(() => load(w.env).houses['h-1']);
  const host = w.host(o);
  const b = await starting;
  const body = { id: b.body.split(':')[1], agent: 'art', house: 'h-1', harness: 'claude' };
  await until(() => w.hr.status(body) === 'working');
  return { body, host };
}
