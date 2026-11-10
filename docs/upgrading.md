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

### loom core comes along

The box's `loom` CLI (loom core) is a checkout of `sleepunit-agents/loom`,
built in place (README, step 2). It's core that reads a piece's `loom` block,
so a runtime can need a newer core than the box was set up with. In
2026-11, loom#707 raised the settings cap from 20 to 32, the runtime declared
21, and boxes on an older core failed every retry with `loom.settings is not a
list of at most 20`.

So when `loom pieces install` fails, the upgrade unit brings core forward and
tries the install once more. It fetches `main` from the canonical URL,
fast-forwards only, then runs `npm ci` and `npm run build`. A checkout ahead of
`main` or beside it is left alone. If the build fails, the old commit goes back
and is rebuilt, so `loom` still runs. What happened to core is in
`upgrade.json`, as `core: {from, to}` or `core: {error}`. The checkout is found
from the `loom` bin's real path. Set `LOOM_CORE_DIR` if it lives somewhere else.

A box on a runtime from before this (loom-box 8718d11 and older) can't do it
for itself. Update its core once by hand, as the box's user, then press
**Update now**:

```bash
cd ~/Code/loom && git pull --ff-only && npm ci && npm run build
```

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
2. **Arms a recovery timer**. These are real unit files under
   `~/.config/systemd/user` (`loom-box-upgrade-recover.timer` and `.service`),
   enabled, with `OnBootSec=2min`, every 10 minutes, and `Persistent=true`.
   They aren't a transient `systemd-run` unit because a reboot wipes those, and
   a reboot mid-swap can leave neither piece installed, so no runner to notice.
   The timer runs `upgrade-apply --recover`, which carries on from the last
   step recorded in `upgrade.json`. It finishes the swap or rolls it back. The
   unit files are removed when the swap is over.

   The runner doesn't trust a recorded timer blindly. On each poll it checks
   that the unit files are there, that `systemctl --user is-active` says the
   timer is active, and that it was armed or last ran within 90 minutes (three
   install times). If any of that fails, it starts the recovery at once from
   that poll. It does this in a unit of its own
   (`loom-box-upgrade-recover-now`), so the reinstall restarting the runner's
   service can't cut it short. A lock file (`upgrade.lock`, the holder's pid)
   keeps the upgrade unit, the timer and the runner from running steps at the
   same time.
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
minutes (the timer keeps firing), and the page says so along with the command
to run by hand. A commit
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
