// The runtime's calls to loom's approvals piece (t-1970, t-1975): `loom approvals <verb> …` as loom's machine, never
// with the store grant loom minted for the runtime's own collections, within 6 s (well inside loom's 15 s for a page
// action). Tests stand a fake in with LOOM_RUNTIME_TEST_APPROVALS (an object): it's handed the verb and its argv.
import { execFile, spawnSync } from 'node:child_process';

/** The test stand-in, if one is set. */
export const approvalsFake = (env) => (env?.LOOM_RUNTIME_TEST_APPROVALS && typeof env.LOOM_RUNTIME_TEST_APPROVALS === 'object' ? env.LOOM_RUNTIME_TEST_APPROVALS : null);

/** Run `loom approvals …argv`: {status, stdout, stderr, error}. */
export function approvalsRun(env, argv) {
  const { LOOM_STORE_GRANT: _mine, ...rest } = env;
  return spawnSync(env.LOOM_BIN || 'loom', ['approvals', ...argv], { env: rest, encoding: 'utf-8', timeout: 6_000 });
}

/** Why a run didn't do it, in a few words (its own, cut to the end). */
export const approvalsWhy = (r) => (r.error?.code === 'ETIMEDOUT' ? 'the approvals piece didn\'t answer in time, so it may have done it already'
  : r.error ? `the approvals piece didn't run (${r.error.message})` : ((r.stderr || r.stdout || '').trim().slice(-300) || `exit ${r.status}`));

/** The same, without blocking the delivery process (execute's path): resolves {status, stdout, stderr, error}. */
export function approvalsRunAsync(env, argv) {
  const { LOOM_STORE_GRANT: _mine, ...rest } = env;
  return new Promise((resolve) => {
    execFile(env.LOOM_BIN || 'loom', ['approvals', ...argv], { env: rest, encoding: 'utf-8', timeout: 6_000 }, (err, stdout, stderr) => {
      const status = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      const error = err && (err.killed || err.signal) ? Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) : err && typeof err.code !== 'number' ? err : undefined;
      resolve({ status, stdout, stderr, error });
    });
  });
}
