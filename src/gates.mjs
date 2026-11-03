// Gates (loom docs/specs/agent-runtime.md, "6. Permissions", Gates; bridges.md, "Who someone is"): who a platform id
// is, and what each person may do with each agent (tiers, grants, restricts). They were shuttle's (its `people`
// collection, shuttle/gates.py); they're the runtime's now, in its own owner-written collection `gates`, one document
// per agent, in the shape shuttle's bridges read: {"people": {<slug>: entry}, "agents": {<slug>: entry}, _notes}.
//
//  - A gate entry names a person card: its key is the person's card slug (person-cards.md), and the card is where that
//    person is one person. The entry holds only what gates (tier, grant, restrict, venues) and their platform ids.
//  - Adding one ensures the card, through core's POST /api/loom/people/ensure with the runtime's token: a minimal card
//    when there's none (name, role, where the entry came from: its platform ids), else only the ids it lacks. The gate
//    write stands when the ensure fails, and the owner's answer says so.
//  - A card merge is followed by the gates: merging `from` into `into` (POST /api/loom/people/merge) renames `from` to
//    `into` in every agent's gates.
//  - Moving in: `loom shuttle gates export --json | loom runtime gates import`, the owner's run. Each piece touches
//    only its own store: shuttle reads its, the runtime writes its. The import refuses anything but an owner's run.
//  - A body proposes one person (`gates propose`, or shuttle's `propose-person`, which hands it here once the runtime
//    has the agent's gates); the owner allows or denies it from the Inbox or the agent's gates page. Allow merges that
//    one entry into the document as it is then; nothing proposes tier 3. A follow-up message the body asked for goes to
//    the agent as a relay delivery once allowed.
//  - Bridges keep reading their agent's gates where they always have (shuttle's `people`), and shuttle answers from
//    here once the runtime has them (`loom runtime gates people --agent <a> --json`): refreshed within a minute.
import { createHash, randomBytes } from 'node:crypto';
import { StoreError } from './store.mjs';

export const GATES = 'gates';          // owner: an agent's people document, key = the agent
export const PROPOSALS = 'gate-proposals';   // piece: one person a body asks the owner to add or change, key <agent>.<id>
export const AGENT = /^[a-z][a-z0-9-]{0,39}$/;
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLATFORM_ID = /^[A-Za-z0-9]{1,24}$/;
const PROPOSAL_ID = /^p-[0-9a-f]{6}$/;
export const FIELDS = ['name', 'role', 'tier', 'slack', 'discord', 'venues'];
const NAME_MAX = 80, ROLE_MAX = 80, IDS_MAX = 3, TEAMS_MAX = 2, VENUE_MAX = 40, VENUES_MAX = 6, WHY_MAX = 300, SAY_MAX = 600;
export const PENDING_MAX = 10;
const PLATFORMS = ['slack', 'discord'];
export const VIAS = ['slack'];
const TEXT_MAX = 2000, TITLE_MAX = 300;

export class GateError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
/** JSON with sorted keys, so a hash is the same however the document was written. */
const stable = (v) => JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const cut = (s, n = 300) => { s = String(s); return s.length <= n ? s : `${s.slice(0, n - 1)}…`; };

// ---------------------------------------------------------------- the document

/** Why a people document isn't one, or null (shuttle's gates.valid). */
export function valid(doc) {
  if (!isObj(doc)) return 'it\'s a JSON object';
  if (Object.keys(doc).some((k) => !k.startsWith('_') && k !== 'people' && k !== 'agents')) return 'it has people, agents (and _notes) and nothing else';
  for (const s of ['people', 'agents']) if (s in doc && !isObj(doc[s])) return `${s} maps a slug to an entry`;
  return null;
}

/** {platform user id: [slug, record]} as the bridges' gate reads it (shuttle's selvedge.index). Never throws. */
export function index(doc, platform, team, sections = ['agents', 'people']) {
  const out = {};
  if (!isObj(doc)) return out;
  for (const section of sections) {
    const entries = doc[section];
    if (!isObj(entries)) continue;
    for (const [slug, rec] of Object.entries(entries)) {
      if (slug.startsWith('_') || !isObj(rec)) continue;
      let ids = rec[platform];
      if (isObj(ids)) ids = ids[team];
      if (typeof ids === 'string' || typeof ids === 'number') ids = [ids];
      if (!Array.isArray(ids)) continue;
      for (const u of ids) if ((typeof u === 'string' || typeof u === 'number')) out[String(u)] = [slug, { ...rec, agent: section === 'agents' }];
    }
  }
  return out;
}

const idList = (v, what) => (Array.isArray(v) && v.length >= 1 && v.length <= IDS_MAX && v.every((u) => typeof u === 'string' && PLATFORM_ID.test(u))
  ? null : `${what} is a list of 1 to ${IDS_MAX} user ids (letters and digits, 24 at most)`);

/** Why `entry` isn't one person a body may propose, or null. */
export function entryProblem(entry) {
  if (!isObj(entry)) return '--entry is one person, a JSON object';
  const extra = Object.keys(entry).filter((k) => !FIELDS.includes(k)).sort();
  if (extra.length) return `a proposed entry carries only ${FIELDS.join(', ')}; not ${extra.join(', ')}`;
  if (entry.tier === 3) return 'a body can\'t propose tier 3: that\'s the owner\'s to give';
  if (entry.tier !== 1 && entry.tier !== 2) return 'tier is 1 (a guest, only in its venues) or 2 (trusted)';
  if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > NAME_MAX) return `name is the person's name, ${NAME_MAX} characters at most`;
  if ('role' in entry && !(typeof entry.role === 'string' && entry.role.length <= ROLE_MAX)) return `role is a few words, ${ROLE_MAX} characters at most`;
  if ('discord' in entry) { const w = idList(entry.discord, 'discord'); if (w) return w; }
  if ('slack' in entry) {
    const sl = entry.slack;
    if (!(isObj(sl) && Object.keys(sl).length >= 1 && Object.keys(sl).length <= TEAMS_MAX && Object.keys(sl).every((t) => PLATFORM_ID.test(t)))) {
      return `slack maps 1 to ${TEAMS_MAX} team ids to user ids: {"T...": ["U..."]}`;
    }
    for (const [t, us] of Object.entries(sl)) { const w = idList(us, `slack ${t}`); if (w) return w; }
  }
  if ('venues' in entry && !(Array.isArray(entry.venues) && entry.venues.length <= VENUES_MAX && entry.venues.every((v) => typeof v === 'string' && v.length > 0 && v.length <= VENUE_MAX))) {
    return `venues is a list of up to ${VENUES_MAX} places, ${VENUE_MAX} characters each`;
  }
  return null;
}

const readable = (v) => {
  const one = (u) => typeof u === 'string' || typeof u === 'number';
  return one(v) || (Array.isArray(v) && v.every(one));
};

/** Where the document has an entry the gate's parser would skip, or null. */
export function unreadable(doc) {
  for (const section of ['agents', 'people']) {
    const entries = doc?.[section];
    if (entries === undefined || entries === null) continue;
    if (!isObj(entries)) return `its ${section} isn't a map of entries`;
    for (const [slug, rec] of Object.entries(entries)) {
      if (slug.startsWith('_')) continue;
      if (!isObj(rec)) return `${section} ${slug} isn't an entry`;
      for (const p of PLATFORMS) {
        const v = rec[p];
        if (v === undefined || v === null) continue;
        if (p === 'slack' && isObj(v)) { if (!Object.values(v).every(readable)) return `${section} ${slug}'s slack ids aren't in a shape the gate reads`; }
        else if (!readable(v)) return `${section} ${slug}'s ${p} ids aren't in a shape the gate reads`;
      }
    }
  }
  return null;
}

const claimed = (entry) => [
  ...(entry.discord ?? []).map((u) => ['discord', undefined, u]),
  ...Object.entries(entry.slack ?? {}).flatMap(([t, us]) => us.map((u) => ['slack', t, u])),
];

/** The first id in `entry` the gate already gives someone else, or null. */
export function collision(slug, entry, doc) {
  for (const [platform, team, uid] of claimed(entry)) {
    for (const section of ['agents', 'people']) {
      const hit = index(doc, platform, team, [section])[String(uid)];
      if (hit && (section === 'agents' || hit[0] !== slug)) return `${platform} id ${uid} is already ${section === 'agents' ? 'the agent ' : ''}${hit[0]}'s`;
    }
  }
  return null;
}

/** `slug`'s entry once `entry` is merged: the proposed fields, and what the owner gave it before kept. */
export function after(doc, slug, entry) {
  const cur = doc?.people?.[slug];
  const kept = isObj(cur) ? Object.fromEntries(Object.entries(cur).filter(([k]) => !FIELDS.includes(k))) : {};
  return { ...kept, ...entry };
}

/** Why a body may not propose `entry` as `slug` in `doc`, or null. */
export function personProblem(slug, entry, doc) {
  if (!SLUG.test(slug ?? '')) return '--slug is a person\'s slug: lowercase letters, digits and -';
  const before = isObj(doc) && isObj(doc.people) ? doc.people[slug] : undefined;
  if (isObj(before) && before.tier === 3) return `${slug} is tier 3; only the owner changes a tier 3 entry`;
  const why = entryProblem(entry) ?? valid({ people: { [slug]: entry } });
  if (why) return why;
  const docWhy = valid(doc) ?? unreadable(doc);
  if (docWhy) return `the people document can't be checked: ${docWhy}; the owner fixes that first`;
  return collision(slug, entry, doc);
}

/** A copy of `doc` with `slug`'s entry merged. */
export function mergeInto(doc, slug, entry) {
  const out = clone(doc);
  (out.people ??= {})[slug] = after(doc, slug, entry);
  return out;
}

/** What the owner was shown: the proposal and the entry as it is now. Allow refuses when this changed. */
export function seen(p, doc) {
  return createHash('sha256').update(stable([p?.id, p?.entry, doc?.people?.[p?.slug] ?? null])).digest('hex').slice(0, 12);
}

const ids = (v) => {
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, u]) => [String(k), (Array.isArray(u) ? u : [u]).map(String)]));
  if (Array.isArray(v)) return v.map(String);
  return v === undefined || v === null || v === '' ? [] : [String(v)];
};

/** dst wins every field; the ids (slack, discord) and places (venues) of both are kept (shuttle's merge_entries). */
export function mergeEntries(src, dst) {
  const out = { ...dst };
  for (const [k, v] of Object.entries(src)) if (!(k in out)) out[k] = v;
  for (const k of ['discord', 'venues']) {
    const a = ids(src[k]), b = ids(dst[k]);
    if (Array.isArray(a) && Array.isArray(b) && (a.length || b.length)) out[k] = [...b, ...a.filter((x) => !b.includes(x))];
  }
  if (isObj(src.slack) && isObj(dst.slack)) {
    const m = Object.fromEntries(Object.entries(ids(dst.slack)).map(([t, u]) => [t, [...u]]));
    for (const [t, us] of Object.entries(ids(src.slack))) { m[t] ??= []; m[t].push(...us.filter((x) => !m[t].includes(x))); }
    out.slack = m;
  }
  return out;
}

/** `doc` with `from` renamed to (or merged into) `into` in its people: [new doc, what happened] or [null, why]. */
export function renamed(doc, from, into) {
  const people = doc?.people ?? {};
  if (!Object.hasOwn(people, from)) return [null, `there's no ${from}`];
  if (!SLUG.test(into)) return [null, 'a slug is lowercase letters, digits and dashes, like pat-lee'];
  if (into === from) return [null, 'that\'s the same person'];
  if (!isObj(people[from]) || (Object.hasOwn(people, into) && !isObj(people[into]))) return [null, 'one of them has an entry this can\'t read; fix it by hand'];
  const both = Object.hasOwn(people, into);
  const entry = both ? mergeEntries(people[from], people[into]) : people[from];
  const out = { ...doc, people: {} };
  for (const [k, v] of Object.entries(people)) {
    if (both && k === from) continue;
    out.people[k === from ? into : k] = k === from || k === into ? entry : v;
  }
  if (both) out.people[into] = entry;
  return [out, both ? `merged ${from} into ${into}` : `${from} is ${into} now`];
}

// ---------------------------------------------------------------- reading

export function gatesOf(store, agent) {
  if (!AGENT.test(agent ?? '')) throw new GateError('that isn\'t an agent');
  const got = store.get(GATES, agent);
  return got ? { doc: got.doc, rev: got.rev } : { doc: null, rev: 0 };
}

/** {agent: rev} of every agent whose gates the runtime holds. */
export function status(store) {
  return Object.fromEntries(store.list(GATES).filter((d) => AGENT.test(d.key)).map((d) => [d.key, d.rev]));
}

export function proposals(store, agent) {
  return store.list(PROPOSALS, `${agent}.`).filter((d) => isObj(d.doc) && d.doc.agent === agent && isObj(d.doc.entry))
    .map((d) => [d.key, d.doc]).sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0) || a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------- a body proposes

/**
 * Keep one proposed person for the owner. `caller` is the body's ({agent, service?, house?}); flags are propose-person's
 * (slug, entry, why, then-relay-say, then-relay-via). Returns {ok, message}.
 */
export function propose(store, caller, flags, { now = Date.now() / 1000, rand = () => randomBytes(3).toString('hex') } = {}) {
  const agent = caller.agent;
  const unknown = Object.keys(flags).filter((k) => !['slug', 'entry', 'then-relay-say', 'then-relay-via', 'why'].includes(k)).sort();
  if (unknown.length) return { ok: false, message: `propose-person doesn't take --${unknown[0]}` };
  const slug = flags.slug ?? '';
  let entry;
  try { entry = JSON.parse(flags.entry ?? ''); } catch { return { ok: false, message: '--entry isn\'t JSON' }; }
  const say = (flags['then-relay-say'] ?? '').trim(), via = flags['then-relay-via'] ?? '', why = (flags.why ?? '').trim();
  if (!!say !== !!via) return { ok: false, message: '--then-relay-say and --then-relay-via go together' };
  if (via && !VIAS.includes(via)) return { ok: false, message: `a relay goes into ${VIAS.join(', ')} for now, not ${via}` };
  if (say.length > SAY_MAX || why.length > WHY_MAX) return { ok: false, message: `--then-relay-say is ${SAY_MAX} characters at most, --why ${WHY_MAX} (so the owner sees all of it)` };
  const { doc, rev } = gatesOf(store, agent);
  if (doc === null) return { ok: false, message: `${agent}'s people aren't in the runtime yet; a proposal waits until the owner has moved them in` };
  const problem = personProblem(slug, entry, doc);
  if (problem) return { ok: false, message: problem };
  if (via && !entry[via]) return { ok: false, message: `${entry.name} has no ${via} id in --entry, so the relay couldn't reach them` };
  const before = doc.people?.[slug];
  if (stable(before ?? null) === stable(after(doc, slug, entry))) return { ok: false, message: `${slug} is already exactly that` };
  const mine = proposals(store, agent);
  const same = mine.filter(([, d]) => d.slug === slug).map(([k]) => k);
  if (mine.length - same.length >= PENDING_MAX) return { ok: false, message: `${PENDING_MAX} proposals are already waiting for the owner; wait for an answer` };
  const pid = `p-${rand()}`;
  store.put(PROPOSALS, `${agent}.${pid}`, {
    agent, id: pid, slug, entry, before: isObj(before) ? before : null, rev, at: now, why,
    from: String(caller.service || caller.house || 'a body').slice(0, 40),
    ...(via ? { relay: { via, say } } : {}),
  });
  for (const k of same) store.del(PROPOSALS, k);
  return { ok: true, message: `${pid}: asked the owner to ${isObj(before) ? 'change' : 'add'} ${entry.name} (${slug}) in ${agent}'s people; nothing changes until they allow it${via ? `, then ${agent} is told to send the message on ${via}` : ''}` };
}

/** propose-person's argv (`--slug S --entry J …`) as flags, or why not. */
export function proposeFlags(rest) {
  if (rest.length % 2 || !rest.every((a) => typeof a === 'string') || !rest.filter((_, i) => i % 2 === 0).every((a) => a.startsWith('--'))) {
    return 'argv is: propose-person --slug SLUG --entry JSON [--why W] [--then-relay-say TEXT --then-relay-via slack]';
  }
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i].slice(2)] = rest[i + 1];
  return flags;
}

// ---------------------------------------------------------------- what the owner is shown

const nameOf = (agent) => agent.slice(0, 1).toUpperCase() + agent.slice(1);
const show = (v) => (v === undefined || v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
const changes = (before = {}, aft = {}) => [...new Set([...Object.keys(before ?? {}), ...Object.keys(aft ?? {})])].sort()
  .filter((k) => stable(before?.[k] ?? null) !== stable(aft?.[k] ?? null)).map((k) => `${k}: ${show(before?.[k])} → ${show(aft?.[k])}`);
function summaryOf(e) {
  const bits = typeof e.role === 'string' && e.role ? [e.role] : [];
  bits.push(`tier ${e.tier}`);
  const slack = Object.values(e.slack ?? {}).flat();
  if (slack.length) bits.push(`Slack ${slack.join(', ')}`);
  if ((e.discord ?? []).length) bits.push(`Discord ${e.discord.join(', ')}`);
  return bits.join(', ');
}

/** Everything the owner sees of one proposal, and whether Allow may be offered (all of it fits uncut, and it passes). */
export function view(agent, p, doc) {
  const e = p.entry, slug = p.slug, who = nameOf(agent);
  const cur = doc?.people?.[slug];
  const problem = personProblem(slug, e, doc);
  const change = isObj(cur);
  let title, what;
  if (change && !problem) {
    const diff = changes(cur, after(doc, slug, e));
    title = `${who} asks to change ${e.name || slug}: ${diff.join('; ')}`;
    if (title.length > TITLE_MAX) title = `${who} asks to change ${e.name || slug}: ${diff.length} fields (${diff.map((d) => d.split(':')[0]).join(', ')})`;
    what = ['Changes', diff.join('; ')];
  } else {
    title = `${who} asks to ${change ? 'change' : 'add'} ${e.name || slug}: ${problem ? 'can\'t be allowed' : summaryOf(e)}`;
    what = ['Entry', JSON.stringify(e)];
  }
  if (title.length > TITLE_MAX) title = `${who} asks to ${change ? 'change' : 'add'} a person (${slug})`.slice(0, TITLE_MAX);
  const asker = `${who}, from ${p.from || 'a body'}`;
  const r = isObj(p.relay) && p.relay.say ? p.relay : null;
  const kv = [['Asked by', asker], ['Why', p.why || '—'], ['Slug', String(slug)], what, ...(r ? [[`Then, on ${r.via}`, String(r.say)]] : [])];
  const bits = [`Asked by ${asker}`, ...(p.why ? [`why: ${p.why}`] : []), what[0] === 'Changes' ? `${slug}, before → after: ${what[1]}` : `new as ${slug}: ${what[1]}`,
    ...(r ? [`then on ${r.via}: “${r.say}”`] : [])];
  let detail = bits.join(' · ');
  const fits = detail.length <= TEXT_MAX && kv.every(([, v]) => v.length <= TEXT_MAX);
  if (problem) detail = cut(`Can't be allowed: ${problem}. Deny it; the body can ask again.`, TEXT_MAX);
  else if (!fits) detail = 'Too long to show here in full, so it can\'t be allowed from here: open it to look, or deny it.';
  return { title, detail, kv: kv.map(([label, value]) => ({ label, value: cut(value, TEXT_MAX) })), allow: !problem && fits, problem };
}

function buttons(agent, p, doc, allow) {
  const id = String(p.id ?? '');
  return [...(allow ? [{ action: 'gates-allow', label: 'Allow', tone: 'primary', fields: { agent, id, seen: seen(p, doc) } }] : []),
    { action: 'gates-deny', label: 'Deny', fields: { agent, id } }];
}

/** One Inbox item per waiting proposal, the household owner's alone (never tagged with an agent). */
export function asks(store) {
  const out = [];
  const agents = [...new Set(store.list(PROPOSALS).map((d) => d.key.split('.')[0]))].filter((a) => AGENT.test(a)).sort();
  for (const a of agents) {
    const { doc } = gatesOf(store, a);
    for (const [, p] of proposals(store, a)) {
      const v = view(a, p, doc);
      out.push({ text: v.title, meta: v.detail, page: `gates/${a}`, label: 'Look', kind: 'permission', actions: buttons(a, p, doc, v.allow),
        ...(typeof p.at === 'number' ? { at: new Date(p.at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') } : {}) });
    }
  }
  return out;
}

const TIERS = { 3: '3 · owner', 2: '2 · trusted', 1: '1 · guest' };
const whereOf = (e) => PLATFORMS.filter((p) => e[p]).map((p) => { const n = Array.isArray(e[p]) ? e[p].length : isObj(e[p]) ? Object.keys(e[p]).length : 1; return n > 1 ? `${p} (${n} ids)` : p; }).join(', ') || '—';
const extrasOf = (e) => cut(['grant', 'restrict', 'projects', 'field'].filter((k) => e[k]).map((k) => `${k}: ${Array.isArray(e[k]) ? e[k].join(', ') : isObj(e[k]) ? Object.keys(e[k]).join(', ') : e[k]}`).join('; '));

/** An agent's gates page: who's waiting, the people and agents, and the merge form. */
export function gatesPage(store, agent) {
  if (!AGENT.test(agent ?? '')) return { title: 'Not found', sections: [] };
  const { doc, rev } = gatesOf(store, agent);
  if (doc === null) return { title: `${agent}'s people`, sections: [{ id: 'none', blocks: [{ type: 'text', tone: 'muted', text: `The runtime doesn't hold ${agent}'s gates yet: the owner moves them in with \`loom shuttle gates export --json | loom runtime gates import\`.` }] }] };
  const sections = [];
  const waiting = proposals(store, agent).slice(0, PENDING_MAX).map(([, p]) => {
    const v = view(agent, p, doc);
    return { type: 'details', summary: v.title, meta: 'waiting for you', blocks: [{ type: 'kv', items: v.kv }, ...(v.allow ? [] : [{ type: 'callout', tone: 'warn', text: v.detail }]), { type: 'buttons', items: buttons(agent, p, doc, v.allow) }] };
  });
  if (waiting.length) sections.push({ id: 'proposals', title: 'Waiting for you', blocks: waiting });
  const people = Object.entries(doc.people ?? {}).filter(([, e]) => isObj(e)).sort(([a, x], [b, y]) => (y.tier ?? 0) - (x.tier ?? 0) || a.localeCompare(b));
  const top = people.filter(([, e]) => e.tier === 3).map(([s]) => s);
  const blocks = [];
  if (top.length) blocks.push({ type: 'callout', tone: 'warn', title: 'Tier 3', text: `Tier 3 can do anything you can, through this agent: ${top.join(', ')}. Check each is someone who should.` });
  blocks.push({ type: 'table', columns: ['Who', 'Card', 'Tier', 'Where', 'Also'], rows: people.slice(0, 150).map(([s, e]) => [cut(e.name || s), s, TIERS[e.tier] ?? String(e.tier ?? '—'), whereOf(e), extrasOf(e)]) });
  const agents = Object.entries(doc.agents ?? {}).filter(([, e]) => isObj(e));
  if (agents.length) blocks.push({ type: 'table', columns: ['Agent', 'Slug', 'Kind', 'Where'], rows: agents.slice(0, 150).map(([s, e]) => [cut(e.name || s), s, cut(e.kind || '—'), cut(e.via || whereOf(e))]) });
  sections.push({ id: 'doc', blocks });
  sections.push({ id: 'merge', title: 'Merge someone', blocks: [{ type: 'form', action: 'gates-merge', submit: 'Merge',
    note: 'Two entries that are one person become one, under the slug of their person card, in every agent\'s gates; their cards merge too. Into a new slug it\'s a rename; into an existing one, the ids and places of both are kept and the tier and everything else are the second one\'s.',
    fields: [{ name: 'from', label: 'Who', kind: 'choice', required: true, options: people.map(([s]) => ({ value: s, label: s })) },
      { name: 'to', label: 'Into (their person card\'s slug)', kind: 'text', required: true }],
    hidden: { agent, rev: String(rev) } }] });
  return { title: `${agent}'s people`, intro: `Who each Slack and Discord id is (by their person card), and what they may ask ${agent} for. Tier 3 is you; 2 is trusted; 1 is a guest, only in the places listed. Changes come from ${agent}'s bodies as proposals, each waiting here and in your Inbox; no proposal gives or changes tier 3.`, sections };
}

// ---------------------------------------------------------------- person cards (core's ensure and merge)

const day = (now = new Date()) => now.toISOString().slice(0, 10);

/** loom's ensure body for one gate entry: who they are and where to reach them, nothing that gates. */
export function cardBody(agent, slug, entry, source) {
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : slug;
  const out = { slug, name: name.slice(0, 80), source, agent };
  if (typeof entry.role === 'string' && entry.role.trim()) out.role = entry.role.split(/\s+/).filter(Boolean).join(' ').slice(0, 200);
  const where = {};
  const one = (v) => (typeof v === 'string' || (typeof v === 'number')) ? [String(v)] : Array.isArray(v) ? v.filter((u) => typeof u === 'string' || typeof u === 'number').map(String) : [];
  const slack = isObj(entry.slack) ? Object.values(entry.slack).flatMap(one) : one(entry.slack);
  if (slack.length) where.slack = { value: slack.length === 1 ? slack[0] : slack.slice(0, 8) };
  const discord = one(entry.discord);
  if (discord.length) where.discord = { value: discord.length === 1 ? discord[0] : discord.slice(0, 8) };
  if (Object.keys(where).length) out.where = where;
  return out;
}

const cardWhat = (o) => (o?.created ? 'card made' : o?.unchanged || !Object.keys(o?.added ?? {}).length ? 'has a card already' : `added ${Object.entries(o?.added ?? {}).map(([f, v]) => `${f} ${[].concat(v).join(', ')}`).join('; ')} to their card`);

/** Ensure a card for each [slug, entry]: [{slug, ok, what}]. Never throws: a card is never why a gate write fails. */
export async function ensureCards(core, agent, pairs, verb, now = new Date()) {
  const out = [];
  for (const [slug, entry] of pairs) {
    try {
      const o = await core.ensure(cardBody(agent, slug, entry, `runtime gates (${agent}'s people), ${verb} by the owner ${day(now)}`));
      out.push({ slug, ok: true, what: cardWhat(o) });
    } catch (e) {
      out.push({ slug, ok: false, what: String(e.message ?? e).replace(/^core refused people\/ensure: /, '').slice(0, 300) });
    }
  }
  return out;
}

const cardSentence = (r) => (!r.length ? '' : r[0].ok ? `Person card: ${r[0].what}.` : `No person card was made (${r[0].what}); they're in the gates all the same.`);
export function cardSummary(results, limit = 6) {
  const ok = results.filter((r) => r.ok), bad = results.filter((r) => !r.ok);
  const made = ok.filter((r) => r.what === 'card made').length;
  const parts = [];
  if (ok.length) parts.push(`person cards: ${made} made, ${ok.length - made} already there`);
  if (bad.length) parts.push(`no card for ${bad.slice(0, limit).map((r) => `${r.slug} (${r.what})`).join('; ')}${bad.length > limit ? ` and ${bad.length - limit} more` : ''}`);
  return parts.join('; ');
}

const peopleOf = (doc) => Object.entries(doc?.people ?? {}).filter(([s, e]) => !s.startsWith('_') && isObj(e));

// ---------------------------------------------------------------- the owner's actions

const MERGE_TRIES = 3;

/** gates-allow / gates-deny: one proposal, as the owner saw it. */
export async function answer(store, core, action, fields, { now = new Date() } = {}) {
  const agent = String(fields.agent ?? '');
  if (!AGENT.test(agent)) return { ok: false, message: 'That isn\'t an agent.' };
  const pid = String(fields.id ?? '');
  const key = `${agent}.${pid}`;
  const p = PROPOSAL_ID.test(pid) ? store.get(PROPOSALS, key)?.doc : null;
  if (!isObj(p) || p.agent !== agent || !isObj(p.entry)) return { ok: false, message: 'That ask isn\'t waiting any more: it was answered, or the body asked again since. Open it again.', page: `gates/${agent}` };
  const name = p.entry.name || p.slug, who = nameOf(agent);
  if (action === 'gates-deny') {
    store.del(PROPOSALS, key);
    return { ok: true, message: `Denied: ${name} isn't in ${who}'s people; nothing changed.`, page: `gates/${agent}` };
  }
  let doc, merged, newRev;
  for (let i = 0; ; i++) {
    ({ doc } = gatesOf(store, agent));
    const { rev } = gatesOf(store, agent);
    if (doc === null) return { ok: false, message: `${who}'s people aren't in the runtime, so there's nothing to add ${name} to.` };
    if (seen(p, doc) !== String(fields.seen ?? '')) return { ok: false, message: `${name}'s entry changed since you looked: open it again.`, page: `gates/${agent}` };
    const v = view(agent, p, doc);
    if (v.problem) return { ok: false, message: `Not added: ${v.problem}. Deny it, or ask the body again.`, page: `gates/${agent}` };
    if (!v.allow) return { ok: false, message: 'Not added: it doesn\'t show in full, so it can\'t be allowed. Deny it.', page: `gates/${agent}` };
    merged = mergeInto(doc, p.slug, p.entry);
    try { newRev = store.put(GATES, agent, merged, rev); break; } catch (e) {
      if (e instanceof StoreError && e.status === 409 && i < MERGE_TRIES - 1) continue;
      if (e instanceof StoreError && e.status === 409) return { ok: false, message: `${who}'s people kept changing while this saved; nothing was added. Try again.` };
      throw e;
    }
  }
  store.del(PROPOSALS, key);
  const verb = isObj(doc.people?.[p.slug]) ? 'changed in' : 'added to';
  let msg = `${name} ${verb} ${who}'s people; its bridges read it within a minute.`;
  const card = cardSentence(await ensureCards(core, agent, [[p.slug, merged.people[p.slug]]], 'allowed', now));
  if (isObj(p.relay) && p.relay.say) {
    try {
      await core.deliver({
        id: `gates-allow-${agent}-${pid}`, agent, venue: 'relay', place: `gates>${agent}`, label: 'People allowed',
        from: { kind: 'agent', id: agent }, kind: 'message', at: now.toISOString(),
        text: `The owner allowed ${name} (${p.slug}) into your people (revision ${newRev}). You asked to then tell them on ${p.relay.via}: “${p.relay.say}”. Send it now.`,
      });
      msg = `${name} ${verb} ${who}'s people; ${who} is told to send the follow-up on ${p.relay.via}.`;
    } catch (e) {
      msg += ` The follow-up didn't reach ${who} (${String(e.message ?? e).slice(0, 160)}); relay it by hand.`;
    }
  }
  return { ok: true, message: `${msg}${card ? ` ${card}` : ''}`, page: `gates/${agent}` };
}

/**
 * gates-merge: `from` and `to` are one person. Their cards merge in core (when both have one), and every agent's gates
 * follow: `from` renamed to `to` (merged into it where an agent has both). The page's agent's revision must be the
 * one it showed.
 */
export async function mergePeople(store, core, fields) {
  const agent = String(fields.agent ?? ''), from = String(fields.from ?? ''), into = String(fields.to ?? '').trim();
  if (!AGENT.test(agent)) return { ok: false, message: 'That isn\'t an agent.' };
  const mine = gatesOf(store, agent);
  if (mine.doc === null) return { ok: false, message: `${agent} has no people in the runtime yet.` };
  if (String(mine.rev) !== String(fields.rev ?? '')) return { ok: false, message: `${agent}'s people changed since you opened this: open it again.` };
  const [first, why] = renamed(mine.doc, from, into);
  if (!first) return { ok: false, message: `Not merged: ${why}.` };
  const done = [];
  for (const a of Object.keys(status(store)).sort()) {
    const g = a === agent ? mine : gatesOf(store, a);
    const [next, what] = a === agent ? [first, why] : renamed(g.doc, from, into);
    if (!next) continue;
    const bad = valid(next);
    if (bad) return { ok: false, message: `Not saved for ${a}: ${bad}.` };
    store.put(GATES, a, next, g.rev);
    done.push(`${a}: ${what}`);
  }
  let card;
  try {
    await core.merge({ from, into });
    card = `Their person cards are one now (${from} → ${into}).`;
  } catch (e) {
    // No card to merge from (a gate slug that never had one): the survivor's card gets the ids instead.
    const r = await ensureCards(core, agent, [[into, first.people[into]]], 'merged');
    card = /404|no card|not-found/i.test(String(e.message)) ? cardSentence(r) : `The cards weren't merged (${String(e.message).slice(0, 160)}); ${cardSentence(r)}`;
  }
  return { ok: true, page: `gates/${agent}`, message: `In the gates, ${done.join('; ')}; the bridges read it within a minute. ${card}` };
}

/** After a card merge made elsewhere (core's merge, the owner's `loom person merge`): every agent's gates follow. */
export function followMerge(store, from, into) {
  const out = [];
  for (const a of Object.keys(status(store)).sort()) {
    const g = gatesOf(store, a);
    const [next, what] = renamed(g.doc, from, into);
    if (!next) continue;
    store.put(GATES, a, next, g.rev);
    out.push(`${a}: ${what}`);
  }
  return out;
}

// ---------------------------------------------------------------- moving in, and out

/** An export, as shuttle writes it ({v: 1, from: 'shuttle', agents: {agent: {doc, rev}}}): {agent: doc}, or why not. */
export function parseExport(text) {
  let d;
  try { d = JSON.parse(text); } catch { return 'the export on stdin isn\'t JSON'; }
  if (!isObj(d) || d.v !== 1 || !isObj(d.agents)) return 'an export is {v: 1, agents: {<agent>: {doc, rev}}} (loom shuttle gates export --json)';
  const out = {};
  for (const [a, g] of Object.entries(d.agents)) {
    if (!AGENT.test(a)) return `${a} isn't an agent's name`;
    const doc = isObj(g) && 'doc' in g ? g.doc : g;
    const why = valid(doc);
    if (why) return `${a}'s people aren't a people document: ${why}`;
    out[a] = doc;
  }
  return out;
}

/** The runtime's gates as an export (the same shape), for the way back or a check. */
export function exportGates(store) {
  const agents = {};
  for (const d of store.list(GATES)) if (AGENT.test(d.key)) agents[d.key] = { doc: d.doc, rev: d.rev };
  return { v: 1, from: 'runtime', agents };
}

/**
 * Import an export, entry for entry. Only the owner's run may (`owner`: the CLI's check of its environment, and core's
 * own: `gates` is owner-written). An agent the runtime already holds is left as it is, unless it's the same document,
 * or `force`. Then every person imported gets a card ensured. Returns {agents: {agent: 'imported'|'same'|'kept'}, cards}.
 */
export async function importGates(store, core, text, { owner, force = false, now = new Date() } = {}) {
  if (owner !== true) throw new GateError(`the import is the owner's run only (${owner || 'not the owner'})`, 403);
  const parsed = parseExport(text);
  if (typeof parsed === 'string') throw new GateError(parsed);
  const agents = {};
  const ensure = [];
  for (const [a, doc] of Object.entries(parsed).sort(([x], [y]) => x.localeCompare(y))) {
    const cur = gatesOf(store, a);
    if (cur.doc !== null && stable(cur.doc) === stable(doc)) { agents[a] = 'same'; continue; }
    if (cur.doc !== null && !force) { agents[a] = 'kept (the runtime has different gates for it; --force replaces them)'; continue; }
    try {
      store.put(GATES, a, doc, cur.rev);
    } catch (e) {
      if (e instanceof StoreError && e.status === 403) throw new GateError(`core refused the write: ${e.message}. The gates are the owner's: run the import as the owner at loom's machine`, 403);
      throw e;
    }
    agents[a] = 'imported';
    ensure.push([a, peopleOf(doc)]);
  }
  const cards = [];
  for (const [a, pairs] of ensure) cards.push(...await ensureCards(core, a, pairs, 'imported', now));
  return { agents, cards: cardSummary(cards), cardResults: cards };
}

/** Whether this process is the owner's run, for the import: no call from loom's API, no grant but an owner's. */
export function ownersRunOf(env, grant) {
  if (env.HOUSE_ID || (env.LOOM_URL && env.LOOM_TOKEN_FILE)) return 'a house';
  if (!env.LOOM_STORE_GRANT) return 'no owner\'s grant: run it as `loom runtime gates import` at loom\'s machine';
  if (grant && grant.owner !== true) return 'a grant for an agent, not the owner';
  return true;
}
