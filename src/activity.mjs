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
// fixed phrases (`Read 120 lines`, `3 additions, 1 removal`, `12 passed, 1 failed`, `exit 1`); `body`, a shell step's
// whole output or an edit's diff, each line redacted (shownText), ANSI colours kept, at most MAX_BODY; `exit`; `limit`,
// the step's own timeout in seconds; `end`, when it finished; `parent`, the helper (subagent) it ran under; and for a
// plan, `items`, its checklist. The body's own words between steps are a `text` card (tool `text`), which delivery
// shows only for a conversation that acts for the owner alone. A read shows its line count, never what it read.
import { createHash } from 'node:crypto';
import { commandLabel, cutInput, cutTo, failWhy, fileName, GONE, INPUT_MAX, part, PRIVATE_FILE, privateFile, privateWords, redact, UNPRINTABLE, UNPRINTABLE_ONE } from './redact.mjs';

const INVISIBLE_CH = /[\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\ufe00-\ufe0f\uffa0\u{E0100}-\u{E01EF}]/gu;

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

/**
 * One line of shown text. Normalised first: every terminal code but colour (SGR) goes whole, then every other control
 * and invisible character but a tab, so nothing can sit inside a token. Then the colour-free text is cut to INPUT_MAX
 * and redacted, a private path named. Its colours are kept only when redaction left that text as it was; else it's the
 * redacted text, without them. Nothing is taken out after redaction runs.
 */
function shownTextLine(line) {
  const norm = String(line)
    .replace(/\x1b\][^\x07\x1b]{0,2000}(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-9;?]{0,30}[A-Za-ln-z]/g, '')
    .replace(/\x1b\[[0-9;]{0,30}m|\x1b|[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, (m) => (m.length > 1 ? m : ''))
    .replace(INVISIBLE_CH, '');
  const plain = norm.replace(SGR, '');
  const cut = plain.length > INPUT_MAX ? cutInput(plain) : plain;
  const r = privateWords(redact(cut));
  return r === plain ? norm : r;
}

/**
 * Text as the owner's view shows it (t-2109): a key block taken out whole, then each line through shownTextLine; at
 * most `max`, its head and tail kept around a line saying how many weren't. '' for none.
 */
export function shownText(text, max = MAX_BODY) {
  const t = String(text ?? '').slice(0, 2_000_000).replace(/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g, GONE);
  const lines = t.split('\n').map(shownTextLine);
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  const all = lines.join('\n');
  if (all.length <= max) return all;
  const head = [], tail = [];
  let h = 0, k = 0;
  for (const l of lines) { if (h + l.length + 1 > max / 2) break; head.push(l); h += l.length + 1; }
  for (let i = lines.length - 1; i >= head.length; i--) { if (k + lines[i].length + 1 > max / 2 - 40) break; tail.unshift(lines[i]); k += lines[i].length + 1; }
  return [...head, `… ${lines.length - head.length - tail.length} lines not kept …`, ...tail].join('\n');
}

/** A shell command as Codex runs it (`/usr/bin/bash -lc '…'`), unwrapped to what the body wrote. */
function unwrapShell(c) {
  const m = /^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(String(c ?? '').trim());
  return m ? m[2] : String(c ?? '');
}

/** A shell step's whole command, as its card's `detail`: shown text (redacted line by line), at most MAX_DETAIL. */
export function commandLine(command) {
  return shownText(String(command ?? '').replace(SGR, ''), MAX_DETAIL);
}

/** A diff (Claude Code's structuredPatch hunks) as shown text: `@@ -a,b +c,d @@` and its lines. */
function patchText(patch) {
  if (!Array.isArray(patch)) return '';
  const out = [];
  for (const h of patch.slice(0, 200)) {
    if (!h || typeof h !== 'object') continue;
    const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
    out.push(`@@ -${n(h.oldStart)},${n(h.oldLines)} +${n(h.newStart)},${n(h.newLines)} @@`);
    for (const l of Array.isArray(h.lines) ? h.lines : []) if (typeof l === 'string') out.push(l);
  }
  return shownText(out.join('\n'));
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

/** A finished Claude step's result line and its body (a shell step's output, an edit's diff): from its `toolUseResult`. */
function claudeResult(name, r, text, failed, exit, input = {}) {
  const u = r && typeof r === 'object' ? r : {};
  // A private file's contents never show, in a diff or as written (a .env, a key, loom's private stores): its counts only.
  const shows = !hidden(input.file_path ?? input.notebook_path);
  switch (name) {
    case 'Bash': {
      const output = typeof u.stdout === 'string' || typeof u.stderr === 'string' ? [u.stdout, u.stderr].filter(Boolean).join('\n') : text;
      const body = shownText(output);
      return { result: shellResult({ exit, output, failed }), ...(body ? { body } : {}) };
    }
    case 'Read': { const n = count(u.file?.numLines); return n === null ? {} : { result: `Read ${plural(n, 'line')}` }; }
    case 'Edit': case 'MultiEdit': { const p = patchLine(u.structuredPatch), body = shows ? patchText(u.structuredPatch) : ''; return p ? { result: p, ...(body ? { body } : {}) } : {}; }
    case 'Write': {
      if (u.type === 'create' && typeof u.content === 'string') { const body = shows ? shownText(u.content.split('\n').map((l) => `+${l}`).join('\n')) : ''; return { result: `Wrote ${plural(u.content.split('\n').length, 'line')}`, ...(body ? { body } : {}) }; }
      const p = patchLine(u.structuredPatch), body = shows ? patchText(u.structuredPatch) : ''; return p ? { result: p, ...(body ? { body } : {}) } : {};
    }
    case 'Grep': { const f = count(u.numFiles), n = count(u.numLines); return n !== null && u.mode === 'content' ? { result: `Found ${plural(n, 'line')}` } : f !== null ? { result: `Found ${plural(f, 'file')}` } : {}; }
    case 'Glob': { const f = count(u.numFiles); return f === null ? {} : { result: `Found ${plural(f, 'file')}` }; }
    case 'Task': case 'Agent': { const n = count(u.totalToolUseCount); return n === null ? {} : { result: `${plural(n, 'tool use')}` }; }
    default: return {};
  }
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
      const mid = typeof l.message?.id === 'string' ? l.message.id : typeof l.uuid === 'string' ? l.uuid : null;
      content.forEach((c, n) => {
        if (c?.type !== 'text' || typeof c.text !== 'string' || !c.text.trim() || !mid) return;
        const id = `${prefix}${mid}:${n}`.slice(0, 80);
        const body = shownText(c.text.replace(SGR, ''), MAX_TEXT);
        const label = part('text', firstLine(c.text), MAX_SUMMARY);
        if (!body || label === GONE) return;
        cards.set(id, { id, at: cardTime(l.timestamp), tool: 'text', summary: clean(label), state: 'done', body, ...(parent ? { parent } : {}) });
      });
      for (const c of content) {
        if (c?.type !== 'tool_use' || typeof c.id !== 'string') continue;
        const id = `${prefix}${c.id}`.slice(0, 80);
        if (cards.has(id)) continue;
        const name = String(c.name ?? ''), input = c.input && typeof c.input === 'object' ? c.input : {};
        const card = { id, at: cardTime(l.timestamp), tool: toolName(c.name), summary: claudeSummary(name, input) || 'Used a tool', state: 'running', ...(parent ? { parent } : {}) };
        const detail = claudeDetail(name, input), limit = claudeLimit(name, input);
        if (detail) card.detail = detail;
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
        if (card.state === 'failed') card.summary = withWhy(card.summary, failWhy({ exit, output: text }));
        if (Number.isInteger(exit)) card.exit = exit;
        const { result, body } = claudeResult(names.get(card.id), l.toolUseResult, text, card.state === 'failed', exit, inputs.get(card.id));
        if (result) card.result = clean(redact(result));
        if (body) card.body = body;
        if (typeof l.timestamp === 'string') card.end = cardTime(l.timestamp);
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
      if (item.type === 'command_execution') {
        if (Number.isInteger(item.exit_code) && Math.abs(item.exit_code) < 1e6) card.exit = item.exit_code;
        card.result = clean(redact(shellResult({ exit: item.exit_code, output: item.aggregated_output, failed: card.state === 'failed' })));
        const body = shownText(item.aggregated_output);
        if (body) card.body = body;
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
 * A card's further parts (t-2109), as core takes them, each through the gate again: from a house's word (houserunner
 * cleanCards) as from our own. A part that isn't its shape is left out, never the card. `detail` shown text of at most
 * MAX_DETAIL without colours, `body` shown text of at most MAX_BODY, `result` one printable line of at most
 * MAX_SUMMARY, `items` at most MAX_ITEMS of {text (100), state done|now|todo}, `end` an ISO time, `parent` an id (as
 * the caller makes it), `exit` and `limit` whole numbers in range.
 */
export function stepParts(c, idOf = (x) => x) {
  const o = {};
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  if (typeof c?.detail === 'string' && c.detail) { const d = shownText(c.detail.replace(SGR, ''), MAX_DETAIL); if (d) o.detail = d; }
  if (typeof c?.body === 'string' && c.body) { const t = shownText(c.body, MAX_BODY); if (t) o.body = t; }
  if (typeof c?.result === 'string' && c.result) { const r = part('text', c.result, MAX_SUMMARY); if (r !== GONE && !UNPRINTABLE_ONE.test(r)) o.result = r; }
  const exit = int(c?.exit, -999_999, 999_999); if (exit !== null) o.exit = exit;
  const limit = int(c?.limit, 1, 86_400); if (limit !== null) o.limit = limit;
  if (typeof c?.end === 'string' && cardTime(c.end) === c.end) o.end = c.end;
  if (typeof c?.parent === 'string' && /^[A-Za-z0-9_.:\-]{1,80}$/.test(c.parent)) { const p = idOf(c.parent); if (p) o.parent = p; }
  if (Array.isArray(c?.items) && c.items.length) {
    o.items = c.items.slice(0, MAX_ITEMS).map((x) => { const t = typeof x?.text === 'string' ? part('text', x.text, 100) : GONE; return { text: t === GONE ? 'an item' : t, state: ['done', 'now', 'todo'].includes(x?.state) ? x.state : 'todo' }; });
  }
  return o;
}

/** Only a card's base fields, as a core from before t-2109 takes them. */
export const baseCard = (c) => ({ id: c.id, at: c.at, tool: c.tool, summary: c.summary, state: c.state });

/** What the record keeps of a card: its state and a short hash of its label (never the label itself). */
const mark = (c) => `${c.state}:${createHash('sha256').update(JSON.stringify([c.summary, c.detail, c.result, c.body, c.exit, c.end, c.items, c.parent])).digest('hex').slice(0, 8)}`;

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
