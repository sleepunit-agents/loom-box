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
