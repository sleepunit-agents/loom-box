# Actual provider continuation bench (held, opt-in)

Status: authored and syntax checked, **not host executed**. This adds no provider
proof until the opt-in test passes on its exact commit. Default invocation skips;
a skip is not a pass. No production policy, collector, piece installation or PR
merge is part of this bench.

## Supported claim

Codex only. `test/integration/continuation-provider.mjs` starts a real clock `fire`
process against an authenticated companion core on loopback. Core's managed
delivery offer crosses an explicit test transport to runtime's real `deliver`,
which uses HouseRunner and a real Podman body-host running the actual Codex CLI.
The provider's shell tool runs a small report helper with its own inherited
holder key and actual native UUID. The parent never borrows that key to enqueue.

A proxy withholds the first accepted clock receipt. The test SIGKILLs the actual
clock process, reads its persisted wire body, restarts it, and requires identical
replay with one runtime admission and one native UUID. Only after replay does it
release the provider's shell helper to enqueue. Runtime tick sends to the actual
companion core; its SQLite store must contain exactly one continuation report.
The native session observed by HouseRunner must equal the session recorded by
the provider's own shell. Structured output records model, image and UUID, not
credentials or transcript content.

The source holder is synthetic; issuance uses the trusted test parent's explicit
24-hour test lifetime. Actual managed CLI issuance must still refuse production's
missing policy. Principal handoff and house-token API transport are test bridges;
core's clock authentication, core deduplication, age sealing, HouseRunner native
admission, body-host, provider CLI and report enqueue are real. Clock timer
installation commands are no-op fixture binaries; no installed timer is changed.

This is a clock crash/replay bench. It does **not** establish runtime-controller
SIGKILL recovery, physical provider-host death/restoration, provider execution
exactly once, Claude support, or bounded retention. The separate model-free native
and actual-owner-provider proofs do not fill those gaps. Add independent cases
before widening the release claim.

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
| `CONTINUATION_CORE` | isolated built checkout at `cd0713deefe2d819b7325cf7c75b8148e69f0c27` |
| `CONTINUATION_CLOCK` | isolated checkout at `3ec64bace24c2f03bd58b86ac2c6acee16c4b1ef` |
| `CONTINUATION_PROVIDER_IMAGE` | existing image pinned as `name@sha256:...` |
| `CONTINUATION_PROVIDER_CODEX` | actual absolute Codex binary path inside that image |
| `CONTINUATION_PROVIDER_MODEL` | explicitly selected supported Codex model |
| `CONTINUATION_PROVIDER_AUTH` | approved existing Codex auth.json, copied privately, never printed |

Run `node --test test/integration/continuation-provider.mjs` from the isolated
runtime checkout under an external `timeout 300s`. Required companion built
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

Before a release decision, extend the bench to runtime-controller publication
crash/retry, lost report receipt, source/child reset and cutoff, or explicitly
narrow supported production behavior. Review stranded claims and uncertain
reports with actual evidence. Claude remains unsupported by this actual-provider
bench until its equivalent route is measured.

## Operational lifetime disposition (held)

| State | Permitted operation | Retention/release status |
| --- | --- | --- |
| issued, unclaimed | original exact wake before cutoff | no renewal; retain sealed record |
| claimed, unbound | same firing retry only, with positive unstarted/recovery evidence | no replacement, release or reassignment |
| native launch uncertain | native journal recovery or owner hold | never classify as positively unstarted |
| bound, zero report attempts | exact child's report before cutoff | reset/cutoff revokes authority, retain evidence |
| attempted, receipt unknown | exact fenced reconciliation only after cutoff | indeterminate retained, no repost or collection |
| late delivered | original core receipt | retain receipt/hash commitments |
| target deleted/reset | refuse new delivery; preserve prior uncertainty | retain tombstone/journal; revocation is not non-delivery |
| legacy missing deadline | fail closed without implicit renewal | retained indefinitely pending separate disposition |

These are accepted fail-closed behaviors in the held draft, not operational
release approval. Storage remains unbounded. The proposed 30-day lifetime is
inactive; no cleanup/GC policy is approved. Final disposition and release review
remain open until actual-provider proof and the explicitly supported crash scope
are settled. All historical test failures remain in predecessor evidence notes.
