# loom-runtime (was loom-box)

loom's **runtime piece** ([loom docs/specs/agent-runtime.md](https://github.com/sleepunit-agents/loom/blob/main/docs/specs/agent-runtime.md)): the layer that lets an agent run. It holds:

- **Boxes and houses** ([runtime.md](https://github.com/sleepunit-agents/loom/blob/main/docs/specs/runtime.md)). A **box** is a machine you keep: wunder, the 5090 box, a laptop, a Thor. You enroll it once. A **house** is one agent's container on a box, built fresh from the agent's repo for one task, then thrown away. **It's not a scheduler.** A house goes to the box you name, or to the one permitted box that has what it needs, or to the agent's primary. If that doesn't come down to exactly one box, it says why and starts nothing.
- **Model accounts**: each box signs in to Claude and Codex itself, with its owner's own subscription, and the accounts are what the boxes report ([docs/model-accounts.md](docs/model-accounts.md)).
- **Runners**: one interface over the harnesses a body runs in, Claude Code and Codex.
- **Model choice**: one resolver that picks the model for a body.

Its piece name is `runtime` (`loom runtime …`, bin `loom-runtime`). It was `box`, and `loom-box` stays a second bin through the move, so `loom box …` and everything below that says it keeps working. Node 22 or later, no dependencies.

## Setting it up

On loom's own machine, which is the control plane and the first box:

```bash
loom pieces install box        # the box piece, from loom's catalog
# How an agent's house is made: its repo (whose house file describes the container), which secrets it gets.
loom box agent art --repo https://github.com/sleepunit-agents/art.git \
  --repo-secret github-art-e-fish-token --secret github-token=github-art-e-fish-token --nested
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

### Keeping it up to date

A box installs the runtime commit loom runs by itself: canonical `main` only,
forward only. Its card shows its commit next to loom's, "updating…" while it's
behind, and why an update failed and when it'll try again, with **Update now**.
A box still on the old `box` piece shows the one line to run on it once.
See [docs/upgrading.md](docs/upgrading.md).

## Bodies

Whoever needs a body asks the runtime for one, on the machine the body runs on:

```bash
loom runtime body start --agent art --venue wake --place schedule:reflect --brief - < brief.md   # prints its id, model and why
loom runtime body feed claude:99553cf9 --text -        # a message mid-turn, where the harness allows (exit 3: not fed)
loom runtime body resume claude:99553cf9 --brief -     # its turn is over: continue its session
loom runtime body resume --slot codex:th-123 --agent art --venue slack --brief -   # a slot another machine kept
loom runtime body end claude:99553cf9  |  loom runtime body list
```

- **The model** is the resolver's (below). `--prefer <model>` puts one ahead of the agent's own preference for this body; the hard limits still apply.
- **The harness** is the model's. `claude` runs `claude --bg` with the brief on stdin, never on argv (`LOOM_RUNTIME_CLAUDE`, extra flags in `LOOM_RUNTIME_CLAUDE_ARGS` as a JSON argv, e.g. `["--dangerously-skip-permissions"]` for an agent that runs unattended). `codex` runs `codex exec --json` (`LOOM_RUNTIME_CODEX`, `LOOM_RUNTIME_CODEX_PROFILE`), and can't deny tools, so a body with a deny list isn't started on it.
- **Feeding** goes through the body's inbox, in the layout the bridges' inbox hook reads, under `LOOM_RUNTIME_INBOX_DIR`. Without one, or once the turn is over, a body isn't fed: resume it.
- **A body's record** (`<LOOM_BOX_DATA>/bodies`, 0600) holds its agent, venue, model, harness and slot, never its brief or a message.

## Delivery

Anything addressed to an agent arrives through core's `deliver`, which runs this piece's `delivery` offer (`loom-runtime deliver`, the body on stdin). The turn goes to core first and its text to the audit log. Then the conversation's body is reached within 2 s: `fed`, `resumed`, `started`, `queued` or `failed`.

- **A body is a session in its agent's own warm house.** Delivery asks for the agent's house (`up`) with the task `loom-runtime body-host --piece <name> --host-key <boot key>`. The house runs it, and the body host there wakes the bodies with the house's own harness, login, repo, cwd, secrets and agent token. The house file's command must run that task. Nothing of the runtime's environment goes along, only each body's run key, `LOOM_BODY_KEY`.
- **The body host's own key:** `body-sync` takes only the body host's key, never a body's credentials. The task's boot key is good for one use: the host's first sync trades it for its own key, which it holds in memory. Bodies get neither key, nor the task.
- **Placement** is the same rule the accounts and the claim use (`mayHost` and `mayUseLogin`, [docs/model-accounts.md](docs/model-accounts.md)). The box must be one that may host the agent, logged in to the body's harness, owned by the agent's owner (a loan hosts the agent but doesn't lend the login), with that login granted to the agent. The house must declare the harness in its house file's `"harnesses"`, or it gets no login and its body fails saying so. With no such box, the body is `failed` and says why.
- **Once only:** each turn carries core's idempotency key, `<source>:<id>` (loom#426). A retry after a lost answer gets the same turn back, and a key that belongs to another turn is refused. The same `(source, id)` arriving with a different message is refused (409), and one still being made answers 503 with `retryAfter`.
- **A body that can't start is the runtime's to retry.** The turn stands and the source is answered `queued`, saying why. The runtime tries again on its tick, after 1, 4 and 10 minutes (`LOOM_RUNTIME_RETRY_S`). If the last try fails too, it records a `failed` note on the conversation (an agent `note` turn, outcome `failed`, the reason as its audit text) and puts a notice on its page for the owner ("Art's wake lane:knowledge couldn't start a body: …"). A source never polls. A body that started and then died is retired as before, not started again: it may have done its work.
- **Capacity** counts busy bodies (`LOOM_RUNTIME_BUSY_LIMIT`, 5 per agent). Over it, a new conversation takes the least recently active idle body's place. A body idle for `LOOM_RUNTIME_WARM_IDLE_S` (600) ends, and so does a house with no body.
- **Loops, not caps** (`src/loops.mjs`, t-1763). Nothing limits how many bodies a conversation starts, or how fast: a busy lane, two agents working something through, a burst of wakes all go. What's caught is a crash loop, from each run's outcome (a run is one body started or resumed; the last 12 are kept on its conversation, with hashes of what it posted, never the words). The patterns are: 4 runs in a row that failed, however far apart (it couldn't start, with a delivery's own retries counted as one run; its harness failed the turn; its post was refused; or no reply and no tool work, as the harness reports it), 4 runs in a row, none for a person and each within 2 minutes of the last, that posted the same words or had the same post refused, two agents relaying near-identical words back and forth more than 4 round trips in 30 minutes, and more than 4 very short runs in a row (under 90 s), each started by what the last one left (a wake it set: not a person's message or another agent's) within 90 s of its end, and saying nothing. A run for a person's message never counts toward repeats or churn. Before its next body starts, such a conversation is **paused**: whatever comes is recorded and queued, and a note turn (outcome `deferred`, the reason as its audit text) goes on the conversation. The owner gets one ask, "Looks like a loop in Art's slack:lane:knowledge: 4 runs in a row failed with '…'. Paused.", with **Resume** (what waited starts now) and **Dismiss** (what waited is dropped, and its next message starts it fresh). Either way the check starts over. From a shell: `loom runtime deliver resume|dismiss <cv>`; `deliver list` shows what's paused.
- **Continuity:** a body that ends leaves a slot. Its session files are sent back by its host, sealed with age to the runtime's own key (`<LOOM_BOX_DATA>/delivery/runtime.key`), and kept for its venue's window (`LOOM_RUNTIME_CONTINUITY`, at most 14 days). A resume puts the files back in the house before resuming. When the slot goes, the conversation resumes from its digests.
- **Answering:** a body pipes its message to `loom runtime send --conversation <cv>`, which goes through the piece API as its own agent with its run key. Its host keeps each conversation's current run key in a 0600 file in a 0700 dir (`~/.local/state/loom-runtime/keys/<cv>.key`, `LOOM_RUNTIME_KEYS_DIR`), and `send` reads that before `LOOM_BODY_KEY`: a harness that runs every session under one daemon (`claude --bg`) gives each session the first body's environment. `send` also carries the harness's own session id (`CLAUDE_CODE_SESSION_ID`, which Claude Code sets per session even under its daemon), and the runtime refuses it unless that's the session of the body holding the conversation now, as its host reports it. Only the body holding the conversation now can speak in it. It answers `{accepted, ref}` at once, and the runtime then runs the venue's `send` with its full 15 s. It retries only when the adapter answered no, never after a timeout, because a post that timed out may have landed. The reply turn is recorded as `answered` or `failed`, and a failure goes back to the body through its inbox. A scheduled venue with no `send` (core's `wake`) posts nowhere: the body is told to send an account of its run, which is recorded as its `reply` (answered, its text in the audit log), so a wake's run has the agent turn its measures read.
- **Every end leaves nothing in the clear:** a body that ends is either packed into a slot or has its harness's session files deleted.
- **Who may do what, in the body** (`src/policy.mjs`). Each message's sender tier is read from the runtime's gates when it's delivered. A body's rules are resolved when it starts, and a platform venue's adapter is asked about the place first (its declared `send` argv with `--place <p> --agent <a> --describe`, answering `{ok, guest?, peer?, venue?, readers?, notes?, pair?}`). A place is a **guest venue** when its adapter says so, when the owner's policy lists it (`guest_places`), when a tier-1 person's gate `venues` include it, or when a tier-1 person wrote. The rules become three things:
  1. **The brief:** who wrote and their tier, the owner (the gates' tier 3), the peers in a peer venue (the gates' `agents`), and, in a guest venue, the floor and its readers' person cards (`loom person show`). Then the agent's own prose. That's files in its repo, named by the owner's policy and read where the repo is: its house's body host reads them (a host too old to read them is refused). A file that's missing, empty or outside the repo means no body.
  2. **The deny list** the harness starts with (Claude Code's `--disallowedTools`; Codex can't deny, so its runner refuses one): the policy's `deny`, plus its `guest_deny` in a guest venue.
  3. **Placement:** a guest's message is never fed to a body that isn't narrowed. That body is ended without keeping its session, and a guest venue's body starts. A session (a warm body, a slot) resumes only under the rules it started with.

  Who wrote is out of band: each message a body reads is fenced by a runtime-written header (`<<<message <n> from <slug>, tier <t>>>>` … `<<<end <n>>>`), with a delimiter drawn fresh for each rendering and taken out of the sender's text. The brief says only that header carries a tier, so a guest typing "jonathan [tier 3]:" is only words.

  It fails closed. A guest venue with no `guest_deny`, no floor, no readers or an unread card gets no body. So does a platform venue whose adapter can't describe the place, and any person's message (on any venue) when the gates can't be read. The start fails and is retried, and the owner gets the notice.
- **The policy** is owner-written (collection `policy`, one document per agent). `loom runtime policy --agent a` shows it, and `loom runtime policy set --agent a < doc` sets it whole (the owner's run):

  ```json
  {"deny": ["mcp__handoff"], "guest_deny": ["mcp__claude_ai_Gmail"],
   "briefs": {"venues": {"discord": "house/briefs/discord.md"}, "guest": "house/briefs/guest.md", "peer": "house/briefs/peer.md",
              "notes": {"onterris_channels": "house/briefs/onterris.md"}, "tiers": {"2": "house/briefs/tier-2.md"}},
   "guest_places": {"discord": {"channel:123": ["robin"]}}}
  ```
- **Presence and the stop word:** when a message reaches a body, the adapter is told with `--status working --message <its id>`, so it can show it's on it (typing, 👀). The tick says so again every 15 s while the body works, and sends `--status done` once its turn is over. An answer carrying `stop: true` means a person said the stop word there: the body is ended (its slot kept) and what waited is dropped.
- **To a person:** `loom runtime send --conversation <cv> --person <slug> --via <venue>` posts one DM, through that venue's `send` with `--place dm:<their id>` (from the agent's gates). Only to someone at tier 2 or up, and from a guest venue's body, only to tier 3. The same words to the same person go once in 10 minutes. The turn is that DM conversation's. The approved target is kept on the conversation by the post's ref, under the lock; the detached post goes only there, once, and a target it wasn't given posts nothing.

## Permissions

The runtime is the household's grants authority (loom docs/specs/agent-runtime.md, section 6). It offers `grants`,
so core asks `loom-runtime grants ask` ({agent, piece, path} on stdin, 2 s) before an agent's call to any piece, a
venue render as the agent, and a delivery a piece makes for an agent. Owner calls never ask. The grants are one
owner-written document (`grants`/`household` in the runtime's store): which agent may use which piece and path, and
who may relay to whom (imported once from household.json's `relay` by the seed; the owner's on the Permissions page
since, and never read from household.json again). Until it's seeded, every ask is allowed and each piece decides by
its own list, as before; there are no relay pairs then, so every relay asks the owner.

    loom runtime grants seed [--dry-run]     each piece's own *_AGENTS list imported (others: every agent), and the relay pairs
    loom runtime grants list | set <piece> <agents|*> [--paths p,p] | paired <from> <to>

**Relay** (agent-runtime.md, "Agent-to-agent relay"; `src/relay.mjs`): the runtime offers core an MCP tool, `relay`
(`mcp_tools` in its loom block), so an agent's session has it only while the runtime is installed. Core runs
`loom-runtime relay tool --agent <a>` with the arguments on stdin (`{to, say, why?, reply_to?, from?, approval?}`). A
paired relay is delivered at once on the runtime's `relay` venue, `from: {kind: agent}`, to the other agent's
conversation with this one (place: the sender), so its body starts, resumes or is fed like any delivery. An unpaired
one goes only with an approval the owner allowed (`approvals request --kind relay --target art->mark`, spent here with
`loom approvals use … --as <the calling body>`), and is refused when no approvals piece is installed. The same words to
the same agent within the hour are refused, an answer is a relay back with `reply_to`, and a thread of 8 or more in a
day is a heads-up on loom's Inbox (`LOOM_RUNTIME_RELAY_HEADS_UP`). From a house, `loom runtime relay --to <b> --say
<text>` and `loom runtime relays` do the same over the piece API.

**The now board** (agent-runtime.md, "The sources"; `src/nowboard.mjs`): live state, the runtime's own. A bridge in a
house writes its board through loom's piece API as its agent (shuttle's nowlog with `SHUTTLE_NOW_REMOTE=runtime/now`):
`now/snapshot` `{bridge, snap}` and `now/event` `{record}`, into `<LOOM_RUNTIME_NOW_DIR>/<agent>-now` (the layout
loom-now kept). `loom runtime now talking` from a house reads its own. The runtime's page **Now** shows each agent's
bridges, who they're talking with, what waits, and the accounts' quota. Its manifest makes a bridge actually down an
alert on loom's Inbox (pushed once) and each live conversation its agent's `doing`. A board holds no message text.

A bridge the runtime is restarting (its service's house wanted, starting, stopping, being moved or just up) shows as
**restarting**, never an alert. It's **down** after `LOOM_RUNTIME_BRIDGE_DARK_S` (default 300) of silence while its
house is meant to be running, or a house stuck on its way up for three times that. A crash loop (its service's house
ending unasked 3 times within 15 minutes; `crashes` on the service) is an alert at once: "keeps restarting: 4 restarts
in 12 min, last error …". Back from an outage, a bridge leaves one FYI ("was down 7 min, back at 14:02"); a blip
leaves nothing. What was down is remembered in `<data>/now-watch.json`, noted by the manifest and the delivery tick.


**Gates** (who a platform id is, and what each person may do with each agent) are the runtime's too: collection
`gates`, one document per agent, each entry keyed by the person's card slug. Importing or allowing someone ensures
their person card in core (`POST /api/loom/people/ensure`); merging two entries merges their cards and every agent's
gates follow. A body's proposal (`piece-call runtime propose-person …`, or shuttle's, which hands it here) waits in
the Inbox for the owner's Allow or Deny. The bridges read their gates through shuttle, which answers from here.

    loom shuttle gates export --json | loom runtime gates import     the owner's run, once
    loom runtime gates status | people --agent a | export --json | follow-merge <from> <into>

**Secrets:** the runtime says where a secret lands in a house (an agent's `--secret as=from`); the secrets piece
decides whether the agent may have it (`loom secrets may <agent> <name>`), and hands it over with `issue` to the
runtime's own process. No environment flag unlocks reading. `loom runtime secrets-map --json | loom secrets policy
houses-import` moves the old map's answers into the secrets policy.

## Model choice

```bash
loom runtime models                                   # the model list, and each agent's settings
echo '{"list": [{"id": "claude-opus-5-5", "harness": "claude", "family": "anthropic", "window": "7d_opus"},
                {"id": "gpt-5.5", "harness": "codex", "family": "openai"}],
       "agent": "art", "prefer": ["claude-opus-5-5"]}' | loom runtime models set --json
loom runtime models resolve --agent art --venue slack # which model, and why
```

Each model has a harness and a **family**, one of `anthropic`, `openai`, `google`, `mistral`, or `local:<name>` for one the household runs itself. `window` names the model's own usage window, if its accounts report one. An agent may have `allow` (the models it may use; default all) and `prefer` (its order). Until the owner sets a list, it's Claude Opus 5.5, Opus 5 and Sonnet 5.

The resolver, in order:

1. **Hard limits:** the models the agent may use, with quota left on one of its accounts (a local model needs none). If the accounts can't be read, quota isn't checked, and it says so.
2. **The agent's preference** among those: this body's `--prefer`, then the agent's `prefer`, then the list's order.
3. **Scorecards** demote the preference when another allowed model's `graded` value for the venue's kind (`live`, `scheduled`, `agent`) is at least 1.0 higher, over the last 14 days, with at least 5 graded samples each. They're read from loom's `GET /api/loom/scorecards` with a runtime token (`LOOM_RUNTIME_TOKEN_FILE`), or a file of rows (`LOOM_RUNTIME_SCORECARDS`). None readable is no demotion.

## The review

The household's daily review (loom's `docs/specs/conversations.md`, "Review"): grading by bare models, then each agent's own introspection. It runs at 04:00 in the household's time zone. household.json's `tz` and `review` are read from core (`GET /api/loom/review/config`), never from the file. The delivery service's tick starts it. A service that was down at 04:00 runs it when it's back that day. A runtime seeing the clock for the first time waits for the next 04:00.

```bash
loom runtime review run --limit 5 --introspect art   # one run now, by hand
loom runtime review status                           # the schedule, and what the last runs did
```

- **Grading.** A review token for the run, kept in memory only. Up to `LOOM_RUNTIME_REVIEW_LIMIT` entries (default 200) taken from the audit log, redacted by core. Each entry carries its producer's family, never its model.
  - **Graders.** Each entry gets models from the families allowed to grade it: two other families where the household has them, else one. A household of one family uses a different model of that family (`same_family`). A conversation with someone other than the owner is graded only by the families that already processed it.
  - **What a grader can run on.** A model whose harness is logged in on loom's own box (a household owner's), with room in its account.
  - **What a grader is.** `claude -p` or `codex exec` in a throwaway container under that box's own login. It has no tools, MCP, settings or session, and gets the sample on stdin. It answers a score and at most one finding (one line, ≤ 200 characters).
  - **The grader image.** Graders run only in the image the box's owner built from `grader/Containerfile` and pinned by digest (`LOOM_RUNTIME_GRADER_IMAGE`; else an owner-set `LOOM_RUNTIME_LOGIN_IMAGE`, pinned the same way). It's checked on the box and run by that digest with `--pull never`. It's never an agent's house image: an agent builds its own, and could put a CLI in it that reads the samples or bends the scores. Without it nothing is graded, and the record says "no grader image". To build it:

    ```bash
    podman build -t localhost/loom-grader:1 grader/
    loom pieces set runtime LOOM_RUNTIME_GRADER_IMAGE=localhost/loom-grader@$(podman image inspect localhost/loom-grader:1 --format '{{.Digest}}')
    ```
  - **Its network.** None (`--network none`). Its only way out is an egress proxy the review runs for each grading, on a unix socket mounted into the container. The proxy tunnels CONNECT to the CLI's own provider hosts on 443 (Claude: `api.anthropic.com`, `console.anthropic.com`, `platform.claude.com`, `claude.ai`; Codex: `chatgpt.com`, `auth.openai.com`, `api.openai.com`) and refuses everything else: loom, the box, the LAN.
  - **After grading.** Scores go to core by ref, findings too (core keeps one per conversation per day), and what was processed is marked done. When no allowed family has room, nothing is taken, and the run's record says why nothing was graded.
- **Introspection.** Each agent the runtime hosts (`LOOM_RUNTIME_REVIEW_INTROSPECT`: `all`, `none`, or a list) gets a wake through the runtime's own delivery: venue `wake`, place `review`. Its body starts the normal way, in its own house, as itself. It reads its own conversations, digests and findings, and writes what it learns through its own memory tools. The runtime keeps only that the wake was delivered.
- **The record** (`<LOOM_BOX_DATA>/review/runs.jsonl`) holds counts, grader families and short reasons. It never holds a sample, a grader's words, a finding's text or a token.

## Model accounts

**Read [docs/model-accounts.md](docs/model-accounts.md).** In short: each box signs in to the real `claude` and `codex` with its owner's own subscription, from the box's page (**Log in Claude**, **Log in Codex**: the CLI's own login, run on that box). The box reports, from the CLIs' own status commands, which harnesses it has and whether each is logged in. The accounts are a view of those reports: boxes on one account share it. Usage comes from the harness's own run output. loom never reads, stores, copies, refreshes or issues a model token, and never calls a provider's API. An API key is a plain secret (`anthropic-api-key`, `openai-api-key`). An agent's work runs only on boxes its owner owns, or ones lent to it.

```bash
loom runtime logins                         # each box: claude/codex installed, logged in, plan
loom runtime login <box> claude|codex       # the CLI's own login on that box; its link shows on the page
loom runtime accounts [usage] [--json]      # the accounts the boxes' reports make, and how full each is
```

`LOOM_RUNTIME_ACCOUNTS=none` turns quota reading off. The box runs its own `claude`/`codex` status and login only in a throwaway container (podman), with the shared login dir its only mount: a box without a container runtime can't offer logins. A login's pasted code crosses the box's channel to loom, so log a box in only over HTTPS or the tailnet; a box joined over plain HTTP elsewhere refuses to run a login.

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
    "github-token": { "file": "github-token" }
  },
  "harnesses": ["claude"],
  "env": { "ART_REPO": "https://github.com/sleepunit-agents/art.git" },
  "mounts": { "state": "/home/art/.local/state", "nested": "/var/lib/containers", "mirror": "/garage/git/art.git" },
  "nested": true,
  "hostname": "art-house"
}
```

- **The image** is built from the repo's Containerfile and cached by the git tree of its build context, so an unchanged house reuses it.
- **Secrets** become the house's own podman secrets: a file under `/run/secrets/`, or an env var. `loom-token` is always there: an `agent:<agent>` token for this house only. The rest are the ones the control plane gives this agent's houses. The house file only says where each one lands; it can't ask for more.
- **Mounts** are only the box's own per-house dirs: `state` (thrown away after), `nested` (the house's own nested-container storage) and `mirror` (the box's mirror of the repo, read-only). There are no host paths, and nothing of the box's environment or home goes in.
- **Harnesses** (`"harnesses": ["claude"]`, per house or service: what it runs) get the box's own harness logins, for those harnesses only ([docs/model-accounts.md](docs/model-accounts.md)): the box's login dir, mounted read-write (`nosuid,nodev,noexec`) at `/run/loom/login/<harness>`, with `CLAUDE_SECURESTORAGE_CONFIG_DIR` set for Claude (the house's claude uses it and refreshes it in place) and `LOOM_LOGIN_CODEX` for Codex (the house links `$CODEX_HOME/auth.json` to `$LOOM_LOGIN_CODEX/auth.json`; Codex writes through the link). The house's user must be root inside the container (rootless podman makes that the box's user), so it can use the box's files. A box not logged in to one doesn't start the house.
- **Env** gets `LOOM_URL`, `HOUSE_ID` and `HOUSE_AGENT`, plus the house file's own plain values. The task arrives on stdin, or as `HOUSE_TASK`.
- **Ports** (`"ports": ["7401", "127.0.0.1:4747"]`, the same number inside and out) are published on the box only if the owner allows each one for that agent (`loom box agent <agent> --port 7401`, or the agents page). A service with a web side (a chat pane, an app) needs one; when it moves to another box, whatever routes to it has to follow.
- **Nested containers** (`"nested": true`: the extra capabilities Art's tank needs, still rootless) run only if the owner allows them for that agent (`loom box agent <agent> --nested`, or the agents page). The house file can only ask.
- **Anything else in the house file is refused,** not ignored: unknown keys, paths outside the repo (a symlinked Containerfile included), reserved env names.

When the container exits, the box removes its podman secrets and its dirs, then tells the control plane `done`, `failed` (with the exit code and the end of the log) or `stopped`, and the house's token is revoked.

## How it talks

A box never reads loom's stores, and loom never reaches into a box. The box polls `POST /api/<piece>/<call>` (loom's piece API, docs/extensions.md "The API") with its **box credential**, a loom token with the role `piece:<piece>/<id>` (the box's id is loom's; its name is only a label). That credential reaches this piece's API and nothing else in loom: no MCP, no CLI, no page.

| Call | Who | |
|---|---|---|
| `hello`, `poll` | a box | its facts in; houses to start, ones to stop, and ones it should have |
| `claim` | a box | take a waiting house, once: its token and secrets |
| `report` | a box | how a house is going; ending one revokes its token |
| `up`, `down`, `list` | owner, agent | ask for, stop and see houses (an agent only its own) |
| `body-sync` | an agent's house | its body host's report in; bodies to start, stop and feed out (its own agent's, its own house's only) |
| `send` | an agent | a body's message out, in its own agent's conversation, with its run's `LOOM_BODY_KEY` |
| `add-box`, `revoke-box`, `may-host`, `set-primary`, `set-agent` | owner | enrollment and config |
| `login-report` | a box | how an owner's login on it is going: the CLI's link and device code, then done or failed |
| `login-start`, `login-code`, `login-cancel` | owner | log a box in with the CLI's own login; the pasted code goes to the box once |
| `box-owner`, `box-lend` | owner | whose a box is, and which other members' agents it's lent to |
| `usage` | a house | how full its account is, from its harness's run output |

`<piece>` is the name loom runs it under: `box`, or `runtime` once it's installed by its new name. A box remembers the name it joined under (`piece` in its `box.json`), and one that joined before the rename keeps calling `/api/box/`, which its `piece:box/<id>` credential names.

## Threat model

- **A box holds what it's given, while it's given it.** It only gets secrets for a house assigned to it, once, at claim time, and only the ones named in that agent's house config. That config lives on the control plane, so a box can't widen it. The secrets sit in the house's 0600 files until the house ends.
- **A box's model logins stay on it.** The CLI writes and refreshes them in the box's login dir (0700); a house that asks for them gets that dir, not a copy, and nothing of them goes to loom. A compromised house that was given a login can use it while it runs, as anything on that box could.
- **A compromised box** gets the agents it may host, for the houses it's given, with the secrets those houses get. It can't read memory, read knowledge, use the page or touch other boxes. Revoking it (on the page, or with `loom box revoke`) revokes its credential and every live house token it holds.
- **A body host's boot key is shown to nobody.** A house's task carries it (`--host-key`), and only the box that claims the house gets it whole: `list`, `down` and the page show `--host-key …`. It's good for one use anyway, traded on the host's first sync.
- **A body can't fetch secrets.** A house's token is an ordinary `agent:<name>` token. It reaches MCP and the CLI as that agent, and the secrets piece won't hand a value to a body. Only the box fetched them, for the house.
- **A box only runs containers.** The agent's code runs inside its container, which is rootless podman with no host home, no box env and only its own dirs and secrets. The agent's Containerfile builds under podman too. So a house can't read the box's credential, the box's files, or (on loom's own machine) the household. Nested containers widen what the container may do inside its own user namespace, which is why the owner has to allow them per agent.
- **Inside one house, a body's run key and session only keep an agent's own bodies apart, not walled off.** A house's bodies are one agent, one uid, in one container. Each conversation's key is a 0600 file only that uid can read, and a body names its harness session when it sends. The runtime refuses a send whose session isn't the one holding the conversation, so a body's mistake (naming a sibling's conversation) is refused even though it can read that key file. But a body that sets out to pose as a sibling can: it can read the sibling's key file and the sibling's session id (the harness's job files), and set `CLAUDE_CODE_SESSION_ID` itself, as it could already read any process's environment in its house. This is the same agent's own conversations, never another agent's: a send is checked against the house's agent token first. A harness whose runner reports no session (Codex today: each body is its own process, with its own `LOOM_BODY_KEY`) is checked by its key alone.
- **Revocation doesn't fail open.** A revoke that fails (loom's token file busy) is queued and retried on every box poll until it goes, and a revoked box's name can't be reused until its old credential is gone.
- State on the control plane: `~/.config/loom-box/state.json` (0600, in a 0700 dir; `LOOM_BOX_HOME` moves it), and each service's saved state as its own gzipped tarball in `blobs/` beside it (up to 48 MB, moved in parts; only its size and hash are in state.json). On a box: `box.json` and `credential` (0600) in the same dir, and repo mirrors and house dirs under `~/.local/share/loom-box` (`LOOM_BOX_DATA`).

## Tests

```bash
npm test
```

They pin runtime.md's list: a box refuses an agent it may not host; a need nobody has fails and names itself; nothing else picks a box; a box credential gets only box calls; a revoked box gets nothing and its houses' tokens go with it; secrets go once, to the house's box; with nothing enrolled, everything goes to loom's own machine. There's also a house run end to end against a real git repo. And agent-runtime.md's: model choice (test 4, `test/models.test.mjs`), the runner interface against stand-in harnesses (`test/runners.test.mjs`), model logins and the accounts view, and that the package holds no credential (`test/accounts.test.mjs`), and the rename (`test/rename.test.mjs`).

## Keeping watch (loom docs/specs/keeping-watch.md)

Every box says, on each poll, which boot it's in (`boot`: the kernel's boot id, PID 1's start, its uptime) and, once a
minute, which of its systemd units (the runner's user's and the system's) have failed or keep restarting (`units`:
each with its journal's last lines, redacted). The control plane keeps what it heard in
`<LOOM_BOX_DATA>/box-watch.json` (never `state.json`), and turns it into the owner's Inbox (an alert while a unit is
failing; an FYI when a box came back from a boot or a unit is OK again) and the owner's alert command
(`LOOM_RUNTIME_ALERT_COMMAND`: sources `box-boot` and `unit-<name>`), once when it starts, "(still)" every 6 hours, once
when it's over. A box's boots alert at most once an hour (each still leaves its FYI, five a box at most), so one that
boot-loops is one alert. What a box sends is data, never trusted: redacted, stripped of control and invisible
characters, capped, and dropped when it isn't in the shape the box would send.

| Setting (on a box) | What |
|---|---|
| `LOOM_RUNTIME_UNITS_IGNORE` | a JavaScript regex searched in a unit's name: those units are never reported |

### Health (section 3)

Each box samples itself once a minute, without root (load, memory and swap, pressure, filesystems, disks and ZFS over a
5 s window, pools, containers' pressure; SMART and container names from `/run/loom-box/root-health.json` if a root
timer writes it: `contrib/root-health`), and sends it with its next poll as `health`. The control plane checks it
against host-watch's rules (`src/health.mjs`, `problems`), keeps the last sample and each condition in `box-watch.json`
and every sample in `<LOOM_BOX_DATA>/health/<box>-<YYYY-MM>.jsonl` (three months), and alerts (source `box-health`)
once a condition has held its time. An always-on box (loom's own, a report-only one, or `loom runtime always-on <box>
on`) quiet for 10 minutes is dark. `loom runtime health [<box>]` says how each is. `loom runtime join … --report-only`
makes a box that only reports: it hosts nothing and never upgrades itself from what loom says.
