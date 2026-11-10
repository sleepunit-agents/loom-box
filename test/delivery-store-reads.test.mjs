import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { storeSignature } from '../src/store.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { depsOf } from '../src/delivery.mjs';

test('delivery shares policy and gates reads until a store commit; changes and failures are immediate', () => {
  const home = mkdtempSync(join(tmpdir(), 'delivery-store-reads-'));
  try {
    const dir = join(home, 'commons', 'stores');
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, 'runtime.db');
    const data = join(home, 'documents.json');
    const count = join(home, 'reads');
    const bin = join(home, 'loom-test');
    const write = (policy, gates, version) => {
      writeFileSync(data, JSON.stringify({ policy, gates }));
      // The signature reader is independent of SQLite: a changed file stands
      // in for the public store's commit signature in this process-count test.
      writeFileSync(marker, version);
    };
    writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(count)}, process.argv[5] + '\\n');
const docs = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
if (docs.fail) { console.error('temporarily unreadable'); process.exit(1); }
console.log(JSON.stringify({doc: docs[process.argv[5]], rev: 1}));
`, { mode: 0o755 });
    const first = { deny: ['Bash'] };
    const gates = { v: 1, people: {}, groups: {} };
    write(first, gates, 'initial');
    const d = depsOf({ LOOM_HOME: home, LOOM_PIECE_NAME: 'runtime', LOOM_BIN: bin }, { core: {}, sealer: {}, accounts: {} });
    const reads = () => readFileSync(count, 'utf8').trim().split('\n');
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(d.policy('art'), first);
      assert.deepEqual(d.gates('art'), gates);
    }
    assert.equal(reads().filter(x => x === 'policy').length, 1);
    assert.equal(reads().filter(x => x === 'gates').length, 1);
    // A permission change cannot wait for the previous gates time cache.
    const next = { deny: ['Bash', 'Write'] };
    const nextGates = { ...gates, changed: true };
    write(next, nextGates, 'second commit, changed size');
    assert.deepEqual(d.policy('art'), next);
    assert.deepEqual(d.gates('art'), nextGates);
    assert.equal(reads().length, 4);
    writeFileSync(data, JSON.stringify({ fail: true }));
    writeFileSync(marker, 'third');
    assert.throws(() => d.policy('art'), /temporarily unreadable/);
    writeFileSync(data, JSON.stringify({ policy: first, gates }));
    assert.deepEqual(d.policy('art'), first); // errors were not cached
    rmSync(marker);
    const before = reads().length;
    d.policy('art'); d.policy('art');
    assert.equal(reads().length, before + 2); // no signature: keep nothing
    const other = join(home, 'other-household');
    mkdirSync(other);
    const otherBin = join(other, 'loom-test');
    writeFileSync(otherBin, `#!${process.execPath}
console.log(JSON.stringify({doc:{deny:['Read']}, rev:1}));
`, { mode: 0o755 });
    const d2 = depsOf({ LOOM_HOME: other, LOOM_PIECE_NAME: 'runtime', LOOM_BIN: otherBin }, { core: {}, sealer: {}, accounts: {} });
    assert.deepEqual(d2.policy('art'), { deny: ['Read'] });
    assert.deepEqual(d.policy('art'), first); // environments never share a store
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('a WAL commit changes the signature before a checkpoint touches the main database', async () => {
  const home = mkdtempSync(join(tmpdir(), 'delivery-wal-signature-'));
  const dir = join(home, 'commons', 'stores');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'runtime.db');
  const child = spawn('python3', ['-u', '-c', `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute('PRAGMA journal_mode=WAL')
c.execute('CREATE TABLE docs (value TEXT)')
c.commit()
print('ready', flush=True)
for line in sys.stdin:
    c.execute('INSERT INTO docs VALUES (?)', (line.strip(),))
    c.commit()
    print('committed', flush=True)
c.close()
`, path], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    await once(child.stdout, 'data');
    const env = { LOOM_HOME: home, LOOM_PIECE_NAME: 'runtime' };
    const before = storeSignature(env);
    const mainBytes = readFileSync(path);
    assert.ok(before);
    child.stdin.write('permission changed\n');
    await once(child.stdout, 'data');
    assert.deepEqual(readFileSync(path), mainBytes);
    assert.notEqual(storeSignature(env), before);
  } finally {
    child.stdin.end();
    await once(child, 'exit');
    rmSync(home, { recursive: true, force: true });
  }
});
