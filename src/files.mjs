// A file someone sent a body's conversation (t-1961): a Slack photo or log, say. The venue's adapter keeps what was
// sent in each place (it holds the bot's token; a body never does), and hands one over only for that agent and place
// (loom-slack `send --place P --agent A --file ID --out PATH`). The runtime asks it only for the body proving it holds
// the conversation in its current run (its run's key and harness session, as `send` and `place` prove it), so a body
// gets files sent in its own conversation's place and nowhere else. They come back to the body in parts, each inside
// loom's answer limit, and are kept here an hour.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryDir, deliveryKey, depsOf, heldConv } from './delivery.mjs';

/** Raw bytes per part: well inside loom's 512 KB answer once base64 and JSON. */
export const FILE_PART = 256 * 1024;
export const FILE_MAX = 25 * 1024 * 1024;
const KEEP_MS = 60 * 60 * 1000;
export const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/;

const dirOf = (env, cv) => join(deliveryDir(env), 'files', cv);

/**
 * Part `part` of file `id` sent in `cv`'s place, for the body proving it holds `cv`: {ok, name, size, sha256, part,
 * parts, data (base64)} or {ok: false, reason}. Part 0 asks the venue's adapter for it (again, if it's gone from here).
 */
export async function fileOf(env, cv, id, part, proof = {}, caller = undefined, d = depsOf(env)) {
  const c = heldConv(env, cv, proof, { caller });
  if (!c || (caller?.agent !== undefined && c.agent !== caller.agent)) return { ok: false, reason: `file: only the body holding ${cv} in its current run asks for its files` };
  if (!FILE_ID.test(id ?? '')) return { ok: false, reason: 'file: that isn\'t a file id' };
  if (!Number.isInteger(part) || part < 0 || part > Math.ceil(FILE_MAX / FILE_PART)) return { ok: false, reason: 'file: --part is a whole number from 0' };
  const dir = dirOf(env, cv);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const metaFile = join(dir, `${id}.json`);
  let meta = readMeta(metaFile);
  if (!meta) {
    if (part !== 0) return { ok: false, reason: 'file: ask for part 0 first' };
    prune(env);
    let v;
    try { v = (await d.venues())?.[c.venue]; } catch (e) { return { ok: false, reason: `file: core couldn't list the venues (${e.message})` }; }
    if (!Array.isArray(v?.send)) return { ok: false, reason: `file: ${c.venue} keeps no files for a body` };
    const tmp = join(dir, `${id}.${randomBytes(6).toString('hex')}.part`);
    try {
      const a = await d.adapter(v.send, c, ['--file', id, '--out', tmp]);
      const st = statSync(tmp);
      const sha = createHash('sha256').update(readFileSync(tmp)).digest('hex');
      if (!st.isFile() || st.size > FILE_MAX || st.size !== a.size || sha !== a.sha256 || !NAME.test(a.name ?? '')) throw new Error('its adapter handed over something other than it said');
      // Sent in this conversation, not only in its place (an earlier conversation there, another seat's): one of the
      // deliveries it came in went to this one, by the runtime's own record of where each delivery went (a day).
      if (!(Array.isArray(a.messages) ? a.messages : []).some((m) => typeof m === 'string' && deliveredTo(env, c.venue, m) === cv)) throw new Error(`no message delivered to this conversation in the last day carried file ${id}`);
      renameSync(tmp, join(dir, `${id}.bin`));
      meta = { name: a.name, size: st.size, sha256: sha, at: Date.now() };
      writeFileSync(metaFile, JSON.stringify(meta), { mode: 0o600 });
    } catch (e) {
      rmSync(tmp, { force: true });
      return { ok: false, reason: `file: ${e.code ? 'it couldn\'t be read' : String(e.message).slice(0, 300)}` };
    }
  }
  const parts = Math.max(1, Math.ceil(meta.size / FILE_PART));
  if (part >= parts) return { ok: false, reason: `file: it has ${parts} part${parts === 1 ? '' : 's'}` };
  const len = Math.min(FILE_PART, meta.size - part * FILE_PART);
  const buf = Buffer.alloc(Math.max(0, len));
  try {
    const fd = openSync(join(dir, `${id}.bin`), 'r');
    try { readSync(fd, buf, 0, buf.length, part * FILE_PART); } finally { closeSync(fd); }
  } catch { return { ok: false, reason: 'file: it was let go meanwhile; ask for part 0 again' }; }
  return { ok: true, name: meta.name, size: meta.size, sha256: meta.sha256, part, parts, data: buf.toString('base64') };
}

/** The conversation the delivery (source, id) went to, by the runtime's own record (delivery.mjs, seen), or null. */
function deliveredTo(env, source, id) {
  try { const s = JSON.parse(readFileSync(join(deliveryDir(env), 'seen', `${deliveryKey({ source, id })}.json`), 'utf-8')); return s.answer?.conversation ?? s.turn?.conversation ?? null; } catch { return null; }
}

function readMeta(p) {
  try { const m = JSON.parse(readFileSync(p, 'utf-8')); return Date.now() - m.at < KEEP_MS && Number.isInteger(m.size) ? m : null; } catch { return null; }
}

/** What's older than an hour goes: a body's file is fetched once, when it asks. */
function prune(env) {
  const root = join(deliveryDir(env), 'files');
  let cvs = [];
  try { cvs = readdirSync(root); } catch { return; }
  for (const cv of cvs) {
    for (const n of (() => { try { return readdirSync(join(root, cv)); } catch { return []; } })()) {
      const p = join(root, cv, n);
      try { if (Date.now() - statSync(p).mtimeMs >= KEEP_MS) rmSync(p, { force: true }); } catch { /* gone */ }
    }
  }
}
