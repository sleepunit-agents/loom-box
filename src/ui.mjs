import { checkLoginExpiry, loginExpiryAsks, loginExpiry } from './login-expiry.mjs';
// The Boxes tab on loom's page (loom docs/extensions.md, "The page"): the
// boxes, what each has and may host, the houses asked for, and the owner's
// controls. Data only; loom renders it. Every action is the owner's (the page
// is), and a box's credential is shown once, in the message after adding it.
import { writeOffApproved } from './dark-box.mjs';
import { principalOf } from './principal.mjs';
import { approvalsFake, approvalsRun, approvalsWhy } from './approvals-call.mjs';
import { appendFileSync, existsSync, readFileSync, statfsSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { BOX_NAME, StateError, load, localBoxName, stateDir } from './state.mjs';
import { sessionsBusy } from './busy.mjs';
import { allowJoin, blockAllJoins, blockJoin, pendingJoins } from './enroll.mjs';
import { preferenceOf, addBox, assertBoxOwner, resolveBox, isBoxOwner, boxLabelOf, boxOfCall, boxUpdateNow, loginOver, factsOf, lendBox, list, loginCancel, loginCode, loginStart, loginView, primaryOf, remoteDown, remoteUp, revokeBox, shownTask, serviceDown, serviceMove, serviceRestart, serviceUp, setAgent, isHostHouse, setBoxOwner, setMayHost, setBoxWatch, setPrimary, up, down, LIVE } from './control.mjs';
import { LOGIN_HARNESSES } from './logins.mjs';
import { ownCommit, swapCommand } from './version.mjs';
import { stateAccounts } from './accounts.mjs';
import { modelsOf, rolesOf, setRole } from './models.mjs';
import { COMMS_VENUE, HARNESS_WORDS, conversationJobs, ownerModelChoice, answerLoop, deliveryNotices, listConvs, loadConv, loopAsks, readFallbacks, resetCardProblem, resetPrincipal, runtimeAs, whenWords, workingConversations, nonIdleAgents } from './delivery.mjs';
import { loomStore } from './store.mjs';
import { asks as gateAsks, answer as gateAnswer, gatesPage, mergePeople, status as gatesStatus, proposals as gateProposals, PROPOSALS as PROPOSALS_COLLECTION } from './gates.mjs';
import { GRANTS, KEY as GRANTS_KEY, GrantsError, addGrant, grantPathsOk, grantsProblem, householdOf, setPiece, setRelay, usableBy } from './grants.mjs';
import { spawnSync } from 'node:child_process';
import { relayNotices } from './relay.mjs';
import { adapterStatuses, nowAgentPage, nowManifest, nowPage } from './nowboard.mjs';
import { boxPagePath, checkDark, watchAsks, watchNotices, watchOf, watchRows } from './watch.mjs';
import { coreFrom } from './core.mjs';

/** Where an agent runs, for its row (t-2048): the boxes its houses are up on, and its order when it has one. */
function whereRuns(s, a, live, env, nowMs) {
  const on = [...new Set(live.filter((h) => h.agent === a && h.state === 'running').map((h) => h.box))];
  const pref = preferenceOf(s, a, env);
  const order = pref.length > 1 ? ` · prefers ${pref.map((id) => boxLabelOf(s, id)).join(', then ')}` : '';
  if (on.length) return `Running on ${on.map((id) => boxLabelOf(s, id)).join(', ')}${order}`;
  return `Next on ${boxLabelOf(s, primaryOf(s, a, env, nowMs))}${order}`;
}

/**
 * The runtime's own store (the grants, the gates), when it runs as loom's piece: loom names it (LOOM_PIECE_NAME).
 * Outside loom (a dev checkout, the tests) there's none unless a test hands one in, so the page never reads a real
 * household's store by accident.
 */
export function permsStore(env) {
  // A test hands in a store object; a real environment's string never is one.
  if (env?.LOOM_RUNTIME_TEST_STORE && typeof env.LOOM_RUNTIME_TEST_STORE === 'object') return env.LOOM_RUNTIME_TEST_STORE;
  return env?.LOOM_PIECE_NAME ? loomStore(env) : null;
}
/**
 * Spend a `grant` approval for exactly this target, as the body of the agent that asked (`--as`): '' when spent, else
 * why not. The approvals piece checks it's allowed, for this kind and target, not overruled, and spends it once.
 */
function spendGrant(env, aid, target, agent) {
  return spendApproval(env, aid, 'grant', target, agent);
}

/**
 * A grant approval's target, <piece>:<agent>[:<path>,<path>], as {piece, agent, paths}; else null (approvals' grant_of).
 * A second reading of approvals' grammar, in another program: kept loose here on purpose. What decides is the spend
 * (approvals matches the target exactly as filed) and grantPathsOk; a target this reads differently is refused, never
 * widened.
 */
export function grantTarget(t) {
  const m = /^([a-z][a-z0-9-]{0,39}):([a-z][a-z0-9-]{0,39})(?::([^:\s]{1,600}))?$/.exec(typeof t === 'string' ? t : '');
  if (!m) return null;
  return { piece: m[1], agent: m[2], paths: m[3] ? m[3].split(',') : ['*'] };
}

/**
 * The owner's Allow on a `grant` approval, applied (t-1970): loom core posts this as the household owner right after the
 * Allow, with the approval's id, its agent (who asked) and its target. Only the household owner's call does anything;
 * the approval is spent first (allowed, for exactly that target), and only then is the grant written: the agent added
 * to the piece's grant, everyone else's kept. Never a grant without an allowed approval behind it.
 */
function grantApproved(env, st, c, fields) {
  if (!(c && c.kind === 'owner' && (c.agents === undefined || c.agents === '*'))) return { ok: false, message: 'Access to a piece is the household owner\'s to give.', page: 'permissions' };
  const id = String(fields.id ?? '');
  const asker = String(fields.agent ?? '');
  const target = String(fields.target ?? '');
  const g = grantTarget(target);
  if (!/^a-[0-9a-f]{8}$/.test(id) || !AGENT_ID.test(asker) || !g || !grantPathsOk(g.paths)) return { ok: false, message: 'That isn\'t a grant approval.', page: 'permissions' };
  const agents = householdOf(env)?.agents ?? [];
  if (!agents.includes(g.agent)) return { ok: false, message: `No agent ${g.agent} in this household: nothing was granted.`, page: 'permissions' };
  const what = `${who(g.agent)} may use ${cap(g.piece)}${g.paths.includes('*') ? '' : ` for ${g.paths.join(', ')}`}`;
  // Checked before it's spent, so a grant the runtime would refuse doesn't use up the owner's yes.
  let cur;
  try { cur = st.get(GRANTS, GRANTS_KEY); } catch (e) { return { ok: false, message: `The runtime couldn't read its grants (${String(e.message || e).slice(0, 160)}): nothing was granted.`, page: 'permissions' }; }
  // No grants yet: the runtime already allows every call, and it's the piece's own agent list that decides. Writing a
  // document now would take every other piece from every agent, so nothing is written, nothing spent, and it says so.
  if (!cur?.doc) return { ok: false, message: `Nothing changed: the runtime has no grants yet, so ${cap(g.piece)} decides by its own agent list. Add ${who(g.agent)} in ${cap(g.piece)}'s own settings, or seed the grants (loom runtime grants seed) and give it on Permissions.`, page: 'permissions' };
  if (grantsProblem(cur.doc)) return { ok: false, message: 'The runtime\'s grants can\'t be read: fix them on Permissions first. Nothing was granted.', page: 'permissions' };
  // The whole write checked too (its paths, the document after it), so only a store that fails now can stop it after the spend.
  try { addGrant(st, g, { dryRun: true }); } catch (e) {
    if (e instanceof GrantsError) return { ok: false, message: `Nothing was granted: ${e.message}.`, page: 'permissions' };
    return { ok: false, message: `The runtime couldn't read its grants (${String(e.message || e).slice(0, 160)}): nothing was granted.`, page: 'permissions' };
  }
  const spent = spendGrant(env, id, target, asker);
  if (spent) return { ok: false, message: `Not granted: the approval couldn't be spent (${spent.slice(0, 200)}).`, page: 'permissions' };
  try {
    const r = addGrant(st, g);
    if (r.none) return { ok: false, message: 'the runtime\'s grants were gone when it came to write, so nothing was granted.', page: 'permissions' };
    return { ok: true, message: r.changed ? `${what} now.` : `${what} already.`, page: `permissions/${g.agent}` };
  } catch (e) {
    return { ok: false, message: `the runtime couldn't write the grant (${String(e.message || e).slice(0, 160)}).`, page: 'permissions' };
  }
}

/**
 * Spend an approval the owner's Allow applies, as the runtime, for the agent that asked: '' when spent, else why not.
 * The approvals piece checks it's allowed, for exactly this kind and target, not overruled, and spends it once. A grant
 * leaves whom unsaid (t-1970: approvals' unstated spend); a reset says the owner (t-1975, `onBehalf`).
 */
function spendApproval(env, aid, kind, target, agent, { onBehalf } = {}) {
  // `loom approvals`: the piece by the name it installs as (also the relay's spend, relay.mjs), as bodies type it.
  const fx = approvalsFake(env);
  if (fx) return fx.spend(aid, target, agent, kind);
  // A reset is spent as the runtime filed it (runtimeAs); a grant as the agent, as t-1970 pinned.
  const as = kind === 'principal-reset' || kind === 'box-write-off' ? runtimeAs(agent) : JSON.stringify({ kind: 'agent', agent });
  const r = approvalsRun(env, ['use', aid, '--kind', kind, '--target', target, '--as', as, ...(onBehalf ? ['--on-behalf', onBehalf] : [])]);
  // Spent is exactly what approvals says when it spent one (`<id>: used`), never just an exit 0 from something else.
  if (!r.error && r.status === 0 && (r.stdout || '').trim() === `${aid}: used`) return '';
  return approvalsWhy(r);
}

/**
 * The owner's Allow on a `principal-reset` approval, applied (t-1975): loom core posts this as the household owner right
 * after the Allow, with the approval's id, its agent and target (`<agent>:<cv>`, read back from the approvals piece).
 * Only the household owner's call does anything; the conversation must be that agent's, here; the approval is spent
 * (allowed, for exactly that conversation, once) and only then is it reset, signed as the owner's, as `loom runtime
 * principal --reset` does at a terminal.
 */
function resetApproved(env, c, fields) {
  // Never from a body (t-1975): loom core posts this from its own process; a house's or a local body's environment, as
  // the runtime set it, is refused here, as the typed `principal --reset` refuses it (cli.mjs).
  if (env.HOUSE_ID || env.LOOM_BODY_KEY || env.LOOM_BODY_CONVERSATION) return { ok: false, message: 'Whose work a conversation is, is the household owner\'s to say, never a body\'s.', page: '' };
  if (!(c && c.kind === 'owner' && (c.agents === undefined || c.agents === '*'))) return { ok: false, message: 'Whose work a conversation is, is the household owner\'s to say.', page: '' };
  const id = String(fields.id ?? '');
  const asker = String(fields.agent ?? '');
  const target = typeof fields.target === 'string' ? fields.target : '';
  const m = /^([a-z][a-z0-9-]{0,39}):(cv-[0-9a-f]{12})$/.exec(target);
  if (!/^a-[0-9a-f]{8}$/.test(id) || !m || asker !== m[1]) return { ok: false, message: 'That isn\'t a conversation to count as yours.', page: '' };
  const conv = loadConv(env, m[2]);
  // Checked under the delivery lock before the owner's yes is spent (and again by resetPrincipal after it).
  const why = resetCardProblem(env, m[2], { agent: m[1], approval: id });
  if (why) return { ok: false, message: `Nothing changed: ${why}.`, page: '' };
  const spent = spendApproval(env, id, 'principal-reset', target, asker, { onBehalf: 'owner' });
  if (spent) return { ok: false, message: `Nothing changed: the approval couldn't be spent (${spent.slice(0, 200)}).`, page: '' };
  const r = resetPrincipal(env, m[2], { agent: m[1], approval: id });
  if (!r.ok) return { ok: false, message: `The approval was spent, but the conversation wasn't reset: ${r.reason}.`, page: '' };
  const label = conv.label ?? conv.place ?? m[2];
  // Counted as his: what was waiting when he was asked. Something unplaced that arrived since keeps it no one's, and
  // its next refusal asks him again (with what's waiting then): said, never a plain "done".
  if (r.stillForeign) return { ok: true, message: `${label} counts as your work up to when you were asked; something loom can't place has arrived there since, so you'll be asked about that next.`, page: '' };
  return { ok: true, message: `${label} counts as your work now: ${who(m[1])} starts afresh there.`, page: '' };
}

const permsCore = (env) => (env?.LOOM_RUNTIME_TEST_CORE && typeof env.LOOM_RUNTIME_TEST_CORE === 'object' ? env.LOOM_RUNTIME_TEST_CORE : coreFrom(env, { timeoutMs: 8_000 }));

const OWNER = { kind: 'owner' };
const ago = (iso, nowMs = Date.now()) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 90) return '1m ago';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const toneOf = (state) => ({ running: 'ok', starting: 'ok', wanted: 'warn', stopping: 'warn', failed: 'bad', lost: 'bad' }[state] ?? 'muted');
/** A house's badge: its state, or, for a running body host's house on an older image than its agent's, that it's draining. */
const collectionWords = h => ({ metadata: 'waiting to collect state', native: 'saving conversation history', state: 'saving state', report: 'finishing', cleanup: 'cleaning up' }[h.collection?.phase]);
export const houseBadge = (h) => collectionWords(h) ?? (h.draining && h.state === 'running' ? `draining (${h.draining.reason ?? 'outdated image'})` : h.state);
const houseTone = (h) => h.collection ? 'warn' : (h.draining && h.state === 'running' ? 'warn' : toneOf(h.state));
const short = (t, n = 80) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const mayHostText = (m) => (m === '*' ? 'anyone' : (m || []).join(', ') || 'no one');
const dataDir = (env) => env.LOOM_BOX_DATA || join(env.HOME || '', '.local', 'share', 'loom-box');

/** A house's remote-control link, from its log on this box (Claude prints it when the session registers). */
function remoteLink(env, id) {
  try {
    const f = join(dataDir(env), 'houses', id, 'log');
    if (!existsSync(f)) return null;
    const m = readFileSync(f, 'utf8').match(/https:\/\/claude\.ai\/code\?environment=env_[A-Za-z0-9]+/g);
    return m ? m[m.length - 1] : null;
  } catch { return null; }
}

/**
 * Sessions first (Jonathan, 2026-10-26: talk to an agent from Claude's own
 * app): per agent, its box session (remote-control on the box) and its house
 * session (a service named "remote"), each with its link and one tap up or down.
 */
function sessionsSection(env, s, view, only) {
  const agents = Object.keys(s.agents).sort().filter((a) => !only || a === only);
  const blocks = [{ type: 'text', tone: 'muted', text: 'Each is a Claude remote-control session: open its link, or find it in the Claude app, and talk to the agent there.' }];
  for (const a of agents) {
    const r = view.remotes.find((x) => x.agent === a);
    const items = [];
    // Each session a row, its link on the row and one tap up or down at its right.
    if (r && r.want === 'up') {
      items.push({ text: `Box session on ${boxLabelOf(s, r.box)}`, meta: `${cap(r.state)}${r.error ? ` (${r.error})` : ''} · in ${r.dir}`, tone: r.state === 'running' ? 'ok' : 'warn', agent: a, ...(r.url ? { href: r.url } : {}),
        act: { action: 'remote-down', label: 'Down', tone: 'danger', confirm: 'The session ends; anything open in the Claude app on it stops.', fields: { agent: a } } });
    } else if (r?.dir) {
      items.push({ text: `Box session on ${boxLabelOf(s, r.box)}`, meta: `Down · in ${r.dir}`, tone: 'muted', agent: a,
        act: { action: 'remote-up', label: 'Up', tone: 'primary', fields: { agent: a, box: r.box, dir: r.dir } } });
    }
    const rs = view.services.find((v) => v.agent === a && v.name === 'remote');
    if (rs) {
      const link = rs.want === 'up' && rs.house ? remoteLink(env, rs.house) : null;
      items.push({ text: 'House session', meta: rs.want === 'up' ? `${cap(rs.state ?? 'starting')} on ${boxLabelOf(s, rs.box)}` : 'Down', tone: rs.want !== 'up' ? 'muted' : rs.state === 'running' ? 'ok' : 'warn', agent: a, ...(link ? { href: link } : {}),
        act: rs.want === 'up'
          ? { action: 'service-down', label: 'Down', tone: 'danger', confirm: 'The house stops; anything open in the Claude app on it stops.', fields: { agent: a, name: 'remote' } }
          : { action: 'service-up', label: 'Up', tone: 'primary', fields: { agent: a, name: 'remote' } } });
    }
    if (!items.length) continue;
    blocks.push({ type: 'list', items });
    // No box session yet: where it would run is a choice, so it's a form, a tap away.
    if (!r?.dir) blocks.push({ type: 'details', summary: `Start ${cap(a)}'s first box session`, blocks: sessionControls(env, s, a, null) });
  }
  return blocks.length > 1 ? { id: 'sessions', title: 'Sessions', blocks } : null;
}

/** No agent-wide Idle claim while a source cannot account for its current activity. */
export function idleUncertain(agent, s, busy, adapters, board) {
  if (!board || board.activityUnknown?.includes(agent)) return true;
  for (const v of Object.values(s.services ?? {})) {
    if (v.agent !== agent || v.want !== 'up') continue;
    if (BRIDGE.test(v.name) && !(adapters[v.name]?.mode === 'live' && adapters[v.name].agents?.includes(agent))) return true;
    if (v.name === 'remote' && (s.houses[v.house]?.state !== 'running' || busy[`house:${v.house}`] !== false)) return true;
  }
  const r = s.remotes?.[agent];
  return !!(r?.want === 'up' && (r.state !== 'running' || busy[`box:${r.name}`] !== false));
}

export function manifest(env, nowMs = Date.now(), o = {}) {
  const s = load(env);
  // One adapter snapshot serves both the legacy board and modern delivery ownership.
  // Re-running both adapter CLIs could exceed core's three-second manifest deadline.
  const adapters = adapterStatuses(env);
  try { checkLoginExpiry(env, nowMs, o.alert ? { alert: o.alert } : {}); } catch { /* next manifest */ }
  // The now board (nowboard.mjs): a bridge actually down is an alert (one restarting, by the runtime's own doing, is
  // not), one back from an outage an FYI, and what each agent's bodies are in is its doing.
  let board = { asks: [], agents: {}, notices: [], activityUnknown: Object.keys(s.agents ?? {}) };
  try { board = nowManifest(env, nowMs / 1000, s, listConvs(env), adapters); } catch { /* a board that can't be read leaves the rest of the manifest */ }
  // An always-on box gone silent is dark (watch.mjs): loom reads this manifest each minute, so it's checked here too.
  try { checkDark(env, s, nowMs, o.alert ? { alert: o.alert } : {}); } catch { /* next time */ }
  let convs = [];
  try { convs = workingConversations(env); } catch { /* the delivery state unreadable this time: the cards say what else is known */ }
  const busy = { ...reportedBusy(s), ...sessionsBusy(join(stateDir(env), 'session-cpu.json')) };
  const reports = agentReports(s, Date.now(), busy, convs, adapters);
  try {
    const busyAgents = nonIdleAgents(env);
    for (const a of Object.keys(s.agents ?? {})) {
      if (idleUncertain(a, s, busy, adapters, board) || busyAgents.has(a) || reports[a]?.doing?.length || board.agents[a]?.length || ['unavailable', 'broken'].includes(reports[a]?.state)) continue;
      reports[a] ??= { readings: [] };
      reports[a].idle = { observedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 30000).toISOString() };
    }
  } catch { /* unreadable delivery is not proof of idle */ }
  for (const [a, doing] of Object.entries(board.agents)) reports[a] = { readings: [], ...reports[a], doing: [...(reports[a]?.doing ?? []), ...doing].slice(0, 8) };
  for (const [agent, jobs] of Object.entries(board.jobs ?? {})) {
    reports[agent] ??= { readings: [] };
    (reports[agent].jobs ??= []).push(...jobs);
  }
  for (const { agent, ...job } of conversationJobs(env)) {
    reports[agent] ??= { readings: [] };
    (reports[agent].jobs ??= []).push(job);
  }
  for (const h of Object.values(s.houses ?? {}).filter((h) => !h.collection && !h.service && !isHostHouse(h, s) && ['running', 'starting', 'wanted'].includes(h.state))) {
    reports[h.agent] ??= { readings: [] };
    (reports[h.agent].jobs ??= []).push({ id: h.id, status: h.state === 'running' ? 'running' : 'waiting', text: doingOf(h, s).text, tasks: houseTaskRefs(h.task), since: h.started ?? h.created });
  }
  for (const [agent, r] of Object.entries(s.remotes ?? {})) {
    if (r.want !== 'up' || r.state !== 'running' || busy[`box:${r.name}`] !== true) continue;
    reports[agent] ??= { readings: [] };
    (reports[agent].jobs ??= []).push({ id: `remote:${r.name}`, status: 'running', text: `Working in a box session on ${boxLabelOf(s, r.box)}` });
  }
  for (const v of Object.values(s.services ?? {})) {
    if (v.name !== 'remote' || v.want !== 'up' || s.houses[v.house]?.state !== 'running' || busy[`house:${v.house}`] !== true) continue;
    reports[v.agent] ??= { readings: [] };
    (reports[v.agent].jobs ??= []).push({ id: `remote:${v.house}`, status: 'running', text: 'Working in a house session' });
  }
  try { withFallbacks(reports, readFallbacks(env), env, nowMs); } catch { /* a card without its model line */ }
  const boxes = Object.values(s.boxes).filter((b) => !b.revoked);
  const live = Object.values(s.houses).filter((h) => LIVE.has(h.state));
  return {
    v: 2,
    // An agent owner sees their agents' houses and services here (loom docs/specs/owners.md).
    owners: 2,
    tab: { label: 'Boxes' },
    // Each agent's houses, services, sessions and how its house is made: on its own Houses tab.
    agentTab: { label: 'Houses' },
    tile: {
      label: 'Boxes',
      value: `${boxes.length} box${boxes.length === 1 ? '' : 'es'}`,
      detail: live.length ? `${live.length} house${live.length === 1 ? '' : 's'} up or waiting` : 'no houses up',
      page: '',
    },
    // A box asking to join is the owner's call: the code is the one on the box's own terminal.
    // ...and a person a body proposes for an agent's gates (gates.mjs): the household owner's to allow or deny.
    // ...and a conversation paused as a loop (delivery.mjs, loops.mjs): Resume or Dismiss.
    // ...and a unit failing or crash-looping on a box (watch.mjs, keeping-watch.md).
    asks: [...pendingJoins(s).slice(0, 5).map((j) => joinAsk(j)), ...permsAsks(env), ...board.asks, ...loopAsksOf(env), ...watchAsksOf(env, s), ...loginExpiryAsks(s, nowMs)],
    agents: reports,
    // A delivery the runtime gave up on (its body never started, after its retries): the owner hears of it.
    // ...and a relay thread between agents that's run long today: a heads-up, never a stop (relay.mjs).
    notices: [...deliveryNotices(env), ...relayNotices(env), ...boxNotices(s), ...(board.notices ?? []), ...watchNoticesOf(env, nowMs)].sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, 20),
  };
}

function watchControlRows(b) {
  return b.local ? [] : [{ label: 'Watch', value: `${b.reportOnly ? 'Report-only' : 'Hosts what it may'} · ${b.reportOnly || b.alwaysOn ? 'always on' : 'not always on'}`,
          detail: 'An always-on box quiet for 10 minutes is an alert', act: b.reportOnly ? { action: 'box-watch', label: 'Let it host', fields: { name: b.id, report_only: 'off' }, confirm: `${b.label} may take houses again.` }
            : { action: 'box-watch', label: b.alwaysOn ? 'Not always on' : 'Always on', fields: { name: b.id, always_on: b.alwaysOn ? 'off' : 'on' } } }];
}
function watchAsksOf(env, s) { try { return watchAsks(env, (b) => boxLabelOf(s, b), (b) => !!s.boxes[b]?.revoked); } catch { return []; } }
function watchNoticesOf(env, nowMs) { try { return watchNotices(env, nowMs); } catch { return []; } }
function watchRowsOf(env, box, nowMs) { try { return watchRows(env, box, nowMs); } catch { return []; } }

function joinAsk(j) {
  return {
      text: `A box asks to join: ${j.name}`,
      meta: `from ${j.address}, code ${j.code}${j.facts.length ? ` · ${j.facts.filter((f) => !f.startsWith('runtime:')).slice(0, 4).map(factWords).join(' · ')}` : ''}`,
      // Something to allow: loom's Inbox files it under Permissions (it was Decisions, by default).
      tone: 'warn', at: j.at, page: '', kind: 'permission',
      actions: [
        { action: 'allow-join', label: 'Let it in', tone: 'primary', fields: { id: j.id }, confirm: `Let ${j.name} in only if its terminal shows code ${j.code}.` },
        { action: 'block-join', label: 'Block', tone: 'danger', fields: { id: j.id } },
      ],
  };
}

/** Conversations paused as loops; never one that breaks the manifest. */
function loopAsksOf(env) { try { return loopAsks(env); } catch { return []; } }

/** Proposals waiting in the gates; never one that breaks the manifest. */
function permsAsks(env) {
  const st = permsStore(env);
  if (!st) return [];
  try { return gateAsks(st).slice(0, 10); } catch { return []; }
}

/** A grant's paths in words: everything, or which. */
const pathsWords = (ps) => (ps.includes('*') ? 'everything' : ps.length === 1 ? `only ${ps[0]}` : `only ${ps.join(', ')}`);
/** Who a piece's grant lets in, in words: "Every agent", "Art and Mark", "Art (only tasks/*)". */
function grantWords(by) {
  const e = Object.entries(by ?? {});
  if (!e.length) return 'No agent';
  if (e.length === 1 && e[0][0] === '*') return e[0][1].includes('*') ? 'Every agent' : `Every agent, ${pathsWords(e[0][1])}`;
  const same = e.every(([, ps]) => ps.join() === e[0][1].join());
  const names = andList(e.map(([a]) => (a === '*' ? 'every agent' : who(a))));
  return same ? `${names}${e[0][1].includes('*') ? '' : `, ${pathsWords(e[0][1])}`}` : e.map(([a, ps]) => `${a === '*' ? 'Every agent' : who(a)}: ${pathsWords(ps)}`).join('; ');
}

/** The household's permissions: each piece's grant, who may relay to whom, and each agent's gates. Panels, not forms. */
function permissionsPage(env) {
  const st = permsStore(env);
  if (!st) return { title: 'Permissions', sections: [{ id: 'none', blocks: [{ type: 'text', tone: 'muted', text: 'The runtime reads its permissions from loom\'s store when loom runs it.' }] }] };
  const g = st.get(GRANTS, GRANTS_KEY);
  const agents = (householdOf(env)?.agents ?? []).filter((a) => AGENT_ID.test(a));
  const sections = [];
  if (!g) {
    sections.push({ id: 'grants', title: 'Pieces', blocks: [{ type: 'callout', tone: 'warn', title: 'Not seeded', text: 'No grants yet, so each piece decides by its own agent list, as before. `loom runtime grants seed` imports those lists; from then on the runtime decides first.' }] });
  } else {
    const bad = grantsProblem(g.doc);
    const rev = String(g.rev);
    // The agents an edit offers: the household's, as chips (Every agent is its own choice).
    const whoFields = (by) => {
      const e = Object.entries(by ?? {});
      const every = e.some(([a]) => a === '*');
      const ps = e[0]?.[1] ?? ['*'];
      return [
        { name: 'who', label: 'Who may use it', kind: 'segmented', value: every ? 'all' : 'some', options: [{ value: 'all', label: 'Every agent' }, { value: 'some', label: 'These agents' }] },
        ...(agents.length ? [{ name: 'agents', label: 'These agents', kind: 'checks', options: agents.map((a) => ({ value: a, label: who(a) })), ...(every ? {} : { value: e.map(([a]) => a).join(',') }) }]
          : [{ name: 'agents', label: 'These agents', kind: 'text', hint: 'agent names, comma-separated', ...(every ? {} : { value: e.map(([a]) => a).join(', ') }) }]),
        { name: 'paths', label: 'Paths', kind: 'text', value: ps.join(', '), hint: '* for all of it, a path, or a prefix ending in /*' },
      ];
    };
    const rows = Object.entries(g.doc.pieces ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([p, by]) => {
      const from = g.doc.seeded?.from?.[p];
      return { label: cap(p), value: grantWords(by), ...(from && /_AGENTS=/.test(from) ? { detail: 'Imported from the piece\'s own agent list' } : {}),
        edit: { title: `Who may use ${cap(p)}`, action: 'grants-set', submit: 'Save', hidden: { piece: p, rev }, fields: whoFields(by),
          note: 'Core asks the runtime before each call an agent makes to this piece.' } };
    });
    rows.push({ label: 'Another piece', value: 'Grant a piece that isn\'t listed', tone: 'muted',
      edit: { title: 'Grant a piece', action: 'grants-set', submit: 'Save', hidden: { rev },
        fields: [{ name: 'piece', label: 'Piece', kind: 'text', required: true }, ...whoFields({ '*': ['*'] })] } });
    sections.push({ id: 'grants', title: 'Pieces', blocks: [
      ...(bad ? [{ type: 'callout', tone: 'bad', title: 'Can\'t be read', text: `${bad}: every agent's piece call is refused until it's fixed.` }] : []),
      { type: 'panel', rows },
    ] });
    // Who may relay to whom: a switch per pair of the household's agents (few), else one sheet per agent.
    const relay = g.doc.relay ?? {};
    const pairs = agents.flatMap((a) => agents.filter((b) => b !== a).map((b) => [a, b]));
    const relayRows = pairs.length && pairs.length <= 12
      ? pairs.map(([a, b]) => { const on = (relay[a] ?? []).includes(b); return { label: `${who(a)} to ${who(b)}`, agent: a, value: on ? 'Without asking' : 'Asks you first',
        toggle: { action: 'relay-pair', on, fields: { agent: a, to: b } } }; })
      : agents.map((a) => ({ label: who(a), agent: a, value: (relay[a] ?? []).length ? `Relays to ${andList(relay[a].map(who))} without asking` : 'Asks you before every relay',
        edit: { title: `Who ${who(a)} relays to without asking`, action: 'relay-set', submit: 'Save', hidden: { agent: a, rev },
          fields: [{ name: 'to', label: 'Relays to', kind: 'checks', options: agents.filter((b) => b !== a).map((b) => ({ value: b, label: who(b) })), ...((relay[a] ?? []).length ? { value: relay[a].join(',') } : {}) }] } }));
    sections.push({ id: 'relay', title: 'Who may relay to whom', blocks: [
      relayRows.length ? { type: 'panel', rows: relayRows } : { type: 'text', tone: 'muted', text: 'One agent: nobody to relay to.' },
      { type: 'text', tone: 'muted', text: 'Switched on, an agent relays to the other without asking (the relay tool). Otherwise it asks you first: an approval on your Inbox, spent once.' },
    ] });
  }
  // Each agent's view (t-1970): what it can use, piece by piece, one click from here and from its own window.
  if (agents.length) {
    const bad = g ? grantsProblem(g.doc) : null;
    sections.push({ id: 'agents', title: 'What each agent can use', blocks: [{ type: 'panel', rows: agents.map((a) => {
      if (bad) return { label: `What ${who(a)} can use`, agent: a, value: 'Nothing: the grants can\'t be read', tone: 'bad', page: `permissions/${a}` };
      const u = g ? usableBy(g.doc, a) : null;
      const n = u ? u.filter((x) => x.paths.length).length : null;
      return { label: `What ${who(a)} can use`, agent: a, value: u === null ? 'Every piece (no grants yet)' : n ? `${n} piece${n === 1 ? '' : 's'}` : 'No pieces', page: `permissions/${a}` };
    }) }] });
  }
  let held = {};
  let waiting = {};
  try {
    held = gatesStatus(st);
    // Every agent's proposals in one read (each read is a run of loom store): the page has three seconds.
    for (const d of st.list(PROPOSALS_COLLECTION)) { const a = d.key.split('.')[0]; if (d.doc?.agent === a && d.doc?.entry && typeof d.doc.entry === 'object') waiting[a] = (waiting[a] ?? 0) + 1; }
  } catch { held = {}; waiting = {}; }
  sections.push({ id: 'gates', title: 'People', blocks: [Object.keys(held).length
    ? { type: 'panel', rows: Object.keys(held).sort().map((a) => { const n = waiting[a] ?? 0; return { label: `${who(a)}'s people`, agent: a, value: n ? `${n} waiting for you` : 'Nothing waiting', tone: n ? 'warn' : 'ok', page: `gates/${a}` }; }) }
    : { type: 'text', tone: 'muted', text: 'The runtime holds no gates yet: `loom shuttle gates export --json | loom runtime gates import`.' }] });
  return { title: 'Permissions', intro: 'Which agent may use which piece, who may relay to whom, and who each person is to each agent.', sections };
}

/** One agent's permissions in plain words (t-1970): each piece it can use and how much, then the ones it can't. */
function agentPermissionsPage(env, agent) {
  const st = permsStore(env);
  if (!st) return { title: 'Permissions', sections: [{ id: 'none', blocks: [{ type: 'text', tone: 'muted', text: 'The runtime reads its permissions from loom\'s store when loom runs it.' }] }] };
  if (!(householdOf(env)?.agents ?? []).includes(agent)) return { title: 'Not found', sections: [] };
  const g = st.get(GRANTS, GRANTS_KEY);
  const title = `What ${who(agent)} can use`;
  const back = { type: 'text', tone: 'muted', text: 'To change one, open Pieces on Permissions. When an agent asks for a piece, your Allow on its ask grants it.' };
  if (!g) return { title, sections: [{ id: 'pieces', blocks: [{ type: 'callout', tone: 'warn', title: 'Every piece', text: `No grants yet, so ${who(agent)} may use every piece, as each piece's own agent list allows.` }, back] }] };
  if (grantsProblem(g.doc)) return { title, sections: [{ id: 'pieces', blocks: [{ type: 'callout', tone: 'bad', title: 'Can\'t be read', text: 'The grants can\'t be read, so every agent\'s piece call is refused until they\'re fixed on Permissions.' }] }] };
  const u = usableBy(g.doc, agent);
  const yes = u.filter((x) => x.paths.length);
  const no = u.filter((x) => !x.paths.length);
  return { title, intro: `The pieces ${who(agent)} may call, as the runtime decides before each call.`, sections: [
    { id: 'can', title: 'Can use', blocks: [yes.length ? { type: 'panel', rows: yes.map((x) => ({ label: cap(x.piece), value: x.paths.includes('*') ? 'All of it' : pathsWords(x.paths).replace(/^only/, 'Only'), tone: 'ok' })) }
      : { type: 'text', tone: 'muted', text: `${who(agent)} can't use any piece.` }] },
    ...(no.length ? [{ id: 'cannot', title: 'Can\'t use', blocks: [{ type: 'panel', rows: no.map((x) => ({ label: cap(x.piece), value: 'Not granted', tone: 'muted' })) }] }] : []),
    { id: 'how', blocks: [back] },
  ] };
}

const NOTICE_WINDOW_MS = 24 * 3600_000;
/** A box's word on its sessions holds this long (it polls every few seconds). */
const SESSIONS_FRESH_MS = 3 * 60_000;

/** What the other boxes said about their remote sessions (each samples its own), while it's fresh. */
export function reportedBusy(s, nowMs = Date.now()) {
  const out = {};
  for (const b of Object.values(s.boxes)) {
    if (b.revoked || !b.sessions?.at || nowMs - Date.parse(b.sessions.at) > SESSIONS_FRESH_MS) continue;
    Object.assign(out, b.sessions.busy);
  }
  return out;
}

/**
 * loom's Inbox, FYI (never unread): a box that joined this week, and a task house that failed in the
 * last day, with the last thing it said (2026-10-27: two wakes died 'OAuth token revoked' and nobody saw).
 */
export function boxNotices(s, nowMs = Date.now()) {
  const out = [];
  for (const [id, b] of Object.entries(s.boxes)) {
    if (b.revoked || !b.joined || nowMs - Date.parse(b.joined) > 7 * NOTICE_WINDOW_MS) continue;
    out.push({ text: `${boxLabelOf(s, id)} joined loom`, meta: factsOf(b).filter((f) => !f.startsWith('runtime:')).slice(0, 5).map(factWords).join(' · '), at: b.joined, page: '' });
  }
  for (const h of Object.values(s.houses)) {
    if (h.service || h.state !== 'failed' || !h.updated || nowMs - Date.parse(h.updated) > NOTICE_WINDOW_MS) continue;
    const last = String(h.log ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
    out.push({ text: `${cap(h.agent)}'s house failed: ${taskLine(h.task)}`.slice(0, 300), meta: last.slice(0, 200), at: h.updated,
      ...(/^[a-z][a-z0-9-]{0,39}$/.test(h.agent) ? { agent: h.agent } : {}), page: '' });
  }
  return out.sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, 20);
}

/** The chat bridges among an agent's services (shuttle's adapters): what "Bridges" on its card means. */
const BRIDGE = /^(discord|slack|teams|telegram|matrix|signal|irc|email)$/;
/** A service that hasn't come back in this long is down, not starting. */
const STARTING_GRACE_MS = 5 * 60_000;
/** This many restarts without staying up is broken, not just down. */
const BROKEN_RESTARTS = 3;

const shortAge = (iso, nowMs) => {
  const m = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  return Number.isNaN(m) ? '' : m < 1 ? 'just now' : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** A wake's note (an agent's words) in a label: an approval's or request's id dropped, a leading task id after the words. */
export function plainNote(note) {
  const t = String(note ?? '').replace(/\((?:[aq]-[0-9a-f]{6,}) (\w+)\)/g, '($1)').trim();
  // The clock's resumed-wake prefix, old ("unparked (allowed): X") or new ("Resumed after your OK: X"), as the new.
  const r = RESUMED_NOTE.exec(t);
  if (r) return `Resumed after your OK${r[1] ? `: ${plainNote(r[1])}` : ''}`;
  const m = /^(t-\d+)[:,\s]+(\S.*)$/.exec(t);
  return m ? `${m[2]} (${m[1]})` : t;
}

/** A resumed wake's note prefix, either form, an id in it or not; group 1 is the agent's own note after it. */
const RESUMED_NOTE = /^(?:unparked \((?:[aq]-[0-9a-f]{6,} )?(?:allowed|granted)\)|Resumed after your OK(?: \(?[aq]-[0-9a-f]{6,}\)?)?):?\s*(.*)$/;
/** The clock's head on a wake resumed after Jonathan's OK (wake/wake unpark): "Jonathan allowed a-…. Pick up where you left off…". */
const RESUMED_HEAD = /(?:^|\n)\s*Jonathan allowed [aq]-[0-9a-f]{6,}\.\s+Pick up where you left off\b/;

const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
/** A lane's name as words: "knowledge-verify" -> "Knowledge verify". */
const laneWords = (n) => cap(n.replace(/-/g, ' '));

/** A task house's prompt, and the clock's wake line in it (its kind and note), if it has one. */
function wakeOf(task) {
  let t = String(task ?? '');
  try { const j = JSON.parse(t); if (j && typeof j.prompt === 'string') t = j.prompt; } catch { /* plain text */ }
  const m = /\(wake id w-[0-9a-f]+, kind (\w+)[^)]*?note: ([^\n]*?)\)\.\s/.exec(t) ?? /\(wake id w-[0-9a-f]+[^)]*?note: ([^\n]*?)\)\.\s/.exec(t);
  if (!m) return { t };
  return m.length === 3 ? { t, kind: m[1], note: m[2] } : { t, note: m[1] };
}

/** Explicit references from the authoritative task, or a wake's note rather than its wrapper instructions. */
export function houseTaskRefs(task) {
  const w = wakeOf(shownTask(task));
  return [...new Set((w.note ?? w.t).match(/\bt-\d+\b/g) ?? [])];
}

/** A lane's prompt, as the clock's lanes write it. */
const LANE_PROMPT = /^\s*You are running the ([a-z][a-z0-9-]*) lane\b/;

/** What a task house is doing, in a line: a wake's note (the clock puts it in the prompt), else the task's start. */
export function taskLine(task) {
  const w = wakeOf(shownTask(task));
  // A lane's own prompt ("You are running the landscape lane in a fresh house. …"): the lane, never the prompt's words.
  const ln = LANE_PROMPT.exec(w.t);
  if (ln && w.note === undefined) return `${laneWords(ln[1])} lane`;
  if (RESUMED_HEAD.test(w.t)) {
    // Never the approval's or request's id: the resumed agent needs it, Jonathan doesn't.
    const r = w.note !== undefined ? RESUMED_NOTE.exec(w.note.trim()) : null;
    const n = plainNote(r ? r[1] : (w.note ?? '').replace(/^schedule\s+/, ''));
    return (n ? `Picking up after your OK: ${n}` : 'Picking up after your OK').slice(0, 120);
  }
  if (w.note !== undefined) return plainNote(w.note.replace(/^schedule\s+/, '')).slice(0, 120) || 'a wake';
  return w.t.replace(/\s+/g, ' ').trim().slice(0, 120) || 'a task';
}

/** A lane's note ("reflect: nightly retro"), its lane name in words: "Reflect: nightly retro". */
const laneLine = (text) => text.replace(/^([a-z][a-z0-9-]*)(?=:|$)/, (n) => laneWords(n));

/** A house by what it is: "Art's Discord bridge", "Wake: cadence runner build (t-1689)", "Reflect lane: nightly retro". */
export function houseName(h, s) {
  const who = cap(String(h.agent ?? ''));
  if (h.service) {
    if (h.service === 'remote') return `${who}'s house session`;
    return BRIDGE.test(h.service) ? `${who}'s ${cap(h.service)} bridge` : `${who}'s ${h.service.replace(/-/g, ' ')}`;
  }
  // A body host's house (houserunner.mjs): where delivery's bodies run, never its command and boot key.
  // By the runtime's own mark (control.mjs, isHostHouse), never by its task's text alone (an agent writes that). Given
  // the state, one from before the mark counts too when no agent asked for it.
  // Whose work it's for (t-1952: one house per steering principal): the owner's, a person's, one unknown conversation's.
  if (h.kind === 'body-host' || (s && isHostHouse(h, s))) {
    const seat = typeof h.seat === 'string' ? h.seat : 'owner';
    if (seat.startsWith('p-')) return `${who}'s body host, for ${seat.slice(2)}`;
    if (seat.startsWith('u-')) return `${who}'s body host, for one conversation (${seat.slice(2)})`;
    return `${who}'s body host`;
  }
  const w = wakeOf(h.task);
  if (w.kind === 'schedule') {
    const t = taskLine(h.task);
    const lm = /^([a-z][a-z0-9-]*)(?::\s*(.*))?$/.exec(t);
    return lm ? `${laneWords(lm[1])} lane${lm[2] ? `: ${lm[2]}` : ''}` : `Lane: ${t}`;
  }
  if (RESUMED_HEAD.test(w.t)) return taskLine(h.task);
  if (w.note !== undefined) return `Wake: ${taskLine(h.task)}`;
  return taskLine(h.task);
}

/**
 * A running task house as one thing its agent has going (loom's `doing`): a lane (the clock's schedule) or a wake,
 * by its note; anything else, by its task's first words.
 */
export function doingOf(h, s) {
  const w = wakeOf(h.task);
  const lane = w.kind === 'schedule' || LANE_PROMPT.test(w.t);
  const text = taskLine(h.task);
  return {
    text: cap(lane ? laneLine(text) : text).slice(0, 100), kind: lane ? 'lane' : 'task',
    where: `a house on ${boxLabelOf(s, h.box)}`,
    since: h.started ?? h.created,
  };
}

/** A house's row label: what it is, by its service, its lane or wake, or its task's first words (never its id). */
export function houseTask(h) {
  return houseName(h);
}

const FACT_WORDS = { nvidia: 'NVIDIA', geforce: 'GeForce', rtx: 'RTX', gtx: 'GTX', amd: 'AMD', radeon: 'Radeon', intel: 'Intel', apple: 'Apple', tesla: 'Tesla', quadro: 'Quadro', ti: 'Ti' };
const OS_WORDS = { linux: 'Linux', darwin: 'macOS', win32: 'Windows', freebsd: 'FreeBSD' };
const ARCH_WORDS = { x86_64: 'x86-64', arm64: 'ARM64', aarch64: 'ARM64' };
/** A box's fact in words, "mem:94g" -> "94 GB"; one it doesn't know stays as it is. */
export function factWords(f) {
  const i = f.indexOf(':');
  const [k, v] = i > 0 ? [f.slice(0, i), f.slice(i + 1)] : [f, ''];
  if (k === 'os' && v) return OS_WORDS[v] ?? cap(v);
  if (k === 'arch' && v) return ARCH_WORDS[v] ?? v;
  if (k === 'cpus' && /^\d+$/.test(v)) return `${v} CPU${v === '1' ? '' : 's'}`;
  if (k === 'mem' && /^\d+g$/.test(v)) return `${v.slice(0, -1)} GB`;
  if (k === 'gpu' && v) return v.split('-').map((p) => FACT_WORDS[p] ?? (/\d/.test(p) ? p.toUpperCase() : cap(p))).join(' ');
  return f;
}
/** A fact as a row of the Machine card: its name in words, and its value in words. */
const FACT_LABELS = { os: 'System', arch: 'Architecture', cpus: 'CPUs', mem: 'Memory', gpu: 'GPU', runtime: 'Runtime' };
function factRow(f) {
  const i = f.indexOf(':');
  if (i <= 0) return { label: f, value: 'yes' };
  const k = f.slice(0, i), v = f.slice(i + 1);
  const w = factWords(f);
  return { label: FACT_LABELS[k] ?? k, value: k === 'cpus' || w === f ? v : w };
}

/** Model family is a normal choice, not a card health reading. Quota details stay in model controls and trace. */
export function withFallbacks(reports) {
  return reports;
}

/**
 * Each agent as the box runtime sees it, for its card on loom's Home (docs/extensions.md, "agents"): working while a
 * task house runs; unavailable while a service it wants up is down; broken when one keeps failing. Readings: its
 * bridges, its remote sessions, and how many tasks are running. It says nothing about an agent with nothing here.
 */
export function agentReports(s, nowMs = Date.now(), busy = {}, convs = [], adapters = {}) {
  const out = {};
  const liveAdapters = Object.entries(adapters).filter(([, d]) => d.mode === 'live').flatMap(([name, d]) => d.agents.map((agent) => ({name, agent, want: 'up', adapter: true})));
  const services = [...Object.values(s.services ?? {}).filter((v) => !liveAdapters.some((a) => a.agent === v.agent && a.name === v.name)), ...liveAdapters];
  const agents = new Set([...Object.keys(s.agents ?? {}), ...services.map((v) => v.agent), ...Object.keys(s.remotes ?? {}), ...convs.map((c) => c.agent)]);
  for (const a of agents) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(a)) continue;
    const mine = services.filter((v) => v.agent === a && v.want === 'up');
    const up = (v) => v.adapter || s.houses[v.house]?.state === 'running';
    const late = (v) => { const h = s.houses[v.house]; return !h || !LIVE.has(h.state) || (h.state !== 'running' && nowMs - Date.parse(h.updated ?? h.created) > STARTING_GRACE_MS); };
    const down = mine.filter((v) => !up(v) && late(v));
    const failing = down.filter((v) => (v.restarts ?? 0) >= BROKEN_RESTARTS);
    // A body host's house is where its conversations run, not something it's doing: its bodies are (the now board's).
    const tasks = Object.values(s.houses).filter((h) => h.agent === a && !h.collection && !h.service && !isHostHouse(h, s) && (h.state === 'running' || h.state === 'starting'))
      // Running first (it's what the agent is doing), then the newest.
      .sort((x, y) => (y.state === 'running') - (x.state === 'running') || Date.parse(y.created) - Date.parse(x.created));
    const readings = [];
    const bridges = mine.filter((v) => BRIDGE.test(v.name));
    if (bridges.length) {
      const bad = bridges.some((v) => !up(v) && late(v));
      // One on its way back up (the runtime restarting it, within the grace) is restarting, not down.
      const word = (v) => (up(v) ? '✓' : late(v) ? '✗' : 'restarting');
      const restarting = bridges.some((v) => !up(v) && !late(v));
      readings.push({ label: 'Bridges', value: bridges.map((v) => `${v.name} ${word(v)}`).join('  '), tone: bad ? 'bad' : restarting ? 'warn' : 'ok' });
    }
    // Each remote session, and whether it's mid-turn (busy.mjs: only sessions on this machine are seen).
    const remote = [];
    const working = [];
    const word = (k) => (busy[k] === true ? ' · working' : busy[k] === false ? ' · idle' : '');
    const r = s.remotes?.[a];
    if (r && r.want === 'up') {
      const k = `box:${r.name}`;
      remote.push(`box session on ${boxLabelOf(s, r.box)}${r.state === 'running' ? word(k) : ` (${r.error ? 'error' : r.state})`}`);
      if (busy[k]) working.push(`box session on ${boxLabelOf(s, r.box)}`);
    }
    const rs = mine.find((v) => v.name === 'remote');
    if (rs) {
      const k = `house:${rs.house}`;
      remote.push(`house session${up(rs) ? word(k) : ' (down)'}`);
      if (busy[k] && up(rs)) working.push('house session');
    }
    if (remote.length) readings.push({ label: 'Remote', value: remote.join(' · '), tone: (r && r.want === 'up' && r.error) ? 'warn' : undefined });
    if (tasks.length) readings.push({ label: 'Tasks', value: `${tasks.length} running`, detail: tasks.map((h) => `${short(houseName(h), 40)} on ${boxLabelOf(s, h.box)}`).slice(0, 3).join(', ') });
    const report = { readings: readings.map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined))).slice(0, 4) };
    // What it has going, for its card (loom's `doing`): each running task house, and a remote session mid-turn.
    const doing = [
      ...tasks.filter((h) => h.state === 'running').map((h) => doingOf(h, s)),
      ...(r && r.want === 'up' && busy[`box:${r.name}`] === true ? [{ text: 'Working in a Claude session', kind: 'session', where: `Box session on ${boxLabelOf(s, r.box)}` }] : []),
      ...(rs && up(rs) && busy[`house:${rs.house}`] === true ? [{ text: 'Working in a Claude session', kind: 'session', where: 'House session' }] : []),
      // Each delivered body mid-turn: a Comms thread, a bridge's chat, a wake (delivery.mjs, workingConversations).
      ...convs.filter((c) => c.agent === a).map(convDoing),
    ].slice(0, 6);
    if (doing.length) report.doing = doing;
    if (failing.length) Object.assign(report, { state: 'broken', reason: `${failing.map((v) => v.name).join(' and ')} keep${failing.length === 1 ? 's' : ''} failing (${failing[0].restarts} restarts)` });
    else if (down.length) Object.assign(report, { state: 'unavailable', reason: `${down.map((v) => v.name).join(' and ')} ${down.length === 1 ? 'is' : 'are'} down` });
    else if (!tasks.length && working.length) Object.assign(report, { state: 'working', reason: `in a remote session: ${working.join(', ')}` });
    else if (tasks.length) {
      const h = tasks[0];
      const d = doingOf(h, s);
      Object.assign(report, { state: 'working', reason: `${d.text} · ${d.where}${h.started ? ` · ${shortAge(h.started, nowMs)}` : ` · ${h.state}`}` });
    }
    if (report.state || report.readings.length || report.doing) out[a] = report;
  }
  return out;
}

/**
 * A delivered body at work, as its card says it (loom's `doing`): its venue, its kind and its conversation's id only.
 * A conversation's label can carry its subject (a Slack channel or DM, a person, a wake's note), and a manifest may
 * reach viewers who aren't allowed to see that conversation: core puts the label in, and the link, only for a viewer
 * who may see it (loom src/ui/handler.ts atWorkFor), as it does a Comms thread's title (comms.md, rule 4).
 */
export function convDoing(c) {
  const since = { ...(Number.isFinite(c.since) ? { since: new Date(c.since).toISOString() } : {}), ...(c.activity ? { activity: c.activity } : {}) };
  if (c.venue === COMMS_VENUE) return { text: 'In a Comms thread', kind: 'talk', where: 'Comms', conversation: c.conversation, ...since };
  if (c.kind === 'scheduled') return { text: 'On a wake', kind: 'lane', conversation: c.conversation, ...since };
  return { text: `Working · ${cap(c.venue)}`, kind: 'talk', ...(['discord', 'slack', 'signal'].includes(c.venue) ? { where: cap(c.venue) } : {}), conversation: c.conversation, ...since };
}

/** "12 days", "5 hours", "40 minutes": how long, for a box's uptime. */
function span(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 120) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.floor(h / 24)} days`;
}

/** This box's disk (where houses live): the share used, and what's free. */
function diskUse(env) {
  try {
    const st = statfsSync(existsSync(dataDir(env)) ? dataDir(env) : (env.HOME || '/'));
    const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
    if (!total) return null;
    const gb = free / 1e9;
    return { used: Math.min(1, Math.max(0, 1 - free / total)), free: gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB` };
  } catch { return null; }
}

/** A house's state in words: "Running", "Waiting for a box", "Running, draining (outdated image)". */
export function houseWords(h) {
  if (collectionWords(h)) return cap(collectionWords(h));
  if (h.draining && h.state === 'running') return `Running, draining (${h.draining.reason ?? 'outdated image'})`;
  return ({ running: 'Running', starting: 'Starting', wanted: 'Waiting for a box', stopping: 'Stopping', stopped: 'Stopped', failed: 'Failed', lost: 'Lost: its box stopped answering' }[h.state]) ?? cap(String(h.state ?? 'unknown'));
}

/** A house's detail, for whoever asks: its id, its box, its times, and what it runs. */
function houseSheet(s, h, nowMs) {
  const items = [
    { label: 'State', value: houseWords(h) },
    { label: 'Box', value: boxLabelOf(s, h.box) },
    ...(h.started ? [{ label: 'Started', value: ago(h.started, nowMs) }] : h.created ? [{ label: 'Asked for', value: ago(h.created, nowMs) }] : []),
    ...(h.updated ? [{ label: 'Last word', value: ago(h.updated, nowMs) }] : []),
    ...(h.needs?.length ? [{ label: 'Needs', value: [].concat(h.needs).join(', ') }] : []),
    ...(h.exit !== undefined ? [{ label: 'Exit', value: String(h.exit) }] : []),
  ];
  const task = typeof h.task === 'string' ? shownTask(h.task) : '';
  return { title: houseName(h, s), blocks: [{ type: 'kv', items }, ...(!h.service && task ? [{ type: 'code', label: isHostHouse(h, s) ? 'What it runs' : 'Its task', text: task.slice(0, 1900) }] : []),
    { type: 'text', tone: 'muted', text: `House ${h.id}` }] };
}

/** A house as a panel row: what it is, its state in words, its agent's mark; the ids and the command a tap away. */
function housePanelRow(s, h, nowMs, extra = {}) {
  return { label: short(houseName(h, s), 90), value: houseWords(h), tone: houseTone(h), ...(AGENT_ID.test(h.agent ?? '') ? { agent: h.agent } : {}), ...extra, ...(extra.act ? {} : { sheet: houseSheet(s, h, nowMs) }) };
}
const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;
const who = (a) => cap(String(a ?? ''));
/** A member's slug as a name: "jonathan-barket" -> "Jonathan Barket". */
const memberName = (m) => String(m ?? '').split('-').map(cap).join(' ');
const andList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A box's machine in a line ("Linux · 64 CPUs · 94 GB"), and its facts and grants in a sheet. */
function machineRow(b) {
  const facts = b.facts.filter((f) => /^(os|cpus|mem|gpu):/.test(f)).map(factWords);
  return { label: 'Machine', value: facts.join(' · ') || 'Not reported yet', ...(b.local ? { detail: 'loom runs here' } : {}),
    sheet: { title: b.label, blocks: [{ type: 'kv', items: [
      ...b.facts.map(factRow),
      { label: 'May host', value: mayHostText(b.mayHost) },
      ...(b.owner ? [{ label: 'Owner', value: b.owner }] : []),
      ...(b.lentTo?.length ? [{ label: 'Lent to', value: b.lentTo.join(', ') }] : []),
      { label: 'Box id', value: b.id },
    ] }] } };
}

/** The owner's settings for a box that isn't loom's own: who it may host, whose it is, who it's lent to; Revoke at its foot. */
function boxSettingsPanel(b) {
  return { type: 'panel', title: 'Settings', rows: [
    { label: 'May host', value: b.mayHost === '*' ? 'Any agent' : (b.mayHost || []).length ? andList((b.mayHost || []).map(who)) : 'No one',
      edit: { title: `Who ${b.label} may host`, action: 'may-host', submit: 'Save', hidden: { name: b.id },
        fields: [{ name: 'may_host', label: 'Agents', kind: 'text', value: mayHostText(b.mayHost), hint: '"anyone", or agent names separated by commas' }] } },
    { label: 'Owner', value: b.owner ? memberName(b.owner) : 'The household', detail: 'An agent\'s work runs only on its owner\'s boxes',
      edit: { title: `Whose ${b.label} is`, action: 'box-owner', submit: 'Save', hidden: { name: b.id },
        fields: [{ name: 'owner', label: 'Owner', kind: 'text', ...(b.owner ? { value: b.owner } : {}), hint: 'a member of the household' }] } },
    { label: 'Lent to', value: (b.lentTo ?? []).length ? andList(b.lentTo.map(who)) : 'No one',
      edit: { title: `Lend ${b.label}`, action: 'box-lend', submit: 'Save', hidden: { name: b.id },
        fields: [{ name: 'agents', label: 'Other members\' agents', kind: 'text', ...((b.lentTo ?? []).length ? { value: b.lentTo.join(', ') } : {}), hint: 'agent names, or empty: their work runs on this box and its logins' }] } },
  ], action: { action: 'revoke-box', label: `Revoke ${b.label}`, tone: 'danger', confirm: `${b.label} is cut off: its credential stops working and its houses lose their tokens.`, fields: { name: b.id } } };
}

/** What the runtime's watch last heard from each box (watch.mjs): its health sample, its conditions, its failing units. */
function watchBoxes(env) { try { return watchOf(env).boxes ?? {}; } catch { return {}; } }

/**
 * One box's own problems, worst first, in words: what its row on Boxes flags and its own page leads with. Each is
 * `text`, which names the box (the headline's), and `short`, which doesn't (its own row's).
 */
function boxIssues(env, b, nowMs, w) {
  const bad = [], warn = [];
  // `state`: it's the box's state itself (its row's value says it), so the row's detail doesn't say it twice.
  const say = (to, text, short, state = false) => to.push({ text, short, state });
  if (!b.local && !b.lastSeen) say(warn, `${b.label} hasn't joined yet`, 'not joined yet', true);
  else if (!b.local && nowMs - Date.parse(b.lastSeen) > 10 * 60_000) say(bad, `${b.label} hasn't been heard from since ${ago(b.lastSeen, nowMs)}`, `not heard from since ${ago(b.lastSeen, nowMs)}`, true);
  const loomC = ownCommit();
  const rt = b.runtime ?? {};
  if (loomC && !b.local && b.lastSeen && rt.commit !== loomC) {
    const u = rt.upgrade?.commit === loomC ? rt.upgrade : null;
    if (u && ['failed', 'refused', 'rolling-back'].includes(u.state)) say(bad, `${b.label}'s runtime update didn't work`, 'its runtime update didn\'t work');
    else if (!rt.commit) say(warn, `${b.label} is on the old box piece`, 'on the old box piece');
  }
  for (const [h, def] of Object.entries(LOGIN_HARNESSES)) {
    const st = b.harnesses?.[h];
    if (st?.installed && st.unhealthy) say(bad, `${def.label} on ${b.label} isn't usable`, `${def.label} isn't usable`);
    else if (st?.installed && !st.loggedIn) say(warn, `${def.label} isn't logged in on ${b.label}`, `${def.label} isn't logged in`);
  }
  const disk = b.local ? diskUse(env) : null;
  if (disk && disk.used >= 0.95) say(bad, `${b.label}'s disk is nearly full`, 'its disk is nearly full');
  else if (disk && disk.used >= 0.9) say(warn, `${b.label}'s disk is ${Math.round(disk.used * 100)}% full`, `disk ${Math.round(disk.used * 100)}% full`);
  // What its watch alerted on (health.mjs titles start with the box's name), and its units failing or crash-looping.
  for (const [key, c] of Object.entries(w?.conditions ?? {})) {
    // Gone dark is the box's state (not heard from since …), said once.
    if (!c.alerted || !c.title || (key === 'dark' && !b.local)) continue;
    const t = String(c.title);
    // "thor: / is nearly full" -> "/ is nearly full", "thor is short of memory" -> "short of memory", "thor's swap is …" -> "swap is …".
    const short = [`${b.label}: `, `${b.label} is `, `${b.label}'s `].reduce((x, pre) => (x === t && t.startsWith(pre) ? t.slice(pre.length) : x), t);
    say(c.severity === 'bad' ? bad : warn, t, short);
  }
  for (const ep of Object.values(w?.units ?? {})) say(bad, `unit ${ep.unit} on ${b.label} ${ep.state === 'looping' ? 'keeps restarting' : 'failed'}`, `unit ${ep.unit} ${ep.state === 'looping' ? 'keeps restarting' : 'failed'}`);
  return { bad, warn };
}

/** What's wrong across the boxes, worst first, in words: the Boxes page's headline. */
function boxProblems(s, issues, view) {
  const bad = [], warn = [];
  for (const i of issues) { bad.push(...i.bad.map((x) => x.text)); warn.push(...i.warn.map((x) => x.text)); }
  for (const v of view.services.filter((x) => x.want === 'up')) {
    if (v.state === 'failed' || v.state === 'lost') bad.push(`${who(v.agent)}'s ${v.name} is down`);
  }
  const asking = pendingJoins(s).length;
  if (asking) warn.push(asking === 1 ? 'A box asks to join' : `${asking} boxes ask to join`);
  return { bad, warn };
}

/** A box's state: up (how long, or when it was last heard from), quiet, or not joined yet. `short` is its row's word. */
function boxState(b, nowMs) {
  if (b.local) return { value: `Up ${span(uptime() * 1000)}`, short: `Up ${span(uptime() * 1000)}`, tone: 'ok' };
  if (!b.lastSeen) return { value: 'Not joined yet', detail: `Run loom box join on ${b.label}`, short: 'Not joined yet', tone: 'warn' };
  if (nowMs - Date.parse(b.lastSeen) > 10 * 60_000) return { value: `Not heard from since ${ago(b.lastSeen, nowMs)}`, short: `Quiet since ${ago(b.lastSeen, nowMs)}`, tone: 'bad' };
  return { value: 'Up', detail: `Seen ${ago(b.lastSeen, nowMs)}`, short: `Up · seen ${ago(b.lastSeen, nowMs)}`, tone: 'ok' };
}

/** What a box is for, in a few words: "loom's own", "report-only · always on", "hosts houses". */
function boxRole(b) {
  const hosts = b.mayHost === '*' || (b.mayHost ?? []).length;
  return [b.local ? 'loom\'s own' : null, b.reportOnly ? 'report-only' : hosts ? 'hosts houses' : 'hosts nothing', !b.local && (b.alwaysOn || b.reportOnly) ? 'always on' : null].filter(Boolean).join(' · ');
}

/** A box's one health fact, from its last sample: how full its fullest disk is, and its swap once it's half used. */
function healthFact(env, b, w) {
  const parts = [];
  const disk = b.local ? diskUse(env) : null;
  const fullest = [...(w?.health?.fs ?? [])].filter((f) => Number.isFinite(f?.used_pct)).sort((x, y) => y.used_pct - x.used_pct)[0];
  if (disk) parts.push(`disk ${Math.round(disk.used * 100)}%`);
  else if (fullest) parts.push(`disk ${Math.round(fullest.used_pct)}%`);
  const m = w?.health?.mem;
  if (m?.swap_total > 0 && Number.isFinite(m.swap_free)) {
    const used = Math.round(100 - (100 * m.swap_free) / m.swap_total);
    if (used >= 50) parts.push(`swap ${used}%`);
  }
  return parts.join(' · ');
}

/** Pending collection retains bookkeeping, not a running container. */
function houseProgress(houses) {
  const collecting = houses.filter(h => h.collection).length;
  const waiting = houses.filter(h => !h.collection && ['wanted', 'starting'].includes(h.state)).length;
  const stopping = houses.filter(h => !h.collection && h.state === 'stopping').length;
  return [collecting ? `${plural(collecting, 'house')} finishing` : '', waiting ? `${plural(waiting, 'house')} starting or waiting` : '', stopping ? `${plural(stopping, 'house')} stopping` : ''].filter(Boolean).join(' · ');
}

const TONE_RANK = { bad: 0, warn: 1, ok: 2 };

/** A status headline: the worst thing in words (and how many more), the next few under it; else the counts. `floor`: a tone it's at least. */
function headline(bad, warn, counts, fine, floor = 'ok') {
  const worst = [...bad, ...warn];
  return { type: 'health', tone: bad.length || floor === 'bad' ? 'bad' : warn.length || floor === 'warn' ? 'warn' : 'ok',
    text: worst.length ? `${cap(worst[0])}${worst.length > 1 ? ` (and ${worst.length - 1} more)` : ''}` : counts,
    detail: worst.length ? `${worst.slice(1, 4).map(cap).join('. ')}${worst.length > 1 ? '. ' : ''}${counts}.` : fine };
}

/**
 * The Boxes page: how things are in a line, then a row per box (its state, its houses, what it's for or what's wrong
 * with it), each a tap from its own page. Jonathan, 2026-11-05: "the first page should be a summary of everything
 * that's easy to digest and then drill into each box."
 */
function boxesPage(env, nowMs) {
  const s = load(env);
  const view = list(env, OWNER);
  const agents = Object.keys(s.agents).sort();
  const live = view.houses.filter((h) => LIVE.has(h.state));
  const running = live.filter((h) => h.state === 'running' && !h.collection);
  const sections = [];
  const live_boxes = view.boxes.filter((b) => !b.revoked).map((b) => ({ ...b, label: boxLabelOf(s, b.id) }));
  const up = live_boxes.filter((b) => b.local || (b.lastSeen && nowMs - Date.parse(b.lastSeen) <= 10 * 60_000));
  const svcUp = view.services.filter((v) => v.want === 'up');
  const watch = watchBoxes(env);

  // The headline: how things are, in words; what's wrong first. Tiles under it.
  // Each box's problems, once: the headline says them all, each box's row its own.
  const issues = live_boxes.map((b) => boxIssues(env, b, nowMs, watch[b.id]));
  const { bad, warn } = boxProblems(s, issues, view);
  const counts = `${plural(up.length, 'box', 'boxes')} up · ${plural(running.length, 'house')} running`;
  const disk = diskUse(env);
  const local = live_boxes.find((b) => b.local);
  sections.push({ id: 'status', blocks: [
    headline(bad, warn, counts, `${plural(svcUp.length, 'service')} up${houseProgress(live) ? ` · ${houseProgress(live)}` : ''}. ${live.some(h => h.collection) ? 'Completed work is still being collected.' : 'Nothing needs you.'}`, live.some(h => h.collection) ? 'warn' : 'ok'),
    { type: 'stats', items: [
      { label: 'Boxes', value: String(up.length), detail: live_boxes.length > up.length ? `of ${live_boxes.length}` : 'all up', tone: live_boxes.length > up.length ? 'warn' : 'ok' },
      { label: 'Houses', value: String(running.length), detail: houseProgress(live) || 'running' },
      { label: 'Services', value: String(svcUp.length), detail: 'kept up' },
      ...(disk && local ? [{ label: `${local.label}'s disk`, value: `${Math.round(disk.used * 100)}%`, detail: `${disk.free} free`, meter: disk.used, ...(disk.used >= 0.95 ? { tone: 'bad' } : disk.used >= 0.85 ? { tone: 'warn' } : {}) }] : []),
    ] },
  ] });

  // Every box waiting to be let in (Home shows the newest few as cards), and a way to clear a flood.
  const asking = pendingJoins(s);
  if (asking.length) {
    sections.push({ id: 'joins', title: `Asking to join (${asking.length})`, tone: 'warn', blocks: [
      { type: 'panel', rows: asking.map((j) => ({ label: j.name, value: `Code ${j.code}`, detail: `Asked from ${j.address}${j.facts.length ? ` · ${j.facts.filter((f) => !f.startsWith('runtime:')).slice(0, 4).map(factWords).join(' · ')}` : ''}`, tone: 'warn',
        act: { action: 'allow-join', label: 'Let it in', tone: 'primary', fields: { id: j.id }, confirm: `Let ${j.name} in only if its terminal shows code ${j.code}.` } })),
      action: { action: 'block-all-joins', label: 'Block all waiting', tone: 'danger', confirm: `All ${asking.length} waiting requests are blocked.` } },
    ] });
  }

  // A row per box, what's wrong first: its state and houses, then its trouble or what it's for. Everything else is a tap away.
  const rows = live_boxes.map((b, k) => {
    const st = boxState(b, nowMs);
    const { bad: badOnes, warn: warnOnes } = issues[k];
    const trouble = [...badOnes, ...warnOnes].filter((x) => !x.state);
    const n = live.filter((h) => h.box === b.id).length;
    const tone = badOnes.length || st.tone === 'bad' ? 'bad' : warnOnes.length || st.tone === 'warn' ? 'warn' : 'ok';
    // What's wrong first (and how many more), then what it's for; a fine box's one health fact in its place.
    const problem = trouble.length ? `${cap(trouble[0].short)}${trouble.length > 1 ? ` (and ${trouble.length - 1} more)` : ''}` : '';
    const role = boxRole(b);
    return { label: b.label, value: `${st.short} · ${plural(n, 'house')}`,
      detail: [problem, problem ? role : (role.startsWith('loom') ? role : cap(role)), problem ? '' : healthFact(env, b, watch[b.id])].filter(Boolean).join(' · '),
      tone, page: `box/${b.id}` };
  }).sort((x, y) => TONE_RANK[x.tone] - TONE_RANK[y.tone]);
  sections.push({ id: 'boxes', title: 'Boxes', blocks: [rows.length ? { type: 'panel', rows } : { type: 'text', tone: 'muted', text: 'No boxes yet: add one below.' }] });

  sections.push(loginsSection(env, s, live_boxes, nowMs, false));
  sections.push(rolesSection(env));

  // Each agent's houses, services and sessions are its own (its Houses tab): here, a row each.
  if (agents.length) {
    sections.push({ id: 'agents', title: 'Each agent\'s houses', blocks: [{ type: 'panel', rows: agents.map((a) => {
      const n = live.filter((h) => h.agent === a).length;
      const svc = view.services.filter((v) => v.agent === a && v.want === 'up');
      const down = svc.filter((v) => v.state === 'failed' || v.state === 'lost');
      return { label: who(a), agent: a, page: `agent:${a}`, value: `${plural(n, 'house')} up · ${plural(svc.length, 'service')}`,
        detail: down.length ? `${andList(down.map((v) => v.name))} ${down.length === 1 ? 'is' : 'are'} down` : whereRuns(s, a, live, env, nowMs), tone: down.length ? 'bad' : n ? 'ok' : 'muted' };
    }) }] });
  }

  sections.push({ id: 'add', side: true, title: 'Add', blocks: [{ type: 'panel', rows: [
    { label: 'A box', value: 'Name the machine, then run loom box join on it', detail: 'Its credential shows once, after you add it',
      edit: { title: 'Add a box', action: 'add-box', submit: 'Add', fields: [
        { name: 'name', label: 'Name', kind: 'text', required: true, hint: 'Lowercase, e.g. thor or jonathan-laptop' },
        { name: 'may_host', label: 'May host', kind: 'text', value: 'anyone', hint: '"anyone", or agent names' },
        { name: 'labels', label: 'Labels', kind: 'text', hint: 'Optional, e.g. jonathan-rig' },
      ] } },
    { label: 'An agent', value: 'Give an agent a house', detail: 'Its repo and what its houses may have', edit: { ...agentEdit('', null), title: 'Give an agent a house' } },
  ] }] });
  // Which agent may use which piece, who may relay to whom, and each agent's gates (agent-runtime.md, section 6).
  sections.push({ id: 'new-agent', side: true, title: 'More', blocks: [{ type: 'panel', rows: [
    { label: 'Permissions', value: 'Pieces, relays and people', page: 'permissions' },
    { label: 'Now', value: 'Bridges and the quota', page: 'now' },
  ] }] });
  return { title: 'Boxes', intro: 'The machines agents run on, and their houses: an agent\'s container, started for a task or kept up as a service.', sections };
}

/**
 * One box's own page, a tap from its row on Boxes: how it is in a line (what's wrong first), then everything about it:
 * its state, machine, runtime and Update now, its sign-ins, its health and boot, its watch, its houses, and its settings.
 * A box's logins and Update now are its owner's (control.mjs, assertBoxOwner): another household owner sees, doesn't press.
 */
function boxPage(env, id, nowMs, caller = OWNER) {
  const s = load(env);
  const view = list(env, OWNER);
  const found = view.boxes.find((x) => x.id === id && !x.revoked);
  if (!found) return { title: 'Not found', sections: [{ id: 'gone', blocks: [{ type: 'text', tone: 'muted', text: 'There\'s no such box (or it was revoked).' }, { type: 'link', text: 'All boxes', page: '' }] }] };
  const b = { ...found, label: boxLabelOf(s, id) };
  const may = isBoxOwner(env, caller, b.id);
  const here = view.houses.filter((h) => LIVE.has(h.state) && h.box === b.id);
  const st = boxState(b, nowMs);
  const i = boxIssues(env, b, nowMs, watchBoxes(env)[b.id]);
  const bad = i.bad.map((x) => x.text), warn = i.warn.map((x) => x.text);
  const running = here.filter((h) => h.state === 'running' && !h.collection).length;
  const counts = `${st.short} · ${plural(running, 'house')} running${houseProgress(here) ? ` · ${houseProgress(here)}` : ''}`;
  return { title: b.label, intro: b.local ? boxRole(b) : cap(boxRole(b)), sections: [
    { id: 'status', blocks: [headline(bad, warn, counts, here.some(h => h.collection) ? 'Completed work is still being collected.' : 'Nothing needs you.', here.some(h => h.collection) && st.tone === 'ok' ? 'warn' : st.tone)] },
    { id: `box-${b.id}`, blocks: [
      { type: 'panel', rows: [
        { label: 'State', value: st.value, ...(st.detail ? { detail: st.detail } : {}), tone: st.tone },
        machineRow(b),
        ...(b.lastSeen || b.local ? runtimePanelRows(env, b, nowMs, may) : []),
        ...harnessPanelRows(s, b, nowMs, may),
        // When it last came back, and its units failing (watch.mjs).
        ...watchRowsOf(env, b.id, nowMs),
        // Whether silence is an alert, and whether it hosts anything: the owner's (control.mjs, setBoxWatch).
        ...watchControlRows(b),
      ] },
      here.length
        ? { type: 'panel', title: `Houses on ${b.label}`, rows: here.slice(0, 30).map((h) => housePanelRow(s, h, nowMs)) }
        : { type: 'text', tone: 'muted', text: 'No houses on it now.' },
      ...(b.local ? [] : [boxSettingsPanel(b)]),
    ] },
  ] };
}

const short7 = (c) => (c ? c.slice(0, 7) : '?');
/** When, from now: "in 5h", "in 20m", "any moment". */
const inTime = (iso, nowMs = Date.now()) => {
  const s = Math.round((Date.parse(iso) - nowMs) / 1000);
  if (!Number.isFinite(s) || s < 60) return 'any moment';
  if (s < 5400) return `in ${Math.round(s / 60)}m`;
  return `in ${Math.round(s / 3600)}h`;
};

/** Which runtime a box runs and loom's, for whoever asks. */
const versionsSheet = (b, mine, loomC) => ({ title: `${b.label}'s runtime`, blocks: [{ type: 'kv', items: [
  { label: 'This box', value: mine ? short7(mine) : (b.local ? 'loom\'s own' : 'too old to say') },
  { label: 'loom', value: loomC ? short7(loomC) : 'unknown (a dev checkout)' },
  ...(b.runtime?.piece ? [{ label: 'Piece', value: b.runtime.piece }] : []),
] }] });

/**
 * A box's runtime against loom's (version.mjs), as panel rows: up to date; updating…; why the last try failed and when
 * it tries again, with "Update now"; or on the old box piece (its sheet: the one command to run on it). The commits are
 * a tap away, never on the row.
 */
function runtimePanelRows(env, b, nowMs, may = true) {
  const loomC = ownCommit();
  const rt = b.runtime ?? {};
  const mine = rt.commit;
  const now = may ? { action: 'box-update-now', label: 'Update now', fields: { name: b.id } } : null;
  const sheet = versionsSheet(b, mine, loomC);
  // loom's commit is ownCommit() alone, what it tells boxes to run: a dev checkout has none, so nothing to compare or press.
  if (!loomC) return [{ label: 'Runtime', value: 'Can\'t compare: loom\'s version is unknown', tone: 'muted', sheet }];
  if (b.local && !mine) return [{ label: 'Runtime', value: 'loom\'s own', tone: 'ok', sheet }];
  if (!mine) {
    return [{ label: 'Runtime', value: 'On the old box piece', detail: `It can't update itself: run one command on ${b.label}`, tone: 'warn',
      sheet: { title: 'Move it to the runtime piece', blocks: [
        { type: 'callout', tone: 'warn', title: 'This box is on the old box piece',
          text: `It can't update itself to the runtime piece: the two can't be installed side by side, and its version is older than the swap. Run this once on ${b.label}. It keeps its settings, data and houses (docs/upgrading.md).` },
        { type: 'code', label: `on ${b.label}`, text: swapCommand(loomC) }] } }];
  }
  if (mine === loomC) return [{ label: 'Runtime', value: 'Up to date', tone: 'ok', sheet }];
  const u = rt.upgrade?.commit === loomC ? rt.upgrade : null;
  if (u && (u.state === 'failed' || u.state === 'refused')) {
    return [{ label: 'Runtime', value: 'The update didn\'t work', detail: `${u.error ?? 'No reason given'}${u.retryAt ? ` · tries again ${inTime(u.retryAt, nowMs)}` : ''}`, tone: 'bad',
      ...(now ? { act: { ...now, tone: 'primary' } } : { sheet }) },
    ...(u.detail ? [{ label: 'What the install said', value: 'Its last lines', tone: 'muted', sheet: { title: 'What the install said', blocks: [{ type: 'code', text: u.detail }] } }] : [])];
  }
  if (u?.state === 'rolling-back') return [{ label: 'Runtime', value: `Putting the ${rt.piece ?? 'old'} piece back`, detail: u.error ? `The update didn't work: ${u.error}` : 'The update didn\'t work', tone: 'bad', sheet }];
  const swap = rt.piece && rt.piece !== 'runtime' ? `Swapping its ${rt.piece} piece for runtime` : undefined;
  // Updating, or about to (it tries on its next poll): the button only once it's been a while.
  const since = u?.at ? nowMs - Date.parse(u.at) : Infinity;
  const stuck = now && since > 10 * 60_000 && !(u && ['removing', 'installing'].includes(u.state));
  return [{ label: 'Runtime', value: 'Updating…', ...(swap ? { detail: swap } : {}), tone: 'warn', ...(stuck ? { act: now } : { sheet }) }];
}

/** How a login reads: "claude.ai, Max". */
const loginWords = (st) => [st?.method, st?.plan ? st.plan.charAt(0).toUpperCase() + st.plan.slice(1) : null].filter(Boolean)
  .map((w) => (w === 'chatgpt' ? 'ChatGPT' : w === 'api-key' ? 'API key' : w)).join(', ');

/**
 * Each harness on a box, as a panel row: not reported yet, not installed, unhealthy, signing in (its page), logged
 * in (how, and its plan; "Log in again"), or not (a "Log in" button; after a failed try, why, and "Try again").
 */
function harnessPanelRows(s, b, nowMs, may = true) {
  const rows = [];
  for (const [h, def] of Object.entries(LOGIN_HARNESSES)) {
    const st = b.harnesses?.[h];
    if (!st) { rows.push({ label: def.label, value: 'Not reported yet', tone: 'muted' }); continue; }
    if (!st.installed) { rows.push({ label: def.label, value: st.unhealthy ? 'Can\'t sign in here' : 'Not installed', detail: st.unhealthy ? st.unhealthy : `${def.bin} isn't installed on ${b.label}`, tone: 'muted' }); continue; }
    if (st.unhealthy) { rows.push({ label: def.label, value: 'Not used', detail: `Its login folder has something in it that shouldn't be (${st.unhealthy})`, tone: 'bad' }); continue; }
    const mine = Object.values(s.logins ?? {}).filter((l) => l.box === b.id && l.harness === h).sort((x, y) => Date.parse(y.created) - Date.parse(x.created));
    const under = mine.find((l) => !['done', 'failed'].includes(l.state));
    const start = { action: 'login-start', fields: { box: b.id, harness: h } };
    if (under) { rows.push({ label: def.label, value: 'Signing in…', tone: 'warn', ...(may ? { page: `login/${under.id}` } : {}) }); continue; }
    const expiry = loginExpiry(st, nowMs);
    if (st.loggedIn && expiry) {
      rows.push({ label: def.label, value: expiry.expired ? 'Login expired' : `Login ends in ${expiry.days} day${expiry.days === 1 ? '' : 's'}`,
        detail: [loginWords(st), 'Renew this login to keep running'].filter(Boolean).join('; '), tone: expiry.severity,
        ...(may ? { act: { ...start, label: 'Renew login', tone: 'primary' } } : {}) });
      continue;
    }
    if (st.loggedIn) { rows.push({ label: def.label, value: 'Logged in', ...(loginWords(st) ? { detail: loginWords(st) } : {}), tone: 'ok', ...(may ? { act: { ...start, label: 'Log in again' } } : {}) }); continue; }
    const lastFail = mine[0]?.state === 'failed' ? mine[0] : null;
    rows.push({ label: def.label, value: 'Not logged in', detail: lastFail ? `Last try: ${lastFail.error}` : 'Installed; nobody has signed in yet', tone: lastFail ? 'bad' : 'warn',
      ...(may ? { act: { ...start, label: lastFail ? 'Try again' : `Log in ${def.label}`, tone: 'primary' } } : lastFail ? {} : {}) });
  }
  return rows;
}

/** A usage window's name in words: "5h" -> "5-hour window", "7d" -> "week". */
const windowWords = (k) => (k === '7d' ? 'week' : /^\d+h$/.test(k) ? `${k.slice(0, -1)}-hour window` : /^\d+d$/.test(k) ? `${k.slice(0, -1)}-day window` : k.replace(/_/g, ' '));

/**
 * Model logins (docs/model-accounts.md): the accounts the boxes' logins make, each a row with how full it is in words
 * and its windows as meters a tap away. Each box's harnesses are on its own page (harnessPanelRows).
 */
function loginsSection(env, s, boxes, nowMs, rows) {
  void rows;
  let accounts = [];
  try { accounts = stateAccounts(env, { now: () => nowMs }).list().accounts; } catch { accounts = []; }
  const pct = (v) => `${Math.round(v * 100)}%`;
  const reported = boxes.some((b) => b.harnesses && Object.keys(b.harnesses).length);
  return { id: 'logins', title: 'Model logins', blocks: [
    ...(accounts.length ? [{ type: 'panel', rows: accounts.map((a) => {
      const w = Object.entries(a.usage).filter(([k, v]) => !k.startsWith('reset_') && k !== 'checked' && typeof v === 'number');
      const top = w.reduce((m, [, v]) => Math.max(m, v), 0);
      const on = a.boxes.map((id) => boxLabelOf(s, id));
      return { label: a.label, value: w.length ? w.map(([k, v]) => `${pct(v)} of the ${windowWords(k)}`).join(', ') : 'Usage not read yet',
        detail: [on.length ? `On ${andList(on)}` : '', a.agents.length ? `for ${andList(a.agents.map(who))}` : 'for no agent'].filter(Boolean).join(', '),
        tone: !w.length ? 'muted' : top >= 0.95 ? 'bad' : top >= 0.8 ? 'warn' : 'ok',
        ...(w.length ? { sheet: { title: a.label, blocks: [{ type: 'meter', items: w.map(([k, v]) => ({ label: cap(windowWords(k)), value: Math.max(0, Math.min(1, v)), detail: pct(v), ...(v >= 0.95 ? { tone: 'bad' } : v >= 0.8 ? { tone: 'warn' } : {}) })) }] } } : {}) };
    }) }] : [{ type: 'text', tone: 'muted', text: reported ? 'No account has reported its usage yet.' : 'No box has reported its harnesses yet.' }]),
    { type: 'text', tone: 'muted', text: 'Each box signs in to Claude and Codex itself, with its owner\'s own subscription: Log in, on its page, runs the CLI\'s own login on that box. loom never sees the login.' },
  ] };
}

/**
 * Work roles (models.mjs, t-2036): the kinds of work an agent can hand off, each with the models eligible for it, the
 * household owner's to add, change and remove here (`loom runtime roles set` does the same). The form carries the
 * catalog's version: an edit made against an older catalog is refused, as the grants' rev is, so two editors never
 * silently overwrite each other. A role never widens what an agent may use (an agent's allow still applies).
 */
function roleFields(list, r = null) {
  const csv = (a) => (a ?? []).join(',');
  return [
    ...(r ? [] : [{ name: 'id', label: 'Name', kind: 'text', required: true, hint: 'Lowercase, like coding, review or light-task' }]),
    { name: 'description', label: 'What it\'s for', kind: 'textarea', required: true, ...(r ? { value: r.description } : {}), hint: 'One or two sentences an agent reads to choose it' },
    { name: 'models', label: 'Models', kind: 'checks', options: list.map((m) => ({ value: m.id, label: m.id, detail: `${m.family}, on ${HARNESS_WORDS[m.harness] ?? m.harness}` })), ...(r?.models?.length ? { value: csv(r.models) } : {}) },
    { name: 'families', label: 'Or any model of', kind: 'text', ...(r?.families?.length ? { value: r.families.join(', ') } : {}), hint: 'Optional: anthropic, openai, google, mistral or local:<name>' },
    { name: 'needs', label: 'Needs', kind: 'text', ...(r?.needs ? { value: r.needs } : {}), hint: 'Optional, e.g. a GPU, or a long context' },
    { name: 'failover', label: 'If its model runs out', kind: 'choice', value: r?.failover ? 'yes' : 'no', options: [
      { value: 'no', label: 'Wait for it', detail: 'The job keeps its model and waits for quota' },
      { value: 'yes', label: 'Move once', detail: 'The job moves once to another eligible model with room' }] },
    { name: 'why', label: 'Why', kind: 'text', hint: 'Optional: kept in the change log' },
  ];
}

function rolesSection(env) {
  let st, cat;
  try { st = load(env); cat = rolesOf(st); } catch { return { id: 'roles', title: 'Work roles', blocks: [{ type: 'text', tone: 'muted', text: 'The roles can\'t be read just now.' }] }; }
  const { list } = modelsOf(st);
  const hidden = { version: String(cat.version) };
  const rows = cat.roles.map((r) => ({ label: r.id, value: r.eligible.length ? r.eligible.join(', ') : 'No model in the list fits it',
    detail: r.description, tone: r.eligible.length ? 'ok' : 'warn',
    edit: { title: `Change ${r.id}`, action: 'role-set', submit: 'Save', hidden: { ...hidden, id: r.id }, fields: roleFields(list, r) },
    act: { action: 'role-remove', label: 'Remove', fields: { ...hidden, id: r.id }, confirm: `Remove the ${r.id} role? A job already running keeps it; new jobs can't ask for it.` } }));
  rows.push({ label: 'A role', value: 'Add a kind of work agents can hand off', tone: 'muted',
    edit: { title: 'Add a role', action: 'role-set', submit: 'Add', hidden, fields: roleFields(list) } });
  const last = cat.changed ? ` Last change: ${cat.changed.what}${cat.changed.why ? ` (${cat.changed.why})` : ''}, by ${cat.changed.by}.` : '';
  return { id: 'roles', title: 'Work roles', blocks: [{ type: 'panel', rows },
    { type: 'text', tone: 'muted', text: `Agents read these when they hand off a job, and the runtime picks a model from the role's. An agent's own model limits still apply.${last}` }] };
}

/** A role from the page's form fields, or a message saying what's wrong. */
function roleFromFields(f) {
  const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const out = { id: String(f.id ?? '').trim(), description: String(f.description ?? '') };
  const models = list(f.models), families = list(f.families);
  if (models.length) out.models = models;
  if (families.length) out.families = families;
  if (String(f.needs ?? '').trim()) out.needs = String(f.needs);
  out.failover = f.failover === 'yes';
  return out;
}

/**
 * One login, start to finish, without a reload: while the box is starting the CLI, checking a pasted code, or
 * waiting for a device sign-in, the page says so beside a spinner (a busy callout) and reloads itself (refresh:
 * loom core's page vocabulary), then flips to "✓ Claude logged in (claude.ai, Max)", or to why it didn't and "Try again".
 */
function loginPage(env, id, nowMs = Date.now()) {
  const seen = loginView(env, id);
  // A page changes nothing: a login loom would give up on its next look (its box went quiet) reads as failed now.
  const over = seen ? loginOver(load(env), seen, nowMs) : null;
  const l = over ? { ...seen, state: 'failed', error: over, link: undefined } : seen;
  if (!l) return { title: 'Not found', sections: [{ id: 'gone', blocks: [{ type: 'text', tone: 'muted', text: 'That sign-in is gone (finished ones go after 20 minutes).' }, { type: 'link', text: 'Back to Boxes', page: '' }] }] };
  const s = load(env);
  const def = LOGIN_HARNESSES[l.harness];
  const who = def.provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  const where = boxLabelOf(s, l.box);
  const box = s.boxes[l.box] ?? {};
  const blocks = [];
  let refresh;
  const busy = (title, text) => blocks.push({ type: 'callout', busy: true, title, text });
  if (l.state === 'wanted') {
    const quiet = box.lastSeen && !box.local && nowMs - Date.parse(box.lastSeen) > 60_000;
    busy(quiet ? `Waiting for ${where} to pick it up…` : `Starting ${def.label}'s sign-in on ${where}…`,
      quiet ? `${where} was last seen ${ago(box.lastSeen, nowMs)}. It starts ${def.bin}'s own login on its next poll.` : 'Its link shows here in a few seconds.');
    refresh = 2;
  } else if (l.state === 'starting') {
    busy(`Starting ${def.label}'s sign-in on ${where}…`, `${where} is running ${def.bin}'s own login. Its link shows here in a few seconds.`);
    refresh = 2;
  } else if (l.state === 'checking') {
    busy(`Checking with ${who}…`, `${where}'s ${def.bin} is finishing the sign-in with your code. This page updates by itself.`);
    refresh = 2;
  } else if (l.state === 'cancel') {
    busy('Cancelling…', `${where} is stopping the sign-in.`);
    refresh = 2;
  } else if (l.state === 'waiting') {
    if (l.kind === 'paste-code') {
      blocks.push({ type: 'text', text: `Open ${who}'s sign-in page and sign in, then paste the code it shows here.` });
      blocks.push({ type: 'link', text: `Open ${who}'s sign-in page`, href: l.link });
      blocks.push({ type: 'form', action: 'login-code', submit: 'Finish', hidden: { id }, note: `It goes to ${def.bin} on ${where}, once. This page then shows how it went.`,
        fields: [{ name: 'code', label: 'Code', kind: 'secret', required: true }] });
      // Slowly, to catch a sign-in that timed out: loom never reloads while the code field is in use, and an
      // unchanged page costs a 304.
      refresh = 10;
    } else {
      if (l.userCode) blocks.push({ type: 'code', label: 'Code to enter', text: l.userCode });
      blocks.push({ type: 'link', text: `Open ${who}'s device page`, href: l.link });
      busy(`Waiting for you to enter the code at ${who}…`, `${where} sees the login by itself once you have, and this page updates when it does.`);
      refresh = 3;
    }
  } else if (l.state === 'done') {
    const how = loginWords(l) || loginWords(box.harnesses?.[l.harness]);
    blocks.push({ type: 'callout', tone: 'ok', title: `✓ ${def.label} logged in${how ? ` (${how})` : ''}`,
      text: `${where} is signed in. Its own ${def.bin} keeps the login and refreshes it; houses there that ask for it use it.` });
  } else {
    blocks.push({ type: 'callout', tone: 'bad', title: `${def.label} didn't log in`, text: l.error || 'It ended without saying why.' });
    if (l.detail || Number.isInteger(l.exit)) {
      blocks.push({ type: 'details', summary: `What ${def.bin} said`, meta: Number.isInteger(l.exit) ? `exit ${l.exit}` : '', blocks: [
        ...(l.detail ? [{ type: 'code', text: l.detail }] : []), ...(Number.isInteger(l.exit) ? [{ type: 'text', tone: 'muted', text: `It exited with status ${l.exit}.` }] : [])] });
    }
    blocks.push({ type: 'buttons', items: [{ action: 'login-start', label: 'Try again', tone: 'primary', fields: { box: l.box, harness: l.harness } }] });
  }
  if (!['done', 'failed', 'cancel'].includes(l.state)) blocks.push({ type: 'buttons', items: [{ action: 'login-cancel', label: 'Cancel', tone: 'danger', fields: { id } }] });
  blocks.push({ type: 'link', text: 'Back to Boxes', page: '' });
  return { title: `Log ${where} in to ${def.label}`, sections: [{ id: 'login', title: 'Sign-in', blocks }], ...(refresh ? { refresh } : {}) };
}

/** One box session: how it is, and its link once it has one. */
function sessionBlocks(r) {
  return [
    { type: 'kv', items: [
      { label: 'Session', value: r.name },
      { label: 'State', value: r.state + (r.error ? ` (${r.error})` : '') },
      { label: 'Folder', value: r.dir },
    ] },
    ...(r.url ? [{ type: 'link', text: `Open "${r.name}" in claude.ai/code`, href: r.url }] : []),
  ];
}

function sessionControls(env, s, a, r) {
  const boxes = Object.entries(s.boxes).filter(([, b]) => !b.revoked).map(([n]) => n);
  if (r?.want === 'up') {
    return [...sessionBlocks(r), { type: 'buttons', items: [{ action: 'remote-down', label: 'Take the box session down', tone: 'danger', fields: { agent: a } }] }];
  }
  return [{ type: 'form', title: 'Box session', action: 'remote-up', submit: 'Bring it up', hidden: { agent: a },
    note: `Claude's remote-control on the box itself, not in a house, with permissions bypassed: for work that needs the machine. Named "${a} on <box> (box session)".`,
    fields: [
      { name: 'box', label: 'Box', kind: 'choice', value: r?.box ?? primaryOf(s, a, env), options: boxes.map((n) => ({ value: n, label: boxLabelOf(s, n) })) },
      { name: 'dir', label: 'Folder on the box', kind: 'text', required: true, ...(r?.dir ? { value: r.dir } : {}), hint: 'Where it works, e.g. /home/art/Art' },
    ] }];
}

/** A service by what it is: "Discord bridge", "House session", "jobs". */
const serviceWords = (name) => (name === 'remote' ? 'House session' : BRIDGE.test(name) ? `${cap(name)} bridge` : cap(name.replace(/-/g, ' ')));
/** A service's state in words. */
function serviceState(v, nameOf) {
  if (v.want !== 'up') return { value: 'Down', detail: 'Taken down', tone: 'muted' };
  const where = v.moveTo ? `Moving from ${nameOf(v.box)} to ${nameOf(v.moveTo)}` : `On ${nameOf(v.box)}`;
  const restarts = v.restarts ? ` · ${plural(v.restarts, 'restart')}` : '';
  const st = v.state ?? 'no house yet';
  const word = { running: 'Running', starting: 'Starting', wanted: 'Waiting for a box', stopping: 'Stopping', failed: 'Failed', lost: 'Lost' }[st] ?? cap(st);
  return { value: word, detail: `${where}${restarts}`, tone: st === 'running' ? 'ok' : st === 'failed' || st === 'lost' ? 'bad' : 'warn' };
}

/**
 * One agent's Houses tab (loom docs/extensions.md, agentTab): how its houses are in a line, its houses, its services,
 * its sessions, a house to start; and, for a household owner, how its house is made and its primary box. An agent
 * owner gets the houses and services of an agent of theirs, as on their own page.
 */
function modelChoiceBlocks(env, agent, caller) {
  const choice = ownerModelChoice(env, caller, { agent });
  return [{ type: 'form', action: 'model-choice', submit: 'Save model', hidden: { agent },
    note: 'Used for new turns. If this model has no quota, another available model can answer.',
    fields: [{ name: 'harness', label: 'Model', kind: 'segmented', value: choice.agentChoice,
      options: [{ value: 'auto', label: 'Auto' }, { value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }] }] }];
}

function agentTabPage(env, agent, caller, nowMs) {
  const s = load(env);
  const own = Array.isArray(caller.agents) ? caller.agents : null;
  if (!s.agents[agent] || (own && !own.includes(agent))) return { title: 'Houses', sections: [{ id: 'none', blocks: [{ type: 'text', tone: 'muted', text: `${who(agent)} has no house yet.${own ? '' : ' Give it one on the Boxes page.'}` }] }] };
  const view = list(env, caller);
  const houses = view.houses.filter((h) => h.agent === agent);
  const live = houses.filter((h) => LIVE.has(h.state));
  const nameOf = (id) => boxLabelOf(s, id);
  const live_boxes = view.boxes.filter((b) => !b.revoked).map((b) => ({ ...b, label: boxLabelOf(s, b.id) }));
  const svcs = view.services.filter((v) => v.agent === agent);
  const svcUp = svcs.filter((v) => v.want === 'up');
  const svcDown = svcUp.filter((v) => v.state === 'failed' || v.state === 'lost');
  const running = live.filter((h) => h.state === 'running' && !h.collection).length;
  const draining = live.filter((h) => h.draining && h.state === 'running' && !h.collection).length;
  const counts = `${plural(running, 'house')} running · ${plural(svcUp.length, 'service')} up`;
  const sections = [{ id: 'model', title: 'Model', blocks: modelChoiceBlocks(env, agent, caller) }, { id: 'houses', title: 'Houses', blocks: [
    { type: 'health', tone: svcDown.length ? 'bad' : draining || live.length > running ? 'warn' : live.length ? 'ok' : 'muted',
      text: svcDown.length ? `${andList(svcDown.map((v) => serviceWords(v.name)))} ${svcDown.length === 1 ? 'is' : 'are'} down` : counts,
      detail: svcDown.length ? counts : [draining ? `${plural(draining, 'house')} draining to a newer image` : '', houseProgress(live)].filter(Boolean).join(' · ') || (live.length ? 'All running.' : 'Nothing running now.') },
    live.length
      ? { type: 'panel', rows: live.slice(0, 30).map((h) => housePanelRow(s, h, nowMs,
        !h.collection && (h.state === 'wanted' || h.state === 'running' || h.state === 'starting') ? { detail: `On ${nameOf(h.box)}`, act: { action: 'down', label: 'Stop', tone: 'danger', fields: { id: h.id }, confirm: 'This house stops.' } } : { detail: `On ${nameOf(h.box)}` })) }
      : { type: 'text', tone: 'muted', text: 'No houses up now.' },
    ...(houses.length > live.length ? [{ type: 'details', summary: 'Recent', meta: String(houses.length - live.length), blocks: [{ type: 'table', columns: ['House', 'Box', 'State', 'Updated'],
      rows: houses.filter((h) => !LIVE.has(h.state)).slice(0, 20).map((h) => [short(houseName(h, s)), nameOf(h.box), houseWords(h) + (h.exit !== undefined ? ` (exit ${h.exit})` : ''), ago(h.updated, nowMs)]) }] }] : []),
  ] }];
  if (svcs.length) {
    sections.push({ id: 'services', title: 'Services', blocks: [
      { type: 'panel', rows: svcs.map((v) => ({
        label: serviceWords(v.name), ...serviceState(v, nameOf),
        act: v.want === 'up'
          ? { action: 'service-restart', label: 'Restart', ...(v.state === 'failed' || v.state === 'lost' ? { tone: 'primary' } : {}), fields: { agent: v.agent, name: v.name } }
          : { action: 'service-up', label: 'Up', tone: 'primary', fields: { agent: v.agent, name: v.name } },
      })) },
      ...(svcUp.length ? [{ type: 'details', summary: 'Move or take down', blocks: [{ type: 'panel', rows: svcUp.slice(0, 12).flatMap((v) => [
        ...(own || live_boxes.length < 2 ? [] : [{ label: `Move ${serviceWords(v.name)}`, value: `On ${nameOf(v.box)}`,
          edit: { title: `Move ${serviceWords(v.name)}`, action: 'service-move', submit: 'Hand it off', hidden: { agent: v.agent, name: v.name },
            note: 'Stopped where it is, then started there: never two at once.',
            fields: [{ name: 'box', label: 'To', kind: 'choice', required: true, options: live_boxes.filter((b) => b.id !== v.box).map((b) => ({ value: b.id, label: b.label })) }] } }]),
        { label: `Take ${serviceWords(v.name)} down`, value: 'It stays down until you bring it up',
          act: { action: 'service-down', label: 'Take down', tone: 'danger', confirm: `${serviceWords(v.name)} stops, and stays down until you bring it up.`, fields: { agent: v.agent, name: v.name } } },
      ]) }] }] : []),
    ] });
  }
  if (!own) {
    const sess = sessionsSection(env, s, view, agent);
    if (sess) sections.push(sess);
  }
  sections.push({ id: 'up', title: 'Start a house', blocks: [{ type: 'panel', rows: [{ label: 'A house for a task', value: `On ${nameOf(primaryOf(s, agent, env))}, its primary, or a box with what it needs`,
    edit: { title: `Start a house for ${who(agent)}`, action: 'up', submit: 'Start it', hidden: { agent }, fields: [
      { name: 'task', label: 'Task', kind: 'textarea', required: true },
      { name: 'box', label: 'Box', kind: 'choice', value: '', options: [{ value: '', label: `Its primary (${nameOf(primaryOf(s, agent, env))}), or the one box that has what it needs` },
        ...live_boxes.map((b) => ({ value: b.id, label: b.label }))] },
      { name: 'needs', label: 'Needs', kind: 'text', hint: 'Optional, e.g. gpu:5090. A box that has it, and may host the agent.' },
    ] } }] }] });
  if (!own) {
    const c = s.agents[agent];
    const primary = primaryOf(s, agent, env, nowMs);
    const pref = preferenceOf(s, agent, env);
    const boxOpts = live_boxes.map((b) => ({ value: b.id, label: b.label }));
    const secrets = Object.entries(c.secrets || {});
    const repo = String(c.repo ?? '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    sections.push({ id: `agent-${agent}`, title: 'Its house', side: true, blocks: [{ type: 'panel', rows: [
      // Its boxes in order (t-2048): bodies and houses go to the first that's up and may host it.
      { label: 'Boxes, in order', value: pref.map(nameOf).join(', then '),
        detail: pref.length > 1 && primary !== pref[0] ? `${nameOf(pref[0])} is down: it runs on ${nameOf(primary)} for now` : `Runs on ${nameOf(primary)}; the next box takes over when it's down`,
        ...(boxOpts.length >= 2 ? { edit: { title: `${who(agent)}'s boxes, in order`, action: 'set-primary', submit: 'Save', hidden: { agent },
          fields: ['first', 'second', 'third'].map((name, i) => ({ name, label: i ? 'Then' : 'First', kind: 'choice', value: pref[i] ?? '',
            options: [...(i ? [{ value: '', label: 'None' }] : []), ...boxOpts] })) } } : {}) },
      { label: 'Repo', value: repo || 'none', detail: `${c.houseFile || 'house/house.json'}${c.branch ? ` on ${c.branch}` : ''}`, sheet: { title: `${who(agent)}'s house`, blocks: [{ type: 'kv', items: houseFacts(c) }] } },
      { label: 'Nested containers', value: c.nested ? 'Allowed' : 'Not allowed', toggle: { action: 'agent-flag', on: !!c.nested, fields: { agent, flag: 'nested' } } },
      { label: 'GPU', value: c.gpu ? 'Allowed' : 'Not allowed', toggle: { action: 'agent-flag', on: !!c.gpu, fields: { agent, flag: 'gpu' } } },
      { label: 'Secrets', value: secrets.length ? plural(secrets.length, 'secret') : 'None', ...(secrets.length ? { sheet: { title: 'Secrets a house gets', blocks: [{ type: 'list', wrap: true, items: secrets.map(([k, v]) => ({ text: k, ...(k === v ? {} : { meta: `from ${v}` }) })) }] } } : {}) },
      { label: 'Ports and tailnets', value: [(c.ports ?? []).length ? (c.ports ?? []).map((g) => `${g.ip}:${g.port}`).join(', ') : '', (c.tailnets ?? []).map((g) => g.name).join(', ')].filter(Boolean).join(' · ') || 'None' },
      { label: 'Everything else', value: 'Repo, branch, secrets, ports', edit: { ...agentEdit(agent, c), title: `Change ${who(agent)}'s house` } },
    ] }] });
  }
  return { title: 'Houses', intro: `${who(agent)}'s houses: its containers, started for a task or kept up as a service.`, sections };
}

function houseFacts(c) {
  return [
    { label: 'Repo', value: c.repo }, { label: 'House file', value: c.houseFile || 'house/house.json' },
    { label: 'Nested containers', value: c.nested ? 'allowed' : 'not allowed' },
    { label: 'GPU', value: c.gpu ? 'allowed' : 'not allowed' },
    { label: 'Ports it may publish', value: (c.ports ?? []).map((g) => `${g.ip}:${g.port}`).join(', ') || 'none' },
    { label: 'Tailnets', value: (c.tailnets ?? []).map((g) => g.name).join(', ') || 'none' },
    { label: 'Branch', value: c.branch || 'default' }, { label: 'Repo secret', value: c.repoSecret || 'none' },
    { label: 'Secrets a house gets', value: Object.entries(c.secrets || {}).map(([k, v]) => (k === v ? k : `${k} (from ${v})`)).join(', ') || 'none' },
    { label: 'Only for', value: Object.entries(c.scopes || {}).map(([k, v]) => `${k}: ${v.split('+').map((w) => (w === 'owner' ? 'your own work' : w.startsWith('service:') ? `the ${w.slice(8)} service` : `the ${w} project`)).join(', ')}`).join('; ') || 'every house gets everything' },
    { label: 'Who steers which project', value: Object.entries(c.steers || {}).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') || 'only you' },
  ];
}

function agentsPage(env) {
  // Each agent's house is on its own Houses tab; here, a link each and a house for a new one.
  const s = load(env);
  const agents = Object.keys(s.agents).sort();
  return { title: 'Agents\' houses', intro: 'How each agent\'s house is made is on its own Houses tab.', sections: [
    ...(agents.length ? [{ id: 'agents', blocks: [{ type: 'list', items: agents.map((a) => ({ text: a, agent: a, page: `agent:${a}`, meta: s.agents[a].repo })) }] }] : []),
    { id: 'new', title: 'Give an agent a house', blocks: [agentForm('', null)] }] };
}

/** The agent form as a panel row's edit sheet. */
function agentEdit(agent, c) {
  const f = agentForm(agent, c);
  return { action: f.action, submit: f.submit, fields: f.fields, ...(f.hidden ? { hidden: f.hidden } : {}) };
}

function agentForm(agent, c) {
  return { type: 'form', title: agent ? `Change ${agent}'s house` : undefined, action: 'set-agent', submit: 'Save', ...(agent ? { hidden: { agent } } : {}), fields: [
    ...(agent ? [] : [{ name: 'agent', label: 'Agent', kind: 'text', required: true }]),
    { name: 'repo', label: 'Repo', kind: 'text', required: true, value: c?.repo ?? '' },
    { name: 'house_file', label: 'House file', kind: 'text', value: c?.houseFile ?? 'house/house.json', hint: 'A path in the repo: the image, and where each secret lands' },
    { name: 'nested', label: 'Nested containers', kind: 'choice', value: c?.nested ? 'yes' : 'no', options: [{ value: 'no', label: 'Not allowed' }, { value: 'yes', label: 'Allowed', detail: 'The house may run containers of its own (more capabilities, still rootless)' }] },
    { name: 'gpu', label: 'GPU', kind: 'choice', value: c?.gpu ? 'yes' : 'no', options: [{ value: 'no', label: 'Not allowed' }, { value: 'yes', label: 'Allowed', detail: 'A house asked for with a GPU need gets the box\'s GPU (NVIDIA, through CDI)' }] },
    { name: 'ports', label: 'Ports', kind: 'text', value: (c?.ports ?? []).map((g) => `${g.ip}:${g.port}`).join(', '), hint: 'Ports a house may publish on its box: 7401 binds loopback, 0.0.0.0:7401 every interface' },
    // Saving replaces the whole record, so every grant is on the form (a missing one would be dropped).
    { name: 'tailnets', label: 'Tailnets', kind: 'text', value: (c?.tailnets ?? []).map((g) => `${g.name}=${g.socket}`).join(', '), hint: 'name=/run/…/tailscaled.sock, comma separated: a box tailscaled the house may use' },
    { name: 'logins', label: 'Box logins', kind: 'text', value: Array.isArray(c?.logins) ? (c.logins.join(', ') || 'none') : 'default', hint: 'claude, codex, none, or default (a household owner\'s own agent gets both): which of a box\'s logins its houses may have, on boxes its owner owns. A house can read the login it\'s given.' },
    { name: 'branch', label: 'Branch', kind: 'text', value: c?.branch ?? '' },
    { name: 'repo_secret', label: 'Repo secret', kind: 'text', value: c?.repoSecret ?? '', hint: 'A secrets-store name, for a private repo over https' },
    { name: 'secrets', label: 'Secrets', kind: 'text', value: Object.entries(c?.secrets || {}).map(([k, v]) => `${k}=${v}`).join(', '), hint: 'name-in-house=store-name, comma separated' },
    // t-1963: who gets what. Blank keeps them as they are; none clears them.
    { name: 'scopes', label: 'Only for', kind: 'text', value: Object.entries(c?.scopes || {}).map(([k, v]) => `${k}=${v}`).join(', '), hint: 'secret=owner (only your own work), secret=pond or tailnet:fleet=pond (your work and that of people you let steer pond), +service:discord for that service too; comma separated. Left blank, nothing changes; none clears them' },
    { name: 'steers', label: 'Who steers which project', kind: 'text', value: Object.entries(c?.steers || {}).map(([k, v]) => `${k}=${v.join('+')}`).join(', '), hint: 'person=project, like patrick=pond: their work gets that project\'s secrets and tailnets. Left blank, nothing changes; none clears them' },
  ].map((f) => (f.value === '' ? (({ value: _v, ...r }) => r)(f) : f)) };
}

/**
 * Who's on the page (loom's caller, docs/specs/owners.md in loom): the owner, as before, unless
 * loom names an agent owner, who gets their agents' houses and services and nothing of the household's.
 */
function pageCaller(caller) {
  if (caller && caller.kind === 'owner' && Array.isArray(caller.agents)) {
    return { kind: 'owner', who: typeof caller.who === 'string' ? caller.who : undefined, agents: caller.agents.filter((a) => typeof a === 'string') };
  }
  return caller && caller.kind === 'owner' && typeof caller.who === 'string' ? { ...OWNER, who: caller.who } : OWNER;
}

/** An agent owner's page: their agents' houses and services, each with what they may do to it. */
function agentOwnerPage(env, caller, nowMs) {
  const view = list(env, caller);
  const live = view.houses.filter((h) => LIVE.has(h.state));
  const sections = [{ id: 'houses', title: 'Houses', blocks: [live.length
    ? { type: 'list', items: live.slice(0, 30).map((h) => ({ text: short(houseName(h)), meta: h.collection ? houseWords(h) : h.state, badge: houseBadge(h), tone: houseTone(h), agent: h.agent,
      ...(!h.collection && (h.state === 'wanted' || h.state === 'running' || h.state === 'starting') ? { act: { action: 'down', label: 'Stop', tone: 'danger', fields: { id: h.id }, confirm: 'This house stops.' } } : {}) })) }
    : { type: 'text', tone: 'muted', text: `No houses for ${caller.agents.join(', ')} now.` }] }];
  if (view.services.length) {
    sections.push({ id: 'services', title: 'Services', blocks: [{ type: 'list', items: view.services.slice(0, 20).map((v) => ({
      text: `${v.agent}'s ${v.name}`, meta: `${v.want} · ${v.state ?? 'no house'}`, agent: v.agent,
      act: { action: 'service-restart', label: 'Restart', fields: { agent: v.agent, name: v.name } } })) }] });
  }
  sections.push({ id: 'theirs', blocks: [{ type: 'text', tone: 'muted', text: 'Boxes, and how each agent\'s house is made, are the household owner\'s.' }] });
  void nowMs;
  return { title: 'Houses', sections };
}

/** A box's own page: box/<its id>. */
const BOX_PAGE = new RegExp(`^box/${BOX_NAME.source.slice(1, -1)}$`); // a box's id or, from before ids, its name (state.mjs, BOX_NAME)

export function page(env, { path, caller: c }, nowMs = Date.now()) {
  const caller = pageCaller(c);
  const scope = scopeOf(env);
  // A box's login and its own page are the household owner's, the way their actions are: never an agent's tab or an agent owner's page.
  if (typeof path === 'string' && (path.startsWith('login/') || path.startsWith('box/')) && (scope || Array.isArray(caller.agents))) {
    return { status: 403, title: 'Not allowed', sections: [{ id: 'no', blocks: [{ type: 'text', tone: 'muted', text: path.startsWith('box/') ? 'A box\'s page is the household owner\'s.' : 'A box\'s login is the household owner\'s.' }] }] };
  }
  // A reply's trace (trace.mjs, t-1895): the owner's, for an agent they own (an agent tab's, that agent only).
  if (typeof path === 'string' && /^trace\/cv-[0-9a-f]{12}$/.test(path)) return tracePage(env, path.slice(6), caller, scope);
  if (scope && (path === '' || path === undefined)) return agentTabPage(env, scope, caller, nowMs);
  if (Array.isArray(caller.agents)) return path === '' || path === undefined ? agentOwnerPage(env, caller, nowMs) : { title: 'Not found', sections: [] };
  if (path === '' || path === undefined) return boxesPage(env, nowMs);
  if (typeof path === 'string' && BOX_PAGE.test(path)) return boxPage(env, path.slice(4), nowMs, caller);
  if (path === 'agents') return agentsPage(env);
  if (path === 'permissions') return permissionsPage(env);
  if (typeof path === 'string' && /^permissions\/[a-z][a-z0-9-]{0,39}$/.test(path)) return agentPermissionsPage(env, path.slice(12));
  if (path === 'now') {
    let usage = [];
    try { usage = stateAccounts(env).usage(); } catch { usage = []; }
    return nowPage(env, { usage, nowS: nowMs / 1000 });
  }
  if (typeof path === 'string' && path.startsWith('now/') && AGENT_ID.test(path.slice(4))) return nowAgentPage(env, path.slice(4), { nowS: nowMs / 1000 });
  if (typeof path === 'string' && /^gates\/[a-z][a-z0-9-]{0,39}$/.test(path)) {
    const st = permsStore(env);
    return st ? gatesPage(st, path.slice(6)) : { title: 'Not found', sections: [] };
  }
  if (typeof path === 'string' && /^login\/l-[0-9a-f]{12}$/.test(path)) {
    const l = load(env).logins?.[path.slice(6)];
    if (l) { try { assertBoxOwner(env, caller, l.box); } catch (e) { return { status: 403, title: 'Not allowed', sections: [{ id: 'no', blocks: [{ type: 'text', tone: 'muted', text: e.message }] }] }; } }
    return loginPage(env, path.slice(6), nowMs);
  }
  return { title: 'Not found', sections: [] };
}

/** A conversation's reply trace as a page: its steps, then each run. Not found for one the caller doesn't own. */
async function tracePage(env, cv, caller, scope) {
  const { trace, TraceError } = await import('./trace.mjs');
  const agents = Array.isArray(caller.agents) ? caller.agents : '*';
  const who = { agents: scope ? (agents === '*' || agents.includes(scope) ? [scope] : []) : agents };
  let t;
  try { t = await trace(env, who, { conversation: cv }); } catch (e) {
    if (e instanceof TraceError) return { title: 'Not found', sections: [{ id: 'no', blocks: [{ type: 'text', tone: 'muted', text: 'No conversation of yours here by that name.' }] }] };
    throw e;
  }
  const tone = (ok) => (ok === false ? 'warn' : 'muted');
  const steps = t.steps.map((x) => ({ text: x.words, meta: `${x.step}${x.at ? ` · ${x.at.slice(0, 19).replace('T', ' ')}` : ''}`, ...(x.ok === false ? { tone: 'warn' } : {}) }));
  const runs = [...t.runs].reverse().slice(0, 5).map((r) => ({ type: 'kv', items: [
    { label: 'Run', value: r.run }, { label: 'Started', value: `${r.started ?? '—'}${r.how ? ` (${r.how})` : ''}` },
    { label: 'Body', value: r.body ? `${r.body}${r.house ? ` in ${r.house}` : r.local ? ' on loom\'s machine' : ''}` : '—' },
    { label: 'Ended', value: r.ended ? `${r.ended}${r.turn ? (r.turn.failed ? `, failed${r.turn.error ? `: ${r.turn.error}` : ''}` : r.turn.worked === false ? ', no tool work' : '') : ''}` : 'still going' },
    { label: 'Sent', value: `${r.sent}${r.refused ? `, ${r.refused} refused: ${r.refusal}` : ''}` },
    ...(r.fail ? [{ label: 'Failed', value: r.fail }] : []),
  ] }));
  return {
    title: `What happened: ${t.label ?? t.place}`,
    sections: [
      { id: 'steps', title: `${t.agent[0].toUpperCase()}${t.agent.slice(1)}'s newest run${t.run ? `, ${t.run}` : ''}`, blocks: [{ type: 'list', items: steps }, ...(t.note ? [{ type: 'text', tone: tone(false), text: t.note }] : [])] },
      ...(runs.length ? [{ id: 'runs', title: 'Runs', blocks: runs }] : []),
      { id: 'about', blocks: [{ type: 'text', tone: 'muted', text: `${t.venue} ${t.place} · ${t.conversation}. No words here: only what happened.` }] },
    ],
  };
}

/** An unexpected failure, kept beside the runtime's state (errors.log): its trace, never a value. */
function logError(env, action, err) {
  const p = join(stateDir(env), 'errors.log');
  try {
    appendFileSync(p, `${new Date().toISOString()} ${action}: ${err.stack || err}\n`, { mode: 0o600 });
  } catch { return 'loom-box\'s stderr'; }
  return p;
}

/** The page's actions, as loom's caller: the household owner's all of them; an agent owner's, their agents' houses and services. */
/** The agent whose tab this is (LOOM_SCOPE), or ''. */
function scopeOf(env) {
  const v = typeof env?.LOOM_SCOPE === 'string' ? env.LOOM_SCOPE.trim() : '';
  return /^[a-z][a-z0-9-]{0,39}$/.test(v) ? v : '';
}

/** The agent an action is about: its field, or a house's own. */
function targetOf(env, action, fields) {
  if (action === 'down') return load(env).houses[fields.id]?.agent;
  return fields.agent;
}

/** Where a box's own action lands: the page of the box it named (by id or name, resolved); else Boxes. */
const boxPath = (env, name) => { try { return boxPagePath(resolveBox(load(env), name)); } catch { return ''; } };

const AGENT_ACTIONS = new Set(['agent-flag', 'model-choice', 'up', 'down', 'service-up', 'service-down', 'service-restart', 'service-move', 'remote-up', 'remote-down', 'set-primary', 'set-agent']);

export function act(env, effects, { action, fields: raw = {}, caller: c }, publicUrl) {
  const OWNER = pageCaller(c);
  // From an agent's Houses tab: that agent's things only, and none of the household's (boxes, joins).
  const scope = scopeOf(env);
  if (scope && (!AGENT_ACTIONS.has(action) || targetOf(env, action, raw) !== scope)) {
    return { ok: false, message: `This is ${scope}'s page.` };
  }
  if (Array.isArray(OWNER.agents) && !['up', 'down', 'service-up', 'service-down', 'service-restart', 'model-choice'].includes(action)) {
    return { ok: false, message: 'That\'s the household owner\'s to do.' };
  }
  // The page's field names are lowercase (loom's vocabulary); the runtime's are camelCase.
  const fields = { ...raw };
  for (const [from, to] of [['may_host', 'mayHost'], ['house_file', 'houseFile'], ['repo_secret', 'repoSecret']]) {
    if (from in fields) { fields[to] = fields[from]; delete fields[from]; }
  }
  const label = (id) => boxLabelOf(load(env), id);
  try {
    // A box's logins and Update now: its owner's only.
    if (['login-start', 'login-code', 'login-cancel', 'box-update-now'].includes(action)) assertBoxOwner(env, OWNER, boxOfCall(env, action, fields));
    switch (action) {
      case 'add-box': {
        const { name, token } = addBox(env, effects, fields);
        const url = publicUrl || '<this loom\'s URL>';
        return { ok: true, keep: true, message: `Added ${name}. On ${name}, run \`loom box join ${url} --name ${name} --credential\` and paste this credential when it asks (shown this once): ${token}`, page: '' };
      }
      case 'allow-join': { const r = allowJoin(env, effects, fields); return { ok: true, message: `Let ${r.name} in (code ${r.code}). It picks up its credential by itself within a few seconds.`, page: '' }; }
      case 'block-join': { const r = blockJoin(env, effects, fields); return { ok: true, message: `Blocked ${r.name}'s request.`, page: '' }; }
      case 'block-all-joins': { const r = blockAllJoins(env, effects); return { ok: true, message: `Blocked ${r.blocked} waiting request${r.blocked === 1 ? '' : 's'}.`, page: '' }; }
      case 'revoke-box': { const r = revokeBox(env, effects, fields); return { ok: true, message: `Revoked ${r.name}. Its houses lost their tokens.`, page: '' }; }
      case 'box-watch': { const r = setBoxWatch(env, effects, { name: fields.name, alwaysOn: fields.always_on, reportOnly: fields.report_only }); return { ok: true, message: `${r.name}: ${r.reportOnly ? 'report-only' : 'hosts what it may'}, ${r.alwaysOn ? 'always on' : 'not always on'}.`, page: boxPath(env, fields.name) }; }
      case 'may-host': { const r = setMayHost(env, effects, fields); return { ok: true, message: `Saved who ${r.name} may host.`, page: boxPath(env, fields.name) }; }
      case 'box-owner': { const r = setBoxOwner(env, effects, fields); return { ok: true, message: `${r.name} is ${r.owner}'s.`, page: boxPath(env, fields.name) }; }
      case 'box-lend': { const r = lendBox(env, effects, fields); return { ok: true, message: r.lentTo.length ? `${r.name} is lent to ${r.lentTo.join(', ')}.` : `${r.name} is lent to no one.`, page: boxPath(env, fields.name) }; }
      case 'login-start': {
        const r = loginStart(env, effects, fields);
        return { ok: true, message: `${label(r.box)} is starting ${LOGIN_HARNESSES[r.harness].label}'s own login; its link shows here in a few seconds.`, page: `login/${r.id}` };
      }
      case 'login-code': { loginCode(env, effects, fields); return { ok: true, message: 'Got it: the box is checking the code.', page: `login/${fields.id}` }; }
      case 'box-update-now': { const r = boxUpdateNow(env, effects, fields); return { ok: true, message: `${r.name} tries loom's runtime on its next poll.`, page: boxPath(env, fields.name) }; }
      case 'login-cancel': { loginCancel(env, effects, fields); return { ok: true, message: 'Cancelled.', page: '' }; }
      case 'role-set': case 'role-remove': {
        const cur = rolesOf(load(env));
        const expect = String(fields.version ?? '');
        const why = String(fields.why ?? '').trim() || undefined;
        const by = typeof OWNER.who === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(OWNER.who) ? OWNER.who : 'owner';
        if (action === 'role-remove') { setRole(env, { remove: String(fields.id ?? ''), why, by, expect }); return { ok: true, message: `Removed the ${fields.id} role.`, page: '' }; }
        const role = roleFromFields(fields);
        const r = setRole(env, { role, why, by, expect, keep: true });
        const had = cur.roles.some((x) => x.id === role.id);
        return { ok: true, message: `${had ? 'Saved' : 'Added'} the ${role.id} role: ${andList(r.roles.find((x) => x.id === role.id)?.eligible ?? []) || 'no model fits it yet'}.`, page: '' };
      }
      case 'model-choice': {
        const choice = ownerModelChoice(env, OWNER, fields);
        return { ok: true, message: `Saved ${who(choice.agent)}'s model preference. New turns use ${choice.effective === 'auto' ? 'Auto' : HARNESS_WORDS[choice.effective]} when available.`, page: '' };
      }
      case 'set-primary': {
        const ordered = ['first', 'second', 'third'].some((k) => k in fields);
        const r = setPrimary(env, effects, { agent: fields.agent, ...(ordered ? { boxes: [fields.first, fields.second, fields.third].filter(Boolean) } : { box: fields.box }) });
        return { ok: true, message: `${r.agent} runs on ${r.boxes.map(label).join(', then ')}: the first that's up.`, page: '' };
      }
      case 'set-agent': { const r = setAgent(env, effects, fields); return { ok: true, message: `Saved ${r.agent}'s house.`, page: '' }; }
      case 'up': {
        const r = up(env, effects, OWNER, { agent: fields.agent, box: fields.box, needs: fields.needs, task: fields.task });
        return { ok: true, message: `${r.id}: ${r.agent} on ${label(r.box)}, waiting for the box to start it.`, page: '' };
      }
      case 'down': { const r = down(env, effects, OWNER, fields); return { ok: true, message: `${r.id} is ${r.state}.`, page: '' }; }
      case 'remote-up': {
        const r = remoteUp(env, effects, { agent: fields.agent, box: fields.box, dir: fields.dir });
        return { ok: true, message: `"${r.name}" is starting; its link shows here in a few seconds.`, page: '' };
      }
      case 'remote-down': { const r = remoteDown(env, effects, fields); return { ok: true, message: `"${r.name}" is going down.`, page: '' }; }
      case 'service-up': { const r = serviceUp(env, effects, OWNER, fields); return { ok: true, message: `${r.service} is coming up on ${label(r.box)}.`, page: '' }; }
      case 'service-down': { const r = serviceDown(env, effects, OWNER, fields); return { ok: true, message: `${r.service} is going down.`, page: '' }; }
      case 'service-restart': {
        const r = serviceRestart(env, effects, OWNER, fields);
        return { ok: true, message: r.restarting ? `${r.service} is restarting: ${r.house} stops, then a fresh house takes over.` : `${r.service} is already starting fresh.`, page: '' };
      }
      case 'service-move': {
        const r = serviceMove(env, effects, OWNER, fields);
        return { ok: true, message: r.moving ? `${r.service}: stopping on ${label(r.box)}; it starts on ${label(r.moveTo)} once that's confirmed.` : `${r.service} is on ${label(r.box)}.`, page: '' };
      }
      case 'agent-flag': {
        // A switch on the agent's house panel: one grant (nested containers, GPU) changed, every other kept as it is.
        const flag = String(fields.flag ?? '');
        if (!['nested', 'gpu'].includes(flag)) return { ok: false, message: 'That isn\'t a switch on an agent\'s house.' };
        const c = load(env).agents[fields.agent];
        if (!c) return { ok: false, message: `${who(fields.agent)} has no house.` };
        const form = agentForm(fields.agent, c);
        const all = Object.fromEntries(form.fields.filter((x) => x.value !== undefined).map((x) => [x.name, x.value]));
        for (const [from, to] of [['house_file', 'houseFile'], ['repo_secret', 'repoSecret']]) if (from in all) { all[to] = all[from]; delete all[from]; }
        all[flag] = fields.on === 'on' ? 'yes' : 'no';
        const r = setAgent(env, effects, { ...all, agent: fields.agent });
        const what = flag === 'gpu' ? 'the box\'s GPU' : 'containers of their own';
        return { ok: true, message: `${who(r.agent)}'s houses ${fields.on === 'on' ? 'may' : 'may not'} have ${what} from their next start.`, page: '' };
      }
      case 'reset-approved': return resetApproved(env, c, fields);
      case 'writeoff-approved': return writeOffApproved(env, effects, c, fields, spendApproval);
      case 'gates-allow': case 'gates-deny': case 'gates-merge': case 'grants-set': case 'relay-set': case 'relay-pair': case 'grant-approved': {
        const st = permsStore(env);
        if (!st) return { ok: false, message: 'The runtime reads its permissions from loom\'s store when loom runs it.' };
        if (action === 'grant-approved') return grantApproved(env, st, c, fields);
        if (action === 'relay-pair') {
          // One pair's switch: a relay from agent to `to` without asking, on or off; the agent's other pairs kept.
          const g = st.get(GRANTS, GRANTS_KEY);
          const agent = String(fields.agent ?? '').trim();
          const other = String(fields.to ?? '').trim();
          const cur = g?.doc?.relay?.[agent] ?? [];
          const to = fields.on === 'on' ? [...new Set([...cur, other])] : cur.filter((x) => x !== other);
          try { setRelay(st, { agent, to, agents: householdOf(env)?.agents ?? [] }); } catch (e) {
            if (e instanceof GrantsError) return { ok: false, message: e.message, page: 'permissions' };
            throw e;
          }
          return { ok: true, message: fields.on === 'on' ? `${who(agent)} relays to ${who(other)} without asking now.` : `${who(agent)} asks you before relaying to ${who(other)}.`, page: 'permissions' };
        }
        if (action === 'relay-set') {
          const g = st.get(GRANTS, GRANTS_KEY);
          if (String(g?.rev ?? 0) !== String(fields.rev ?? '0')) return { ok: false, message: 'The grants changed since you opened this: open it again.', page: 'permissions' };
          const agent = String(fields.agent ?? '').trim();
          const to = String(fields.to ?? '').split(',').map((x) => x.trim()).filter(Boolean);
          let rev;
          try { rev = setRelay(st, { agent, to, agents: householdOf(env)?.agents ?? [] }); } catch (e) {
            if (e instanceof GrantsError) return { ok: false, message: e.message, page: 'permissions' };
            throw e;
          }
          return { ok: true, message: `${agent} ${to.length ? `relays to ${[...new Set(to)].sort().join(', ')} without asking` : 'asks you before every relay'} (revision ${rev}).`, page: 'permissions' };
        }
        if (action === 'grants-set') {
          const g = st.get(GRANTS, GRANTS_KEY);
          if (String(g?.rev ?? 0) !== String(fields.rev ?? '0')) return { ok: false, message: 'The grants changed since you opened this: open it again.', page: 'permissions' };
          // The panel's sheet says Every agent or These agents (chips); the old form, agents as text ("*" for every agent).
          const whom = fields.who === 'all' ? '*' : String(fields.agents ?? '').trim();
          const agents = whom === '*' ? '*' : whom.split(',').map((x) => x.trim()).filter(Boolean);
          const piece = String(fields.piece ?? '').trim();
          try {
            setPiece(st, { piece, agents, paths: String(fields.paths || '*').split(',').map((x) => x.trim()).filter(Boolean) });
          } catch (e) {
            if (e instanceof GrantsError) return { ok: false, message: e.message, page: 'permissions' };
            throw e;
          }
          const words = agents === '*' ? 'every agent' : agents.length ? andList(agents.map(who)) : null;
          return { ok: true, message: words ? `${cap(piece)} is ${words}'s to use; core asks from the next call.` : `${cap(piece)} has no grant now: no agent may use it.`, page: 'permissions' };
        }
        return (action === 'gates-merge' ? mergePeople(st, permsCore(env), fields) : gateAnswer(st, permsCore(env), action, fields))
          .catch((err) => ({ ok: false, message: `The runtime failed (${String(err.message || err).slice(0, 160)}).` }));
      }
      case 'loop-resume': case 'loop-dismiss': {
        const answer = action === 'loop-resume' ? 'resume' : 'dismiss';
        return answerLoop(env, String(fields.conversation ?? ''), answer, { detach: true })
          .then((r) => ({ ok: true, message: answer === 'resume' ? `Resumed${r.waiting ? `: ${r.waiting} waiting start${r.waiting === 1 ? 's' : ''} now` : ''}.` : `Dismissed${r.waiting ? `: ${r.waiting} waiting dropped` : ''}; its next message starts it fresh.`, page: '' }))
          .catch((e) => ({ ok: false, message: String(e.message || e).slice(0, 200) }));
      }
      default: return { ok: false, message: `No action ${action}.` };
    }
  } catch (err) {
    if (err instanceof StateError) return { ok: false, message: err.message };
    // loom doesn't keep a piece's stderr from the page, so the trace goes where it can be found.
    const where = logError(env, action, err);
    process.stderr.write(`loom-box: ${err.stack || err}\n`);
    return { ok: false, message: `The runtime failed (${String(err.message || err).slice(0, 160)}). The full error is in ${where}.` };
  }
}

export { localBoxName, factsOf };
