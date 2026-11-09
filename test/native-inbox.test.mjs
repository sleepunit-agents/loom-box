import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativePendingInbox } from '../src/native-inbox.mjs';
import { scratch } from './scratch.mjs';

function fixture() {
  const root = scratch('native-inbox-'), id = 'deadbeef12345678', dir = join(root, id.slice(0, 8));
  mkdirSync(dir);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ venue: 'runtime', chan: id, bridge: 'runtime' }));
  return { root, id, dir, read: () => nativePendingInbox(root, id) };
}

test('a final inbox receipt returns only pending IDs, excluding delivered and duplicate records', () => {
  const w = fixture();
  writeFileSync(join(w.dir, 'pending.jsonl'), [{ id: 'k1', text: 'private text' }, { id: 'k2' }, { id: 'k2' }].map(x => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(w.dir, 'delivered.jsonl'), JSON.stringify({ id: 'k1' }) + '\n');
  assert.deepEqual(w.read(), ['k2']);
});

test('an empty identified inbox is known; missing or another body\'s metadata is unknown', () => {
  const w = fixture(); assert.deepEqual(w.read(), []);
  writeFileSync(join(w.dir, 'meta.json'), JSON.stringify({ venue: 'runtime', bridge: 'runtime', chan: 'deadbeef-other-body' }));
  assert.equal(w.read(), null);
  rmSync(join(w.dir, 'meta.json')); assert.equal(w.read(), null);
  assert.equal(nativePendingInbox(w.root, 'missing-body'), null);
});

for (const value of ['{"id":"k1"}\n{"id":', '{"text":"missing id"}\n', JSON.stringify({ id: 'x'.repeat(65) })]) {
  test('a partial or invalid inbox record cannot certify an empty inbox', () => {
    const w = fixture(); writeFileSync(join(w.dir, 'pending.jsonl'), value); assert.equal(w.read(), null);
  });
}

test('linked or oversized inbox files remain unknown without following or blocking on them', () => {
  const w = fixture(); symlinkSync('/does-not-exist', join(w.dir, 'pending.jsonl')); assert.equal(w.read(), null);
  rmSync(join(w.dir, 'pending.jsonl'));
  writeFileSync(join(w.dir, 'pending.jsonl'), 'x'.repeat(2 * 1024 * 1024 + 1)); assert.equal(w.read(), null);
});
