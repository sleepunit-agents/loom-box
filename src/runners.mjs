// Runners (loom docs/specs/agent-runtime.md, section 3): one interface over the harnesses a body runs in.
//
// A runner runs bodies on one harness, on this machine (loom's own, or inside a house):
//   start({brief, model, cwd, env, deny})  → a body: {id, harness, model, slot?}. The brief goes on stdin, never
//                                            argv (message text must not show in /proc/<pid>/cmdline).
//   feed(body, message)                    → {fed: true} | {fed: false, reason}: a message mid-turn, where the
//                                            harness allows it. Where it doesn't, or the turn is over, the caller
//                                            waits for the turn to end, or resumes.
//   resume(slot, {brief, model, cwd, env}) → a body, continuing the session the slot names.
//   end(body, env?)                        → stops it; never throws for a body that's already gone.
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
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keptReading } from './statusline.mjs';
import { claudeCards, codexCards } from './activity.mjs';
import { lastRateLimit, lastRefusal, refusedUntil, tailOf } from './logins.mjs';
import { lastToolUse } from './stuck.mjs';

export class RunnerError extends Error {}

/** A harness's session id, as it may appear in a file name: never a path. */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/;
/** The names in a dir (with files too, when `all`), [] for none. */
const dirs = (d, all = false) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => all || e.isDirectory()).map((e) => e.name); } catch { return []; } };

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hex8 = () => randomBytes(4).toString('hex');

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

  constructor({ claude = 'claude', jobsDir = join(homedir(), '.claude', 'jobs'), projectsDir, args = [], inboxDir, usageDir = usageDirOf(), node = process.execPath, run = spawnSync, sleep = sleepMs, claimPolls = 10, token = hex8 } = {}) {
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
    const session = a.sessionId ?? this.job(body.id)?.sessionId;
    const found = typeof session === 'string' && SESSION.test(session)
      ? dirs(this.roots.projects).map((p) => join(this.roots.projects, p, `${session}.jsonl`)).filter((f) => existsSync(f)).sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0]
      : null;
    return found ? lastToolUse(found) : { tool: '', what: '' };
  }

  launch({ brief, model, cwd, env, deny = [], resume }) {
    const token = this.token();
    const nl = brief.indexOf('\n');
    const prompt = nl < 0 ? `${brief}\n${ClaudeRunner.TOKEN_LINE.replace('{token}', token)}\n`
      : `${brief.slice(0, nl)}\n${ClaudeRunner.TOKEN_LINE.replace('{token}', token)}\n${brief.slice(nl + 1)}`;
    // A Codex body's key, inherited by a launcher started under one: a Claude body must never key its inbox on it.
    // Nor a Codex thread's id (a launcher running under Codex has one): `send` names a Claude body's own session.
    const { SHUTTLE_BODY: _drop, CODEX_THREAD_ID: _thread, ...clean } = env ?? process.env;
    const before = new Set((this.agents(clean) ?? []).map((a) => a.id));
    const argv = ['--bg', ...(model ? ['--model', model] : []), ...this.statusLine(), ...this.args, ...(deny.length ? ['--disallowedTools', ...deny] : []), ...(resume ? ['--resume', resume] : [])];
    const r = this.run(this.claude, argv, { cwd, env: clean, input: prompt, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
    if (r.error || r.status !== 0) throw new RunnerError(`claude --bg didn't start: ${(r.stderr || r.error?.message || '').trim().split('\n').pop() || `exit ${r.status}`}`);
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
    // Or a failed turn whose account reads full: the same, in its numbers.
    const refused = (f ? lastRefusal('claude', tailOf(f)) : null) ?? (out.failed && readsFull(reading) ? { code: 'rate_limit' } : null);
    if (refused) {
      const until = refusedUntil(reading);
      Object.assign(out, { failed: true, limited: true, error: out.error ?? `its provider refused it (${refused.code})`, ...(until ? { resets: until } : {}) });
    }
    return out;
  }

  /** Its session's transcript, the newest of that name under projects; null when there's none. */
  transcriptOf(body) {
    const session = this.slotOf(body)?.session;
    if (typeof session !== 'string' || !SESSION.test(session)) return null;
    return dirs(this.roots.projects).map((p) => join(this.roots.projects, p, `${session}.jsonl`)).filter((f) => existsSync(f))
      .sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0] ?? null;
  }

  slotOf(body) {
    const session = body.slot?.session ?? this.job(body.id)?.sessionId;
    return session ? { harness: 'claude', session } : null;
  }

  /**
   * Its tool steps as activity cards (activity.mjs), from its session's transcript: only ever asked for a body in a
   * Comms thread. Tool-use ids are unique across sessions, so they need no prefix.
   */
  activity(body) {
    const session = this.slotOf(body)?.session;
    if (typeof session !== 'string' || !SESSION.test(session)) return [];
    for (const p of dirs(this.roots.projects)) {
      const f = join(this.roots.projects, p, `${session}.jsonl`);
      if (existsSync(f)) return claudeCards(lines(f));
    }
    return [];
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
 * A body's deny list (Claude Code's tool names), as Codex can keep it (t-1907): an MCP server's tools by its name.
 *   mcp__<server>          the whole server: `-c mcp_servers.<server>.enabled=false`
 *   mcp__<server>__<tool>  one tool: `-c mcp_servers.<server>.disabled_tools=[…]`
 * A server Codex doesn't load (`servers`, from its config) is denied already: it can't be reached (claude.ai's
 * connectors, mcp__claude_ai_*, are Claude's alone). Any other name (a built-in, like Bash) Codex can't deny: an error,
 * and no body (fail closed, as before). → {args} | {error}.
 */
export function codexDeny(deny, servers = new Set()) {
  const off = new Set();
  const tools = new Map();
  const bad = [];
  for (const d of deny) {
    const m = /^mcp__([A-Za-z0-9_-]+?)(?:__([A-Za-z0-9_.-]+))?$/.exec(String(d));
    // A server's name can hold single underscores (claude_ai_Gmail); a tool is after the first double one.
    const parts = String(d).startsWith('mcp__') ? String(d).slice(5).split('__') : null;
    if (!m || !parts || parts.length > 2 || !parts[0]) { bad.push(d); continue; }
    const [server, tool] = parts;
    if (!servers.has(server)) continue;
    if (tool) (tools.get(server) ?? tools.set(server, []).get(server)).push(tool);
    else off.add(server);
  }
  if (bad.length) return { error: `the codex runner can't deny ${bad.join(', ')} (it turns off MCP servers and their tools by name, nothing else): refusing to start a body that would keep them` };
  const args = [];
  for (const s of [...off].sort()) args.push('-c', `mcp_servers.${s}.enabled=false`);
  for (const [s, t] of [...tools].sort()) if (!off.has(s)) args.push('-c', `mcp_servers.${s}.disabled_tools=${JSON.stringify([...new Set(t)].sort())}`);
  return { args };
}

/**
 * Codex, `codex exec --json`: a body is one process, started in its own session with the brief on stdin, its events
 * in <runs>/<key>/events.jsonl. Its id is a key picked at launch (so its env can carry it as SHUTTLE_BODY for the
 * inbox hook); the thread id Codex reports first is its slot (`codex exec resume <thread>`). Files, not pipes, so a
 * body outlives whatever started it. A deny list is kept as Codex can (codexDeny): MCP servers and their tools only.
 */
export class CodexRunner {
  harness = 'codex';

  constructor({ codex = 'codex', profile, runsDir = join(homedir(), '.local', 'share', 'loom-runtime', 'codex-runs'), sessionsDir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'), inboxDir, spawn = nodeSpawn, run = spawnSync, key = hex8 } = {}) {
    Object.assign(this, { codex, profile, runsDir, spawn, run, key });
    this.inbox = inboxDir ? inbox(inboxDir, { run }) : null;
    // Codex keeps a thread's rollout at <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<when>-<thread>.jsonl.
    this.roots = { sessions: sessionsDir };
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

  launch({ brief, model, cwd, env, deny = [], resume }) {
    const off = codexDeny(deny, this.mcpServers(cwd));
    if (off.error) throw new RunnerError(off.error);
    const key = this.key();
    const dir = join(this.runsDir, key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const e = { ...scrub(env ?? process.env), SHUTTLE_BODY: key, ...(this.inbox ? { SHUTTLE_INBOX_DIR: this.inbox.dir } : {}) };
    const argv = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox',
      ...(this.profile ? ['-p', this.profile] : []), ...(model ? ['-m', model] : []), ...off.args, '-C', cwd ?? process.cwd(), '-o', join(dir, 'last.txt'),
      ...(resume ? ['resume', resume] : []), '-'];
    const out = openSync(join(dir, 'events.jsonl'), 'a', 0o600);
    const err = openSync(join(dir, 'stderr.txt'), 'a', 0o600);
    let child;
    try {
      child = this.spawn(this.codex, argv, { cwd, env: e, stdio: ['pipe', out, err], detached: true });
    } finally { closeSync(out); closeSync(err); }
    if (!child.pid) throw new RunnerError(`codex didn't start (${this.codex})`);
    writeFileSync(join(dir, 'pid'), `${child.pid}\n`, { mode: 0o600 });
    child.stdin.on('error', () => {});
    child.stdin.end(brief);
    child.unref();
    this.inbox?.open(key, { venue: 'runtime', chan: key, bridge: 'runtime' });
    return { id: key, harness: 'codex', model, ...(resume ? { slot: { harness: 'codex', session: resume } } : {}) };
  }

  /**
   * The MCP servers Codex would load: [mcp_servers.<name>] tables in its home's config.toml and the project's
   * (<cwd>/.codex/config.toml). Only their names: a deny turns them off by name (codexDeny).
   */
  mcpServers(cwd) {
    const home = this.codexHome ?? dirname(this.roots.sessions);
    const names = new Set();
    for (const f of [join(home, 'config.toml'), ...(cwd ? [join(cwd, '.codex', 'config.toml')] : [])]) {
      let text = '';
      try { text = readFileSync(f, 'utf-8'); } catch { continue; }
      for (const m of text.matchAll(/^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*[\].]/gm)) names.add(m[1] ?? m[2] ?? m[3]);
    }
    return names;
  }

  start(o) { return this.launch(o); }
  resume(slot, o) {
    if (slot?.harness !== 'codex' || !slot.session) throw new RunnerError('a Codex body resumes from a Codex slot (its thread)');
    return this.launch({ ...o, resume: slot.session });
  }
  feed(body, message) { return feedVia(this, body, message); }

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
  activity(body) { return codexCards(this.events(body.id), `${body.id}:`); }

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
    // Or a failed turn whose last token_count reads full (or names the limit it reached): the same, in its numbers.
    const reading = this.usage(body);
    const refused = this.sessionFiles(this.slotOf(body)).keep.map((k) => lastRefusal('codex', tailOf(join(this.roots[k.root], k.rel)))).find(Boolean)
      ?? (out.failed && (reading?.limited || readsFull(reading)) ? { code: 'usage_limit_exceeded' } : null);
    if (refused) {
      const until = refusedUntil(reading);
      Object.assign(out, { failed: true, limited: true, ...(out.error ? {} : { error: `its provider refused it (${refused.code})` }), ...(until ? { resets: until } : {}) });
    }
    return out;
  }

  slotOf(body) {
    const t = this.events(body.id).find((e) => e.type === 'thread.started')?.thread_id ?? body.slot?.session;
    return t ? { harness: 'codex', session: String(t) } : null;
  }

  end(body) {
    const pid = Number(readJson(join(this.runsDir, body.id, 'pid')) ?? NaN);
    if (this.alive(body.id)) { try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ } }
    this.inbox?.close(body.id);
  }

  /** Every run dir: for listing. */
  ids() { try { return readdirSync(this.runsDir).filter((d) => statSync(join(this.runsDir, d)).isDirectory()); } catch { return []; } }
}

/** A reading with a window at or past full (accounts.mjs, FULL). */
const readsFull = (r) => !!r?.windows && Object.values(r.windows).some((v) => typeof v === 'number' && v >= 0.97);

/** Where Claude bodies' status lines keep their readings (statusline.mjs): the runner's and `usage statusline`'s. */
export const usageDirOf = (env = process.env) => env.LOOM_RUNTIME_USAGE_DIR || join(env.HOME || homedir(), '.local', 'state', 'loom-runtime', 'usage');

/** The runner for a harness, from the runtime's settings (LOOM_RUNTIME_CLAUDE, …) and what a test passes in. */
export function runnerFor(harness, env = process.env, opts = {}) {
  const argv = (v) => { try { const a = JSON.parse(v); return Array.isArray(a) && a.every((x) => typeof x === 'string') ? a : []; } catch { return []; } };
  const inboxDir = env.LOOM_RUNTIME_INBOX_DIR || undefined;
  if (harness === 'claude') {
    return new ClaudeRunner({ claude: env.LOOM_RUNTIME_CLAUDE || 'claude', usageDir: usageDirOf(env), ...(env.LOOM_RUNTIME_CLAUDE_JOBS ? { jobsDir: env.LOOM_RUNTIME_CLAUDE_JOBS } : {}), ...(env.LOOM_RUNTIME_CLAUDE_PROJECTS ? { projectsDir: env.LOOM_RUNTIME_CLAUDE_PROJECTS } : {}), args: argv(env.LOOM_RUNTIME_CLAUDE_ARGS), inboxDir, ...opts });
  }
  if (harness === 'codex') {
    return new CodexRunner({ codex: env.LOOM_RUNTIME_CODEX || 'codex', profile: env.LOOM_RUNTIME_CODEX_PROFILE || undefined, ...(env.LOOM_RUNTIME_CODEX_RUNS ? { runsDir: env.LOOM_RUNTIME_CODEX_RUNS } : {}), ...(env.LOOM_RUNTIME_CODEX_SESSIONS ? { sessionsDir: env.LOOM_RUNTIME_CODEX_SESSIONS } : {}), inboxDir, ...opts });
  }
  throw new RunnerError(`no runner for harness ${JSON.stringify(harness)}`);
}
