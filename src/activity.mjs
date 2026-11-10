// Activity: what a body in a Comms thread is doing, as plain one-line cards (loom docs/specs/comms.md, section 3).
// Read only for managed bodies, from the harness's own record:
//   - Claude: the session transcript (<projects>/<cwd>/<session>.jsonl). An `assistant` line's `tool_use` entry makes a
//     `running` card; a later `user` line's `tool_result` for it makes it `done`, or `failed` when `is_error`.
//   - Codex: events.jsonl. `item.started` makes a card, `item.completed` finishes it (`status: "failed"` is failed).
// A card's summary is its label (t-1944): what the step did, in plain words, from the fixed rules below and in
// redact.mjs; nothing is asked of a model for one (a Bash description is the body's own words, redacted like the
// rest). A shell command shows as its description when the harness gives one, else its short form
// (`Ran gh pr checks 603`); a file by its base name; a search by its pattern; a message by who it went to; a tool this
// table doesn't know as "Used a tool". Every variable part passes redact.mjs `part` (the gate), and every finished label
// `finish` (redacted whole, one line, at most 120). A failed step adds why, from fixed phrases only
// (`exit 1: 3 tests failed`). Never a tool's output, a file's contents, a whole command line or an environment value.
// Text and thinking make no card.
import { createHash } from 'node:crypto';
import { commandLabel, cutTo, failWhy, fileName, GONE, part, PRIVATE_FILE, privateFile, redact, UNPRINTABLE, UNPRINTABLE_ONE } from './redact.mjs';

export { UNPRINTABLE, UNPRINTABLE_ONE };

export const MAX_SUMMARY = 120;
export const MAX_CARDS = 50;

/**
 * loom's tools in fixed words. Those that read or write a private store (memory, people, notes, knowledge, threads,
 * conversations) never show what they were used on: what Art remembered or looked up is his, not a step's label.
 */
const LOOM_TOOLS = {
  recall: 'Searched memory', remember: 'Saved a memory', forget: 'Forgot a memory', update: 'Updated a memory',
  episodes: 'Looked at recent memories', find_similar: 'Looked for similar memories', identity: 'Loaded who it is',
  dossier: 'Loaded its dossier', note_write: 'Wrote a note', note_read: 'Read a note', note_list: 'Listed notes',
  knowledge_recall: 'Looked up what it knows', knowledge_write: 'Wrote down a fact', knowledge_verify: 'Checked a fact',
  knowledge_list: 'Listed what it knows', conversation_digest: 'Wrote its digest', conversations: 'Looked at its conversations',
  conversation: 'Read a conversation', conversation_findings: 'Read its findings', comms_title: 'Named the thread',
  comms_thread: 'Read a thread', comms_trace: 'Traced a reply', person: 'Read a person card', person_list: 'Listed people',
  person_write: 'Updated a person card', project: 'Read a project card', project_list: 'Listed projects',
  project_hub: 'Looked at a project', project_write: 'Updated a project card',
};
/** Private stores by name, for a loom tool the table above doesn't list: fixed words, never an argument. */
const PRIVATE = [
  [/^memory_/, 'Tended its memory'], [/^(?:note|notes)_/, 'Worked on its notes'], [/^knowledge_/, 'Tended what it knows'],
  [/^person_/, 'Worked on a person card'], [/^project_/, 'Worked on a project card'], [/^comms_/, 'Used its thread'],
  [/^conversation/, 'Read its conversations'], [/^(?:harness|bootstrap|describe_self|update_identity)/, 'Tended its setup'],
];
/**
 * The tools whose argument a label may show, by name, with the argument and the shape it must have: work ids, never
 * words. A task (`t-1929`), a PR or issue number. Any other tool shows only its name in words.
 */
const PUBLIC_ARGS = [
  [/^(?:task|tasks|taskstore)(?:_[a-z]{1,12})?$/, ['id', 'task'], /^t-\d{1,9}$/, '', 'Used a task tool'],
  [/^(?:get_|create_|update_|merge_)?(?:pull_request|issue)(?:_read|_comment|_review)?$/, ['pullNumber', 'pull_number', 'issue_number', 'issueNumber', 'number'], /^\d{1,9}$/, '#', 'Used a GitHub tool'],
];

/** One printable line of at most `n` (MAX_SUMMARY, and at least 1): unprintable characters and line breaks gone. */
export function clean(s, n = MAX_SUMMARY) {
  const max = Math.max(1, Math.min(MAX_SUMMARY, n));
  const one = String(s ?? '').slice(0, 4000).replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim();
  return cutTo(one, max); // in UTF-16 units, as core counts, and never between a surrogate pair
}

/** A finished label: redacted as a whole once more, on one printable line, at most MAX_SUMMARY. */
const finish = (s) => clean(redact(s));
/** A text part of a label (a pattern, a query, a first line), through the gate, cut to `n`. */
const txt = (s, n) => part('text', s, n);
const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

/** A path for showing: its base name, or "a private file" (redact.mjs fileName, through the gate). */
export const shownPath = (p) => fileName(p);

/** A host to show from a URL, without its user or password; null when it isn't one. */
function hostOf(u) {
  const s = String(u ?? '');
  // The whole URL is checked first, its credentials taken out by redact: a host that is a piece of a secret (one with a
  // / in it, the URL parser lower-casing it) never shows.
  const r = redact(s);
  try {
    const host = new URL(r).hostname || null;
    return host && new URL(s).hostname === host && redact(host) === host ? host : null;
  } catch { return null; }
}

/** A plan's (TodoWrite's or Codex's todo list's) line: `Plan (2/5): Running the tests`. */
function planLine(items) {
  if (!Array.isArray(items) || !items.length) return 'Updated its plan';
  const done = items.filter((x) => x.done).length;
  const now = items.find((x) => x.now) ?? items.find((x) => !x.done);
  return finish(`Plan (${done}/${items.length}): ${now ? txt(now.text, 90) : 'all done'}`);
}

/** The argument a public tool was used on (PUBLIC_ARGS), or ''. */
function publicArg(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  for (const [name, keys, shape, prefix] of PUBLIC_ARGS) {
    if (!name.test(tool)) continue;
    for (const k of keys) { const v = i[k]; if ((typeof v === 'string' || typeof v === 'number') && shape.test(String(v)) && part('id', v) !== GONE) return `${prefix}${part('id', v)}`; }
  }
  return '';
}

/** An MCP tool's label: fixed words, a relay's who and first line, or a public tool's id (`Used task close t-12`). */
function mcpLabel(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (tool === 'relay') {
    // Jonathan asked to see who a message went to and what it opened with; only the agent's owners read the thread.
    return messaged(i.to, i.say ?? i.text ?? i.message, 'another agent');
  }
  const t = String(tool);
  if (Object.hasOwn(LOOM_TOOLS, t)) return LOOM_TOOLS[t];
  const priv = PRIVATE.find(([re]) => re.test(t));
  if (priv) return priv[1];
  // A public tool (PUBLIC_ARGS) is its fixed words and its id; any other is "Used a tool". A tool's own name is the
  // harness's word, never shown.
  const pub = PUBLIC_ARGS.find(([re]) => re.test(t));
  if (!pub) return 'Used a tool';
  const arg = publicArg(t, i);
  return finish(`${pub[4]}${arg ? ` ${arg}` : ''}`);
}

/** A message's label: who it went to (a plain name, else `other`) and its first line, both through the gate. */
function messaged(to, say, other) {
  const who = typeof to === 'string' ? part('who', to) : GONE;
  const line = firstLine(say);
  return finish(`Messaged ${who === GONE ? other : who}${line ? `: "${txt(line, 70)}"` : ''}`);
}

/** The tool's name in words, for an MCP tool (`mcp__<server>__<tool>`) or a plain name. */
function mcpName(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return m ? m[2] : name;
}

/** A Claude Code tool call's label, by the fixed table (comms.md, section 3). */
export function claudeSummary(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const lines = () => {
    const o = Number(i.offset), l = Number(i.limit);
    if (!Number.isFinite(o) && !Number.isFinite(l)) return '';
    const from = Number.isFinite(o) && o > 0 ? o : 1;
    return Number.isFinite(l) && l > 0 ? ` (lines ${part('count', Math.floor(from))}–${part('count', Math.floor(from + l - 1))})` : ` (from line ${part('count', Math.floor(from))})`;
  };
  switch (name) {
    case 'Bash': {
      const d = typeof i.description === 'string' ? i.description.trim() : '';
      return finish(d ? txt(d) : commandLabel(i.command) || 'Ran a command');
    }
    case 'BashOutput': return 'Checked a background command';
    case 'KillShell': case 'KillBash': return 'Stopped a background command';
    case 'Read': return finish(`Read ${fileName(i.file_path)}${lines()}`);
    case 'Edit': case 'MultiEdit': return finish(`Edited ${fileName(i.file_path)}`);
    case 'Write': return finish(`Wrote ${fileName(i.file_path)}`);
    case 'NotebookEdit': return finish(`Edited ${fileName(i.notebook_path)}`);
    case 'Grep': return finish(`Searched for "${txt(i.pattern, 60)}"${i.path ? ` in ${fileName(i.path)}` : ''}`);
    // A glob is a pattern of paths: only its last part, so no folder (a home, ~/.config) shows.
    case 'Glob': return finish(`Looked for files: ${privateGlob(i.pattern) ? PRIVATE_FILE : lastPart(i.pattern)}`);
    case 'WebSearch': return finish(`Searched the web for "${txt(i.query, 60)}"`);
    // A page's host, only when the whole URL passes redaction (no user, no password, no token in it anywhere).
    case 'WebFetch': { const h = hostOf(i.url); return h && part('host', h) !== GONE && redact(String(i.url)) === String(i.url) ? finish(`Read a page on ${part('host', h)}`) : 'Read a web page'; }
    case 'Task': case 'Agent': return i.description ? finish(`Started a helper: ${txt(i.description, 80)}`) : 'Started a helper';
    case 'SendMessage': return messaged(i.to, i.message, 'a helper');
    case 'TodoWrite': return planLine((Array.isArray(i.todos) ? i.todos : []).map((t) => ({ text: t?.status === 'in_progress' ? (t.activeForm || t.content) : t?.content, done: t?.status === 'completed', now: t?.status === 'in_progress' })));
    // A skill's name is lower case words, maybe a plugin's prefix (superpowers:brainstorming); anything else isn't shown.
    case 'Skill': { const k = part('word', i.skill); return k === GONE || !/^[a-z0-9-]{1,40}(?::[a-z0-9-]{1,40})?$/.test(k) ? 'Used a skill' : finish(`Used the ${k} skill`); }
    case 'ToolSearch': return 'Loaded more tools';
    default: return name.startsWith('mcp__') ? mcpLabel(mcpName(name), i) : 'Used a tool';
  }
}

/** A glob's last part, through the gate; checked whole first, so a secret with a / in it never shows its tail. */
function lastPart(g) {
  const s = String(g ?? '').slice(0, 2000);
  if (redact(s) !== s) return GONE;
  return txt(s.split(/[\\/]/).filter(Boolean).pop() ?? '', 60);
}

/** Whether a glob points into a private place (redact.mjs privateFile on the glob as a path). */
// One check for every file tool (redact.mjs privateFile), on the whole glob and on each of its parts.
const privateGlob = (g) => { const s = String(g ?? ''); return privateFile(s) || s.split(/[\\/]/).some((p) => p && privateFile(p)); };

/** `label — why` within MAX_SUMMARY, the label cut so the why fits. */
function withWhy(label, why) {
  if (!why) return label;
  const tail = ` — ${clean(why, 50)}`;
  return clean(`${clean(label, MAX_SUMMARY - tail.length)}${tail}`);
}

/** A Claude tool_result's text (a string, or a list of text blocks), for failWhy only. */
function resultText(c) {
  if (typeof c?.content === 'string') return c.content;
  if (Array.isArray(c?.content)) return c.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n');
  return '';
}

const TOOL = /^[A-Za-z0-9_.:\-]{1,64}$/;
/** A card's `tool`: the harness's name for it, when it's plain and nothing secret-shaped; else "tool". */
const toolName = (n) => (TOOL.test(String(n)) && redact(String(n)) === String(n) ? String(n) : 'tool');
/** A card's time: an ISO time as the transcript wrote it, else now. */
export const cardTime = (t) => (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(t) ? t : new Date().toISOString());

/** The cards in a Claude transcript's lines (parsed JSON objects), in order; `prefix` keeps ids unique per thread. */
export function claudeCards(lines, prefix = '') {
  const cards = new Map();
  for (const l of lines) {
    const content = l?.message?.content;
    if (!Array.isArray(content)) continue;
    if (l.type === 'assistant') {
      for (const c of content) {
        if (c?.type !== 'tool_use' || typeof c.id !== 'string') continue;
        const id = `${prefix}${c.id}`.slice(0, 80);
        if (!cards.has(id)) cards.set(id, { id, at: cardTime(l.timestamp), tool: toolName(c.name), summary: claudeSummary(String(c.name ?? ''), c.input) || 'Used a tool', state: 'running' });
      }
    } else if (l.type === 'user') {
      for (const c of content) {
        if (c?.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
        const card = cards.get(`${prefix}${c.tool_use_id}`.slice(0, 80));
        if (!card || card.state !== 'running') continue; // one result per call: a repeated line changes nothing
        card.state = c.is_error === true ? 'failed' : 'done';
        if (card.state === 'failed') {
          // Claude Code's Bash result starts "Exit code N" on a failure; the rest is only matched, never shown.
          const text = resultText(c);
          const exit = /^Exit code (\d+)/.exec(text)?.[1];
          card.summary = withWhy(card.summary, failWhy({ exit: exit ? Number(exit) : undefined, output: text }));
        }
      }
    }
  }
  return [...cards.values()];
}

const CODEX_TYPES = ['command_execution', 'mcp_tool_call', 'file_change', 'web_search', 'todo_list'];

function codexSummary(item) {
  switch (item.type) {
    case 'command_execution': return finish(commandLabel(item.command) ?? 'Ran a command');
    case 'file_change': {
      const paths = Array.isArray(item.changes) ? item.changes.map((c) => fileName(c?.path)) : [];
      return finish(paths.length === 1 ? `Changed ${paths[0]}` : paths.length === 2 ? `Changed ${paths.join(', ')}` : paths.length ? `Changed ${paths[0]} and ${paths.length - 1} more` : 'Changed files');
    }
    case 'mcp_tool_call': return mcpLabel(String(item.tool ?? 'a tool'), item.arguments);
    case 'web_search': return finish(`Searched the web for "${txt(item.query, 60)}"`);
    case 'todo_list': return planLine((Array.isArray(item.items) ? item.items : []).map((t) => ({ text: t?.text, done: t?.completed === true })));
    default: return 'Used a tool';
  }
}

/** Why a Codex item failed: a command's exit code and its output's fixed phrase; an MCP call's error, by phrase. */
function codexWhy(item) {
  if (item.type === 'command_execution') return failWhy({ exit: Number.isInteger(item.exit_code) ? item.exit_code : undefined, output: item.aggregated_output });
  if (item.type === 'mcp_tool_call') return failWhy({ output: typeof item.error === 'string' ? item.error : item.error?.message ?? '' });
  return null;
}

/** The cards in a Codex run's events (parsed JSON objects), in order; `prefix` keeps item ids unique per thread. */
export function codexCards(events, prefix = '') {
  const cards = new Map();
  for (const e of events) {
    const item = e?.item;
    if (!item || !CODEX_TYPES.includes(item.type) || typeof item.id !== 'string') continue;
    const id = `${prefix}${item.id}`.slice(0, 80);
    if (!cards.has(id) && ['item.started', 'item.updated', 'item.completed'].includes(e.type)) {
      cards.set(id, { id, at: new Date().toISOString(), tool: toolName(item.type), summary: '', state: item.type === 'todo_list' ? 'done' : 'running' });
    }
    const card = cards.get(id);
    if (!card) continue;
    const label = codexSummary(item); // once per event: a plan moves on item.updated, a step's label on completion
    if (!card.summary) card.summary = label;
    // A plan changes as the turn goes (item.updated): it's never a running step, only the latest plan.
    if (item.type === 'todo_list') { card.summary = label; continue; }
    if (e.type === 'item.completed') {
      card.state = item.status === 'failed' || (item.type === 'command_execution' && Number.isInteger(item.exit_code) && item.exit_code !== 0) ? 'failed' : 'done';
      card.summary = card.state === 'failed' ? withWhy(label, codexWhy(item)) : label;
    }
  }
  return [...cards.values()];
}

/** What the record keeps of a card: its state and a short hash of its label (never the label itself). */
const mark = (c) => `${c.state}:${createHash('sha256').update(String(c.summary)).digest('hex').slice(0, 8)}`;

/**
 * What to post of `cards` given what was posted (`sent`: id → its mark): the new ones and those whose state or label
 * moved, at most MAX_CARDS (the oldest first). Answers the cards and the record after posting them. A record from
 * before labels moved (t-1944) holds the bare state: a card whose state still matches it isn't sent again, and its
 * record moves to the mark, so a later move of its label is.
 */
export function changed(cards, sent = {}) {
  const out = cards.filter((c) => sent[c.id] !== mark(c) && sent[c.id] !== c.state).slice(0, MAX_CARDS);
  const next = { ...sent };
  for (const c of cards) if (next[c.id] === c.state) next[c.id] = mark(c);
  for (const c of out) next[c.id] = mark(c);
  // Keep the record bounded: the newest 400 ids.
  const keys = Object.keys(next);
  if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete next[k];
  return { out, next };
}
