#!/usr/bin/env node
// A stand-in for Claude Code's background sessions (`claude --bg`), for the runner tests. Its daemon is a dir
// ($FAKE_HARNESS): jobs/<id8>/state.json as Claude's job dirs have them (state, intent, sessionId), agents.json for
// `claude agents --json`, and argv.log, every call's argv. A test ends a turn by writing the job's state.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const D = process.env.FAKE_HARNESS;
const args = process.argv.slice(2);
appendFileSync(join(D, 'argv.log'), JSON.stringify(args) + '\n');
const agentsFile = join(D, 'agents.json');
const agents = () => (existsSync(agentsFile) ? JSON.parse(readFileSync(agentsFile, 'utf-8')) : []);
const job = (id) => join(D, 'jobs', id.slice(0, 8), 'state.json');

if (args[0] === '--bg') {
  if (existsSync(join(D, 'refuse'))) { process.stderr.write('Error: not logged in\n'); process.exit(1); }
  const prompt = readFileSync(0, 'utf-8');
  const at = args.indexOf('--resume');
  const id = randomBytes(4).toString('hex');
  const sessionId = at >= 0 ? args[at + 1] : `${id}-${randomUUID().slice(9)}`;
  mkdirSync(join(D, 'jobs', id), { recursive: true });
  writeFileSync(job(id), JSON.stringify({ state: 'working', intent: prompt, sessionId, respawnFlags: args.slice(1) }));
  writeFileSync(agentsFile, JSON.stringify([...agents(), { id, kind: 'background', sessionId, state: 'running' }]));
  process.stdout.write(`${id}\n`);
  process.exit(0);
}
if (args[0] === 'agents') { process.stdout.write(JSON.stringify(agents())); process.exit(0); }
if (args[0] === 'stop') {
  const s = JSON.parse(readFileSync(job(args[1]), 'utf-8'));
  writeFileSync(job(args[1]), JSON.stringify({ ...s, state: 'stopped' }));
  process.exit(0);
}
process.exit(2);
