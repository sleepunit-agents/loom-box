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

Without `--root`, the command asks the runtime for local **and box** snapshots.
`--agent art` filters by recorded house owner; `--box wunder` accepts a box id or
name. Filtering happens before ranking/limiting. Agents can read only their own
identified sessions; the owner can also see unassociated local terminal sessions.
An explicit `--root` remains an offline scan and cannot use agent/box filters.

Each box's existing health polling loop samples its houses' durable native roots
once a minute. It sends batches of at most 100 allowlisted numeric session rows
on authenticated polls. The runtime verifies that the house belongs to that box
and derives the agent from its own house record. Unknown fields and native file
paths never enter the retained snapshots. A final acknowledged sample precedes
native cleanup; failures retain the house for retry. Reports remain in the
control plane after house cleanup or runner restart. This is separate from quota
reporting and never sends transcript text through the job-usage report.

Rows carry box id/name, house, agent, last report time and native harness/session.
Conversation is added when the runtime still knows the native slot; `currentRun`
is the current run associated with a live slot, **not** an attribution of lifetime
session traffic to that one run. Missing associations remain absent. Local rows
are labelled by the control-plane box. Same-box session copies/retries keep the
largest lifetime snapshot rather than adding it twice. A native session restored
onto another box can appear on both boxes with overlapping lifetime totals; this
report does not claim per-call execution attribution or additive fleet billing.
A partial copy with fewer tokens cannot replace a larger snapshot. Silent boxes
retain their last snapshot and `reportedAt`; they are not claimed current.

Rollout after review/merge approval: update the runtime control plane first, then
the runtime runner on every reporting box. Verify an active house on each box,
then its final snapshot after cleanup, using `usage jobs --day all --box <id>`.
Existing deleted histories cannot be recovered by this feature; explicit archive
roots can still be measured offline. No house-image update is needed for boxes
whose houses already have the durable native-history mount. Old service houses
without that mount are not measured by the box scanner.
