# Continuation report delivery (draft integration)

The runtime issues an opaque capability only after the current holder proves its
agent, key, session and house through the existing holderProblem boundary. The
source snapshot comes from runtime state: principal, reset generation and fixed
venue/place. Unknown principals are refused. Display-only originConversation
links and historical wakes confer no authority; those need authenticated adoption.

The clock stores the opaque handle on its created wake. Core accepts this field
only from the authenticated clock. Runtime seals the exact firing and retains
an admission snapshot only after successfully starting/resuming the child.
Queued wakes and warm feeds grant nothing. Enqueue/status recover a binding from
that sealed admission, so a runtime crash before binding is recoverable. There
is no body-callable bind route, and a grant cannot bind a second firing or child.

The child proves its own current holder to enqueue/read receipts. A report id
with different text is a conflict. The child supplies no target or snapshot.
`loom runtime continuation issue` returns a handle; `enqueue --handle cont-…
--id final` reads text from stdin (or `--text`); `status --handle cont-… --id final`
returns pending, delivered or failed. Each takes `--conversation cv-…` or uses
its body's current conversation. The CLI carries its key and harness session in
the authenticated API body, never in argv. HTTP holder refusals remain failures.

The delivery tick drains the sealed outbox. Immediately before each attempt it
checks source and child principal/reset/target, and the exact child run. A new
source holder is allowed. Each post uses its stable runtime-generated ref, fixed
target, bound child run and enqueue-time harness annotation (`on`, when switched).
It never borrows the source holder's key. All payload fields stay stable across
retries, even if the source changes holder or the child switches harness.

Only core's adapter is enabled: other adapters lack the required idempotency
contract and fail permanently without executing their send command. Core's
companion PR675 binds ref to agent/place/text/run/normalized on in one transaction
with the encrypted reply. An exact retry returns the original sequence; another
payload receives HTTP409. A confirmed nonempty core receipt is delivered;
accepted/pending alone is not. HTTP4xx are permanent except 408/425/429; transport
loss and 5xx retry. Explicit permanent adapter refusals also stop.

Every outbox mutation seals its record, fsyncs a private temporary file, renames
it and fsyncs its directory. The next retry time is persisted before network I/O.
A SIGKILL after acceptance leaves pending state and retries the identical ref.
There is no automatic collection or expiry yet; the retention review below is
a shipping gate, not an implemented collector.

## Evidence and remaining gates

Focused tests cover holder/session/house proof, admission binding, warm-feed and
rebind rejection, reset changes, exact payload stability, error classification,
CLI forwarding and actual tick delivery. The tick regression fails on ac8f31d
with zero posts instead of one.

For the cross-repository crash bench, build companion core PR675, then run:

```
CONTINUATION_CORE=/path/to/loom node --test test/continuation-core.integration.test.mjs
```

It uses the actual core HTTP auth/adapter/database and two fresh runtime drain
processes. A proxy withholds the first receipt after core commits, the first
runtime receives SIGKILL, and the restarted runtime recovers the original receipt
with one stored reply. Borrowed session and reset-after-queue negatives cannot
reach that HTTP adapter. It uses a fake harness and test sealer, and does not
exercise the actual clock process or core-to-runtime piece dispatch. Without the
companion checkout the test explicitly skips.

The clock route bench additionally runs the real clock `fire` CLI, its spool and
principal handover subprocess, core's managed delivery offer and agent piece API,
the production holder API, real age sealing, delivery tick and core receipt:

```
CONTINUATION_CORE=/path/to/loom CONTINUATION_CLOCK=/path/to/loom-clock \
  node --test test/continuation-clock.integration.test.mjs
```

It kills the real clock process after core accepts but before the receipt returns.
The fresh clock recovers its persisted firing, posts identical JSON, and core replay
avoids a second child. It also proves non-clock credentials and a supplied
source field are refused before forwarding, and forged handles, borrowed holder
keys/sessions, rebinding and source reset cannot produce another stored reply.
A forged handle can launch an ordinary wake; it cannot authorize a report.
Holder issue/enqueue/status now execute the production `src/cli.mjs api --json`
in a fresh process launched through core's managed bin. The HTTP bridge rejects
API calls, so the bench cannot silently substitute its in-process handler.
The fake harness and delivery/principal bridge remain explicit test seams;
no installed runner, native harness or installed end-to-end proof is claimed.
Timer creation is stubbed so this bench never installs host systemd units.

All three PRs remain draft (runtime148, core675, clock24). Before merge/install:
prove the complete authenticated clock→core→runtime route and its negatives,
with the native harness and executable instead of the test bridge; complete exact-head CI and resolve
core's exact-head CI failures while preserving the history owner; review collection/expiry; then
coordinate installation and live delivery proof. Preserve PR145 native admission
ownership. No installed or historical-thread delivery is claimed here.

## Retention review

The runtime currently keeps sealed grants and every pending/delivered/failed report
indefinitely. A grant has an issuance time but no deadline, and a still-bound child
may enqueue multiple distinct report ids. Reset/principal/target/child-run checks
remain the revocation boundary. Slot expiry is not capability expiry. This keeps
long scheduled continuations valid, but storage and authority lifetime are unbounded;
do not describe the current implementation as having retention limits.

Core keeps the stable ref and payload hash with the encrypted reply rather than
in its ordinary short-lived turn idempotency cache. Archival keeps that receipt.
Explicit thread deletion commits its deleted-thread tombstone before removing the
reply/hash. A durable cleanup journal in the same transaction as the tombstone and
thread removal is replayed by core's startup/minute sweep. Deleted targets reject
exact retries even while cleanup still has the old receipt. Archival preserves
receipts. This is deletion recovery, not a receipt GC scheme.

The actual-core bench now kills the runtime after acceptance, sweeps words beyond
14 days, and retries in a fresh runtime roughly three months later. Live and
archived targets return the original receipt with one reply row; deleted targets
remain failed across another runtime restart. A fourth case SIGKILLs core during
deletion, restarts core, and verifies its tombstone survives, cleanup finishes and
the retry cannot recreate a reply. This case FAILS against core2b6bbf1: deleting
messages before committing the tombstone loses dedup and the retry gets a new
accepted receipt. The companion core repair journals revocation before cleanup.
Test seams remain the fake native harness/test sealer described above; no installed
native proof or bounded retention implementation is implied.

Before introducing collection, agree the maximum admission/enqueue/retry lifetime
together across clock, runtime and core. Never prune pending reports by age alone:
a lost receipt may already represent an accepted post. Removing a terminal report
while its grant can still enqueue the same id also destroys local payload-conflict
detection. Removing a core ref while retries can reach a live target permits a
duplicate reply. A bounded design needs durable terminal/expired tombstones and a
common retry cutoff, plus deletion/reset tests and a delayed-retry crash proof.

This review makes no destructive change. Keep expiry/collection open for the
coordinated shipping review; native admission and history owners still own their
respective gates.

### Bounded retention acceptance plan (still held)

A collector cannot be added independently. The review must settle one persisted
absolute authority deadline for issue, clock admission, enqueue and retry; expose
it to the issuer so a wake beyond it is refused when scheduled. Repeating a firing
or restarting a process cannot extend it. Existing no-deadline grants must be
explicitly expired or adopted by their authenticated issuer, never silently given
a fresh lifetime during upgrade. No body may choose or extend its own deadline.

Core must enforce that same sealed deadline before accepting a new stable ref,
including a request delayed in flight past cutoff. Keep deadline in the payload
hash. An expired pending report whose receipt may have been lost is unresolved,
not known undelivered: retain its stable ref and surface an indeterminate outcome
until reconciliation. Tombstones must block reuse of an expired grant/report id;
collection may remove plaintext only after authority is irrevocably terminal.
Core receipt/hash collection must wait until no accepted retry can reach that ref.

Required tests before choosing collection: exact cutoff on all paths, lost receipt
then deadline crossing, core network delay beyond cutoff, deadline rollback and
fresh-process replay, reset/deletion at each cleanup boundary, expired-grant
reissue attempts, and payload conflict after terminal payload collection. The
current grant/report set remains sealed and uncollected until those checks and
review pass. The deletion journal above repairs explicit deletion only.

The next proposed wire/state contract is [Shared continuation deadline protocol](continuation-deadline.md). It specifies core-serialized lost-receipt reconciliation, immutable version2 deadlines, fail-closed legacy grants and deferred collection. This is design only, pending implementation and adversarial review. Exact core f9b1c3d Node22 CI failed the existing live SSE latency assertion (581ms against400ms); Node24 passed. Earlier local deadline failures remain evidence; no broad-green claim.
