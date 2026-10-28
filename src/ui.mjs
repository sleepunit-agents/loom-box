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
import { addBox, boxLabelOf, factsOf, list, primaryOf, remoteDown, remoteUp, revokeBox, serviceDown, serviceMove, serviceRestart, serviceUp, setAgent, setMayHost, setPrimary, up, down, LIVE } from './control.mjs';

const OWNER = { kind: 'owner' };
const ago = (iso, nowMs = Date.now()) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
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
function sessionsSection(env, s, view) {
  const agents = Object.keys(s.agents).sort();
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
      items.push({ text: `${a}'s house: house session`, meta: rs.want === 'up' ? `${rs.state ?? 'starting'} · ${rs.house} on ${boxLabelOf(s, rs.box)}` : 'down', tone: rs.want !== 'up' ? 'muted' : rs.state === 'running' ? 'ok' : 'warn', agent: a, ...(link ? { href: link } : {}),
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
  const boxes = Object.values(s.boxes).filter((b) => !b.revoked);
  const live = Object.values(s.houses).filter((h) => LIVE.has(h.state));
  return {
    v: 2,
    // An agent owner sees their agents' houses and services here (loom docs/specs/owners.md).
    owners: 2,
    tab: { label: 'Boxes' },
    tile: {
      label: 'Boxes',
      value: `${boxes.length} box${boxes.length === 1 ? '' : 'es'}`,
      detail: live.length ? `${live.length} house${live.length === 1 ? '' : 's'} up or waiting` : 'no houses up',
      page: '',
    },
    // A box asking to join is the owner's call: the code is the one on the box's own terminal.
    asks: pendingJoins(s).slice(0, 5).map((j) => ({
      text: `A box asks to join: ${j.name}`,
      meta: `from ${j.address}, code ${j.code}${j.facts.length ? ` · ${j.facts.filter((f) => !f.startsWith('runtime:')).slice(0, 4).join(', ')}` : ''}`,
      tone: 'warn', at: j.at, page: '',
      actions: [
        { action: 'allow-join', label: 'Let it in', tone: 'primary', fields: { id: j.id }, confirm: `Let ${j.name} in only if its terminal shows code ${j.code}.` },
        { action: 'block-join', label: 'Block', tone: 'danger', fields: { id: j.id } },
      ],
    })),
    agents: agentReports(s, Date.now(), { ...reportedBusy(s), ...sessionsBusy(join(stateDir(env), 'session-cpu.json')) }),
    notices: boxNotices(s),
  };
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
    out.push({ text: `${boxLabelOf(s, id)} joined loom`, meta: factsOf(b).filter((f) => !f.startsWith('runtime:')).slice(0, 5).join(', '), at: b.joined, page: '' });
  }
  for (const h of Object.values(s.houses)) {
    if (h.service || h.state !== 'failed' || !h.updated || nowMs - Date.parse(h.updated) > NOTICE_WINDOW_MS) continue;
    const last = String(h.log ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
    out.push({ text: `${h.agent}'s house ${h.id} failed: ${taskLine(h.task)}`.slice(0, 300), meta: last.slice(0, 200), at: h.updated,
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
  return Number.isNaN(m) ? '' : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** What a task house is doing, in a line: a wake's note (the clock puts it in the prompt), else the task's start. */
export function taskLine(task) {
  let t = String(task ?? '');
  try { const j = JSON.parse(t); if (j && typeof j.prompt === 'string') t = j.prompt; } catch { /* plain text */ }
  const note = /\(wake id (w-[0-9a-f]+)[^)]*?note: ([^\n]*?)\)\.\s/.exec(t);
  if (note) return `${note[1]}: ${note[2]}`.slice(0, 120);
  return t.replace(/\s+/g, ' ').trim().slice(0, 120) || 'a task';
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
      if (busy[k] && up(rs)) working.push(`house session (${rs.house})`);
    }
    if (remote.length) readings.push({ label: 'Remote', value: remote.join(' · '), tone: (r && r.want === 'up' && r.error) ? 'warn' : undefined });
    if (tasks.length) readings.push({ label: 'Tasks', value: `${tasks.length} running`, detail: tasks.map((h) => `${h.id} on ${boxLabelOf(s, h.box)}`).slice(0, 3).join(', ') });
    const report = { readings: readings.map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined))).slice(0, 4) };
    if (failing.length) Object.assign(report, { state: 'broken', reason: `${failing.map((v) => v.name).join(' and ')} keep${failing.length === 1 ? 's' : ''} failing (${failing[0].restarts} restarts)` });
    else if (down.length) Object.assign(report, { state: 'unavailable', reason: `${down.map((v) => v.name).join(' and ')} ${down.length === 1 ? 'is' : 'are'} down` });
    else if (!tasks.length && working.length) Object.assign(report, { state: 'working', reason: `in a remote session: ${working.join(', ')}` });
    else if (tasks.length) {
      const h = tasks[0];
      Object.assign(report, { state: 'working', reason: `${taskLine(h.task)} · ${h.id} on ${boxLabelOf(s, h.box)}${h.started ? ` · ${shortAge(h.started, nowMs)}` : ` · ${h.state}`}` });
    }
    if (report.state || report.readings.length) out[a] = report;
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

function boxesPage(env, nowMs) {
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
      text: b.local ? `${b.label} · loom's own` : b.label, meta: `${live.filter((h) => h.box === b.id).length} houses · ${b.local ? 'here' : b.lastSeen ? `seen ${ago(b.lastSeen, nowMs)}` : 'not joined yet'}`,
    })) }] });
  }
  for (const b of live_boxes.length > 3 ? [] : live_boxes) {
    const here = live.filter((h) => h.box === b.id);
    // The board's box card: how long it's been up, its disk, then the houses on it. The machine's facts a tap away.
    const disk = b.local ? diskUse(env) : null;
    sections.push({ id: `box-${b.id}`, title: b.local ? `${b.label} · loom's own` : b.label, tone: b.local || b.lastSeen ? undefined : 'warn', blocks: [
      { type: 'text', tone: 'muted', text: b.local ? `Up ${span(uptime() * 1000)}` : b.lastSeen ? `Seen ${ago(b.lastSeen, nowMs)}` : 'Not joined yet' },
      ...(disk ? [{ type: 'meter', items: [{ label: 'Disk', value: disk.used, detail: `${disk.free} free`, ...(disk.used >= 0.95 ? { tone: 'bad' } : disk.used >= 0.85 ? { tone: 'warn' } : {}) }] }] : []),
      here.length
        ? { type: 'list', items: here.slice(0, 20).map((h) => ({ text: svcOf.has(h.id) ? `${h.agent}'s ${svcOf.get(h.id)}` : `${h.agent}'s house`, meta: h.id, badge: h.state, tone: toneOf(h.state), agent: h.agent })) }
        : { type: 'text', tone: 'muted', text: 'No houses on it now.' },
      { type: 'details', summary: 'Machine', meta: b.local ? 'here' : '', blocks: [{ type: 'kv', items: [
        ...b.facts.map((f) => { const i = f.indexOf(':'); return i > 0 ? { label: f.slice(0, i), value: f.slice(i + 1) } : { label: f, value: 'yes' }; }),
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
        { type: 'buttons', items: [{ action: 'revoke-box', label: `Revoke ${b.label}`, tone: 'danger', fields: { name: b.id } }] },
      ],
    })),
  ] });

  if (view.services.length) {
    sections.push({ id: 'services', title: 'Services', blocks: [
      // Restart at each row's right: its house stops and the service brings up a fresh one (what fixes a stuck bridge).
      { type: 'list', items: view.services.map((v) => ({
        text: v.service, agent: v.agent,
        meta: v.want === 'up' ? `${v.moveTo ? `${nameOf(v.box)} → ${nameOf(v.moveTo)}` : nameOf(v.box)} · ${v.house} ${v.state ?? ''}${v.restarts ? ` · ${v.restarts} restart${v.restarts === 1 ? '' : 's'}` : ''}` : 'down',
        tone: v.want !== 'up' ? 'muted' : v.state === 'running' ? 'ok' : v.state === 'failed' || v.state === 'lost' ? 'bad' : 'warn',
        ...(v.want === 'up' ? { act: { action: 'service-restart', label: 'Restart', ...(v.state === 'failed' || v.state === 'lost' ? { tone: 'primary' } : {}), fields: { agent: v.agent, name: v.name } } } : {}),
      })) },
      ...view.services.slice(0, 8).map((v) => ({
        type: 'details', summary: v.service, meta: v.want === 'up' ? `on ${nameOf(v.box)}` : 'down',
        blocks: [
          ...(v.want === 'up' ? [{ type: 'form', title: `Move ${v.service}`, action: 'service-move', submit: 'Hand it off', hidden: { agent: v.agent, name: v.name },
            note: 'Stopped where it is, then started there: never two at once.',
            fields: [{ name: 'box', label: 'To', kind: 'choice', required: true, options: live_boxes.filter((b) => b.id !== v.box).map((b) => ({ value: b.id, label: b.label })) }] }] : []),
          { type: 'buttons', items: [v.want === 'up'
            ? { action: 'service-down', label: `Take ${v.name} down`, tone: 'danger', fields: { agent: v.agent, name: v.name } }
            : { action: 'service-up', label: `Bring ${v.name} up`, tone: 'primary', fields: { agent: v.agent, name: v.name } }] },
        ],
      })),
    ] });
  }

  const sess = sessionsSection(env, s, view);
  if (sess) sections.push(sess);

  sections.push({ id: 'houses', title: 'Houses', blocks: view.houses.length ? [
    { type: 'table', columns: ['House', 'Agent', 'Box', 'State', 'Task', 'Updated'], rows: view.houses.slice(0, 25).map((h) => [
      h.id, h.agent, nameOf(h.box), h.state + (h.exit !== undefined ? ` (exit ${h.exit})` : ''), short(h.task), ago(h.updated, nowMs),
    ]) },
    ...(live.length ? [{ type: 'buttons', items: live.slice(0, 10).map((h) => ({ action: 'down', label: `Stop ${h.id}`, fields: { id: h.id } })) }] : []),
  ] : [{ type: 'text', tone: 'muted', text: 'No houses yet.' }] });

  if (agents.length) {
    sections.push({ id: 'up', title: 'Start a house', blocks: [{ type: 'form', action: 'up', submit: 'Start it', fields: [
      { name: 'agent', label: 'Agent', kind: 'choice', required: true, options: agents.map((a) => ({ value: a, label: a, detail: `primary: ${primaryOf(s, a, env)}` })) },
      { name: 'box', label: 'Box', kind: 'choice', value: '', options: [{ value: '', label: 'Its primary, or the one box that has what it needs' },
        ...live_boxes.map((b) => ({ value: b.id, label: b.label }))] },
      { name: 'needs', label: 'Needs', kind: 'text', hint: 'Optional, e.g. gpu:5090. A box that has it, and may host the agent.' },
      { name: 'task', label: 'Task', kind: 'textarea', required: true },
    ] }] });
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

  if (agents.length) {
    sections.push({ id: 'primaries', side: true, title: 'Primaries', blocks: [
      { type: 'link', text: `Agents' houses (${agents.length})`, page: 'agents' },
      { type: 'kv', items: agents.map((a) => ({ label: a, value: primaryOf(s, a, env) })) },
      { type: 'form', action: 'set-primary', submit: 'Set', fields: [
        { name: 'agent', label: 'Agent', kind: 'choice', required: true, options: agents.map((a) => ({ value: a, label: a })) },
        { name: 'box', label: 'Primary', kind: 'choice', options: live_boxes.map((b) => ({ value: b.id, label: b.label })) },
      ] },
    ] });
  }
  return { title: 'Boxes', intro: `${live_boxes.length} box${live_boxes.length === 1 ? '' : 'es'}, ${live.length} house${live.length === 1 ? '' : 's'} up${waiting ? ' or waiting' : ''}. A house is an agent's container, started for a task.`, sections };
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

function agentsPage(env) {
  const s = load(env);
  const sections = Object.entries(s.agents).sort().slice(0, 8).map(([a, c]) => ({
    id: `agent-${a}`, title: a, blocks: [
      { type: 'kv', items: [
        { label: 'Repo', value: c.repo }, { label: 'House file', value: c.houseFile || 'house/house.json' },
        { label: 'Nested containers', value: c.nested ? 'allowed' : 'not allowed' },
        { label: 'GPU', value: c.gpu ? 'allowed' : 'not allowed' },
        { label: 'Ports it may publish', value: (c.ports ?? []).map((g) => `${g.ip}:${g.port}`).join(', ') || 'none' },
        { label: 'Tailnets', value: (c.tailnets ?? []).map((g) => g.name).join(', ') || 'none' },
        { label: 'Branch', value: c.branch || 'default' }, { label: 'Repo secret', value: c.repoSecret || 'none' },
        { label: 'Secrets a house gets', value: Object.entries(c.secrets || {}).map(([k, v]) => (k === v ? k : `${k} (from ${v})`)).join(', ') || 'none' },
      ] },
      ...sessionControls(env, s, a, s.remotes?.[a] && { agent: a, ...s.remotes[a] }),
      agentForm(a, c),
    ],
  }));
  sections.push({ id: 'new', title: 'Give an agent a house', blocks: [agentForm('', null)] });
  return { title: 'Agents\' houses', intro: 'How each agent\'s house is made. A box gets only these secrets, and only for a house it was given.', sections };
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
    ? { type: 'list', items: live.slice(0, 30).map((h) => ({ text: `${h.agent}'s house`, meta: `${h.id} · ${h.state}`, badge: h.state, tone: toneOf(h.state), agent: h.agent,
      ...(h.state === 'wanted' || h.state === 'running' || h.state === 'starting' ? { act: { action: 'down', label: 'Stop', tone: 'danger', fields: { id: h.id }, confirm: `${h.id} stops.` } } : {}) })) }
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
  if (Array.isArray(caller.agents)) return path === '' || path === undefined ? agentOwnerPage(env, caller, nowMs) : { title: 'Not found', sections: [] };
  if (path === '' || path === undefined) return boxesPage(env, nowMs);
  if (path === 'agents') return agentsPage(env);
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
export function act(env, effects, { action, fields: raw = {}, caller: c }, publicUrl) {
  const OWNER = pageCaller(c);
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
      case 'set-primary': { const r = setPrimary(env, effects, fields); return { ok: true, message: `${r.agent}'s primary is ${label(r.primary)}.`, page: '' }; }
      case 'set-agent': { const r = setAgent(env, effects, fields); return { ok: true, message: `Saved ${r.agent}'s house.`, page: 'agents' }; }
      case 'up': {
        const r = up(env, effects, OWNER, { agent: fields.agent, box: fields.box, needs: fields.needs, task: fields.task });
        return { ok: true, message: `${r.id}: ${r.agent} on ${label(r.box)}, waiting for the box to start it.`, page: '' };
      }
      case 'down': { const r = down(env, effects, OWNER, fields); return { ok: true, message: `${r.id} is ${r.state}.`, page: '' }; }
      case 'remote-up': {
        const r = remoteUp(env, effects, { agent: fields.agent, box: fields.box, dir: fields.dir });
        return { ok: true, message: `"${r.name}" is starting; its link shows here in a few seconds.`, page: 'agents' };
      }
      case 'remote-down': { const r = remoteDown(env, effects, fields); return { ok: true, message: `"${r.name}" is going down.`, page: 'agents' }; }
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
