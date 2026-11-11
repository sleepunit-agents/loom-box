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

Every Claude job and conversation kind selects a profile. Missing stores/declarations and
invalid declarations select an empty minimal profile plus a visible `JOB PROFILE
PROBLEM` in the body brief. There is no global allowlist and no `off` override.
A declared but unavailable capability refuses startup rather than silently omitting
it. Requests carry the validated declaration to the house; both launch paths require
`job-profile-v1` before publication. Old hosts receive no profiled work.

Claude uses strict explicit MCP configuration, an explicit built-in tool list,
settings deny rules, safe mode and disabled slash commands. Custom configuration
directories survive selection so their denies and disabled servers remain effective.
Named skills are preloaded through `--append-system-prompt`: only their selected
SKILL.md text is included, with discovery and Skill invocation disabled. Relative
references in those skills still require declared file tools. Continuations render
fresh system instructions with `--system-prompt-snapshot off`, and apply the selected
profile again. Prior runtime denies remain unioned across continuation, including
slot-only continuations recovered from the runtime records. An unrecognized slot
gets a visible minimal-profile fallback because its prior restriction floor is unknown.
`Skill` itself is unsupported under this adapter; declaring it selects a visible
minimal fallback rather than silently losing a declared tool. Named skills use
the explicit preloading path above.

The runtime sets `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`: background requests otherwise
advertise the provider advisor despite `--tools`. Native request traces can also
contain `DeferredToolPlaceholder` (provider schema placeholder) and `EndConversation`
(background lifecycle control). They are not MCP, shell, file or secret access;
the executable test explicitly distinguishes these intrinsic harness controls.

Codex profiled jobs fail closed with the visible reason "work profiles don't support
Codex yet". Codex profile support is outside this PR; null owns that follow-up.
Codex jobs without a matching declaration retain their existing environment and
brief through the public start and resume paths, including legacy continuations.
An unreadable or malformed configured store remains fail-closed; a previously
profiled history cannot become unprofiled when its declaration is removed.
No optional work-identity/core API is required or claimed by this runtime change.

## Owner-approved permanent amendments

A running owner job asks for a missing capability with
`loom runtime profile request --field tools --name Read` (fields: mcp, tools,
skills, secrets). Its shell supplies its own conversation proof; callers cannot
choose another job key, profile, or revision. The runtime checks the active body,
its owner principal and house, derives its key and original declaration, and
rejects a stale revision before filing anything. An MCP addition includes its
explicit `mcp.SERVER` credential declaration on the same card. The card lists
every added declaration, including that credential bundle.

The runtime publishes the canonical amendment privately before requesting a
`grant` target `runtime-job-profile:SHA256`. The companion approvals change
retains one answer per job/revision/capability, including Deny, and only accepts
these requests from the trusted runtime. On Allow, core's existing grant callback
reaches the runtime's owner-only `grant-approved` executor. It loads the stored
amendment, checks the requesting agent and exact target, spends the exact approval,
and durably compare-and-swaps the profile. The trusted spend and write are
idempotent so retries after either crash boundary do not ask again or widen access.
There is no body-facing apply endpoint. A changed profile needs a fresh request.
A kernel file lock serializes writers and is released automatically on process death. Hosts without flock refuse the callback visibly.

The companion approvals adapter must ship together with this runtime change.
Tests exercise actual temporary approvals stores, concurrent request deduplication,
Deny, owner Allow, cross-job rejection, replay, and fresh next-launch selection.
The background executable test uses the actual Claude --bg runner through both
house admission paths and a narrowed continuation; it is opt-in because it spends
model calls. Its host transport is in-process; it does not prove a deployed image.

Rollout awaits independent clearance and green checks. The source deny and disabled-server
floor is saved before native admission, retained with the native session (including
forked session ids), and packed with its continuity history. A different config
directory or house unions the old floor with its current sources. Unknown floors
remain visibly minimal on later continuations. Invalid transported declarations
also launch minimal access with a visible diagnostic and no inherited job secrets.
Install the companion approvals piece before runtime: runtime uses its new trusted
profile-grant request and replay semantics. Do not enable scheduled rollout or
update hosts until the coordinator clears the reviewed heads.
