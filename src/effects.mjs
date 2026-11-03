// What the runtime does outside its own state, on the control plane: mint and
// revoke loom tokens (through loom's own CLI, so core keeps the only token
// store), and get a secret for a house it's starting from the secrets piece,
// whose policy decides whether that agent may have it (`issue`, which asks its
// `may`: loom docs/specs/agent-runtime.md, section 6, Secrets). No environment
// flag unlocks reading: the secrets piece knows the runtime's own process by the
// name loom gives it (LOOM_PIECE_NAME).
// Values only ever travel on pipes, never in argv. No model credential passes
// through here: each box logs in itself (docs/model-accounts.md).
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
    /** A secret for a house of `agent` the runtime is starting: the secrets piece's to give (its policy's `may`). */
    secret(name, { agent, house } = {}) {
      if (!agent) throw new Error(`reading secret ${name}: whose house it's for is required`);
      // Never a flag that unlocks reading, whatever the environment brought in.
      const { LOOM_SECRETS_ALLOW_GET: _flag, ...clean } = env;
      // The runtime's process is the one loom named (LOOM_PIECE_NAME runtime, or box before the rename).
      return run(secrets, ['issue', name, '--agent', agent, ...(house ? ['--house', house] : [])], clean, `getting secret ${name} for ${agent}`);
    },
  };
}
