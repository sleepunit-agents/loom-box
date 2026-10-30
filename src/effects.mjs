// What the runtime does outside its own state, on the control plane: mint and
// revoke loom tokens (through loom's own CLI, so core keeps the only token
// store) and read a secret for a house (through the secrets piece, host side).
// Values only ever travel on pipes, never in argv.
import { spawnSync } from 'node:child_process';

// 60s: on 2026-10-30 a `loom token create` on a box at load 120+ outran 20s and was killed after writing its token.
function run(cmd, args, env, what) {
  const r = spawnSync(cmd, args, { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  if (r.error) throw new Error(`${what}: can't run ${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || '').trim().split('\n').pop() || `${cmd} exited ${r.status}`}`);
  return r.stdout;
}

export function realEffects(env = process.env) {
  const loom = env.LOOM_BOX_LOOM || 'loom';
  const secrets = env.LOOM_BOX_SECRETS || 'loom-secrets';
  return {
    now: () => new Date(),
    /** `loom token create <role flags> --label <label>`: the token is its stdout, alone. */
    mint(roleArgs, label) {
      const token = run(loom, ['token', 'create', ...roleArgs, '--label', label], env, 'minting a token').trim();
      if (!/^loom_[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('minting a token: loom printed something other than a token');
      return token;
    },
    revoke(label) { run(loom, ['token', 'revoke', label], env, 'revoking a token'); },
    /**
     * What an agent's next house runs on, for a provider: the subscriptions
     * piece's issue (its order, the first with room left, made safe for a
     * house: an OpenAI login without its refresh token; a kind, as
     * 'session', picks a Claude session login's access-only view). {name, value}, the
     * value on a pipe; the name is which credential, from its stderr.
     */
    issue(agent, provider, kind) {
      const r = spawnSync(loom, ['subscriptions', 'issue', agent, provider, ...(kind ? ['--kind', kind] : [])], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 40_000 });
      if (r.error || r.status !== 0) throw new Error(`issuing ${agent}'s ${provider} credential: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}`);
      const m = /issued ([a-z0-9-]+)\/([A-Za-z0-9._-]+)/.exec(r.stderr || '');
      return { name: m ? m[2] : 'unknown', value: r.stdout };
    },
    /** The control plane is the host side, so it may pass the secrets piece's body gate. */
    secret(name) {
      return run(secrets, ['get', name, '--reveal'], { ...env, LOOM_SECRETS_ALLOW_GET: '1' }, `reading secret ${name}`);
    },
  };
}
