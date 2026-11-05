// Stuck bodies (t-1858, after the clock's t-1854): a body the runtime starts on loom's machine runs with nobody at its
// terminal, so one that stops on a permission prompt waits forever. On 2026-11-04 an alert triage for art-chain-check
// (d35895b1) sat there for hours; the clock's own stopper never saw it, since the runtime started it. What a stuck body
// was waiting on is told to the owner and its task, so it's read here from its transcript: its last tool call. A
// command can carry a credential, and task comments are read back by agents: what's shown of one goes through redact()
// first, and an alert shows none of it.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Minutes a body may wait on a permission prompt (LOOM_RUNTIME_STUCK_AFTER) unless the owner says. */
export const STUCK_AFTER_MIN = 10;
/** Characters of a command a comment shows, after redact(). */
export const CMD_SHOWN = 120;
/** Bytes read from a transcript's end for its last tool call. */
const TAIL = 4 * 1024 * 1024;

// The clock's redactions (loom-clock bin/wake, REDACTIONS), the same patterns.
const REDACTIONS = [
  [/\b(authorization|proxy-authorization)\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?[^\s'"]+/gi, '$1: [redacted]'],
  [/\bbearer\s+[^\s'"]+/gi, 'Bearer [redacted]'],
  [/(\b[\w-]*(?:token|key|secret|password|passwd|pwd)[\w-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&'"]+)/gi, '$1[redacted]'],
  [/(--[\w-]*(?:token|key|secret|password)[\w-]*[ =])(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}|\bgithub_pat_[A-Za-z0-9_]{10,}|\bsk-[A-Za-z0-9_-]{10,}|\bxox[abposr]-[A-Za-z0-9-]{8,}/g, '[redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, '$1[redacted]@'],
  // A long run of base64 or hex: a token, unless it's plainly words (a kebab-case name like alert-upgrade-skip-…).
  [/[A-Za-z0-9+_=-]{24,}/g, (m) => (/^[a-z]+(?:-[a-z]+)+$/.test(m) ? m : '[redacted]')],
];

/** Credentials out of a command before any of it is shown: auth headers, key=value secrets, known token prefixes, URL userinfo, long base64/hex runs. */
export function redact(text) {
  let out = String(text ?? '');
  for (const [rx, rep] of REDACTIONS) out = out.replace(rx, rep);
  return out;
}

/** A command, redacted and quoted for a comment: one line, at most n characters, in a JSON string. */
export function asData(text, n = CMD_SHOWN) {
  const one = redact(text).split(/\s+/).filter(Boolean).join(' ');
  return JSON.stringify(one.length <= n ? one : `${one.slice(0, n)}…`);
}

/** {tool, what} for a transcript's last tool call: what its session was waiting on. Empty strings when there's none. */
export function lastToolUse(path, tail = TAIL) {
  let text;
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, tail);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf-8');
    } finally { closeSync(fd); }
  } catch { return { tool: '', what: '' }; }
  for (const line of text.split('\n').reverse()) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || typeof d !== 'object' || d.type !== 'assistant' || !d.message || typeof d.message !== 'object') continue;
    const content = d.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of [...content].reverse()) {
      if (block && typeof block === 'object' && block.type === 'tool_use') {
        const inp = block.input && typeof block.input === 'object' ? block.input : {};
        return { tool: String(block.name || 'a tool'), what: typeof inp.command === 'string' ? inp.command : JSON.stringify(inp) };
      }
    }
  }
  return { tool: '', what: '' };
}

const TASK_ID = /\bt-\d+\b/;
/** The task a conversation's label names (a wake's note: "t-40 round 12"), or ''. */
export const taskOf = (...texts) => texts.map((t) => TASK_ID.exec(String(t ?? ''))?.[0]).find(Boolean) ?? '';

/**
 * LOOM_RUNTIME_TASK_COMMENT: how a stopped body is noted on its task, a JSON argv with {task} and {text} as whole
 * arguments; `off` never. Unset: `taskstore comment {task} {text}`, when taskstore is on the PATH it runs with.
 * Run in `cwd` (a local body's folder: where its taskstore is). True when it took it.
 */
export function taskComment(env, task, text, { cwd, path, run = spawnSync } = {}) {
  const raw = env.LOOM_RUNTIME_TASK_COMMENT;
  if (raw && ['off', 'none'].includes(raw.trim().toLowerCase())) return false;
  let argv;
  try { argv = raw ? JSON.parse(raw) : ['taskstore', 'comment', '{task}', '{text}']; } catch { return false; }
  if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string' && a)) return false;
  const PATH = path || env.PATH || '';
  if (!raw && !PATH.split(delimiter).some((d) => d && existsSync(join(d, argv[0])))) return false;
  const r = run(argv[0], argv.slice(1).map((a) => (a === '{task}' ? task : a === '{text}' ? text : a)),
    { env: { ...env, PATH }, cwd: cwd && existsSync(cwd) ? cwd : undefined, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8', timeout: 60_000 });
  return !r.error && r.status === 0;
}
