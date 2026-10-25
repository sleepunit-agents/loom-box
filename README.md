# loom-box

loom's **runtime piece**: boxes and houses ([loom docs/specs/runtime.md](https://github.com/sleepunit-agents/loom/blob/main/docs/specs/runtime.md)).

- A **box** is a machine you keep: wunder, the 5090 box, a laptop, a Thor. You enroll it once.
- A **house** is one agent's container on a box, built fresh from the agent's repo for one task, then thrown away.
- **It's not a scheduler.** A house goes to the box you name, or to the one permitted box that has what it needs, or to the agent's primary. If that doesn't come down to exactly one box, it says why and starts nothing.

`loom box …` reaches it through loom's piece dispatch (put `src/cli.mjs` on PATH as `loom-box`). Node 22 or later, no dependencies.

## Setting it up

On loom's own machine, which is the control plane and the first box:

```bash
ln -s ~/Code/loom-box/src/cli.mjs ~/.local/bin/loom-box
# How an agent's house is made: its repo, the command in it, which secrets it gets.
loom box agent art --repo https://github.com/sleepunit-agents/art.git --house-cmd house/up \
  --repo-secret github-art-e-fish-token --secret github-token=github-art-e-fish-token --secret claude-oauth=claude-oauth-token
loom box run --local          # as a user service: runs houses here
```

With nothing else enrolled, every agent's primary is this machine, so `loom box up --task "…"` works straight away.

On another machine:

```bash
# On loom's machine (or the Boxes page, "Add a box"): prints the box's credential once.
loom box add thor --may-host art
# On thor:
loom box join https://loom.example.com --name thor     # paste the credential when it asks
loom box run                                           # as a user service
```

The Boxes page lists the boxes and what each one has, starts and stops houses, sets primaries and revokes boxes.

## Asking for a house

```bash
loom box up --task "render the frames"                     # the agent's primary
loom box up --needs gpu:5090 --task "train the thing"      # the one box with a 5090 that may host the agent
loom box up --box laptop --task "…"                        # that box
loom box list | loom box down h-12
```

As the owner on loom's machine, add `--agent <name>`. From a body anywhere, with `LOOM_URL` and `LOOM_TOKEN_FILE` set, it goes through loom's piece API as that body's own agent token. An agent asks only for its own houses.

**Needs** match a box's facts by key and part of the value. `gpu:5090` matches `gpu:nvidia-geforce-rtx-5090`, and a bare need like `jonathan-rig` matches a label the owner gave the box. A box reports its own facts (os, arch, cpus, mem, container runtime, GPUs via `nvidia-smi`) every time it polls.

## The house command

A house is the agent's repo, cloned fresh, with its house command (default `house/up`) run in its own process group. It gets:

| | |
|---|---|
| `HOUSE_TASK` | what to do |
| `HOUSE_ID`, `HOUSE_AGENT` | which house, whose |
| `HOUSE_SECRETS_DIR` | a 0700 dir: `loom-token` (an `agent:<agent>` token for this house only) and the agent's house secrets, a file each, 0600 |
| `LOOM_URL` | loom's MCP endpoint |

What the container is, and how it's run, is the repo's business: Art's `house/up` runs its tank. When the command exits, the box deletes the secrets dir and the clone, tells the control plane `done`, `failed` (with the exit code and the end of the log) or `stopped`, and the house's token is revoked.

## How it talks

A box never reads loom's stores, and loom never reaches into a box. The box polls `POST /api/box/<call>` (loom's piece API, docs/extensions.md "The API") with its **box credential**, a loom token with the role `piece:box/<name>`. That credential reaches this piece's API and nothing else in loom: no MCP, no CLI, no page.

| Call | Who | |
|---|---|---|
| `hello`, `poll` | a box | its facts in; houses to start, ones to stop, and ones it should have |
| `claim` | a box | take a waiting house, once: its token and secrets |
| `report` | a box | how a house is going; ending one revokes its token |
| `up`, `down`, `list` | owner, agent | ask for, stop and see houses (an agent only its own) |
| `add-box`, `revoke-box`, `may-host`, `set-primary`, `set-agent` | owner | enrollment and config |

## Threat model

- **A box holds what it's given, while it's given it.** It only gets secrets for a house assigned to it, once, at claim time, and only the ones named in that agent's house config. That config lives on the control plane, so a box can't widen it. The secrets sit in the house's 0600 files until the house ends.
- **A compromised box** gets the agents it may host, for the houses it's given, with the secrets those houses get. It can't read memory, read knowledge, use the page or touch other boxes. Revoking it (on the page, or with `loom box revoke`) revokes its credential and every live house token it holds.
- **A body can't fetch secrets.** A house's token is an ordinary `agent:<name>` token. It reaches MCP and the CLI as that agent, and the secrets piece won't hand a value to a body. Only the box fetched them, for the house.
- **The house command is the agent's own code, and it runs as the box's user.** That's the known gap in this version. The house command can read whatever that user can: on a box, its box credential (so it could act as the box); on loom's own machine, the whole household, including the secrets store and its key. Today the boundary is the container the house command starts (Art's tank is rootless podman, with its keys as podman secrets and no host home mounted), plus who's allowed to set an agent's house config: only the owner, per agent. So set an agent's house only if you'd let that repo run as that user, on every box that may host it. Running each house under its own user, so the box's files are out of reach, is the next step.
- **Revocation doesn't fail open.** A revoke that fails (loom's token file busy) is queued and retried on every box poll until it goes, and a revoked box's name can't be reused until its old credential is gone.
- State on the control plane: `~/.config/loom-box/state.json` (0600, in a 0700 dir; `LOOM_BOX_HOME` moves it). On a box: `box.json` and `credential` (0600) in the same dir, and repo mirrors and house dirs under `~/.local/share/loom-box` (`LOOM_BOX_DATA`).

## Tests

```bash
npm test
```

They pin the spec's list: a box refuses an agent it may not host; a need nobody has fails and names itself; nothing else picks a box; a box credential gets only box calls; a revoked box gets nothing and its houses' tokens go with it; secrets go once, to the house's box; with nothing enrolled, everything goes to loom's own machine. There's also a house run end to end against a real git repo.
