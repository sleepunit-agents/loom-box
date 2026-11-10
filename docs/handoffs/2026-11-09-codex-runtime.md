# Codex runtime handoff — November 9, 2026

Jonathan ended this session and requested a handoff. **Stop this thread's work.**
Box administration grew into a separate project; it is deferred, not a remaining
condition for declaring the ordinary Codex runtime fixes useful. Do not resume
administration automatically under the Codex parity goal.

## Deployed Codex work

- Native admission/history recovery merged in [runtime PR 145](https://github.com/sleepunit-agents/loom-box/pull/145),
  merge `fc786c5d97d278b3da95cee526551226166fefb0`.
  Durable launch ownership, native history collection, lost receipts, physical
  stop barriers and legacy-house transition handling are implemented.
- A real Codex process was killed with SIGKILL, resumed the same native session,
  recalled its prior seed and delivered its reply. Evidence:
  loom note `work/codex-native-history-live-18724473b3` and
  `/home/art/scratch/codex-native-history-proof-18724473b3-final.json`.
  An additional raw exec check failed and remains recorded; it is not counted
  as a success. The diagnostic briefly used dispatch-only capacity exceptions;
  saved guest limits and pre-existing conversation holds were preserved.
- Local Clock wakes now use the shared runtime even with legacy session/spawn
  settings. [Clock PR 25](https://github.com/sleepunit-agents/loom-clock/pull/25)
  merged and installed at `8a67bfd22fa5024aac31f99d27c8402d1d44c1e9`.
  Installed-binary loopback smoke passed; production schedules were not added.

At handoff, installed runtime is
`dd48237e9e1b762575fa2bf03a7637b2d60328e7`, main's venue-status PR 150,
which is one commit ahead of and contains the native-admission merge above.
Runtime run, runtime delivery and Clock run services were all checked active.
Administration code below is **not installed**.

## Remaining primary work

- `t-2004`: separately owned continuation/outbox work remains in drafts, with
  production lifetime/retention acceptance and actual provider verification
  still held in the latest task record. Consult that task and its own evidence;
  do not merge or deploy it based on this handoff.
- `t-1998` / `t-535`: finish auditing legacy manual launch helpers, notably
  `Art/bin/art-directed-admit`, `Art/bin/art-handoff-inbox-poll`, and the
  intentional isolated grader in `Art/bin/landscape blind`. The first two have
  no installed service/timer here but remain manually reachable. Preserve
  ledger/acknowledgement behavior when migrating or explicitly retiring them.
- `t-1986`: broader guard/options/detail parity remains tracked separately.
- `t-1743`: actual week-long soak cannot be replaced by test counts. Its recorded
  earliest completion is November 16, with failure/duplicate/continuity review.

## Deferred administration project

Task `t-1997`, priority 3, retained as a separately deferred project.

| Repository | Branch / PR | Implementation head |
| --- | --- | --- |
| loom-box | `design/scoped-box-administration`, [draft 144](https://github.com/sleepunit-agents/loom-box/pull/144) | `da763323cfbb828d7f0a152897f028706e456882` |
| loom-approvals | `fix/scoped-administration-approvals`, [draft 16](https://github.com/sleepunit-agents/loom-approvals/pull/16) | `a3e082b46ccae4ed45a8d65543c6b64eee17ed2f` |

Worktrees:

- `/home/art/Code/loom-box-wt-administration`
- `/home/art/Code/loom-approvals-wt-administration`

Both implementation heads are pushed. The runtime implementation head has all
four Node 22/24 CI checks green. This handoff is a subsequent documentation-only
commit. Integrate current main before resuming: the administration branch does
not include main's later venue-status change. Do not rebase or force-push.

Implemented: immutable scopes and native caller proof, durable approval
activation, owner revocation UI, sealed claims/results, authenticated box RPC,
worker-bound admission, systemd containment, ordinary/root provisioning through
the normal box loop, and result acknowledgement recovery after restart.
Credentials stay in the parent; commands get no valid native body key.

Still required: shared body CLI/MCP request/status/execute/result/finish tools,
actual authenticated owner-app approval and both native harnesses, review,
compatible dependency/agent pins, exact-head release checks and supported
installation. No production approval was answered, no sudo policy broadened,
and no production administration capability deployed. Automatic receipt
retention cleanup is not enabled.

## Verification and limits

- Full local run: **1,024 passed, zero failures/skips**:
  `/home/art/scratch/admin57-full-final.log`.
- Final isolated real-systemd matrix: **21 passed**, including normal runner/root
  provisioning, two uploads with one command effect after daemon restart,
  worker/gate SIGKILL, descendant cleanup and actual running lease expiry:
  `/home/art/scratch/admin57-real-isolated-final.log`.
- Loaded concurrent matrix: **20 passed, one positive-path startup refusal**:
  `/home/art/scratch/admin57-real-context-final.log`. Retain this evidence;
  do not describe it as green or widen leases/assertions to hide it.
- Initial full run: 1,021 passed and two shutdown-fixture failures. Those HTTP
  fixtures were synchronous; awaiting the asynchronous API fixed them.
  Targeted shutdown/control/box checks then passed 41/41.
- Approval dependency: 120 Python tests and isolated CLI smoke passed.

Detailed checkpoints are loom notes `work/codex-runtime-checkpoint45` through
`work/codex-runtime-checkpoint57`. Earlier failure artifacts remain in scratch.
User/root failed transient fixture units were reset only after verifying their
exact source, failed state, zero MainPID and transient status; active units were
not touched. Root fixture journals may remain in their isolated hashed
namespaces under `/var/lib/loom-runtime-administration`; they are not production
jobs and must not be confused with enrolled production namespaces.

## Workspace boundaries

Preserve live Art's unrelated untracked files:
`.taskstore/store.export.jsonl.287806.tmp` and `VOICE-OFF`.
The live Art checkout was not used for implementation. Do not disturb other
owners' continuation, job-card or release branches. Do not create new timers,
restart tests whose observation merely timed out, or claim overall parity from
the administration fixtures. The next session should first reconfirm scope
with Jonathan rather than continue this adjacent project by inertia.
