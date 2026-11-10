# Shared continuation deadline protocol

> **Shipped state (2026-11-10, t-2004):** issuance is on, with the runtime service's `LOOM_RUNTIME_CONTINUATION_DAYS` (1-13, default 7); finished records are collected 7 days after their deadline; reviewed by three rounds plus a fresh independent read. Statements below that issuance is held or nothing is collected are dated checkpoints, superseded. Current behaviour: loom-box `docs/continuation-outbox.md`, "Lifetime policy and collection".


This is the staged contract for runtime148/core682/clock24. Runtime version2
sealed deadlines, core acceptance/fenced reconciliation, authenticated clock
inspection and completed native-interface admission checks are implemented and
tested. Production issuance deliberately refuses without a trusted policy; only
tests inject `continuationLifetimeMs` into internal delivery dependencies. No body
field or environment setting chooses it. The proposed 30-day maximum remains
inactive. There is no collector, storage bound, installed continuation proof or
actual provider/Podman continuation crash proof. Keep all three PRs drafts.

The checkpoint sections below are chronological evidence; later sections supersede
their statements about work still pending, without erasing their failures.

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

## Clock preflight and runtime runner boundary checkpoint

Clock scheduling now calls the local runtime principal bridge with the signed
issuer statement on stdin. Runtime requires the local clock context, verifies the
statement, checks its exact source conversation/agent/principal against the sealed
grant and current source snapshot, and returns its immutable deadline. Clock
requires scheduledAt < deadline, saves it beside the handle/wake, and checks again
before spool/timer commitment. Fire/replay drops expired, legacy or changed sealed
envelopes without posting. Core and runtime require the integer deadline in the
clock envelope; core includes it in delivery deduplication hashes.

Queued runtime operations recheck the sealed deadline equality, current source and
child principal, expiry/highwater and binding immediately before runner start or
resume, after asynchronous routing/model resolution. This is the runtime runner
boundary only. A remote runner can still await transport/host work before native
launch: its host must perform the admission recheck too, through the completed
native owner handoff. Do not claim that proof or enable production issuance.

Focused evidence includes signed inspection, forged/foreign/body refusal,
scheduled cutoff equality, sealed deadline mismatch, legacy/expired firing,
queued cutoff with no runner start, and changed deadline with no runner start.
The existing cross-repository benches are now explicit unresolved gates: production
holder issue correctly refuses without trusted policy, and the four core lost-receipt
benches still use historical fake time against real core cutoff. Adapt them through
a test-only trusted policy/time seam; do not enable policy in production or relax
cutoff. Runtime fenced reconciliation and actual SIGKILL crossing cutoff remain next.

## Actual cutoff crash proof (2026-11-09)

The opt-in core companion bench now SIGKILLs a runtime drain process after
adapter acceptance but before receipt, or before forwarding to core. A new
process beyond the shared cutoff sends only `reconcile`, with every other
payload field unchanged. Live/archive receipts become delivered; fenced
non-acceptance expires; deleted targets remain indeterminate through another
fresh-process lookup. The deletion crash also kills/restarts core between
message removal and cleanup completion. Database row counts verify no recreated
reply. Core fixture time is controlled only in its test process via parent IPC;
no production time or policy switch exists.

The clock companion bench retains actual managed production enqueue/status
executables, real encryption and authenticated core/clock routing. Production
issue is asserted to refuse the unconfigured deadline policy; only the trusted
test parent supplies a policy for its grant. Harness/managed delivery bridge
and stubbed systemd calls remain explicit test seams.

Five fresh-interpreter legacy tests read real age-encrypted old-schema fixtures
(unbound, bound, pending, attempted, delivered). None gains a deadline or makes
a network call. Pending expires, attempted stays indeterminate, delivered stays
delivered. This is durable schema-upgrade proof, not execution of a historical
runtime binary.

Native owner handoff is now complete at merged runtime145 fc786c5d97d278b3da95cee526551226166fefb0
(note:work/codex-native-history-live-18724473b3). Continuation integration still
needs to consume that completed interface and prove its own native launch path;
the companion fake runner cannot stand in for that proof. Production issuance,
collection, merge and installation remain held for this draft.

## Held acceptance review: claimed but unbound recovery (2026-11-09)

Reviewed runtime1ff61c2/corecd0713d/clock3ec64ba, with exact runtime all four
Node22/24 checks and core all seven checks successful; clock has no configured CI.
The final isolated-env runtime checkpoint is 1,039 tests: 1,030 pass, nine skip.
The inherited native-history broad run (26 failures), baseline duplicate-firing
regressions (two failures before the fix), and earlier failures remain evidence.

The durable firing claim is an admission reservation, not report authority. It
fixes wake/delivery/conversation/reset/target before native publication, is fsynced,
and has no release/reassignment or renewal route. A positively unstarted refusal
can retry the exact queued firing before cutoff. An uncertain start must first
use the launch journal's recovery/retirement path; it cannot treat a lost receipt
as a positive refusal or grant report authority to uncertain input. Owner hold
keeps the sealed queued firing and prevents replacement.

Five added acceptance checks exercise this distinction. Four actually SIGKILL a
separate interpreter immediately after `checkFiring` returns and before binding,
using real age-encrypted records. On reopening: exact recovery can bind/enqueue;
cutoff, source reset and child reset cannot. All retain issuedAt/expiresAt, reject
rescheduling/another firing, and grant no enqueue authority while unbound. The
fifth uses delivery/tick plus a fake native runner's explicit `nativeNotStarted`
refusal: claim stays unbound, a different firing starts nothing, and the exact
queued retry starts once and can enqueue. This is process-kill storage proof and
model-free runtime refusal proof, not a native host/provider process-kill test.
All five fail on unchanged pre-claim461be87 (missing durable firing claim);
all 65 combined focused tests pass after the fix. The first new refusal fixture
failed before household owner setup was added; that fixture failure is retained
in the run evidence, not treated as a production failure.

A claimed grant that cannot recover before cutoff remains sealed and unusable;
there is deliberately no automatic release or reassignment. A source holder may
issue a separate new grant, but it cannot adopt the old firing/run/report identity.
After an uncertain report attempt, reset/deletion is revocation, not proof of
non-acceptance: retain indeterminate state and prior evidence. No collector may
turn those rows into absence. Minimal claims, receipts, hashes, deletion journals
and unresolved legacy state remain retained without a storage bound.

Verdict: the checked model-free claim/refusal behavior satisfies the held draft
contract; it does not authorize policy activation. Remaining rollout acceptance
must include actual clock-to-native/provider continuation crash and retry with
both harnesses (or explicitly narrow supported scope), review of the immutable
lifetime choice and operational handling of stranded/indeterminate records, and
an explicit release decision. The 30-day value is a proposal, not a security
property established by these tests. Collection is separate work after disposition
and tombstone policy; this task implements no collector. No merge, install,
production policy change or t2006 change follows from this review.
