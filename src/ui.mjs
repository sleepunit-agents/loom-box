// The Boxes tab on loom's page (loom docs/extensions.md, "The page"): the
// boxes, what each has and may host, the houses asked for, and the owner's
// controls. Data only; loom renders it. Every action is the owner's (the page
// is), and a box's credential is shown once, in the message after adding it.
import { appendFileSync, existsSync, readFileSync, statfsSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { StateError, load, localBoxName, stateDir } from './state.mjs';
import { sessionsBusy } from './busy.mjs';
import { allowJoin, blockAllJoins, blockJoin, pendingJoins } from './enroll.mjs';
import { addBox, assertBoxOwner, isBoxOwner, boxLabelOf, boxOfCall, boxUpdateNow, loginOver, factsOf, lendBox, list, loginCancel, loginCode, loginStart, loginView, primaryOf, remoteDown, remoteUp, revokeBox, shownTask, serviceDown, serviceMove, serviceRestart, serviceUp, setAgent, isHostHouse, setBoxOwner, setMayHost, setPrimary, up, down, LIVE } from './control.mjs';
import { LOGIN_HARNESSES } from './logins.mjs';
import { ownCommit, swapCommand } from './version.mjs';
import { stateAccounts } from './accounts.mjs';
import { answerLoop, deliveryNotices, loopAsks } from './delivery.mjs';
import { loomStore } from './store.mjs';
import { asks as gateAsks, answer as gateAnswer, gatesPage, mergePeople, status as gatesStatus, proposals as gateProposals, PROPOSALS as PROPOSALS_COLLECTION } from './gates.mjs';
import { GRANTS, KEY as GRANTS_KEY, GrantsError, grantsProblem, householdOf, setPiece, setRelay } from './grants.mjs';
import { relayNotices } from './relay.mjs';
import { nowManifest, nowPage } from './nowboard.mjs';
import { watchAsks, watchNotices, watchRows } from './watch.mjs';
import { coreFrom } from './core.mjs';

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
export const houseBadge = (h) => (h.draining && h.state === 'running' ? `draining (${h.draining.reason ?? 'outdated image'})` : h.state);
const houseTone = (h) => (h.draining && h.state === 'running' ? 'warn' : toneOf(h.state));
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

export function manifest(env, nowMs = Date.now()) {
  const s = load(env);
  // The now board (nowboard.mjs): a bridge actually down is an alert (one restarting, by the runtime's own doing, is
  // not), one back from an outage an FYI, and what each agent's bodies are in is its doing.
  let board = { asks: [], agents: {}, notices: [] };
  try { board = nowManifest(env, Date.now() / 1000, s); } catch { /* a board that can't be read leaves the rest of the manifest */ }
  const reports = agentReports(s, Date.now(), { ...reportedBusy(s), ...sessionsBusy(join(stateDir(env), 'session-cpu.json')) });
  for (const [a, doing] of Object.entries(board.agents)) reports[a] = { readings: [], ...reports[a], doing: [...(reports[a]?.doing ?? []), ...doing].slice(0, 8) };
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
    asks: [...pendingJoins(s).slice(0, 5).map((j) => joinAsk(j)), ...permsAsks(env), ...board.asks, ...loopAsksOf(env), ...watchAsksOf(env, s)],
    agents: reports,
    // A delivery the runtime gave up on (its body never started, after its retries): the owner hears of it.
    // ...and a relay thread between agents that's run long today: a heads-up, never a stop (relay.mjs).
    notices: [...deliveryNotices(env), ...relayNotices(env), ...boxNotices(s), ...(board.notices ?? []), ...watchNoticesOf(env, nowMs)].sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, 20),
  };
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
  if (h.kind === 'body-host' || (s && isHostHouse(h, s))) return `${who}'s body host`;
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

/**
 * Each agent as the box runtime sees it, for its card on loom's Home (docs/extensions.md, "agents"): working while a
 * task house runs; unavailable while a service it wants up is down; broken when one keeps failing. Readings: its
 * bridges, its remote sessions, and how many tasks are running. It says nothing about an agent with nothing here.
 */
export function agentReports(s, nowMs = Date.now(), busy = {}) {
  const out = {};
  const services = Object.values(s.services ?? {});
  const agents = new Set([...Object.keys(s.agents ?? {}), ...services.map((v) => v.agent), ...Object.keys(s.remotes ?? {})]);
  for (const a of agents) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(a)) continue;
    const mine = services.filter((v) => v.agent === a && v.want === 'up');
    const up = (v) => s.houses[v.house]?.state === 'running';
    const late = (v) => { const h = s.houses[v.house]; return !h || !LIVE.has(h.state) || (h.state !== 'running' && nowMs - Date.parse(h.updated ?? h.created) > STARTING_GRACE_MS); };
    const down = mine.filter((v) => !up(v) && late(v));
    const failing = down.filter((v) => (v.restarts ?? 0) >= BROKEN_RESTARTS);
    // A body host's house is where its conversations run, not something it's doing: its bodies are (the now board's).
    const tasks = Object.values(s.houses).filter((h) => h.agent === a && !h.service && !isHostHouse(h, s) && (h.state === 'running' || h.state === 'starting'))
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

/** What's wrong across the boxes, worst first, in words: the Boxes page's headline. */
function boxProblems(env, s, boxes, live, view, nowMs) {
  const bad = [], warn = [];
  for (const b of boxes) {
    if (!b.local && !b.lastSeen) warn.push(`${b.label} hasn't joined yet`);
    else if (!b.local && nowMs - Date.parse(b.lastSeen) > 10 * 60_000) bad.push(`${b.label} hasn't been heard from since ${ago(b.lastSeen, nowMs)}`);
    const loomC = ownCommit();
    const rt = b.runtime ?? {};
    if (loomC && !b.local && b.lastSeen && rt.commit !== loomC) {
      const u = rt.upgrade?.commit === loomC ? rt.upgrade : null;
      if (u && ['failed', 'refused', 'rolling-back'].includes(u.state)) bad.push(`${b.label}'s runtime update didn't work`);
      else if (!rt.commit) warn.push(`${b.label} is on the old box piece`);
    }
    for (const [h, def] of Object.entries(LOGIN_HARNESSES)) {
      const st = b.harnesses?.[h];
      if (st?.installed && st.unhealthy) bad.push(`${def.label} on ${b.label} isn't usable`);
      else if (st?.installed && !st.loggedIn) warn.push(`${def.label} isn't logged in on ${b.label}`);
    }
    const disk = b.local ? diskUse(env) : null;
    if (disk && disk.used >= 0.95) bad.push(`${b.label}'s disk is nearly full`);
    else if (disk && disk.used >= 0.9) warn.push(`${b.label}'s disk is ${Math.round(disk.used * 100)}% full`);
  }
  for (const v of view.services.filter((x) => x.want === 'up')) {
    if (v.state === 'failed' || v.state === 'lost') bad.push(`${who(v.agent)}'s ${v.name} is down`);
  }
  const asking = pendingJoins(s).length;
  if (asking) warn.push(asking === 1 ? 'A box asks to join' : `${asking} boxes ask to join`);
  void live;
  return { bad, warn };
}

function boxesPage(env, nowMs, caller = OWNER) {
  // A box's logins and Update now are its owner's (control.mjs, assertBoxOwner): another household owner sees, doesn't press.
  const mayAct = (b) => isBoxOwner(env, caller, b.id);
  const s = load(env);
  const view = list(env, OWNER);
  const agents = Object.keys(s.agents).sort();
  const live = view.houses.filter((h) => LIVE.has(h.state));
  const running = live.filter((h) => h.state === 'running');
  const sections = [];
  const live_boxes = view.boxes.filter((b) => !b.revoked).map((b) => ({ ...b, label: boxLabelOf(s, b.id) }));
  const up = live_boxes.filter((b) => b.local || (b.lastSeen && nowMs - Date.parse(b.lastSeen) <= 10 * 60_000));
  const svcUp = view.services.filter((v) => v.want === 'up');

  // The headline: how things are, in words; what's wrong first. Tiles under it.
  const { bad, warn } = boxProblems(env, s, live_boxes, live, view, nowMs);
  const counts = `${plural(up.length, 'box', 'boxes')} up · ${plural(running.length, 'house')} running`;
  const worst = [...bad, ...warn];
  const disk = diskUse(env);
  const local = live_boxes.find((b) => b.local);
  sections.push({ id: 'status', blocks: [
    { type: 'health', tone: bad.length ? 'bad' : warn.length ? 'warn' : 'ok',
      text: worst.length ? `${cap(worst[0])}${worst.length > 1 ? ` (and ${worst.length - 1} more)` : ''}` : counts,
      detail: worst.length ? `${worst.slice(1, 4).map(cap).join('. ')}${worst.length > 1 ? '. ' : ''}${counts}.` : `${plural(svcUp.length, 'service')} up${live.length > running.length ? ` · ${live.length - running.length} starting or waiting` : ''}. Nothing needs you.` },
    { type: 'stats', items: [
      { label: 'Boxes', value: String(up.length), detail: live_boxes.length > up.length ? `of ${live_boxes.length}` : 'all up', tone: live_boxes.length > up.length ? 'warn' : 'ok' },
      { label: 'Houses', value: String(running.length), detail: live.length > running.length ? `${live.length - running.length} more on the way` : 'running' },
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

  // A card per box (a page holds ten sections, so past three boxes, one panel with each box behind a tap).
  if (live_boxes.length > 3) {
    sections.push({ id: 'all-boxes', title: 'Boxes', blocks: [{ type: 'panel', rows: live_boxes.map((b) => {
      const n = live.filter((h) => h.box === b.id).length;
      const seen = b.local ? 'loom\'s own' : b.lastSeen ? `Seen ${ago(b.lastSeen, nowMs)}` : 'Not joined yet';
      return { label: b.label, value: `${seen} · ${plural(n, 'house')}`, tone: b.local || b.lastSeen ? 'ok' : 'warn',
        sheet: { title: b.label, blocks: [
          { type: 'panel', rows: [...(b.lastSeen || b.local ? runtimePanelRows(env, b, nowMs, mayAct(b)) : []), ...harnessPanelRows(s, b, nowMs, mayAct(b))].map(({ sheet: _s, ...r }) => r) },
          ...(watchRowsOf(env, b.id, nowMs).length ? [{ type: 'panel', title: 'Watch', rows: watchRowsOf(env, b.id, nowMs).map(({ sheet: _s, ...r }) => r) }] : []),
          ...(b.local ? [] : [boxSettingsPanel(b)]),
        ] } };
    }) }] });
  }
  for (const b of live_boxes.length > 3 ? [] : live_boxes) {
    const here = live.filter((h) => h.box === b.id);
    const state = b.local ? { value: `Up ${span(uptime() * 1000)}`, tone: 'ok' }
      : !b.lastSeen ? { value: 'Not joined yet', detail: `Run loom box join on ${b.label}`, tone: 'warn' }
        : nowMs - Date.parse(b.lastSeen) > 10 * 60_000 ? { value: `Not heard from since ${ago(b.lastSeen, nowMs)}`, tone: 'bad' }
          : { value: 'Up', detail: `Seen ${ago(b.lastSeen, nowMs)}`, tone: 'ok' };
    sections.push({ id: `box-${b.id}`, title: b.local ? `${b.label} · loom's own` : b.label, ...(state.tone === 'ok' ? {} : { tone: 'warn' }), blocks: [
      { type: 'panel', rows: [
        { label: 'State', ...state },
        machineRow(b),
        ...(b.lastSeen || b.local ? runtimePanelRows(env, b, nowMs, mayAct(b)) : []),
        ...harnessPanelRows(s, b, nowMs, mayAct(b)),
        // When it last came back, and its units failing (watch.mjs).
        ...watchRowsOf(env, b.id, nowMs),
      ] },
      // Its disk is the headline's tile (only loom's own box measures one).
      here.length
        ? { type: 'panel', title: `Houses on ${b.label}`, rows: here.slice(0, 30).map((h) => housePanelRow(s, h, nowMs)) }
        : { type: 'text', tone: 'muted', text: 'No houses on it now.' },
      ...(b.local ? [] : [boxSettingsPanel(b)]),
    ] });
  }

  sections.push(loginsSection(env, s, live_boxes, nowMs, false));

  // Each agent's houses, services and sessions are its own (its Houses tab): here, a row each.
  if (agents.length) {
    sections.push({ id: 'agents', title: 'Each agent\'s houses', blocks: [{ type: 'panel', rows: agents.map((a) => {
      const n = live.filter((h) => h.agent === a).length;
      const svc = view.services.filter((v) => v.agent === a && v.want === 'up');
      const down = svc.filter((v) => v.state === 'failed' || v.state === 'lost');
      return { label: who(a), agent: a, page: `agent:${a}`, value: `${plural(n, 'house')} up · ${plural(svc.length, 'service')}`,
        detail: down.length ? `${andList(down.map((v) => v.name))} ${down.length === 1 ? 'is' : 'are'} down` : `Primary box: ${boxLabelOf(s, primaryOf(s, a, env))}`, tone: down.length ? 'bad' : n ? 'ok' : 'muted' };
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
  void nowMs;
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
 * and its windows as meters a tap away. Each box's harnesses are on its own card (harnessPanelRows).
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
    { type: 'text', tone: 'muted', text: 'Each box signs in to Claude and Codex itself, with its owner\'s own subscription: Log in, on its card, runs the CLI\'s own login on that box. loom never sees the login.' },
  ] };
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
  const running = live.filter((h) => h.state === 'running').length;
  const draining = live.filter((h) => h.draining && h.state === 'running').length;
  const counts = `${plural(running, 'house')} running · ${plural(svcUp.length, 'service')} up`;
  const sections = [{ id: 'houses', title: 'Houses', blocks: [
    { type: 'health', tone: svcDown.length ? 'bad' : draining || live.length > running ? 'warn' : live.length ? 'ok' : 'muted',
      text: svcDown.length ? `${andList(svcDown.map((v) => serviceWords(v.name)))} ${svcDown.length === 1 ? 'is' : 'are'} down` : counts,
      detail: svcDown.length ? counts : draining ? `${plural(draining, 'house')} draining to a newer image.` : live.length > running ? `${live.length - running} more starting or waiting for a box.` : live.length ? 'All running.' : 'Nothing running now.' },
    live.length
      ? { type: 'panel', rows: live.slice(0, 30).map((h) => housePanelRow(s, h, nowMs,
        h.state === 'wanted' || h.state === 'running' || h.state === 'starting' ? { detail: `On ${nameOf(h.box)}`, act: { action: 'down', label: 'Stop', tone: 'danger', fields: { id: h.id }, confirm: 'This house stops.' } } : { detail: `On ${nameOf(h.box)}` })) }
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
    const primary = primaryOf(s, agent, env);
    const boxOpts = live_boxes.map((b) => ({ value: b.id, label: b.label }));
    const secrets = Object.entries(c.secrets || {});
    const repo = String(c.repo ?? '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    sections.push({ id: `agent-${agent}`, title: 'Its house', side: true, blocks: [{ type: 'panel', rows: [
      { label: 'Primary box', value: nameOf(primary), ...(boxOpts.length >= 2 && boxOpts.length <= 5
        ? { choice: { action: 'set-primary', name: 'box', value: primary, options: boxOpts, fields: { agent } } }
        : boxOpts.length > 5 ? { edit: { title: 'Primary box', action: 'set-primary', submit: 'Set', hidden: { agent }, fields: [{ name: 'box', label: 'Primary', kind: 'choice', value: primary, options: boxOpts }] } } : {}) },
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
    ? { type: 'list', items: live.slice(0, 30).map((h) => ({ text: short(houseName(h)), meta: h.state, badge: h.state, tone: toneOf(h.state), agent: h.agent,
      ...(h.state === 'wanted' || h.state === 'running' || h.state === 'starting' ? { act: { action: 'down', label: 'Stop', tone: 'danger', fields: { id: h.id }, confirm: 'This house stops.' } } : {}) })) }
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

export function page(env, { path, caller: c }, nowMs = Date.now()) {
  const caller = pageCaller(c);
  const scope = scopeOf(env);
  // A box's login is its owner's, the way the login actions are: never an agent's tab or an agent owner's page.
  if (typeof path === 'string' && path.startsWith('login/') && (scope || Array.isArray(caller.agents))) {
    return { status: 403, title: 'Not allowed', sections: [{ id: 'no', blocks: [{ type: 'text', tone: 'muted', text: 'A box\'s login is the household owner\'s.' }] }] };
  }
  if (scope && (path === '' || path === undefined)) return agentTabPage(env, scope, caller, nowMs);
  if (Array.isArray(caller.agents)) return path === '' || path === undefined ? agentOwnerPage(env, caller, nowMs) : { title: 'Not found', sections: [] };
  if (path === '' || path === undefined) return boxesPage(env, nowMs, caller);
  if (path === 'agents') return agentsPage(env);
  if (path === 'permissions') return permissionsPage(env);
  if (path === 'now') {
    let usage = [];
    try { usage = stateAccounts(env).usage(); } catch { usage = []; }
    return nowPage(env, { usage, nowS: nowMs / 1000 });
  }
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

const AGENT_ACTIONS = new Set(['agent-flag', 'up', 'down', 'service-up', 'service-down', 'service-restart', 'service-move', 'remote-up', 'remote-down', 'set-primary', 'set-agent']);

export function act(env, effects, { action, fields: raw = {}, caller: c }, publicUrl) {
  const OWNER = pageCaller(c);
  // From an agent's Houses tab: that agent's things only, and none of the household's (boxes, joins).
  const scope = scopeOf(env);
  if (scope && (!AGENT_ACTIONS.has(action) || targetOf(env, action, raw) !== scope)) {
    return { ok: false, message: `This is ${scope}'s page.` };
  }
  if (Array.isArray(OWNER.agents) && !['up', 'down', 'service-up', 'service-down', 'service-restart'].includes(action)) {
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
      case 'may-host': { const r = setMayHost(env, effects, fields); return { ok: true, message: `Saved who ${r.name} may host.`, page: '' }; }
      case 'box-owner': { const r = setBoxOwner(env, effects, fields); return { ok: true, message: `${r.name} is ${r.owner}'s.`, page: '' }; }
      case 'box-lend': { const r = lendBox(env, effects, fields); return { ok: true, message: r.lentTo.length ? `${r.name} is lent to ${r.lentTo.join(', ')}.` : `${r.name} is lent to no one.`, page: '' }; }
      case 'login-start': {
        const r = loginStart(env, effects, fields);
        return { ok: true, message: `${label(r.box)} is starting ${LOGIN_HARNESSES[r.harness].label}'s own login; its link shows here in a few seconds.`, page: `login/${r.id}` };
      }
      case 'login-code': { loginCode(env, effects, fields); return { ok: true, message: 'Got it: the box is checking the code.', page: `login/${fields.id}` }; }
      case 'box-update-now': { const r = boxUpdateNow(env, effects, fields); return { ok: true, message: `${r.name} tries loom's runtime on its next poll.`, page: '' }; }
      case 'login-cancel': { loginCancel(env, effects, fields); return { ok: true, message: 'Cancelled.', page: '' }; }
      case 'set-primary': { const r = setPrimary(env, effects, fields); return { ok: true, message: `${r.agent}'s primary is ${label(r.primary)}.`, page: '' }; }
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
      case 'gates-allow': case 'gates-deny': case 'gates-merge': case 'grants-set': case 'relay-set': case 'relay-pair': {
        const st = permsStore(env);
        if (!st) return { ok: false, message: 'The runtime reads its permissions from loom\'s store when loom runs it.' };
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
