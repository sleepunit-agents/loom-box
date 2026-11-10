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
// (`exit 1: 3 tests failed`). Never a tool's output, a file's contents, a whole command line or an environment value
// in a label.
// A card may also carry, for the owner's Watching view (t-2109; Jonathan, 2026-11-10: work done for him is shown in
// full, only other people's words are kept out): `detail`, the step's whole command or target; `result`, one line of
// fixed phrases (`Read 120 lines`, `3 additions, 1 removal`, `12 passed, 1 failed`, `exit 1`); `body`, an edit's diff
// of a file that isn't private, each line redacted (shownText), at most MAX_BODY; `exit`; `limit`,
// the step's own timeout in seconds; `end`, when it finished; `parent`, the helper (subagent) it ran under; and for a
// plan, `items`, its checklist. The body's own words between steps are a `text` card (tool `text`), which delivery
// shows only for a conversation that acts for the owner alone. A read shows its line count, never what it read; a shell
// step's output is read only for its fixed phrases and never kept or sent (showing it on demand is its own task).
import { createHash } from 'node:crypto';
import { commandLabel, cutInput, cutTo, failWhy, fileName, WHY_WORDS, GONE, INPUT_MAX, part, PRIVATE_FILE, privateFile, privateWords, redact, UNPRINTABLE, UNPRINTABLE_ONE } from './redact.mjs';



export { UNPRINTABLE, UNPRINTABLE_ONE };

export const MAX_SUMMARY = 120;
export const MAX_CARDS = 50;
/** A card's `detail` (a whole command), its `body` (output, a diff, its words) at most, in UTF-16 units; plan items. */
export const MAX_DETAIL = 4000;
export const MAX_BODY = 32_000;
/** The body's own words between steps, at most. */
export const MAX_TEXT = 8_000;
export const MAX_ITEMS = 20;

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

/** A plan's checklist: each item through the gate, `done`, `now` (the one it's on) or `todo`; at most MAX_ITEMS. */
function planItems(items) {
  if (!Array.isArray(items)) return [];
  const now = items.find((x) => x.now) ?? items.find((x) => !x.done);
  return items.slice(0, MAX_ITEMS).map((x) => ({ text: (() => { const t = txt(x.text, 100); return t === GONE ? 'an item' : t; })(), state: x.done ? 'done' : x === now ? 'now' : 'todo' }));
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

// ─── A card's fixed label (t-2109): fixed words and safe parts only, set where the card is made ──────────────────────

/** A file's base name as a fixed label may hold it: plain characters only, never a quote, a colon or a folder. */
const safeName = (p) => { const n = fileName(p); return n !== GONE && n !== PRIVATE_FILE && /^[A-Za-z0-9._+-]{1,60}$/.test(n) && redact(n) === n ? n : null; };
/** A person's or agent's name as a fixed label may hold it: a plain handle (`mark`, `loren-b`), else nothing. */
const safeWho = (w) => (typeof w === 'string' && /^[a-z][a-z0-9]{0,30}(?:-[a-z0-9]{1,30}){0,3}$/.test(w) && redact(w) === w ? w : null);
const planFixed = (items) => (Array.isArray(items) && items.length ? `Plan (${items.filter((x) => x.done).length}/${items.length})` : 'Updated its plan');

/**
 * A Claude tool call's fixed label: what the owner's view shows where someone else is in the conversation, and the
 * only label sent there (delivery's activityPass). Built from fixed words and safe parts (a file's plain base name, a
 * plan's counts, a plain name, a work id) — never a pattern, a query, a description or a message's words.
 */
export function claudeFixed(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const file = (verb, p) => { const n = safeName(p); return n ? `${verb} ${n}` : `${verb} a file`; };
  switch (name) {
    case 'Bash': case 'BashOutput': return 'Ran a command';
    case 'KillShell': case 'KillBash': return 'Stopped a background command';
    case 'Read': return file('Read', i.file_path);
    case 'Edit': case 'MultiEdit': return file('Edited', i.file_path);
    case 'Write': return file('Wrote', i.file_path);
    case 'NotebookEdit': return file('Edited', i.notebook_path);
    case 'Grep': return 'Searched files';
    case 'Glob': return 'Looked for files';
    case 'WebSearch': return 'Searched the web';
    case 'WebFetch': return 'Read a web page';
    case 'Task': case 'Agent': return 'Started a helper';
    case 'SendMessage': return 'Messaged a helper';
    case 'TodoWrite': return planFixed((Array.isArray(i.todos) ? i.todos : []).map((t) => ({ done: t?.status === 'completed' })));
    case 'Skill': return 'Used a skill';
    case 'ToolSearch': return 'Loaded more tools';
    default: return name.startsWith('mcp__') ? mcpFixed(mcpName(name), i) : 'Used a tool';
  }
}

/** An MCP tool's fixed label: loom's tools in their fixed words, a relay as who it went to, a public tool's id. */
function mcpFixed(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (tool === 'relay') { const w = safeWho(i.to); return w ? `Messaged ${w}` : 'Messaged someone'; }
  if (Object.hasOwn(LOOM_TOOLS, tool)) return LOOM_TOOLS[tool];
  const priv = PRIVATE.find(([re]) => re.test(tool));
  if (priv) return priv[1];
  const pub = PUBLIC_ARGS.find(([re]) => re.test(tool));
  if (!pub) return 'Used a tool';
  const arg = publicArg(tool, i);
  return `${pub[4]}${arg ? ` ${arg}` : ''}`;
}

/** A Codex item's fixed label. */
function codexFixed(item) {
  switch (item.type) {
    case 'command_execution': return 'Ran a command';
    case 'file_change': { const c = Array.isArray(item.changes) ? item.changes : []; const n = c.length === 1 ? safeName(c[0]?.path) : null; return n ? `Changed ${n}` : c.length ? `Changed ${c.length} file${c.length === 1 ? '' : 's'}` : 'Changed files'; }
    case 'mcp_tool_call': return mcpFixed(String(item.tool ?? ''), item.arguments);
    case 'web_search': return 'Searched the web';
    case 'todo_list': return planFixed((Array.isArray(item.items) ? item.items : []).map((t) => ({ done: t?.completed === true })));
    default: return 'Used a tool';
  }
}

/** A failure's fixed phrase after a fixed label: its exit code and failWhy's fixed words only. */
const fixedWhy = (label, why) => (why ? `${label} — ${why}` : label);

/** The shapes a fixed label may take (a house's is checked against them): fixed words, a plain name, a count, an id. */
const NAME = '[A-Za-z0-9._+-]{1,60}';
/** failWhy's fixed phrases (redact.mjs WHY), the only words a failure adds to a fixed label. */
const WHY_PHRASES = WHY_WORDS;
const WHY_TAIL = `(?:\\d{1,6} tests? failed|${WHY_PHRASES.map((w) => w.replace(/[()]/g, '\\$&')).join('|')})`;
const FIXED_WORDS = [...new Set(['Ran a command', 'Stopped a background command', 'Searched files', 'Looked for files', 'Searched the web', 'Read a web page',
  'Started a helper', 'Messaged a helper', 'Messaged someone', 'Used a skill', 'Loaded more tools', 'Used a tool', 'Updated its plan', 'Changed files',
  'Read a file', 'Edited a file', 'Wrote a file', 'Did a step', 'Wrote its words', 'Used a task tool', 'Used a GitHub tool', ...Object.values(LOOM_TOOLS), ...PRIVATE.map(([, w]) => w)])];
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const FIXED = new RegExp(`^(?:${FIXED_WORDS.map(esc).join('|')}|(?:Read|Edited|Wrote|Changed) ${NAME}|Changed \\d{1,6} files?|Plan \\(\\d{1,4}/\\d{1,4}\\)|Messaged [a-z][a-z0-9]{0,30}(?:-[a-z0-9]{1,30}){0,3}|Used a task tool t-\\d{1,9}|Used a GitHub tool #\\d{1,9})(?: — (?:exit -?\\d{1,6}(?:: ${WHY_TAIL})?|${WHY_TAIL}))?$`);

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

// ─── Claude Code's look: a step's target, its result line, a few lines of a shell step's output (t-2109) ──────────

/** ANSI colour (SGR) codes: kept in a shown text for a terminal's look; every other control goes. */
const SGR = /\x1b\[[0-9;]{0,30}m/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** A line with every terminal code but a short colour gone whole, and every other unprintable character but a tab. */
function normLine(line) {
  return String(line)
    // OSC (a title, a link) to its end; any CSI (ECMA-48: parameters, intermediates, a final byte) but a colour of at
    // most 30 parameter characters; any other escape with its intermediates and final byte (ESC ( B, ESC 7, ESC =).
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, (m) => (/^\x1b\[[0-9;]{0,30}m$/.test(m) ? m : ''))
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, (m) => (/^\x1b\[/.test(m) ? m : ''))
    .split(/(\x1b\[[0-9;]{0,30}m)/)
    .map((seg, i) => (i % 2 ? seg : seg.replace(UNPRINTABLE, (m) => m.replace(/[^\t]/gu, ''))))
    .join('');
}

/**
 * One line of shown text. Normalised first: every terminal code but colour (SGR) goes whole, then every other control
 * and invisible character but a tab, so nothing can sit inside a token. Then the colour-free text is cut to INPUT_MAX
 * and redacted, a private path named. Its colours are kept only when redaction left that text as it was; else it's the
 * redacted text, without them. Nothing is taken out after redaction runs.
 */
function shownTextLine(line) {
  const norm = normLine(line);
  const plain = norm.replace(SGR, '');
  // A line past INPUT_MAX is cut at a word, before redaction, and says so.
  const cut = plain.length > INPUT_MAX ? cutInput(plain) : plain;
  const r = privateWords(redact(cut));
  return r === plain ? norm : cut === plain ? r : `${r} … (line cut)`;
}

/** Lines already shown (each through shownTextLine), at most `max`: their head and tail around a line saying how many
 * weren't kept. Nothing is redacted or taken out of a line here. */
function capLines(lines, max, more = 0) {
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  const all = lines.join('\n');
  if (all.length <= max && !more) return all;
  const head = [], tail = [];
  let h = 0, k = 0;
  for (const l of lines) { if (h + l.length + 1 > max / 2) break; head.push(l); h += l.length + 1; }
  for (let i = lines.length - 1; i >= head.length; i--) { if (k + lines[i].length + 1 > max / 2 - 40) break; tail.unshift(lines[i]); k += lines[i].length + 1; }
  return [...head, `… ${lines.length - head.length - tail.length + more} lines not kept …`, ...tail].join('\n');
}

/**
 * The raw lines worth working on to show at most `max` (t-2109): a head and a tail of WINDOW times `max` each, and how
 * many lines between them weren't (capLines keeps less than either), so a long file isn't redacted whole to keep 32 KB.
 */
const WINDOW = 2;
function window(lines, max) {
  let n = 0;
  for (const l of lines) { n += l.length + 1; if (n > 2 * WINDOW * max) break; }
  if (n <= 2 * WINDOW * max) return { head: lines, middle: [], tail: [] };
  let h = 0, t = 0, i = 0, j = lines.length;
  while (i < j && h + lines[i].length + 1 <= WINDOW * max) h += lines[i++].length + 1;
  while (j > i && t + lines[j - 1].length + 1 <= WINDOW * max) t += lines[--j].length + 1;
  return { head: lines.slice(0, i), middle: lines.slice(i, j), tail: lines.slice(j) };
}

const KEY_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const KEY_END = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;

/**
 * A diff as shown: each line's content redacted apart from its mark (+, -, space), so `+NAME=value` is an assignment to
 * redact and `-print(…)` isn't read as a `-p` flag; a hunk header as itself; at most MAX_BODY.
 */
export function diffText(text) {
  // Its mark is read after the line is normalised, so nothing invisible before it can hide it. A key block's every line,
  // from its BEGIN to its END whatever its mark, goes whole (redact can't see a key line by line).
  // Only its head and tail are worked out (window); the lines between are read for a key block's start and end only.
  let inKey = false;
  const key = (l) => {
    const words = (/^[-+ ]/.test(l) ? l.slice(1) : l).replace(SGR, '');
    if (KEY_BEGIN.test(words)) inKey = true;
    if (inKey) { if (KEY_END.test(words)) inKey = false; return true; }
    return false;
  };
  const show = (raw) => { const l = normLine(raw); return key(l) ? GONE : /^[-+ ]/.test(l) ? `${l[0]}${shownTextLine(l.slice(1))}` : shownTextLine(l); };
  const { head, middle, tail } = window(String(text ?? '').slice(0, 2_000_000).split('\n'), MAX_BODY);
  const shown = head.map(show);
  for (const raw of middle) if (raw.includes('-----')) key(normLine(raw));
  return capLines([...shown, ...tail.map(show)], MAX_BODY, middle.length);
}

/**
 * Text as the owner's view shows it (t-2109): a key block taken out whole, then each line through shownTextLine; at
 * most `max`, its head and tail kept around a line saying how many weren't. '' for none.
 */
export function shownText(text, max = MAX_BODY) {
  let inKey = false;
  const key = (line) => {
    const words = line.replace(SGR, '');
    if (KEY_BEGIN.test(words)) inKey = true;
    if (!inKey) return false;
    if (KEY_END.test(words)) inKey = false;
    return true;
  };
  const show = (raw) => { const line = normLine(raw); return key(line) ? GONE : shownTextLine(line); };
  const { head, middle, tail } = window(String(text ?? '').slice(0, 2_000_000).split('\n'), max);
  const shown = head.map(show);
  for (const raw of middle) if (raw.includes('-----')) key(normLine(raw));
  return capLines([...shown, ...tail.map(show)], max, middle.length);
}

/** A shell command as Codex runs it (`/usr/bin/bash -lc '…'`), unwrapped to what the body wrote. */
function unwrapShell(c) {
  const m = /^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(String(c ?? '').trim());
  return m ? m[2] : String(c ?? '');
}

/**
 * A command that takes a secret in (t-2109): its words can hold one that redaction can't tell from any other word (a
 * value piped to a login, given to a secrets store, or written into a private file). Its command isn't shown, only its
 * label. Read on the command as written and on it as shown (where a private path reads PRIVATE_FILE).
 */
const SECRET_IN = /--password-stdin\b|--with-token\b|--token-stdin\b|\bgh\s+secret\s+set\b|\bgh\s+auth\s+login\b|\b(?:vault\s+(?:kv\s+)?(?:put|write)|kubectl\s+create\s+secret|docker\s+secret\s+create|secret-tool\s+store|pass\s+(?:insert|edit)|op\s+item\s+(?:create|edit)|aws\s+secretsmanager|gcloud\s+secrets|az\s+keyvault\s+secret\s+set|security\s+add-\w+-password|htpasswd|chpasswd|passwd)\b/i;
const CMD_MAX = 64_000;
const REDIRECT = /(?:>{1,2}|\btee\b(?:\s+-\w+)*)\s*(['"]?)([^\s'"|;&<>]+)\1/g;
export function secretIn(command) {
  // Read to CMD_MAX (a command past it isn't shown whole anyway); each scan bounded, so none backtracks far.
  const c = String(command ?? '').slice(0, CMD_MAX);
  if (SECRET_IN.test(c)) return true;
  for (const m of c.matchAll(REDIRECT)) if (privateFile(m[2])) return true;
  // Each part of a pipe or list on its own, with linear tests only: sudo reading its password from stdin; a write
  // into a file shown as private.
  for (const part of c.split(/[|;&\n]/)) {
    if (/\bsudo\b/i.test(part) && /\s(?:-[A-Za-z]*S[A-Za-z]*|--stdin)\b/i.test(part)) return true;
    if (/>|\btee\b/.test(part) && part.includes(PRIVATE_FILE)) return true;
  }
  return false;
}

/**
 * A shell step's whole command, as its card's `detail`: shown text (redacted line by line, a line continued with `\`
 * joined first so a secret on the next line is read with its flag), at most MAX_DETAIL; none for one that takes a
 * secret in (secretIn). Worked out once for the process (worked).
 */
export function commandLine(command) {
  // Past CMD_MAX, it isn't read for a secret taken in: so it isn't shown.
  if (String(command ?? '').length > CMD_MAX) return '';
  const c = String(command ?? '').replace(/\\\r?\n[ \t]*/g, ' ');
  if (secretIn(c)) return '';
  return worked('cmd', c, () => { const d = shownText(c.replace(SGR, ''), MAX_DETAIL); return secretIn(d) ? '' : d; });
}

/** A diff (Claude Code's structuredPatch hunks) as shown text: `@@ -a,b +c,d @@` and its lines. */
function patchText(patch) {
  if (!Array.isArray(patch)) return '';
  const out = [];
  for (const h of patch.slice(0, 200)) {
    if (!h || typeof h !== 'object') continue;
    const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
    out.push(`@@ -${n(h.oldStart)},${n(h.oldLines)} +${n(h.newStart)},${n(h.newLines)} @@`);
    for (const l of Array.isArray(h.lines) ? h.lines : []) if (typeof l === 'string') out.push(l.replace(/\n/g, ' '));
  }
  return diffText(out.join('\n'));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const count = (n) => (Number.isInteger(n) && n >= 0 && n < 1e9 ? n : null);

/** A test run's counts in fixed words, from its output (node --test, vitest, jest, pytest): `12 passed, 1 failed`. */
export function testsLine(output) {
  const t = String(output ?? '').slice(-20_000);
  let pass = null, fail = null;
  const node = /^[#ℹ] pass (\d{1,6})\s*$/m.exec(t), nodeF = /^[#ℹ] fail (\d{1,6})\s*$/m.exec(t);
  if (node) { pass = Number(node[1]); fail = nodeF ? Number(nodeF[1]) : 0; }
  const jest = /\bTests:\s{1,10}(?:(\d{1,6}) failed,\s*)?(?:\d{1,6} \w+,\s*)*?(\d{1,6}) passed/.exec(t);
  if (pass === null && jest) { pass = Number(jest[2]); fail = jest[1] ? Number(jest[1]) : 0; }
  const vitest = /\bTests\s{1,10}(?:(\d{1,6}) failed \|\s*)?(\d{1,6}) passed/.exec(t);
  if (pass === null && vitest) { pass = Number(vitest[2]); fail = vitest[1] ? Number(vitest[1]) : 0; }
  const py = /=+ (?:(\d{1,6}) failed, )?(\d{1,6}) passed(?:, (\d{1,6}) failed)?/.exec(t);
  if (pass === null && py) { pass = Number(py[2]); fail = Number(py[1] ?? py[3] ?? 0); }
  if (pass === null) return null;
  return fail ? `${pass} passed, ${fail} failed` : `${plural(pass, 'test')} passed`;
}

/** A shell step's result line: its exit code when it failed, a test run's counts, or how much it printed. */
function shellResult({ exit, output, failed }) {
  const tests = testsLine(output);
  const lines = String(output ?? '').split('\n').filter((l) => l.trim()).length;
  const code = Number.isInteger(exit) && exit !== 0 && Math.abs(exit) < 1e6 ? `exit ${exit}` : failed ? 'failed' : null;
  return [code, tests ?? (code ? null : lines ? plural(lines, 'line') + ' of output' : 'no output')].filter(Boolean).join(': ');
}

/** A patch's (Claude Code's structuredPatch) counts: `3 additions, 1 removal`. */
function patchLine(patch) {
  if (!Array.isArray(patch)) return null;
  let add = 0, rm = 0;
  for (const h of patch) for (const l of Array.isArray(h?.lines) ? h.lines : []) { if (typeof l !== 'string') continue; if (l.startsWith('+')) add++; else if (l.startsWith('-')) rm++; }
  return `${plural(add, 'addition')}, ${plural(rm, 'removal')}`;
}

/** A Claude tool's target, for `Tool(target)`: a shell step's command, a file's shown name, a search's pattern. */
function claudeDetail(name, i) {
  switch (name) {
    case 'Bash': return commandLine(i.command);
    case 'Read': case 'Edit': case 'MultiEdit': case 'Write': return fileName(i.file_path) === GONE ? '' : fileName(i.file_path);
    case 'NotebookEdit': return fileName(i.notebook_path) === GONE ? '' : fileName(i.notebook_path);
    case 'Grep': { const p = txt(i.pattern, 60); return p === GONE ? '' : `"${p}"${i.path && fileName(i.path) !== GONE ? ` in ${fileName(i.path)}` : ''}`; }
    case 'Glob': return privateGlob(i.pattern) ? PRIVATE_FILE : (lastPart(i.pattern) === GONE ? '' : lastPart(i.pattern));
    default: return '';
  }
}

/** Whether a file's contents must never show: no path, a private one, or one whose shown name isn't plain. */
function hidden(path) {
  if (typeof path !== 'string' || !path) return true;
  const n = fileName(path);
  return privateFile(path) || n === PRIVATE_FILE || n === GONE;
}

/** A shell step's own timeout, in seconds (Claude Code's Bash: `timeout` ms, 2 minutes when unset; none in the background). */
function claudeLimit(name, i) {
  if (name !== 'Bash' || i.run_in_background === true) return null;
  const ms = Number(i.timeout);
  return Math.min(86_400, Math.max(1, Math.ceil((Number.isFinite(ms) && ms > 0 ? ms : 120_000) / 1000)));
}

/** A finished Claude step's result line and its body (an edit's diff, made when read: lazyBody): from its `toolUseResult`. */
function claudeResult(name, r, text, failed, exit, input = {}) {
  const u = r && typeof r === 'object' ? r : {};
  // A private file's contents never show, in a diff or as written (a .env, a key, loom's private stores): its counts only.
  const shows = !hidden(input.file_path ?? input.notebook_path);
  switch (name) {
    case 'Bash': {
      // A shell step's output is read only for its fixed phrases (exit code, test counts, how many lines), never kept or
      // sent (t-2109: showing it on demand is its own task).
      const output = typeof u.stdout === 'string' || typeof u.stderr === 'string' ? [u.stdout, u.stderr].filter(Boolean).join('\n') : text;
      return { result: shellResult({ exit, output, failed }) };
    }
    case 'Read': { const n = count(u.file?.numLines); return n === null ? {} : { result: `Read ${plural(n, 'line')}` }; }
    case 'Edit': case 'MultiEdit': { const p = patchLine(u.structuredPatch); return p ? { result: p, ...(shows ? { body: () => worked('patch', JSON.stringify(u.structuredPatch), () => patchText(u.structuredPatch)) } : {}) } : {}; }
    case 'Write': {
      if (u.type === 'create' && typeof u.content === 'string') return { result: `Wrote ${plural(u.content.split('\n').length, 'line')}`, ...(shows ? { body: () => worked('write', u.content, () => diffText(u.content.split('\n').map((l) => `+${l}`).join('\n'))) } : {}) };
      const p = patchLine(u.structuredPatch); return p ? { result: p, ...(shows ? { body: () => worked('patch', JSON.stringify(u.structuredPatch), () => patchText(u.structuredPatch)) } : {}) } : {};
    }
    case 'Grep': { const f = count(u.numFiles), n = count(u.numLines); return n !== null && u.mode === 'content' ? { result: `Found ${plural(n, 'line')}` } : f !== null ? { result: `Found ${plural(f, 'file')}` } : {}; }
    case 'Glob': { const f = count(u.numFiles); return f === null ? {} : { result: `Found ${plural(f, 'file')}` }; }
    case 'Task': case 'Agent': { const n = count(u.totalToolUseCount); return n === null ? {} : { result: `${plural(n, 'tool use')}` }; }
    default: return {};
  }
}

/**
 * A card's `body` made only when it's first read (t-2109): a transcript's window holds thousands of steps, and only the
 * newest few are ever kept or sent, so their diffs and words are worked out, redacted line by line, for those only.
 * An empty one reads as none.
 */
/**
 * Text worked out once (t-2109): a diff or words shown are made again from the same input every pass (a transcript is
 * read whole each time), so what was made is kept for the process by its input's hash, the newest WORKED_MAX of them.
 */
const WORKED = new Map();
/** How many of each kind are kept: well over CARDS_KEPT for several conversations at once (a command is small). */
const WORKED_MAX = { cmd: 8000, text: 2000, 'gate-text': 2000, patch: 1500, write: 1500, 'gate-diff': 1500 };
function worked(kind, input, make) {
  if (!WORKED.has(kind)) WORKED.set(kind, new Map());
  const m = WORKED.get(kind), k = createHash('sha256').update(String(input)).digest('hex');
  if (m.has(k)) { const v = m.get(k); m.delete(k); m.set(k, v); return v; }
  const v = make();
  m.set(k, v);
  if (m.size > (WORKED_MAX[kind] ?? 1000)) m.delete(m.keys().next().value);
  return v;
}

function lazyBody(card, make, key = 'body') {
  let made = false, v;
  Object.defineProperty(card, key, { enumerable: true, configurable: true,
    get() { if (!made) { made = true; v = make() || undefined; } return v; },
    set(x) { Object.defineProperty(card, key, { value: x, enumerable: true, configurable: true, writable: true }); } });
  return card;
}

/** The cards in a Claude transcript's lines (parsed JSON objects), in order; `prefix` keeps ids unique per thread. */
export function claudeCards(lines, prefix = '', parent = null) {
  const cards = new Map(), names = new Map(), inputs = new Map();
  for (const l of lines) {
    const content = l?.message?.content;
    if (!Array.isArray(content)) continue;
    if (l.type === 'assistant') {
      // The body's own words between steps (t-2109): a `text` card, its first line the label and the whole the body.
      // Thinking never. Delivery keeps them only for a conversation that acts for the owner alone.
      // By its line's own uuid: Claude Code writes each block of one message as a line of its own, under one message id.
      const mid = typeof l.uuid === 'string' ? l.uuid : typeof l.message?.id === 'string' ? l.message.id : null;
      content.forEach((c, n) => {
        if (c?.type !== 'text' || typeof c.text !== 'string' || !c.text.trim() || !mid) return;
        const id = `${prefix}${mid}:${n}`.slice(0, 80);
        const label = part('text', firstLine(c.text), MAX_SUMMARY);
        if (label === GONE) return;
        const card = { id, at: cardTime(l.timestamp), tool: 'text', summary: clean(label), fixed: 'Wrote its words', state: 'done', ...(parent ? { parent } : {}) };
        cards.set(id, lazyBody(card, () => worked('text', c.text, () => shownText(c.text.replace(SGR, ''), MAX_TEXT))));
      });
      for (const c of content) {
        if (c?.type !== 'tool_use' || typeof c.id !== 'string') continue;
        const id = `${prefix}${c.id}`.slice(0, 80);
        if (cards.has(id)) continue;
        const name = String(c.name ?? ''), input = c.input && typeof c.input === 'object' ? c.input : {};
        const card = { id, at: cardTime(l.timestamp), tool: toolName(c.name), summary: claudeSummary(name, input) || 'Used a tool', fixed: claudeFixed(name, input), state: 'running', ...(parent ? { parent } : {}) };
        // A shell step's command is worked out only when it's read, as a body is (a window holds thousands).
        const limit = claudeLimit(name, input);
        if (name === 'Bash') lazyBody(card, () => claudeDetail(name, input), 'detail');
        else { const detail = claudeDetail(name, input); if (detail) card.detail = detail; }
        if (limit) card.limit = limit;
        if (name === 'TodoWrite') card.items = planItems((Array.isArray(input.todos) ? input.todos : []).map((t) => ({ text: t?.status === 'in_progress' ? (t.activeForm || t.content) : t?.content, done: t?.status === 'completed', now: t?.status === 'in_progress' })));
        names.set(id, name);
        inputs.set(id, input);
        cards.set(id, card);
      }
    } else if (l.type === 'user') {
      for (const c of content) {
        if (c?.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
        const card = cards.get(`${prefix}${c.tool_use_id}`.slice(0, 80));
        if (!card || card.state !== 'running') continue; // one result per call: a repeated line changes nothing
        card.state = c.is_error === true ? 'failed' : 'done';
        const text = resultText(c);
        // Claude Code's Bash result starts "Exit code N" on a failure.
        const code = /^Exit code (\d+)/.exec(text)?.[1];
        const exit = code ? Number(code) : undefined;
        if (card.state === 'failed') { const why = failWhy({ exit, output: text }); card.summary = withWhy(card.summary, why); card.fixed = fixedWhy(card.fixed, why); }
        // An exit code only for a shell step: any other tool's result text (a file's contents) is never read for one.
        if (Number.isInteger(exit) && SHELL_TOOLS.has(names.get(card.id))) card.exit = exit;
        // A line's toolUseResult is its one result's: with several results in one line, whose it is can't be told, so
        // none of them is read from it (no diff on the wrong card).
        const own = content.filter((x) => x?.type === 'tool_result').length === 1 ? l.toolUseResult : undefined;
        const { result, body } = claudeResult(names.get(card.id), own, text, card.state === 'failed', exit, inputs.get(card.id));
        if (result) card.result = clean(redact(result));
        if (body) lazyBody(card, body);
        if (typeof l.timestamp === 'string' && cardTime(l.timestamp) === l.timestamp) card.end = l.timestamp;
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
export function codexCards(events, prefix = '', timeOf = () => new Date().toISOString()) {
  const cards = new Map();
  for (const e of events) {
    const item = e?.item;
    if (!item || typeof item.id !== 'string') continue;
    if (item.type === 'agent_message') {
      if (e.type !== 'item.completed' || typeof item.text !== 'string' || !item.text.trim()) continue;
      const id = `${prefix}${item.id}`.slice(0, 80);
      const text = item.text;
      const card = { id, at: timeOf(id), tool: 'text', summary: finish(text.split('\n')[0]), fixed: 'Wrote its words', state: 'done' };
      cards.set(id, lazyBody(card, () => worked('text', text, () => shownText(text, MAX_TEXT))));
      continue;
    }
    if (!CODEX_TYPES.includes(item.type)) continue;
    const id = `${prefix}${item.id}`.slice(0, 80);
    if (!cards.has(id) && ['item.started', 'item.updated', 'item.completed'].includes(e.type)) {
      cards.set(id, { id, at: timeOf(id), tool: toolName(item.type), summary: '', state: item.type === 'todo_list' ? 'done' : 'running' });
    }
    const card = cards.get(id);
    if (!card) continue;
    const label = codexSummary(item); // once per event: a plan moves on item.updated, a step's label on completion
    if (!card.summary) card.summary = label;
    if (!card.fixed || item.type === 'todo_list') card.fixed = codexFixed(item);
    if (!card.detail) {
      const detail = item.type === 'command_execution' ? commandLine(unwrapShell(item.command))
        : item.type === 'file_change' && Array.isArray(item.changes) && item.changes.length && fileName(item.changes[0]?.path) !== GONE ? fileName(item.changes[0]?.path) : '';
      if (detail) card.detail = detail;
    }
    // A plan changes as the turn goes (item.updated): it's never a running step, only the latest plan.
    if (item.type === 'todo_list') { card.summary = label; card.items = planItems((Array.isArray(item.items) ? item.items : []).map((t) => ({ text: t?.text, done: t?.completed === true }))); continue; }
    if (e.type === 'item.completed') {
      card.state = item.status === 'failed' || (item.type === 'command_execution' && Number.isInteger(item.exit_code) && item.exit_code !== 0) ? 'failed' : 'done';
      card.summary = card.state === 'failed' ? withWhy(label, codexWhy(item)) : label;
      card.fixed = card.state === 'failed' ? fixedWhy(codexFixed(item), codexWhy(item)) : codexFixed(item);
      if (item.type === 'command_execution') {
        if (Number.isInteger(item.exit_code) && Math.abs(item.exit_code) < 1e6) card.exit = item.exit_code;
        card.result = clean(redact(shellResult({ exit: item.exit_code, output: item.aggregated_output, failed: card.state === 'failed' })));
      } else if (item.type === 'file_change' && Array.isArray(item.changes)) card.result = `${plural(item.changes.length, 'file')} changed`;
    }
  }
  return [...cards.values()];
}

/**
 * How many tokens a Claude session has written: each assistant message's output_tokens once (its largest: Claude
 * Code writes a message's lines as it streams, each with the usage so far); null for none. `seen` (message id → its
 * tokens) carries a count across reads of a growing transcript.
 */
export function claudeTokens(lines, seen = new Map()) {
  for (const l of lines) {
    const id = l?.message?.id, n = l?.message?.usage?.output_tokens;
    if (l?.type === 'assistant' && typeof id === 'string' && Number.isInteger(n) && n >= 0) seen.set(id, Math.max(seen.get(id) ?? 0, Math.min(n, 1e9)));
  }
  if (!seen.size) return null;
  let t = 0;
  for (const n of seen.values()) t += n;
  return Math.min(t, 1e12);
}

/** A body's last sign of life as core takes it: an ISO time, and its tokens so far when it says; null when neither. */
export function cleanAlive(a) {
  if (!a || typeof a !== 'object' || typeof a.at !== 'string' || !Number.isFinite(Date.parse(a.at)) || cardTime(a.at) !== a.at) return null;
  return { at: a.at, ...(Number.isInteger(a.tokens) && a.tokens >= 0 && a.tokens <= 1e12 ? { tokens: a.tokens } : {}) };
}

/**
 * A card's further parts (t-2109), as core takes them, each through the gate again: a house's (houserunner cleanCards)
 * and our own alike (delivery's activityPass passes every card through it before it's told). A part that isn't its shape is left out, never the card. `detail` shown text of at most
 * MAX_DETAIL without colours, `body` shown text of at most MAX_BODY, `result` one printable line of at most
 * MAX_SUMMARY, `items` at most MAX_ITEMS of {text (100), state done|now|todo}, `end` an ISO time, `parent` an id (as
 * the caller makes it), `exit` and `limit` whole numbers in range.
 */
export function stepParts(c, idOf = (x) => x, { words = true } = {}) {
  const o = {};
  // Its fixed label, only in a shape made here (FIXED); else none (delivery then says "Did a step").
  // A file it names isn't a private one (a house's label could say `Read .env`; one made here never does).
  const named = typeof c?.fixed === 'string' ? /^(?:Read|Edited|Wrote|Changed) (\S+)/.exec(c.fixed)?.[1] : undefined;
  if (typeof c?.fixed === 'string' && c.fixed.length <= MAX_SUMMARY && FIXED.test(c.fixed) && redact(c.fixed) === c.fixed && !(named && privateFile(named))) o.fixed = c.fixed;
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  const tool = String(c?.tool ?? '');
  // A target only of the shape made here for its tool (detailOk): a command; a file's base name; a search's pattern.
  if (words && typeof c?.detail === 'string' && c.detail) { const d = shownText(c.detail.replace(SGR, ''), MAX_DETAIL); if (d && detailOk(tool, d)) o.detail = d; }
  // A body only where one is made here (bodyAllowed): the body's words, or a diff of a file whose shown name is plain
  // and not private. Never a shell step's output, never a read's.
  // Read only where it may go: its words wanted, and its tool's (a lazy body is worked out only then).
  if (words && bodyAllowed(tool, o.detail) && typeof c?.body === 'string' && c.body) { const t = tool === 'text' ? worked('gate-text', c.body, () => shownText(c.body, MAX_TEXT)) : worked('gate-diff', c.body, () => diffText(c.body)); if (t) o.body = t; }
  // A result is one of the fixed phrases made here (shellResult, claudeResult, codexCards), never a house's prose.
  if (typeof c?.result === 'string' && RESULT.test(c.result) && redact(c.result) === c.result) o.result = c.result;
  const exit = int(c?.exit, -999_999, 999_999); if (exit !== null) o.exit = exit;
  const limit = int(c?.limit, 1, 86_400); if (limit !== null) o.limit = limit;
  if (typeof c?.end === 'string' && cardTime(c.end) === c.end) o.end = c.end;
  if (typeof c?.parent === 'string' && /^[A-Za-z0-9_.:\-]{1,80}$/.test(c.parent)) { const p = idOf(c.parent); if (p) o.parent = p; }
  if (words && Array.isArray(c?.items) && c.items.length) {
    o.items = c.items.slice(0, MAX_ITEMS).map((x) => { const t = typeof x?.text === 'string' ? part('text', x.text, 100) : GONE; return { text: t === GONE ? 'an item' : t, state: ['done', 'now', 'todo'].includes(x?.state) ? x.state : 'todo' }; });
  }
  return o;
}

const DIFFS = new Set(['Edit', 'MultiEdit', 'Write']);
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'file_change', 'Glob']);
const SHELL_TOOLS = new Set(['Bash', 'command_execution']);
/** Whether a target fits what's made here for its tool: a shell step's command; a file tool's base name (no folder);
 * a search's `"pattern"` and where; nothing for any other tool (a private store's argument never shows). */
function detailOk(tool, d) {
  // A house's command is read for a secret taken in as one made here is (secretIn).
  if (SHELL_TOOLS.has(tool)) return !secretIn(d);
  if (FILE_TOOLS.has(tool)) return d.length <= 80 && !/[/\\\n]/.test(d) && fileName(d) === d;
  if (tool === 'Grep') return d.length <= 160 && /^"[^"\n]{1,60}"(?: in [^/\\\n]{1,80})?$/.test(d);
  return false;
}
/** The result lines made here, as their shapes: counts and fixed words only. */
const N = '\\d{1,9}';
const TESTS = `(?:${N} tests? passed|${N} passed, ${N} failed)`;
const RESULT = new RegExp(`^(?:(?:exit -?${N}|failed)(?:: ${TESTS})?|${TESTS}|${N} lines? of output|no output|Read ${N} lines?|Wrote ${N} lines?|${N} additions?, ${N} removals?|Found ${N} (?:files?|lines?)|${N} tool uses?|${N} files? changed)$`);
/** Whether a card of this tool, with this (gated) target, may carry a body: the rule claudeResult follows (`shows`). */
function bodyAllowed(tool, detail) {
  if (tool === 'text') return true;
  if (DIFFS.has(tool)) return !!detail && detail !== PRIVATE_FILE && detail !== GONE && !hidden(detail);
  return false;
}

/** Only a card's base fields, as a core from before t-2109 takes them. */
export const baseCard = (c) => ({ id: c.id, at: c.at, tool: c.tool, summary: c.summary, state: c.state });

/** What the record keeps of a card: its state and a short hash of its label (never the label itself). */
const mark = (c) => `${c.state}:${createHash('sha256').update(JSON.stringify([c.summary, c.fixed, c.detail, c.result, c.body, c.exit, c.limit, c.end, c.items, c.parent])).digest('hex').slice(0, 8)}`;

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
  // Keep the record bounded: every card still in what was read (or each would be told again, t-2109), and of the rest,
  // the newest, to 400 in all.
  const keys = Object.keys(next);
  if (keys.length > 400) {
    const now = new Set(cards.map((c) => c.id));
    let over = keys.length - Math.max(400, now.size);
    for (const k of keys) { if (over <= 0) break; if (!now.has(k)) { delete next[k]; over--; } }
  }
  return { out, next };
}
