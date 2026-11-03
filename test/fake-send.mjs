#!/usr/bin/env node
// A stand-in for a venue adapter's declared `send` (agent-runtime.md, "Outbound"): given `--place <p> --agent <a>` and
// the text on stdin, it posts and answers {ok, id?}. Each call is a line in $FAKE_SEND/calls.log; $FAKE_SEND/fail holds
// how many calls to refuse first ({ok: false, reason}); $FAKE_SEND/delay, how long each takes.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const D = process.env.FAKE_SEND;
const text = readFileSync(0, 'utf-8');
// What posts nothing (t-1756): `--describe` (the place's rules: $FAKE_SEND/about, JSON) and `--status working|done`
// (presence: $FAKE_SEND/stop makes a working one answer stop: true). Each is a line in $FAKE_SEND/presence.log.
const argv = process.argv.slice(2);
if (argv.includes('--describe') || argv.includes('--status')) {
  if (D) appendFileSync(join(D, 'presence.log'), JSON.stringify({ argv }) + '\n');
  const about = D && existsSync(join(D, 'about')) ? JSON.parse(readFileSync(join(D, 'about'), 'utf-8')) : {};
  const stop = !!D && argv.includes('--status') && existsSync(join(D, 'stop'));
  process.stdout.write(JSON.stringify(argv.includes('--describe') ? { ok: true, ...about } : { ok: true, ...(stop ? { stop: true } : {}) }) + '\n');
  process.exit(0);
}
appendFileSync(join(D, 'calls.log'), JSON.stringify({ argv: process.argv.slice(2), text }) + '\n');
// $FAKE_SEND/delay: how long it takes to post, in ms (a slow platform).
const delay = existsSync(join(D, 'delay')) ? Number(readFileSync(join(D, 'delay'), 'utf-8')) : 0;
if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
// $FAKE_SEND/refuse: an answer it gives every post, as it is (a venue in shadow mode: {ok: false, reason, permanent}).
if (existsSync(join(D, 'refuse'))) {
  process.stdout.write(readFileSync(join(D, 'refuse'), 'utf-8').trim() + '\n');
  process.exit(1);
}
const f = join(D, 'fail');
const left = existsSync(f) ? Number(readFileSync(f, 'utf-8')) : 0;
if (left > 0) {
  writeFileSync(f, String(left - 1));
  process.stdout.write(JSON.stringify({ ok: false, reason: 'the bot has no access to that channel' }) + '\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true, id: `p-${Date.now()}` }) + '\n');
}
