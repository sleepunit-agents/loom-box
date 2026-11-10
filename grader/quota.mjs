// Emit only CLI quota metadata before the disposable home is removed. Never
// print a rollout, prompt, response or credential.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function quotaEvents(root) {
  const walk = p => { try { return readdirSync(p, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(p, e.name)) : e.isFile() && e.name.endsWith('.jsonl') ? [join(p, e.name)] : []); } catch { return []; } };
  let last;
  for (const f of walk(root)) for (const line of readFileSync(f, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const p = e?.type === 'event_msg' ? e.payload : null;
    if (p?.type !== 'token_count' || !p.rate_limits) continue;
    // Reconstruct the event from numbers only, never forward model-written fields.
    const rl = {};
    for (const k of ['primary', 'secondary']) {
      const w = p.rate_limits[k];
      if (w && ['used_percent', 'window_minutes', 'resets_at'].every(n => Number.isFinite(w[n]))) rl[k] = Object.fromEntries(['used_percent', 'window_minutes', 'resets_at'].map(n => [n, w[n]]));
    }
    if (Object.keys(rl).length) last = { type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } };
  }
  return last;
}
if (process.argv[1]?.endsWith('/quota.mjs')) { const event = quotaEvents(process.argv[2]); if (event) process.stdout.write(JSON.stringify(event) + '\n'); }
