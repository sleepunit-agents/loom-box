// Short, read-only model calls. Choice stays on the control plane; execution and
// the login stay in the calling house. Prompts and answers never cross this API.
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, StateError } from './state.mjs';
import { deriveAccounts, stateAccounts } from './accounts.mjs';
import { membersOf } from './owners.mjs';
import { resolveFor } from './models.mjs';
import { shortCallGate } from './delivery.mjs';
import { lastRateLimit, terminalOutcome, codexUsageOnBox, tailOf, CRED_FILE } from './logins.mjs';
import { codexLayers } from './runners.mjs';
import { runAsync, answerOf } from './grader.mjs';

const fail = (s, status = 400) => { throw new StateError(s, status); };

export function oneShotAccounts(env, caller) {
  if (caller.kind !== 'agent' || !caller.house) fail('a one-shot runs in its agent’s house', 403);
  const s = load(env), h = s.houses?.[caller.house];
  if (!h || h.agent !== caller.agent || !['starting', 'running'].includes(h.state)) fail('no such house running', 403);
  return { s, h, list: { accounts: deriveAccounts(s, { members: membersOf(env) }).accounts.filter(a => a.kind === 'login' && a.boxes.includes(h.box) && (h.logins ?? []).includes(a.harness)) } };
}

export function refuseOneShot(env, caller, { harness } = {}) {
  if (!['claude', 'codex'].includes(harness)) fail('which harness');
  const { list } = oneShotAccounts(env, caller);
  for (const a of list.accounts.filter(a => a.harness === harness)) stateAccounts(env).hold({ name: a.name, why: 'one-shot refused for a usage limit' });
  return { ok: true };
}

export async function chooseOneShot(env, caller, { prefer = [], avoid = [], modelNeed } = {}) {
  const { list } = oneShotAccounts(env, caller);
  if (!Array.isArray(prefer) || prefer.some(x => typeof x !== 'string') || prefer.length > 32) fail('prefer is a list of models');
  if (!Array.isArray(avoid) || avoid.some(x => !['claude', 'codex'].includes(x))) fail('avoid is a list of harnesses');
  const pick = await resolveFor(env, { agent: caller.agent, venueKind: 'agent', prefer, avoid, modelNeed,
    accounts: { list: () => list }, gate: shortCallGate(env, 'agent') });
  const { accountKey: _private, ...out } = pick;
  return out;
}

export function oneShotArgs(harness, model, cwd) {
  if (harness === 'claude') return ['-p', '--safe-mode', '--permission-prompts', 'none', '--model', model, '--output-format', 'stream-json', '--verbose'];
  if (harness === 'codex') return ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd,
    '--disable', 'multi_agent', '--disable', 'hooks', '--disable', 'skill_mcp_dependency_install', '--disable', 'apps', '--disable', 'plugins', '--disable', 'memories', '--disable', 'skill_search', '-c', 'web_search="disabled"', '-m', model, '-'];
  fail('unsupported one-shot harness');
}

export async function runOneShot(env, { input, cwd, prefer = [], modelNeed, timeout = 600_000 }, { call, run = runAsync, warn = s => process.stderr.write(`${s}\n`) } = {}) {
  if (!env.HOUSE_ID || !call) fail('one-shot needs a runtime house and its piece connection');
  const avoid = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const pick = await call('oneshot-choice', { prefer, avoid, ...(modelNeed ? { modelNeed } : {}) });
    if (pick.error || pick.ok === false) fail(pick.error || pick.reason);
    if (!['claude', 'codex'].includes(pick.harness) || !/^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/.test(pick.model ?? '')) fail('invalid runtime choice');
    const dir = mkdtempSync(join(tmpdir(), 'loom-oneshot-'));
    let r, reading, refusal, validAnswer;
    try {
      const childEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'].filter(k => typeof env[k] === 'string').map(k => [k, env[k]]));
      if (pick.harness === 'claude') {
        if (!env.CLAUDE_SECURESTORAGE_CONFIG_DIR) fail('one-shot needs the house’s mounted Claude login');
        childEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
        childEnv.CLAUDE_CONFIG_DIR = join(dir, 'claude');
        mkdirSync(childEnv.CLAUDE_CONFIG_DIR);
      }
      if (pick.harness === 'codex') {
        if (codexLayers(cwd, { realHome: env.CODEX_HOME || join(env.HOME, '.codex'), userHome: env.HOME }).length) fail('Codex configuration outside the fresh home prevents a cold one-shot');
        const home = join(dir, 'codex'); mkdirSync(home);
        symlinkSync(join(env.CODEX_HOME || join(env.HOME, '.codex'), CRED_FILE.codex), join(home, CRED_FILE.codex));
        childEnv.CODEX_HOME = home;
      }
      warn(`one-shot: ${pick.model} (${pick.harness}) on ${pick.account ?? 'its login'}`);
      r = await run(pick.harness, oneShotArgs(pick.harness, pick.model, cwd), { env: childEnv, input, timeout, cwd, killGroup: true });
      reading = pick.harness === 'codex' ? codexUsageOnBox(childEnv, { root: join(childEnv.CODEX_HOME, 'sessions') }) : r.readings?.claude ?? lastRateLimit('claude', r.stdout);
      const stdoutState = terminalOutcome(pick.harness, r.stdout);
      let rolloutState = null;
      // A dedicated home and no subagents: only this run's provider trace. The
      // rollout is authoritative over stdout bookkeeping; conflicting explicit
      // non-quota failures fail closed instead of spending a second account.
      if (pick.harness === 'codex') {
        const { readdirSync } = await import('node:fs');
        const walk = p => { try { return readdirSync(p, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(p, e.name)) : e.isFile() && e.name.endsWith('.jsonl') ? [join(p, e.name)] : []); } catch { return []; } };
        for (const f of walk(join(childEnv.CODEX_HOME, 'sessions'))) {
          const next = terminalOutcome('codex', tailOf(f) ?? '');
          if (next) rolloutState = next;
        }
      }
      const state = [stdoutState, rolloutState].some(s => s?.kind === 'error') ? { kind: 'error' } : rolloutState ?? stdoutState;
      refusal = state?.kind === 'quota';
      validAnswer = state?.kind === 'answer';
      if (reading) {
        const reported = await call('usage', { harness: pick.harness, reading: { ...reading, checked: reading.checked ?? Math.floor(Date.now() / 1000) } });
        if (reported.error || reported.ok === false) fail('one-shot usage report failed');
      } else warn('one-shot: harness returned no quota reading; account total remains last measured');
    } finally { rmSync(dir, { recursive: true, force: true }); }
    if (r.error || r.signal || r.truncated) fail('one-shot process failed, timed out or exceeded its output limit (not retried)');
    if (refusal) {
      const held = await call('oneshot-refused', { harness: pick.harness });
      if (held.error || held.ok === false) fail('could not hold refused account');
    }
    if (refusal && !attempt) { avoid.push(pick.harness); continue; }
    if (r.error || r.signal || r.status !== 0 || refusal || !validAnswer) fail('one-shot failed (no prompt or output logged)');
    return answerOf(pick.harness, r.stdout);
  }
}
