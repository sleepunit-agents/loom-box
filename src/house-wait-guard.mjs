// fd 3 is held only by the runtime. EOF also happens when it is SIGKILLed,
// regardless of which init/subreaper inherits this process.
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
const lifetime = new Socket({ fd: 3, readable: true, writable: false });
let stopping = false;
const child = spawn(process.argv[2], ['wait', process.argv[3]], { stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => { stopping = true; child.kill('SIGKILL'); };
lifetime.on('end', stop);
lifetime.on('error', stop);
lifetime.resume();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.once('error', () => process.exit(125));
child.once('exit', (code, signal) => {
  if (stopping || signal) process.kill(process.pid, 'SIGKILL');
  else process.exit(code ?? 125);
});
