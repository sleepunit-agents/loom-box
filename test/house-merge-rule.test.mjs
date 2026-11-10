// A house body's merge-rule check, end to end (t-2136, after t-2063): the runtime signs whom the body works for, and
// the approvals piece itself (its own CLI, as loom's piece API runs it) reads that statement with this runtime's
// `principal --verify`. A job the owner started is his, so his standing rules answer it; a job started from a
// conversation someone else steered is theirs; a body left in the shared house from before t-2061 gets no statement
// and is someone loom can't name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from '../src/control.mjs';
import { deliver, loadConv, saveConv } from '../src/delivery.mjs';
import { spawnCall } from '../src/spawn.mjs';
import { cvOf, here, world } from './delivery-world.mjs';

const ROOT = join(here, '..');
// The approvals piece's own CLI: CI checks it out next to loom (LOOM_APPROVALS); else a clone in ~/Code.
const APPROVALS = process.env.LOOM_APPROVALS || join(homedir(), 'Code', 'loom-approvals', 'bin', 'approvals');
const skip = existsSync(APPROVALS) ? false : `no approvals piece at ${APPROVALS} (set LOOM_APPROVALS)`;

const fx = { now: () => new Date() };
const HEAD = 'a'.repeat(40);
const TARGET = `github:sleepunit-agents/loom#680@${HEAD}`;
const perConversation = () => { const m = {}; let n = 0; return new Proxy({}, { get: (_, k) => (typeof k === 'string' ? (m[k] ??= `h-${++n}`) : undefined) }); };

function household(env) {
  const dir = join(env.HOME, '.config', 'loom');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'household.json'), JSON.stringify({ members: [{ person: 'jonathan', agents: '*' }] }));
  return env;
}

/** The body holding `cv`, as its house's call arrives: its run's key, its session, and the house it runs in. */
function bodyOf(w, cv) {
  const c = loadConv(w.env, cv);
  const id = c.body.split(':')[1];
  return { caller: { kind: 'agent', agent: 'art', house: w.runner.where({ seat: c.bodyRules.seat }).house },
    proof: { conversation: cv, key: w.runner.envs[id].LOOM_BODY_KEY, session: w.sessionFor(cv) } };
}

/** What the house's piece-call gets from `loom-runtime principal`: the runtime's piece API answer. */
const statementOf = async (w, cv) => {
  const { caller, proof } = bodyOf(w, cv);
  return { caller, r: await api(w.env, fx, { caller, path: 'principal', body: proof }) };
};

/**
 * `approvals rule merge TARGET --json`, as loom's piece API runs it for this house's call (`approvals api`, caller and
 * argv), with the statement piece-call adds. The piece checks it with this runtime's CLI on this runtime's state.
 */
function ruleCheck(w, caller, statement) {
  const D = mkdtempSync(join(tmpdir(), 'merge-rule-'));
  const verify = join(D, 'loom-runtime');
  writeFileSync(verify, `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, 'src/cli.mjs')}' "$@"\n`, { mode: 0o755 });
  const argv = ['rule', 'merge', TARGET, '--json', ...(statement ? ['--principal', statement] : [])];
  // The piece's own CLI, run as loom's machine runs it. It won't answer as the piece inside a container (in_a_house:
  // /run/.containerenv), and lanes run these tests in houses: there, that one check is off, nothing else.
  const shim = "import sys, importlib.machinery as m; a = m.SourceFileLoader('approvals', sys.argv[1]).load_module(); a.in_a_house = lambda: False; sys.argv = ['approvals', *sys.argv[2:]]; a.main()";
  const out = execFileSync('python3', ['-I', '-c', shim, APPROVALS, 'api'], {
    input: JSON.stringify({ path: 'run', caller, body: { argv } }), encoding: 'utf-8',
    // loom's machine: the runtime's own environment (its state, for --verify) and the piece's settings; no body's.
    env: { PATH: process.env.PATH, ...w.env,
      APPROVALS_DIR: join(D, 'approvals'), APPROVALS_PRINCIPAL: `${verify} principal`,
      APPROVALS_SEED_RULES: JSON.stringify([{ kind: 'merge', scope: 'github:sleepunit-agents/*', tier: 'do' }]) },
  });
  const res = JSON.parse(out);
  assert.equal(res.status, 200, out);
  assert.equal(res.body.exit, 0, out);
  return JSON.parse(res.body.stdout)[TARGET];
}

test('a house body in a job the owner started is his: his standing rule answers its merge (do, for owner)', { skip }, async () => {
  const w = world();
  household(w.env);
  w.runner.houses = perConversation();
  const r = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'Rebase and merge loom#680' }, w.o);
  const c = loadConv(w.env, r.handle);
  assert.equal(c.bodyRules.seat, `owner.${r.handle}`, 'in a house of its own conversation alone');
  const { caller, r: st } = await statementOf(w, r.handle);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.deepEqual([st.body.owner, st.body.conversation], [true, r.handle]);
  assert.deepEqual(ruleCheck(w, caller, st.body.statement), { tier: 'do', for: 'owner', scope: 'github:sleepunit-agents/*' });
  // A job that job started is still his (its lineage is the owner's).
  const sub = await spawnCall(w.env, caller, { ...bodyOf(w, r.handle).proof, brief: 'Review it cold' }, w.o);
  const s2 = await statementOf(w, sub.handle);
  assert.equal(ruleCheck(w, s2.caller, s2.r.body.statement).for, 'owner');
});

test('a house body in a job someone else\'s conversation started is theirs, never the owner\'s: it asks', { skip }, async () => {
  const w = world();
  household(w.env);
  w.runner.houses = perConversation();
  // Loren (not an owner) asks in a DM; her conversation's body starts a job.
  await deliver(w.env, w.msg('dm:L', 'please merge loom 680'), w.o);
  const L = cvOf('art', 'slack', 'dm:L');
  const parent = bodyOf(w, L);
  const job = await spawnCall(w.env, parent.caller, { ...parent.proof, brief: 'merge it' }, w.o);
  assert.equal(loadConv(w.env, job.handle).bodyRules.seat, `p-loren.${job.handle}`);
  const { caller, r: st } = await statementOf(w, job.handle);
  assert.deepEqual([st.status, st.body.for, st.body.owner], [200, 'loren', false]);
  const answer = ruleCheck(w, caller, st.body.statement);
  assert.deepEqual([answer.tier, answer.for], ['ask', 'loren'], 'the owner\'s rule is his own work\'s; Loren has no grant');
  // A statement is a bearer word for 5 minutes, so one shown to another conversation's body (a relay's text, a task
  // comment) holds only from its own body's house: the owner's job's statement, from Loren's job's house, is no one's.
  const mine = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'x' }, w.o);
  const his = await statementOf(w, mine.handle);
  assert.equal(ruleCheck(w, his.caller, his.r.body.statement).for, 'owner');
  assert.deepEqual([ruleCheck(w, caller, his.r.body.statement).for, ruleCheck(w, caller, his.r.body.statement).tier], ['?', 'ask']);
  assert.equal(ruleCheck(w, his.caller, st.body.statement).for, '?', 'nor hers from his');
});

test('a body left in the shared house from before t-2061 gets no statement, says why, and is someone loom can\'t name', { skip }, async () => {
  const w = world();
  household(w.env);
  w.runner.houses = perConversation();
  // Lane 3l (cv-b61172b34a7d): its owner job started in the shared `owner` house just before the cut-over deploy.
  const r = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'six PRs' }, w.o);
  const { caller, proof } = bodyOf(w, r.handle);
  const c = loadConv(w.env, r.handle);
  c.bodyRules = { ...c.bodyRules, seat: 'owner' };
  saveConv(w.env, c);
  const st = await api(w.env, fx, { caller, path: 'principal', body: proof });
  assert.equal(st.status, 409);
  assert.match(st.body.reason, /moved to another principal's house/, 'the reason piece-call now passes on');
  assert.equal(ruleCheck(w, caller, null).for, '?');
  // Nor does a statement borrowed from the owner's other job make it his: that one holds only from its own house.
  const other = await spawnCall(w.env, { kind: 'owner' }, { agent: 'art', brief: 'y' }, w.o);
  const os = await statementOf(w, other.handle);
  assert.equal(os.r.body.owner, true);
  assert.equal(ruleCheck(w, caller, os.r.body.statement).for, '?');
});
