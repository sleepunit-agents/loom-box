// `loom-runtime api --serve` (t-2065): the piece API for the paths the runtime declares in its loom block
// (`api_serve`), from one long-lived process instead of one per call. A body host's `body-sync` comes every 2 s from
// every warm house, and each was a node start on loom's machine.
//
// Core writes one request per line, {id, grant, request}, and reads one answer per line, {id, exit, stdout}: stdout
// is exactly what `api --json` would have printed for that request, so core reads it the same way. One request at a
// time, in order. Its store grant (minted by core for this call, or null) is that request's env only: the process
// itself holds none, and nothing of one request's env is kept for the next.
//
// Only SERVED paths: every other module here may keep what one process saw (delivery's store client, its gates) on
// the understanding that a process is one call. A path joins SERVED only once what it reaches keeps nothing of one
// caller for another; anything else is refused here even if core asks (exit 2: the call fails, it never runs here).
// A path core serves must be in SERVED and in the loom block's api_serve alike (a test keeps the two the same).
import { createInterface } from 'node:readline';
import { api } from './control.mjs';
import { realEffects } from './effects.mjs';

/** The paths served here, as the loom block's `api_serve` declares them (a test keeps the two the same). */
export const SERVED = Object.freeze(['body-sync']);

const ID = /^[0-9]{1,15}$/;

/** One request line to its answer line's fields: what `api --json` would print, or the exit it would have made. */
export async function serveOne(base, line, { call = api } = {}) {
  let m;
  try { m = JSON.parse(line); } catch { return null; }
  if (!m || typeof m !== 'object' || !ID.test(String(m.id ?? ''))) return null;
  const { id, grant, request } = m;
  if (grant !== null && grant !== undefined && typeof grant !== 'string') return { id, exit: 2 };
  if (!request || typeof request !== 'object' || !SERVED.includes(request.path)) return { id, exit: 2 };
  const env = grant ? { ...base, LOOM_STORE_GRANT: grant } : base;
  try {
    return { id, exit: 0, stdout: JSON.stringify(await call(env, realEffects(env), request)) + '\n' };
  } catch (e) {
    return { id, exit: Number.isInteger(e?.code) && e.code > 0 ? e.code : 1 };
  }
}

/** Serve until stdin ends. What anything else prints goes to stderr: stdout is the answers' alone. */
export async function serveApi(env, { input = process.stdin, output = process.stdout, call = api } = {}) {
  const { LOOM_STORE_GRANT: _none, ...base } = env;
  const write = output.write.bind(output);
  if (output === process.stdout) process.stdout.write = (...a) => process.stderr.write(...a);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const r = await serveOne(base, line, { call });
    if (r) write(JSON.stringify(r) + '\n');
  }
}
