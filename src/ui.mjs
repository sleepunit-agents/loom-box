// The Boxes tab on loom's page (loom docs/extensions.md, "The page"): the
// boxes, what each has and may host, the houses asked for, and the owner's
// controls. Data only; loom renders it. Every action is the owner's (the page
// is), and a box's credential is shown once, in the message after adding it.
import { StateError, load, localBoxName } from './state.mjs';
import { addBox, factsOf, list, primaryOf, remoteDown, remoteUp, revokeBox, serviceDown, serviceMove, serviceUp, setAgent, setMayHost, setPrimary, up, down, LIVE } from './control.mjs';

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

export function manifest(env) {
  const s = load(env);
  const boxes = Object.values(s.boxes).filter((b) => !b.revoked);
  const live = Object.values(s.houses).filter((h) => LIVE.has(h.state));
  return {
    v: 2,
    tab: { label: 'Boxes' },
    tile: {
      label: 'Boxes',
      value: `${boxes.length} box${boxes.length === 1 ? '' : 'es'}`,
      detail: live.length ? `${live.length} house${live.length === 1 ? '' : 's'} up or waiting` : 'no houses up',
      page: '',
    },
    asks: [],
  };
}

function boxesPage(env, nowMs) {
  const s = load(env);
  const view = list(env, OWNER);
  const agents = Object.keys(s.agents).sort();
  const live = view.houses.filter((h) => LIVE.has(h.state));
  const sections = [];
  const waiting = live.some((h) => h.state === 'wanted');
  sections.push({ id: 'summary', blocks: [{ type: 'stats', items: [
    { label: 'Boxes', value: String(view.boxes.filter((b) => !b.revoked).length) },
    { label: 'Houses up or waiting', value: String(live.length), ...(waiting ? { tone: 'warn' } : {}) },
    { label: 'Agents with a house', value: String(agents.length), page: 'agents' },
  ] }] });

  const live_boxes = view.boxes.filter((b) => !b.revoked);
  sections.push({ id: 'boxes', title: 'Boxes', blocks: [
    { type: 'table', columns: ['Box', 'Has', 'May host', 'Last seen', 'Houses'], rows: live_boxes.map((b) => [
      b.local ? `${b.name} (loom's own)` : b.name,
      b.facts.join(', ') || (b.local ? '' : 'not joined yet'),
      mayHostText(b.mayHost),
      b.local ? 'here' : ago(b.lastSeen, nowMs),
      String(live.filter((h) => h.box === b.name).length),
    ]) },
    ...live_boxes.filter((b) => !b.local).map((b) => ({
      type: 'details', summary: b.name, meta: b.lastSeen ? `seen ${ago(b.lastSeen, nowMs)}` : 'waiting for `loom box join`',
      blocks: [
        { type: 'form', title: `Who ${b.name} may host`, action: 'may-host', submit: 'Save', hidden: { name: b.name },
          fields: [{ name: 'may_host', label: 'Agents', kind: 'text', value: mayHostText(b.mayHost), hint: '"anyone", or agent names separated by commas' }] },
        { type: 'buttons', items: [{ action: 'revoke-box', label: `Revoke ${b.name}`, tone: 'danger', fields: { name: b.name } }] },
      ],
    })),
  ] });

  if (view.services.length) {
    sections.push({ id: 'services', title: 'Services', blocks: [
      { type: 'table', columns: ['Service', 'Box', 'Wanted', 'House', 'Restarts', 'State saved'], rows: view.services.map((v) => [
        v.service, v.moveTo ? `${v.box} → ${v.moveTo}` : v.box, v.want, `${v.house} ${v.state ?? ''}`, String(v.restarts), ago(v.stateSaved, nowMs),
      ]) },
      ...view.services.slice(0, 8).map((v) => ({
        type: 'details', summary: v.service, meta: v.want === 'up' ? `on ${v.box}` : 'down',
        blocks: [
          ...(v.want === 'up' ? [{ type: 'form', title: `Move ${v.service}`, action: 'service-move', submit: 'Hand it off', hidden: { agent: v.agent, name: v.name },
            note: 'Stopped where it is, then started there: never two at once.',
            fields: [{ name: 'box', label: 'To', kind: 'choice', required: true, options: live_boxes.filter((b) => b.name !== v.box).map((b) => ({ value: b.name, label: b.name })) }] }] : []),
          { type: 'buttons', items: [v.want === 'up'
            ? { action: 'service-down', label: `Take ${v.name} down`, tone: 'danger', fields: { agent: v.agent, name: v.name } }
            : { action: 'service-up', label: `Bring ${v.name} up`, tone: 'primary', fields: { agent: v.agent, name: v.name } }] },
        ],
      })),
    ] });
  }

  const upSessions = view.remotes.filter((r) => r.want === 'up');
  if (upSessions.length) {
    sections.push({ id: 'box-sessions', title: 'Box sessions', blocks: [
      { type: 'text', tone: 'muted', text: 'Claude on a box itself, not in a house: the box\'s whole reach. Take it down when the work is done.' },
      ...upSessions.flatMap(sessionBlocks),
    ] });
  }

  sections.push({ id: 'houses', title: 'Houses', blocks: view.houses.length ? [
    { type: 'table', columns: ['House', 'Agent', 'Box', 'State', 'Task', 'Updated'], rows: view.houses.slice(0, 25).map((h) => [
      h.id, h.agent, h.box, h.state + (h.exit !== undefined ? ` (exit ${h.exit})` : ''), short(h.task), ago(h.updated, nowMs),
    ]) },
    ...(live.length ? [{ type: 'buttons', items: live.slice(0, 10).map((h) => ({ action: 'down', label: `Stop ${h.id}`, fields: { id: h.id } })) }] : []),
  ] : [{ type: 'text', tone: 'muted', text: 'No houses yet.' }] });

  if (agents.length) {
    sections.push({ id: 'up', title: 'Start a house', blocks: [{ type: 'form', action: 'up', submit: 'Start it', fields: [
      { name: 'agent', label: 'Agent', kind: 'choice', required: true, options: agents.map((a) => ({ value: a, label: a, detail: `primary: ${primaryOf(s, a, env)}` })) },
      { name: 'box', label: 'Box', kind: 'choice', value: '', options: [{ value: '', label: 'Its primary, or the one box that has what it needs' },
        ...live_boxes.map((b) => ({ value: b.name, label: b.name }))] },
      { name: 'needs', label: 'Needs', kind: 'text', hint: 'Optional, e.g. gpu:5090. A box that has it, and may host the agent.' },
      { name: 'task', label: 'Task', kind: 'textarea', required: true },
    ] }] });
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
      { type: 'kv', items: agents.map((a) => ({ label: a, value: primaryOf(s, a, env) })) },
      { type: 'form', action: 'set-primary', submit: 'Set', fields: [
        { name: 'agent', label: 'Agent', kind: 'choice', required: true, options: agents.map((a) => ({ value: a, label: a })) },
        { name: 'box', label: 'Primary', kind: 'choice', options: live_boxes.map((b) => ({ value: b.name, label: b.name })) },
      ] },
    ] });
  }
  return { title: 'Boxes', intro: 'Machines that run houses: an agent\'s container, started for a task. Nothing picks a box by itself.', sections };
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
      { name: 'box', label: 'Box', kind: 'choice', value: r?.box ?? primaryOf(s, a, env), options: boxes.map((n) => ({ value: n, label: n })) },
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
        { label: 'Ports it may publish', value: (c.ports ?? []).map((g) => `${g.ip}:${g.port}`).join(', ') || 'none' },
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
    { name: 'ports', label: 'Ports', kind: 'text', value: (c?.ports ?? []).map((g) => `${g.ip}:${g.port}`).join(', '), hint: 'Ports a house may publish on its box: 7401 binds loopback, 0.0.0.0:7401 every interface' },
    { name: 'branch', label: 'Branch', kind: 'text', value: c?.branch ?? '' },
    { name: 'repo_secret', label: 'Repo secret', kind: 'text', value: c?.repoSecret ?? '', hint: 'A secrets-store name, for a private repo over https' },
    { name: 'secrets', label: 'Secrets', kind: 'text', value: Object.entries(c?.secrets || {}).map(([k, v]) => `${k}=${v}`).join(', '), hint: 'name-in-house=store-name, comma separated' },
  ].map((f) => (f.value === '' ? (({ value: _v, ...r }) => r)(f) : f)) };
}

export function page(env, { path }, nowMs = Date.now()) {
  if (path === '' || path === undefined) return boxesPage(env, nowMs);
  if (path === 'agents') return agentsPage(env);
  return { title: 'Not found', sections: [] };
}

/** The page's actions. The page is the owner's, so each runs as the owner. */
export function act(env, effects, { action, fields: raw = {} }, publicUrl) {
  // The page's field names are lowercase (loom's vocabulary); the runtime's are camelCase.
  const fields = { ...raw };
  for (const [from, to] of [['may_host', 'mayHost'], ['house_file', 'houseFile'], ['repo_secret', 'repoSecret']]) {
    if (from in fields) { fields[to] = fields[from]; delete fields[from]; }
  }
  try {
    switch (action) {
      case 'add-box': {
        const { box, token } = addBox(env, effects, fields);
        const url = publicUrl || '<this loom\'s URL>';
        return { ok: true, message: `Added ${box}. On ${box}, run \`loom box join ${url} --name ${box}\` and paste this credential when it asks (shown this once): ${token}`, page: '' };
      }
      case 'revoke-box': revokeBox(env, effects, fields); return { ok: true, message: `Revoked ${fields.name}. Its houses lost their tokens.`, page: '' };
      case 'may-host': setMayHost(env, effects, fields); return { ok: true, message: `Saved who ${fields.name} may host.`, page: '' };
      case 'set-primary': { const r = setPrimary(env, effects, fields); return { ok: true, message: `${r.agent}'s primary is ${r.primary}.`, page: '' }; }
      case 'set-agent': { const r = setAgent(env, effects, fields); return { ok: true, message: `Saved ${r.agent}'s house.`, page: 'agents' }; }
      case 'up': {
        const r = up(env, effects, OWNER, { agent: fields.agent, box: fields.box, needs: fields.needs, task: fields.task });
        return { ok: true, message: `${r.id}: ${r.agent} on ${r.box}, waiting for the box to start it.`, page: '' };
      }
      case 'down': { const r = down(env, effects, OWNER, fields); return { ok: true, message: `${r.id} is ${r.state}.`, page: '' }; }
      case 'remote-up': {
        const r = remoteUp(env, effects, { agent: fields.agent, box: fields.box, dir: fields.dir });
        return { ok: true, message: `"${r.name}" is starting; its link shows here in a few seconds.`, page: 'agents' };
      }
      case 'remote-down': { const r = remoteDown(env, effects, fields); return { ok: true, message: `"${r.name}" is going down.`, page: 'agents' }; }
      case 'service-up': { const r = serviceUp(env, effects, OWNER, fields); return { ok: true, message: `${r.service} is coming up on ${r.box}.`, page: '' }; }
      case 'service-down': { const r = serviceDown(env, effects, OWNER, fields); return { ok: true, message: `${r.service} is going down.`, page: '' }; }
      case 'service-move': {
        const r = serviceMove(env, effects, OWNER, fields);
        return { ok: true, message: r.moving ? `${r.service}: stopping on ${r.box}; it starts on ${r.moveTo} once that's confirmed.` : `${r.service} is on ${r.box}.`, page: '' };
      }
      default: return { ok: false, message: `No action ${action}.` };
    }
  } catch (err) {
    if (err instanceof StateError) return { ok: false, message: err.message };
    process.stderr.write(`loom-box: ${err.stack || err}\n`);
    return { ok: false, message: 'The runtime failed; see the daemon log.' };
  }
}

export { localBoxName, factsOf };
