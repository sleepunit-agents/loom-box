// Only the CLI's reported hard login deadline, never an access token's short expiry.
// No credentials are read here. Missing deadlines stay unknown (not all harnesses expose one).
import { update } from './state.mjs';
import { raiseAlert } from './alerthook.mjs';
const DAY = 86_400_000;
export function loginExpiry(st, now = Date.now()) {
  if (!st?.installed || !st.loggedIn || typeof st.loginExpiresAt !== 'string') return null;
  const end = Date.parse(st.loginExpiresAt);
  if (!Number.isFinite(end) || end - now > 10 * DAY) return null;
  return { expired: end <= now, days: Math.max(0, Math.ceil((end - now) / DAY)),
    severity: end - now <= 3 * DAY ? 'bad' : 'warn', end: new Date(end).toISOString() };
}
function conditions(s, now) {
  const out = [];
  for (const [box, b] of Object.entries(s.boxes)) {
    if (b.revoked || b.reportOnly) continue;
    for (const [harness, st] of Object.entries(b.harnesses ?? {})) {
      const x = loginExpiry(st, now);
      if (!x) continue;
      const label = harness === 'claude' ? 'Claude' : harness === 'codex' ? 'Codex' : harness;
      out.push({ ...x, box, harness, text: `${label} login on ${b.name ?? box} ${x.expired ? 'has expired' : `ends in ${x.days} day${x.days === 1 ? '' : 's'}`}` });
    }
  }
  return out;
}
export function loginExpiryAsks(s, now = Date.now()) {
  return conditions(s, now).map((x) => ({ text: x.text, meta: 'Renew this login to keep running.',
    at: x.end, page: `box/${x.box}`, label: 'Renew login', kind: 'alert' }));
}
// One alert on entering each urgency level, then daily. Replaced/healthy/missing reports clear the latch.
export function checkLoginExpiry(env, now = Date.now(), o = {}) {
  const calls = [];
  update(env, (s) => {
    const next = {};
    for (const x of conditions(s, now)) {
      const key = `${x.box}:${x.harness}`, stage = x.expired ? 'expired' : x.severity;
      const previous = s.loginExpiryAlerts?.[key];
      const changed = !previous || previous.end !== x.end || previous.stage !== stage;
      if (changed || now - previous.said >= DAY) {
        calls.push({ source: 'runtime-login', severity: x.severity, summary: x.text,
          facts: { box: x.box, harness: x.harness, expires: x.end } });
        next[key] = { end: x.end, stage, said: now };
      } else next[key] = previous;
    }
    s.loginExpiryAlerts = next;
  });
  for (const c of calls) { try { (o.alert ?? raiseAlert)(env, c); } catch { /* never block a poll */ } }
  return calls;
}
