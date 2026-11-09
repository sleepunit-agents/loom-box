// Shared task-host lifecycle, including bounded script timeout signals: stop and collect before returning.
import { runBodyHost } from './bodyhost.mjs';
export async function runTaskClient({ call, runner, env, brief, signals = process, host = runBodyHost, log = () => {} }) {
  let cancelling = false, cancelled = false, result;
  const stop = () => { cancelling = true; };
  signals.on('SIGTERM', stop); signals.on('SIGINT', stop);
  try {
    const boot = await call(brief === undefined ? 'task-bootstrap' : 'script-bootstrap', brief === undefined ? {} : { brief });
    if (boot.error || !boot.hostKey) throw Error(boot.error || 'the runtime did not bootstrap this task');
    await host({ client: async (path, body) => {
      const r = await call(path, body); if (r.error) throw Error(r.error);
      if (path === 'body-sync' && !r.exit) {
        if (cancelling && !cancelled) {
          const answer = await call('task-cancel', {});
          if (answer.error) throw Error(answer.error);
          cancelled = true;
        }
        const status = await call('task-status', {});
        if (status.error) throw Error(status.error);
        if (status.done) { result = status; return { ...r, exit: true, reason: 'task report and session collected' }; }
      }
      return r;
    }, runner, env, hostKey: boot.hostKey, idleS: 0, log });
    if (cancelling && result?.ok) return { done: true, ok: false, cancelled: true, reason: 'the task was cancelled' };
    return result ?? { done: false, ok: false, reason: 'task host ended before its result was collected' };
  } finally {
    signals.removeListener('SIGTERM', stop); signals.removeListener('SIGINT', stop);
  }
}
