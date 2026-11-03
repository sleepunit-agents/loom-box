// The review job (loom docs/specs/agent-runtime.md, section 7; conversations.md, "Review"): the household's daily
// pass, grading and then introspection. Core defines the contract and the runtime runs it, because it runs models.
//
// When: 04:00 in the household's time zone, read from core (`GET /api/loom/review/config`: {review, tz}), never
// from household.json. The `delivery` service's loop asks reviewTick on each of its ticks. Once that day's 04:00 has
// passed and the day hasn't had its run, it starts one, detached (`loom-runtime review run --scheduled`). A
// service that was down at 04:00 catches up when it comes back that day. A runtime seeing the clock for the first
// time arms itself for the next 04:00 and doesn't run at once. `review: "off"` runs nothing, and a command in its
// place runs instead of the whole job, with the run's review token on its stdin.
//
// Grading, household-wide and blind:
//   1. a review token for the run (`POST /api/loom/review/token`), held in memory only;
//   2. up to N entries (LOOM_RUNTIME_REVIEW_LIMIT, default 200), taken in batches (`audit/take`) while the token
//      has time left. Each is redacted by core and carries its producer's family, never its model;
//   3. for each entry, graders from the families allowed to grade it, among the models the runtime can run now. A
//      grader can run when its harness is logged in on loom's own box (the control plane's, a household owner's),
//      its account has room for that model's window, and an image is there to run its CLI in:
//        - not the producer's family: two families where the household has them, else one;
//        - a household of one family falls back to a different model of that family (same_family: true);
//        - a conversation with someone other than the owner: only the families that already processed it
//          (`only_families`), the producer's among them.
//      An entry with no family (someone else's words, a wake, a turn with no model) can't be scored, and is done.
//      So is an entry no allowed family has room to grade: a taken entry is never handed out again, so keeping its
//      text would only keep it.
//   4. each grader is bare (grader.mjs): one CLI run with the redacted sample and the venue kind's question;
//   5. its score goes to `scores`, and at most one finding per entry to `findings` (core keeps one per conversation
//      per day, and refuses later ones);
//   6. the processed entries are marked done (`audit/done`). An entry whose graders all failed is left as it is,
//      and the 7-day sweep removes it.
// When no allowed family has room for anything, nothing is taken, and the run's record says why nothing was graded.
//
// Introspection, per agent, after grading: each agent the runtime hosts gets a wake, delivered through the runtime's
// own delivery (venue `wake`, place `review`), so its body starts the normal way: in its own house, as itself, with
// its own token and memory tools. The brief asks it to read its own conversations, digests and findings
// (`conversations`, `conversation`, `conversation_findings`) and write what it learns through its own tools. Nothing
// of what it reads or writes passes through the runtime. The run's record keeps only that the wake was delivered.
//
// The run's record (<data>/review/runs.jsonl) holds counts, grader families, and short reasons. It never holds a
// sample, a grader's words, a finding's text or a token. The same goes for its log.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAccounts, hasRoom } from './accounts.mjs';
import { CoreError, coreFrom, reviewFrom } from './core.mjs';
import { deliver } from './delivery.mjs';
import { GraderError, grade as gradeOnce } from './grader.mjs';
import { credentialState, loginImage } from './logins.mjs';
import { fetchScorecards, providerOf, readModels, sinceDay, VENUE_KIND, VENUE_KINDS } from './models.mjs';
import { boxOwner, householdOwners, membersOf } from './owners.mjs';
import { pieceName, setting } from './piece.mjs';
import { AGENT_NAME, StateError, alive, load } from './state.mjs';

/** The review's hour, in the household's time zone (conversations.md, "Review"). */
export const REVIEW_HOUR = 4;
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 2000;
/** One take at a time, so a run never claims much more than it has time to grade. */
export const BATCH = 25;
/** A review token lasts 2 hours: no new take after this much of it, and no grading after GRADE_FOR_MS. */
export const TAKE_FOR_MS = 90 * 60_000;
export const GRADE_FOR_MS = 110 * 60_000;
/** How often the tick asks core for the review's settings. */
export const CONFIG_EVERY_MS = 10 * 60_000;
/** A grader model that fails this many times in a run isn't asked again in it. */
const MAX_FAILS = 3;
const RUNS_KEPT = 90;

const dataDir = (env) => env.LOOM_BOX_DATA || join(env.HOME || homedir(), '.local', 'share', 'loom-box');
export const reviewDir = (env) => join(dataDir(env), 'review');
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
function writeJson(p, v) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 1) + '\n', { mode: 0o600 });
  renameSync(tmp, p);
}

// ─── When ───────────────────────────────────────────────────────────────────

/** The local day (YYYY-MM-DD) and hour at `now` in `tz`. */
export function localTime(now, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Which day's review is due at `now`, given the last day that had one: that day, or null. */
export function dueDay(now, tz, last) {
  const { day, hour } = localTime(now, tz);
  if (hour < REVIEW_HOUR) return null;
  return last && last >= day ? null : day;
}

const tickFile = (env) => join(reviewDir(env), 'schedule.json');
const cached = { at: 0, config: null };

/**
 * The delivery service's tick: start the day's review once it's due. Cheap when it isn't: core is asked for the
 * settings at most every 10 minutes. Answers what it did ({started: day} | {armed: day} | {off: true} | null).
 */
export async function reviewTick(env, { now = new Date(), core, spawnRun = (day) => spawnReview(env, day), nowMs = Date.now() } = {}) {
  if (!cached.config || nowMs - cached.at >= CONFIG_EVERY_MS) {
    try { cached.config = await (core ?? coreFrom(env)).reviewConfig(); cached.at = nowMs; } catch { return null; }
  }
  const { review, tz } = cached.config;
  if (review === 'off') return { off: true };
  const st = readJson(tickFile(env));
  const { day, hour } = localTime(now, tz);
  // First sight: the next 04:00 is the first run (an install, or an upgrade, never runs the job on the spot).
  if (!st) { writeJson(tickFile(env), { day: hour >= REVIEW_HOUR ? day : null, armed: now.toISOString() }); return { armed: day }; }
  const due = dueDay(now, tz, st.day);
  if (!due) return null;
  writeJson(tickFile(env), { day: due, started: now.toISOString() });
  spawnRun(due);
  return { started: due };
}

/** Forget the cached settings (tests). */
export const resetTick = () => { cached.at = 0; cached.config = null; };

/** `loom-runtime review run --scheduled`, detached: a review outlives the tick that started it. */
function spawnReview(env, day) {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
  mkdirSync(reviewDir(env), { recursive: true, mode: 0o700 });
  const log = openSync(join(reviewDir(env), 'run.log'), 'a', 0o600);
  const child = nodeSpawn(process.execPath, [cli, 'review', 'run', '--scheduled', '--day', day], { env, detached: true, stdio: ['ignore', log, log] });
  child.unref();
}

// ─── Who can grade ──────────────────────────────────────────────────────────

/**
 * The graders the runtime can run now: each model in its list whose harness is logged in on loom's own box (a
 * household owner's), whose account there has room for the model's window, and whose CLI has an image to run in.
 * Answers {pool: [{model, harness, family, window?, image}], why: [lines]}.
 */
export function graderPool(env, { s = load(env), members = membersOf(env), models = readModels(env).list, nowMs = Date.now(), image = (agents) => loginImage(env, agents), cred = (h) => credentialState(env, h) } = {}) {
  const why = [];
  const local = Object.entries(s.boxes ?? {}).find(([, b]) => b.local && !b.revoked);
  if (!local) return { pool: [], why: ['loom\'s own box isn\'t in the runtime\'s state'] };
  const [id, box] = local;
  // Grading is household-wide: only a household owner's login grades.
  if (!householdOwners(members).includes(boxOwner(box, members))) return { pool: [], why: [`${id}'s owner isn't a household owner, so its logins don't grade`] };
  const accounts = deriveAccounts(s, { members, nowMs }).accounts.filter((a) => a.kind === 'login' && a.boxes.includes(id));
  const pool = [];
  for (const m of models) {
    if (!providerOf(m.family)) { why.push(`${m.id}: a local model has no CLI login to grade with`); continue; }
    const acct = accounts.find((a) => a.harness === m.harness && a.provider === providerOf(m.family));
    if (!acct) { why.push(`${m.id}: ${id} isn't logged in to ${m.harness}`); continue; }
    if (!hasRoom(acct, m.window)) { why.push(`${m.id}: ${acct.label} has no room`); continue; }
    const bad = cred(m.harness);
    if (bad) { why.push(`${m.id}: ${id}'s ${m.harness} login can't be used (${bad})`); continue; }
    const img = image(acct.agents);
    if (!img?.image) { why.push(`${m.id}: ${img?.why ?? 'no image to run its CLI in'}`); continue; }
    pool.push({ model: m.id, harness: m.harness, family: m.family, ...(m.window ? { window: m.window } : {}), image: img.image });
  }
  return { pool, why };
}

/** The models of each family that produced turns, from the scorecards, with their sample counts: {family: {model: n}}. */
export function producersOf(rows) {
  const out = {};
  for (const r of rows ?? []) {
    if (typeof r?.model !== 'string' || typeof r.family !== 'string' || r.model === 'unknown') continue;
    out[r.family] ??= {};
    out[r.family][r.model] = (out[r.family][r.model] ?? 0) + (Number.isFinite(r.n) ? r.n : 0);
  }
  return out;
}

/**
 * The graders for one entry: [{...grader, sameFamily}] (at most two, one per family), or {skip: why}.
 *   families   the household's families (the runtime's model list, less any core refused)
 *   producers  producersOf(scorecards): a same-family grader is a model of that family that produced the least
 */
export function pickGraders(entry, pool, { families, producers = {}, fallback = true }) {
  if (typeof entry?.family !== 'string' || !entry.family) return { skip: 'unscorable' };
  const producer = entry.family;
  let allowed;
  if (Array.isArray(entry.only_families)) {
    // Someone other than the owner: a person's words go only where they already went.
    allowed = entry.only_families.filter((f) => typeof f === 'string');
  } else {
    const others = [...new Set(families)].filter((f) => f !== producer);
    // Only a household of one family grades its own family.
    allowed = others.length ? others : fallback ? [producer] : [];
  }
  const out = [];
  for (const f of allowed) {
    if (out.length >= 2) break;
    const mine = pool.filter((g) => g.family === f);
    if (!mine.length) continue;
    // Never the model that produced it, as far as the runtime can tell (the entry names only its family): the
    // family's models that produced the least come first.
    const n = (g) => producers[f]?.[g.model] ?? 0;
    const g = f === producer ? [...mine].sort((a, b) => n(a) - n(b))[0] : mine[0];
    out.push({ ...g, sameFamily: f === producer || Array.isArray(entry.only_families) });
  }
  return out.length ? out : { skip: 'no-room' };
}

// ─── The run ────────────────────────────────────────────────────────────────

const lockFile = (env) => join(reviewDir(env), 'run.lock');

function takeLock(env) {
  mkdirSync(reviewDir(env), { recursive: true, mode: 0o700 });
  const held = readJson(lockFile(env));
  if (held && alive(held.pid) && held.pid !== process.pid) throw new StateError(`a review is already running (pid ${held.pid})`, 409);
  writeJson(lockFile(env), { pid: process.pid, at: new Date().toISOString() });
  return () => { if (readJson(lockFile(env))?.pid === process.pid) rmSync(lockFile(env), { force: true }); };
}

/** The runs on record, newest last. */
export function reviewRuns(env) {
  try { return readFileSync(join(reviewDir(env), 'runs.jsonl'), 'utf-8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; }
}

function record(env, rec) {
  mkdirSync(reviewDir(env), { recursive: true, mode: 0o700 });
  const runs = [...reviewRuns(env), rec].slice(-RUNS_KEPT);
  const p = join(reviewDir(env), 'runs.jsonl');
  writeFileSync(`${p}.tmp`, runs.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}

/** The run's limit: LOOM_RUNTIME_REVIEW_LIMIT, or the caller's. */
export function limitOf(env, given) {
  const v = given ?? setting(env, 'REVIEW_LIMIT');
  if (v === undefined || v === '') return DEFAULT_LIMIT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new StateError(`the review's limit is 1-${MAX_LIMIT} entries`);
  return n;
}

/** Which agents introspect: LOOM_RUNTIME_REVIEW_INTROSPECT (all, none, or a list), or the caller's. */
export function introspectOf(env, given, s) {
  const v = String(given ?? setting(env, 'REVIEW_INTROSPECT') ?? 'all').trim();
  // Every agent the runtime hosts (one it has a house for): its body starts in its own house.
  const hosted = Object.entries(s?.agents ?? {}).filter(([a, c]) => AGENT_NAME.test(a) && c?.repo).map(([a]) => a).sort();
  if (v === 'none') return [];
  if (v === 'all' || v === '') return hosted;
  const named = v.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = named.find((a) => !hosted.includes(a));
  if (bad) throw new StateError(`${bad} isn't an agent the runtime hosts`);
  return named;
}

const short = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 160);

/**
 * One review run. Everything it reaches is passed in, so a test hands in fakes:
 *   core       the runtime's core client (reviewConfig, reviewToken)
 *   reviewer   (token) → the run's calls (take, score, finding, done)
 *   pool       () → graderPool(env)
 *   grade      (grader, {venueKind, entry}) → {score, finding?}
 *   scorecards () → rows
 *   deliver    (msg) → a delivery's answer
 *   runCommand (argv, token) → {exit}: a review command that replaces the job
 * Answers the run's record (counts and families only).
 */
export async function runReview(env, o = {}) {
  const now = o.now ?? (() => new Date());
  const core = o.core ?? coreFrom(env);
  const log = o.log ?? ((m) => process.stderr.write(`loom-runtime review: ${m}\n`));
  const release = takeLock(env);
  const started = now();
  const rec = {
    at: started.toISOString(), trigger: o.trigger ?? 'by-hand', limit: limitOf(env, o.limit),
    taken: 0, graded: 0, scores: 0, findings: 0, findings_refused: 0, unscorable: 0, ungraded: 0, failed: 0, done: 0,
    graders: {}, same_family: 0, why: [],
  };
  try {
    const config = await core.reviewConfig();
    rec.tz = config.tz;
    rec.day = o.day ?? localTime(started, config.tz).day;
    if (config.review === 'off') { rec.off = true; rec.why.push('review is off (household.json)'); return finish(); }
    if (Array.isArray(config.review)) {
      const { token } = await core.reviewToken();
      const r = await (o.runCommand ?? runCommand)(config.review, token);
      rec.replaced = true; rec.exit = r.exit;
      return finish();
    }
    // A grading phase that fails (core down mid-run) still leaves each agent its introspection.
    try { await grading(); } catch (e) { rec.error = `grading: ${short(e)}`; }
    await introspection();
    return finish();
  } catch (e) {
    rec.error = short(e);
    return finish();
  } finally { release(); }

  function finish() {
    rec.ended = now().toISOString();
    if (!rec.why.length) delete rec.why;
    record(env, rec);
    return rec;
  }

  async function grading() {
    const poolOf = o.pool ?? (() => graderPool(env));
    let { pool, why } = poolOf();
    if (!pool.length) {
      rec.nothing_graded = `no allowed family has room: ${why.join('; ') || 'the runtime can run no model'}`;
      log(rec.nothing_graded);
      return;
    }
    const models = o.models ?? readModels(env).list;
    const refused = new Set();
    // Core knows a family the runtime doesn't (a turn ran a model off its list): its own family may not grade then.
    let fallback = true;
    const families = () => [...new Set(models.map((m) => m.family))].filter((f) => !refused.has(f));
    let producers = {};
    try { producers = producersOf(await (o.scorecards ?? (async () => (await fetchScorecards(env, { since: sinceDay(now()) })).rows))()); } catch { producers = {}; }
    const { token } = await core.reviewToken();
    const rv = (o.reviewer ?? ((t) => reviewFrom(env, t)))(token);
    const grade = o.grade ?? ((g, x) => gradeOnce(env, g, x));
    // A venue's kind: core's registry (an adapter's venues), else the ones the runtime knows by name.
    let registry = {};
    try { registry = (await core.venues?.()) ?? {}; } catch { registry = {}; }
    const fails = new Map();
    const takeUntil = Date.now() + (o.takeForMs ?? TAKE_FOR_MS);
    const gradeUntil = Date.now() + (o.gradeForMs ?? GRADE_FOR_MS);
    while (rec.taken < rec.limit && Date.now() < takeUntil) {
      const entries = await rv.take(Math.min(BATCH, rec.limit - rec.taken));
      if (!entries.length) break;
      rec.taken += entries.length;
      const done = [];
      for (const entry of entries) {
        if (typeof entry?.ref !== 'string') continue;
        const outcome = await gradeEntry(entry);
        if (outcome !== 'failed') done.push(entry.ref);
        rec[outcome] += 1;
      }
      if (done.length) {
        try { await rv.done(done); rec.done += done.length; } catch (e) { rec.why.push(`done: ${short(e)}`); }
      }
      // Room moves as graders run: the next batch's pool is asked again.
      if (!o.pool) ({ pool, why } = poolOf());
      if (!pool.length) { rec.why.push(`stopped: no allowed family has room (${why.join('; ')})`); break; }
      // Every grader failing: claim nothing more (what's taken can't be handed out again).
      if (!pool.some((g) => (fails.get(g.model) ?? 0) < MAX_FAILS)) { rec.why.push('stopped: every grader kept failing'); break; }
    }

    async function gradeEntry(entry) {
      const told = registry[entry.venue]?.kind;
      const venueKind = VENUE_KINDS.includes(told) ? told : VENUE_KIND[entry.venue] ?? null;
      // The token's time running out: left for the sweep, never scored on a token core would refuse.
      if (Date.now() >= gradeUntil) { note('stopped grading: the review token\'s time is nearly up'); return 'failed'; }
      for (let attempt = 0; attempt < 3; attempt++) {
        const picked = pickGraders(entry, pool.filter((g) => (fails.get(g.model) ?? 0) < MAX_FAILS), { families: families(), producers, fallback });
        if (picked.skip) return picked.skip === 'unscorable' ? 'unscorable' : 'ungraded';
        if (!venueKind) { rec.why.push(`venue ${entry.venue}'s kind isn't known: not graded`); return 'ungraded'; }
        let scored = 0;
        let finding;
        let refusedNow = false;
        for (const g of picked) {
          let v;
          try { v = await grade(g, { venueKind, entry }); } catch (e) {
            fails.set(g.model, (fails.get(g.model) ?? 0) + 1);
            note(`${g.family} grader: ${e instanceof GraderError ? e.message : 'failed'}`);
            continue;
          }
          try {
            await rv.score(entry.ref, g.family, v.score);
            scored += 1; rec.scores += 1;
            rec.graders[g.family] = (rec.graders[g.family] ?? 0) + 1;
            if (g.sameFamily) rec.same_family += 1;
            finding ??= v.finding;
          } catch (e) {
            // Core grades only with the families its turns name: one it refuses isn't asked again in this run. And
            // when it says the household has another family, the producer's own doesn't grade (no fallback).
            if (e instanceof CoreError && e.status === 403 && !Array.isArray(entry.only_families)) {
              if (/no household agent runs/.test(e.message)) { refused.add(g.family); refusedNow = true; } else if (g.family === entry.family) { fallback = false; refusedNow = true; }
            }
            note(`score: ${short(e)}`);
          }
        }
        if (scored) {
          if (finding) {
            try { await rv.finding(entry.ref, finding); rec.findings += 1; } catch (e) {
              // Core keeps one per conversation per day: a later one is refused, and that's the cap working.
              if (e instanceof CoreError && e.status === 409) rec.findings_refused += 1; else note(`finding: ${short(e)}`);
            }
          }
          return 'graded';
        }
        if (!refusedNow) return 'failed';
      }
      return 'failed';
    }
  }

  function note(m) { if (rec.why.length < 12 && !rec.why.includes(m)) rec.why.push(m); }

  async function introspection() {
    const s = o.state ?? load(env);
    const agents = introspectOf(env, o.introspect, s);
    if (!agents.length) return;
    const prev = [...reviewRuns(env)].reverse().find((r) => r.introspection?.length && r.at < rec.at);
    const since = prev?.at ?? new Date(started.getTime() - 86_400_000).toISOString();
    const send = o.deliver ?? ((m) => deliver(env, m, { detach: true }));
    rec.introspection = [];
    for (const agent of agents) {
      const msg = introspectionMessage(env, { agent, day: rec.day, since, at: now().toISOString() });
      try {
        const r = await send(msg);
        // What the runtime keeps of it: that it reached the agent's body, never what the body does.
        rec.introspection.push({ agent, body: r?.body ?? 'refused', ...(r?.status ? { error: short(r.error) } : {}) });
      } catch (e) { rec.introspection.push({ agent, body: 'refused', error: short(e) }); }
    }
  }
}

/** A review command in the job's place: its argv, the run's review token on its stdin, two hours at most. */
function runCommand(argv, token) {
  return new Promise((resolve) => {
    const child = nodeSpawn(argv[0], argv.slice(1), { stdio: ['pipe', 'inherit', 'inherit'] });
    const t = setTimeout(() => child.kill('SIGTERM'), 2 * 3600_000);
    child.on('error', () => { clearTimeout(t); resolve({ exit: 127 }); });
    child.on('exit', (code) => { clearTimeout(t); resolve({ exit: code ?? 1 }); });
    child.stdin.on('error', () => {});
    child.stdin.end(`${token}\n`);
  });
}

/** The introspection brief: the agent's own review of its own day, through its own tools. */
export function introspectionBrief({ day, since }) {
  return [
    `Daily review: your introspection for ${day}.`,
    '',
    'This is your own review of your own work. It runs as you, and nothing of it goes to another agent.',
    '',
    `1. Your conversations since ${since}: conversations({since: "${since}"}). Open the ones worth a look with`,
    '   conversation({id}): their digests, and the findings on your turns.',
    `2. The graders' findings on your turns: conversation_findings({since: "${since}"}). Each is one line from a bare`,
    '   model that graded a redacted sample of one of your turns, blind, with a score of 1-5. A finding is evidence,',
    '   not a ruling: weigh it against what you know of that conversation.',
    '3. Write down what you learn, through your own tools: a feedback memory for a lesson that should change how you',
    '   work, a proposed task for something to fix, or a fix to your own brief. Write nothing when there\'s nothing to',
    '   learn.',
    '',
    'Keep what a decent coworker would keep: no transcripts, and no bulk quoting of anyone.',
    'When you\'re done, reply with one line on what you took away, or "nothing new".',
  ].join('\n');
}

/** The delivery that starts an agent's introspection: a wake, from the schedule, on core's `wake` venue. */
export function introspectionMessage(env, { agent, day, since, at }) {
  if (!AGENT_NAME.test(agent ?? '')) throw new StateError('which agent');
  return {
    // Once per agent per day: delivering the same day's again answers the first and writes nothing.
    source: pieceName(env), id: `review-${day}-${agent}`, agent, venue: 'wake', place: 'review', label: 'Daily review',
    from: { kind: 'schedule' }, kind: 'wake', at, text: introspectionBrief({ day, since }),
  };
}

/** For the CLI: the last runs, as kept. */
export function reviewStatus(env) {
  return { schedule: readJson(tickFile(env)), runs: reviewRuns(env).slice(-7) };
}

