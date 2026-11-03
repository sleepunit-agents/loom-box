// A brief in parts (t-1756): the runtime's own lines, and the agent's prose by reference. The agent-specific text (its
// conduct on a venue, the floor under a guest venue, a channel's notes) is the agent's: files in its own repo, named by
// the owner's policy (policy.mjs). The runtime never holds that prose; it names the file, and whoever starts the
// body reads it where the repo is: the body host in the agent's house (bodyhost.mjs), or the runtime for a local body.
//
//   [{text: "…"}, {file: "house/briefs/discord.md", what: "your conduct on discord"}, …]
//
// Every file named is required: one that's missing, unreadable, empty or too big fails the start (a guest venue's
// floor that isn't there is never a body without it). A file is a path inside the repo: no absolute path, no `..`.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

export const MAX_PARTS = 40;
export const MAX_FILE = 20_000;
const REL = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export class BriefError extends Error {}

/** Why `p` isn't a repo-relative file a brief may name, or null. */
export function fileProblem(p) {
  if (typeof p !== 'string' || p.length > 200 || !REL.test(p)) return 'a brief file is a path inside the repo, like house/briefs/discord.md';
  if (p.split('/').some((s) => s === '.' || s === '..')) return 'a brief file has no . or .. in its path';
  return null;
}

/** Whether a brief is parts (an array), as opposed to the plain text a body was always started with. */
export const isParts = (b) => Array.isArray(b);

/** Whether a brief's parts name any file: only then does whoever starts it need the repo. */
export const namesFiles = (b) => isParts(b) && b.some((p) => p && typeof p.file === 'string');

/** Checked parts: each {text} or {file, what?}. Throws BriefError. */
export function checkParts(parts) {
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS) throw new BriefError(`a brief is 1-${MAX_PARTS} parts`);
  return parts.map((p) => {
    if (p && typeof p.text === 'string' && Object.keys(p).length === 1) return { text: p.text };
    if (p && typeof p.file === 'string' && Object.keys(p).every((k) => k === 'file' || k === 'what')) {
      const why = fileProblem(p.file);
      if (why) throw new BriefError(why);
      return { file: p.file, ...(typeof p.what === 'string' ? { what: p.what.slice(0, 120) } : {}) };
    }
    throw new BriefError('a brief part is {text} or {file, what?}');
  });
}

/**
 * The brief as one text: each part's text, and each file's contents read from `cwd` (the agent's repo), joined as
 * they come. A file that resolves outside `cwd` (a symlink out), or is missing, empty or too big, throws.
 */
export function composeBrief(parts, cwd, { read = readFileSync } = {}) {
  if (!isParts(parts)) return parts;
  const checked = checkParts(parts);
  let root;
  if (checked.some((p) => p.file)) {
    if (typeof cwd !== 'string' || !cwd) throw new BriefError('a brief that names the agent\'s files needs its repo (the body\'s cwd)');
    try { root = realpathSync(cwd); } catch { throw new BriefError(`the agent's repo isn't here (${cwd})`); }
  }
  return checked.map((p) => {
    if (p.text !== undefined) return p.text;
    const what = p.what ? `${p.what} (${p.file})` : p.file;
    let real;
    try { real = realpathSync(join(root, p.file)); } catch { throw new BriefError(`${what} isn't in the agent's repo`); }
    if (real !== root && !real.startsWith(root + sep)) throw new BriefError(`${what} is outside the agent's repo`);
    let size;
    try { size = statSync(real).size; } catch { throw new BriefError(`${what} can't be read`); }
    if (size > MAX_FILE) throw new BriefError(`${what} is over ${MAX_FILE} bytes`);
    let text;
    try { text = String(read(real, 'utf-8')); } catch { throw new BriefError(`${what} can't be read`); }
    if (!text.trim()) throw new BriefError(`${what} is empty`);
    return text;
  }).join('');
}
