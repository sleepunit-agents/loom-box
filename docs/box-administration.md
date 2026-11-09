# Scoped work on a box

Implementation plan for t-1997. This is a design, not an installed capability.

A body can need to repair its host while its ordinary house cannot reach it.
The owner approves completing named work on one box. That approval enables
runtime commands there without another model or a series of command approvals.
An Allow must enable the work itself; the owner never receives terminal commands
to finish granting access.

## Contract

The shared runtime exposes request, status, execute, result, and finish operations
through one CLI/MCP surface. Both native harnesses call those same operations.
The API authenticates the caller's agent and current conversation with holdsRun
and its native session, using the same house/principal checks as send. Neither a
caller-provided principal nor a claimed owner flag grants authority.

A request names an enrolled box, plain-language work and reason, working
directory, execution identity, duration (default 60 minutes, at most eight hours),
and requesting conversation. The runtime records an immutable scope id and
snapshot of the conversation's steering principal. The owner sees these exact
fields before Allow, with what enabling it does and how to revoke it. Commands
run as the box runner's existing OS user. Root/sudo is a distinct requested
identity; no request silently changes OS identity or installs persistent sudo
rights. A runner unable to provide the selected identity refuses before approval
is requested. An approval cannot enroll a machine, grant access to another
owner's box, or enable an unrelated agent.

The work description is a human authorization boundary, not a shell sandbox.
Arbitrary commands cannot be mechanically proven to fit natural-language work.
The enforceable limits are box, OS identity, agent, conversation, principal,
expiry, revocation, command bounds, and immutable action records. The UI and tool
must state this honestly. The agent remains responsible for staying within the
approved work. There is no permanent general-administrator grant.

## Approval and lease

Use the existing approvals piece for one owner decision, kind box-administration,
target containing the immutable scope id and named box. The runtime files it as
the agent for the verified principal, never as the owner merely because the
runtime is calling. The stored scope hash covers every authorization field.
Changed fields require a new scope and approval.

The runtime's normal tick observes Allow and consumes it once, then activates
the lease. An approval-use timeout is uncertain, not denied: a durable activation
intent and the approvals record must reconcile a used decision after restart.
It must be impossible to consume the Yes and lose the resulting lease. The
runtime's existing approval continuation mechanism is the precedent, but its
transaction boundary must be tested explicitly. No model continuation or terminal
confirmation is needed to activate the lease.

A lease survives a harness change and a saved native session resuming. Each
execute call still proves the current conversation and compares its current
principal with the approved snapshot. New steering that changes authority blocks
further commands. Peer relays never inherit an owner lease. The owner can revoke
from the same in-app card at any time; the requester can finish early. Expiry is
checked at submission and again at physical admission on the box.

## Command transport and admission

Extend the existing authenticated box poll protocol with administrative work;
do not add SSH credentials, a second model runner, or a detached host fallback.
The box explicitly reports support and OS identities. Existing box ownership and
agent eligibility checks remain mandatory. A disconnected box keeps work queued
until the lease expires or the owner revokes it.

Each execute has a caller idempotency key and immutable sealed payload (argv,
stdin, cwd, identity), plus a short readable intent. Reusing a key with another
payload is refused. Commands are data, never composed into another shell
invocation; a caller choosing a shell explicitly names its argv. Secret-bearing
payloads and output remain sealed at rest. Public audit entries contain intent,
ids, timestamps, identity, payload hash, state, and exit status, not raw arguments
or stdout. Result retrieval requires the same authorized conversation or owner.

Polling offers work; it does not authorize execution. The runner claims an
operation and performs an authenticated admission check immediately before spawn,
which validates the still-active lease and yields a one-operation admission.
The runner persists admission and native process identity before acknowledging
execution. A command whose admission is uncertain is reconciled, never blindly
replayed. A restarted runner adopts the recorded process or marks the outcome
unknown; it does not rerun a command simply because its launcher vanished.
Non-idempotent side effects mean exactly-once completion cannot be promised after
an OS crash. Unknown results must be explicit and require agent inspection.

Revocation prevents future admissions. Already admitted commands receive a
bounded stop request for that operation's process tree; no blanket process-group
cleanup of unrelated services. If the box is offline, show revocation requested
and outstanding execution until the box acknowledges it. An offline revocation
cannot honestly promise immediate cessation. Administrative commands have an
explicit runtime limit; creating a persistent service is an intentional system
change recorded in the work, not a child process the runtime claims it can revoke.

## Verification gates

- No approval, wrong agent/box/conversation, unproved native session, unknown
  principal substituted for owner, and peer relay reuse all refuse execution.
- Owner Allow activates exactly one immutable lease through the actual app
  action; denial, expiry, and changed scope do not. Crash and lost response at
  every approval-use/lease-save boundary recover without lost or doubled access.
- Execute retries return the same operation; another payload at that key refuses.
  Two controller processes cannot admit it twice.
- Expiry/revocation between queue, claim, and physical admission prevents spawn.
  Already admitted work and unreachable boxes show truthful pending stop state.
- Box-runner restart before spawn, after spawn, during result upload, and after
  acknowledged completion never blindly replays a host command or loses the only
  result. Original failed attempts remain inspectable.
- Both harnesses request and use this same tool in isolated harmless host work.
  Test owner approval, native-session continuation, principal change, and revoke.
  Verify actual box-side filesystem effects and the in-app action record.
- No test broadens permanent sudo rights, touches another person's data, starts
  another model runner, or substitutes a terminal command for the owner's Allow.

## Implementation order

1. Add durable scope/lease/operation records and unit tests with fake time,
   approvals, authenticated callers, and runner transport.
2. Add approval activation/revocation and owner UI using existing piece actions.
3. Add claimed box-command transport and crash-safe native process receipts.
4. Add the one shared CLI/MCP tool and principal proof forwarding.
5. Exercise real in-app Allow and isolated command receipts on an owned box,
   through both harnesses, including revocation and restart boundaries.
6. Publish matching catalog/runner pins before advertising the capability.

## Implementation status

This remains an undeployed draft. The private bounded journal, immutable scope,
sealed command queue, and recovery of approval activation are implemented. The
existing delivery tick files and activates approvals without a model turn.
Approval cards include every scope field as ASCII JSON; oversized cards refuse
rather than truncate authority. The box owner's page lists existing access and
provides a named-owner revoke action. Other members receive no private scope
inventory. These changes depend on approvals PR 16 for decision provenance,
piece-only consumption and recovery of original terminal filing answers.

Controller operations bind each command to one worker's host, PID, boot,
process birth and UID/GID. Claim tickets, command inputs and results are sealed.
Admission rechecks authority, identity and expiry; retries preserve the same
worker and immutable result. Unknown outcomes cannot authorize replay.

The physical worker now requires a systemd user manager by default and refuses
an unavailable manager. A stable per-operation unit is recorded before submit.
The gate is its main process, with control-group cleanup, a bounded runtime and
stop grace. The lease is obtained before unit creation, so its startup time
consumes the lease. No command input is released before the actual gate identity
and one-shot execution marker are durable. A conservative monotonic deadline
also applies inside the gate. Commands receive a minimal environment without
broker credentials. The gate seals bounded output independently of the worker;
a separate sealing phase protects the only result writer from worker escalation.

The direct-process adapter is explicitly a test fixture, never an automatic
production fallback. Default tests exercise that fixture plus refusal of an
unavailable manager. On a Linux host with a user manager, run
`npm run test:administration-supervisor` for real transient-unit checks.
Verified boundaries include worker SIGKILL with result recovery, gate SIGKILL
with descendant cleanup and unknown/no replay, targeted revoke, actual
controller admission/results around a harmless command, and running lease
expiry after worker death. A short lease can correctly expire during startup;
the tests report that refusal separately from the running-expiry proof.

Remaining release gates are authenticated box capability/transport wiring,
supported root identity provisioning, result upload acknowledgements, the
shared CLI/MCP surface, and actual owner-app/both-native-harness verification.
No production approval is answered by these fixtures, no administrator
capability is advertised, and no sudo policy is broadened.
