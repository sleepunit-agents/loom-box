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

Scheduled and agent jobs get the work tool profile by default. Claude uses a private
strict MCP file assembled from its usual global and project MCP definitions, keeping
only loom, github, gh-art/gh_art and taskstore. Codex filters those same servers and
passes `--disable apps --disable remote_plugin`, using a distinct generated home.
Shell and coding tools remain available; `gh-art` and taskstore need no MCP schema.
Existing deny flags remain in force. A conflicting custom Claude MCP config or Codex
config layer fails the lean launch rather than silently loading extra connectors.
`LOOM_RUNTIME_WORK_PROFILE=off` restores the ordinary tool profile.

The start brief asks identity for `profile: work`. Core needs the matching optional
identity API and the agent's authored `work-identity.md` (at most 8000 bytes). Missing,
empty or oversized files fall back to the full identity. Owners, room, project,
explicit role/project context, client adapter restrictions and health warnings are
preserved. Full identity remains available on demand. Install core before runtime.

`LOOM_RUNTIME_CONTEXT_CAP` defaults to 150000 for scheduled/agent jobs, accepts
20000–2000000, and `off`/`0` disables it. Live conversations are unchanged. This is a
COOPERATIVE threshold, not a hard ceiling: after a completed API call is observed,
the runtime feeds a handoff request through the existing inbox. The body must reach
a tool boundary, read it and comply. A non-feedable or noncompliant harness can pass
the threshold; no automatic destructive interruption is claimed. A single large
response can also cross it before observation. An explicit bounded handoff final is
sealed on the conversation, the old writer is retired with its inbox reconciled,
and its sealed transcript is copied to a context archive beside the slot. The
continuation starts a fresh session with the saved note under the same principal
and model pin. The handoff is never returned as job completion. The note and archive
survive controller restart; old transcript archives are retained, not discarded.

Rollout evidence must distinguish measured first-call tokens from byte savings.
The supplied task baseline was 699 Claude calls: first 80,760, average 383,078,
cache-read 258.7M, cache-create 9.0M, output 0.64M. This isolated house cannot rank
other houses or local host sessions. Run the command on the host with its actual
archive roots, keep its JSON as a loom note attachment, and inspect the top ten in
their own job records for task-specific causes. Measure new first calls from real
work-profile jobs after deploying both core and runtime; do not equate byte counts
with token counts.
