// Runaway loops (t-1763): what replaced the hourly start cap (t-1760's backstop). Jonathan's ruling, 2026-11-03: every
// "stop after N" cap blocked productive work (a busy lane, two agents working something through, a burst of wakes).
// What's caught is a crash loop, by its outcomes, never by how many messages came or how fast:
//
//   failure streak   FAIL_RUNS runs in a row that each failed (it couldn't start, its harness failed its turn, its
//                    post was refused, or it ended with no reply and no tool work), however far apart
//   repeated output  REPEAT_RUNS runs in a row, none for a person, each soon after the last, that posted the same
//                    words (or had the same post refused for the same reason)
//   relay ping-pong  two agents relaying back and forth with near-identical words (shapeOf), more than PINGPONG_TRIPS
//                    round trips within PINGPONG_MS
//   start-stop churn more than CHURN_RUNS very short runs in a row, each started by what the last one left (a wake it
//                    set, a note: not a person's message, not another agent's) right after it ended, and replying
//                    nothing. A wake set for later (minutes or more) is no churn: it doesn't start right after.
//
// A run is one body start (or resume) for a conversation: delivery.mjs keeps the last RUNS_KEPT of them on the
// conversation (`runs`: when, for whom, what it sent, how its turn ended). A person's message is never a reason: runs
// for a person don't count toward repeats or churn, and a person's own words are never looked at.
import { createHash } from 'node:crypto';

export const FAIL_RUNS = 4;
export const REPEAT_RUNS = 4;
/** Repeats count only when each run starts this soon after the one before it ended: a crash loop is quick, and a lane
 * that reports the same quiet "nothing new" every few minutes is a quiet lane. */
export const REPEAT_GAP_MS = 2 * 60_000;
export const PINGPONG_TRIPS = 4;
export const PINGPONG_MS = 30 * 60_000;
export const CHURN_RUNS = 4;
/** A churn run is this short, and starts this soon after the one before it ended. */
export const CHURN_RUN_MS = 90_000;
export const CHURN_GAP_MS = 90_000;
/** A relay sent this soon after a run's end (as its body's tool returned) is still that run's. */
const RELAY_SLACK_MS = 5_000;
/** Runs kept on a conversation: enough for every pattern's window, and its one before. */
export const RUNS_KEPT = 12;

const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

/** A post's words, as a hash (never the words): the same text, whitespace aside. */
export const textHash = (t) => sha(String(t ?? '').trim().replace(/\s+/g, ' '));

/**
 * Near-identical words, as one hash: case, digits, ids (r-…, out-…, a-…) and punctuation aside, the first 400
 * letters. "Thanks! Got it (3)" and "thanks, got it (4)" are one shape; a new question is another.
 */
export function shapeOf(t) {
  const s = String(t ?? '').normalize('NFKC').toLowerCase()
    .replace(/\b(r|out|a|w|q|t|cv|run|note)-[0-9a-f-]{3,}\b/g, ' ')
    .replace(/[\p{N}]+/gu, ' ')
    .replace(/[^\p{L}]+/gu, ' ')
    .trim().slice(0, 400);
  return sha(s);
}

/** Who a run was for: a person (any person's message in its batch), an agent, the schedule, or something else. */
export function causeOf(msgs) {
  const real = msgs.filter((x) => x.note !== true);
  if (real.some((x) => x.from?.kind === 'person')) return { cause: 'person' };
  const agent = real.find((x) => x.from?.kind === 'agent');
  if (agent) return { cause: 'agent', by: agent.from.id };
  if (real.some((x) => x.kind === 'wake' || x.from?.kind === 'schedule')) return { cause: 'schedule' };
  return { cause: 'other' };
}

/**
 * How a finished run went: {failed: reason} or {failed: null}, and its output's signature (the same post, or the
 * same refusal), or null when it posted nothing. A run whose turn its harness can't describe (an older house's host)
 * is never called a failure for that.
 */
export function judge(r) {
  const ok = (r.posts ?? []).filter((p) => p.ok);
  const bad = (r.posts ?? []).filter((p) => !p.ok);
  let failed = null;
  if (r.fail) failed = r.fail;
  else if (r.turn?.failed) failed = `its harness failed the turn${r.turn.error ? `: ${r.turn.error}` : ''}`;
  else if (bad.length && !ok.length) failed = `its post was refused: ${bad.at(-1).reason ?? 'no reason given'}`;
  else if (!said(r) && r.turn && r.turn.worked === false) failed = 'it ended with no reply and no tool work';
  const sig = ok.length ? `post:${ok.at(-1).h}` : bad.length ? `refused:${bad.at(-1).reason ?? ''}` : null;
  return { failed, sig };
}

/** It said something: a post (or a record) through `send`, or a relay to another agent while it ran. */
const said = (r) => r.sent > 0 || r.relayed > 0;

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const quote = (s, n = 120) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * Whether this conversation's runs look like a loop: {pattern, reason} or null. `runs`: its finished runs, oldest
 * first (since the owner last resumed it). `relays`: the relay log's rows (relay.mjs), for a relay conversation
 * (`peer`: who relays to `agent` there).
 */
export function detectLoop({ runs = [], relays = [], agent, peer, now }) {
  // A relay this agent sent while a run was going (to the end of it, and a few seconds on) is what that run said.
  const mine = relays.filter((x) => x.from === agent);
  const done = runs.filter((r) => Number.isFinite(r.end)).map((r) => ({ ...r, relayed: mine.filter((x) => x.at >= r.at && x.at <= r.end + RELAY_SLACK_MS).length }));
  const tail = (n) => (done.length >= n ? done.slice(-n) : null);

  // A failure streak: however fast or slow.
  const f = tail(FAIL_RUNS);
  if (f) {
    const j = f.map(judge);
    if (j.every((x) => x.failed)) return { pattern: 'failures', reason: `${FAIL_RUNS} runs in a row failed with '${quote(j.at(-1).failed)}'` };
  }

  // The same output, run after run, none for a person, each soon after the last.
  const r = tail(REPEAT_RUNS);
  if (r && r.every((x) => x.cause !== 'person')) {
    const sigs = r.map((x) => judge(x).sig);
    const quick = r.every((x, i) => i === 0 || x.at - r[i - 1].end <= REPEAT_GAP_MS);
    if (sigs[0] && sigs.every((s) => s === sigs[0]) && quick) {
      const what = sigs[0].startsWith('refused:') ? `had the same post refused ('${quote(sigs[0].slice(8))}')` : 'posted the same words';
      return { pattern: 'repeats', reason: `${REPEAT_RUNS} runs in a row ${what}` };
    }
  }

  // Relay ping-pong: near-identical words back and forth.
  if (peer && agent) {
    const pp = pingPong(relays, agent, peer, now);
    if (pp > PINGPONG_TRIPS) return { pattern: 'ping-pong', reason: `${cap(agent)} and ${cap(peer)} relayed near-identical words back and forth ${plural(pp, 'time')} in ${Math.round(PINGPONG_MS / 60_000)} minutes` };
  }

  // Start-stop churn: very short runs, each right after the last, started by what the last one left (a wake it set, a
  // note: never a person's message, nor another agent's, which is that agent's to answer for), replying nothing.
  const c = tail(CHURN_RUNS + 2);
  if (c) {
    const runs2 = c.slice(1);
    const churn = runs2.every((x, i) => (x.cause === 'schedule' || x.cause === 'other') && !said(x) && !x.fail && x.end - x.at < CHURN_RUN_MS && x.at - c[i].end < CHURN_GAP_MS);
    if (churn) return { pattern: 'churn', reason: `${runs2.length} very short runs in a row, each started right after the last, by what the last left, with nothing said` };
  }
  return null;
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/**
 * Round trips of near-identical relays between `agent` and `peer`, the newest last: from the newest back, each relay
 * alternates direction and has the shape its own side's relay before it had. 0 when they're saying new things.
 */
export function pingPong(relays, agent, peer, now) {
  const rows = relays
    .filter((x) => ((x.from === agent && x.to === peer) || (x.from === peer && x.to === agent)) && now - x.at < PINGPONG_MS && typeof x.shape === 'string')
    .sort((a, b) => a.at - b.at);
  let n = rows.length ? 1 : 0;
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i].from === rows[i - 1].from) break;
    if (i >= 2 && rows[i].shape !== rows[i - 2].shape) break;
    n++;
  }
  // `n` relays alternate, each like its side's last: a round trip is two, the first two being the words repeated.
  return n >= 4 ? Math.floor(n / 2) : 0;
}
