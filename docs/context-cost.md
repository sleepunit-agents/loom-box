# Job context and token traffic

`loom runtime usage jobs` reads local Claude and Codex native transcripts. Repeat
`--root PATH` to include copied house archives and local projects/sessions together;
`--day YYYY-MM-DD` selects sessions that STARTED on that day (America/Chicago by
default), `--day all` selects all, `--timezone TZ` changes the day boundary and
`--limit N` controls ranking (default ten). Output is JSON, no transcript text.

The unit is a native session, explicitly labelled: one runtime job can span several
sessions. Copied sessions are combined by native request identity. A resumed native
session stays one row; a context handoff starts another. Total tokens ranks token
traffic, NOT dollars or quota. Model prices and cache discounts are not inferred.
Starting/average/peak/last context include cache reads and writes. `cacheWriteCalls`
counts API calls with positive cache creation, alongside `cacheCreate` tokens. This
makes rewrites visible but cannot distinguish TTL expiry from a changed prefix; it
is not a count of proven TTL misses. Claude input is
uncached; Codex input already includes cached input, so cache reads and writes are
subtracted to obtain uncached input. Codex reasoning output is part of output and
is not added again. Repeated Claude request/message IDs and unchanged Codex totals
are not charged twice. Truncated JSON lines are counted, not fatal. Duration is
first-to-last transcript timestamp, not CPU or model latency. Reasons are numerical
inferences (large start, large context, many calls, cache rereads, output volume),
not claims about unseen task contents.
