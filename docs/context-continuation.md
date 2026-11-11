# Context continuation

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
