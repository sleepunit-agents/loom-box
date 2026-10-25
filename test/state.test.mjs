// A service's saved state comes from a box, so it's untrusted when the next
// box unpacks it. restoreState writes only what it has checked itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { restoreState } from '../src/box.mjs';

function packed(fill) {
  const src = mkdtempSync(join(tmpdir(), 'st-src-'));
  fill(src);
  return spawnSync('tar', ['--format=ustar', '-C', src, '-czf', '-', '.']).stdout;
}
const fresh = () => mkdtempSync(join(tmpdir(), 'st-out-'));
const reject = (buf, why) => {
  const out = fresh();
  assert.throws(() => restoreState(out, buf.toString('base64')), why);
  assert.deepEqual(readdirSync(out), [], 'nothing written');
};
/** A field rewritten in the first header, its checksum fixed (or not). */
function patched(fill, edit, { fixSum = true } = {}) {
  const tar = Buffer.from(gunzipSync(packed(fill)));
  edit(tar);
  if (fixSum) {
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : tar[i];
    tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  }
  return gzipSync(tar);
}
const oneFile = (d) => writeFileSync(join(d, 'cursor'), '42');

test('a plain state comes back, files 0600', () => {
  const out = fresh();
  restoreState(out, packed((d) => { mkdirSync(join(d, 'sub')); writeFileSync(join(d, 'sub', 'f'), 'hi'); writeFileSync(join(d, 'state.json'), '{}'); }).toString('base64'));
  assert.equal(readFileSync(join(out, 'sub', 'f'), 'utf-8'), 'hi');
  assert.equal(statSync(join(out, 'state.json')).mode & 0o777, 0o600);
});

test('links, bad checksums, odd sizes, .. names and trailing data are refused before anything is written', () => {
  reject(packed((d) => { oneFile(d); symlinkSync('/etc/passwd', join(d, 'link')); }), /other than plain files/);
  reject(patched(oneFile, (t) => t.write('X', 0, 'latin1'), { fixSum: false }), /checksum/);
  reject(patched(oneFile, (t) => { t.fill(0, 0, 100); t.write('../escape', 0, 'latin1'); }), /outside its dir/);
  reject(patched(oneFile, (t) => t.write('00000000009 ', 124, 'latin1')), /isn't octal/);
  reject(patched(oneFile, (t) => t.write('xxxxx\0', 257, 'latin1')), /isn't ustar/);
  const tail = Buffer.from(gunzipSync(packed(oneFile)));
  reject(gzipSync(Buffer.concat([tail, Buffer.from('a hidden second archive')])), /data after its end/);
});

test('a state that would unpack too big is refused, without unpacking it', () => {
  const big = Buffer.alloc(70 * 1024 * 1024);
  reject(gzipSync(big), /too big/);
});
