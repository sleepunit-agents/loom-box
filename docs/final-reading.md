# Incremental Claude final messages

Claude final reads remember offsets and the last assistant words for the 64 most recently used transcripts in this process. Appends are read incrementally, with whole UTF-8 characters, and text parts are joined by newlines. Each scan reads one open descriptor only up to its initial size (appends wait for the next scan) and checks the path again before keeping its result; replacement or shortening during a scan retries once from zero, then returns no result if it keeps changing. Configured slices have a four-byte minimum so every UTF-8 character can advance. Replaced or shorter files restart at zero; links and non-regular files are not read.

The process memo remains a 64-transcript LRU. Native Claude jobs also keep a disposable `.loom-final` checkpoint in their existing `jobs/<id8>` directory. RAM eviction or a process restart reloads that job's validated snapshot instead of rescanning unchanged transcript bytes. Changed transcripts still obey the descriptor identity, observed-size and UTF-8 rules above. Checkpoint corruption, missing job ownership, storage failure or an unsupported filesystem costs an initial rescan; it does not change which transcript words are authoritative. Readers without a native job directory retain the process-only LRU behavior.

Checkpoints contain a versioned header (at most 16 KiB), rest (at most 16 MiB UTF-8), last words (at most 16 MiB measured as UTF-8, stored as at most 32 MiB UTF-16LE to preserve JSON's escaped lone surrogates), and SHA-256 integrity bytes. File and field lengths are checked before allocation. Payloads are bounded reads through regular, owner-held files, with no symlink traversal of the job or checkpoint. Writes use private temporary files and atomic rename through an open directory descriptor; they neither recreate a retired job nor follow a replaced job directory. Crash remnants are cleaned before another save or at retirement. There is no fsync requirement: losing this disposable state only causes a rescan. Unchanged polls do not rewrite it.

The disk budget is proportional to retained native jobs, as approved for this reader: at most 48 MiB plus header/integrity bytes per checkpoint, and one additional replacement file during a normal atomic save. There is no global disk LRU that could recreate the population cliff. The RAM LRU remains bounded; loading/saving adds bounded temporary field buffers. Concurrent independent writers may discard one another's temporary checkpoint and lose progress, but a partial file cannot pass the integrity/length checks; this is not a shared multi-process index or cache-coherence protocol.

`dropSession` forgets the in-memory words and removes the checkpoint before deleting a body's job directory. Slot-only expiration also searches matching job state to remove checkpoints left by interrupted retirement, without deleting unrelated jobs. Checkpoints and temporary files are excluded from packed continuity history. Body cleanup failures use the existing retirement retry path; checkpoints have no separate retention period or directory of their own.

`test/final-checkpoint.test.mjs` pins a 128-job rotation, append-only reads, fresh-process restore, Unicode, snapshot retry, invalid checkpoint fallback and retirement/slot cleanup. The standalone byte-read reproduction is `node scripts/measure-final-reads.mjs [baseline-checkout]`. With one 1 MiB tool event and a Unicode assistant event per transcript, measured at baseline `0fa08bb1cb8d5207c2893eecab75e569b73f9449`:

| Transcripts | Baseline bytes on each unchanged poll | With checkpoints |
|---|---:|---:|
| 64 | 0 | 0 |
| 65 | 68,164,785 | 0 |
| 128 | 134,232,192 | 0 |

Initial scans read the same transcript bytes before and after. The measurement counts actual `readSync` return bytes on transcript descriptors separately from checkpoint/job-state I/O. A 128-job unchanged poll now reads small checkpoint/job records instead of 128 MiB of transcript history; large last messages or unfinished lines can still require correspondingly larger bounded checkpoint reads after RAM eviction.

One unfinished JSON line may occupy at most 16 MiB. Larger lines are skipped through their next newline. A final reports an explicit omission notice and the last readable words, never silently claims they are the newest. A later readable assistant message clears the notice. This bounds memory for transcripts containing huge tool results; it intentionally cannot reconstruct assistant text inside an oversized event. Tests cover the notice and recovery.
