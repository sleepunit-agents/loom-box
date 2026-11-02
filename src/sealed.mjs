// The runtime's own key (loom docs/specs/agent-runtime.md, section 5, "Continuity slots hold raw session state"):
// what the runtime keeps of a conversation's raw text (a continuity slot, a message waiting for a body) is encrypted at
// rest to it, the way core keeps its audit log to review.key/review.pub (loom src/audit.ts).
//
//   <data>/delivery/runtime.key   made with `age-keygen` at first use, mode 0600, never in a bundle
//   <data>/delivery/runtime.pub   its recipient, always derived again from the key (a swapped pub file can't
//                                 redirect anything)
//
// Without the age programs nothing raw is kept: seal() throws SealError, and the caller keeps no slot (a conversation
// then resumes from its digests) and holds no message.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class SealError extends Error {}

const AGE_HEADER = 'age-encryption.org/v1';
const MAX = 256 * 1024 * 1024;

const regular = (p) => { try { return lstatSync(p).isFile(); } catch { return false; } };

/** `age` and `age-keygen`: LOOM_AGE / LOOM_AGE_KEYGEN (as loom finds them), else beside age, else on PATH. */
export function agePrograms(env) {
  const age = env.LOOM_AGE || 'age';
  const keygen = env.LOOM_AGE_KEYGEN || (age.includes('/') && existsSync(join(dirname(age), 'age-keygen')) ? join(dirname(age), 'age-keygen') : 'age-keygen');
  return { age, keygen };
}

/** The runtime's key pair in `dir`, made at first use. Hard-linked into place, so two first uses can't both win. */
export function runtimeKey(env, dir) {
  const { age, keygen } = agePrograms(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = join(dir, 'runtime.key');
  const pub = join(dir, 'runtime.pub');
  if (!existsSync(key)) {
    const tmp = join(dir, `.runtime.key.${process.pid}.${randomBytes(4).toString('hex')}`);
    try {
      const r = spawnSync(keygen, ['-o', tmp], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8' });
      if (r.error || r.status !== 0) throw new SealError(`age-keygen: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
      chmodSync(tmp, 0o600);
      try { linkSync(tmp, key); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    } finally { rmSync(tmp, { force: true }); }
  }
  if (!regular(key)) throw new SealError('runtime.key isn\'t a plain file; refusing to use it');
  chmodSync(key, 0o600);
  const r = spawnSync(keygen, ['-y', key], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  const recipient = (r.stdout ?? '').trim();
  if (r.error || r.status !== 0 || !/^age1[0-9a-z]{20,}$/.test(recipient)) throw new SealError('age-keygen couldn\'t read the runtime key\'s recipient');
  if (!regular(pub) || readFileSync(pub, 'utf-8').trim() !== recipient) {
    const tmp = `${pub}.${process.pid}.tmp`;
    writeFileSync(tmp, `${recipient}\n`, { mode: 0o600 });
    renameSync(tmp, pub);
  }
  return { key, recipient, age };
}

/** A sealer over the runtime's key in `dir`: seal(Buffer) → Buffer (an age file), open(Buffer) → Buffer. */
export function ageSealer(env, dir) {
  return {
    seal(plain) {
      const k = runtimeKey(env, dir);
      const r = spawnSync(k.age, ['-e', '-r', k.recipient], { input: plain, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: MAX });
      const out = r.stdout;
      if (r.error || r.status !== 0 || !out || !out.subarray(0, AGE_HEADER.length).equals(Buffer.from(AGE_HEADER))) throw new SealError('age couldn\'t encrypt it');
      return out;
    },
    open(blob) {
      const { age } = agePrograms(env);
      const key = join(dir, 'runtime.key');
      if (!regular(key)) throw new SealError('no runtime key');
      const r = spawnSync(age, ['-d', '-i', key], { input: blob, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: MAX });
      if (r.error || r.status !== 0 || !r.stdout) throw new SealError('it didn\'t decrypt with the runtime key');
      return r.stdout;
    },
  };
}
