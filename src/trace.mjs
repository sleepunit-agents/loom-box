// A reply's trace (loom docs/specs/comms.md, "Tracing a reply"; t-1895): what happened to one conversation's message,
// from in to shown, in one read. Two records hold it:
//
//   the runtime's (this machine)   the conversation: each run's body, how it came, its end, how its harness says the
//                                  turn went, what it sent and what was refused; each message's delivery outcome
//   core's (its adapter op trace)  for a Comms thread: each message's delivery, the reply's run, error cards; no words
//
// Who reads one: an agent its own agent's conversations (the `comms_trace` tool core runs as the session's agent, or
// `loom runtime trace` in its house through the piece API); an owner the conversations of agents they own (the
// runtime's `trace/<cv>` page, `loom runtime trace` at loom's machine). Never across agents, and never a message's
// words: a trace is mechanism.
import { coreFrom } from './core.mjs';
import { COMMS_VENUE, CV, listConvs, loadConv } from './delivery.mjs';
import { readBody } from './bodies.mjs';

const THREAD = /^th:[a-z2-7]{10}$/;
const RUN = /^(run|start)-[0-9a-f]{8,12}$/;
const NONE = 'no conversation of yours here by that name';

export class TraceError extends Error {}
const no = (m) => { throw new TraceError(m); };

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/** May `who` read conversation `c`: an agent, its own; an owner, an agent `agents` covers ('*' or a list). */
export function mayRead(who, c) {
  if (!c) return false;
  if (typeof who?.agent === 'string') return c.agent === who.agent;
  return who?.agents === '*' || (Array.isArray(who?.agents) && who.agents.includes(c.agent));
}

/** The conversation a trace names: a conversation id, a thread (a Comms place) or a run; only one `who` may read. */
export function findConv(env, who, { conversation, thread, run } = {}) {
  let c = null;
  if (conversation !== undefined) c = CV.test(conversation) ? loadConv(env, conversation) : no('conversation is a cv- id');
  else if (thread !== undefined) {
    if (!THREAD.test(thread)) no('thread is a Comms thread id, th:…');
    c = listConvs(env).find((x) => x.venue === COMMS_VENUE && x.place === thread && mayRead(who, x)) ?? null;
  } else if (run !== undefined) {
    if (!RUN.test(run)) no('run is a run id, run-…');
    c = listConvs(env).find((x) => mayRead(who, x) && (x.run === run || (x.runLog ?? []).some((r) => r.run === run))) ?? null;
  } else no('name a conversation (cv-…), a thread (th:…) or a run (run-…)');
  // One answer for another agent's and for none at all: a trace never says whose a conversation is.
  if (!c || !mayRead(who, c)) no(NONE);
  return c;
}

/** Where a body ran: its house (h-…) or loom's machine, and its harness. */
function whereOf(env, ref) {
  if (typeof ref !== 'string') return {};
  let rec = null;
  try { rec = readBody(env, ref); } catch { rec = null; }
  const [harness, id] = ref.split(':');
  const house = rec?.house ?? (/^(h-\d+)-/.exec(id ?? '')?.[1] ?? null);
  return { harness: rec?.harness ?? harness, ...(house ? { house } : { local: true }) };
}

/** One run as a trace shows it. */
function runOf(env, r) {
  return {
    run: r.run, cause: r.cause, ...(r.by ? { by: r.by } : {}), started: iso(r.at), ...(r.body ? { body: r.body, how: r.how, ...whereOf(env, r.body) } : {}),
    ended: iso(r.end), ...(r.turn ? { turn: r.turn } : {}), ...(r.fail ? { fail: r.fail } : {}),
    sent: r.sent ?? 0, ...(r.refused ? { refused: r.refused, refusal: r.refusal } : {}),
    posts: (r.posts ?? []).map((p) => ({ ok: !!p.ok, ...(p.reason ? { reason: p.reason } : {}) })),
  };
}

/**
 * The steps of one run, in words: delivered, started, ended, posted, accepted, shown. `thread` is core's half for a
 * Comms conversation (its trace op), or null when there's none or core couldn't say.
 */
export function stepsOf(c, run, thread, next = null) {
  const who = cap(c.agent);
  const steps = [];
  const outcomes = Object.values(c.outcomes ?? {}).filter((o) => o && Number.isFinite(o.at)).sort((a, b) => a.at - b.at);
  const near = run ? outcomes.filter((o) => Math.abs(o.at - Date.parse(run.started ?? '')) < 5 * 60_000) : outcomes;
  for (const o of (near.length ? near : outcomes).slice(-3)) steps.push({ step: 'delivered', at: iso(o.at), ok: o.body !== 'failed', words: o.body === 'failed' ? `Not delivered to ${who}: ${o.reason ?? 'no reason given'}.` : `Delivered to ${who} (${o.body}).` });
  if (c.queue?.length) steps.push({ step: 'delivered', ok: null, words: `${c.queue.length} message${c.queue.length === 1 ? '' : 's'} waiting for ${who}'s body.` });
  if (!run) { steps.push({ step: 'started', ok: false, words: `No run of ${who}'s is on the record here.` }); return steps; }
  // A start that failed is a run of its own (delivery.mjs: `start-…`, no body); a run stopped later keeps its run id.
  if (run.fail && run.run.startsWith('start-')) { steps.push({ step: 'started', at: run.started, ok: false, words: `${who}'s body couldn't start: ${run.fail}` }); return steps; }
  const where = run.house ? `in house ${run.house}` : run.local ? 'on loom\'s machine' : '';
  steps.push({ step: 'started', at: run.started, ok: true, words: `${who}'s body ${run.how ?? 'started'}${run.harness ? ` on ${run.harness}` : ''}${where ? ` ${where}` : ''} (${run.run}).` });
  if (!run.ended) steps.push({ step: 'ended', ok: null, words: 'Its turn is still going.' });
  else if (run.fail) steps.push({ step: 'ended', at: run.ended, ok: false, words: `Its turn was stopped: ${run.fail}` });
  else if (run.turn?.failed) steps.push({ step: 'ended', at: run.ended, ok: false, words: `Its turn failed${run.turn.error ? `: ${run.turn.error}` : ''}.` });
  else steps.push({ step: 'ended', at: run.ended, ok: true, words: `Its turn ended${run.turn?.worked === false ? ', with no tool work' : ''}.` });
  if (run.refused) steps.push({ step: 'posted', ok: false, words: `${run.refused} send${run.refused === 1 ? ' was' : 's were'} refused before posting: ${run.refusal}` });
  if (!run.sent && run.ended) steps.push({ step: 'posted', ok: false, words: run.refused ? 'Nothing it said was posted.' : `It never called \`loom runtime send\`: it said nothing to post.` });
  else if (run.sent) steps.push({ step: 'posted', ok: true, words: `It sent ${run.sent} message${run.sent === 1 ? '' : 's'}.` });
  for (const p of run.posts) steps.push({ step: 'accepted', ok: p.ok, words: p.ok ? 'The venue took a post.' : `The venue refused a post: ${p.reason ?? 'no reason given'}` });
  if (thread) {
    const shown = thread.messages.filter((m) => m.kind === 'reply' && m.run === run.run);
    // Its error cards: from just before it started until the next run started (a later run's are that run's).
    const from = Date.parse(run.started ?? '') - 60_000;
    const until = Number.isFinite(Date.parse(next?.started ?? '')) ? Date.parse(next.started) : Infinity;
    const errors = thread.messages.filter((m) => m.kind === 'error' && Date.parse(m.at) >= from && Date.parse(m.at) < until);
    if (shown.length) steps.push({ step: 'shown', at: shown.at(-1).at, ok: true, words: `The thread shows ${shown.length} repl${shown.length === 1 ? 'y' : 'ies'} from this run (seq ${shown.map((m) => m.seq).join(', ')}).` });
    else steps.push({ step: 'shown', ok: false, words: 'The thread shows no reply from this run.' });
    for (const e of errors) steps.push({ step: 'shown', at: e.at, ok: false, words: `The thread shows an error card: ${e.error?.words ?? e.error?.code}` });
    if (thread.working_since) steps.push({ step: 'shown', ok: null, words: `The thread shows ${who} working (since ${thread.working_since}).` });
  }
  return steps;
}

/**
 * The trace: {conversation, agent, venue, place, label, now, runs (newest last), run (the one asked, else the newest),
 * steps, thread (core's half, Comms only), note?}. `who`: {agent} or {agents}.
 */
export async function trace(env, who, q = {}, o = {}) {
  const c = findConv(env, who, q);
  const runs = (c.runLog ?? []).map((r) => runOf(env, r));
  const run = q.run !== undefined ? runs.find((r) => r.run === q.run) ?? null : runs.at(-1) ?? null;
  let thread = null;
  let note;
  if (c.venue === COMMS_VENUE) {
    try {
      const core = o.core ?? coreFrom(env, { fetchImpl: o.fetchImpl });
      const a = await core.comms({ op: 'trace', place: c.place, agent: c.agent });
      if (a?.ok && a.trace) thread = a.trace; else note = `core couldn't say what the thread shows: ${a?.reason ?? 'no answer'}`;
    } catch (e) { note = `core couldn't say what the thread shows: ${String(e.message).split('\n')[0].slice(0, 200)}`; }
  }
  return {
    conversation: c.conversation, agent: c.agent, venue: c.venue, place: c.place, ...(c.label ? { label: c.label } : {}),
    now: { body: c.body ?? null, ...(c.body ? whereOf(env, c.body) : {}), starting: !!c.starting, waiting: c.queue?.length ?? 0, ...(c.slot?.until ? { slotUntil: c.slot.until } : {}) },
    runs, run: run?.run ?? null, steps: stepsOf(c, run, thread, run ? runs[runs.indexOf(run) + 1] ?? null : null), ...(thread ? { thread } : {}), ...(note ? { note } : {}),
  };
}

/** A trace as lines, for the CLI and the tool's text. */
export function traceText(t) {
  const head = `${cap(t.agent)} · ${t.venue} ${t.label ?? t.place} · ${t.conversation}${t.run ? ` · ${t.run}` : ''}`;
  const mark = (ok) => (ok === true ? 'ok ' : ok === false ? 'NO ' : '.. ');
  const lines = t.steps.map((s) => `${mark(s.ok)}${s.at ? `${s.at.slice(5, 19).replace('T', ' ')} ` : ''}${s.step}: ${s.words}`);
  return [head, ...lines, ...(t.note ? [`(${t.note})`] : [])].join('\n');
}

/** The `comms_trace` tool core adds to an agent's MCP session (package.json mcp_tools.comms_trace mirrors it). */
export const TOOL = {
  description:
    'What happened to a reply of yours, from the message in to the reply shown: delivered to you, your body started ' +
    'and ended, what you sent and what was refused, whether the venue took it and whether the thread shows it. Name a ' +
    'Comms thread (th:…), a run (run-…) or a conversation (cv-…) of your own; never another agent\'s. No words, only ' +
    'what happened.',
  input_schema: {
    type: 'object',
    properties: {
      thread: { type: 'string', description: 'A Comms thread of yours, th:…' },
      run: { type: 'string', description: 'A run of yours, run-… (its steps; else the newest run\'s)' },
      conversation: { type: 'string', description: 'A conversation of yours, cv-…' },
    },
  },
};

/** `loom-runtime trace tool --agent <a> [--house h]`, the arguments on stdin: core runs it as the session's agent. */
export async function traceTool(env, argv, input, o = {}) {
  const i = argv.indexOf('--agent');
  const agent = i >= 0 ? argv[i + 1] : undefined;
  if (!agent) return { exit: 1, answer: { text: 'comms_trace: core names no agent', isError: true } };
  let args;
  try { args = JSON.parse(input || '{}'); } catch { return { exit: 1, answer: { text: 'comms_trace: the arguments aren\'t JSON', isError: true } }; }
  const q = {};
  for (const k of ['thread', 'run', 'conversation']) if (typeof args?.[k] === 'string' && args[k]) q[k] = args[k];
  try {
    const t = await trace(env, { agent }, q, o);
    return { exit: 0, answer: { text: `${traceText(t)}\n\n${JSON.stringify(t)}`.slice(0, 60_000) } };
  } catch (e) {
    if (e instanceof TraceError) return { exit: 1, answer: { text: e.message, isError: true } };
    return { exit: 1, answer: { text: `comms_trace: the runtime failed (${String(e?.message ?? e).slice(0, 200)})`, isError: true } };
  }
}
