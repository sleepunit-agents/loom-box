// A service's saved state on the control plane: one gzipped tarball per
// service, kept as a file beside state.json (blobs/, 0700), with only its
// size and hash in state.json. It travels in parts, each well inside loom's
// 1 MB request body and 512 KB per answer, so a bridge with megabytes of
// history moves as easily as one with a cursor.
//
//   save:  the box sends parts 0..n-1; the last one in makes the file, whole,
//          by rename, and only then does it replace the state before it.
//   load:  the box asks for part i of n by offset; it checks the sha256 of the
//          whole before unpacking any of it.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './state.mjs';

/** Raw bytes per part: 700 KB as base64, inside loom's 1 MB body and its 512 KB answer once JSON-quoted. */
export const PART_RAW = 360 * 1024;
export const MAX_STATE_TOTAL = 48 * 1024 * 1024;
export const MAX_PARTS = Math.ceil(MAX_STATE_TOTAL / PART_RAW);

export const partsOf = (bytes) => Math.max(1, Math.ceil(bytes / PART_RAW));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
// Keys and house ids are already constrained (agent/service names, h-<n>, "seed"); this keeps them one path segment.
const seg = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

function dir(env) {
  const d = join(stateDir(env), 'blobs');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
  return d;
}

const fileName = (key, from) => `${seg(key)}~${seg(from)}.tgz`;

/**
 * One part of a state being saved. Returns null until every part is in, then
 * {file, bytes, sha256} for the whole, written by rename.
 */
export function putPart(env, key, from, part, parts, buf) {
  const inc = join(dir(env), 'incoming', `${seg(key)}~${seg(from)}`);
  // A new save of this key from someone else (a seed, a newer house) starts clean.
  const root = join(dir(env), 'incoming');
  if (existsSync(root)) {
    for (const d of readdirSync(root)) if (d.startsWith(`${seg(key)}~`) && d !== `${seg(key)}~${seg(from)}`) rmSync(join(root, d), { recursive: true, force: true });
  }
  const meta = join(inc, 'parts');
  // A save that changed its mind about how many parts there are starts over.
  if (existsSync(meta) && Number(readFileSync(meta, 'utf-8')) !== parts) rmSync(inc, { recursive: true, force: true });
  mkdirSync(inc, { recursive: true, mode: 0o700 });
  writeFileSync(meta, String(parts), { mode: 0o600 });
  writeFileSync(join(inc, String(part)), buf, { mode: 0o600 });
  const have = new Set(readdirSync(inc).filter((n) => /^\d+$/.test(n)).map(Number));
  for (let i = 0; i < parts; i++) if (!have.has(i)) return null;
  const whole = Buffer.concat(Array.from({ length: parts }, (_, i) => readFileSync(join(inc, String(i)))));
  if (whole.length > MAX_STATE_TOTAL) { rmSync(inc, { recursive: true, force: true }); throw new RangeError('too big'); }
  const name = fileName(key, from);
  const tmp = join(dir(env), `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, whole, { mode: 0o600 });
  renameSync(tmp, join(dir(env), name));
  rmSync(inc, { recursive: true, force: true });
  return { file: name, bytes: whole.length, sha256: sha(whole) };
}

/** A whole state written at once (a bundle coming back, an old inline one moving out of state.json). */
export function putWhole(env, key, from, buf) {
  const name = fileName(key, from);
  const tmp = join(dir(env), `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, buf, { mode: 0o600 });
  renameSync(tmp, join(dir(env), name));
  return { file: name, bytes: buf.length, sha256: sha(buf) };
}

/** A saved state's file as a bundle carried it, under the name it had. */
export function putFile(env, name, buf) {
  if (!/^[A-Za-z0-9._-]+~[A-Za-z0-9._-]+\.tgz$/.test(name)) throw new Error(`${name} isn't a saved state's file name`);
  const tmp = join(dir(env), `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, buf, { mode: 0o600 });
  renameSync(tmp, join(dir(env), name));
}

/** Part `part` of a saved state, as raw bytes. */
export function readPart(env, meta, part) {
  const fd = openSync(join(dir(env), meta.file), 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, Math.min(PART_RAW, meta.bytes - part * PART_RAW)));
    readSync(fd, buf, 0, buf.length, part * PART_RAW);
    return buf;
  } finally {
    closeSync(fd);
  }
}

export function readWhole(env, meta) {
  return readFileSync(join(dir(env), meta.file));
}

/** Forget a saved state's file (it was replaced). */
export function drop(env, meta) {
  if (meta?.file) rmSync(join(dir(env), meta.file), { force: true });
}

/** Parts back into one buffer, checked against the size and hash it was saved with. */
export function joinParts(chunks, { bytes, sha256 }) {
  const whole = Buffer.concat(chunks);
  if (whole.length !== bytes || sha(whole) !== sha256) throw new Error('the saved state came back different from how it was saved');
  return whole;
}
