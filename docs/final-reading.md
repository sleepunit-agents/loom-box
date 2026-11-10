# Incremental Claude final messages

Claude final reads remember offsets and the last assistant words for the 64 most recently used transcripts in this process. Appends are read incrementally, with whole UTF-8 characters, and text parts are joined by newlines. Replaced or shorter files restart at zero; links and non-regular files are not read.

This memo is bounded, rather than a durable index: eviction or a process restart requires one initial whole scan, in bounded slices. More than 64 transcripts polled in rotation can therefore force repeated scans. Houses normally poll far fewer; a durable index for larger populations is separate work. The 64-transcript test pins retention within the supported working set.

One unfinished JSON line may occupy at most 16 MiB. Larger lines are skipped through their next newline. A final reports an explicit omission notice and the last readable words, never silently claims they are the newest. A later readable assistant message clears the notice. This bounds memory for transcripts containing huge tool results; it intentionally cannot reconstruct assistant text inside an oversized event. Tests cover the notice and recovery.
