#!/usr/bin/env node
// A stand-in for `codex exec --json`, for the runner tests: it reads the brief on stdin, reports a thread and a turn
// on stdout as Codex does, and keeps working until $FAKE_HARNESS/finish appears (or 20s), then completes its turn.
// Every call's argv goes to $FAKE_HARNESS/argv.log, with its CODEX_HOME. With FAKE_ROLLOUT set, it writes its thread's
// rollout under $CODEX_HOME/sessions, as Codex does, with a token_count reading.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const D = process.env.FAKE_HARNESS;
const args = process.argv.slice(2);
appendFileSync(join(D, 'argv.log'), JSON.stringify({ args, body: process.env.SHUTTLE_BODY, inbox: process.env.SHUTTLE_INBOX_DIR ?? null, claude: Object.keys(process.env).filter((k) => k.startsWith('CLAUDE_CODE_')), home: process.env.CODEX_HOME ?? null }) + '\n');
const brief = readFileSync(0, 'utf-8');
appendFileSync(join(D, 'briefs.log'), JSON.stringify(brief) + '\n');
const r = args.indexOf('resume');
const say = (e) => process.stdout.write(JSON.stringify(e) + '\n');
const thread = r >= 0 ? args[r + 1] : `th-${process.pid}`;
let tool;
if (process.env.FAKE_DETACHED_TOOL) {
  tool = spawn(process.execPath, ['-e', `const fs=require('node:fs'); const p=process.argv[1]; fs.writeFileSync(p+'/tool-started','1'); setTimeout(()=>fs.writeFileSync(p+'/orphan-finished','1'),600);`, D], { detached: true, stdio: 'ignore' });
  tool.unref();
}
say({ type: 'thread.started', thread_id: thread });
if (process.env.FAKE_ROLLOUT && process.env.CODEX_HOME) {
  const day = join(process.env.CODEX_HOME, 'sessions', '2026', '11', '06');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-11-06T12-00-00-${thread}.jsonl`), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: 4102444800 } } } }) + '\n');
}
say({ type: 'turn.started' });
const until = Date.now() + 20_000;
const tick = () => {
  if (existsSync(join(D, 'finish')) || Date.now() > until) {
    say({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
    say({ type: 'turn.completed' });
    process.exit(0);
  }
  setTimeout(tick, 50);
};
process.on('SIGTERM', () => process.exit(143));
process.on('SIGINT', () => {
  if (tool) {
    try { process.kill(-tool.pid, 'SIGTERM'); } catch { /* already gone */ }
    writeFileSync(join(D, 'interrupt-flushed'), '1');
  }
  process.exit(130);
});
tick();
