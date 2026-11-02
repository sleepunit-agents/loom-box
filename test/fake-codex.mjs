#!/usr/bin/env node
// A stand-in for `codex exec --json`, for the runner tests: it reads the brief on stdin, reports a thread and a turn
// on stdout as Codex does, and keeps working until $FAKE_HARNESS/finish appears (or 20s), then completes its turn.
// Every call's argv goes to $FAKE_HARNESS/argv.log.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const D = process.env.FAKE_HARNESS;
const args = process.argv.slice(2);
appendFileSync(join(D, 'argv.log'), JSON.stringify({ args, body: process.env.SHUTTLE_BODY, inbox: process.env.SHUTTLE_INBOX_DIR ?? null, claude: Object.keys(process.env).filter((k) => k.startsWith('CLAUDE_CODE_')) }) + '\n');
const brief = readFileSync(0, 'utf-8');
appendFileSync(join(D, 'briefs.log'), JSON.stringify(brief) + '\n');
const r = args.indexOf('resume');
const say = (e) => process.stdout.write(JSON.stringify(e) + '\n');
say({ type: 'thread.started', thread_id: r >= 0 ? args[r + 1] : `th-${process.pid}` });
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
tick();
