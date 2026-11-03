#!/usr/bin/env node
// A runtime body's Claude Code status line (runners.mjs, ClaudeRunner; t-1754): how full its account is, kept where the
// body host reads it when the body's turn ends.
//
// A `claude --bg` body writes no stream-json, so no `rate_limit_event` reaches anything the runtime reads, and its
// transcript carries none either. Its status line does: Claude Code (2.1.317) runs the status line command for a
// background session too, with the session's JSON on stdin, `rate_limits` in it:
//   {"session_id": "…", "rate_limits": {"five_hour": {"used_percentage": 12, "resets_at": 1793720000},
//                                      "seven_day": {"used_percentage": 10, "resets_at": 1794265200}}, …}
// This keeps only that, as a reading (`{windows: {"5h": 0.12, "7d": 0.1}, resets}`, the shape `usage` takes), in
// <dir>/<session>.json (0600, by rename). Nothing else of the input is kept: not the cwd, the model or a word said.
//
//   node statusline.mjs <dir>        (stdin: the status line JSON; stdout: one short line, e.g. "5h 12% · 7d 10%")
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOW_OF = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d_opus', seven_day_sonnet: '7d_sonnet' };
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The status line's rate_limits as a reading, or null. */
export function readingFromStatusline(input) {
  const rl = input && typeof input === 'object' ? input.rate_limits : null;
  if (!rl || typeof rl !== 'object') return null;
  const windows = {}, resets = {};
  for (const [k, w] of Object.entries(rl)) {
    const name = WINDOW_OF[k];
    if (!name || !w || typeof w !== 'object') continue;
    const pct = num(w.used_percentage) ?? (num(w.utilization) !== undefined ? w.utilization * 100 : undefined);
    if (pct === undefined) continue;
    windows[name] = Math.max(0, Math.min(1, pct / 100));
    const r = num(w.resets_at);
    if (r !== undefined) resets[name] = r;
  }
  return Object.keys(windows).length ? { windows, resets } : null;
}

/** Keeps a status line's reading for its session in `dir`: {session, reading}, or null when it has none. */
export function capture(dir, text, nowMs = Date.now()) {
  let input;
  try { input = JSON.parse(text); } catch { return null; }
  const session = input?.session_id;
  if (typeof session !== 'string' || !SESSION.test(session)) return null;
  const reading = readingFromStatusline(input);
  if (!reading) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, `${session}.json`);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ at: Math.floor(nowMs / 1000), reading }), { mode: 0o600 });
  renameSync(tmp, f);
  return { session, reading };
}

/** A session's kept reading, `checked` when it was kept; null if none. */
export function keptReading(dir, session) {
  if (typeof session !== 'string' || !SESSION.test(session)) return null;
  try {
    const k = JSON.parse(readFileSync(join(dir, `${session}.json`), 'utf-8'));
    if (!k?.reading?.windows || typeof k.reading.windows !== 'object') return null;
    return { ...k.reading, checked: num(k.at) };
  } catch { return null; }
}

/** The line Claude Code shows: the windows, rounded. */
export const lineOf = (reading) => (reading ? Object.entries(reading.windows).map(([w, v]) => `${w} ${Math.round(v * 100)}%`).join(' · ') : '');

const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  let text = '';
  try { text = readFileSync(0, 'utf-8'); } catch { /* nothing piped */ }
  let got = null;
  try { got = process.argv[2] ? capture(process.argv[2], text) : null; } catch { /* a status line never fails its session */ }
  process.stdout.write(`${lineOf(got?.reading)}\n`);
}
