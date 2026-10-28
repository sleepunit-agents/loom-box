# loom-box

loom's **runtime piece**: boxes and houses ([loom docs/specs/runtime.md](https://github.com/sleepunit-agents/loom/blob/main/docs/specs/runtime.md)).

- A **box** is a machine you keep: wunder, the 5090 box, a laptop, a Thor. You enroll it once.
- A **house** is one agent's container on a box, built fresh from the agent's repo for one task, then thrown away.
- **It's not a scheduler.** A house goes to the box you name, or to the one permitted box that has what it needs, or to the agent's primary. If that doesn't come down to exactly one box, it says why and starts nothing.

`loom box …` reaches it through loom's piece dispatch: `loom pieces install box` installs it (or, working on it, put this repo's `src/cli.mjs` on PATH as `loom-box`). Node 22 or later, no dependencies.

## Setting it up

On loom's own machine, which is the control plane and the first box:

```bash
loom pieces install box        # the box piece, from loom's catalog
# How an agent's house is made: its repo (whose house file describes the container), which secrets it gets.
loom box agent art --repo https://github.com/sleepunit-agents/art.git \
  --repo-secret github-art-e-fish-token --secret github-token=github-art-e-fish-token --secret claude-oauth=claude-oauth-token --nested
loom box run --local          # as a user service: runs houses here
```

With nothing else enrolled, every agent's primary is this machine, so `loom box up --task "…"` works straight away.

On another machine: see [Adding a box](#adding-a-box) below.

The Boxes page lists the boxes and what each one has, starts and stops houses, sets primaries and revokes boxes.

## Adding a box

A second machine that runs houses for loom: a desktop, a laptop, a GPU box, a
VM, an LXC. These steps assume a fresh Debian or Ubuntu machine (x86_64 or
arm64), and loom already running somewhere this machine can reach. On
Windows, the machine is a Linux in WSL2: first [On Windows: WSL2](#on-windows-wsl2). Commands
marked **on loom** run on loom's own machine (or its page); everything else
runs on the new box, logged in as the user that will run its houses.

### 0. A user, and if it's an LXC, the container

The houses run as an ordinary user, never root. Log in as that user over ssh
or a real console: `systemctl --user` needs a login session, so `su` or
`sudo -i` won't do. Make one if needed: `sudo adduser loom`, then log in as
`loom`.

**In an LXC** (Proxmox), do this first, on the Proxmox host. The container
needs `nesting=1,keyctl=1`, and rootless podman's network needs `/dev/net/tun`:

```bash
pct set <id> --features nesting=1,keyctl=1
printf 'lxc.cgroup2.devices.allow: c 10:200 rwm\nlxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file\n' >> /etc/pve/lxc/<id>.conf
pct reboot <id>
```

Without it, a house's image build fails with `Failed to open() /dev/net/tun`.

### 1. Podman, rootless

```bash
sudo apt update
sudo apt install podman uidmap passt fuse-overlayfs git curl build-essential python3
grep "^$USER:" /etc/subuid /etc/subgid       # adduser normally gave you a range in each
```

If either is missing, give this user a range nobody else has. Look at what's
taken first (`cat /etc/subuid`) and pick the next free one. In an
unprivileged LXC, only uids below 65536 exist inside, so use something like
`20000-59999`:

```bash
sudo usermod --add-subuids 20000-59999 --add-subgids 20000-59999 "$USER" && podman system migrate
```

Then:

```bash
sudo loginctl enable-linger "$USER"     # its houses keep running after you log out
podman run --rm docker.io/library/debian:trixie true && echo podman ok
```

### 2. Node and the loom CLI

```bash
mkdir -p ~/.local/share/node ~/.local/bin ~/Code
case "$(uname -m)" in x86_64) A=x64 ;; aarch64) A=arm64 ;; esac
V=v24.18.1 N=node-$V-linux-$A.tar.xz
curl -fsSLO https://nodejs.org/dist/$V/$N && curl -fsSL https://nodejs.org/dist/$V/SHASUMS256.txt | grep " $N\$" | sha256sum -c -
tar -xJf $N -C ~/.local/share/node --strip-components=1 && rm $N
echo 'export PATH=$HOME/.local/bin:$HOME/.local/share/node/bin:$PATH' >> ~/.profile && . ~/.profile
git clone https://github.com/sleepunit-agents/loom.git ~/Code/loom
cd ~/Code/loom && npm ci && npm run build && chmod +x dist/index.js && ln -sf ~/Code/loom/dist/index.js ~/.local/bin/loom
loom --version
loom pieces install box       # downloads this piece; its service starts, and waits until the box has joined
```

### 3. Which URL

The box and its houses talk to loom over HTTP. Ask whoever runs loom which
address it listens on for boxes. That's where `loom serve --http --host
<address>` runs, and loom's machine may run several listeners. Pick the one
this machine can open, and that the network between them can be trusted with.
House tokens and secrets travel over it:

- **loom's tailnet address**, like `http://100.79.56.125:8787`: encrypted by the tailnet. Best when the box can join it.
- **loom's public `https://` URL**, if it has one: encrypted by TLS.
- **a LAN address**, like `http://192.168.6.30:8787`: plain HTTP. Only on a network you trust.

Check it: `curl -s -o /dev/null -w '%{http_code}\n' -X POST <url>/api/box/list -H content-type:application/json -d '{}'`
should print `401` (loom answering, without a token yet), not a timeout.

### 4. Join

On the new box:

```bash
loom box join <url> --name <name>
```

It asks loom to let it in, prints a code like `4DX-9CH`, and waits. On loom's
page, a card on Home says **A box asks to join: \<name>**, with where it's
from, what it has, and the same code. If the code matches the one on the
box's terminal, tap **Let it in**. The box picks up its credential by itself
and joins. Nobody copies a key. The name is only what you call the box, so it
can match its hostname, and two boxes can have the same name. Loom keeps its
own id for each box (like `9f3a2b-c41d0e-77a1f2-0b5e9c`). Where a name is
shared, the page shows the start of the id, and commands take the id. A
request nobody answers expires in 15 minutes. **Block** if it isn't yours.

Then:

```bash
systemctl --user restart loom-piece-box-run
systemctl --user is-enabled loom-piece-box-run      # enabled: it comes back after a reboot
journalctl --user -u loom-piece-box-run -n 5        # no errors
```

The Boxes page now lists the box with its facts (CPUs, memory, podman) and
when it was last seen. It may host any agent; open it there to narrow that.

**The other way, with a credential:** Boxes, then **Add a box**, shows a
credential once. Run `loom box join <url> --name <name> --credential` and
paste it at the prompt, never into chat or a file. If it leaks, revoke the
box and add it again.

### 5. Try it

**On loom** (its page, or loom's machine):

- **A house:** the Boxes page, or `loom box up --agent <agent> --box <name> --task "…"`.
  The first one builds the agent's image from its repo, so give it 10 to 15
  minutes. Later ones reuse the image.
- **Moving a bridge** (a long-lived service house), and back:
  `loom box service move <service> <name> --agent <agent>`. It hands off:
  the bridge stops on the old box, its state moves to the new one, and it
  starts there. Expect a short gap without the bridge.

### On Windows: WSL2

loom-box runs on Linux: rootless podman, systemd user services, Unix
sockets and file modes. On Windows, the box is a Linux in WSL2, and steps 1
to 5 run inside it unchanged. These are the Windows-side steps. They haven't
been tried on a loom box yet, so note what differs and fix this section.

**1. The distro.** In PowerShell, as admin:

```powershell
wsl --install -d Debian          # reboot if it asks; then open "Debian" and make your user
```

**2. systemd** (loom-box's service is a systemd user unit). Inside Debian:

```bash
printf '[boot]\nsystemd=true\n[user]\ndefault=%s\n' "$USER" | sudo tee /etc/wsl.conf
```

Then in PowerShell, `wsl --shutdown`, and open Debian again.
`systemctl --user status` should answer now.

**3. The network.** Windows 11 can give WSL the same network as Windows, so
it reaches your LAN and, if Windows runs Tailscale, the tailnet. In
`%UserProfile%\.wslconfig` (create it if needed):

```ini
[wsl2]
networkingMode=mirrored
```

`wsl --shutdown` again. If step 3 of the guide (the `curl` check) still times
out, install Tailscale inside Debian too, and use loom's tailnet address.

**4. Keep it running.** Windows stops WSL when nothing is using it, and the
box's houses stop with it. Keep it up from Task Scheduler: a task that runs
at log on (and is allowed to keep running), with action `wsl.exe` and
arguments `-d Debian --exec sleep infinity`. The box then runs whenever
you're logged in. If it has to run while nobody is, that needs more (a
Windows service around WSL), and that isn't worked out yet.

**5. Disks.** Keep everything in Debian's own filesystem (`~`), never under
`/mnt/c`. Windows drives don't keep Unix permissions, which the box's
credential and its houses' secrets rely on, and they're slow for this.

**A GPU** (an NVIDIA card in Windows). Install only the Windows NVIDIA
driver: WSL gets the GPU through it, and `nvidia-smi` works in Debian.
Never install a Linux NVIDIA driver inside WSL. The box reports the card
(`gpu:nvidia-…` among its facts), so a house that needs a GPU goes to it.
Getting the GPU into a house's container takes the NVIDIA Container Toolkit
in Debian, then a CDI spec, once:

```bash
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
```

The box then reports `cdi:nvidia`. A GPU in a house is the owner's grant, per
agent (`loom box agent <agent> … --gpu`, or GPU on the agent's page). With it, a
house asked for with a GPU need (`loom box up --needs gpu …`) gets the card
(`--device nvidia.com/gpu=all`).
Without the spec, the house fails, and its log names that command.

### When it doesn't work

| What you see | What it is |
|---|---|
| `Unable to locate package` | run `sudo apt update` first |
| `Failed to connect to bus` from `systemctl --user` | not a login session: log in as the user over ssh, not `su` |
| `Failed to open() /dev/net/tun` while a house builds | an LXC without `/dev/net/tun` (step 0) |
| podman: `insufficient UIDs or GIDs` | no subuid range for this user, or one outside the LXC's 65536 (step 1) |
| `E: Sub-process http returned an error code (112)` in a bare `podman run` | apt's sandbox in a rootless container. House images set `APT::Sandbox::User "root"` themselves, so it isn't the network |
| `loom-box: this machine hasn't joined a loom yet` | the service started before `loom box join`; join, then restart it |
| the box never shows as seen | the URL from step 3 isn't reachable from this machine |
| `this box may not host <agent>` | on the Boxes page, open the box and set who it may host |

## Asking for a house

```bash
loom box up --task "render the frames"                     # the agent's primary
loom box up --needs gpu:5090 --task "train the thing"      # the one box with a 5090 that may host the agent
loom box up --box laptop --task "…"                        # that box
loom box list | loom box down h-12
loom box up --slot tending --task -                        # with its slot: restored at start, saved at the end, one house at a time
loom box session                                           # a house here with you in it, at this terminal; it goes when you leave
loom box attach h-14                                       # back into a session house on this box
```

As the owner on loom's machine, add `--agent <name>`. From a body anywhere, with `LOOM_URL` and `LOOM_TOKEN_FILE` set, it goes through loom's piece API as that body's own agent token. An agent asks only for its own houses.

**Needs** match a box's facts by key and part of the value. `gpu:5090` matches `gpu:nvidia-geforce-rtx-5090`, and a bare need like `jonathan-rig` matches a label the owner gave the box. A box reports its own facts (os, arch, cpus, mem, container runtime, GPUs via `nvidia-smi`) every time it polls.

## The house file

**A house is a container, and only a container.** The box checks out the agent's repo, reads its house file (default `house/house.json`), builds the image, and runs it with podman itself. No agent code runs on the box outside a container.

```json
{
  "build": { "containerfile": "house/Containerfile", "context": "house" },
  "command": ["claude", "-p"],
  "task": "stdin",
  "secrets": {
    "loom-token":   { "file": "loom-token" },
    "github-token": { "file": "github-token" },
    "claude-oauth": { "env": "CLAUDE_CODE_OAUTH_TOKEN" }
  },
  "env": { "ART_REPO": "https://github.com/sleepunit-agents/art.git" },
  "mounts": { "state": "/home/art/.local/state", "nested": "/var/lib/containers", "mirror": "/garage/git/art.git" },
  "nested": true,
  "hostname": "art-house"
}
```

- **The image** is built from the repo's Containerfile and cached by the git tree of its build context, so an unchanged house reuses it.
- **Secrets** become the house's own podman secrets: a file under `/run/secrets/`, or an env var. `loom-token` is always there: an `agent:<agent>` token for this house only. The rest are the ones the control plane gives this agent's houses. The house file only says where each one lands; it can't ask for more.
- **Mounts** are only the box's own per-house dirs: `state` (thrown away after), `nested` (the house's own nested-container storage) and `mirror` (the box's mirror of the repo, read-only). There are no host paths, and nothing of the box's environment or home goes in.
- **Env** gets `LOOM_URL`, `HOUSE_ID` and `HOUSE_AGENT`, plus the house file's own plain values. The task arrives on stdin, or as `HOUSE_TASK`.
- **Ports** (`"ports": ["7401", "127.0.0.1:4747"]`, the same number inside and out) are published on the box only if the owner allows each one for that agent (`loom box agent <agent> --port 7401`, or the agents page). A service with a web side (a chat pane, an app) needs one; when it moves to another box, whatever routes to it has to follow.
- **Nested containers** (`"nested": true`: the extra capabilities Art's tank needs, still rootless) run only if the owner allows them for that agent (`loom box agent <agent> --nested`, or the agents page). The house file can only ask.
- **Anything else in the house file is refused,** not ignored: unknown keys, paths outside the repo (a symlinked Containerfile included), reserved env names.

When the container exits, the box removes its podman secrets and its dirs, then tells the control plane `done`, `failed` (with the exit code and the end of the log) or `stopped`, and the house's token is revoked.

## How it talks

A box never reads loom's stores, and loom never reaches into a box. The box polls `POST /api/box/<call>` (loom's piece API, docs/extensions.md "The API") with its **box credential**, a loom token with the role `piece:box/<id>` (the box's id is loom's; its name is only a label). That credential reaches this piece's API and nothing else in loom: no MCP, no CLI, no page.

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
- **A box only runs containers.** The agent's code runs inside its container, which is rootless podman with no host home, no box env and only its own dirs and secrets. The agent's Containerfile builds under podman too. So a house can't read the box's credential, the box's files, or (on loom's own machine) the household. Nested containers widen what the container may do inside its own user namespace, which is why the owner has to allow them per agent.
- **Revocation doesn't fail open.** A revoke that fails (loom's token file busy) is queued and retried on every box poll until it goes, and a revoked box's name can't be reused until its old credential is gone.
- State on the control plane: `~/.config/loom-box/state.json` (0600, in a 0700 dir; `LOOM_BOX_HOME` moves it), and each service's saved state as its own gzipped tarball in `blobs/` beside it (up to 48 MB, moved in parts; only its size and hash are in state.json). On a box: `box.json` and `credential` (0600) in the same dir, and repo mirrors and house dirs under `~/.local/share/loom-box` (`LOOM_BOX_DATA`).

## Tests

```bash
npm test
```

They pin the spec's list: a box refuses an agent it may not host; a need nobody has fails and names itself; nothing else picks a box; a box credential gets only box calls; a revoked box gets nothing and its houses' tokens go with it; secrets go once, to the house's box; with nothing enrolled, everything goes to loom's own machine. There's also a house run end to end against a real git repo.
