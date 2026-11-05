// Activity: what a body in a Comms thread is doing, as plain one-line cards (loom docs/specs/comms.md, section 3).
// Read only for bodies of venue `loom`, from the harness's own record:
//   - Claude: the session transcript (<projects>/<cwd>/<session>.jsonl). An `assistant` line's `tool_use` entry makes a
//     `running` card; a later `user` line's `tool_result` for it makes it `done`, or `failed` when `is_error`.
//   - Codex: events.jsonl. `item.started` makes a card, `item.completed` finishes it (`status: "failed"` is failed).
// A card's summary comes from the fixed table below, never from a model, and never carries a tool's output or result,
// a file's contents, a command line itself or an environment value. Text and thinking entries make no card.

export const MAX_SUMMARY = 120;
export const MAX_CARDS = 50;

const LOOM_TOOLS = {
  recall: 'Recalled memories', remember: 'Remembered something', forget: 'Forgot a memory', identity: 'Loaded who it is',
  note_write: 'Wrote a note', note_read: 'Read a note', note_list: 'Listed notes', knowledge_recall: 'Looked up what it knows',
  knowledge_write: 'Wrote down a fact', knowledge_verify: 'Checked a fact', conversation_digest: 'Wrote its digest',
  conversations: 'Looked at its conversations', conversation: 'Read a conversation', comms_title: 'Named the thread',
  relay: 'Messaged another agent', person: 'Read a person card', person_write: 'Updated a person card',
  project: 'Read a project card', project_hub: 'Looked at a project', project_write: 'Updated a project card',
};

/** One printable line of at most MAX_SUMMARY: control characters and line breaks gone. */
export function clean(s) {
  const one = String(s ?? '').replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > MAX_SUMMARY ? `${one.slice(0, MAX_SUMMARY - 1)}…` : one;
}

const cut = (s, n) => { const t = clean(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** A path for showing: relative to the repo (the body's working directory), never absolute. */
export function shownPath(p, cwd) {
  const s = String(p ?? '');
  if (!s) return 'a file';
  if (cwd && s.startsWith(`${cwd.replace(/\/+$/, '')}/`)) return s.slice(cwd.replace(/\/+$/, '').length + 1);
  if (s.startsWith('/')) return s.split('/').filter(Boolean).pop() ?? 'a file';
  return s;
}

/** The tool's name in words, for an MCP tool (`mcp__<server>__<tool>`) or a plain name. */
function mcpWords(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  const tool = m ? m[2] : name;
  return LOOM_TOOLS[tool] ?? `Used ${tool.replace(/[_-]+/g, ' ')}`;
}

/** A Claude Code tool call's summary, by the fixed table (comms.md, section 3). */
export function claudeSummary(name, input = {}, cwd) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Bash': return clean(typeof i.description === 'string' && i.description.trim() ? i.description : 'Ran a command');
    case 'Read': return clean(`Read ${shownPath(i.file_path, cwd)}`);
    case 'Edit': case 'MultiEdit': return clean(`Edited ${shownPath(i.file_path, cwd)}`);
    case 'Write': return clean(`Wrote ${shownPath(i.file_path, cwd)}`);
    case 'NotebookEdit': return clean(`Edited ${shownPath(i.notebook_path, cwd)}`);
    case 'Grep': return clean(`Searched for ${cut(i.pattern, 60)}`);
    case 'Glob': return clean(`Looked for files: ${cut(i.pattern, 60)}`);
    case 'WebSearch': return clean(`Searched the web for ${cut(i.query, 60)}`);
    case 'WebFetch': return 'Read a web page';
    case 'Task': case 'Agent': return 'Started a helper';
    case 'TodoWrite': return 'Updated its to-do list';
    default: return clean(name.startsWith('mcp__') ? mcpWords(name) : name);
  }
}

const TOOL = /^[A-Za-z0-9_.:\-]{1,64}$/;
const toolName = (n) => (TOOL.test(String(n)) ? String(n) : 'tool');

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
        if (!cards.has(id)) cards.set(id, { id, at: typeof l.timestamp === 'string' ? l.timestamp : new Date().toISOString(), tool: toolName(c.name), summary: claudeSummary(String(c.name ?? ''), c.input, l.cwd) || 'Used a tool', state: 'running' });
      }
    } else if (l.type === 'user') {
      for (const c of content) {
        if (c?.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
        const card = cards.get(`${prefix}${c.tool_use_id}`.slice(0, 80));
        if (card) card.state = c.is_error === true ? 'failed' : 'done';
      }
    }
  }
  return [...cards.values()];
}

const CODEX_TYPES = ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'];

function codexSummary(item) {
  switch (item.type) {
    case 'command_execution': return 'Ran a command';
    case 'file_change': {
      const paths = Array.isArray(item.changes) ? item.changes.map((c) => shownPath(c?.path)).filter(Boolean) : [];
      return clean(paths.length === 1 ? `Changed ${paths[0]}` : paths.length ? `Changed ${paths.length} files` : 'Changed files');
    }
    case 'mcp_tool_call': return clean(LOOM_TOOLS[item.tool] ?? `Used ${String(item.tool ?? 'a tool').replace(/[_-]+/g, ' ')}`);
    case 'web_search': return clean(`Searched the web for ${cut(item.query, 60)}`);
    default: return 'Used a tool';
  }
}

/** The cards in a Codex run's events (parsed JSON objects), in order; `prefix` keeps item ids unique per thread. */
export function codexCards(events, prefix = '') {
  const cards = new Map();
  for (const e of events) {
    const item = e?.item;
    if (!item || !CODEX_TYPES.includes(item.type) || typeof item.id !== 'string') continue;
    const id = `${prefix}${item.id}`.slice(0, 80);
    if (e.type === 'item.started' || (e.type === 'item.completed' && !cards.has(id))) {
      if (!cards.has(id)) cards.set(id, { id, at: new Date().toISOString(), tool: toolName(item.type), summary: codexSummary(item), state: 'running' });
    }
    if (e.type === 'item.completed') cards.get(id).state = item.status === 'failed' ? 'failed' : 'done';
  }
  return [...cards.values()];
}

/**
 * What to post of `cards` given what was posted (`sent`: id → state): the new ones and those whose state moved, at most
 * MAX_CARDS (the oldest first). Answers the cards and the record after posting them.
 */
export function changed(cards, sent = {}) {
  const out = cards.filter((c) => sent[c.id] !== c.state).slice(0, MAX_CARDS);
  const next = { ...sent };
  for (const c of out) next[c.id] = c.state;
  // Keep the record bounded: the newest 400 ids.
  const keys = Object.keys(next);
  if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete next[k];
  return { out, next };
}
