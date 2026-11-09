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

The draft now has a private, bounded, fsynced administration journal and its
scope/activation/command-queue engine (`src/administration.mjs`). Requests use
the existing current native run proof, capture principal/reset authority and
the box's reported OS identity, and bind the exact work to an immutable target.
The observed owner decision, approval expiry and fixed lease cutoff are written
before consumption. A lost consumption reply recovers that same lease; a used
card without its original activation intent stays explicitly unresolved.
Payloads are sealed and idempotency keys cannot change a command. Expiry,
revocation, changed steering or OS identity prevent new work. These are internal
functions only: the draft does not expose a functioning administration tool or
execute host commands yet.

The approvals integration must expose the authenticated decision maker (`by` in
the existing approval record) as well as kind/target/principal. An agent with
several owners must not let another member grant access to the named box owner's
OS identity. The engine requires that owner on both allowed and consumed
receipts. The installed approvals read currently omits this field and omits
expiry after consumption; do not invent either. Register the new kind for
piece-only consumption before advertising the tool, so a body cannot consume
the Yes without enabling its lease.

Remaining gates include actual approval filing/activation and owner UI, box
capability reporting and physical command admission/receipts, result retrieval,
the shared CLI/MCP surface, and isolated native-harness/app verification. The
foundation tests use fake approvals and OS identities; no real host command,
sudo policy or production lease is enabled by them.

The production check/use adapter now uses the existing bounded approvals
subprocess helper and mints a fresh principal statement immediately before
consumption, after rechecking the saved conversation and box identity. It never
substitutes an owner principal for unknown or several people. Approval checks
use the approvals protocol's question mark for an unknown principal. This
adapter depends on approvals PR 16 for authenticated decision-maker reads and
piece-only administration consumption; neither draft is deployed.

An isolated integration run against that actual approvals CLI exercised a
fixture UI Allow, a ten-minute approval wait, preservation of an unknown
principal's named people, and a deliberately lost successful consumption reply.
Retry recovered the same lease with one consumption. This verifies the adapter
boundary; automatic filing/tick activation, production UI and host execution
remain unimplemented.
