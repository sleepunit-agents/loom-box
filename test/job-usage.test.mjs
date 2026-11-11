import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const count = (input, last, output) => ({ type: 'event_msg', timestamp: '2026-11-11T01:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output }, last_token_usage: { input_tokens: last, cached_input_tokens: 60, cache_write_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 2 } } } });
  await fixture([{ type: 'turn_context', payload: { model: 'gpt-test' } }, count(100, 100, 5), count(100, 100, 5), count(220, 120, 10)], async f => {
    const r = await transcriptUsage(f);
    assert.equal(r.calls, 2); assert.equal(r.cacheWriteCalls, 2); assert.equal(r.startingContext, 100); assert.equal(r.lastContext, 120); assert.equal(r.peakContext, 120); assert.equal(r.averageContext, 110); assert.equal(r.cacheRead, 120); assert.equal(r.cacheCreate, 20); assert.equal(r.uncached, 80); assert.equal(r.output, 10); assert.deepEqual(r.models, ['gpt-test']);
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

test('mixed Claude request/message aliases dedupe within and across copies', async () => {
  const row = (requestId, id) => ({ type: 'assistant', sessionId: 'mixed', requestId, timestamp: '2026-11-11T01:00:00Z', message: { id, usage: { input_tokens: 10, cache_creation_input_tokens: 20 } } });
  await fixture([row('r', undefined), row(undefined, 'm')], async (f, root) => {
    writeFileSync(join(root, 'bridge.jsonl'), JSON.stringify(row('r', 'm')));
    let report = await usageJobs({ roots: [root], day: 'all' });
    assert.equal(report.jobs[0].calls, 1); assert.equal(report.jobs[0].cacheWriteCalls, 1); assert.equal(report.jobs[0].totalTokens, 30);
    writeFileSync(f, [row('r', undefined), row(undefined, 'm'), row('r', 'm')].map(JSON.stringify).join('\n'));
    assert.equal((await transcriptUsage(f)).calls, 1);
  });
});
test('timezone determines the default date, and limit constrains ranking', async () => {
  const row = (id, amount) => ({ type: 'assistant', sessionId: id, timestamp: new Date().toISOString(), message: { id, usage: { input_tokens: amount } } });
  await fixture([row('small', 10)], async (f, root) => {
    writeFileSync(join(root, 'big.jsonl'), JSON.stringify(row('big', 20)));
    for (const timezone of ['Pacific/Kiritimati', 'Pacific/Honolulu']) {
      const report = await usageJobs({ roots: [root], timezone, limit: 1 });
      assert.equal(report.day, new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
      assert.equal(report.measuredJobs, 2); assert.deepEqual(report.jobs.map(r => r.session), ['big']);
    }
  });
});
test('zero Codex cache writes and quota-only repeats count no writes', async () => {
  const row = { type: 'event_msg', timestamp: '2026-11-11T01:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100 }, last_token_usage: { input_tokens: 100, output_tokens: 3 } } } };
  await fixture([row, row], async f => { const r = await transcriptUsage(f); assert.equal(r.calls, 1); assert.equal(r.cacheWriteCalls, 0); assert.equal(r.output, 3); assert.equal(r.uncached, 100); });
});

test('Claude counts writes only when cache creation is positive', async () => {
  const row = (id, cache_creation_input_tokens) => ({ type: 'assistant', sessionId: 'mixed-writes', message: { id, usage: { input_tokens: 10, cache_creation_input_tokens } } });
  await fixture([row('absent'), row('zero', 0), row('positive', 20), row('positive', 20)], async f => {
    const r = await transcriptUsage(f); assert.equal(r.calls, 3); assert.equal(r.cacheWriteCalls, 1); assert.equal(r.cacheCreate, 20); assert.equal(r.uncached, 30);
  });
});

test('reordered Codex totals and absent zero counters are the same observation', async () => {
  const row = (timestamp, total) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: { input_tokens: 100, cache_write_input_tokens: 20, output_tokens: 5 } } } });
  await fixture([row('2026-11-11T01:00:00Z', { input_tokens: 100, output_tokens: 5 }), row('2026-11-11T01:00:01Z', { output_tokens: 5, input_tokens: 100, cached_input_tokens: 0 })], async f => {
    const r = await transcriptUsage(f); assert.equal(r.calls, 1); assert.equal(r.cacheWriteCalls, 1); assert.equal(r.cacheCreate, 20); assert.equal(r.output, 5); assert.equal(r.uncached, 80);
  });
});

// A different workload must produce different reasons, not a constant diagnosis.
test('ordinary fixture has no large-context or cache diagnosis', async () => {
  const r = await transcriptUsage(fileURLToPath(new URL('./fixtures/job-usage-small.jsonl', import.meta.url)));
  assert.deepEqual(r.reasons, ['ordinary context and call volume']);
  assert.equal(r.startingContext, 90); assert.equal(r.peakContext, 140); assert.equal(r.lastContext, 110);
});

test('Codex calls retain the model active at each observation', async () => {
  const turn = model => ({ type: 'turn_context', payload: { model } });
  const count = (second, total, input) => ({ type: 'event_msg', timestamp: `2026-11-11T01:00:0${second}Z`, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total }, last_token_usage: { input_tokens: input } } } });
  await fixture([turn('first-model'), count(0, 90, 90), turn('second-model'), count(1, 230, 140), count(2, 340, 110)], async f => {
    const r = await transcriptUsage(f);
    assert.deepEqual(r.models, ['first-model', 'second-model']);
    assert.deepEqual([...r.nativeCalls.values()].map(c => [c.model, c.uncached]), [['first-model', 90], ['second-model', 140], ['second-model', 110]]);
    assert.equal(r.startingContext, 90); assert.equal(r.peakContext, 140); assert.equal(r.lastContext, 110);
  });
});

test('partial Codex fragments contribute start time and known model', async () => {
  const meta = { type: 'session_meta', timestamp: '2026-11-10T05:59:00Z', payload: { id: 'fragmented' } };
  const row = { type: 'event_msg', timestamp: '2026-11-10T06:01:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100 }, last_token_usage: { input_tokens: 100 } } } };
  await fixture([meta], async (f, root) => {
    const late = { ...meta, timestamp: row.timestamp };
    writeFileSync(join(root, 'a-copy.jsonl'), [late, row].map(JSON.stringify).join('\n'));
    writeFileSync(join(root, 'z-copy.jsonl'), [late, { type: 'turn_context', payload: { model: 'known-model' } }, row].map(JSON.stringify).join('\n'));
    const r = await usageJobs({ roots: [root], day: '2026-11-09' });
    assert.equal(r.jobs.length, 1); assert.equal(r.jobs[0].calls, 1);
    assert.equal(r.jobs[0].start, meta.timestamp.replace('Z', '.000Z')); assert.equal(r.jobs[0].durationSeconds, 120);
    assert.deepEqual(r.jobs[0].models, ['known-model']);
  });
});
test('output-only counter reset is reported', async () => {
  const row = (second, output) => ({ type: 'event_msg', timestamp: `2026-11-11T01:00:0${second}Z`, payload: { type: 'token_count', info: { total_token_usage: { output_tokens: output }, last_token_usage: { output_tokens: output } } } });
  await fixture([row(0, 10), row(1, 5)], async f => { const r = await transcriptUsage(f); assert.equal(r.counterResets, 1); assert.equal(r.output, 15); });
});
test('partial Claude updates merge counters by maximum across copies', async () => {
  const row = (input, read, create, output) => ({ type: 'assistant', sessionId: 'updates', message: { id: 'one', usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: create, output_tokens: output } } });
  await fixture([row(10, 30, 0, 2)], async (f, root) => {
    writeFileSync(join(root, 'copy.jsonl'), JSON.stringify(row(20, 40, 5, 3)));
    const r = (await usageJobs({ roots: [root], day: 'all' })).jobs[0];
    assert.equal(r.calls, 1); assert.equal(r.uncached, 20); assert.equal(r.cacheRead, 40); assert.equal(r.cacheCreate, 5); assert.equal(r.output, 3); assert.equal(r.totalTokens, 68);
  });
});
test('default ranking stops at ten and directory symlinks are skipped', async () => {
  await fixture([], async (f, root) => {
    const outside = mkdtempSync(join(tmpdir(), 'usage-outside-'));
    try {
      const row = (id, input) => ({ type: 'assistant', sessionId: id, message: { id, usage: { input_tokens: input } } });
      writeFileSync(join(outside, 'outside.jsonl'), JSON.stringify(row('outside', 99999)));
      symlinkSync(outside, join(root, 'linked-dir'));
      for (let i = 1; i <= 12; i++) writeFileSync(join(root, `${i}.jsonl`), JSON.stringify(row(`job-${i}`, i)));
      const r = await usageJobs({ roots: [root], day: 'all' });
      assert.equal(r.measuredJobs, 12); assert.equal(r.jobs.length, 10); assert.equal(r.jobs[0].session, 'job-12'); assert.equal(r.jobs.at(-1).session, 'job-3');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

test('a later model selection followed only by quota repeat cannot relabel an earlier call', async () => {
  const row = second => ({ type: 'event_msg', timestamp: `2026-11-11T01:00:0${second}Z`, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100 }, last_token_usage: { input_tokens: 100 } } } });
  await fixture([row(0), { type: 'turn_context', payload: { model: 'later-model' } }, row(1)], async f => {
    const r = await transcriptUsage(f); assert.equal(r.calls, 1); assert.deepEqual(r.models, ['unknown']);
  });
});
test('malformed record shapes do not abort valid accounting', async () => {
  await fixture(['null', '[]', '42', '{', { type: 'assistant', sessionId: 'valid', message: { id: 'v', usage: { input_tokens: 11 } } }], async f => {
    const r = await transcriptUsage(f); assert.equal(r.calls, 1); assert.equal(r.uncached, 11); assert.equal(r.malformedLines, 4);
  });
});
test('sessions spanning midnight keep lifetime totals on the start day', async () => {
  const row = (id, timestamp, input) => ({ type: 'assistant', sessionId: 'overnight', timestamp, message: { id, usage: { input_tokens: input } } });
  await fixture([row('first', '2026-11-11T05:59:00Z', 100), row('second', '2026-11-11T06:01:00Z', 200)], async (f, root) => {
    const r = await usageJobs({ roots: [root], day: '2026-11-10' });
    assert.equal(r.jobs.length, 1); assert.equal(r.jobs[0].calls, 2); assert.equal(r.jobs[0].totalTokens, 300); assert.equal(r.jobs[0].durationSeconds, 120);
    assert.equal((await usageJobs({ roots: [root], day: '2026-11-11' })).jobs.length, 0);
  });
});
test('call-count and output-volume reasons distinguish workloads at their thresholds', async () => {
  const row = (id, output) => ({ type: 'assistant', sessionId: 'volume', message: { id, usage: { input_tokens: 10, output_tokens: output } } });
  await fixture(Array.from({ length: 101 }, (_, i) => row(String(i), 1000)), async (f) => {
    assert.deepEqual((await transcriptUsage(f)).reasons, ['many model calls', 'large output volume']);
    writeFileSync(f, Array.from({ length: 100 }, (_, i) => JSON.stringify(row(String(i), 1000))).join('\n'));
    assert.deepEqual((await transcriptUsage(f)).reasons, ['ordinary context and call volume']);
  });
});
