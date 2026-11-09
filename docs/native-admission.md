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
Full host termination and authenticated replacement are covered below. That
proof does not claim in-place adoption after an arbitrary supervisor restarts
only the host inside a still-running house namespace.

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

## Session read failures during acknowledged retirement

An acknowledged native stop is only permission to collect its files. A failed
filesystem read is not evidence that the session is empty. Both the local
retirement transaction and the shared house host retain the original session
and pending stop, retry collection, and avoid admitting replacement work until
collection succeeds. House retries do not repeat the native stop. Only the
explicit `SessionSizeError` preserves the documented over-6-MB fallback to an
empty continuity pack; other read failures cannot silently select that fallback.

The body-stop and retirement-commit regressions cover persistent read failure,
recovery of the original transcript, no empty slot receipt, and the explicit
size limit. These do not close the separate unexpected-house-host-exit gap:
auto-removed containers and stateless cleanup still require durable native
history collection before that cleanup can be considered safe.

## Native history preparation for unexpected house exits

`native-history.mjs` prepares an explicitly allocated house's dedicated native
history mount before constructing the existing runner. Native launch journals
use that mount too. Claude's actual CLI `jobs` and `projects` directories link
to it; changing just the collector's projects selector would not preserve the
CLI's writes. Codex's configured run and session paths link to it while keeping
the selected constructor paths. Existing nonempty directories or conflicting
links are refused without deleting their contents. Claude hooks/settings and
provider credentials remain in the original configuration home. Codex's made
homes, which can contain credentials, remain outside the history mount.

`native-history-collection.mjs` is a passive reader. After the box has established
physical house termination, it can make a private bounded plain-file snapshot
of only the named history directories. Links, special files, changed files and
limits fail without publishing a partial snapshot or deleting the source.
`offlineNativeSession` uses the existing adapter's `slotOf`/`sessionFiles` and
`packSession`; it cannot invoke a CLI, inspect host processes, start/resume a
model, stop a model or sweep credential homes. Missing native identity/history
remains uncertain. A collected body returns only its own native session files.

The box provisions this mount for newly claimed non-service houses and runs
collection before terminal reporting or cleanup. The explicit real-container
proof below covers host SIGKILL and fresh-controller resume with model-free
native executables. The code remains a draft until its other acceptance gates
are met.

## Box-authenticated core collection transaction

A box can explicitly negotiate `nativeHistory: 1` when claiming a non-service
house. That house cannot report terminal completion until `native-collection`
has finished. The separate positive `not-started` operation is for a box that
never entered container launch; it is refused after collection began or a
running house was reported. A box integration must track that actual boundary,
not infer it from a missing receipt.

Only the allocated box credential can open or upload a collection plan. An
agent's house token, an owner token, or another box cannot use this door. Opening
the plan requires the box's physical stopped/gone observation and freezes new
publication. The stable plan covers bound conversation bodies, live host bodies
and published requests that have no receipt yet. Legacy requests and missing
host metadata remain held for explicit reconciliation. Late host reports cannot
replace an offline collection plan.

Each body's upload fixes its native identity, session, content hash, part count
and input-confirmation disposition. Parts and completed packs are sealed through
the existing native session storage. A recovered published attempt uses the same
house launch receipt journal; an uncertain input stays uncertain. Only a
positive unstarted attempt may become a refusal. An empty or malformed offline
history cannot silently become an empty continuity slot.

Partial offline uploads and received packs are pinned against ordinary transfer
sweeps. Delivery remains pending while the original history is being collected,
and while a received pack has not been consumed into its conversation's durable
slot. A temporarily unavailable decryption key cannot convert it into an empty
slot after the house itself ends. Warming another house preserves the old plan
and receipts in its own draining record. Acknowledging the committed slot clears
the received pack and its pin.

The box-side client now provisions private per-house history before claiming,
requires the negotiated version, and verifies the host capability before
publishing work. Native adapters also refuse allocated houses without a history
mount before admission; an older box with a newer image cannot silently start
unbacked native work. House environment and secret selectors cannot override
this provisioning or mount an overlapping path.

After physical termination the client snapshots missing entries, recovers only
the matching native token or session through the existing adapters, and retries
immutable multipart uploads. Container PIDs are never interpreted as box PIDs.
A reserved/refused launch journal can establish that no admission happened; an
admitted journal without recoverable history remains held. Completion is
acknowledged and persisted in the box's ending receipt before normal cleanup.
Lost acknowledgements and box restarts retry this same transaction. The UI calls
this phase “saving conversation history.”

The live host also retains original native files until core acknowledges the
complete pack. Missing earlier parts cause an explicit transfer restart rather
than an acknowledgement of the last part alone. Offline collection adopts
already sealed live-host packs, covering a host exit after the final upload.
Unknown house metadata cannot prove termination, and delivery yields promptly
while the box is collecting history.

Tests cover both adapters' offline decoding, immutable multipart retries,
reserved and admitted attempts, existing core packs, missing metadata, and box
restart after lost part/final acknowledgements. These use model-free native
executables or a fake container engine; the separate integration proof below
uses real Podman. Explicit handling for admitted work with no native history,
older-house cutover reconciliation and deployed provider verification remain
required. The offline size-limit disposition is defined below. This draft is
not deployable.

## Final inbox receipts after host failure

Configured native inbox directories now link into the same private history
mount for both adapters. Offline collection reads only the selected body's
matching runtime metadata and pending/delivered records. It sends IDs, never
inbox text: replay uses delivery's existing sealed message copies. Missing,
malformed, partial, oversized or mismatched receipts remain unknown, which
conservatively replays all fed copies rather than trusting a stale empty host
report. A valid empty inbox is a distinct, positive receipt.

Live session packing captures the final inbox after native retirement. Its
receipt is sealed with the multipart transfer and native pack, so offline
collection can inherit both if the host dies after upload. Multipart retries
cannot change the selected pending IDs. Offline receipts stay available across
new controllers and draining-house handoff.

Common retirement waits for a pending offline receipt. Once collected, that
final receipt supersedes an earlier provisional live inbox snapshot before
committing the continuity slot and replay queue. Tests cover both adapters,
lost/invalid receipts, delivered-versus-pending replay through common delivery,
and replacement of a provisional snapshot during warm resume. The real-container
host-kill proof also carries one pending follow-up through native resume.

## Real-container host termination and native resume

Run the explicit integration test against an existing local house image:

```sh
LOOM_NATIVE_HOST_IMAGE=<local-house-image> node --test test/integration/native-host-death.mjs
```

This is outside the default unit suite because it requires real rootless Podman
and a local Node24 house image. It never pulls/builds an image or calls a model
provider. Its isolated native CLI fixtures use the actual ClaudeRunner and
CodexRunner, admission workers, body-host CLI, authenticated core API,
box-side collection client and fresh delivery CLI controllers.

Each case kills the first container with SIGKILL, positively observes that it is
gone, deletes its ephemeral HOME, collects only the retained native history,
then continues through a second house. The native fixture refuses a native
resume unless the original context has already been restored. Ordinary cases
check that same session; oversized cases check an explicit fresh continuation
under the shared digest fallback. Every case checks exactly one pending
follow-up and new turn, unchanged conversation principal, a new run/sender key,
and a reply posted from inside the new container.
Both owned containers must be positively absent after cleanup.

This test exposed a real negotiation failure: cleanReport stripped the host's
native-history capability, causing prepareLaunch to refuse fully provisioned
houses. The capability now survives the authenticated sanitizer, with a
regression that failed before the fix. A completed physical-stop collection is
also durable evidence after the last heartbeat expires; it forces the old body
ended even if a prior report called it working. The stale-heartbeat regression
failed before that correction too. These proofs cover real process/container
lifecycle and storage, not a provider model's semantic memory after a crash.

## Explicit session-size disposition and consumer acknowledgement

The existing native session budget is 6 MB. Local retirement, live house packing
and offline collection all use packSession and its SessionSizeError. Only that
typed exception permits omitting the native session and continuing from the
conversation's digests. An arbitrary read error or a missing transcript remains
uncertain and retains its history for retry.

Both live and offline transfers now name the omission as size-limit. It is
immutable across parts and sealed with the final receipt, native identity and
inbox IDs. A size-limit receipt contains no native files; an omitted session
with files or an unrecognized reason is refused. Offline collection can adopt
an already sealed live omission after host death. Lost part/final acknowledgements
reuse the committed receipt even if the original container HOME is gone.

HouseRunner raises the same SessionSizeError from that sealed receipt. Common
retirement reports that native context was too large, durably commits its
digest fallback and replay queue, then acknowledges the received pack. It never
creates an empty native continuity slot or labels the admitted work unstarted.
Real-container cases cover both ordinary resume and size-limit continuation for
both adapters after physical SIGKILL.

Consumption is a separate durable receipt. A consumer acknowledgement is saved
in the host journal before received files/pins are removed. Their absence alone
cannot release ownership or let pruning discard an unconsumed receipt. A
regression that deleted the files without acknowledging them failed before this
correction; it now retains ownership and yields an explicit unavailable-pack
error. A completed C retirement receipt can retry acknowledgement after a crash.

The independent whole-house snapshot budget remains 64 MB/10,000 entries. A
snapshot failure retains the original source and reports its resource/read
error; it is not treated as a session-size omission. Missing-history recovery
and legacy-house reconciliation remain separate acceptance work.
