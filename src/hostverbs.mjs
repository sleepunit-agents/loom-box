// Host verbs (t-2096; loom note runtime/2026-11-10-t2049-phase3-local-bodies-off-loom, step 3): the one way a body in a
// house asks loom's machine for a host step, with no shell there and no model on it.
//
//   body (house) ──run {argv: [host, <verb>, …args], key, session}──► runtime (gates-api.mjs, runFor)
//        1. the caller proves it holds its conversation now (its run's key and session, as `send` does), and that
//           conversation and the caller's house are the owner's work: anyone else is refused before anything is read
//        2. the verb and its arguments parse against the fixed table below (no free-form command, ever)
//        3. its tier: the owner's standing rule for kind `host` (approvals `rule host <verb>:<arg>`), else the verb's own
//           (reads: do; changes: ask). ask: a `host` approval for exactly `<verb>:<arg>`, spent once (`approvals use`);
//           tell: an FYI filed first (a tell that can't be filed refuses the verb)
//        4. the request is written to the spool (deliveryDir/host-exec/queue), and only then can it run
//   loom-runtime host-exec (its own unit on loom's machine, no model) ──► claims it, parses it again against the same
//        table, runs the fixed argv with no shell, bounded in time and output, redacted, and writes the result
//   body ──run {argv: [host, result, <id>], key, session}──► the result, only for the same conversation's holder
//
// The executor is its own process so a verb that restarts loom or this piece (deploy-loom, pieces-update runtime) isn't
// killed with the process that asked for it.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { approvalsFake, approvalsRunAsync, approvalsWhy } from './approvals-call.mjs';
import { redact } from './redact.mjs';
import { setting } from './piece.mjs';
import { householdOwners, membersOf, ownersOf } from './owners.mjs';

export const HOST_ID = /^hx-[0-9a-f]{16}$/;
const APPROVAL_ID = /^a-[0-9a-f]{8,32}$/;
const CV = /^cv-[0-9a-f]{12}$/;
/** What a result keeps of a verb's output: its tail, this many bytes at most. */
export const OUTPUT_MAX = 64 * 1024;
/** How long a body's call waits for a quick verb's result before it answers with the request's id (inside loom's 15 s). */
const WAIT_MS = 2_000;
const KEEP_RESULTS = 200;
const KEEP_MS = 7 * 24 * 3600 * 1000;

// ─── The verbs: a fixed table, each argument typed ──────────────────────────

const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;          // deploy-loom's own rule, and never a flag (-h, --prepare)
const PIECE = /^[a-z][a-z0-9-]{0,39}$/;
// Units a body may read about: loom's own and Art's lanes. Restart is narrower (RESTARTABLE).
const UNIT = /^(?:loom-[a-z0-9-]{1,60}|art-[a-z0-9-]{1,60}|wake-rearm)\.(?:service|timer)$/;
const RESTARTABLE = /^(?:loom-http(?:-local|-lan)?|loom-piece-[a-z0-9-]{1,40})\.service$/;
const SINCE = /^([1-9][0-9]{0,2})(m|h|d)$/;
// System tools by absolute path, never looked up on a PATH a checkout could put something ahead of.
const SYS = { systemctl: '/usr/bin/systemctl', journalctl: '/usr/bin/journalctl', flock: '/usr/bin/flock' };
const unitOf = (u) => (typeof u === 'string' && !u.includes('.') ? `${u}.service` : u);

/**
 * Each verb: `tier` when no standing rule says otherwise, `args(list) -> {arg, …} | string (why not)`, `target(p)` (what
 * an approval names), `argv(p, env)` (the executor's fixed command), `timeoutMs`, `changes` (serialised, never retried).
 */
export const VERBS = {
  'unit-status': {
    tier: 'do', changes: false, timeoutMs: 15_000,
    usage: 'unit-status <unit>',
    args: ([u, ...more]) => { const unit = unitOf(u); return more.length || !UNIT.test(unit ?? '') ? 'unit-status takes one unit: loom-*, art-* or wake-rearm (.service or .timer)' : { unit }; },
    target: (p) => p.unit,
    argv: (p) => [SYS.systemctl, '--user', 'status', '--no-pager', '--lines=0', '--', p.unit],
  },
  journal: {
    tier: 'do', changes: false, timeoutMs: 20_000,
    usage: 'journal <unit> [--since 2h] [--lines 200]',
    args: (list) => {
      const [u, ...rest] = list;
      const unit = unitOf(u);
      if (!UNIT.test(unit ?? '')) return 'journal takes a unit: loom-*, art-* or wake-rearm (.service or .timer)';
      let since = '1h', lines = 200;
      for (let i = 0; i < rest.length; i += 2) {
        const [k, v] = [rest[i], rest[i + 1]];
        if (k === '--since' && SINCE.test(v ?? '')) since = v;
        else if (k === '--lines' && /^[1-9][0-9]{0,3}$/.test(v ?? '') && Number(v) <= 2000) lines = Number(v);
        else return 'journal <unit> [--since N(m|h|d), up to 999] [--lines 1..2000]';
      }
      return { unit, since, lines };
    },
    target: (p) => p.unit,
    argv: (p) => { const [, n, u] = SINCE.exec(p.since); return [SYS.journalctl, '--user', '--no-pager', '--output=short-iso', `--since=-${n}${u === 'm' ? 'min' : u}`, `--lines=${p.lines}`, '--unit', p.unit]; },
  },
  // A script from ~/Art, which syncs from its repo by itself: what it runs can change with a push, so it's asked for
  // like a change (the owner's yes is for this run), never run on its own say-so.
  'art-chain-check': {
    tier: 'ask', changes: true, timeoutMs: 120_000,
    usage: 'art-chain-check',
    args: (list) => (list.length ? 'art-chain-check takes nothing' : {}),
    target: () => 'art',
    argv: (_p, env) => [join(artHome(env), 'bin', 'art-chain-check')],
    ask: () => 'Run Art\'s wake-chain check on loom\'s machine?',
  },
  read: {
    tier: 'do', changes: false, timeoutMs: 10_000,
    usage: 'read <path under the runtime\'s delivery logs or hosts/>',
    args: ([p, ...more]) => (more.length || typeof p !== 'string' || !p || p.length > 300 || p.includes('\0') ? 'read takes one path' : { path: p }),
    target: (p) => p.path,
    argv: null, // read in-process by the executor (readAllowed), never through a command
  },
  'deploy-loom': {
    tier: 'ask', changes: true, timeoutMs: 30 * 60_000,
    usage: 'deploy-loom <label>',
    args: ([l, ...more]) => (more.length || !LABEL.test(l ?? '') ? 'deploy-loom takes one label: letters, digits, dots, underscores or hyphens' : { label: l }),
    target: (p) => p.label,
    argv: (p, env) => [SYS.flock, '-w', '1800', '/tmp/deploy-loom.lock', join(artHome(env), 'bin', 'deploy-loom'), p.label],
    ask: (p) => `Deploy loom's latest build on loom's machine (${p.label})?`,
  },
  'pieces-update': {
    tier: 'ask', changes: true, timeoutMs: 15 * 60_000,
    usage: 'pieces-update <piece>',
    args: ([x, ...more]) => (more.length || !PIECE.test(x ?? '') ? 'pieces-update takes one piece name' : { piece: x }),
    target: (p) => p.piece,
    argv: (p, env) => [loomBin(env), 'pieces', 'update', p.piece],
    ask: (p) => `Update loom's ${p.piece} piece on loom's machine?`,
  },
  restart: {
    tier: 'ask', changes: true, timeoutMs: 120_000,
    usage: 'restart <loom-http | loom-http-local | loom-http-lan | loom-piece-*>',
    args: ([u, ...more]) => { const unit = unitOf(u); return more.length || !RESTARTABLE.test(unit ?? '') ? 'restart takes one unit: loom-http, loom-http-local, loom-http-lan or loom-piece-*' : { unit }; },
    target: (p) => p.unit,
    argv: (p) => [SYS.systemctl, '--user', 'restart', '--', p.unit],
    ask: (p) => `Restart ${p.unit.replace(/\.service$/, '')} on loom's machine?`,
  },
};

const loomBin = (env) => (isAbsolute(env.LOOM_BIN ?? '') ? env.LOOM_BIN : join(env.HOME || homedir(), '.local', 'bin', 'loom'));
const artHome = (env) => setting(env, 'HOST_ART') || join(env.HOME || homedir(), 'Art');
const dataDir = (env) => env.LOOM_BOX_DATA || join(env.HOME || homedir(), '.local', 'share', 'loom-box');
export const hostExecDir = (env) => join(dataDir(env), 'delivery', 'host-exec');
const dirOf = (env, d) => join(hostExecDir(env), d);

/** A verb and its arguments as typed, or {error}. Parsed the same way on both sides of the spool. */
export function parseVerb(verb, list) {
  const v = typeof verb === 'string' && Object.hasOwn(VERBS, verb) ? VERBS[verb] : null;
  if (!v) return { error: `no host verb ${JSON.stringify(String(verb ?? '')).slice(0, 60)}: ${Object.values(VERBS).map((x) => x.usage).join(' | ')}` };
  if (!Array.isArray(list) || !list.every((a) => typeof a === 'string')) return { error: 'a verb\'s arguments are strings' };
  const p = v.args(list);
  if (typeof p === 'string') return { error: p };
  return { verb, p, target: `${verb}:${v.target(p)}` };
}

// ─── Who may ask: the owner's own work, proved ──────────────────────────────

/**
 * The conversation record when the caller is a body holding `cv` in its current run whose work is the owner's, both by
 * the conversation's principal and by the house it runs in; else {reason}. `d`: {heldConv, principalOf, housePrincipal}.
 */
export function ownerBody(env, caller, cv, proof, d) {
  const no = { reason: 'host verbs are for a body doing its owner\'s own work, proved from its house (`loom runtime host`)' };
  if (caller?.kind !== 'agent' || typeof caller.agent !== 'string' || !CV.test(cv ?? '')) return no;
  // The household owner's agent only: "owner" below is the agent's owner, and a member's own agent (owned by someone
  // who isn't a household owner) is that member's, never one that may touch loom's machine.
  if (!(d.householdAgent ?? householdAgent)(env, caller.agent)) return no;
  if (typeof proof?.key !== 'string' || !proof.key || typeof proof.session !== 'string' || !proof.session) return no;
  const c = d.heldConv(env, cv, proof, { caller });
  if (!c || c.agent !== caller.agent) return no;
  if (d.principalOf(env, c)?.owner !== true) return no;
  // Its house: the owner's seat (or a job house whose work is the owner's). A body on loom's machine (no house) only when
  // its conversation is a local one: heldConv already refused a house caller for it, and a local one for a house body.
  if (typeof caller.house === 'string') {
    if (d.housePrincipal(caller.house)?.owner !== true) return no;
  } else if (!c.local) return no;
  return { c };
}

/** Whether every owner of `agent` is a household owner (an agent no member names is the household owners'). */
export function householdAgent(env, agent) {
  const ms = membersOf(env);
  const hh = householdOwners(ms);
  const own = ownersOf(ms, agent);
  return own.length > 0 && own.every((p) => hh.includes(p));
}

// ─── The tier: the owner's standing rule, else the verb's own ───────────────

const TIERS = new Set(['do', 'tell', 'ask']);
/** The tier a standing rule gives `target`, or null (no host rules yet, a timeout, anything unreadable: the verb's own). */
async function ruleTier(env, caller, target) {
  // The approvals piece has standing rules for merges only (t-2104): until it has host rules, asking costs a spawn
  // inside the call's 15 s and always says no, so it's asked only once the household says it can answer.
  if (setting(env, 'HOST_RULES') !== '1') return null;
  const fx = approvalsFake(env);
  const r = fx?.rule ? await fx.rule(target) : await approvalsRunAsync(env, ['rule', 'host', target, '--as', JSON.stringify(caller), '--on-behalf', 'owner']);
  if (!r || r.error || r.status !== 0) return null;
  const t = String(r.stdout ?? '').trim().split(/\s+/)[0];
  return TIERS.has(t) ? t : null;
}

/** The tier a verb runs at: the owner's standing rule for it when there is one he set, else the verb's own. */
export async function tierOf(env, caller, parsed) {
  return (await ruleTier(env, caller, parsed.target)) ?? VERBS[parsed.verb].tier;
}

// ─── Asking: spend, then spool ──────────────────────────────────────────────

const writeJson = (f, v) => { const t = `${f}.${randomBytes(4).toString('hex')}.tmp`; writeFileSync(t, JSON.stringify(v), { mode: 0o600 }); renameSync(t, f); };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return null; } };
const ensureDirs = (env) => { for (const d of ['queue', 'running', 'done']) mkdirSync(dirOf(env, d), { recursive: true, mode: 0o700 }); chmodSync(hostExecDir(env), 0o700); };

function logLine(env, row) {
  try {
    const f = join(hostExecDir(env), 'log.jsonl');
    mkdirSync(hostExecDir(env), { recursive: true, mode: 0o700 });
    try { if (statSync(f).size > 2 * 1024 * 1024) renameSync(f, `${f}.1`); } catch { /* none yet */ }
    writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { flag: 'a', mode: 0o600 });
  } catch { /* the log never stops a verb */ }
}

/**
 * `host <verb> …args --conversation cv [--approval a-…]`, from a body: {ok, id, state, …result} or {ok: false, reason}.
 * `d` (deps, for tests): {heldConv, principalOf, housePrincipal, now?, waitMs?}.
 */
export async function hostRequest(env, caller, args, proof, d) {
  // One budget inside loom's 15 s for the whole call: what's left of it is what the answer waits for.
  const deadline = Date.now() + (d.budgetMs ?? 11_000);
  const a = [...args];
  const take = (n) => { const i = a.indexOf(n); if (i < 0) return undefined; const v = a[i + 1]; a.splice(i, 2); return v; };
  const cv = take('--conversation');
  const approval = take('--approval');
  // Who first: anyone but the owner's own body learns nothing else here, not even whether the verb would parse.
  const who = ownerBody(env, caller, cv, proof, d);
  if (!who.c) return { ok: false, reason: who.reason };
  const [verb, ...rest] = a;
  const parsed = parseVerb(verb, rest);
  if (parsed.error) return { ok: false, reason: parsed.error, usage: true };
  const tier = await tierOf(env, caller, parsed);
  const v = VERBS[parsed.verb];
  // The spool first: one that can't be written never costs the owner's yes.
  try { ensureDirs(env); } catch (e) { return { ok: false, reason: `the host steps' spool can't be written (${e.code ?? e.message})` }; }
  if (tier === 'ask') {
    if (approval === undefined) {
      return { ok: false, needsApproval: true, reason: `${parsed.verb} changes loom's machine, so it needs the owner's yes for exactly this: approvals request --kind host --target '${parsed.target}' --ask '${(v.ask?.(parsed.p) ?? `Run ${parsed.target} on loom's machine?`).replace(/'/g, '’')}' --why '<one line>' --if-yes '<what you do>' --if-no '<what you do instead>', park on it, then ask again with --approval <its id>` };
    }
    if (!APPROVAL_ID.test(approval)) return { ok: false, reason: '--approval is an approval id (a-…)' };
    const why = await spend(env, caller, approval, parsed.target);
    if (why) return { ok: false, reason: `approval ${approval} isn't an allowed host approval for ${parsed.target}: ${why}` };
  } else if (approval !== undefined) {
    // Not spent when it isn't needed: it stays his for what it was asked for.
    return { ok: false, reason: `${parsed.target} runs without asking (${tier}); leave --approval off` };
  }
  if (tier === 'tell') {
    const why = await tell(env, caller, parsed.target, `${caller.agent} ran ${parsed.target} on loom's machine`);
    if (why) return { ok: false, reason: `${parsed.target} is "tell me after", and the owner couldn't be told (${why}), so it didn't run` };
  }
  const now = (d.now ?? Date.now)();
  const id = `hx-${randomBytes(8).toString('hex')}`;
  const req = { id, verb: parsed.verb, args: rest, target: parsed.target, tier, agent: caller.agent, house: caller.house ?? null, conversation: cv, run: who.c.run ?? null, at: new Date(now).toISOString(), ...(tier === 'ask' ? { approval } : {}) };
  writeJson(join(dirOf(env, 'queue'), `${id}.json`), req);
  logLine(env, { id, event: 'queued', verb: parsed.verb, target: parsed.target, tier, agent: caller.agent, conversation: cv, ...(tier === 'ask' ? { approval } : {}) });
  // A quick verb's answer comes back in this call; a long one's by `host result <id>`.
  const until = Math.min(Date.now() + (d.waitMs ?? WAIT_MS), deadline);
  for (;;) {
    const r = resultFor(env, id);
    if (r || Date.now() >= until) return r ? { ok: true, ...r } : { ok: true, id, state: stateOf(env, id), target: parsed.target, tier, then: `loom runtime host result ${id}` };
    await new Promise((res) => setTimeout(res, 250));
  }
}

async function spend(env, caller, aid, target) {
  const fx = approvalsFake(env);
  const r = fx?.use ? await fx.use(aid, target, caller) : await approvalsRunAsync(env, ['use', aid, '--kind', 'host', '--target', target, '--as', JSON.stringify(caller), '--on-behalf', 'owner']);
  return r && !r.error && r.status === 0 ? '' : approvalsWhy(r ?? {});
}

async function tell(env, caller, target, what) {
  const fx = approvalsFake(env);
  const r = fx?.tell ? await fx.tell(target, what) : await approvalsRunAsync(env, ['tell', '--kind', 'host', '--target', target, '--what', what, '--as', JSON.stringify(caller), '--on-behalf', 'owner']);
  return r && !r.error && r.status === 0 ? '' : approvalsWhy(r ?? {});
}

const stateOf = (env, id) => (existsSync(join(dirOf(env, 'running'), `${id}.json`)) ? 'running' : existsSync(join(dirOf(env, 'queue'), `${id}.json`)) ? 'queued' : 'unknown');
function resultFor(env, id) {
  const r = readJson(join(dirOf(env, 'done'), `${id}.json`));
  return r && r.id === id ? r : null;
}

/** `host result <id> --conversation cv`: only for the body that holds the conversation that asked, in its current run's agent. */
export function hostResult(env, caller, args, proof, d) {
  const a = [...args];
  const i = a.indexOf('--conversation');
  const cv = i >= 0 ? a.splice(i, 2)[1] : undefined;
  const who = ownerBody(env, caller, cv, proof, d);
  if (!who.c) return { ok: false, reason: who.reason };
  const [id, ...more] = a;
  if (more.length || !HOST_ID.test(id ?? '')) return { ok: false, reason: 'host result <hx-…>', usage: true };
  const q = readJson(join(dirOf(env, 'done'), `${id}.json`)) ?? readJson(join(dirOf(env, 'running'), `${id}.json`)) ?? readJson(join(dirOf(env, 'queue'), `${id}.json`));
  // Another conversation's request is no one's to read here: said exactly as one that doesn't exist.
  if (!q || q.conversation !== cv || q.agent !== caller.agent) return { ok: false, reason: `no host request ${id} from ${cv}` };
  const done = resultFor(env, id);
  return done ? { ok: true, ...done } : { ok: true, id, state: stateOf(env, id), target: q.target, tier: q.tier };
}

// ─── The executor: model-free, on loom's machine ────────────────────────────

/** Where `read` may look: the delivery dir's runtime logs (not its subdirectories but hosts/), and hosts/. */
export function readAllowed(env, p, agent) {
  const base = join(dataDir(env), 'delivery');
  const LOGS = /^(?:allocator-(?:shadow|readings)\.jsonl(?:\.1)?|relays\.jsonl|host-exec\/log\.jsonl(?:\.1)?)$/;
  const rel = String(p).replace(/^\.\//, '');
  // hosts/: only the asking agent's own owner-seat record, never another agent's or a person's seat's.
  const own = typeof agent === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(agent) && rel === `hosts/${agent}.json`;
  if (rel.startsWith('/') || rel.split('/').includes('..') || !(LOGS.test(rel) || own)) return { error: 'read is for the runtime\'s logs (allocator-shadow.jsonl, allocator-readings.jsonl, relays.jsonl, host-exec/log.jsonl) and hosts/<your agent>.json, named under its delivery dir' };
  const full = join(base, rel);
  let real;
  try { if (lstatSync(full).isSymbolicLink()) return { error: 'read doesn\'t follow a link' }; real = realpathSync(full); } catch { return { error: `no ${rel}` }; }
  let baseReal;
  try { baseReal = realpathSync(base); } catch { return { error: 'no delivery dir' }; }
  if (!real.startsWith(baseReal + sep) || !statSync(real).isFile()) return { error: `${rel} isn't a file under the delivery dir` };
  return { path: real };
}

function tailOf(path, max = OUTPUT_MAX) {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const n = Math.min(size, max);
    const b = Buffer.alloc(n);
    readSync(fd, b, 0, n, size - n);
    return { text: b.toString('utf-8'), cut: size > n };
  } finally { closeSync(fd); }
}

/** Output kept: its tail, bounded, every line through redact.mjs. */
export function boundOutput(s) {
  const t = String(s ?? '');
  const cut = Buffer.byteLength(t) > OUTPUT_MAX;
  const tail = cut ? Buffer.from(t).subarray(-OUTPUT_MAX).toString('utf-8') : t;
  return { output: tail.split('\n').map(redactLine).join('\n'), ...(cut ? { cut: true } : {}) };
}

const PIECE_MAX = 1500;
const TOKENISH = /[A-Za-z0-9_\-+/=.~%]/;
const SECRETISH = /(?:pass|token|secret|key|auth|bearer|cookie|cred|pw|pin)[a-z_-]*\W{0,8}$/i;
/**
 * redact() reads at most 2000 characters (cutting back to a word), so a longer line is redacted in pieces, never
 * lost. A piece ends only between tokens, never inside one (a token cut in two could pass as two harmless halves),
 * and never just after a secret-named word (its value would start the next piece without it). A token-like run
 * longer than a piece with nothing to cut at is taken out whole: fail closed.
 */
export function redactLine(l) {
  if (l.length <= PIECE_MAX) return redact(l);
  const out = [];
  let i = 0;
  while (i < l.length) {
    if (l.length - i <= PIECE_MAX) { out.push(redact(l.slice(i))); break; }
    let cut = i + PIECE_MAX;
    while (cut > i && TOKENISH.test(l[cut - 1]) && TOKENISH.test(l[cut])) cut--;
    if (cut === i) {
      // One run of token characters longer than a piece: out whole, as a secret would be.
      let end = i;
      while (end < l.length && TOKENISH.test(l[end])) end++;
      out.push('…');
      i = end;
      continue;
    }
    const m = SECRETISH.exec(l.slice(Math.max(i, cut - 120), cut));
    if (m) { const back = cut - (m[0].length); if (back > i) cut = back; }
    out.push(redact(l.slice(i, cut)));
    i = cut;
  }
  return out.join('');
}

const childEnv = (env) => ({
  // node's own dir (loom is a node script) and the system's: never a checkout's bin, which a push could fill.
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: env.HOME || homedir(),
  ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}),
  ...(env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS } : {}),
  ...(env.LOOM_BIN ? { LOOM_BIN: env.LOOM_BIN } : {}), LANG: 'C.UTF-8',
});

/** Run one request (already claimed): its result. `exec` is runCommand's shape (tests stand one in).*/
export async function runOne(env, req, exec = runCommand) {
  const parsed = parseVerb(req?.verb, req?.args);
  const started = new Date().toISOString();
  if (parsed.error) return { id: req?.id, state: 'refused', reason: parsed.error, startedAt: started, endedAt: started };
  const v = VERBS[parsed.verb];
  if (parsed.verb === 'read') {
    const ok = readAllowed(env, parsed.p.path, req.agent);
    if (ok.error) return { id: req.id, verb: req.verb, target: parsed.target, state: 'failed', exit: 1, ...boundOutput(ok.error), startedAt: started, endedAt: new Date().toISOString() };
    const t = tailOf(ok.path);
    return { id: req.id, verb: req.verb, target: parsed.target, state: 'done', exit: 0, ...boundOutput(t.text), ...(t.cut ? { cut: true } : {}), startedAt: started, endedAt: new Date().toISOString() };
  }
  const [cmd, ...argv] = v.argv(parsed.p, env);
  const r = await exec(cmd, argv, { env: childEnv(env), timeoutMs: v.timeoutMs });
  // Past its time is a failure, whatever the last process said.
  const state = r.exit === 0 && !r.timedOut ? 'done' : 'failed';
  const note = r.timedOut ? `\n(stopped after ${Math.round(v.timeoutMs / 1000)} s)` : r.spawnError ? `\n(couldn't start ${cmd}: ${r.spawnError})` : '';
  return { id: req.id, verb: req.verb, target: parsed.target, state, exit: r.exit, ...(r.signal ? { signal: r.signal } : {}), ...boundOutput(r.out + note), startedAt: started, endedAt: new Date().toISOString() };
}

/**
 * Run a fixed argv with no shell, in its own process group, keeping only the output's tail: {exit, signal, timedOut,
 * spawnError, out}. Past its time the whole group is ended (SIGTERM, then SIGKILL), so nothing it started (deploy-loom
 * under flock) runs on beside the next change.
 */
export function runCommand(cmd, argv, { env, timeoutMs }) {
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    const keep = (b) => { out = Buffer.concat([out, b]); if (out.length > 2 * OUTPUT_MAX) out = out.subarray(-OUTPUT_MAX); };
    let child;
    try { child = spawn(cmd, argv, { env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ exit: null, spawnError: e.code ?? e.message, out: '' }); return; }
    let timedOut = false, done = false;
    const group = (sig) => { try { process.kill(-child.pid, sig); } catch { /* gone */ } };
    let kill = null;
    const t = setTimeout(() => { timedOut = true; group('SIGTERM'); kill = setTimeout(() => group('SIGKILL'), 10_000); kill.unref(); }, timeoutMs);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(t); resolve({ exit: null, spawnError: e.code ?? e.message, out: out.toString('utf-8') }); });
    child.on('close', (code, signal) => { if (done) return; done = true; clearTimeout(t); if (kill) clearTimeout(kill); if (timedOut) group('SIGKILL'); resolve({ exit: code, signal, timedOut, out: out.toString('utf-8') }); });
  });
}

/** A request file the executor will take: a plain file of ours, only ours to read and write. */
function trusted(f) {
  try {
    const s = lstatSync(f);
    return s.isFile() && (s.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || s.uid === process.getuid());
  } catch { return false; }
}

/**
 * One pass of the executor: a request left running by an executor that died is recorded as lost (a change may have
 * happened, so it's never run twice); then every queued request is claimed (renamed into running/, so only one
 * executor runs it) and run, changes one at a time, reads alongside. Resolves when this pass's runs end.
 */
export async function execPass(env, { exec = runCommand, state = { busy: new Set(), chain: Promise.resolve() }, log = logLine } = {}) {
  const { busy } = state;
  ensureDirs(env);
  const q = dirOf(env, 'queue'), run = dirOf(env, 'running'), done = dirOf(env, 'done');
  for (const n of readdirSync(run)) {
    const id = n.replace(/\.json$/, '');
    if (!HOST_ID.test(id) || busy.has(id)) continue;
    const req = readJson(join(run, n));
    writeJson(join(done, `${id}.json`), { id, verb: req?.verb, target: req?.target, state: 'lost', reason: 'the executor stopped while it ran; it may have acted, and it isn\'t run again', endedAt: new Date().toISOString() });
    rmSync(join(run, n), { force: true });
    log(env, { id, event: 'lost' });
  }
  const names = readdirSync(q).filter((n) => HOST_ID.test(n.replace(/\.json$/, '')) && n.endsWith('.json')).sort();
  const jobs = [];
  for (const n of names) {
    const id = n.replace(/\.json$/, '');
    const from = join(q, n), to = join(run, n);
    if (!trusted(from)) { rmSync(from, { force: true }); log(env, { id, event: 'dropped', why: 'not a private file of this user' }); continue; }
    try { renameSync(from, to); } catch { continue; } // another pass took it
    const req = readJson(to);
    if (!req || req.id !== id) { rmSync(to, { force: true }); log(env, { id, event: 'dropped', why: 'unreadable' }); continue; }
    busy.add(id);
    const go = async () => {
      // Stopping: a change that hasn't begun goes back on the queue for the next executor, never begun now.
      if (state.stopping) { try { renameSync(to, from); } catch { /* left for the next start's sweep */ } busy.delete(id); return; }
      log(env, { id, event: 'started', verb: req.verb, target: req.target, agent: req.agent, conversation: req.conversation });
      let res;
      try { res = await runOne(env, req, exec); } catch (e) { res = { id, state: 'failed', ...boundOutput(String(e?.message ?? e)), endedAt: new Date().toISOString() }; }
      try { writeJson(join(done, `${id}.json`), { ...res, agent: req.agent, conversation: req.conversation }); } catch (e) { process.stderr.write(`host-exec: ${id}'s result couldn't be kept: ${e.message}\n`); }
      finally { rmSync(to, { force: true }); busy.delete(id); }
      log(env, { id, event: 'ended', state: res.state, exit: res.exit ?? null });
    };
    const changes = VERBS[req.verb]?.changes !== false;
    // Changes one at a time across every pass (a deploy and a pieces update never overlap); reads alongside.
    if (changes) { state.chain = state.chain.then(go, go); jobs.push(state.chain); } else jobs.push(go());
  }
  await Promise.all(jobs);
  prune(env);
}

function prune(env) {
  const done = dirOf(env, 'done');
  const files = readdirSync(done).filter((n) => n.endsWith('.json')).map((n) => { const f = join(done, n); let m = 0; try { m = statSync(f).mtimeMs; } catch { /* gone */ } return { f, m }; }).sort((a, b) => b.m - a.m);
  const now = Date.now();
  files.forEach((x, i) => { if (i >= KEEP_RESULTS || now - x.m > KEEP_MS) rmSync(x.f, { force: true }); });
}

/** `loom-runtime host-exec [--once]`: the executor's loop (its own user unit on loom's machine). */
export async function hostExecLoop(env, { once = false, everyMs = 1000 } = {}) {
  ensureDirs(env);
  // One executor at a time, held by the kernel: the lock file's open description is flock'd (the shell's
  // `exec 9>lock; flock -n 9`), and it stays this process's until it exits, however it exits, so a crash or a
  // reboot never leaves a lock behind and two starts can't both get in.
  const fd = openSync(join(hostExecDir(env), 'executor.lock'), 'a', 0o600);
  const r = spawnSync(SYS.flock, ['-n', '-E', '75', '3'], { stdio: ['ignore', 'ignore', 'inherit', fd] });
  if (r.status === 75) throw new Error('another host executor is running');
  if (r.error || r.status !== 0) throw new Error(`the executor's lock couldn't be taken (${r.error?.message ?? `exit ${r.status}`})`);
  const state = { busy: new Set(), chain: Promise.resolve(), stopping: false };
  const passes = new Set();
  // A stop lets what's running finish (its unit's TimeoutStopSec bounds that) and begins nothing more.
  process.on('SIGTERM', () => { state.stopping = true; Promise.all([...passes, state.chain]).finally(() => process.exit(0)); });
  for (;;) {
    if (state.stopping) return;
    const p = execPass(env, { state }).catch((e) => process.stderr.write(`host-exec: ${e.message}\n`));
    passes.add(p);
    p.finally(() => passes.delete(p));
    if (once) { await p; await state.chain; return; }
    // A long change (a deploy) doesn't hold up reads: the next pass starts while it runs; `busy` keeps it from being
    // taken for lost, and claiming by rename keeps a request from running twice.
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
