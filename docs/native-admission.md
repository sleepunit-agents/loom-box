# Native launch admission (t-535)

143 does not exclude replacement native work after a delivery marker expires or
its registrar dies. Its eventual stop/retire of a late body prevents stale state
commits, but cannot undo work already performed in parallel.

The new regression checks native admission count before releasing the first
start, both past four minutes with a live registrar and after registrar death.
These are required failures against143. They are not a complete native-process
verification suite and this branch must not deploy while they fail.

## Required handoff

Persist one conversation attempt id before entering any launcher. Its immutable
sealed intent includes the run key and selected native launch parameters so a
replacement registrar can continue the SAME attempt and sender proof. A new
registrar cannot invent a fresh operation or replay its input while the old
attempt's outcome is uncertain. Elapsed time is a health signal, not a fence.

Use a runtime-owned launch worker to outlive controller death. It invokes the
existing native runners; it is not another model router. Persist a boot id,
worker process identity, and stable native token/run key before native admission.
Commit a native receipt before returning it to delivery. Both local delivery and
house body-host use this protocol, and the house request id is derived from the
same attempt, rather than generated anew for a registrar retry.

The worker obtains the whole input before admitting native work. Native process
identity is recorded before its stdin is released. Losing the controller after
admission must leave the worker and durable receipt recoverable. Losing the
worker after native launch must retain its native token/run key for recovery:

- Codex: the stable run directory and native PID/OS process identity. Its current
  pid file is written after spawn; the crash window before that write needs a
  child gate or authoritative process discovery, not an assumption of no work.
- Claude: the stable token in its job intent. A failed or timed-out `--bg` call
  can have submitted a daemon request. A missing job today does not establish
  that it cannot appear later. Persist uncertainty and keep reconciling this
  token; never submit a new token merely because a poll limit was reached.

The supervisor may adopt the same native identity, or retire it through the
common acknowledged stop/save transaction before another admission. A receipt
must include its generation so an old one cannot release a later attempt.
Physical destruction of the attempt's isolated house, or a verified OS boot
change for a local attempt, can prove old work cannot execute. Registrar death,
missing PID registration, timeout, and a failed observation cannot.

Where native admission truly cannot be observed, report uncertain work rather
than claiming completion or admitting a duplicate. Do not kill all bodies in a
shared daemon or all child services to clear the condition. Finishing the
implementation requires a usable recovery path, not just removing the timeout.

## Tests before shipping

Keep the new count regressions and update the former H/late-start fixtures to
the stronger exclusion contract once implemented. Exercise both real runner
adapters with harmless fake native executables and actual OS worker death at
each boundary: before admission, after native spawn before PID registration,
after native work begins before receipt, after receipt before conversation
commit. Test separate fresh controller processes, house request retries and
body-host restart, late Claude daemon admission, lost replies, owner interruption,
and quota routing after confirmed refusal. Every uncertain boundary must keep
the original attempt and no second native work; confirmed refusal must retain
the existing autonomous retry capability. Repeat live Codex stop/resume only
after source, pins and deployed controller agree.

## Prepared delivery commit

The journal/supervisor alone does not fix delivery. Before entering any native
launcher, persist a prepared conversation record containing the attempt id,
selected body metadata and record generation, run id, sender-key hash, body
rules, route/slot metadata, and the original sealed queue entries. Keep the
actual sender key in the existing private key file, never plain conversation
metadata. A recovery must bind that same receipt and prepared record, rather
than resolve another model or invent another run key.

A live registrar retains ownership regardless of age. A dead registrar with
prepared state schedules recovery of that same operation. A reserved attempt
can be cancelled atomically before retry: its late worker must lose admission.
Once admitted, cancellation cannot erase it. Missing journals after a submitted
attempt are uncertainty, not evidence that no native work exists. OS boot and
process birth identify the registrar; PID existence alone permits reuse mistakes.

A recovered native identity without a worker receipt carries inputUncertain.
Do not acknowledge original messages as fully delivered from that identity.
Bind enough metadata to stop/save the native writer through the common retirement
transaction, then resume with the original queued work and its actual native
context. If the owner interrupted meanwhile, keep it held. Never replay while
that writer remains live. The Codex prompt pipe is flushed before a normal
receipt commits; a worker lost before that receipt cannot retroactively prove
full input delivery.

Remote work needs the same stable attempt mapped to its house request and the
body-host journal. Host and house PID namespaces differ: only the native host
observes its own worker. Older hosts need a capability check and drain/update
path before receiving this protocol. Legacy unprepared starts also need explicit
reconciliation or a physical execution barrier; new records cannot prove their
absence after the fact. The unfinished draft must not deploy until these cases
and the two delivery exclusion regressions pass.

## House request journal

The controller reserves a stable request in `delivery/house-launches/<attempt>.json`.
Its public handle fixes the agent, seat, house, harness, intent hash and 16-digit
request id. The private request uses the existing transit representation and
private atomic file writes. The conversation must commit that handle before
publication. Repeating preparation with another intent is refused.

Publication shares the host lock with stop admission and authenticated host sync:

1. Write `publishing` to the journal before exposing the request.
2. Write the exact request, tagged with its attempt, into that house's record.
3. Mark the journal `published`.

Only `reserved` can be cancelled. A late publisher sees the refusal and cannot
expose it. `publishing` remains uncertain even if the temporary host request was
lost; its absence cannot authorize replacement work. Recovery may repeat that
same publication to the same house, never choose another house from a timeout.
The exact request tag also recognizes an interrupted publication between writes.

Authenticated host sync persists the native receipt before returning its answer.
A fresh controller can recover it after the transient host report disappears.
A claim timeout retains both request and journal. Once the conversation commits
the receipt, acknowledgement removes the request while preserving the receipt.
An ordinary error string cannot prove that native admission never occurred.
The explicit between-launch stopping handshake can provide that proof.

A legacy identity receipt carries `inputUncertain`; it cannot acknowledge full
input delivery. Conversation delivery now commits prepared house state before
warming and the exact handle before publication, then binds the original receipt
through its common generation/run/sender commit. The native house fence and
capability gate use the shared worker. Authenticated host restart reconstruction,
legacy-start reconciliation and physical barrier recovery still gate deployment.

## Resume restoration inside admission

The shared native worker accepts packed resume files in its private input and
includes them in the immutable intent hash. Only the admitted worker restores
them, before invoking the existing native adapter. A controller retry or receipt
observation never restores files over an already admitted writer. Restore errors
before entering the native adapter are confirmed refusals. Errors after possible
native admission retain the restored files and admission for recovery; cleanup
cannot assume that the native writer stopped.

The worker input bound includes the existing maximum session pack in base64 as
well as the prompt and launch configuration. Packed files remain outside public
journal metadata. Both adapter fixtures verify restoration before native entry,
one native resume under competing controllers, and preservation of subsequent
native edits. A real worker SIGKILL during resumed Codex input verifies recovery
of the same OS writer with explicit input uncertainty and its restored files kept.

## Pending house launches and receipt acknowledgement

A host advertising `native-admission` starts durable attempts asynchronously so
native admission and input transfer cannot block authenticated sync, packing or
owner shutdown. Actual native adapters use the shared OS launch worker and full
selected constructor configuration. Explicit injected adapters share the same
ledger in-process; an uncertain injected call cannot run again on every beat.

The host reports every unsettled request id, including completions still waiting
for a receipt acknowledgement. The controller cannot synthesize a pre-start
refusal for those ids. The receipt list is bounded; the unsettled-id list must
not discard ids merely because they fall beyond that receipt limit. Missing or
malformed pending metadata, or loss of a previously established capability,
remains uncertainty. A host cannot exit for cooperative shutdown with unsettled
identities or incomplete pending metadata.

A controller acknowledges a durable receipt explicitly only after persisting it.
The host retains an unacknowledged completion even when shutdown stops returning
requests. A receipt carries its original attempt so a lost acknowledgement can
be retried after the bound request was removed. Terminal journal entries are
never returned as launch requests again. Stop calls use the host's selected body
environment, with its bootstrap task and host credential excluded.

The conversation controller persists pending acknowledgement handles atomically
with its receipt commit. Cleanup runs outside the conversation lock, removes only
acknowledged handles, and retries on subsequent ticks. Later generations append
to the pending acknowledgements rather than replacing an older failed one.
Confirmed refusals are acknowledged through the same cleanup path.

Uncertain input binds enough identity to stop and collect the writer through the
common retirement transaction before replaying the original sealed messages.
Tests verify restoration of the original native context before another admission,
and that owner interruption keeps the work and slot held without replay.
Authenticated OS-process restart of the host remains a shipping requirement.

## Read-only recovery queries

After native worker death, status discovery also runs in an owned process. The
observer receives the original constructor configuration, environment and token
on private stdin and calls only the existing adapter's `recoverLaunch`. It never
starts, resumes, restores or stops work. Its bounded stdout contains only a
validated native identity and optional session identity; failures remain pending.
The supervisor keeps at most one query in flight per caller and backs off pending
metadata without releasing admission. Normal confirmed-receipt delivery needs no
observer process.

This keeps a blocked native CLI query out of the shared house host's event loop.
The same observer is used by local conversation recovery. Regression coverage
includes a real worker death followed by a blocked Claude query while authenticated
host sync and shutdown continue. Fork errors, failed exits, malformed/oversized
replies and wrong-harness identities do not change the admission journal or start
replacement work.

## Delivery controller process-death verification

The delivery integration tests now use separate OS processes for the original
controller, the house host and its real native-adapter workers, then SIGKILL the
controller and recover through a fresh ordinary CLI process. The provider CLIs
are harmless local stand-ins; the core HTTP and piece API fixture authenticates
separate runtime and house credentials.

Both Claude and Codex cover four boundaries:

- Reserved before publication: no native executable has run. Recovery cancels
  that reservation before retry, and late publication stays refused.
- Native work before the controller's house receipt: the authenticated receipt
  request is held until after controller death, then the original receipt binds.
- House receipt before conversation commit: recovery preserves the original body
  generation, run id, sender hash and non-owner principal.
- Conversation commit before acknowledgement: recovery clears the durable pending
  acknowledgement without rebinding or incrementing the run.

Every case verifies one native launch and one house, then posts one reply through
the recovered native session and its original sender proof. These process tests
do not substitute for real-container host-failure/session-collection verification.
