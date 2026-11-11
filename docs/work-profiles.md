# Per-job work profiles — draft, rollout held

Runtime selects a declaration from the runtime-owned JSON file named by
`LOOM_RUNTIME_JOB_PROFILES`. The format is `{ "v": 1, "jobs": { KEY: PROFILE } }`.
KEY is JSON.stringify([agent, venue, kind, place-or-null]); it comes from runtime
metadata, never prompt text. Thus lanes, individual scheduled jobs, and conversation
kinds can have different declarations. Each PROFILE explicitly contains:

```json
{"v":1,"mcp":["loom"],"tools":["Read","Bash"],"skills":[],"secrets":["mcp.loom","LOOM_URL","LOOM_TOKEN_FILE"]}
```

`mcp` names complete servers and authorizes their tools; `tools` names individual
harness built-in tools, never `default`. `skills` names skills. `secrets` names `mcp.SERVER` for each configured server credential bundle, and
environment variables already supplied by the secret injector; declarations do not
grant access at the secrets piece. Harness launch controls cannot be secrets.
Provider subscription logins remain infrastructure, not job secrets. HOME/PATH and
ordinary process identity are infrastructure. This is harness/prompt configuration,
not filesystem isolation from a malicious shell. Jobs needing stronger boundaries
must run in separately provisioned houses with appropriately scoped secrets.

Every job and conversation kind selects a profile. Missing stores/declarations and
invalid declarations select an empty minimal profile plus a visible `JOB PROFILE
PROBLEM` in the body brief. There is no global allowlist and no `off` override.
A declared but unavailable capability refuses startup rather than silently omitting
it. Requests carry the validated declaration to the house; both launch paths require
`job-profile-v1` before publication. Old hosts receive no profiled work.

Claude uses strict explicit MCP configuration, an explicit built-in tool list,
settings deny rules, safe mode and disabled slash commands. Inherited environment
secrets are removed. Named skills are currently **refused**: local executable
probing shows safe mode still advertises built-in skills and does not load the
explicit plugin's skill. Codex profiled jobs are also **refused** until its complete
built-in tool and skill discovery adapters are verified. Profiled Claude resumes
are refused because old histories can retain capabilities and prompt snapshots.
These are rollout blockers, not completed support for the requested contract.
No optional work-identity/core API is required or claimed by this runtime change.

## Owner-approved permanent amendments

`profile-amendment.mjs` is the runtime half of the approvals integration:
`requestAmendment` sends a deterministic grant target tied to the job, current
profile hash and single capability; the approvals adapter must deduplicate pending,
allowed and denied requests for that target. `commitAmendment` is an owner-executor
library, never a body-facing endpoint. It checks the exact target, compare-and-swaps
the prior profile, serializes writers and durably replaces the store. Replayed
callbacks are idempotent. A changed profile needs a new approval. A crash-held lock
requires operator recovery; never silently steal it.

Required separate approvals change before rollout: register grant namespace
`runtime-job-profile`, authenticate the requesting running job and derive its key
and current declaration server-side (ignore caller-supplied key/profile), retain the
exact amendment with the card, deduplicate its target including Deny, and on Allow
invoke `commitAmendment` in the trusted owner executor with that stored amendment.
Never expose a general apply endpoint or accept an approval boolean from a body.
Record completion durably and retry the same callback after crashes. Reject grant
callbacks whose target/payload differs, whose requester job is unproved, or whose
profile revision is stale. Tests: concurrent identical requests produce one card;
Deny never mutates; Allow survives restart and affects the next launch; stale and
cross-job payloads cannot amend another job; replay after write-before-ack is safe.
This adapter is not installed by the runtime PR, so ask-once is not end-to-end yet.

Rollout remains HOLD until named-skill support, Codex isolation, profile-bound
continuation, and that approvals adapter pass independent review. Do not enable
scheduled rollout or update hosts from this draft.
