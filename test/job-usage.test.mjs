import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptUsage, usageJobs } from '../src/job-usage.mjs';
const fixture = async (rows, fn) => {
  const root = mkdtempSync(join(tmpdir(), 'usage-'));
  const file = join(root, 'session.jsonl');
  writeFileSync(file, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n'));
  try { await fn(file, root); } finally { rmSync(root, { recursive: true, force: true }); }
};
test('Claude counts each request once, includes cache context, tolerates partial last line', async () => {
  const row = (id, output) => ({ type: 'assistant', sessionId: 'session', timestamp: id === 'b' ? '2026-11-11T01:00:03Z' : '2026-11-11T01:00:00Z', message: { id, model: 'claude', usage: { input_tokens: 10, cache_read_input_tokens: id === 'b' ? 300000 : 200000, cache_creation_input_tokens: 30000, output_tokens: output } } });
  await fixture([row('a', 2), row('a', 5), row('b', 6), '{'], async f => {
    const r = await transcriptUsage(f);
    assert.deepEqual(r.models, ['claude']); assert.equal(r.durationSeconds, 3); assert.deepEqual(r.reasons, ['large starting context', 'context exceeded 150k', 'repeated cached context dominates', 'cache creation is a material share']);
    assert.doesNotMatch(JSON.stringify(r), /nativeCalls|message|content/);
    assert.equal(r.calls, 2); assert.equal(r.startingContext, 230010); assert.equal(r.averageContext, 280010); assert.equal(r.peakContext, 330010); assert.equal(r.lastContext, 330010);
    assert.equal(r.cacheWriteCalls, 2); assert.equal(r.cacheRead, 500000); assert.equal(r.cacheCreate, 60000); assert.equal(r.uncached, 20); assert.equal(r.output, 11); assert.equal(r.malformedLines, 1);
  });
});
test('Codex inclusive input and repeated quota readings do not double count', async () => {
  const count = (input, last, output) => ({ type: 'event_msg', timestamp: '2026-11-11T01:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output }, last_token_usage: { input_tokens: last, cached_input_tokens: 60, cache_write_input_tokens: 10, output_tokens: 5 } } } });
  await fixture([{ type: 'turn_context', payload: { model: 'gpt-test' } }, count(100, 100, 5), count(100, 100, 5), count(220, 120, 10)], async f => {
    const r = await transcriptUsage(f);
    assert.equal(r.calls, 2); assert.equal(r.averageContext, 110); assert.equal(r.cacheRead, 120); assert.equal(r.cacheCreate, 20); assert.equal(r.uncached, 80); assert.equal(r.output, 10); assert.deepEqual(r.models, ['gpt-test']);
  });
});
test('ranks full session totals on Central start day; no symlink duplicates', async () => {
  await fixture([{ type: 'assistant', sessionId: 'one-session', timestamp: '2026-11-11T01:00:00Z', message: { id: 'a', usage: { input_tokens: 100 } } }], async (f, root) => {
    symlinkSync(f, join(root, 'link.jsonl'));
    copyFileSync(f, join(root, 'copy.jsonl'));
    const r = await usageJobs({ roots: [root, root], day: '2026-11-10' });
    assert.equal(r.measuredJobs, 1); assert.equal(r.scannedFiles, 2);
    assert.equal(r.jobs[0].calls, 1); assert.equal(r.jobs[0].totalTokens, 100);
    assert.equal((await usageJobs({ roots: [root], day: '2026-11-11' })).measuredJobs, 0);
  });
});
test('partial Codex copy starting on a quota-only repeat is not another call; reset keeps new calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-copies-'));
  const meta = { type: 'session_meta', payload: { id: 'codex-copy-session' } };
  const count = (at, input, last) => ({ type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input }, last_token_usage: { input_tokens: last, cached_input_tokens: 0, output_tokens: 0 } } } });
  const first = count('2026-11-11T01:00:00Z', 100, 100), repeat = count('2026-11-11T01:00:03Z', 100, 100);
  try {
    writeFileSync(join(root, 'a.jsonl'), [meta, first, repeat].map(JSON.stringify).join('\n'));
    writeFileSync(join(root, 'b.jsonl'), [meta, repeat].map(JSON.stringify).join('\n'));
    const report = await usageJobs({ roots: [root], day: '2026-11-10' });
    assert.equal(report.jobs.length, 1); assert.equal(report.jobs[0].calls, 1); assert.equal(report.jobs[0].uncached, 100); assert.equal(report.jobs[0].durationSeconds, 3);
    const reset = count('2026-11-11T01:00:05Z', 50, 50);
    writeFileSync(join(root, 'c.jsonl'), [meta, first, count('2026-11-11T01:00:04Z', 220, 120), reset].map(JSON.stringify).join('\n'));
    const r = await transcriptUsage(join(root, 'c.jsonl'));
    assert.equal(r.calls, 3); assert.equal(r.counterResets, 1); assert.equal(r.uncached, 270);
    writeFileSync(join(root, 'd.jsonl'), [meta, reset].map(JSON.stringify).join('\n'));
    const merged = await usageJobs({ roots: [root], day: '2026-11-10' });
    assert.equal(merged.jobs[0].calls, 3); assert.equal(merged.jobs[0].uncached, 270);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
