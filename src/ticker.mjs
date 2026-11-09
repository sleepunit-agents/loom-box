// Current tool state only. No argument, command, summary or chat text crosses this boundary.
export const ACTIONS = new Set(['Working', 'Running a command', 'Reading a file', 'Editing a file', 'Writing a file', 'Searching files', 'Searching the web', 'Using a tool', 'Starting a helper']);
const claudeAction = n => ({Bash:'Running a command',Read:'Reading a file',Edit:'Editing a file',MultiEdit:'Editing a file',Write:'Writing a file',Grep:'Searching files',Glob:'Searching files',WebSearch:'Searching the web',WebFetch:'Using a tool',Agent:'Starting a helper',Task:'Starting a helper'})[n] ?? 'Using a tool';
const codexAction = n => ({command_execution:'Running a command',file_change:'Editing a file',web_search:'Searching the web',mcp_tool_call:'Using a tool'})[n];
export function claudeActionNow(lines) {
  const pending = new Map();
  for (const l of lines) {
    const cs = l?.message?.content;
    if (l.type === 'system' && l.subtype === 'turn_duration') pending.clear();
    if (!Array.isArray(cs)) { if (l.type === 'user') pending.clear(); continue; }
    // A new user turn cannot inherit an unfinished tool from a previous turn.
    if (l.type === 'user' && !cs.some(c => c.type === 'tool_result')) pending.clear();
    for (const c of cs) {
      if (l.type === 'assistant' && c.type === 'tool_use' && typeof c.id === 'string') pending.set(c.id, claudeAction(c.name));
      if (l.type === 'user' && c.type === 'tool_result') pending.delete(c.tool_use_id);
    }
    if (l.message?.stop_reason === 'end_turn') pending.clear();
  }
  return [...pending.values()].at(-1) ?? 'Working';
}
export function codexActionNow(events) {
  const pending = new Map();
  for (const e of events) {
    if (['turn.started', 'turn.completed', 'turn.failed'].includes(e.type)) pending.clear();
    const i = e.item;
    if (!i || typeof i.id !== 'string') continue;
    if (e.type === 'item.completed') pending.delete(i.id);
    else if (e.type === 'item.started' && codexAction(i.type)) pending.set(i.id, codexAction(i.type));
  }
  return [...pending.values()].at(-1) ?? 'Working';
}
export function observation(action, observedAt, now = Date.now()) {
  const at = Date.parse(observedAt);
  if (!ACTIONS.has(action) || !Number.isFinite(at) || at > now || now - at >= 30000) return null;
  return { action, observedAt: new Date(at).toISOString(), expiresAt: new Date(at + 30000).toISOString() };
}
