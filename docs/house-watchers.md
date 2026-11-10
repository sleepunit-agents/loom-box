# House wait observers

A guardian observes each adopted house through `podman wait`. Its private fd 3
connects only to the runtime. Closing that connection (including runtime SIGKILL)
makes the guardian kill and reap the wait, then exit. Replacement closes the old
connection and waits for termination before starting its successor. Container processes receive no signals from this cleanup.

New waits inherit `LOOM_WAIT_OWNER=<runtime-pid>:<Linux-start-time>`. On startup,
the runtime reaps waits whose owner is gone, a zombie, or a reused PID, even under
custom subreapers. It requires the resolved Podman executable, exactly three argv
entries (`podman wait <assigned-container>`), and an assigned container name or locally owned historical house receipt.
It preserves waits whose recorded runtime is still alive.

Before this marker existed, ownership cannot be proven under an arbitrary
supervisor. Unmarked legacy waits are only automatically reaped under PID 1,
systemd, tini or dumb-init. Unknown-parent legacy waits require investigation;
do not broaden the parent match to every Node or Python process.

## Coordinator rollout

After the runtime catalog pin merges, update the runtime piece on loom's machine
with `loom pieces update runtime`. Update joined boxes through their normal runtime
update mechanism. Verify two restarts leave one wait (and its guardian) per adopted
house and that houses remain running.

On box `one` and on `wunder`, run the following as each box's runtime user, from
the updated runtime checkout. Set `LOOM_BOX_DATA` to that user's actual runtime
data directory if it differs from `~/.local/share/loom-box`; set `LOOM_BOX_PODMAN`
if that runtime uses a different Podman executable. The receipts in that directory
are the ownership scope; don't point it at another runtime's data.

```sh
REAP=0 node scripts/reap-house-waits.mjs
REAP=1 node scripts/reap-house-waits.mjs
REAP=0 node scripts/reap-house-waits.mjs
```

Inspect the first dry-run's PIDs before the reap. The final dry-run should list
nothing. The script includes historical house receipts, so it also cleans legacy
init/systemd waits whose houses are no longer active. Live marked owners are
preserved. An absent houses directory is an error, not permission to scan broadly.
Unknown-parent unmarked waits are skipped; inspect their executable, exact argv,
parent and actual runtime ownership before any separate manual action.

For an unmarked legacy wait under an unknown supervisor, select its exact PID
from `ps -eo pid,ppid,lstart,args`. Inspect that PID's `/proc/<pid>/exe` and
NUL-separated `/proc/<pid>/cmdline`, its parent's executable and command line,
and the box's runtime service/main PID. Verify the executable is the configured
Podman, argv is exactly `podman wait loom-house-h-N`, that receipt belongs to this
data directory, and the parent is the custom supervisor rather than a live runtime
owning that observer. If ownership cannot be established, leave it alone and
report the PID and parent to the coordinator. Once verified, pass only those PIDs:

```sh
REAP=0 node scripts/reap-house-waits.mjs --legacy-pids=123,456
REAP=1 node scripts/reap-house-waits.mjs --legacy-pids=123,456
REAP=0 node scripts/reap-house-waits.mjs --legacy-pids=123,456
```

Replace the example PIDs with the verified list, and use the same data directory
and executable settings as above. The explicit list bypasses only the legacy
parent-name check; executable, exact argv, receipt names and marked-owner checks
still apply. Never use the list for a wait owned by a live runtime. Run promptly
after inspection and repeat inspection if a listed PID disappears or changes.
