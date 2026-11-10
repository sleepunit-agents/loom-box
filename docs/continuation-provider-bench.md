# Actual provider continuation bench (held, opt-in)

Status (2026-11-10, t-2004): **stage 1 host-run green; stages 2-4 authored, not yet
host-executed.**

Stage 1 ran green on 2026-11-09 on this branch's earlier head `bedb109`, which carried the
*pre-review draft* of the follow-up code, with Codex `gpt-5.6-terra`, codex-cli 0.162.1,
image `localhost/loom-house-art@sha256:2de6f7dc…bfe5bf`, draft core `cd0713d` and draft
clock `3ec64ba`. It had 2 clock requests (identical sealed replay), 1 runtime admission,
1 native UUID and 1 core report row (loom note `work/2026-11-09-actual-provider-bench-green`).
Three bench defects were fixed to get there, none weakening an assertion: the native-history
mount dir is pre-created as production does; a cold body-host may answer deliver's documented
`queued`/`its body is still starting`, after which the recorded outcome must reach `started`
(exactly one outcome); and the run needs `umask 077` (core refuses group-writable homes). A
model the ChatGPT account doesn't offer (`gpt-5.5`) fails at the provider; that is a blocker,
not a pass.

Since then the reviewed code merged (loom-box#148 `c31d4ed`, core loom#716 `323766b`, clock
loom-clock#24 `077bc80`) and is deployed (loom `5214140`: runtime `407c463`, clock `d3ca90b`).
This branch now merges main, so the bench runs the merged runtime, and it pins the deployed
companions. **The 2026-11-09 green is therefore evidence about the draft, not about what is
deployed**; the next host run must repeat stage 1 on the merged code before any claim about
the deployed system rests on it.

Optional `CONTINUATION_DIAG_HOST_LOG`/`CONTINUATION_DIAG_DIR` copy host stderr and native run
records to private local paths on failure only; never put them in notes. Default invocation
still skips; a skip is not a pass. No production policy, collector, piece installation or PR
merge is part of this bench.

## What the bench claims, by stage

Codex only, one provider run. `test/integration/continuation-provider.mjs` starts a real clock
`fire` process against an authenticated companion core on loopback. Core's managed delivery
offer crosses an explicit test transport to runtime's real `deliver`, which uses HouseRunner
and a real Podman body-host running the actual Codex CLI. The provider's shell tool runs one
helper (`test/fixtures/continuation-provider-report.mjs`) with its own inherited holder key
and actual native UUID; the parent never borrows that key. The helper waits for the parent's
release file before each step.

1. **Clock crash/replay** (host-run green on the draft). A proxy withholds the first accepted
   clock receipt. The test SIGKILLs the clock process, reads its persisted wire body, restarts
   it, and requires identical replay with one runtime admission and one native UUID; the
   native session HouseRunner saw must equal the one the provider's own shell records. Only
   then does the provider enqueue its report (`pending`).
2. **Runtime-controller crash with lost report receipt** (authored). The controller's
   continuation drain (`drainContinuations`, the step of the service tick that posts reports)
   runs in its own process behind a proxy that lets the post reach core and withholds core's
   answer. That process is SIGKILLed: core holds one row, and the runtime doesn't know it. A
   fresh process, after the 2 s retry backoff, posts the identical sealed payload with the
   same stable ref exactly once; core deduplicates; still one row. The provider's own
   `continuation status` then reads `delivered`, and a further drain posts nothing.
3. **Cutoff** (authored). With the bridge's clock one minute past the sealed deadline, the
   provider's own next report is refused with `continuation expired`, and a drain past the
   deadline posts and reconciles nothing. The test clock reaches only the continuation route,
   copied field for field from `control.mjs`, because the production route takes no clock.
4. **Source reset** (authored). The source conversation's recorded reset changes, and the
   provider's next report, through the unchanged production `api()` route, is refused with
   `continuation source was reset or changed` (the binding recheck, before any clock check).
   Exactly one core row across all four stages.

The source holder is synthetic. Issuance uses the trusted test parent's explicit 24-hour test
lifetime, after the production executable, set out of range (`LOOM_RUNTIME_CONTINUATION_DAYS=0`),
refuses to issue. Principal handoff and house-token API transport are test bridges; core's clock
authentication, core deduplication, age sealing, HouseRunner native admission, body-host,
provider CLI, report enqueue/status and the controller's drain are real. Clock timer
installation commands are no-op fixture binaries; no installed timer is changed.

**Not claimed, even once stages 2-4 pass:** SIGKILL of the whole runtime service (only its drain
step is a separate process here); physical provider-host death or restoration; provider
execution exactly once; a *child* run reset (only the source's); a lost receipt that crosses the
cutoff with a real provider (the model-free `test/continuation-core.integration.test.mjs` covers
that with real core, for live, archived, deleted and never-accepted targets); Claude. Until stages
2-4 pass on loom's machine, the release claim for the actual-provider path stays the narrow one:
**clock crash/replay only, on the draft code**.

### Run risk for stages 2-4

The provider's one shell call now lasts for all four stages (about 10-20 s of bench work, plus
start-up). The prompt asks Codex for a timeout of at least 240000 ms. If the provider's shell tool
kills the helper early anyway, the run fails at a `provider <stage>` deadline: a blocker to record,
not a reason to split the helper or loosen an assertion.

## Inputs and execution boundary

Execution is exclusively by an approved local continuation, using a currently
available model account and existing local house image. Never pull/build an image,
install/update a piece, activate issuance policy or reach the installed loom API.
Do not run a provider in the authoring house. A missing prerequisite is a recorded
blocker, not permission to install or repurpose production state.

Required environment, supplied by the continuation (never by asking Jonathan to
type commands):

| Variable | Value |
| --- | --- |
| `CONTINUATION_PROVIDER_OPT_IN` | `actual-codex` |
| `CONTINUATION_CORE` | isolated built checkout of loom at `5214140963140b0e535f1ecc179b7c5ecbddb88a` (deployed) |
| `CONTINUATION_CLOCK` | isolated checkout of loom-clock at `d3ca90b2f96ee0354c0144ffebfe1b6b6ce2bb6d` (deployed) |
| `CONTINUATION_PROVIDER_IMAGE` | existing image pinned as `name@sha256:...` |
| `CONTINUATION_PROVIDER_CODEX` | actual absolute Codex binary path inside that image |
| `CONTINUATION_PROVIDER_MODEL` | explicitly selected supported Codex model |
| `CONTINUATION_PROVIDER_AUTH` | approved existing Codex auth.json, copied privately, never printed |

Run `node --test test/integration/continuation-provider.mjs` from the isolated
runtime checkout under an external `timeout 300s` and `umask 077`. Required companion built
modules and age tools must already be available; reuse existing dependency
artifacts only. Do not install packages to make this check work under this scope.

All writable runtime/core/clock state lives beneath test-owned temporary roots.
Only the runtime source checkout is mounted read-only into the container. The
existing auth file is copied into a mode-0600 private fixture HOME, never edited
in place. The container gets a fixture house token and a fresh native-history
root, no installed loom credentials. Its name belongs to this test. Cleanup must
positively remove that container before the test process's scratch cleanup;
a failed removal is a test failure, never a successful proof. Outer interruption
must also check for this owned container. Do not delete any unrelated container.
Provider account refresh in the copied login does not update the real login.

## Acceptance and evidence

Keep full test output and exit code as a loom evidence note, including any failed
attempts and corrections. Keep the exact bench commit, companion SHAs, image
digest, provider CLI version, model, native UUID and counts. No credentials,
provider transcripts, report handle or holder key goes into notes. A timeout,
provider refusal, missing tool execution or CLI mismatch is failure/blocker, not
an excuse to substitute a model-free runner. The default skip and syntax check
only prove the opt-in boundary and parser acceptance.

The structured line now also records the controller's post count (2: the killed one and its
retry) and the cutoff and reset refusal words. Stages 2-4 count only once a host run passes all
four in one run; a pass of stage 1 alone is still a clock-replay claim. Claude remains
unsupported by this actual-provider bench until its equivalent route is measured.

## Lifetime and disposition review (2026-11-10, against main `407c463`)

The table this section used to hold described the held draft: lifetime inactive, no
collection, unbounded storage. That is no longer the code. What merged (#148) and is deployed:

| State | What the merged code does | Test on main |
| --- | --- | --- |
| issued, unclaimed | exact wake only, before the deadline; no renewal. Lifetime from the runtime service's `LOOM_RUNTIME_CONTINUATION_DAYS` (1-13, default 7), written to `continuation-policy.json` by the service tick only; out of range refuses issuance. At most 20 live per source conversation | holder: policy tests; outbox: bounded live |
| claimed, unbound | same firing retry only; the bound child's own conversation may restart on the same firing with no new authority | claim integration; outbox: requeue restart |
| bound, zero attempts | exact child's report before the deadline, at most 20 per continuation; reset or deadline refuses | outbox; this bench stages 3-4 |
| attempted, receipt unknown | `indeterminate`; after the deadline, only fenced `reconcile` (never a repost), with backoff | outbox: lost receipt; core integration (real core) |
| core clock rollback | core answers 503; report stays `pending` and posts later | outbox: 503 hold |
| delivered (late or not) | final; moved to `done/`; never reopened by drain | outbox; this bench stage 2 |
| target deleted | reconciliation ends `withdrawn` (final); core's tombstone refuses any later post | core integration: delete, delete-crash |
| unreadable record | set aside in `unreadable/`, said once; no grant is collected while any is there | outbox |
| legacy (no deadline) | held, never given a deadline, never collected | outbox: legacy |
| collection | hourly at most: final reports and grants no report still names, `LOOM_RUNTIME_CONTINUATION_KEEP_DAYS` (1-90, default 7) after the deadline; pending/indeterminate rows and their grants are kept until resolved | outbox: collection |

Review verdict: **the lifetime and disposition are settled in code and tested model-free;
nothing here needs a new policy.** Storage is bounded except for three deliberate holds: legacy
records, unresolved (`indeterminate`) reports, and anything in `unreadable/`. Each is kept on
purpose, because deleting it would turn "unknown" into "didn't happen". They are small and
countable; whether to add a count to the runtime's status page is a follow-up, not a blocker.

Still open, tracked rather than fixed (from the merge reviews, t-2004): a sub-second race between
a reset and a post (review #6); a cross-process race between a thread delete and a post (#7);
multi-owner principal equality (#10); after a crash, `status` can show an older state until the
next drain. On the deployed system: the clock can't find `loom-runtime` when a house sets a
follow-up (t-2095), the house image's `loom runtime` predates #148, and one house body saw another
conversation's `LOOM_BODY_CONVERSATION` (same family as t-2053/t-2061). None of these is closed by
this bench; the deployed end-to-end proof (one real report into a held thread) waits on t-2095.
