// Cooperative cap: a context observation requests one handoff at a tool boundary.
// A handoff is explicit; a normal final response still completes the job.
// Rotation follows measured context, never a count of finished tasks: a fresh session pays to
// read everything again, so a body keeps its session until the runtime sees it filling.
export const TASK_BOUNDARY = 'Keep working in this session across completed tasks: finishing, pushing or merging one is not a reason to begin a fresh session, and waiting on checks is time to begin the next task. Do not rotate on your own. The runtime measures this job\'s context and tells you when it is filling; only then, after finishing the task you are on, pipe a handoff of at most 12,000 characters to `loom runtime context-boundary --note -` and end the turn without beginning more work. The runtime keeps this conversation and resumes the job in a fresh session after acknowledgment. If the whole job is complete, return the actual result instead.';
export const BOUNDARY_REQUEST = 'The runtime observed that this job\'s context is filling (past its boundary point, below its cap). Do not stop mid-task. Finish the task you are on, then pipe your handoff to `loom runtime context-boundary --note -` and end the turn without beginning more work. Include the original goal, completed work, remaining steps, repositories and worktree paths, branch heads and PRs, test/review results, blockers and required host steps, in at most 12,000 characters. If the cap arrives first the runtime asks for an immediate handoff instead.';
export const HANDOFF_MARKER = 'LOOM_CONTEXT_HANDOFF\n';
export const HANDOFF_REQUEST = 'The runtime observed the job context cap. Stop new work at the next safe boundary. Write your handoff as your final response, beginning exactly LOOM_CONTEXT_HANDOFF on its own line. Include the original goal, completed work, remaining steps, repositories and worktree paths, branch heads and PRs, test/review results, blockers and required host steps. Keep it under 12,000 characters. Do not present this as completion. The runtime saves this note and continues the same job in a fresh session.';
export function contextCapOf(env, conversation) {
  const raw = env.LOOM_RUNTIME_CONTEXT_CAP;
  if (raw === '0' || raw === 'off') return null;
  const cap = raw === undefined || raw === '' ? 150000 : Number(raw);
  if (!Number.isInteger(cap) || cap < 20000 || cap > 2000000) return null;
  return conversation.kind === 'scheduled' || conversation.kind === 'agent' ? cap : null;
}
/** Where the runtime asks for a handoff at the next finished task: two thirds of the cap unless set. */
export function contextBoundaryOf(env, conversation) {
  const cap = contextCapOf(env, conversation);
  if (!cap) return null;
  const raw = env.LOOM_RUNTIME_CONTEXT_BOUNDARY;
  if (raw === '0' || raw === 'off') return null;
  const at = raw === undefined || raw === '' ? Math.floor(cap * 2 / 3) : Number(raw);
  return Number.isInteger(at) && at >= 10000 && at < cap ? at : null;
}
export function handoffText(text) {
  if (typeof text !== 'string' || !text.startsWith(HANDOFF_MARKER)) return null;
  const note = text.slice(HANDOFF_MARKER.length).trim();
  return note && note.length <= 12000 ? note : null;
}
export function lastContext(harness, text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let r; try { r = JSON.parse(lines[i]); } catch { continue; }
    let value;
    if (harness === 'claude' && r.type === 'assistant' && r.message?.usage) {
      const u = r.message.usage;
      value = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
    if (harness === 'codex' && r.type === 'event_msg' && r.payload?.type === 'token_count') value = r.payload.info?.last_token_usage?.input_tokens;
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}
