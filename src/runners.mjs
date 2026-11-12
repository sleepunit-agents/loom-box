import { durableJson } from './durable-json.mjs';
import { isWork, selectedProfile, restrictedEnv, claudeWorkArgs, minimalProfile, profileNotice } from './work-profile.mjs';
// Runners (loom docs/specs/agent-runtime.md, section 3): one interface over the harnesses a body runs in.
//
// A runner runs bodies on one harness, on this machine (loom's own, or inside a house):
//   start({brief, model, cwd, env, deny})  → a body: {id, harness, model, slot?}. The brief goes on stdin, never
//                                            argv (message text must not show in /proc/<pid>/cmdline).
//   feed(body, message)                    → {fed: true} | {fed: false, reason}: a message mid-turn, where the
//                                            harness allows it. Where it doesn't, or the turn is over, the caller
//                                            waits for the turn to end, or resumes.
//   resume(slot, {brief, model, cwd, env}) → a body, continuing the session the slot names.
//   end(body, env?)                        → requests its stop; never throws for a body that's already gone.
//   stopped(body)                          → confirms it has stopped writing its session, before packing or deletion.
//   status(body)                           → 'working' (mid-turn), 'idle' (its turn ended; resumable), 'ended'
//                                            or 'unknown'.
//   slotOf(body)                           → the slot that resumes it ({harness, session}), once the harness says.
//   sessionFiles(slot, body?)              → the harness's own local files for that session: {keep: [{root, rel}]}
//                                            (its transcript: what a resume needs, packed into a continuity slot)
//                                            and {drop: [path]} (the body's job or run dir: its brief, its events).
//   roots                                  → {name: dir}: where `keep` paths are relative to (and restored into).
//   usage(body)                            → how full its account was at its last turn ({windows, resets, checked}),
//                                            or null: what the body host reports when a turn ends (t-1754).
//   waiting(body, env?)                    → {tool, what} while it waits on a permission prompt (its last tool call,
//                                            from its transcript), else null. Only where the harness says so (Claude
//                                            Code's `claude agents --json`); a body nobody can answer is stopped by the
//                                            tick (delivery.mjs, t-1858).
//   turn(body)                             → how its turn went, once it's over: {failed, worked, error?, limited?,
//                                            resets?} (worked: it did any tool work; null when the harness doesn't
//                                            say), or null. What the loop check reads (loops.mjs, t-1763). `limited`:
//                                            its provider refused it for a usage limit (logins.mjs, lastRefusal: the
//                                            harness's structured error, never its prose), and `resets` when that
//                                            account has room again, from its last reading (t-1907).
//
// Two harnesses today, ported from the bridges piece's runners (shuttle/runner.py, shuttle/runners/codex.py):
// Claude Code as `claude --bg`, and Codex as `codex exec --json`. Feeding goes through a body's inbox: the layout
// the bridges piece's inbox hook reads (<inbox dir>/<id8>/pending.jsonl, under flock), so a house whose harness
// has that hook hears follow-ups mid-turn. With no inbox dir, a body can't be fed.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { nativeHistoryEnv, validateNativeHistoryOptions } from './native-history.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastContext } from './context-cap.mjs';
import { keptReading } from './statusline.mjs';
import { openFinalCheckpoint, closeFinalCheckpoint, loadFinalCheckpoint, saveFinalCheckpoint, dropFinalCheckpoints } from './final-checkpoint.mjs';
import { claudeActionNow, codexActionNow } from './ticker.mjs';
import { claudeCards, claudeTokens, codexCards } from './activity.mjs';
import { CRED_FILE, lastRateLimit, lastRefusal, refusedUntil, tailOf } from './logins.mjs';
// A ticker observation never scans an unbounded conversation history. Missing starts mean generic Working.
const tickerLines = p => (tailOf(p, 1024 * 1024) ?? '').split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
import { lastToolUse } from './stuck.mjs';
import { withLock } from './state.mjs';
import { parse as parseToml, stringify as stringifyToml } from './vendor/smol-toml/index.js';

export class RunnerError extends Error {}
const neverStarted = message => Object.assign(new RunnerError(message), { nativeNotStarted: true });

/** A harness's session id, as it may appear in a file name: never a path. */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/;
/** The names in a dir (with files too, when `all`), [] for none. */
const dirs = (d, all = false) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => all || e.isDirectory()).map((e) => e.name); } catch { return []; } };

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hex8 = () => randomBytes(4).toString('hex');
const stableLaunchToken = value => {
  if (!/^[0-9a-f]{24}$/.test(value ?? '')) throw new RunnerError('invalid durable native launch token');
  return value;
};

/** At most how much of a session's transcript a sign of life reads a time, and of a helper's transcript (t-2109). */
const SIGN_READ_MAX = 4 * 1024 * 1024;
const HELPER_READ_MAX = 2 * 1024 * 1024;
const SIGN_MEMO = new Map();
const CODEX_CARD_TIMES = new Map();
/** Each transcript's last words so far and where its read stopped (ClaudeRunner.final, t-2138), kept for the process. */
const FINAL_MEMO = new Map();
/** A transcript line's words: an assistant message's text parts, joined; null for any other line, or one not JSON. */
function lastWordsOf(line) {
  let e;
  try { e = JSON.parse(line); } catch { return null; }
  if (e?.type !== 'assistant' || !Array.isArray(e.message?.content) || !e.message.content.some((p) => p?.type === 'text')) return null;
  return e.message.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
}
/** The longest unfinished line a sign of life carries between reads; past it, the line's dropped. */
const REST_MAX = 16 * 1024 * 1024;
/** At most how much of a helper's meta file is read (a few hundred bytes, as Claude Code writes it). */
const META_MAX = 64 * 1024;
const ACTIVITY_READ_MAX = 16 * 1024 * 1024;
const jsonLines = (t) => t.split('\n').flatMap((l) => { try { const v = JSON.parse(l); return v && typeof v === 'object' ? [v] : []; } catch { return []; } });
/** `max` bytes of `p` from `offset` (as text), and the offset after them. */
function readFrom(p, offset, max, opened) {
  let fd;
  try {
    // As tailOf reads; a buffer only as large as what's there to read.
    // Never through a link, nor a FIFO or device a body put there (no wait to open it, only a plain file read).
    fd = opened ?? openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return { text: '', next: offset };
    const size = Math.max(0, Math.min(max, st.size - offset));
    const buf = Buffer.alloc(size);
    const n = size ? readSync(fd, buf, 0, size, offset) : 0;
    // Up to the last whole UTF-8 character: a character cut by the slice is read whole next time, never as U+FFFD.
    let end = n;
    if (n) {
      let k = n - 1;
      while (k >= 0 && n - k <= 4 && (buf[k] & 0xc0) === 0x80) k--;
      const lead = k >= 0 ? buf[k] : 0;
      const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (k >= 0 && n - k < width) end = k;
    }
    return { text: buf.subarray(0, end).toString('utf-8'), next: offset + end };
  } catch { return { text: '', next: offset }; } finally { if (opened === undefined && fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}
const lines = (p) => { try { return readFileSync(p, 'utf-8').split('\n').flatMap((l) => { try { const v = JSON.parse(l); return v && typeof v === 'object' ? [v] : []; } catch { return []; } }); } catch { return []; } };

/** A body's inbox, in the bridges piece's layout (shuttle/inbox.py), so its hook reads what's put here. */
export function inbox(dir, { run = spawnSync } = {}) {
  const at = (id) => join(dir, String(id).slice(0, 8));
  return {
    dir,
    open(id, meta) {
      // A new body's inbox is a new one: a resumed Claude session has its old job id (t-1881), and must not inherit
      // that body's closed inbox, nor what it was fed.
      rmSync(at(id), { recursive: true, force: true });
      mkdirSync(at(id), { recursive: true, mode: 0o700 });
      writeFileSync(join(at(id), 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
    },
    isOpen: (id) => existsSync(at(id)) && !existsSync(join(at(id), 'closed')),
    /** Appended under the hook's own lock (flock(2), as Python's fcntl.flock takes it), so a take never loses one. */
    put(id, items, now = Date.now() / 1000) {
      if (!existsSync(at(id))) return false;
      const lines = items.map((it) => JSON.stringify({ ...it, t: now }) + '\n').join('');
      const r = run('flock', [join(at(id), 'lock'), 'sh', '-c', '[ ! -e closed ] && cat >> pending.jsonl'], { cwd: at(id), input: lines, stdio: ['pipe', 'ignore', 'pipe'], timeout: 10_000 });
      return r.status === 0;
    },
    close(id) {
      if (!existsSync(at(id))) return;
      run('flock', [join(at(id), 'lock'), 'touch', 'closed'], { cwd: at(id), stdio: 'ignore', timeout: 10_000 });
    },
    /** What's still pending (put, never taken by the hook): after close, final (shuttle's inbox.close). Body-writable: ids only mean anything. */
    pending(id) {
      const took = new Set(this.taken(id));
      return lines(join(at(id), 'pending.jsonl')).filter((v) => !took.has(v.id));
    },
    /** The ids its hook took (delivered.jsonl). */
    taken(id) { return lines(join(at(id), 'delivered.jsonl')).map((v) => v.id).filter((k) => typeof k === 'string'); },
    /** Gone, with every message's text in it: message text lives in an inbox only while its body runs. */
    remove(id) { rmSync(at(id), { recursive: true, force: true }); },
  };
}

/** Feeding a body: into its inbox while its turn runs; else the caller waits or resumes. */
function feedVia(runner, body, message) {
  if (!runner.inbox) return { fed: false, reason: `this ${runner.harness} runner has no inbox dir (LOOM_RUNTIME_INBOX_DIR), so a body hears nothing mid-turn` };
  if (runner.status(body) !== 'working') return { fed: false, reason: 'its turn is over: resume it' };
  if (!runner.inbox.isOpen(body.id)) return { fed: false, reason: 'its inbox is closed' };
  const id = message.id ?? `m-${hex8()}`;
  return runner.inbox.put(body.id, [{ id, text: String(message.text ?? ''), msg: message.msg ?? id }]) ? { fed: true } : { fed: false, reason: 'its inbox refused it' };
}

/** `claude agents --json`, as `waiting` last read it, by harness: {at, rows}. */
const waitLooks = new Map();
export const WAIT_LOOK_MS = 30_000;

/**
 * Claude Code, `claude --bg`: its daemon owns each body, `claude agents --json` lists them, and each body's job dir
 * (<jobs>/<id8>/state.json) says how its turn is going. A new body is found by a random spawn token on line 2 of its
 * brief (the job's intent), so a quoted line in a message can never claim it (shuttle's t-1272, t-1411).
 */
export class ClaudeRunner {
  harness = 'claude';
  static TOKEN_LINE = '(bridge spawn token {token}: ignore this line)';

  constructor({ claude = 'claude', jobsDir = join(homedir(), '.claude', 'jobs'), projectsDir, args = [], inboxDir, usageDir = usageDirOf(), node = process.execPath, run = spawnSync, sleep = sleepMs, claimPolls = 10, token = hex8, readMax = {} } = {}) {
    // How much it reads of a transcript a pass (t-2109): its steps, a helper's, its sign of life.
    this.readMax = { activity: ACTIVITY_READ_MAX, helper: HELPER_READ_MAX, sign: SIGN_READ_MAX, final: SIGN_READ_MAX, ...readMax };
    this.readMax.final = Math.max(4, Math.floor(Number(this.readMax.final)) || SIGN_READ_MAX);
    Object.assign(this, { claude, jobsDir, args, usageDir, node, run, sleep, claimPolls, token });
    this.inbox = inboxDir ? inbox(inboxDir, { run }) : null;
    // Claude Code keeps a session's transcript at <config>/projects/<cwd, slugged>/<session>.jsonl (and its tool
    // results beside it, <session>/): the config dir is the jobs dir's parent.
    this.roots = { projects: projectsDir ?? join(dirname(jobsDir), 'projects') };
  }

  sessionFiles(slot, body) {
    const keep = [];
    const session = slot?.session;
    if (typeof session === 'string' && SESSION.test(session)) {
      for (const p of dirs(this.roots.projects)) {
        for (const name of [`${session}.jsonl`, session]) if (existsSync(join(this.roots.projects, p, name))) keep.push({ root: 'projects', rel: join(p, name) });
      }
    }
    if (keep.length && existsSync(this.floorPath(`session-${session}`))) keep.push({ root: 'projects', rel: join('.loom-profile-floors', `session-${session}.json`) });
    const drop = body?.id && /^[A-Za-z0-9-]{4,64}$/.test(body.id) ? [join(this.jobsDir, String(body.id).slice(0, 8))] : [];
    return { keep, drop };
  }

  agents(env) {
    const r = this.run(this.claude, ['agents', '--json', '--all'], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    if (r.status !== 0) return null;
    try { const d = JSON.parse(r.stdout || '[]'); return Array.isArray(d) ? d : null; } catch { return null; }
  }

  job(id) { return readJson(join(this.jobsDir, String(id).slice(0, 8), 'state.json')); }

  /**
   * {tool, what} while `claude agents --json` lists the body waiting on a permission prompt (status waiting, or none,
   * and waitingFor naming one), else null; undefined when the list can't be had (it can't say). The list is asked at
   * most once a WAIT_LOOK_MS per harness (the tick runs every few seconds), or now with `fresh`: before a stop.
   */
  waiting(body, env, { fresh = false } = {}) {
    const key = `${this.claude}\0${this.jobsDir}`;
    let seen = waitLooks.get(key);
    if (fresh || !seen || Date.now() - seen.at >= WAIT_LOOK_MS) {
      const rows = this.agents(env);
      if (!rows) return undefined;
      waitLooks.set(key, (seen = { at: Date.now(), rows }));
    }
    const a = seen.rows.find((x) => x && x.id === body.id);
    if (!a || !['waiting', undefined].includes(a.status) || !/permission/i.test(String(a.waitingFor ?? ''))) return null;
    const found = this.transcriptOf({ ...body, slot: { harness: 'claude', session: a.sessionId ?? this.job(body.id)?.sessionId } });
    return found ? lastToolUse(found) : { tool: '', what: '' };
  }

  floorPath(key) {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new RunnerError('invalid profile floor key');
    return join(this.roots.projects, '.loom-profile-floors', `${key}.json`);
  }
  readFloor(key) {
    try {
      const value = JSON.parse(readFileSync(this.floorPath(key), 'utf8'));
      if (!value || !['deny', 'disabled'].every(k => Array.isArray(value[k]) && value[k].every(x => typeof x === 'string'))) throw new Error('invalid floor');
      return value;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      return { deny: [], disabled: [], unknown: true };
    }
  }
  saveFloor(key, floor) { durableJson(this.floorPath(key), floor); }

  bindFloor(token, id, session) {
    const floor = this.readFloor(`launch-${token}`);
    if (!floor) return;
    this.saveFloor(`body-${id}`, floor);
    if (session) this.saveFloor(`session-${session}`, floor);
  }

  launch({ brief, model, cwd, env, deny = [], resume, launchToken }) {
    const token = launchToken === undefined ? this.token() : stableLaunchToken(launchToken);
    const incoming = env ?? process.env;
    const selected = selectedProfile(incoming);
    let floor = selected ? (resume ? this.readFloor(`session-${resume}`) : { deny: [], disabled: [] }) : null;
    if (selected && (!floor || floor.unknown)) {
      incoming.LOOM_BODY_PROFILE = JSON.stringify(minimalProfile());
      incoming.LOOM_BODY_PROFILE_PROBLEM = 'JOB PROFILE PROBLEM: continuation has no saved source restriction floor; using minimal profile (no tools, MCP, skills or secrets).';
      floor = { deny: floor?.deny ?? [], disabled: floor?.disabled ?? [], unknown: true };
    }
    const effective = isWork(incoming) ? restrictedEnv(incoming, selectedProfile(incoming)) : incoming;
    if (profileNotice(effective)) brief = `${profileNotice(effective)}\n\n${brief}`;
    const nl = brief.indexOf('\n');
    const prompt = nl < 0 ? `${brief}\n${ClaudeRunner.TOKEN_LINE.replace('{token}', token)}\n`
      : `${brief.slice(0, nl)}\n${ClaudeRunner.TOKEN_LINE.replace('{token}', token)}\n${brief.slice(nl + 1)}`;
    // A Codex body's key, inherited by a launcher started under one: a Claude body must never key its inbox on it.
    // Nor a Codex thread's id (a launcher running under Codex has one): `send` names a Claude body's own session.
    const { SHUTTLE_BODY: _drop, CODEX_THREAD_ID: _thread, ...clean } = effective;
    if (isWork(clean) && this.args.length) throw new RunnerError('job profiles cannot combine custom Claude arguments');
    const before = new Set((this.agents(clean) ?? []).map((a) => a.id));
    const workArgs = claudeWorkArgs(clean, cwd, this.jobsDir, floor ?? undefined);
    if (floor) { floor.deny = [...new Set([...floor.deny, ...deny])]; this.saveFloor(`launch-${token}`, floor); }
    const argv = ['--bg', ...(model ? ['--model', model] : []), ...this.statusLine(), ...this.args, ...workArgs, ...(deny.length ? ['--disallowedTools', ...deny] : []), ...(resume ? ['--resume', resume] : [])];
    const r = this.run(this.claude, argv, { cwd, env: clean, input: prompt, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
    if (r.error || r.status !== 0) {
      const message = `claude --bg didn't start: ${(r.stderr || r.error?.message || '').trim().split('\n').pop() || `exit ${r.status}`}`;
      throw ['ENOENT', 'EACCES', 'ENOEXEC'].includes(r.error?.code) ? neverStarted(message) : new RunnerError(message);
    }
    // Claim: a new agent whose job intent carries this launch's token.
    const marker = `(bridge spawn token ${token}:`;
    for (let i = 0; i < this.claimPolls; i++) {
      // A resumed session comes back under the job id it had (Claude Code's id is its session's), so for a resume an id
      // seen before is a candidate too (t-1881): the token in its job's intent, this launch's alone, is what claims it.
      // By id, once: the agents list can carry that id twice (the old job's row and the resumed one's), still one body.
      const found = [...new Map((this.agents(clean) ?? []).filter((a) => a.id && (resume || !before.has(a.id)) && (this.job(a.id)?.intent ?? '').includes(marker)).map((a) => [a.id, a])).values()];
      if (found.length === 1) {
        const a = found[0];
        const session = a.sessionId ?? this.job(a.id)?.sessionId;
        this.bindFloor(token, a.id, session);
        const body = { id: a.id, harness: 'claude', model, ...(session ? { slot: { harness: 'claude', session } } : {}) };
        this.inbox?.open(a.id, { venue: 'runtime', chan: a.id, bridge: 'runtime' });
        return body;
      }
      if (found.length > 1) throw new RunnerError(`${found.length} new bodies carry one launch's token; claiming none`);
      this.sleep(1000);
    }
    throw new RunnerError('claude --bg started nothing this runner could find');
  }

  /**
   * How a body's usage is read: its status line (statusline.mjs), which Claude Code runs for a background session too,
   * keeping the session's rate_limits in usageDir. Not when the runtime's args bring their own --settings (Claude
   * Code takes one), and never with a path a shell would read as more than a word.
   */
  statusLine() {
    if (!this.usageDir || this.args.includes('--settings')) return [];
    const script = fileURLToPath(new URL('./statusline.mjs', import.meta.url));
    if (![this.node, script, this.usageDir].every((p) => /^\/[A-Za-z0-9._\/+-]+$/.test(p))) return [];
    return ['--settings', JSON.stringify({ statusLine: { type: 'command', command: `${this.node} ${script} ${this.usageDir}` } })];
  }

  usage(body) {
    const session = this.slotOf(body)?.session;
    return session ? keptReading(this.usageDir, session) : null;
  }

  start(o) { return this.launch(o); }
  /** Observe a prior admission, without submitting another daemon request or
   * reopening (and thereby clearing) an inbox that native work may already use. */
  recoverLaunch(launchToken, { model, env } = {}) {
    const token = stableLaunchToken(launchToken);
    const rows = this.agents(env);
    if (!rows) return { state: 'pending' };
    const marker = `(bridge spawn token ${token}:`;
    const found = [...new Map(rows.filter(a => a?.id && (this.job(a.id)?.intent ?? '').includes(marker)).map(a => [a.id, a])).values()];
    if (found.length !== 1) return { state: 'pending' };
    const a = found[0], session = a.sessionId ?? this.job(a.id)?.sessionId;
    this.bindFloor(token, a.id, session);
    return { state: 'ready', body: { id: a.id, harness: 'claude', model, ...(session ? { slot: { harness: 'claude', session } } : {}) } };
  }
  resume(slot, o) {
    if (slot?.harness !== 'claude' || !slot.session) throw new RunnerError('a Claude body resumes from a Claude slot (its session)');
    return this.launch({ ...o, resume: slot.session });
  }
  feed(body, message) { return feedVia(this, body, message); }

  status(body) {
    const job = this.job(body.id);
    if (!job) return 'unknown';
    return turnOver(job) ? 'idle' : 'working';
  }

  stopped(body) {
    return ['done', 'stopped', 'failed', 'blocked'].includes(this.job(body.id)?.state);
  }

  /**
   * Its job's state says failed; its timeline (<jobs>/<id8>/timeline.jsonl) has a line for what it was doing at each
   * step while it worked ("Reading …", "Running …"): any such line is tool work.
   */
  turn(body) {
    const job = this.job(body.id);
    if (!job || !turnOver(job)) return null;
    const tl = lines(join(this.jobsDir, String(body.id).slice(0, 8), 'timeline.jsonl'));
    const worked = tl.length ? tl.some((l) => l.state === 'working' && typeof l.detail === 'string' && l.detail.trim() !== '') : null;
    const out = { failed: job.state === 'failed', worked, ...(job.state === 'failed' && typeof job.detail === 'string' && job.detail ? { error: job.detail.slice(0, 200) } : {}) };
    // Refused for a usage limit: its transcript's last entry is Claude Code's API error (t-1907).
    const f = this.transcriptOf(body);
    const reading = this.usage(body);
    const refused = f ? lastRefusal('claude', tailOf(f)) : null;
    if (refused) {
      const until = refusedUntil(reading);
      Object.assign(out, { failed: true, limited: true, error: out.error ?? `its provider refused it (${refused.code})`, ...(until ? { resets: until } : {}) });
    }
    return out;
  }

  context(body) {
    const f = this.transcriptOf(body);
    return f ? lastContext('claude', tailOf(f, 1024 * 1024)) : null;
  }

  /**
   * Its last words: the text of its transcript's last assistant message that has any. Read as the transcript grows
   * (t-2138), from where the last call of this process stopped (FINAL_MEMO), in slices of at most readMax.final: a
   * body host asks each beat, and a long session is read whole once, never every beat.
   */
  final(body, retry = 0) {
    const f = this.transcriptOf(body);
    if (!f) return null;
    let fd, st, checkpoint;
    try {
      checkpoint = openFinalCheckpoint(this.jobsDir, body, this.slotOf(body)?.session, f);
      fd = openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      st = fstatSync(fd);
      if (!st.isFile()) return null;
    let m = FINAL_MEMO.get(f) ?? (retry === 0 ? loadFinalCheckpoint(checkpoint) : null);
    const previousOffset = m?.offset, previousSize = m?.size;
    // Another file at that path, or one cut shorter, is read again from its start.
    if (!m || m.ino !== st.ino || m.dev !== st.dev || st.size < (m.size ?? m.offset)) m = { ino: st.ino, dev: st.dev, offset: 0, rest: '', last: null };
    while (st.size > m.offset) {
      const { text, next } = readFrom(f, m.offset, Math.min(this.readMax.final, st.size - m.offset), fd);
      if (next === m.offset) break;
      const parts = (m.rest + text).split('\n');
      const tail = parts.pop() ?? '';
      if (m.skipping) {
        if (parts.length) { parts.shift(); m.skipping = false; }
        else { m.rest = ''; m.offset = next; continue; }
      }
      m.rest = Buffer.byteLength(tail) > REST_MAX ? '' : tail;
      for (const l of parts) {
        if (Buffer.byteLength(l) > REST_MAX) { m.omitted = true; continue; }
        const w = lastWordsOf(l);
        if (w !== null) { m.last = w; m.omitted = false; }
      }
      if (Buffer.byteLength(tail) > REST_MAX) { m.skipping = true; m.omitted = true; }
      m.offset = next;
    }
    // A last line not yet ended (no newline after it) counts once it's whole JSON, as reading the file whole did.
    const completeTail = m.rest ? lastWordsOf(m.rest) : null;
    if (completeTail !== null) { m.omitted = false; m.last = completeTail; }
    const last = completeTail ?? m.last;
    // One descriptor supplies the snapshot. Never commit old words after replacement or shortening during the scan.
    const after = lstatSync(f);
    if (!after.isFile() || after.ino !== st.ino || after.dev !== st.dev || after.size < st.size) {
      FINAL_MEMO.delete(f);
      return retry < 1 ? this.final(body, retry + 1) : null;
    }
    m.size = st.size;
    if (checkpoint && (m.savedKey !== checkpoint.key || previousOffset !== m.offset || previousSize !== m.size)) {
      if (saveFinalCheckpoint(checkpoint, m)) m.savedKey = checkpoint.key;
    }
    FINAL_MEMO.delete(f); FINAL_MEMO.set(f, m);
    if (FINAL_MEMO.size > 64) FINAL_MEMO.delete(FINAL_MEMO.keys().next().value);
    return m.omitted ? `… (transcript line exceeded 16 MiB; last readable words follow)\n${last ?? ''}` : last;
    } catch { FINAL_MEMO.delete(f); return null; }
    finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
      closeFinalCheckpoint(checkpoint);
    }
  }

  /** Forget derived words when the job retires, including slot-only expiry after interrupted retirement. */
  forgetFinal(slot, body) {
    const session = slot?.session ?? (body ? this.slotOf(body)?.session : null);
    if (session) {
      for (const f of FINAL_MEMO.keys()) if (f.endsWith(`/${session}.jsonl`)) FINAL_MEMO.delete(f);
    }
    if (session || body) dropFinalCheckpoints(this.jobsDir, session, body);
  }

  /** Its session's transcript, the newest of that name under projects; null when there's none. */
  transcriptOf(body) {
    const session = this.slotOf(body)?.session;
    if (typeof session !== 'string' || !SESSION.test(session)) return null;
    return dirs(this.roots.projects).map((p) => join(this.roots.projects, p, `${session}.jsonl`)).filter((f) => existsSync(f))
      .sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0] ?? null;
  }

  slotOf(body) {
    const session = this.job(body.id)?.sessionId ?? body.slot?.session;
    if (session && body.id) {
      const floor = this.readFloor(`body-${body.id}`);
      if (floor) this.saveFloor(`session-${session}`, floor);
    }
    return session ? { harness: 'claude', session } : null;
  }

  /**
   * Its tool steps as activity cards (activity.mjs), from its session's transcript: only ever asked for a body in a
   * Comms thread. Tool-use ids are unique across sessions, so they need no prefix.
   */
  tickerAction(body) {
    const session = this.slotOf(body)?.session;
    if (typeof session !== 'string' || !SESSION.test(session)) return 'Working';
    for (const p of dirs(this.roots.projects)) {
      const f = join(this.roots.projects, p, `${session}.jsonl`);
      if (existsSync(f)) return claudeActionNow(tickerLines(f));
    }
    return 'Working';
  }

  activity(body) {
    const f = this.transcriptOf(body);
    if (!f) return [];
    // Its newest ACTIVITY_READ_MAX of transcript, never the whole of a long session each pass. A step whose start is
    // older than that and whose end lands inside it stays as last told (its end can't be matched).
    const cards = claudeCards(jsonLines(tailOf(f, this.readMax.activity) ?? ''));
    // Its helpers (subagents), each under the step that started it (t-2109): Claude Code keeps a helper's transcript
    // beside the session's, `<session>/subagents/agent-<id>.jsonl`, and its meta names that step (`toolUseId`)
    // (measured 2026-11-10 on this machine: `agent-<17 hex>.meta.json` = {agentType, isBuiltIn, description, toolUseId,
    // spawnDepth, requestShape, …, finished}). A layout it doesn't find leaves the session's own steps, never fewer.
    const dir = join(f.slice(0, -'.jsonl'.length), 'subagents');
    let metas = [];
    // The body writes there: a meta is only ever a plain file, never followed through a link, read to META_MAX.
    try { metas = readdirSync(dir).slice(0, 500).filter((n) => /^agent-[A-Za-z0-9_-]{1,64}\.meta\.json$/.test(n)); } catch { return cards; }
    const helpers = metas.map((n) => { try { const st = lstatSync(join(dir, n)); if (!st.isFile()) return null; let t = st.mtimeMs; try { const transcript = lstatSync(join(dir, n.replace('.meta.json', '.jsonl'))); if (transcript.isFile()) t = transcript.mtimeMs; } catch { /* no transcript */ } return { n, t }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.t - a.t).slice(0, 20);
    for (const { n } of helpers) {
      const agent = n.slice('agent-'.length, -'.meta.json'.length);
      let meta;
      try { meta = JSON.parse(readFrom(join(dir, n), 0, META_MAX).text); } catch { continue; }
      // Its step, when the session's window still holds it; else its steps stand on their own (never dropped).
      const parent = typeof meta?.toolUseId === 'string' && cards.some((c) => c.id === meta.toolUseId) ? meta.toolUseId : null;
      // A helper's transcript is read from its end, at most HELPER_READ_MAX: its newest steps.
      cards.push(...claudeCards(jsonLines(tailOf(join(dir, `agent-${agent}.jsonl`), this.readMax.helper) ?? ''), `${agent}:`, parent ?? undefined));
    }
    // In the order they happened, so a host's "newest 100" keeps the newest of the body's and its helpers' alike.
    return cards.map((c, i) => [c, i]).sort((x, y) => ((Date.parse(x[0].at) || 0) - (Date.parse(y[0].at) || 0) || x[1] - y[1])).map(([c]) => c);
  }


  /**
   * Its last sign of life (t-2109): when its transcript was last written, and how many tokens it has written so far
   * (each assistant message's output_tokens once, its largest). Read as it grows, at most SIGN_READ_MAX a pass, from
   * where the last pass of this process stopped (SIGN_MEMO); its tokens are said only once it's caught up.
   */
  signOfLife(body) {
    const f = this.transcriptOf(body);
    if (!f) return null;
    let st;
    try { st = lstatSync(f); if (!st.isFile()) return null; } catch { return null; }
    // Kept for the process, by file: a body host makes a runner each beat, so a memo of its own would start over.
    const memos = SIGN_MEMO;
    let m = memos.get(f);
    if (!m || st.ino !== m.ino || st.dev !== m.dev || st.size < (m.size ?? m.offset)) m = { ino: st.ino, dev: st.dev, offset: 0, seen: new Map(), rest: '' };
    if (st.size > m.offset) {
      const { text, next } = readFrom(f, m.offset, this.readMax.sign);
      const parts = (m.rest + text).split('\n');
      // The last part is a line not yet ended: kept for the next read (dropped if it's grown past any real line).
      const last = parts.pop() ?? '';
      m.rest = last.length > REST_MAX ? '' : last;
      for (const l of parts) { try { claudeTokens([JSON.parse(l)], m.seen); } catch { /* not a line of JSON */ } }
      m.offset = next;
    }
    m.size = st.size;
    memos.delete(f); memos.set(f, m);
    if (memos.size > 64) memos.delete(memos.keys().next().value);
    let tokens = 0;
    for (const n of m.seen.values()) tokens += n;
    // Its tokens only once it's read to the end: a count of part of it isn't its total.
    return { at: new Date(st.mtimeMs).toISOString(), ...(m.seen.size && m.offset >= st.size ? { tokens } : {}) };
  }

  end(body, env) {
    this.run(this.claude, ['stop', body.id], { env, stdio: 'ignore', timeout: 20_000 });
    this.inbox?.close(body.id);
  }
}

/**
 * Whether a background job's turn is over. Its state is terminal (done, stopped, failed, blocked), or its tempo is idle
 * with nothing in flight. Claude Code leaves a turn that ended on "I'll check back", "waiting on CI" or "result, then
 * next: …" as state working, tempo idle (t-1764, 2026-11-03: every delivered wake's body read as mid-turn for good, so it
 * never reported its usage and its house never idled out). Mid-turn its tempo is active.
 */
function turnOver(job) {
  if (['done', 'stopped', 'failed', 'blocked'].includes(job.state)) return true;
  const f = job.inFlight ?? {};
  return job.tempo === 'idle' && !(f.tasks > 0) && !(f.queued > 0) && !(f.drainableMonitors > 0);
}

// The env keys a Claude Code launcher leaves behind: a Codex body must not look like a Claude session to its tools.
const scrub = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE' && k !== 'CLAUDE_JOB_DIR'));

/**
 * A body's deny list (Claude Code's tool names), as Codex can keep it (t-1907, t-1916): whole MCP servers, by name.
 *   mcp__<server>   left out of the Codex home the runner makes for the body (CodexRunner.homeFor), so no config Codex
 *                   reads for it defines the server; and, a second layer, `-c mcp_servers.<server>={enabled=false,
 *                   command="false"}` on its command line. A stub, not a bare `enabled=false`: Codex refuses a server
 *                   entry with no transport ("invalid transport", codex-cli 0.162.1), and the server is defined nowhere.
 * Anything else (one tool of a server, mcp__<server>__<tool>, or a built-in like Bash) Codex can't be trusted to keep:
 * an error, and no body. Delivery avoids Codex for such a body and says so. → {args, denied} | {error}.
 */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export function codexDeny(deny) {
  const off = new Set();
  const bad = [];
  for (const d of deny ?? []) {
    const name = String(d).startsWith('mcp__') ? String(d).slice(5) : null;
    // A server's name can hold single underscores (claude_ai_Gmail); a double one is a tool within it.
    if (!name || name.includes('__') || !SERVER_NAME.test(name)) { bad.push(String(d)); continue; }
    off.add(name);
  }
  if (bad.length) return { error: `the codex runner can't deny ${bad.join(', ')} (it turns off whole MCP servers, nothing else): refusing to start a body that would keep them` };
  const args = [];
  for (const s of [...off].sort()) args.push('-c', `mcp_servers.${s}={enabled=false, command="false"}`);
  return { args, denied: off };
}

/**
 * The config layers Codex reads besides its home's own config.toml, which no CODEX_HOME replaces (Codex's docs,
 * t-1916: https://learn.chatgpt.com/docs/config-file/config-basic, …/config-advanced,
 * https://learn.chatgpt.com/codex/enterprise/managed-configuration): the machine's /etc/codex/config.toml, its managed
 * defaults (managed_config.toml, which win over `-c`) and requirements (requirements.toml); and a project's
 * .codex/config.toml, in every dir from the project root (the nearest dir above the cwd with a .git; else the cwd)
 * down to the cwd. No documented flag turns them off (`codex exec --ignore-user-config` skips only the home's), and
 * Codex reads a project's whether or not the project is trusted (codex-cli 0.162.1, checked 2026-11-06 with a
 * throwaway home). So they're never parsed here, only looked for: from the cwd up to /, whatever the root, and in
 * /etc/codex. The one exception is the real Codex home's own config.toml (`realHome`, the one the made home replaces)
 * when it sits above the project root, where Codex never reads it as a project's: ~/.codex above ~/Art.
 * → the paths found ([] for none). A path that can't be looked at counts as found.
 */
export function codexLayers(cwd, { realHome, systemDir = '/etc/codex' } = {}) {
  const there = (p) => { try { lstatSync(p); return true; } catch (e) { return !['ENOENT', 'ENOTDIR'].includes(e.code); } };
  const dirsUp = [];
  for (let d = resolve(cwd ?? process.cwd()); ; d = dirname(d)) { dirsUp.push(d); if (dirname(d) === d) break; }
  const rootAt = dirsUp.findIndex((d) => there(join(d, '.git')));
  const found = [];
  dirsUp.forEach((d, i) => {
    const f = join(d, '.codex', 'config.toml');
    const aboveRoot = i > (rootAt < 0 ? 0 : rootAt);
    if (aboveRoot && realHome && resolve(realHome) === join(d, '.codex')) return;
    if (there(f)) found.push(f);
  });
  for (const n of ['config.toml', 'managed_config.toml', 'requirements.toml']) if (there(join(systemDir, n))) found.push(join(systemDir, n));
  return found;
}

/** What a made Codex home links from the real one: its login, and what tells the body how to work. Never its config. */
// The login is linked, never read: its file's name is logins.mjs's (CRED_FILE), which moves it between homes unread.
const HOME_LINKS = [CRED_FILE.codex, 'AGENTS.md', 'skills', 'rules'];
/**
 * How a Codex runner's refusal to run a body begins (plan), here or in a house, where it comes back as a failed start:
 * delivery reads it to start that body again off Codex, in the same drain (t-1924).
 */
const CODEX_WONT_WORDS = "codex won't run this body here: ";
export const CODEX_WONT = /^codex won't run this body here: /;

/** A made home's name (homeIdOf), and how new a run dir is that counts as a body starting (sweepHomes). */
const HOME_ID = /^[0-9a-f]{16}$/;
const HOME_GRACE_MS = 10 * 60_000;

/**
 * Codex, `codex exec --json`: a body is one process, started in its own session with the brief on stdin, its events
 * in <runs>/<key>/events.jsonl. Its id is a key picked at launch (so its env can carry it as SHUTTLE_BODY for the
 * inbox hook); the thread id Codex reports first is its slot (`codex exec resume <thread>`). Files, not pipes, so a
 * body outlives whatever started it.
 *
 * A deny list is kept by construction (t-1916): every body runs with CODEX_HOME set to a home this runner makes
 * (homeFor), whose config.toml it writes itself with only the MCP servers the body may use, read from the real
 * home's config (a TOML parse; nothing else carries over: no profiles, no other keys). The real home is the body
 * env's CODEX_HOME, else this runner's `codexHome`. The made home links the real one's login and instructions
 * (HOME_LINKS), and its sessions dir is this runner's (roots.sessions), so resume, usage and session files read
 * where Codex writes. A config layer no CODEX_HOME replaces (codexLayers) refuses a body with a deny list.
 */
export class CodexRunner {
  harness = 'codex';

  constructor({ codex = 'codex', profile, runsDir = join(homedir(), '.local', 'share', 'loom-runtime', 'codex-runs'), codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), sessionsDir, homesDir, systemDir = '/etc/codex', inboxDir, spawn = nodeSpawn, run = spawnSync, key = hex8 } = {}) {
    Object.assign(this, { codex, profile, runsDir, codexHome, systemDir, spawn, run, key });
    this.homesDir = homesDir ?? join(dirname(runsDir), 'codex-homes');
    this.inbox = inboxDir ? inbox(inboxDir, { run }) : null;
    // Codex keeps a thread's rollout at <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<when>-<thread>.jsonl: every made
    // home's sessions is a link to this one.
    this.roots = { sessions: sessionsDir ?? join(codexHome, 'sessions') };
  }

  sessionFiles(slot, body) {
    const keep = [];
    const thread = slot?.session;
    if (typeof thread === 'string' && SESSION.test(thread)) {
      const walk = (rel, depth) => {
        for (const n of dirs(join(this.roots.sessions, rel), true)) {
          const r = join(rel, n);
          if (depth < 3) walk(r, depth + 1);
          else if (n.endsWith(`-${thread}.jsonl`)) keep.push({ root: 'sessions', rel: r });
        }
      };
      walk('', 0);
    }
    const drop = body?.id && /^[A-Za-z0-9-]{4,64}$/.test(body.id) ? [join(this.runsDir, body.id)] : [];
    return { keep, drop };
  }

  launch({ brief, model, cwd, env, deny = [], resume, launchToken }) {
    const plan = this.plan(deny, cwd, env);
    if (plan.why) throw neverStarted(plan.why);
    const key = launchToken === undefined ? this.key() : stableLaunchToken(launchToken);
    const dir = join(this.runsDir, key);
    if (launchToken !== undefined && existsSync(dir)) throw new RunnerError('durable Codex launch already exists; recover its original admission');
    // Its run dir names its home before the home is made, under the homes' lock: a sweep never takes a home a body is
    // starting in (t-1924).
    const home = this.homesLocked(() => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, 'home'), `${this.homeIdOf(plan)}\n`, { mode: 0o600 });
      return this.homeFor(plan);
    });
    const e = { ...scrub(env ?? process.env), CODEX_HOME: home, SHUTTLE_BODY: key, ...(this.inbox ? { SHUTTLE_INBOX_DIR: this.inbox.dir } : {}) };
    const argv = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox',
      ...(model ? ['-m', model] : []), ...plan.args, '-C', cwd ?? process.cwd(), '-o', join(dir, 'last.txt'),
      ...(resume ? ['resume', resume] : []), '-'];
    const out = openSync(join(dir, 'events.jsonl'), 'a', 0o600);
    const err = openSync(join(dir, 'stderr.txt'), 'a', 0o600);
    let child;
    try {
      child = this.spawn(this.codex, argv, { cwd, env: e, stdio: ['pipe', out, err], detached: true });
    } finally { closeSync(out); closeSync(err); }
    child.on?.('error', () => {});
    if (!child.pid) throw neverStarted(`codex didn't start (${this.codex})`);
    writeFileSync(join(dir, 'pid'), `${child.pid}\n`, { mode: 0o600 });
    child.stdin.on('error', () => {});
    let inputReady;
    if (launchToken !== undefined) {
      inputReady = new Promise((resolve, reject) => {
        child.stdin.once('error', reject);
        child.stdin.end(brief, error => error ? reject(error) : resolve());
      });
    } else child.stdin.end(brief);
    child.unref();
    this.inbox?.open(key, { venue: 'runtime', chan: key, bridge: 'runtime' });
    return { id: key, harness: 'codex', model, ...(inputReady ? { inputReady } : {}), ...(resume ? { slot: { harness: 'codex', session: resume } } : {}) };
  }

  /**
   * What a body here would run with: {src, servers, args} (its real home, the MCP servers it may use, the `-c`s that
   * turn the denied ones off), or {why} it won't run here. LOOM_RUNTIME_CODEX_PROFILE isn't supported (set, every
   * body is refused, said so: a profile's own servers would come back on); a deny list Codex can't keep (codexDeny);
   * with a deny list, a config layer the made home can't replace (codexLayers); a real config that can't be read.
   */
  plan(deny, cwd, env) {
    const p = this.planOf(deny, cwd, env);
    return p.why ? { why: `${CODEX_WONT_WORDS}${p.why}` } : p;
  }

  planOf(deny, cwd, env) {
    if (isWork(env)) return { why: "work profiles don't support Codex yet; refusing launch instead of widening the profile" };
    if (this.profile) return { why: `LOOM_RUNTIME_CODEX_PROFILE is set (${String(this.profile).slice(0, 64)}): a Codex profile can turn a denied tool server back on, so the codex runner runs no body under one; unset it` };
    const off = codexDeny(deny);
    if (off.error) return { why: off.error };
    const { denied } = off;
    const src = resolve(env?.CODEX_HOME || this.codexHome);
    if (denied.size) {
      const layers = codexLayers(cwd, { realHome: src, systemDir: this.systemDir });
      if (layers.length) return { why: `Codex would read ${layers.join(', ')} too, a config the runtime can't replace, which could turn a denied tool server back on: refusing a body with a deny list here (remove it, or keep this agent off Codex)` };
    }
    let conf = {};
    const f = join(src, 'config.toml');
    try { conf = parseToml(readFileSync(f, 'utf-8')); } catch (e) {
      if (e.code !== 'ENOENT') return { why: `the codex runner can't read ${f} for the tool servers a body may use (${String(e.message).split('\n')[0].slice(0, 120)}): refusing to start one` };
    }
    const all = conf.mcp_servers && typeof conf.mcp_servers === 'object' && !Array.isArray(conf.mcp_servers) ? conf.mcp_servers : {};
    const servers = Object.fromEntries(Object.entries(all).filter(([n]) => !denied.has(n)));
    return { src, servers, args: off.args };
  }

  /** Why this runner won't start a body here, or null: what delivery reads to keep the body off Codex. */
  wontRun(deny, cwd, env) { return this.plan(deny, cwd, env).why ?? null; }

  /**
   * The Codex home for a body (0700): one per real home and deny list, under homesDir, so bodies alike share one and
   * Codex's own state there (its thread database) carries from run to run. Its config.toml is written each launch
   * (whole, 0600, renamed into place): the allowed servers, as the real config has them now. Its links: the real
   * home's login and instructions (HOME_LINKS, where they exist) and this runner's sessions dir.
   */
  homeFor({ src, servers, args }) {
    const home = join(this.homesDir, this.homeIdOf({ src, args }));
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    const tmp = join(home, `.config.toml.${process.pid}.${hex8()}`);
    writeFileSync(tmp, `# Written by loom's runtime for its Codex bodies (runners.mjs, CodexRunner.homeFor): only the MCP servers\n# a body may use, from ${join(src, 'config.toml')}. Rewritten at each start; edit that one.\n\n${Object.keys(servers).length ? stringifyToml({ mcp_servers: servers }) : ''}`, { mode: 0o600 });
    renameSync(tmp, join(home, 'config.toml'));
    mkdirSync(this.roots.sessions, { recursive: true, mode: 0o700 });
    const links = [...HOME_LINKS.filter((n) => existsSync(join(src, n))).map((n) => [n, join(src, n)]), ['sessions', resolve(this.roots.sessions)]];
    for (const [n, to] of links) {
      const at = join(home, n);
      let cur = null;
      try { cur = readlinkSync(at); } catch { /* none, or not a link */ }
      if (cur === to) continue;
      // Whatever else is there is moved aside, never deleted: a real dir at `sessions` may hold a body's rollouts.
      if (cur === null && existsSync(at)) renameSync(at, `${at}.aside-${Date.now()}-${hex8()}`);
      else rmSync(at, { force: true });
      symlinkSync(to, at);
    }
    return home;
  }

  /** A made home's name: one per real home and deny list. */
  homeIdOf({ src, args }) { return createHash('sha256').update(JSON.stringify([src, args])).digest('hex').slice(0, 16); }

  /** The made homes' lock (homesDir/lock): a launch naming its home, and a sweep, never at once. */
  homesLocked(f) { return withLock(this.homesDir, 'lock', f, 'the codex homes', 10_000); }

  /**
   * The made homes no live body uses, deleted (t-1924): each holds a copy of its tool servers' credentials. A home is
   * in use while a run dir names it (its `home` file) and that run's codex is alive, or the run dir is new (a body
   * starting). Run with every body's end (sessions.mjs, dropSession) and on the runtime's tick. A body's resume makes
   * its home again (homeFor), and Codex resumes a thread from its rollout, in the shared sessions dir, in a home it
   * has never seen (codex-cli 0.162.1, checked 2026-11-07). A live run dir with no `home` file (a body an older
   * runtime started) stops the sweep: what it uses can't be told. A home with something moved aside in it (homeFor)
   * keeps that, and loses only its config. → the names deleted.
   */
  sweepHomes({ now = Date.now(), graceMs = HOME_GRACE_MS } = {}) {
    if (!existsSync(this.homesDir)) return [];
    return this.homesLocked(() => {
      const used = new Set();
      for (const id of this.ids()) {
        const dir = join(this.runsDir, id);
        let young = false;
        try { young = now - statSync(dir).mtimeMs < graceMs; } catch { continue; }
        if (!young && !this.alive(id)) continue;
        let h = '';
        try { h = readFileSync(join(dir, 'home'), 'utf-8').trim(); } catch { /* none */ }
        if (!HOME_ID.test(h)) return [];
        used.add(h);
      }
      const gone = [];
      for (const n of dirs(this.homesDir)) {
        if (!HOME_ID.test(n) || used.has(n)) continue;
        const at = join(this.homesDir, n);
        if (dirs(at, true).some((x) => x.includes('.aside-'))) { rmSync(join(at, 'config.toml'), { force: true }); continue; }
        rmSync(at, { recursive: true, force: true });
        gone.push(n);
      }
      return gone;
    });
  }

  start(o) { return this.launch(o); }
  /** Recover the stable native run without launching. If its registrar died
   * between spawn and pid registration, inspect the exact private output path
   * in proc internally. No argv or brief leaves this method. */
  recoverLaunch(launchToken, { model } = {}) {
    const key = stableLaunchToken(launchToken), dir = join(this.runsDir, key);
    if (!existsSync(dir)) return { state: 'pending' };
    if (!this.alive(key)) {
      const found = [];
      for (const pid of dirs('/proc').filter(p => /^\d+$/.test(p))) {
        try { if (readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from(dir))) found.push(Number(pid)); } catch { /* exited or inaccessible: no proof */ }
      }
      if (found.length > 1) return { state: 'pending' };
      if (found.length === 1) writeFileSync(join(dir, 'pid'), String(found[0]) + '\n', { mode: 0o600 });
    }
    if (!this.alive(key)) {
      const pid = Number(readJson(join(dir, 'pid')) ?? NaN);
      let gone = false;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (error) { gone = error.code === 'ESRCH'; }
      }
      // Events alone do not establish that an unregistered writer stopped.
      // A failed proc observation (including access denial) cannot release it.
      if (!gone || !this.events(key).length) return { state: 'pending' };
    }
    const slot = this.slotOf({ id: key });
    return { state: 'ready', body: { id: key, harness: 'codex', model, ...(slot ? { slot } : {}) } };
  }
  resume(slot, o) {
    if (slot?.harness !== 'codex' || !slot.session) throw new RunnerError('a Codex body resumes from a Codex slot (its thread)');
    return this.launch({ ...o, resume: slot.session });
  }
  feed(body, message) { return feedVia(this, body, message); }

  context(body) {
    for (const k of this.sessionFiles(this.slotOf(body)).keep) {
      const got = lastContext('codex', tailOf(join(this.roots[k.root], k.rel), 1024 * 1024));
      if (got) return got;
    }
    return null;
  }

  /** Its thread's rollout (where Codex writes token_count; `exec --json` doesn't): the last reading in its end. */
  usage(body) {
    for (const k of this.sessionFiles(this.slotOf(body)).keep) {
      const f = join(this.roots[k.root], k.rel);
      const text = tailOf(f);
      const got = text === null ? null : lastRateLimit('codex', text);
      if (got) { let checked; try { checked = Math.floor(statSync(f).mtimeMs / 1000); } catch { /* gone */ } return { ...got, ...(checked ? { checked } : {}) }; }
    }
    return null;
  }

  /** Its tool steps as activity cards (activity.mjs), from its events: item ids repeat per run, so they carry its id. */
  tickerAction(body) { return codexActionNow(tickerLines(join(this.runsDir, body.id, 'events.jsonl'))); }

  activity(body) {
    // Its newest ACTIVITY_READ_MAX of events (t-2109), never the whole of a long run each pass.
    const file = join(this.runsDir, body.id, 'events.jsonl');
    let stat;
    try { stat = statSync(file); } catch { return []; }
    let memo = CODEX_CARD_TIMES.get(file);
    if (!memo || memo.ino !== stat.ino || stat.size < memo.size) memo = {ino: stat.ino, times: new Map()};
    memo.size = stat.size;
    // Codex events have no timestamp: keep when each card was first observed, never retime old cards on a reread.
    const at = new Date().toISOString();
    const cards = codexCards(jsonLines(tailOf(file, ACTIVITY_READ_MAX) ?? ''), `${body.id}:`, (id) => {
      if (!memo.times.has(id)) memo.times.set(id, at);
      return memo.times.get(id);
    });
    const retained = new Set(cards.slice(-1000).map(c => c.id));
    for (const id of memo.times.keys()) if (!retained.has(id)) memo.times.delete(id);
    CODEX_CARD_TIMES.delete(file); CODEX_CARD_TIMES.set(file, memo);
    if (CODEX_CARD_TIMES.size > 64) CODEX_CARD_TIMES.delete(CODEX_CARD_TIMES.keys().next().value);
    return cards;
  }

  /** Its last sign of life (t-2109): when its events were last written. Codex says its tokens only at a turn's end. */
  signOfLife(body) {
    try { return { at: new Date(statSync(join(this.runsDir, body.id, 'events.jsonl')).mtimeMs).toISOString() }; } catch { return null; }
  }

  events(id) {
    try {
      return readFileSync(join(this.runsDir, id, 'events.jsonl'), 'utf-8').split('\n').flatMap((l) => { try { const e = JSON.parse(l); return e && typeof e === 'object' ? [e] : []; } catch { return []; } });
    } catch { return []; }
  }

  /** Its process is still this run's codex: a recycled pid's argv doesn't name this run's dir. */
  alive(id) {
    const dir = join(this.runsDir, id);
    const pid = Number(readJson(join(dir, 'pid')) ?? NaN);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { return readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from(dir)); } catch { return false; }
  }

  stopped(body) { return !this.alive(body.id); }

  status(body) {
    if (!existsSync(join(this.runsDir, body.id))) return 'unknown';
    const ev = this.events(body.id);
    const over = ev.some((e) => e.type === 'turn.completed' || e.type === 'turn.failed');
    if (this.alive(body.id) && !over) return 'working';
    return over ? 'idle' : 'ended';
  }

  /** Its events: turn.failed (and its error), and any tool item (a command, an MCP call, a file change, a search). */
  turn(body) {
    const ev = this.events(body.id);
    const end = ev.find((e) => e.type === 'turn.completed' || e.type === 'turn.failed');
    if (!end) return null;
    const worked = ev.some((e) => e.type === 'item.completed' && ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(e.item?.type));
    const err = end.type === 'turn.failed' ? String(end.error?.message ?? end.error ?? '').slice(0, 200) : '';
    const out = { failed: end.type === 'turn.failed', worked, ...(err ? { error: err } : {}) };
    // Refused for a usage limit: its rollout's error event says so in codex_error_info (t-1907); exec's own events don't.
    // (A token_count naming rate_limit_reached_type is one too: codexRefusal reads it.)
    const reading = this.usage(body);
    const refused = this.sessionFiles(this.slotOf(body)).keep.map((k) => lastRefusal('codex', tailOf(join(this.roots[k.root], k.rel)))).find(Boolean);
    if (refused) {
      const until = refusedUntil(reading);
      Object.assign(out, { failed: true, limited: true, ...(out.error ? {} : { error: `its provider refused it (${refused.code})` }), ...(until ? { resets: until } : {}) });
    }
    return out;
  }

  final(body) {
    return this.events(body.id).findLast((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')?.item.text ?? null;
  }

  slotOf(body) {
    const t = this.events(body.id).find((e) => e.type === 'thread.started')?.thread_id ?? body.slot?.session;
    return t ? { harness: 'codex', session: String(t) } : null;
  }

  end(body) {
    const pid = Number(readJson(join(this.runsDir, body.id, 'pid')) ?? NaN);
    // Codex handles Ctrl-C by interrupting its turn and shutting down its tool
    // manager. SIGTERM exits it abruptly and can leave detached tools running.
    if (this.alive(body.id)) { try { process.kill(-pid, 'SIGINT'); } catch { /* gone */ } }
    this.inbox?.close(body.id);
  }

  /** Every run dir: for listing. */
  ids() { try { return readdirSync(this.runsDir).filter((d) => statSync(join(this.runsDir, d)).isDirectory()); } catch { return []; } }
}

/** Where Claude bodies' status lines keep their readings (statusline.mjs): the runner's and `usage statusline`'s. */
export const usageDirOf = (env = process.env) => env.LOOM_RUNTIME_USAGE_DIR || join(env.HOME || homedir(), '.local', 'state', 'loom-runtime', 'usage');

/** Exact private constructor configuration for the selected launch worker. */
export function nativeRunnerConfiguration(runner) {
  if (runner instanceof ClaudeRunner && runner.run === spawnSync) return {
    claude: runner.claude, jobsDir: runner.jobsDir, projectsDir: runner.roots.projects,
    args: runner.args, usageDir: runner.usageDir, node: runner.node, claimPolls: runner.claimPolls,
    ...(runner.inbox ? { inboxDir: runner.inbox.dir } : {}),
  };
  if (runner instanceof CodexRunner && runner.spawn === nodeSpawn && runner.run === spawnSync) return {
    codex: runner.codex, profile: runner.profile, runsDir: runner.runsDir,
    codexHome: runner.codexHome, sessionsDir: runner.roots.sessions, homesDir: runner.homesDir, systemDir: runner.systemDir,
    ...(runner.inbox ? { inboxDir: runner.inbox.dir } : {}),
  };
  return null;
}

/** Only the selectors needed to observe an existing native identity. Native
 * arguments and profile contents do not belong in conversation metadata. */
export function nativeRecoveryConfiguration(runner) {
  if (runner instanceof ClaudeRunner) return {
    claude: runner.claude, jobsDir: runner.jobsDir, projectsDir: runner.roots.projects,
    ...(runner.inbox ? { inboxDir: runner.inbox.dir } : {}),
  };
  if (runner instanceof CodexRunner) return {
    codex: runner.codex, runsDir: runner.runsDir, codexHome: runner.codexHome,
    sessionsDir: runner.roots.sessions, homesDir: runner.homesDir, systemDir: runner.systemDir,
    ...(runner.inbox ? { inboxDir: runner.inbox.dir } : {}),
  };
  return null;
}

/** Private launch-worker input; never a new model routing or permissions path. */
export function configuredNativeRunner(harness, configuration, env = process.env) {
  if (!configuration) return runnerFor(harness, env);
  if (harness === 'claude') return new ClaudeRunner(configuration);
  if (harness === 'codex') return new CodexRunner(configuration);
  throw new RunnerError('unsupported native launch configuration');
}

/** The runner from runtime settings and explicit dependency injection. */
export function runnerFor(harness, env = process.env, opts = {}) {
  env = nativeHistoryEnv(harness, env);
  validateNativeHistoryOptions(harness, env, opts);
  const argv = (v) => { try { const a = JSON.parse(v); return Array.isArray(a) && a.every((x) => typeof x === 'string') ? a : []; } catch { return []; } };
  const inboxDir = env.LOOM_RUNTIME_INBOX_DIR || undefined;
  if (harness === 'claude') {
    return new ClaudeRunner({ claude: env.LOOM_RUNTIME_CLAUDE || 'claude', usageDir: usageDirOf(env), ...(env.LOOM_RUNTIME_CLAUDE_JOBS ? { jobsDir: env.LOOM_RUNTIME_CLAUDE_JOBS } : {}), ...(env.LOOM_RUNTIME_CLAUDE_PROJECTS ? { projectsDir: env.LOOM_RUNTIME_CLAUDE_PROJECTS } : {}), args: argv(env.LOOM_RUNTIME_CLAUDE_ARGS), inboxDir, ...opts });
  }
  if (harness === 'codex') {
    return new CodexRunner({ codex: env.LOOM_RUNTIME_CODEX || 'codex', profile: env.LOOM_RUNTIME_CODEX_PROFILE || undefined, ...(env.CODEX_HOME ? { codexHome: env.CODEX_HOME } : {}), ...(env.LOOM_RUNTIME_CODEX_RUNS ? { runsDir: env.LOOM_RUNTIME_CODEX_RUNS } : {}), ...(env.LOOM_RUNTIME_CODEX_SESSIONS ? { sessionsDir: env.LOOM_RUNTIME_CODEX_SESSIONS } : {}), ...(env.LOOM_RUNTIME_CODEX_HOMES ? { homesDir: env.LOOM_RUNTIME_CODEX_HOMES } : {}), inboxDir, ...opts });
  }
  throw new RunnerError(`no runner for harness ${JSON.stringify(harness)}`);
}
