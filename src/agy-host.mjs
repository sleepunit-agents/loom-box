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
const child = spawn(executable, argv, { stdio: ['pipe', 'inherit', 'inherit'] });
let timer;
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
  timer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
});
child.stdin.on('error', () => {});
child.stdin.end(JSON.stringify(prompt) + '\n');
let written = false;
function finish(code, signal) {
  if (written) return;
  written = true; clearTimeout(timer);
  const path = join(dir, 'exit.json');
  writeFileSync(path + '.new', JSON.stringify({ code, signal }), { mode: 0o600 });
  renameSync(path + '.new', path);
}
child.once('error', () => finish(127, null));
child.once('exit', finish);
