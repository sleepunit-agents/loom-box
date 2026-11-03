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
import { addBox, assertBoxOwner, isBoxOwner, boxLabelOf, boxOfCall, boxUpdateNow, loginOver, factsOf, lendBox, list, loginCancel, loginCode, loginStart, loginView, primaryOf, remoteDown, remoteUp, revokeBox, shownTask, serviceDown, serviceMove, serviceRestart, serviceUp, setAgent, setBoxOwner, setMayHost, setPrimary, up, down, LIVE } from './control.mjs';
import { LOGIN_HARNESSES } from './logins.mjs';
import { ownCommit, swapCommand } from './version.mjs';
import { stateAccounts } from './accounts.mjs';
import { answerLoop, deliveryNotices, loopAsks } from './delivery.mjs';
import { loomStore } from './store.mjs';
import { asks as gateAsks, answer as gateAnswer, gatesPage, mergePeople, status as gatesStatus, proposals as gateProposals } from './gates.mjs';
import { GRANTS, KEY as GRANTS_KEY, GrantsError, grantsProblem, householdOf, setPiece, setRelay } from './grants.mjs';
import { relayNotices } from './relay.mjs';
import { nowManifest, nowPage } from './nowboard.mjs';
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
      items.push({ text: `${a} on ${boxLabelOf(s, r.box)}: box session`, meta: `${r.state}${r.error ? ` (${r.error})` : ''} · ${r.dir}`, tone: r.state === 'running' ? 'ok' : 'warn', agent: a, ...(r.url ? { href: r.url } : {}),
        act: { action: 'remote-down', label: 'Down', tone: 'danger', confirm: 'The session ends; anything open in the Claude app on it stops.', fields: { agent: a } } });
    } else if (r?.dir) {
      items.push({ text: `${a} on ${boxLabelOf(s, r.box)}: box session`, meta: `down · ${r.dir}`, tone: 'muted', agent: a,
        act: { action: 'remote-up', label: 'Up', tone: 'primary', fields: { agent: a, box: r.box, dir: r.dir } } });
    }
    const rs = view.services.find((v) => v.agent === a && v.name === 'remote');
    if (rs) {
      const link = rs.want === 'up' && rs.house ? remoteLink(env, rs.house) : null;
      items.push({ text: `${a}'s house: house session`, meta: rs.want === 'up' ? `${rs.state ?? 'starting'} on ${boxLabelOf(s, rs.box)}` : 'down', tone: rs.want !== 'up' ? 'muted' : rs.state === 'running' ? 'ok' : 'warn', agent: a, ...(link ? { href: link } : {}),
        act: rs.want === 'up'
          ? { action: 'service-down', label: 'Down', tone: 'danger', confirm: 'The house stops; anything open in the Claude app on it stops.', fields: { agent: a, name: 'remote' } }
          : { action: 'service-up', label: 'Up', tone: 'primary', fields: { agent: a, name: 'remote' } } });
    }
    if (!items.length) continue;
    blocks.push({ type: 'list', items });
    // No box session yet: where it would run is a choice, so it's a form, a tap away.
    if (!r?.dir) blocks.push({ type: 'details', summary: `Start ${a}'s first box session`, blocks: sessionControls(env, s, a, null) });
  }
  return blocks.length > 1 ? { id: 'sessions', title: 'Sessions', blocks } : null;
}

export function manifest(env) {
  const s = load(env);
  // The now board (nowboard.mjs): a bridge gone dark is an alert, and what each agent's bodies are in is its doing.
  let board = { asks: [], agents: {} };
  try { board = nowManifest(env); } catch { /* a board that can't be read leaves the rest of the manifest */ }
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
    asks: [...pendingJoins(s).slice(0, 5).map((j) => joinAsk(j)), ...permsAsks(env), ...board.asks, ...loopAsksOf(env)],
    agents: reports,
    // A delivery the runtime gave up on (its body never started, after its retries): the owner hears of it.
    // ...and a relay thread between agents that's run long today: a heads-up, never a stop (relay.mjs).
    notices: [...deliveryNotices(env), ...relayNotices(env), ...boxNotices(s)].sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, 20),
  };
}

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

/** The household's permissions: each piece's grant, who may relay to whom, and each agent's gates. */
function permissionsPage(env) {
  const st = permsStore(env);
  if (!st) return { title: 'Permissions', sections: [{ id: 'none', blocks: [{ type: 'text', tone: 'muted', text: 'The runtime reads its permissions from loom\'s store when loom runs it.' }] }] };
  const g = st.get(GRANTS, GRANTS_KEY);
  const sections = [];
  if (!g) {
    sections.push({ id: 'grants', title: 'Grants', blocks: [{ type: 'callout', tone: 'warn', title: 'Not seeded', text: 'No grants yet, so each piece decides by its own agent list, as before. `loom runtime grants seed` imports those lists; from then on the runtime decides first.' }] });
  } else {
    const bad = grantsProblem(g.doc);
    const rows = Object.entries(g.doc.pieces ?? {}).map(([p, by]) => [p, Object.entries(by).map(([a, ps]) => `${a === '*' ? 'every agent' : a}: ${ps.join(', ')}`).join('; '), g.doc.seeded?.from?.[p] ?? '']);
    sections.push({ id: 'grants', title: 'Grants', blocks: [
      ...(bad ? [{ type: 'callout', tone: 'bad', title: 'Can\'t be read', text: `${bad}: every agent's piece call is refused until it's fixed.` }] : []),
      { type: 'table', columns: ['Piece', 'Who may use it', 'Seeded from'], rows },
      { type: 'form', action: 'grants-set', submit: 'Save', note: 'One piece\'s grant: agents comma-separated, or * for every agent; paths * (all), a path, or a prefix ending in /*. Empty agents removes the piece\'s grant.',
        fields: [{ name: 'piece', label: 'Piece', kind: 'text', required: true }, { name: 'agents', label: 'Agents', kind: 'text' }, { name: 'paths', label: 'Paths', kind: 'text', value: '*' }],
        hidden: { rev: String(g.rev) } }] });
    const relay = Object.entries(g.doc.relay ?? {});
    const agents = householdOf(env)?.agents ?? [];
    sections.push({ id: 'relay', title: 'Who may relay to whom', blocks: [
      relay.length ? { type: 'kv', items: relay.map(([a, to]) => ({ label: a, value: to.join(', ') || 'no one' })) } : { type: 'text', tone: 'muted', text: 'No pairs.' },
      { type: 'text', tone: 'muted', text: 'An agent relays to these without asking (the relay tool). To any other, it asks you first: an approval on your Inbox, spent once.' },
      ...(agents.length > 1 ? [{ type: 'form', action: 'relay-set', submit: 'Save', note: 'One agent\'s pairs: the agents it may relay to without asking, comma-separated. Empty: it asks you before every relay.',
        fields: [{ name: 'agent', label: 'Agent', kind: 'text', required: true, hint: agents.join(', ') }, { name: 'to', label: 'Relays to', kind: 'text' }],
        hidden: { rev: String(g.rev) } }] : []),
    ] });
  }
  let held = {};
  try { held = gatesStatus(st); } catch { held = {}; }
  sections.push({ id: 'gates', title: 'Gates', blocks: [Object.keys(held).length
    ? { type: 'list', items: Object.keys(held).sort().map((a) => { const n = gateProposals(st, a).length; return { text: `${a}'s people`, meta: n ? `${n} waiting for you` : `revision ${held[a]}`, ...(n ? { tone: 'warn' } : {}), page: `gates/${a}` }; }) }
    : { type: 'text', tone: 'muted', text: 'The runtime holds no gates yet: `loom shuttle gates export --json | loom runtime gates import`.' }] });
  return { title: 'Permissions', intro: 'Which agent may use which piece (core asks the runtime before each call), who may relay to whom, and who each person is to each agent.', sections };
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

/** What a task house is doing, in a line: a wake's note (the clock puts it in the prompt), else the task's start. */
export function taskLine(task) {
  const w = wakeOf(shownTask(task));
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
export function houseName(h) {
  const who = cap(String(h.agent ?? ''));
  if (h.service) {
    if (h.service === 'remote') return `${who}'s house session`;
    return BRIDGE.test(h.service) ? `${who}'s ${cap(h.service)} bridge` : `${who}'s ${h.service}`;
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
  const lane = w.kind === 'schedule';
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
    const tasks = Object.values(s.houses).filter((h) => h.agent === a && !h.service && (h.state === 'running' || h.state === 'starting'))
      // Running first (it's what the agent is doing), then the newest.
      .sort((x, y) => (y.state === 'running') - (x.state === 'running') || Date.parse(y.created) - Date.parse(x.created));
    const readings = [];
    const bridges = mine.filter((v) => BRIDGE.test(v.name));
    if (bridges.length) {
      const bad = bridges.some((v) => !up(v) && late(v));
      readings.push({ label: 'Bridges', value: bridges.map((v) => `${v.name} ${up(v) ? '✓' : '✗'}`).join('  '), tone: bad ? 'bad' : 'ok' });
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
      ...(r && r.want === 'up' && busy[`box:${r.name}`] === true ? [{ text: 'A remote session', kind: 'session', where: `box session on ${boxLabelOf(s, r.box)}` }] : []),
      ...(rs && up(rs) && busy[`house:${rs.house}`] === true ? [{ text: 'A remote session', kind: 'session', where: 'house session' }] : []),
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

function boxesPage(env, nowMs, caller = OWNER) {
  // A box's logins and Update now are its owner's (control.mjs, assertBoxOwner): another household owner sees, doesn't press.
  const mayAct = (b) => isBoxOwner(env, caller, b.id);
  const s = load(env);
  const view = list(env, OWNER);
  const agents = Object.keys(s.agents).sort();
  const live = view.houses.filter((h) => LIVE.has(h.state));
  const sections = [];
  const waiting = live.some((h) => h.state === 'wanted');
  const live_boxes = view.boxes.filter((b) => !b.revoked).map((b) => ({ ...b, label: boxLabelOf(s, b.id) }));
  const nameOf = (id) => boxLabelOf(s, id);
  // The board: a card per box, what it is, and the houses on it now (a page holds ten sections, so past three boxes, one list).
  const svcOf = new Map(view.services.map((v) => [v.house, v.name]));
  if (live_boxes.length > 3) {
    sections.push({ id: 'all-boxes', title: 'Boxes', blocks: [{ type: 'list', items: live_boxes.map((b) => ({
      text: b.local ? `${b.label} · loom's own` : b.label, meta: `${live.filter((h) => h.box === b.id).length} houses · ${b.local ? 'here' : b.lastSeen ? `seen ${ago(b.lastSeen, nowMs)}` : 'not joined yet'}${b.lastSeen || b.local ? ` · ${runtimeRow(env, b, nowMs).meta}` : ''}`,
    })) }] });
  }
  for (const b of live_boxes.length > 3 ? [] : live_boxes) {
    const here = live.filter((h) => h.box === b.id);
    // The board's box card: how long it's been up, its disk, then the houses on it. The machine's facts a tap away.
    const disk = b.local ? diskUse(env) : null;
    sections.push({ id: `box-${b.id}`, title: b.local ? `${b.label} · loom's own` : b.label, tone: b.local || b.lastSeen ? undefined : 'warn', blocks: [
      { type: 'text', tone: 'muted', text: b.local ? `Up ${span(uptime() * 1000)}` : b.lastSeen ? `Seen ${ago(b.lastSeen, nowMs)}` : 'Not joined yet' },
      // Up front: which runtime it runs against loom's, and each harness: installed, logged in, or a Log in button.
      { type: 'list', items: [...(b.lastSeen || b.local ? [runtimeRow(env, b, nowMs, mayAct(b))] : []), ...harnessRows(s, b, nowMs, mayAct(b))] },
      ...runtimeHelp(env, b),
      ...(disk ? [{ type: 'meter', items: [{ label: 'Disk', value: disk.used, detail: `${disk.free} free`, ...(disk.used >= 0.95 ? { tone: 'bad' } : disk.used >= 0.85 ? { tone: 'warn' } : {}) }] }] : []),
      here.length
        ? { type: 'list', items: here.slice(0, 20).map((h) => ({ text: svcOf.has(h.id) ? `${h.agent}'s ${svcOf.get(h.id)}` : `${h.agent}'s house`, ...(svcOf.has(h.id) ? {} : { meta: short(houseName(h)) }), badge: h.state, tone: toneOf(h.state), agent: h.agent })) }
        : { type: 'text', tone: 'muted', text: 'No houses on it now.' },
      { type: 'details', summary: 'Machine', meta: b.local ? 'here' : '', blocks: [{ type: 'kv', items: [
        ...b.facts.map(factRow),
        { label: 'may host', value: mayHostText(b.mayHost) },
      ] }] },
    ] });
  }
  if (live_boxes.some((b) => !b.local)) sections.push({ id: 'boxes', title: 'Manage boxes', blocks: [
    ...live_boxes.filter((b) => !b.local).map((b) => ({
      type: 'details', summary: b.label, meta: b.lastSeen ? `seen ${ago(b.lastSeen, nowMs)}` : 'waiting for `loom box join`',
      blocks: [
        { type: 'form', title: `Who ${b.label} may host`, action: 'may-host', submit: 'Save', hidden: { name: b.id },
          fields: [{ name: 'may_host', label: 'Agents', kind: 'text', value: mayHostText(b.mayHost), hint: '"anyone", or agent names separated by commas' }] },
        { type: 'form', title: `Whose ${b.label} is`, action: 'box-owner', submit: 'Save', hidden: { name: b.id },
          fields: [{ name: 'owner', label: 'Owner', kind: 'text', value: b.owner ?? '', hint: 'a member; an agent\'s work runs only on its owner\'s boxes' }] },
        { type: 'form', title: `Lend ${b.label}`, action: 'box-lend', submit: 'Save', hidden: { name: b.id },
          fields: [{ name: 'agents', label: 'Other members\' agents', kind: 'text', value: (b.lentTo ?? []).join(', '), hint: 'agent names, or empty: their work runs on this box and its logins' }] },
        { type: 'buttons', items: [{ action: 'revoke-box', label: `Revoke ${b.label}`, tone: 'danger', fields: { name: b.id } }] },
      ],
    })),
  ] });

  sections.push(loginsSection(env, s, live_boxes, nowMs, live_boxes.length > 3));

  // Each agent's houses, services and sessions are its own (its Houses tab): here, a link each.
  if (agents.length) {
    sections.push({ id: 'agents', title: 'Each agent\'s houses', blocks: [{ type: 'list', items: agents.map((a) => {
      const up = live.filter((h) => h.agent === a).length;
      const svc = view.services.filter((v) => v.agent === a && v.want === 'up').length;
      return { text: a, agent: a, page: `agent:${a}`, meta: `${up} house${up === 1 ? '' : 's'} up · ${svc} service${svc === 1 ? '' : 's'} · primary ${primaryOf(s, a, env)}` };
    }) }] });
  }

  // Every box waiting to be let in (Home shows the newest few as cards), and a way to clear a flood.
  const asking = pendingJoins(s);
  if (asking.length) {
    sections.push({ id: 'joins', title: `Asking to join (${asking.length})`, blocks: [
      { type: 'list', items: asking.map((j) => ({ text: j.name, meta: `from ${j.address}, code ${j.code}`, tone: 'warn',
        act: { action: 'allow-join', label: 'Let it in', tone: 'primary', fields: { id: j.id }, confirm: `Let ${j.name} in only if its terminal shows code ${j.code}.` } })) },
      { type: 'buttons', items: [{ action: 'block-all-joins', label: 'Block all waiting', tone: 'danger', confirm: `Block all ${asking.length}?` }] },
    ] });
  }
  sections.push({ id: 'add', side: true, title: 'Add a box', blocks: [
    { type: 'text', tone: 'muted', text: 'Name the machine, then run `loom box join` on it with the credential shown after you add it.' },
    { type: 'form', action: 'add-box', submit: 'Add', fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, hint: 'Lowercase, e.g. thor or jonathan-laptop' },
      { name: 'may_host', label: 'May host', kind: 'text', value: 'anyone', hint: '"anyone", or agent names' },
      { name: 'labels', label: 'Labels', kind: 'text', hint: 'Optional, e.g. jonathan-rig' },
    ] },
  ] });

  sections.push({ id: 'new-agent', side: true, title: '', blocks: [
    { type: 'details', summary: 'Give an agent a house', blocks: [agentForm('', null)] },
    // Which agent may use which piece, who may relay to whom, and each agent's gates (agent-runtime.md, section 6).
    { type: 'list', items: [{ text: 'Permissions', meta: 'grants, relay pairs, gates', page: 'permissions' },
      { text: 'Now', meta: 'the bridges: who they\'re talking with, what waits, and the quota', page: 'now' }] }] });
  return { title: 'Boxes', intro: `${live_boxes.length} box${live_boxes.length === 1 ? '' : 'es'}, ${live.length} house${live.length === 1 ? '' : 's'} up${waiting ? ' or waiting' : ''}. A house is an agent's container, started for a task.`, sections };
}

const short7 = (c) => (c ? c.slice(0, 7) : '?');
/** When, from now: "in 5h", "in 20m", "any moment". */
const inTime = (iso, nowMs = Date.now()) => {
  const s = Math.round((Date.parse(iso) - nowMs) / 1000);
  if (!Number.isFinite(s) || s < 60) return 'any moment';
  if (s < 5400) return `in ${Math.round(s / 60)}m`;
  return `in ${Math.round(s / 3600)}h`;
};

/**
 * A box's runtime against loom's (version.mjs): up to date; updating…; why the last try failed and when it tries
 * again, with "Update now"; or too old to say (an old `box` piece: runtimeHelp says what to run on it).
 */
function runtimeRow(env, b, nowMs, may = true) {
  const loomC = ownCommit();
  const rt = b.runtime ?? {};
  const mine = rt.commit;
  const now = may ? { action: 'box-update-now', label: 'Update now', fields: { name: b.id } } : null;
  // loom's commit is ownCommit() alone, what it tells boxes to run: a dev checkout has none, so nothing to compare or press.
  if (!loomC) return { text: 'Runtime', meta: `${mine ? `${short7(mine)} · ` : ''}loom's version unknown`, tone: 'muted' };
  if (b.local && !mine) return { text: 'Runtime', meta: `${short7(loomC)} · loom's own`, tone: 'ok' };
  if (!mine) return { text: 'Runtime', meta: `too old to say which · loom's ${short7(loomC)}`, tone: 'warn', badge: 'old' };
  if (mine === loomC) return { text: 'Runtime', meta: `${short7(mine)} · up to date with loom's`, tone: 'ok' };
  const u = rt.upgrade?.commit === loomC ? rt.upgrade : null;
  const lag = `${short7(mine)} · loom's ${short7(loomC)}`;
  if (u && (u.state === 'failed' || u.state === 'refused')) {
    return { text: 'Runtime', meta: `${lag} · the update didn't work: ${u.error ?? 'no reason given'}${u.retryAt ? ` · tries again ${inTime(u.retryAt, nowMs)}` : ''}`, tone: 'bad', ...(now ? { act: { ...now, tone: 'primary' } } : {}) };
  }
  if (u?.state === 'rolling-back') return { text: 'Runtime', meta: `${lag} · the update didn't work; putting the ${rt.piece ?? 'old'} piece back: ${u.error ?? ''}`.trim(), tone: 'bad', badge: 'rolling back' };
  const swap = rt.piece && rt.piece !== 'runtime' ? `, swapping its ${rt.piece} piece for runtime` : '';
  // Updating, or about to (it tries on its next poll): the button only once it's been a while.
  const since = u?.at ? nowMs - Date.parse(u.at) : Infinity;
  return { text: 'Runtime', meta: `${lag} · updating…${swap}`, tone: 'warn', badge: 'updating…', ...(now && since > 10 * 60_000 && !(u && ['removing', 'installing'].includes(u.state)) ? { act: now } : {}) };
}

/** Below the runtime row: the failed update's last lines, or, for a box too old to report, the one line to run on it. */
function runtimeHelp(env, b) {
  const loomC = ownCommit();
  const rt = b.runtime ?? {};
  if (!loomC || b.local) return [];
  if (!rt.commit && b.lastSeen) {
    return [{ type: 'callout', tone: 'warn', title: 'This box is on the old box piece',
      text: `It can't update itself to the runtime piece: the two can't be installed side by side, and its version is older than the swap. Run this once on ${b.label}. It keeps its settings, data and houses (docs/upgrading.md).` },
    { type: 'code', label: `on ${b.label}`, text: swapCommand(loomC) }];
  }
  const u = rt.upgrade;
  if (rt.commit !== loomC && u?.commit === loomC && (u.state === 'failed' || u.state === 'refused') && u.detail) {
    return [{ type: 'details', summary: 'What the install said', blocks: [{ type: 'code', text: u.detail }] }];
  }
  return [];
}

/** How a login reads: "claude.ai, Max". */
const loginWords = (st) => [st?.method, st?.plan ? st.plan.charAt(0).toUpperCase() + st.plan.slice(1) : null].filter(Boolean)
  .map((w) => (w === 'chatgpt' ? 'ChatGPT' : w === 'api-key' ? 'API key' : w)).join(', ');

/**
 * Each harness on a box, as one row: not reported yet, not installed, unhealthy, signing in (its page), logged
 * in (how, and its plan; "Log in again"), or not (a "Log in" button; after a failed try, why, and "Try again").
 */
function harnessRows(s, b, nowMs, may = true) {
  void nowMs;
  const items = [];
  for (const [h, def] of Object.entries(LOGIN_HARNESSES)) {
    const st = b.harnesses?.[h];
    if (!st) { items.push({ text: def.label, meta: 'not reported yet', tone: 'muted' }); continue; }
    if (!st.installed) { items.push({ text: def.label, meta: st.unhealthy ? `can't sign in here: ${st.unhealthy}` : `${def.bin} isn't installed there`, tone: 'muted' }); continue; }
    if (st.unhealthy) { items.push({ text: def.label, meta: `not used: its login dir has something in it that shouldn't be (${st.unhealthy})`, tone: 'bad' }); continue; }
    const mine = Object.values(s.logins ?? {}).filter((l) => l.box === b.id && l.harness === h).sort((x, y) => Date.parse(y.created) - Date.parse(x.created));
    const under = mine.find((l) => !['done', 'failed'].includes(l.state));
    const start = { action: 'login-start', fields: { box: b.id, harness: h } };
    if (under) { items.push({ text: def.label, meta: 'signing in…', badge: 'signing in', tone: 'warn', ...(may ? { page: `login/${under.id}` } : {}) }); continue; }
    if (st.loggedIn) { items.push({ text: def.label, meta: `✓ logged in${loginWords(st) ? ` (${loginWords(st)})` : ''}`, tone: 'ok', ...(may ? { act: { ...start, label: 'Log in again' } } : {}) }); continue; }
    const lastFail = mine[0]?.state === 'failed' ? mine[0] : null;
    items.push({ text: def.label, meta: lastFail ? `not logged in · last try: ${lastFail.error}` : 'installed, not logged in', tone: lastFail ? 'bad' : 'warn',
      ...(lastFail && may ? { page: `login/${lastFail.id}` } : {}), ...(may ? { act: { ...start, label: lastFail ? 'Try again' : `Log in ${def.label}`, tone: 'primary' } } : {}) });
  }
  return items;
}

/**
 * Model logins (docs/model-accounts.md): the accounts the boxes' logins make, with how full each is. Each box's
 * harnesses are on its own card (harnessRows); here as well past three boxes, when there are no cards.
 */
function loginsSection(env, s, boxes, nowMs, rows) {
  const items = rows ? boxes.flatMap((b) => harnessRows(s, b, nowMs).map((r) => ({ ...r, text: `${b.label} · ${r.text}` }))) : [];
  let accounts = [];
  try { accounts = stateAccounts(env, { now: () => nowMs }).list().accounts; } catch { accounts = []; }
  const pct = (v) => `${Math.round(v * 100)}%`;
  return { id: 'logins', title: 'Model logins', blocks: [
    { type: 'text', tone: 'muted', text: 'Each box signs in to Claude and Codex itself, with its owner\'s own subscription: Log in runs the CLI\'s own login on that box. loom never sees the login.' },
    ...(items.length ? [{ type: 'list', items }] : boxes.some((b) => b.harnesses && Object.keys(b.harnesses).length) ? [] : [{ type: 'text', tone: 'muted', text: 'No box has reported its harnesses yet.' }]),
    ...(accounts.length ? [{ type: 'details', summary: 'Accounts', meta: `${accounts.length}`, blocks: [{ type: 'list', items: accounts.map((a) => {
      const w = Object.entries(a.usage).filter(([k]) => !k.startsWith('reset_') && k !== 'checked');
      return { text: a.label, meta: `${w.length ? w.map(([k, v]) => `${k} ${pct(v)}`).join(', ') : 'usage not read yet'}${a.boxes.length ? ` · on ${a.boxes.map((id) => boxLabelOf(s, id)).join(', ')}` : ''} · for ${a.agents.join(', ') || 'no agent'}` };
    }) }] }] : []),
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

/**
 * One agent's Houses tab (loom docs/extensions.md, agentTab): its houses, its services, its sessions, a house
 * to start; and, for a household owner, how its house is made and its primary box. An agent owner gets the
 * houses and services of an agent of theirs, as on their own page.
 */
function agentTabPage(env, agent, caller, nowMs) {
  const s = load(env);
  const own = Array.isArray(caller.agents) ? caller.agents : null;
  if (!s.agents[agent] || (own && !own.includes(agent))) return { title: 'Houses', sections: [{ id: 'none', blocks: [{ type: 'text', tone: 'muted', text: `${agent} has no house yet.${own ? '' : ' Give it one on the Boxes page.'}` }] }] };
  const view = list(env, caller);
  const houses = view.houses.filter((h) => h.agent === agent);
  const live = houses.filter((h) => LIVE.has(h.state));
  const nameOf = (id) => boxLabelOf(s, id);
  const live_boxes = view.boxes.filter((b) => !b.revoked).map((b) => ({ ...b, label: boxLabelOf(s, b.id) }));
  const sections = [{ id: 'houses', title: 'Houses', blocks: [
    live.length
      ? { type: 'list', items: live.slice(0, 30).map((h) => ({ text: short(houseName(h)), meta: nameOf(h.box), badge: h.state, tone: toneOf(h.state),
        ...(h.state === 'wanted' || h.state === 'running' || h.state === 'starting' ? { act: { action: 'down', label: 'Stop', tone: 'danger', fields: { id: h.id }, confirm: 'This house stops.' } } : {}) })) }
      : { type: 'text', tone: 'muted', text: 'No houses up now.' },
    ...(houses.length > live.length ? [{ type: 'details', summary: 'Recent', blocks: [{ type: 'table', columns: ['House', 'Box', 'State', 'Updated'],
      rows: houses.filter((h) => !LIVE.has(h.state)).slice(0, 20).map((h) => [short(houseName(h)), nameOf(h.box), h.state + (h.exit !== undefined ? ` (exit ${h.exit})` : ''), ago(h.updated, nowMs)]) }] }] : []),
  ] }];
  const svcs = view.services.filter((v) => v.agent === agent);
  if (svcs.length) {
    sections.push({ id: 'services', title: 'Services', blocks: [
      { type: 'list', items: svcs.map((v) => ({
        text: v.name,
        meta: v.want === 'up' ? `${v.moveTo ? `${nameOf(v.box)} → ${nameOf(v.moveTo)}` : nameOf(v.box)} · ${v.state ?? 'no house yet'}${v.restarts ? ` · ${v.restarts} restart${v.restarts === 1 ? '' : 's'}` : ''}` : 'down',
        tone: v.want !== 'up' ? 'muted' : v.state === 'running' ? 'ok' : v.state === 'failed' || v.state === 'lost' ? 'bad' : 'warn',
        act: v.want === 'up'
          ? { action: 'service-restart', label: 'Restart', ...(v.state === 'failed' || v.state === 'lost' ? { tone: 'primary' } : {}), fields: { agent: v.agent, name: v.name } }
          : { action: 'service-up', label: 'Up', tone: 'primary', fields: { agent: v.agent, name: v.name } },
      })) },
      ...svcs.filter((v) => v.want === 'up').slice(0, 8).map((v) => ({
        type: 'details', summary: v.name, meta: `on ${nameOf(v.box)}`,
        blocks: [
          ...(own ? [] : [{ type: 'form', title: `Move ${v.name}`, action: 'service-move', submit: 'Hand it off', hidden: { agent: v.agent, name: v.name },
            note: 'Stopped where it is, then started there: never two at once.',
            fields: [{ name: 'box', label: 'To', kind: 'choice', required: true, options: live_boxes.filter((b) => b.id !== v.box).map((b) => ({ value: b.id, label: b.label })) }] }]),
          { type: 'buttons', items: [{ action: 'service-down', label: `Take ${v.name} down`, tone: 'danger', fields: { agent: v.agent, name: v.name } }] },
        ],
      })),
    ] });
  }
  if (!own) {
    const sess = sessionsSection(env, s, view, agent);
    if (sess) sections.push(sess);
  }
  sections.push({ id: 'up', title: 'Start a house', blocks: [{ type: 'form', action: 'up', submit: 'Start it', hidden: { agent }, fields: [
    { name: 'box', label: 'Box', kind: 'choice', value: '', options: [{ value: '', label: `Its primary (${primaryOf(s, agent, env)}), or the one box that has what it needs` },
      ...live_boxes.map((b) => ({ value: b.id, label: b.label }))] },
    { name: 'needs', label: 'Needs', kind: 'text', hint: 'Optional, e.g. gpu:5090. A box that has it, and may host the agent.' },
    { name: 'task', label: 'Task', kind: 'textarea', required: true },
  ] }] });
  if (!own) {
    const c = s.agents[agent];
    sections.push({ id: `agent-${agent}`, title: 'Its house', side: true, blocks: [
      { type: 'kv', items: houseFacts(c) },
      { type: 'form', title: 'Primary box', action: 'set-primary', submit: 'Set', hidden: { agent }, fields: [
        { name: 'box', label: 'Primary', kind: 'choice', value: primaryOf(s, agent, env), options: live_boxes.map((b) => ({ value: b.id, label: b.label })) }] },
      { type: 'details', summary: `Change ${agent}'s house`, blocks: [agentForm(agent, c)] },
    ] });
  }
  return { title: 'Houses', intro: `${agent}'s houses: its containers, started for a task or kept up as a service.`, sections };
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

const AGENT_ACTIONS = new Set(['up', 'down', 'service-up', 'service-down', 'service-restart', 'service-move', 'remote-up', 'remote-down', 'set-primary', 'set-agent']);

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
      case 'gates-allow': case 'gates-deny': case 'gates-merge': case 'grants-set': case 'relay-set': {
        const st = permsStore(env);
        if (!st) return { ok: false, message: 'The runtime reads its permissions from loom\'s store when loom runs it.' };
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
          const who = String(fields.agents ?? '').trim();
          const rev = setPiece(st, { piece: String(fields.piece ?? '').trim(), agents: who === '*' ? '*' : who.split(',').map((x) => x.trim()).filter(Boolean),
            paths: String(fields.paths || '*').split(',').map((x) => x.trim()).filter(Boolean) });
          return { ok: true, message: `Saved ${fields.piece}'s grant (revision ${rev}); core asks it from the next call.`, page: 'permissions' };
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
