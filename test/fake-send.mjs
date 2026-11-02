#!/usr/bin/env node
// A stand-in for a venue adapter's declared `send` (agent-runtime.md, "Outbound"): given `--place <p> --agent <a>` and
// the text on stdin, it posts and answers {ok, id?}. Each call is a line in $FAKE_SEND/calls.log; $FAKE_SEND/fail holds
// how many calls to refuse first ({ok: false, reason}); $FAKE_SEND/delay, how long each takes.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const D = process.env.FAKE_SEND;
const text = readFileSync(0, 'utf-8');
appendFileSync(join(D, 'calls.log'), JSON.stringify({ argv: process.argv.slice(2), text }) + '\n');
// $FAKE_SEND/delay: how long it takes to post, in ms (a slow platform).
const delay = existsSync(join(D, 'delay')) ? Number(readFileSync(join(D, 'delay'), 'utf-8')) : 0;
if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
const f = join(D, 'fail');
const left = existsSync(f) ? Number(readFileSync(f, 'utf-8')) : 0;
if (left > 0) {
  writeFileSync(f, String(left - 1));
  process.stdout.write(JSON.stringify({ ok: false, reason: 'the bot has no access to that channel' }) + '\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true, id: `p-${Date.now()}` }) + '\n');
}
