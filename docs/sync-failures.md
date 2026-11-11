# A house whose sync fails

`oversized: declared 1048673 bytes exceeds cap 1048576` is an HTTP **request**
rejection. Core emits it from `src/transport/http-server.ts`'s `pieceCall`, before
calling the runtime. It does not describe an oversized sync reply or require a
core change. The reply carries start requests (briefs and resume files), stop
requests, follow-up inbox messages and acknowledgements; it carries no history
of tool steps. Tool cards, finals, native session parts and pending-inbox
receipts travel the other way, in the host's report.

The exact report from the stopped house in t-2163 was not retained with the
brief, so its offending field cannot be identified conclusively here. Before
runtime commit 77cbf03 (t-2109), reports sent every queued session part at once,
all finals and up to 100 cards per body without a shared byte budget. Three
360 KiB parts alone exceed core's cap. That commit budgets cards, finals and
session data, but did not include the pending-inbox receipts repeated beside
each session part. A valid list of 10,000 64-character IDs plus a full part can
still exceed the cap. Receipts now travel inside the session transfer, split
across its existing parts, with their complete contents preserved. The final
HTTP envelope, including the key, is measured in UTF-8 and refused locally above
1,024,000 bytes. Unexpected oversized metadata becomes a visible fault rather
than a stream of doomed HTTP requests; it is never silently dropped.

Every consecutive sync failure backs off: 2, 4, 8, 16, 32, 64, 128, 256 seconds,
then five minutes. A successful sync resets the sequence. Alternating timeout
and size errors share the sequence, so changing error text cannot defeat it.
After five failures, the host posts a small `body-health` report independently
of the full sync. The host's own key authenticates it; a body's run key or house
token alone cannot. Only a failure count and fixed category are persisted, never
raw exception text. The runtime's agent manifest reports `broken` with a reason,
which core displays in the agent card's Problems. A successful full sync clears
it. Health reporting is retried at the same backoff cadence; if loom cannot be
reached at all, the host can only log that reporting failed until it returns.
A lost first key-exchange answer can still be reported with the boot key, which
remains a health-only credential and cannot replay a sync or start work.

An empty house should exit after ten minutes without work, as it already does
on successful sync. Failures now run that check too (at the next retry, at most
five minutes later). It never abandons a known body, an uncertain launch, a
completion receipt or a native session awaiting collection because of a network
failure. The next delivery can request a fresh house.

## Rollout

Merge the runtime PR, then update the runtime pin in loom's piece catalog to the
merged commit and install it with `loom pieces update runtime`. No core source
change is needed. The controller advertises `packedReceipts: true`; a new host
uses the new envelope only after seeing that capability. Old hosts retain their
old transfer format and old failure loop. Update the boxes' runtime and rebuild
house images with the new runtime pin so newly started hosts have this fix;
existing hosts must drain or be collected through the normal house lifecycle.
Do not restart an occupied house to apply it. Deploy the controller before new
house images; new hosts talking to an old controller preserve the old format.

Focused coverage is in `test/sync-failures.test.mjs`, including a real
host/controller collection of 10,000 large Unicode receipts, a lost part
acknowledgement, exact receipt and transcript recovery, and the final-file
retention rule. Existing `steps`, `body-stop`, `body-usage`, `taskclient`, `serve`
and delivery tests cover the adjacent report budgets and lifecycle.
