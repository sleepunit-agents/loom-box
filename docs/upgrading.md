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
- **the update didn't work: <why> · tries again in 5h**: the last attempt
  failed or the commit was refused. **What the install said** shows the
  install's last lines. **Update now** skips the wait, and the box tries again
  on its next poll. The vetting is the same: canonical `main`, forward only.
- **too old to say which**: the box runs a version from before boxes reported
  their commit. It's most likely still the old `box` piece (see below).

The box keeps its last attempt in `~/.config/loom-box/upgrade.json` and
reports it on every poll.

## From the old `box` piece to `runtime`

This piece used to be called `box`. It's `runtime` now. The two can't be
installed side by side, because both ship the `loom-box` bin.

**A box on this version or later swaps the pieces by itself.** When it's
installed as `box` and told to install a commit whose package is `runtime`, its
upgrade unit does the following:

1. Removes `box`. loom keeps that piece's `settings.json` and its data. The
   box's own state is in `~/.config/loom-box`, outside the piece, and that
   stays too.
2. Installs `runtime` at the commit.
3. Copies the settings across under their new names (`LOOM_BOX_*` becomes
   `LOOM_RUNTIME_*`), but only the ones `runtime` declares.

If step 2 fails, the unit puts `box` back at the commit the box was on, and
that picks up its kept settings. The page shows why the install failed.

**A box still on an older version can't do the swap itself**, since the code
that does it is new. Its page says "This box is on the old box piece" and shows
this one line to run once on that box. The line has loom's commit filled in:

```bash
loom pieces remove box && loom pieces install --from github:sleepunit-agents/loom-box#<loom's runtime commit> --yes && loom runtime carry-settings
```

`loom runtime carry-settings` copies `pieces/box/settings.json` to `runtime`,
under the new names. If the install fails, put the old piece back with
`loom pieces install --from github:sleepunit-agents/loom-box#<its old commit> --yes`.
Its settings were kept. From then on, the box updates itself.
