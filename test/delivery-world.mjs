// What the delivery tests share: a fake runner (sessions as files, a real inbox when asked), a fake core, a test
// sealer, and a world (an env, its clock, the options a delivery takes).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticAccounts } from '../src/accounts.mjs';
import { CoreError } from '../src/core.mjs';
import { setModels } from '../src/models.mjs';
import { RunnerError, inbox } from '../src/runners.mjs';
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
    harness, roots, inbox: inboxDir ? inbox(inboxDir) : null, failStart: null, failResume: null, envs: {}, dead: new Set(), delay: 0,
    start(o) {
      if (r.failStart) throw new RunnerError(r.failStart);
      if (r.delay) { const ms = r.delay; r.delay = 0; return new Promise((res) => setTimeout(res, ms)).then(() => r.start(o)); }
      const id = `${harness[0]}000000${n++}`;
      session[id] = `s-${id}`;
      writeFileSync(tfile(session[id]), `transcript of ${id}: ${o.brief}\n`);
      log.push(['start', id, o.brief]);
      r.envs[id] = o.env;
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
    /** The test's hand: this body's turn is over. */
    finish(ref) { state[ref.split(':')[1]] = 'idle'; },
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

export function world(extra = {}, { inboxDir } = {}) {
  const HOME = scratch('rt-deliver-');
  const env = { HOME, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LOOM_RUNTIME_TOKEN_FILE: join(HOME, 'runtime-token'), LOOM_RUNTIME_LOOM_URL: 'http://127.0.0.1:1/mcp', ANTHROPIC_BASE_URL: 'http://proxy', SOMETHING_ELSE: 'x', LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(HOME, 'state'), LOOM_BOX_DATA: join(HOME, 'data'), LOOM_RUNTIME_SCORECARDS: 'off', ...extra };
  setModels(env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }], agent: 'art', prefer: ['opus'] });
  setModels(env, { agent: 'mark', prefer: ['opus'] });
  const log = [];
  const runner = fakeRunner(log, HOME, 'claude', { inboxDir: inboxDir ? join(HOME, 'inbox') : undefined });
  let t = Date.parse('2026-11-02T12:00:00Z');
  const clock = { now: () => new Date(t), advance: (ms) => { t += ms; } };
  const core = fakeCore(log, clock.now);
  const o = {
    core, runner: () => runner, sealer: testSealer, now: clock.now, memAvailableMb: () => 8000, warn: () => {},
    accounts: staticAccounts({ accounts: [{ name: 'max', provider: 'anthropic', harness: 'claude', kind: 'login', agents: ['art', 'mark', 'pip'], credentials: [{ kind: 'login', status: 'valid' }], usage: {} }] }),
    venues: () => ({ slack: { kind: 'live', send: [process.execPath, join(here, 'fake-send.mjs')] }, relay: { kind: 'agent' } }),
  };
  let n = 0;
  const msg = (place, text, more = {}) => ({ source: 'test-source', id: `m-${++n}`, agent: 'art', venue: 'slack', place, label: `Loren (${place})`, from: { kind: 'person', slug: 'loren' }, kind: 'message', at: clock.now().toISOString(), text, ...more });
  return { env, log, runner, core, clock, o, msg, kinds: () => log.map((l) => l[0]) };
}

