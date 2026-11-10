// A private per-body host owns agy's stdin and exit witness across runtime restarts.
import { spawn } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw Error('agy launch input exceeds its bound');
}
const { executable, argv, prompt } = JSON.parse(input), dir = process.argv[2];
// agy and its ordinary tools have their own process group, separate from this
// witness writer. A stop escalates that whole group, including surviving tools.
const child = spawn(executable, argv, { stdio: ['pipe', 'inherit', 'inherit'], detached: true });
let timer, stopping = false, written = false, terminal;
const signalGroup = signal => { try { process.kill(-child.pid, signal); } catch {} };
function finish(code, signal) {
  terminal = { code, signal };
  if (written || stopping) return;
  written = true;
  const path = join(dir, 'exit.json');
  writeFileSync(path + '.new', JSON.stringify(terminal), { mode: 0o600 });
  renameSync(path + '.new', path);
}
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  signalGroup('SIGTERM');
  // Do not cancel escalation when agy exits: one of its tools may still live.
  timer = setTimeout(() => {
    signalGroup('SIGKILL');
    stopping = false;
    finish(terminal?.code ?? null, terminal?.signal ?? 'SIGTERM');
  }, 5000);
});
child.stdin.on('error', () => {});
child.stdin.end(JSON.stringify(prompt) + '\n', error => {
  if (!error) writeFileSync(join(dir, 'input-ready'), '1', { mode: 0o600 });
});
child.once('error', () => finish(127, null));
child.once('exit', finish);
