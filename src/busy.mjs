// Which remote sessions on this machine are mid-turn (t-1624). A remote-control
// session runs its conversation in a `claude --print --sdk-url …/sessions/…`
// process, which uses CPU while a turn runs: sampled twice (each time loom asks
// for the manifest, about a minute apart), more than a little CPU in between is
// working. A turn waiting on a tool uses none, but the tool runs as its child:
// a child started well after the session (its MCP servers start with it) is a
// tool running, and working too. Only what runs on this machine is seen.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** CPU, in clock ticks a second (USER_HZ is 100 on Linux), above which a session is mid-turn. */
export const BUSY_TICKS_PER_S = 2;
/** A child started this long after its session is a tool, not one of its MCP servers. */
const TOOL_AFTER_TICKS = 120 * 100;
/** Samples further apart than this say nothing about now. */
const STALE_S = 600;

const argv = (root, pid) => { try { return readFileSync(join(root, pid, 'cmdline'), 'utf-8').split('\0'); } catch { return null; } };
function stat(root, pid) {
  try {
    const s = readFileSync(join(root, pid, 'stat'), 'utf-8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { ppid: f[1], ticks: Number(f[11]) + Number(f[12]), start: Number(f[19]) };
  } catch { return null; }
}
function children(root, pid) {
  try { return readdirSync(join(root, pid, 'task')).flatMap((t) => readFileSync(join(root, pid, 'task', t, 'children'), 'utf-8').trim().split(/\s+/).filter(Boolean)); } catch { return []; }
}
const flag = (a, name) => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : undefined; };

/**
 * Every session process here, keyed by whose it is: `box:<session name>` (a box session's
 * `claude remote-control --name …`) or `house:<id>` (one inside a house: conmon's -n loom-house-<id>).
 */
export function sessionTicks(root = '/proc') {
  const out = {};
  let pids = [];
  try { pids = readdirSync(root).filter((p) => /^\d+$/.test(p)); } catch { return out; }
  for (const pid of pids) {
    const a = argv(root, pid);
    if (!a || !a.includes('--sdk-url')) continue;
    const st = stat(root, pid);
    if (!st) continue;
    // Up its ancestors: the remote-control that runs it, and, for one inside a house, the house's conmon.
    // A house's session also runs under remote-control inside it: the house is what names it.
    let box;
    let house;
    for (let p = st.ppid, depth = 0; p && p !== '0' && p !== '1' && depth < 16 && !house; depth++) {
      const up = argv(root, p);
      if (!box && up?.some((x) => /(^|\/)claude$/.test(x)) && up.includes('remote-control') && flag(up, '--name')) box = `box:${flag(up, '--name')}`;
      const n = up && /(^|\/)conmon$/.test(up[0]) ? flag(up, '-n') : undefined;
      if (n?.startsWith('loom-house-')) house = `house:${n.slice('loom-house-'.length)}`;
      p = stat(root, p)?.ppid;
    }
    const key = house ?? box;
    if (!key) continue;
    const tools = children(root, pid).filter((c) => { const cs = stat(root, c); return cs && cs.start - st.start > TOOL_AFTER_TICKS; }).length;
    out[key] = { ticks: (out[key]?.ticks ?? 0) + st.ticks, tools: (out[key]?.tools ?? 0) + tools };
  }
  return out;
}

/** Which sessions are working: a tool running now, or CPU since the last sample (kept in `file`). {key: true|false}; unknown keys are left out. */
export function sessionsBusy(file, { now = Date.now(), ticks = sessionTicks() } = {}) {
  let prev = null;
  try { prev = JSON.parse(readFileSync(file, 'utf-8')); } catch { /* the first sample */ }
  try { writeFileSync(file, JSON.stringify({ at: now, ticks }), { mode: 0o600 }); } catch { /* a read-only state dir: no answer */ }
  const out = {};
  const dt = prev ? (now - prev.at) / 1000 : 0;
  const fresh = prev && dt > 0 && dt <= STALE_S;
  for (const [k, t] of Object.entries(ticks)) {
    if (t.tools > 0) { out[k] = true; continue; }
    const was = fresh ? prev.ticks?.[k]?.ticks : undefined;
    if (was === undefined || t.ticks < was) continue;
    out[k] = (t.ticks - was) / dt >= BUSY_TICKS_PER_S;
  }
  return out;
}
