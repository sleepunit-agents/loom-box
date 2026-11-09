# Continuation report delivery (integration in progress)

This branch supplies an internal capability/outbox state machine. It is deliberately
exposed through holder-authenticated issue/enqueue/status API routes only.
No clock binding, drain or CLI is enabled yet; issued grants cannot deliver. It does not authorize historical
originConversation links, and does not fix originating-thread delivery by itself.

The delivery layer must prove the current source holder with holderProblem (agent,
key, session and house) before issue. It constructs snapshots from loadConv and
principalOf, including actsFor.reset (null before a reset), resetPending and the
immutable conversation venue/place. No snapshot fields come from request JSON.
An unknown steering principal must be refused at this boundary.

Clock admission must carry the opaque capability on a newly created wake. Trusted
clock firing and runtime delivery bind the exact wake id, delivery id and admitted
child run, once. A body cannot call bind. Retries of the same binding are harmless;
reuse for another wake, delivery or run is refused. Do not use display provenance
as evidence of a binding. Existing wakes need authenticated issuer adoption.

Only the bound child's proven current holder may enqueue or read its receipts. Its
caller supplies a report id and text, never a destination. Retrying an id with new
text is a conflict. Do not expose the store to direct house filesystem access.

The delivery tick must drain with current runtime-owned snapshots of both source
and child. Source holder changes are allowed; source reset, principal or target
changes invalidate authority. Child run changes invalidate authority. Post uses a
fixed runtime-issued stable ref and the original destination. It must not call send
with a borrowed run key. The existing normal send holder gate stays unchanged.

Core's adapter must first accept continuation refs under runtime authentication,
store their exact payload hash and return the original receipt on exact retries.
The outbox's test adapter models that required contract; it is not proof that core
currently implements it. Crash after acceptance before receipt then safely retries.
Other venue adapters need an equivalent idempotency contract before enabling this
path for them. Never infer success from accepted/pending alone.

Records, including report text, are sealed using runtime's sealer. Every mutation
writes a fresh private file, fsyncs it, renames it, and fsyncs the directory. A
pending attempt records its next retry before I/O. Receipts distinguish pending,
delivered and permanently failed. Transient errors retry after restart; permanent
adapter refusals stop. Outbox collection/expiry is still an integration decision.

Holder-authenticated issuance and receipt/enqueue endpoints now construct snapshots
from runtime state and enforce the normal holder/session/house proof.

Remaining work before merge or installation: exact trusted clock admission and firing binding;
core stable-ref dedup and negative authorization tests; tick/CLI wiring; actual
process-kill crash tests against core; full integration and installed live proof.
This branch must remain draft until those pieces exist together.
