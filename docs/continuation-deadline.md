# Shared continuation deadline protocol — proposed, not implemented

This is the next implementation contract for runtime148/core675/clock24.
There is no collector, deadline enforcement or bounded-retention claim in those
heads today. Keep all three drafts held. Native145 and history676 are separately
owned; integrate only their completed handoffs.

## Authority and wire format

Version 2 grants carry immutable `issuedAt` and `expiresAt`, integer Unix
milliseconds, sealed with the existing source snapshot. Proposed maximum lifetime:
30 days from issuance, chosen by runtime policy, never by the requesting body.
Return `{handle, expiresAt}` to the authenticated issuer. No automatic renewal,
no extension on bind/retry/restart, no new grant issued by the child. Longer work
requires a new authenticated source-holder grant and a separately scheduled wake.
The old grant/report ids never transfer to it.

Runtime persists an authority-clock high-water mark before issuance/admission or
send. Detect a local clock below that mark and hold authority-changing operations
until time recovers; status and reconciliation remain available. Persist an expired
bit before returning terminal expiry. Once observed expired, a backward clock or
restart cannot reactivate a grant. Core independently persists its acceptance
clock high-water mark; client timestamps never set core's clock.

These mechanisms detect rollback relative to observed time, not arbitrary elapsed
real time while all processes were stopped. The protocol assumes a trustworthy
core wall clock. Do not claim protection against restoring an entire old database
or moving the clock backwards to an unobserved time during downtime. Clock health
failure holds new acceptance, and no data is collected while time is uncertain.

Clock scheduling must obtain the deadline from runtime using a clock-authenticated
capability inspection call, not a caller-supplied `--expires` value. Validate the
issuer's authenticated principal against the grant before inspection. Require
`scheduledAt < expiresAt`; refuse the scheduling request visibly before committing
a spool entry or creating a timer. Save the returned deadline in the durable
spool/firing JSON. Runtime checks equality with its sealed grant at admission;
clock-supplied deadline alone grants no authority. Fire/recovery may replay the
same payload, but admission at or beyond cutoff is refused. Deferred/warm/queued
messages must recheck before native start, not just on HTTP delivery receipt.
Do not start a native child for an expired continuation under ordinary-wake
fallback. A forged handle is still incapable of authorizing a report.

Runtime bind and first enqueue require `now < expiresAt`. Known report status,
including terminal receipts, remains readable by the bound authenticated child
after expiry. Exact re-enqueue of a known id returns that status after comparing
its payload digest; a changed payload still conflicts. A new id at cutoff fails.
Retries require both the sealed grant and report deadline to match, plus all
existing principal/reset/child/target checks.

Runtime sends `expiresAt` on every core continuation request. Core requires it
for version2, validates integer/range/type without coercion, and includes it in
the HMAC payload hash with agent/place/text/run/on. The runtime token authenticates
this contract; an arbitrary body must never reach the adapter with its own cutoff.
Keep it stable across proxies and every retry. Core is the final acceptance clock,
so network delay past cutoff cannot create a new reply even if runtime sent early.

## Acceptance, receipts and the lost-response fence

Core checks deletion first, then an existing ref and its hash. An exact existing
receipt may be returned after cutoff; a mismatched payload is always409. A missing
ref can be accepted only before cutoff, with the expiry check and insert in the
same serialized message transaction. There must be no asynchronous work between
that check and insert. The logical acceptance point is that transaction's cutoff
check, not the HTTP response or physical completion time. An already accepted
transaction may finish after cutoff; never promise otherwise.

At cutoff, runtime pending rows become `indeterminate` if any attempt was durably
recorded before I/O, even if the process died before actually sending. A row with
zero attempts becomes `expired` (no send was possible). Delivered remains delivered.
Do not label a transport loss, timeout, or an expiry refusal after an earlier
attempt as known undelivered. Reset/deletion refusals after an uncertain attempt
also need an explicit uncertainty disposition; they cannot erase acceptance history.
Persist `everAttempted` separately from retry count if attempts are ever compacted.

Add a runtime-auth-only reconciliation operation taking ref plus the complete
immutable payload commitment and deadline. It cannot append a reply. It returns
`delivered` (original receipt), `conflict`, `deleted`, or `not-accepted` only after
core's own cutoff is reached. Before cutoff, missing means `unresolved`.

A plain SELECT is insufficient for `not-accepted`: it can race a writer that
already passed its cutoff check. Reconciliation must acquire the SAME SQLite
write serialization as acceptance (e.g. BEGIN IMMEDIATE), wait for earlier writers,
check the authoritative clock/high-water state inside that transaction, then
look up the receipt. Future writers must perform their own cutoff check under
that lock. Thus a fenced missing result after cutoff proves no allowed writer
can later insert that ref. Deleted is a terminal revocation, but does not prove
whether a now-erased reply was once accepted. Surface that distinction rather
than inventing an original receipt. Timeout acquiring the fence stays unresolved.

After restart, runtime reconciles indeterminate rows rather than retrying a write
past cutoff. A late successful receipt from an in-flight pre-cutoff attempt may
upgrade indeterminate to delivered under the outbox lock; it must not be dropped
merely because the row is no longer pending. Never downgrade delivered. Conflicting
responses hold for investigation. Deadline refusal with no previous attempt is
expired; with any attempt it triggers reconciliation.

## Upgrade and collection sequencing

Legacy no-deadline grants fail closed for new admission/enqueue/drain after upgrade.
Retain their records and existing receipts. They do not inherit a new 30-day window.
An authenticated source-holder adoption may issue a NEW version2 grant for future
work after proving the current snapshot; it cannot rewrite an old report's hash,
ref or deadline. Legacy uncertain sends require their existing dedup/reconciliation
path and indefinitely retained core refs until explicitly resolved. This can hold
rollout; do not hide it by deleting legacy state.

The first implementation does not collect anything. First prove deadline authority,
upgrade and reconciliation. A later collector may remove sealed report text only
once a durable receipt/expiry/disposition and payload commitment survive, the grant
is irrevocably expired, and no send can still be admitted. Keep the id/hash commitment
for conflict detection; keep minimal grant tombstones so ids cannot be adopted anew.
Unknown grants always fail closed. Receipt lookup and deletion cleanup must share
an ordering rule so collection cannot turn delivered into a new accepted reply.

Core may eventually delete an expired ref/hash only when its cutoff is durably
closed and its clock cannot reopen it; late exact retries would then receive an
expired disposition, never a fresh insert. Do not implement this until runtime has
a durable reconciled receipt or explicit unresolved-retention policy. Deleted-thread
tombstones and deletion cleanup journals remain outside receipt GC. This design
bounds authorization lifetime, not total storage: unresolved legacy rows and minimal
tombstones remain retained. Any storage-bound claim needs its own measured policy.

## Required implementation order and adversarial evidence

1. Add sealed version2 deadlines, persisted clock/expiry state and holder-readable
   receipt states, without enabling collection. Prove exact D-1/D/D+1 issue/bind/
   enqueue/drain, restart after observed expiry, rollback and conflicting re-enqueue.
2. Add strict core deadline/hash enforcement and fenced reconciliation. Prove delayed
   new-ref request crosses cutoff, exact existing receipt after cutoff, modified
   deadline409, a paused earlier writer versus reconciliation, and SQLite busy/timeout.
3. Add clock-auth inspection and scheduling/admission checks. Prove visible refusal
   beyond cutoff, rearm/replay cannot extend it, and queued native admission rechecks.
4. Wire outbox late receipts and reconciliation; SIGKILL before send, after acceptance,
   before local receipt, then cross cutoff and restart in a fresh process. Verify one
   reply, no write retry after expiry and delivered/expired/indeterminate distinctions.
5. Prove upgrade with unbound, bound, pending and delivered legacy records; reset and
   deletion at every cleanup boundary; no implicit adoption or deadline refresh.
6. Obtain independent adversarial review, resolve exact-head CI including recorded
   deadline failures, integrate completed native admission/history handoffs and run
   actual clock/native crash route. Only then consider a separate collection change.

No merge/install or native-provider proof follows from writing this contract.
