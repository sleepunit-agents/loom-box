#!/usr/bin/env node
// Model-free native CLI for the real-container host-death proof. Never invokes
// a provider CLI. Resume must find the original native context before accepting
// another brief, through each adapter's normal native file layout.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const home = process.env.HOME, args = process.argv.slice(2), harness = process.env.FIXTURE_NATIVE_HARNESS;
const seed = 'native-host-death-context-v1';
const put = (file, value) => writeFileSync(file, value, { mode: 0o600 });
const proof = (session, resumed, brief) => put(join(home, 'proof.json'), JSON.stringify({ session, resumed,
  pending: brief.split('PENDING-HOST-DEATH-FOLLOWUP').length - 1,
  next: brief.split('NEXT-HOST-DEATH-TURN').length - 1 }));
const resumeAt = args.indexOf(harness === 'claude' ? '--resume' : 'resume');
const resumed = resumeAt >= 0;

if (harness === 'claude') {
  const jobs = join(process.env.CLAUDE_CONFIG_DIR, 'jobs'), projects = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
  const agentsFile = join(home, 'agents.json');
  if (args[0] === 'agents') { process.stdout.write(existsSync(agentsFile) ? readFileSync(agentsFile) : '[]'); process.exit(0); }
  if (args[0] === 'stop') {
    const file = join(jobs, args[1], 'state.json'), state = JSON.parse(readFileSync(file, 'utf8'));
    put(file, JSON.stringify({ ...state, state: 'stopped' })); process.exit(0);
  }
  if (args[0] !== '--bg') throw Error('unexpected fixture Claude command');
  const brief = readFileSync(0, 'utf8'), session = resumed ? args[resumeAt + 1] : randomUUID(), id = session.slice(0, 8);
  mkdirSync(projects, { recursive: true });
  const file = join(projects, `${session}.jsonl`);
  if (resumed && !readFileSync(file, 'utf8').includes(seed)) throw Error('native Claude context was not restored');
  if (!resumed) put(file, JSON.stringify({ type: 'assistant', message: { content: seed } }) + '\n');
  mkdirSync(join(jobs, id), { recursive: true });
  put(join(jobs, id, 'state.json'), JSON.stringify({ state: 'working', intent: brief, sessionId: session }));
  put(agentsFile, JSON.stringify([{ id, kind: 'background', sessionId: session, state: 'running' }]));
  proof(session, resumed, brief); process.stdout.write(id + '\n');
} else if (harness === 'codex') {
  if (args[0] !== 'exec') throw Error('unexpected fixture Codex command');
  const brief = readFileSync(0, 'utf8'), session = resumed ? args[resumeAt + 1] : randomUUID();
  const dir = join(process.env.CODEX_HOME, 'sessions', '2026', '11', '09'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-fixture-${session}.jsonl`);
  if (resumed && !readFileSync(file, 'utf8').includes(seed)) throw Error('native Codex context was not restored');
  if (!resumed) put(file, JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { content: seed } }) + '\n');
  appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
  proof(session, resumed, brief);
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: session }) + '\n' + JSON.stringify({ type: 'turn.started' }) + '\n');
  // Work remains live until its owning container is killed or the real adapter
  // interrupts it; this is not a timer standing in for process termination.
  setInterval(() => {}, 1000);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
} else throw Error('fixture harness is required');
