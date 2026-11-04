// The owner's alert command (t-1830): what the runtime notices that's wrong (a bridge down or crash-looping, a
// conversation paused as a loop, a body that couldn't start) goes to the owner's Inbox as it always has, and also to
// this command, so the agent can look into it first. LOOM_RUNTIME_ALERT_COMMAND, a JSON argv; the runtime adds
// `<source> --severity <warn|bad> --summary <one line> [--fact k=v]...` and runs it detached: it never waits on it,
// and a command that fails, or isn't set, changes nothing else.
//
// Never for a conversation that's itself an alert's (place alert:…): its own trouble is the owner's to hear, as an
// ask, not one more alert into the conversation that's in trouble.
import { spawn as nodeSpawn } from 'node:child_process';
import { setting } from './piece.mjs';

const SOURCE = /^[a-z][a-z0-9-]{0,39}$/;
const FACT_KEY = /^[a-z][a-z0-9_-]{0,31}$/;

export function alertArgv(env) {
  try {
    const a = JSON.parse(setting(env, 'ALERT_COMMAND') || 'null');
    return Array.isArray(a) && a.length && a.every((x) => typeof x === 'string' && x) ? a : null;
  } catch { return null; }
}

const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The argv for one alert, or null (no command, a bad source, or an alert's own conversation). */
export function alertCall(env, { source, severity = 'warn', summary, facts = {}, place }) {
  const argv = alertArgv(env);
  if (!argv || !SOURCE.test(source ?? '') || !oneLine(summary, 1)) return null;
  if (typeof place === 'string' && place.startsWith('alert:')) return null;
  const out = [...argv, source, '--severity', severity === 'bad' ? 'bad' : 'warn', '--summary', oneLine(summary, 200)];
  for (const [k, v] of Object.entries(facts)) {
    if (!FACT_KEY.test(k) || v === undefined || v === null || v === '') continue;
    out.push('--fact', `${k}=${oneLine(v, 300)}`);
  }
  return out;
}

/** Run it, detached; true when it was started. Never throws. */
export function raiseAlert(env, alert, o = {}) {
  const argv = alertCall(env, alert);
  if (!argv) return false;
  try {
    const child = (o.spawn ?? nodeSpawn)(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', env });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch { return false; }
}
