# Context continuation

`LOOM_RUNTIME_CONTEXT_CAP` defaults to 150000 for scheduled/agent jobs, accepts
20000–2000000, and `off`/`0` disables it. Live conversations are unchanged. This is a
COOPERATIVE threshold, not a hard ceiling: after a completed API call is observed,
the runtime feeds a handoff request through the existing inbox. The body must reach
a tool boundary, read it and comply. A non-feedable or noncompliant harness can pass
the threshold; no automatic destructive interruption is claimed. A single large
response can also cross it before observation. An explicit bounded handoff final is
sealed on the conversation. A fresh successor first reads and acknowledges it
under the same principal, model pin and restriction floor. The old writer is
then retired with its inbox reconciled, and its sealed transcript is copied to a
context archive beside the slot. The accepted successor resumes with the saved
note and queued work. The handoff is never returned as job completion. The note and archive
survive controller restart; old transcript archives are retained, not discarded.

A requested handoff whose final is missing, malformed, empty or oversized, or whose
saved note cannot be decrypted, is held visibly on the conversation. Its native
history remains owned by the predecessor; it is not returned as a spawned result.
A corrected valid handoff can be collected on a later tick. An ordinary final
response can still finish work that completed before handing off.
Missing or malformed predecessor model metadata holds rotation before retirement.
A continuation with an invalid or mismatched pin waits rather than selecting a
new model.

A body can request rotation at a completed task boundary, below the cap or with the
cap disabled: pipe its handoff to `loom runtime context-boundary --note -`. This is
an authenticated body call (current conversation, run key, harness session and
agent/house). A nonempty note of at most 12,000 characters is sealed before the
command returns. The body must then end its current turn without beginning more
work. The cap remains a cooperative backstop for bodies that do not request a
boundary themselves.

The successor first runs an acceptance turn with the predecessor's model and
restriction floor. The predecessor stays idle, owns the conversation and keeps
its native history. Follow-ups remain queued. The successor reads the note and
returns `LOOM_CONTEXT_ACCEPT <note-digest>` as its entire final response, without
calling tools or doing task work. Only that acknowledgment permits predecessor
retirement and archival. The runtime then resumes the accepted fresh session with
the saved note and queued messages. A start failure, missing acknowledgment or
changed note holds visibly; it never returns the handoff as job completion.

Missing or malformed predecessor body rules refuse rotation before successor
launch. The saved floor, principal, profile markers and model pin are durable.
A changed principal or standing restriction holds instead of widening access.

Non-default profile markers currently hold before launch: this branch does not
implement the separate work-profile runner contract. It never silently drops a
profile it cannot propagate.
