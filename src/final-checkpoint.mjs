// Disposable final-reader state, owned by a native Claude job. Never packed into a continuity slot.
// Directory descriptors anchor every operation so a job removed/replaced during a scan cannot redirect a write.
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, writeSync, renameSync, unlinkSync, opendirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { join, basename, resolve } from 'node:path';

const LIMIT = 16 * 1024 * 1024;
const HEADER = 16 * 1024;
const NAME = '.loom-final';
const TEMP = /^\.loom-final-[a-f0-9]{24}\.tmp$/;
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const privateOwner = st => st.uid === process.getuid() && !(st.mode & 0o022);
function readExact(fd, n, offset) {
  const buf = Buffer.alloc(n);
  for (let got = 0; got < n;) {
    const count = readSync(fd, buf, got, n - got, offset + got);
    if (!count) throw new Error('short checkpoint');
    got += count;
  }
  return buf;
}
function smallJson(path) {
  let fd;
  try {
    fd = openSync(path, flags);
    const st = fstatSync(fd);
    if (!st.isFile() || !privateOwner(st) || st.size > 64 * 1024) return null;
    return JSON.parse(readExact(fd, st.size, 0).toString('utf8'));
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Open only an existing job which actually owns this session. Caller closes, even after failed scans. */
export function openFinalCheckpoint(jobsDir, body, session, transcript) {
  if (!/^[A-Za-z0-9-]{4,64}$/.test(body?.id ?? '') || typeof session !== 'string' || basename(transcript) !== `${session}.jsonl`) return null;
  let fd;
  try {
    const dir = join(jobsDir, body.id.slice(0, 8));
    fd = openSync(dir, flags | constants.O_DIRECTORY);
    const st = fstatSync(fd);
    if (!privateOwner(st)) throw new Error('unowned job');
    const anchored = `/proc/self/fd/${fd}`;
    if (smallJson(join(anchored, 'state.json'))?.sessionId !== session) throw new Error('another session');
    return { fd, anchored, dir, st, session, transcript: resolve(transcript), body: body.id,
      key: `${resolve(dir)}\0${st.dev}:${st.ino}\0${session}\0${resolve(transcript)}` };
  } catch { if (fd !== undefined) closeSync(fd); return null; }
}
export const closeFinalCheckpoint = c => { if (c) closeSync(c.fd); };

export function loadFinalCheckpoint(c) {
  if (!c) return null;
  let fd;
  try {
    fd = openSync(join(c.anchored, NAME), flags);
    const st = fstatSync(fd);
    if (!st.isFile() || !privateOwner(st) || st.size < 36 || st.size > 4 + HEADER + 3 * LIMIT + 32) return null;
    const prefix = readExact(fd, 4, 0), n = prefix.readUInt32BE();
    if (!n || n > HEADER) return null;
    const head = readExact(fd, n, 4), h = JSON.parse(head.toString('utf8'));
    if (h.v !== 1 || h.body !== c.body || h.session !== c.session || h.transcript !== c.transcript ||
        !['dev', 'ino', 'size', 'offset', 'restBytes', 'lastBytes'].every(k => integer(h[k])) ||
        h.offset > h.size || h.restBytes > LIMIT || h.lastBytes > 2 * LIMIT || h.lastBytes % 2 !== 0 ||
        typeof h.lastNull !== 'boolean' || typeof h.omitted !== 'boolean' || typeof h.skipping !== 'boolean' ||
        (h.lastNull && h.lastBytes !== 0) || (h.skipping && (!h.omitted || h.restBytes !== 0)) ||
        st.size !== 4 + n + h.restBytes + h.lastBytes + 32) return null;
    const rest = readExact(fd, h.restBytes, 4 + n);
    const last = readExact(fd, h.lastBytes, 4 + n + rest.length);
    const digest = readExact(fd, 32, st.size - 32);
    if (!isUtf8(rest) || !createHash('sha256').update(prefix).update(head).update(rest).update(last).digest().equals(digest)) return null;
    const words = h.lastNull ? null : last.toString('utf16le');
    if ((words !== null && Buffer.byteLength(words) > LIMIT) || rest.includes(10)) return null;
    return { dev: h.dev, ino: h.ino, size: h.size, offset: h.offset, rest: rest.toString('utf8'),
      last: words, omitted: h.omitted, skipping: h.skipping, savedKey: c.key };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function clearTemps(c) {
  const d = opendirSync(c.anchored);
  try { for (let e; (e = d.readSync());) if (TEMP.test(e.name)) { try { unlinkSync(join(c.anchored, e.name)); } catch { /* another writer */ } } }
  finally { d.closeSync(); }
}
/** Best effort: failure costs a rescan after eviction, never makes the checkpoint authoritative. */
export function saveFinalCheckpoint(c, m) {
  if (!c) return false;
  let fd, temp;
  try {
    const live = lstatSync(c.dir);
    if (!live.isDirectory() || live.dev !== c.st.dev || live.ino !== c.st.ino || smallJson(join(c.anchored, 'state.json'))?.sessionId !== c.session) return false;
    if (Buffer.byteLength(m.rest) > LIMIT || (m.last !== null && Buffer.byteLength(m.last) > LIMIT)) return false;
    // UTF-16LE preserves JSON's escaped lone surrogates exactly, as the warm reader does.
    const rest = Buffer.from(m.rest), last = Buffer.from(m.last ?? '', 'utf16le');
    const head = Buffer.from(JSON.stringify({ v: 1, body: c.body, session: c.session, transcript: c.transcript,
      dev: m.dev, ino: m.ino, size: m.size, offset: m.offset, omitted: !!m.omitted, skipping: !!m.skipping,
      restBytes: rest.length, lastBytes: last.length, lastNull: m.last === null }));
    if (head.length > HEADER) return false;
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(head.length);
    const digest = createHash('sha256').update(prefix).update(head).update(rest).update(last).digest();
    clearTemps(c); // crash remnants; concurrent writers may lose their checkpoint, never transcript data
    temp = join(c.anchored, `.loom-final-${randomBytes(12).toString('hex')}.tmp`);
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    for (const buf of [prefix, head, rest, last, digest]) {
      for (let at = 0; at < buf.length;) { const n = writeSync(fd, buf, at, buf.length - at); if (!n) throw new Error('short write'); at += n; }
    }
    closeSync(fd); fd = undefined;
    renameSync(temp, join(c.anchored, NAME));
    return true;
  } catch { return false; }
  finally {
    if (fd !== undefined) closeSync(fd);
    if (temp) { try { unlinkSync(temp); } catch { /* renamed or job retired */ } }
  }
}

/** Body retirement also removes the job dir. Slot-only expiry cleans any checkpoint left by interrupted retirement. */
export function dropFinalCheckpoints(jobsDir, session, body) {
  let d;
  try {
    d = opendirSync(jobsDir);
    for (let e; (e = d.readSync());) {
      if (!e.isDirectory() || (body && e.name !== String(body.id).slice(0, 8))) continue;
      // The state file binds a slot to its job, even when the runtime no longer has the body reference.
      const owner = smallJson(join(jobsDir, e.name, 'state.json'))?.sessionId;
      if (typeof owner !== 'string' || (session && owner !== session)) continue;
      const c = openFinalCheckpoint(jobsDir, { id: body?.id ?? e.name }, owner, `${owner}.jsonl`);
      if (!c) continue;
      try { try { unlinkSync(join(c.anchored, NAME)); } catch { /* no checkpoint */ } clearTemps(c); }
      finally { closeFinalCheckpoint(c); }
    }
  } catch { /* no jobs, or a job disappeared */ }
  finally { d?.closeSync(); }
}
