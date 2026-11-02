# Keeping a box up to date

You don't need to log in to a box to update it. Each box installs the runtime
commit that loom runs, by itself.

## How it works

On every poll, loom tells the box which runtime commit it runs. If the box is
on a different one, it vets that commit (`src/version.mjs`):

- The commit must be on `sleepunit-agents/loom-box`'s `main`, not a fork's
  commit that GitHub would also serve under that name.
- It must come after the commit the box runs now. The box never installs an
  older one; you roll back by hand.

If the commit passes, the box installs it from a systemd unit of its own
(`loom-box-upgrade-<commit>`). The install can then restart the box's service
without being killed along with it. The houses carry on: a box adopts its
running houses when it starts again.

A failed attempt isn't retried for 6 hours. A refused commit isn't either.

## What the box's page shows

Boxes → the box's card → **Runtime**:

- **up to date with loom's**: the box runs loom's commit.
- **updating…**: the box is behind and an install is under way, or about to
  start on its next poll.
- **putting the box piece back…**: a swap failed and is rolling back. The
  recovery timer has it.
- **the update didn't work: <why> · tries again in 5h**: the last attempt
  failed or the commit was refused. **What the install said** shows the
  install's last lines. **Update now** skips the wait, and the box tries again
  on its next poll. The vetting is the same: canonical `main`, forward only.
  loom keeps asking until the box's record says an attempt started. A box that
  can't start yet (a house is starting, upgrades are off) logs why. Only the
  box's owner can press it.
- **loom's version unknown**: loom runs a dev checkout, so there's no commit to
  compare against and nothing to press.
- **too old to say which**: the box runs a version from before boxes reported
  their commit. It's most likely still the old `box` piece (see below).

The box keeps its last attempt in `~/.config/loom-box/upgrade.json` and
reports it on every poll.

## From the old `box` piece to `runtime`

This piece used to be called `box`. It's `runtime` now. The two can't be
installed side by side, because both ship the `loom-box` bin.

**A box on this version or later swaps the pieces by itself.** When it's
installed as `box` and told to install a commit whose package is `runtime`, its
upgrade unit (`loom-runtime upgrade-apply`) does the following, and it can
recover from any step:

1. **Keeps a copy** of the running version's package in
   `~/.config/loom-box/upgrade-keep/<old commit>`, outside the piece home that
   `remove` empties. A rollback then installs from `path:` with no network.
2. **Arms a recovery timer**: `systemd-run --user --on-active=10min` running
   `upgrade-apply --recover`. If the unit dies mid-swap (OOM, a reboot), the
   timer carries on from the last step recorded in `upgrade.json`. It finishes
   the swap, or rolls it back, and re-arms itself until one of those is done.
   The successful path stops the timer.
3. **Writes each step** to `upgrade.json` before taking it: `removing`,
   `installing`, `rolling-back`, then `done` or `failed`.
4. **Removes `box`.** loom keeps that piece's `settings.json` and its data. The
   box's own state is in `~/.config/loom-box`, or wherever `LOOM_BOX_DATA` and
   `LOOM_BOX_HOME` point, outside the piece.
5. **Installs `runtime`** at the commit.
6. **Carries every setting.** Each old setting is kept under its own name in
   `pieces/runtime/carried.env`, which the runtime loads when it starts. Names
   loom already sets win, and the code still reads `LOOM_BOX_*`, so
   `LOOM_BOX_DATA`, where all of a box's state lives, carries too. Each setting
   `runtime` declares also gets its `LOOM_RUNTIME_*` copy through
   `loom pieces set`. Settings don't go into loom's settings store or
   `service.env`: the store refuses names a piece doesn't declare, and loom
   rewrites `service.env` from the store on every install and `set`.

If step 5 fails, the kept copy goes back in from `path:`, then the old commit
from GitHub if that fails too. If both fail, the timer tries again in 10
minutes, and the page says so along with the command to run by hand. A commit
whose `package.json` can't be read is refused before anything changes: the box
can't tell which piece it installs as.

**A box still on an older version can't do the swap itself**, since the code
that does it is new. Its page says "This box is on the old box piece" and shows
this one line to run once on that box. The line has loom's commit filled in:

```bash
loom pieces remove box && loom pieces install --from github:sleepunit-agents/loom-box#<loom's runtime commit> --yes && loom runtime carry-settings
```

`loom runtime carry-settings` carries `pieces/box/settings.json` to `runtime`
the same way as step 6: every setting into `carried.env`, and the declared ones
under their new names. If the install fails, put the old piece back with
`loom pieces install --from github:sleepunit-agents/loom-box#<its old commit> --yes`.
Its settings were kept. From then on, the box updates itself.
