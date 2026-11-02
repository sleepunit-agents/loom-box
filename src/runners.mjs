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
//
// Two harnesses today, ported from the bridges piece's runners (shuttle/runner.py, shuttle/runners/codex.py):
// Claude Code as `claude --bg`, and Codex as `codex exec --json`. Feeding goes through a body's inbox: the layout
// the bridges piece's inbox hook reads (<inbox dir>/<id8>/pending.jsonl, under flock), so a house whose harness
// has that hook hears follow-ups mid-turn. With no inbox dir, a body can't be fed.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class RunnerError extends Error {}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hex8 = () => randomBytes(4).toString('hex');

/** A body's inbox, in the bridges piece's layout (shuttle/inbox.py), so its hook reads what's put here. */
export function inbox(dir, { run = spawnSync } = {}) {
  const at = (id) => join(dir, String(id).slice(0, 8));
  return {
    dir,
    open(id, meta) {
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

/**
 * Claude Code, `claude --bg`: its daemon owns each body, `claude agents --json` lists them, and each body's job dir
 * (<jobs>/<id8>/state.json) says how its turn is going. A new body is found by a random spawn token on line 2 of its
 * brief (the job's intent), so a quoted line in a message can never claim it (shuttle's t-1272, t-1411).
 */
export class ClaudeRunner {
  harness = 'claude';
  static TOKEN_LINE = '(bridge spawn token {token}: ignore this line)';

  constructor({ claude = 'claude', jobsDir = join(homedir(), '.claude', 'jobs'), args = [], inboxDir, run = spawnSync, sleep = sleepMs, claimPolls = 10, token = hex8 } = {}) {
    Object.assign(this, { claude, jobsDir, args, run, sleep, claimPolls, token });
    this.inbox = inboxDir ? inbox(inboxDir, { run }) : null;
  }

  agents(env) {
    const r = this.run(this.claude, ['agents', '--json', '--all'], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    if (r.status !== 0) return null;
    try { const d = JSON.parse(r.stdout || '[]'); return Array.isArray(d) ? d : null; } catch { return null; }
  }

  job(id) { return readJson(join(this.jobsDir, String(id).slice(0, 8), 'state.json')); }

  launch({ brief, model, cwd, env, deny = [], resume }) {
    const token = this.token();
    const nl = brief.indexOf('\n');
    const prompt = nl < 0 ? `${brief}\n${ClaudeRunner.TOKEN_LINE.replace('{token}', token)}\n`
      : `${brief.slice(0, nl)}\n${ClaudeRunner.TOKEN_LINE.replace('{token}', token)}\n${brief.slice(nl + 1)}`;
    // A Codex body's key, inherited by a launcher started under one: a Claude body must never key its inbox on it.
    const { SHUTTLE_BODY: _drop, ...clean } = env ?? process.env;
    const before = new Set((this.agents(clean) ?? []).map((a) => a.id));
    const argv = ['--bg', ...(model ? ['--model', model] : []), ...this.args, ...(deny.length ? ['--disallowedTools', ...deny] : []), ...(resume ? ['--resume', resume] : [])];
    const r = this.run(this.claude, argv, { cwd, env: clean, input: prompt, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
    if (r.error || r.status !== 0) throw new RunnerError(`claude --bg didn't start: ${(r.stderr || r.error?.message || '').trim().split('\n').pop() || `exit ${r.status}`}`);
    // Claim: a new agent whose job intent carries this launch's token.
    const marker = `(bridge spawn token ${token}:`;
    for (let i = 0; i < this.claimPolls; i++) {
      const found = (this.agents(clean) ?? []).filter((a) => a.id && !before.has(a.id) && (this.job(a.id)?.intent ?? '').includes(marker));
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

  start(o) { return this.launch(o); }
  resume(slot, o) {
    if (slot?.harness !== 'claude' || !slot.session) throw new RunnerError('a Claude body resumes from a Claude slot (its session)');
    return this.launch({ ...o, resume: slot.session });
  }
  feed(body, message) { return feedVia(this, body, message); }

  status(body) {
    const job = this.job(body.id);
    if (!job) return 'unknown';
    if (job.state === 'done' || job.state === 'stopped' || job.state === 'failed' || job.state === 'blocked') return 'idle';
    return 'working';
  }

  slotOf(body) {
    const session = body.slot?.session ?? this.job(body.id)?.sessionId;
    return session ? { harness: 'claude', session } : null;
  }

  end(body, env) {
    this.run(this.claude, ['stop', body.id], { env, stdio: 'ignore', timeout: 20_000 });
    this.inbox?.close(body.id);
  }
}

// The env keys a Claude Code launcher leaves behind: a Codex body must not look like a Claude session to its tools.
const scrub = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE' && k !== 'CLAUDE_JOB_DIR'));

/**
 * Codex, `codex exec --json`: a body is one process, started in its own session with the brief on stdin, its events
 * in <runs>/<key>/events.jsonl. Its id is a key picked at launch (so its env can carry it as SHUTTLE_BODY for the
 * inbox hook); the thread id Codex reports first is its slot (`codex exec resume <thread>`). Files, not pipes, so a
 * body outlives whatever started it. Codex can't deny tools by name, so a deny list is refused.
 */
export class CodexRunner {
  harness = 'codex';

  constructor({ codex = 'codex', profile, runsDir = join(homedir(), '.local', 'share', 'loom-runtime', 'codex-runs'), inboxDir, spawn = nodeSpawn, run = spawnSync, key = hex8 } = {}) {
    Object.assign(this, { codex, profile, runsDir, spawn, run, key });
    this.inbox = inboxDir ? inbox(inboxDir, { run }) : null;
  }

  launch({ brief, model, cwd, env, deny = [], resume }) {
    if (deny.length) throw new RunnerError(`the codex runner can't deny tools (${deny.join(', ')}): refusing to start a body that would keep them`);
    const key = this.key();
    const dir = join(this.runsDir, key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const e = { ...scrub(env ?? process.env), SHUTTLE_BODY: key, ...(this.inbox ? { SHUTTLE_INBOX_DIR: this.inbox.dir } : {}) };
    const argv = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox',
      ...(this.profile ? ['-p', this.profile] : []), ...(model ? ['-m', model] : []), '-C', cwd ?? process.cwd(), '-o', join(dir, 'last.txt'),
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

  start(o) { return this.launch(o); }
  resume(slot, o) {
    if (slot?.harness !== 'codex' || !slot.session) throw new RunnerError('a Codex body resumes from a Codex slot (its thread)');
    return this.launch({ ...o, resume: slot.session });
  }
  feed(body, message) { return feedVia(this, body, message); }

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

/** The runner for a harness, from the runtime's settings (LOOM_RUNTIME_CLAUDE, …) and what a test passes in. */
export function runnerFor(harness, env = process.env, opts = {}) {
  const argv = (v) => { try { const a = JSON.parse(v); return Array.isArray(a) && a.every((x) => typeof x === 'string') ? a : []; } catch { return []; } };
  const inboxDir = env.LOOM_RUNTIME_INBOX_DIR || undefined;
  if (harness === 'claude') {
    return new ClaudeRunner({ claude: env.LOOM_RUNTIME_CLAUDE || 'claude', ...(env.LOOM_RUNTIME_CLAUDE_JOBS ? { jobsDir: env.LOOM_RUNTIME_CLAUDE_JOBS } : {}), args: argv(env.LOOM_RUNTIME_CLAUDE_ARGS), inboxDir, ...opts });
  }
  if (harness === 'codex') {
    return new CodexRunner({ codex: env.LOOM_RUNTIME_CODEX || 'codex', profile: env.LOOM_RUNTIME_CODEX_PROFILE || undefined, ...(env.LOOM_RUNTIME_CODEX_RUNS ? { runsDir: env.LOOM_RUNTIME_CODEX_RUNS } : {}), inboxDir, ...opts });
  }
  throw new RunnerError(`no runner for harness ${JSON.stringify(harness)}`);
}
