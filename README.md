# loom-runtime (was loom-box)

loom's **runtime piece** ([loom docs/specs/agent-runtime.md](https://github.com/sleepunit-agents/loom/blob/main/docs/specs/agent-runtime.md)): the layer that lets an agent run. It holds:

- **Boxes and houses** ([runtime.md](https://github.com/sleepunit-agents/loom/blob/main/docs/specs/runtime.md)). A **box** is a machine you keep: wunder, the 5090 box, a laptop, a Thor. You enroll it once. A **house** is one agent's container on a box, built fresh from the agent's repo for one task, then thrown away. **It's not a scheduler.** A house goes to the box you name, or to the one permitted box that has what it needs, or to the agent's primary: the first box of its ordered list (`loom runtime primary art one wunder loom`, or the agent's page) that's up, so when one box goes quiet its next house and its new bodies go to the next one. If that doesn't come down to exactly one box, it says why and starts nothing.
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

The Boxes page is a summary: a row per box (its state, its houses, what it is for or what is wrong with it, worst first). Tap a box for its own page: health, sign-ins, runtime version and Update now, watch, houses, settings and Revoke. Boxes also starts and stops houses and sets primaries.

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

The Boxes page now has a row for the box, with when it was last seen; tap it
for its own page and its facts (CPUs, memory, podman). It may host any agent;
change that under Settings on its page.

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
forward only. Its page shows its commit next to loom's, "updating…" while it's
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
- **The harness** is the model's. `claude` runs `claude --bg` with the brief on stdin, never on argv (`LOOM_RUNTIME_CLAUDE`, extra flags in `LOOM_RUNTIME_CLAUDE_ARGS` as a JSON argv, e.g. `["--dangerously-skip-permissions"]` for an agent that runs unattended). `codex` runs `codex exec --json` (`LOOM_RUNTIME_CODEX`; `LOOM_RUNTIME_CODEX_PROFILE` isn't supported: set, no Codex body starts, and it says so), in a Codex home the runtime makes for it, and keeps a deny list only as whole MCP servers turned off: a body that denies anything else (one tool, a built-in) isn't started on it ("When an account runs out", below).
- **Feeding** goes through the body's inbox, in the layout the bridges' inbox hook reads, under `LOOM_RUNTIME_INBOX_DIR`. Without one, or once the turn is over, a body isn't fed: resume it.
- **A body's record** (`<LOOM_BOX_DATA>/bodies`, 0600) holds its agent, venue, model, harness and slot, never its brief or a message.
- **A resumed Claude body keeps its id.** Claude Code gives a resumed session back its own job id, so `body resume` of a body that ended answers the same id, and its record becomes the resumed body's (a new inbox, a new run). A house reports it the same way, and the runtime takes it as that resume.

## Delivery

Anything addressed to an agent arrives through core's `deliver`, which runs this piece's `delivery` offer (`loom-runtime deliver`, the body on stdin). The turn goes to core first and its text to the audit log. Then the conversation's body is reached within 2 s: `fed`, `resumed`, `started`, `queued` or `failed`.

- **A body is a session in its agent's own warm house, its principal's** (one house per steering principal: Permissions, t-1952). Delivery asks for that house (`up`) with the task `loom-runtime body-host --piece <name> --host-key <boot key>`. The house runs it, and the body host there wakes the bodies with the house's own harness, login, repo, cwd, secrets and agent token. The house file's command must run that task. Nothing of the runtime's environment goes along, only each body's run key, `LOOM_BODY_KEY`.
- **The body host's own key:** `body-sync` takes only the body host's key, never a body's credentials. The task's boot key is good for one use: the host's first sync trades it for its own key, which it holds in memory. Bodies get neither key, nor the task.
- **Placement** is the same rule the accounts and the claim use (`mayHost` and `mayUseLogin`, [docs/model-accounts.md](docs/model-accounts.md)). The box must be one that may host the agent, logged in to the body's harness, owned by the agent's owner (a loan hosts the agent but doesn't lend the login), with that login granted to the agent. The house must declare the harness in its house file's `"harnesses"`, or it gets no login and its body fails saying so. With no such box, the body is `failed` and says why.
- **Once only:** each turn carries core's idempotency key, `<source>:<id>` (loom#426). A retry after a lost answer gets the same turn back, and a key that belongs to another turn is refused. The same `(source, id)` arriving with a different message is refused (409), and one still being made answers 503 with `retryAfter`.
- **A body that can't start is the runtime's to retry.** The turn stands and the source is answered `queued`, saying why. The runtime tries again on its tick, after 1, 4 and 10 minutes (`LOOM_RUNTIME_RETRY_S`). If the last try fails too, it records a `failed` note on the conversation (an agent `note` turn, outcome `failed`, the reason as its audit text) and puts a notice on its page for the owner ("Art's wake lane:knowledge couldn't start a body: …"). A start that failed only because loom couldn't be read at all (its store gave no answer, a torn one, or timed out: a deploy restarting it, t-2106) isn't one of those tries: it's tried again each minute, quietly, for up to half an hour, and only a failure after that counts. A source never polls. A body that started and then died is retired as before, not started again: it may have done its work.
- **Capacity** counts busy bodies (`LOOM_RUNTIME_BUSY_LIMIT`, 5 per agent). Over it, a new conversation takes the least recently active idle body's place. A body idle for `LOOM_RUNTIME_WARM_IDLE_S` (600) ends, and so does a house with no body.
- **Startup status in Comms:** a body-host timeout can happen after the delivery response already said “starting.” The runtime sends an asynchronous `comms/adapter` status (`start-retry` or `start-failed`) with the stable failed-start run, attempt number, message IDs, bounded reason and retry time. The latest notification waits durably through transport errors; a successful start cancels unsent failure status. Older cores that reject the new status with a 4xx are not retried indefinitely. Core owns deduplication, clearing the busy indicator and drawing the retry/failure state.
- **Loops, not caps** (`src/loops.mjs`, t-1763). Nothing limits how many bodies a conversation starts, or how fast: a busy lane, two agents working something through, a burst of wakes all go. What's caught is a crash loop, from each run's outcome (a run is one body started or resumed; the last 12 are kept on its conversation, with hashes of what it posted, never the words). The patterns are: 4 runs in a row that failed, however far apart (it couldn't start, with a delivery's own retries counted as one run; its harness failed the turn; its post was refused; or no reply and no tool work, as the harness reports it), 4 runs in a row, none for a person and each within 2 minutes of the last, that posted the same words or had the same post refused, two agents relaying near-identical words back and forth more than 4 round trips in 30 minutes, and more than 4 very short runs in a row (under 90 s), each started by what the last one left (a wake it set: not a person's message or another agent's) within 90 s of its end, and saying nothing. A run for a person's message never counts toward repeats or churn. Before its next body starts, such a conversation is **paused**: whatever comes is recorded and queued, and a note turn (outcome `deferred`, the reason as its audit text) goes on the conversation. The owner gets one ask, "Looks like a loop in Art's slack:lane:knowledge: 4 runs in a row failed with '…'. Paused.", with **Resume** (what waited starts now) and **Dismiss** (what waited is dropped, and its next message starts it fresh). Either way the check starts over. From a shell: `loom runtime deliver resume|dismiss <cv>`; `deliver list` shows what's paused.
- **Stuck on a permission prompt** (t-1858, the clock's t-1854 for what the runtime starts). A body on loom's machine (a local wake's, an alert triage) has nobody at its terminal, so one that stops on a permission prompt would wait forever. The tick asks its harness (`claude agents --json`, at most every 30 s: status `waiting`, `waitingFor` a permission prompt); one that has waited `LOOM_RUNTIME_STUCK_AFTER` minutes (default 10; `0` or `off`: never), counted from when the tick first saw it waiting, is stopped with its session kept in its slot, as an eviction (the conversation's next message resumes it). Its run is a failure on the conversation's record (so a run of them pauses it as a loop), a `failed` note turn goes on the conversation, the owner gets a notice and an alert (`runtime-stuck`: the tool and the session, never the command), and the task its label names (a `t-NNN`) a comment with the tool and a redacted 120-character excerpt of the call, quoted as data (`LOOM_RUNTIME_TASK_COMMENT`, a JSON argv with `{task}` and `{text}`; unset, `taskstore comment {task} {text}` in the local bodies' folder when `taskstore` is on their PATH; `off`, never). A house's body isn't looked at: its runner can't say.
- **Continuity:** a body that ends leaves a slot. Its session files are sent back by its host, sealed with age to the runtime's own key (`<LOOM_BOX_DATA>/delivery/runtime.key`), and kept for its venue's window (`LOOM_RUNTIME_CONTINUITY`, at most 14 days). A resume puts the files back in the house before resuming. When the slot goes, the conversation resumes from its digests.
- **Answering:** a body pipes its message to `loom runtime send --conversation <cv>`, which goes through the piece API as its own agent with its run key. Its host keeps each conversation's current run key in a 0600 file in a 0700 dir (`~/.local/state/loom-runtime/keys/<cv>.key`, `LOOM_RUNTIME_KEYS_DIR`), and `send` reads that before `LOOM_BODY_KEY`: a harness that runs every session under one daemon (`claude --bg`) gives each session the first body's environment. `send` also carries the harness's own session id (`CLAUDE_CODE_SESSION_ID`, which Claude Code sets per session even under its daemon), and the runtime refuses it unless that's the session of the body holding the conversation now, as its host reports it. Only the body holding the conversation now can speak in it. The runtime accepts it at once and runs the venue's `send` with its full 15 s, detached; `send` then asks after it (`send-status`) and answers the body only once the venue has: `{ok: true, posted: true, id?}`, or `{ok: false, reason}` (t-1920: an answer of "accepted" was read as sent, and a run's digest said a DM went that never did). It retries only when the adapter answered no, never after a timeout, because a post that timed out may have landed. The reply turn is recorded as `answered` or `failed`, and a failure goes back to the body through its inbox. A scheduled venue with no `send` (core's `wake`) posts nowhere: the body is told to send an account of its run, which is recorded as its `reply` (answered, its text in the audit log), so a wake's run has the agent turn its measures read. A DM (`--person <slug> --via <venue>`) whose venue's adapter refuses it as shadow (`{ok: false, permanent: true, shadow: true}`) isn't refused for good while that venue's old bridge still posts (`LEGACY_SEND`; empty since Slack went live on loom-slack, t-1745): `send` hands it to that relay as the agent and answers `{ok: true, posted: false, relay}`, which the body reports as on its way, not sent.
- **Every end leaves nothing in the clear:** a body that ends is either packed into a slot or has its harness's session files deleted.
- **Who may do what, in the body** (`src/policy.mjs`). Each message's sender tier is read from the runtime's gates when it's delivered. A body's rules are resolved when it starts, and a platform venue's adapter is asked about the place first (its declared `send` argv with `--place <p> --agent <a> --describe`, answering `{ok, guest?, peer?, venue?, readers?, members?, notes?, pair?}`; `members` is who's in the place, by slug, e.g. a Slack DM's one person or a group DM's people; an adapter names them only for places whose membership can't change under a body, since the runtime reads them at a start or resume, never mid-run). A place is a **guest venue** when its adapter says so, when the owner's policy lists it (`guest_places`), when a tier-1 person's gate `venues` include it, when a tier-1 person wrote, or when a member is tier 1. The rules become three things:
  1. **The brief:** who wrote and their tier, the owner (the gates' tier 3), the peers in a peer venue (the gates' `agents`), and, in a guest venue, the floor and its readers' person cards (`loom person show`). Where the adapter names `members` (t-1745), from the gates, never the adapter: the roster with each one's tier and the lowest tier present (which governs the room), each member's and person sender's standing restriction (`restrict`), the members' cards (best effort; none while a guest reads), and, in a one-to-one place with a tier-2 person, their standing authority (`grant`) only while every message is theirs and the conversation's principal (`principal.mjs`) is them alone, the owner never having spoken there. Then the agent's own prose. That's files in its repo, named by the owner's policy and read where the repo is: its house's body host reads them (a host too old to read them is refused). A file that's missing, empty or outside the repo means no body.
  2. **The deny list** the harness starts with (Claude Code's `--disallowedTools`; Codex turns each denied MCP server off and refuses a body that denies anything else): the policy's `deny`, plus its `guest_deny` in a guest venue.
  3. **Placement:** a guest's message is never fed to a body that isn't narrowed. That body is ended without keeping its session, and a guest venue's body starts. Likewise a body told a person's standing authority hears no one else, and a body whose rules name a place's members hears no person outside them: either is ended without keeping its session and a fresh one starts (`needsReseat`). A session (a warm body, a slot) resumes only under the rules it started with (for rules that name people, the same rules key).

  Who wrote is out of band: each message a body reads is fenced by a runtime-written header (`<<<message <n> from <slug>, tier <t>>>>` … `<<<end <n>>>`), with a delimiter drawn fresh for each rendering and taken out of the sender's text. The brief says only that header carries a tier, so a guest typing "jonathan [tier 3]:" is only words.

  It fails closed. A guest venue with no `guest_deny`, no floor, no readers or an unread card gets no body. So does a platform venue whose adapter can't describe the place, any person's message (on any venue) when the gates can't be read, a `members` roster that can't be taken whole (empty, over 12, a bad or repeated slug), a member the gates give no tier, and a person writing in a place whose roster doesn't have them. The start fails and is retried, and the owner gets the notice.

  **Where am I** (t-1745): `loom runtime place`, from a body, answers `{conversation, agent, venue, place, label?, members, membersAt?, principal: {for, owner, ownerSpoke, unknown?}}` only to the body proving it holds the conversation (its run key and harness session, as `send`), in a house through the piece API or on loom's machine directly. A tool scoped by whom a body works for (Art's `pond-field`) asks it instead of trusting the body's environment.
- **The policy** is owner-written (collection `policy`, one document per agent). `loom runtime policy --agent a` shows it, and `loom runtime policy set --agent a < doc` sets it whole (the owner's run):

  ```json
  {"deny": ["mcp__handoff"], "guest_deny": ["mcp__claude_ai_Gmail"],
   "briefs": {"venues": {"discord": "house/briefs/discord.md"}, "guest": "house/briefs/guest.md", "peer": "house/briefs/peer.md",
              "notes": {"onterris_channels": "house/briefs/onterris.md"}, "tiers": {"2": "house/briefs/tier-2.md"}},
   "guest_places": {"discord": {"channel:123": ["robin"]}}}
  ```
- **Presence and the stop word:** when a message reaches a body, the adapter is told with `--status working --message <its id>`, so it can show it's on it (typing, 👀). The tick says so again every 15 s while the body works, and sends `--status done` once its turn is over. To core's own venue (Comms), a done whose turn posted nothing also carries `replied: false` and its run, so the thread says the agent finished without replying (t-1900); not for a turn refused for a usage limit or one the member stopped. An answer carrying `stop: true` means a person said the stop word there: the body is ended (its slot kept) and what waited is dropped.
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

**A Yes grants it** (t-1970). An agent that needs a piece asks with a `grant` approval (`approvals request --kind grant
--target tasks:mark`) and waits on it in its Needs you. Right after a household owner's Allow, loom core posts
`grant-approved` here as that owner, with the approval's id, agent and target (read from the approvals piece): the
runtime spends it (`loom approvals use … --kind grant --as <the agent that asked>`: allowed, for exactly that target,
once) and only then adds that agent to the piece's grant, everyone else's kept. A member's call, an agent's tab, or no
caller grants nothing and spends nothing; with no grants yet nothing is written (every agent may use every piece
already). Every body's brief says so: ask the yes or no question, never send the owner to do a step himself.
The Permissions page has each agent's own page too, `permissions/<agent>` ("What Mark can use"), the pieces it can
and can't use in words; loom's launcher and each agent's window link there.

**Relay** (agent-runtime.md, "Agent-to-agent relay"; `src/relay.mjs`): the runtime offers core an MCP tool, `relay`
(`mcp_tools` in its loom block), so an agent's session has it only while the runtime is installed. Core runs
`loom-runtime relay tool --agent <a>` with the arguments on stdin (`{to, say, why?, reply_to?, conversation?, from?, approval?}`). A
paired relay is delivered at once on the runtime's `relay` venue, `from: {kind: agent}`, to the other agent's
conversation with this one (place: the sender), so its body starts, resumes or is fed like any delivery. An unpaired
one goes only with an approval the owner allowed (`approvals request --kind relay --target art->mark`, spent here with
`loom approvals use … --as <the calling body>`), and is refused when no approvals piece is installed. The same words to
the same agent within the hour are refused, an answer is a relay back with `reply_to`, and a thread of 8 or more in a
day is a heads-up on loom's Inbox (`LOOM_RUNTIME_RELAY_HEADS_UP`). From a house, `loom runtime relay --to <b> --say
<text> --conversation <cv>` and `loom runtime relays --thread <r-id>` do the same over the piece API.

Include your current `conversation` in a request. The runtime checks it belongs to your agent and, for a house
caller, is held by a body in that house; it records the conversation and current run, never the message text.
Core names a caller's agent and house, never its conversation, so a named conversation is a claim: it stands when the
caller proves it holds that conversation's current run (its `LOOM_BODY_KEY` and harness session, as `send` takes
them, and only while that run is at work and its session is known; `loom runtime relay` from a house body's shell, where
`LOOM_BODY_CONVERSATION` is set, names it, refuses any other, and sends both in the call's body, never argv; the MCP
tool never takes proof), or, unproven (the MCP tool), only while that conversation is at work and no other conversation of the
agent is (any such body could be the one claiming it). So a guest
venue's body, or one working for someone else, can't make an answer land in the owner's own thread (t-1943), nor
the owner's thread's body one in a guest venue;
otherwise the answer goes to the relay conversation, and the relay's answer says why. A relay conversation is never
a return address. The origin's run is recorded for the trace, not checked: an answer that arrives after that run ended
still goes to the conversation (it waits, `untilIdle`, until no turn is under way, then resumes its session), within
6 hours of the ask (`RETURN_MS`); later, or when the runtime no longer keeps the conversation, it falls back. A peer ping-pong into a thread pauses that thread, the owner's
own messages there included, until the owner resumes it.
A reply with `reply_to` goes back to that recorded conversation through normal delivery: a working body finishes its
current turn before the answer is delivered, or its saved session resumes. The peer cannot replace this destination. When no conversation is specified, only
a single active conversation in the caller's house can be inferred; an ambiguous house uses the relay conversation
instead. Legacy relays and origins no longer kept by the runtime also use that fallback. Relay framing still names
the peer and carries none of the owner's authority. `from` accepts `loom:cv-…`, `conversation:cv-…` or a bare `cv-…` as aliases for
an explicit conversation; Discord/Slack location strings remain descriptive hints only.


**A reply's trace** (loom comms.md, "Tracing a reply"; `src/trace.mjs`, t-1895): what happened to one message, from in
to shown, in one read: delivered to the body, the run's body (its house, its harness, started or resumed), how its turn
ended, what it sent and what was refused (`refused` and the last `refusal` on the run), whether the venue took it, and
for a Comms thread whether core shows the reply (core's adapter op `trace`: facts, never words). An agent reads its own
agent's: the `comms_trace` MCP tool (`mcp_tools`, run as the session's agent) or `loom runtime trace --thread th:… |
--run run-… | --conversation cv-…` in its house. The owner reads the agents they own: the `trace/<cv>` page (Comms'
"What happened" links there) or `loom runtime trace` at loom's machine. Never across agents.
**The now board** (agent-runtime.md, "The sources"; `src/nowboard.mjs`): live state, the runtime's own. A bridge in a
house writes its board through loom's piece API as its agent (shuttle's nowlog with `SHUTTLE_NOW_REMOTE=runtime/now`):
`now/snapshot` `{bridge, snap}` and `now/event` `{record}`, into `<LOOM_RUNTIME_NOW_DIR>/<agent>-now` (the layout
loom-now kept). `loom runtime now talking` from a house reads its own. The runtime's page **Now** shows the accounts'
quota and a row per agent (its bridges and bodies in words, what's wrong first); a tap opens `now/<agent>`, its
bridges, who they're talking with and what waits. An alert's **Look** and a back-again FYI open that agent's board.
Its manifest makes a bridge actually down an alert on loom's Inbox (pushed once) and each live conversation its
agent's `doing`. A board holds no message text.

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

### On whose behalf (t-1943)

The owner's standing rules and his yes cover work done for him; work an agent does for anyone else needs a grant he
set for that person, or it asks (the approvals piece). Who a body acts for is the runtime's word, since it hears every
message a body does (`src/principal.mjs`):

- Each conversation keeps `actsFor` as messages join its queue: whether its owner spoke (a member who owns the agent,
  `owners.mjs`), the other people who did, and whether anything it can't place steered it (a relay from another agent,
  an unnamed sender, a wake with no word from the clock, or history from before this was kept, in any venue). It only
  grows.
- Its principal: one other person, theirs; several, or anything unplaced, unknown; only the owner, the owner's;
  nothing heard, unknown. **Never the owner by default.**
- `loom runtime principal [--conversation cv]`, from a body: proven as `send` is (its run's key and session, as its own
  agent), it answers `{for, owner, people, statement}`. The statement is signed with a key only the runtime holds
  (`delivery/principal.key`) and lasts 5 minutes; the run's key never goes to a piece. A house's `piece-call` adds it,
  to every approvals and clock call from a body in a conversation, when the runtime answers, after taking off any the
  caller typed; with none, the piece treats the body as acting for someone it can't name, and `piece-call` says on
  stderr why the runtime gave none (a body left in the shared house from before t-2061, say). The runtime's own daily
  review wake is the owner's schedule. The runtime's own relay spends a relay approval with `--as` and
  no principal (it has no conversation to ask about): approvals then checks everything but whom it was for.
- `loom runtime principal --verify [--house h-N]` (stdin) checks one, on loom's machine: what approvals and the clock
  run. With `--house` (approvals passes its caller's, core's word from the house's token), it holds only when that
  house runs the body of the statement's conversation: a statement is a bearer word for its 5 minutes, so one another
  conversation's body was shown (a relay's text, a task comment) never speaks for it from there.
- `loom runtime principal --wake --agent a --place p --id <delivery id> --for owner|<slug>|-`: the clock's word on whom
  that firing wake is for, given just before it delivers it, and taken as that delivery's message is queued (a word for
  a wake that never arrives is never another's). A wake set by a body working for Loren stays Loren's.
- `--verify` answers `{ok, agent, conversation, for, owner, people, exp}` (`owner` is true or false; `for` is a slug or
  null), and refuses a statement whose conversation has heard someone new since. The piece that reads it binds it to
  its caller: `agent` must be the calling agent.
- **Unknown is for good.** A conversation that ran before this was kept (in any venue: its body resumes that session or
  its digests), or heard a relay or a sender no one names, asks from then on; messages already waiting in its queue
  count as heard. The owner can vouch for one on loom's machine: `loom runtime principal --reset --conversation cv`
  sets aside what it heard before (his Comms threads and lanes from before this change, say).
- **Houses follow it** (t-1952, below): a body runs in its principal's house, so it can't read the run key or session
  of a conversation someone else steers. On loom's machine, the signing key is the runtime's account's, which a local
  body shares.

### One house per conversation (t-2061)

A house's bodies are root together in one container, with the harness's one `claude --bg` daemon, one home, one
checkout of the agent's repo (its hooks too) and the house's one loom token. So a body could read a sibling's key file,
its `/proc` environment and session id, or plant a hook the sibling's session runs, and pose as the sibling's
conversation, even one of the same principal (a prompt-injected thread posting as another of the owner's). A separate
uid per body doesn't close that (the shared daemon, checkout and token stay), so each conversation gets a house of its
own, and no house is ever reused for another:

- **The seat is the conversation's**, and says whose work it is: `owner.cv-…` (the owner's), `p-<person>.cv-…` (one
  person's), `u-cv-…` (unknown), or a job's `j-h-<n>` (its one conversation). The bare `owner` and `p-<person>` are the
  shared houses from before: read on old records, never given to a new body. A launch that holds a conversation goes
  only to a seat naming that conversation, or its job's (`houserunner.mjs`, `sharedSeatProblem`).
- **Core is told which conversation a house holds** before the house is handed its body (`POST /api/loom/
  conversations/house`, the runtime's only, set once). `conversation_digest`, `comms_title` and `comms_thread` from a
  body's house reach only that conversation, and nothing at all from a house core was told nothing of. A failed bind
  is a start that didn't happen. Houses already up at the cut-over (an unknown principal's, a job's) are told on the
  service's tick (`bindLiveHouses`); the shared houses from before never are.
- **Every route the runtime checks against the caller's house** (`send`, `principal`, the continuation calls, `place`,
  the relay's return address, `spawn`, host verbs) now has one conversation behind that house, so a key and session
  id carried out of their house prove nothing anywhere else.
- **Moving in.** A body of the owner's in the shared owner house from before has moved: it can't speak, ask its
  principal or continue there (any sibling there could hold its key), and its next message ends it there and starts
  it fresh, from its digests, in its own house. Its session stays behind: any sibling there was root and could have
  rewritten it. The same for a person's shared house.
- **Cost.** One container per conversation at work, about 0.7-1 GB each. The owner's are bounded by the busy limit
  (`LOOM_RUNTIME_BUSY_LIMIT`, bodies per agent), and each house idles out `LOOM_RUNTIME_WARM_IDLE_S` after its body
  ends. Houses for other people stay capped by `LOOM_RUNTIME_SEAT_HOUSES`, now counted per conversation, so its
  default is 8 (was 4).
- **Not covered here** (follow-ups): a service's house (a chat bridge runs many conversations in one house), bodies on
  loom's machine (no house: they share the runtime account), and other pieces that take a conversation a body names
  (the approvals piece's `--conversation`, the clock's `wake park`, the tasks piece's `--source`).

### One house per steering principal (t-1952)

(Since t-2061 each conversation has its own house, above; the seats below are per conversation, and what's said about
principals still holds for which house a conversation's body moves to.)

The owner's ruling, 2026-11-07: bodies doing his work run in his house; bodies doing anyone else's (Loren, Daniel, a
Discord or Slack guest, someone unnamed) run in a separate house for that principal. A house's bodies are one uid in
one container, so walling conversations apart inside a house isn't possible; walling principals apart is.

- **The house key** is agent + body host + *seat*, the seat being the conversation's principal now
  (`principal.mjs`, `seatOf`): `owner` when every voice was the owner's; `p-<slug>` for one non-owner person; and
  `u-<conversation>` for anything else (unknown, several people, a relay from another agent, nothing heard). An
  unknown principal is never shared: two conversations nobody can name are no more one principal than two strangers.
  The owner's seat keeps the record it always had (`delivery/hosts/<agent>.json`), so his warm house is kept across the
  change; each other seat has `delivery/hosts/<agent>@<seat>.json` and its own house. A body host's house says its
  seat (`seat` in `loom box list --json`, "for loren" in its text and on the Boxes page; the owner's says nothing).
- **The proof is bound to the house.** `send`, `principal`, a body's `place` and the relay's return address all take
  the run's key and session as before, and now also refuse a caller whose house (core names it, from the house's
  token) isn't the house of the body holding that conversation. A key or session id carried out of its house proves
  nothing from another, nor from no house.
- **A principal that changes moves the body.** Each body's rules record its seat. When the next message would change
  it (Loren writes into the owner's group, a second person into Loren's DM, the owner resets a conversation that was
  someone else's and writes), the body is never fed where it is: it's ended there (mid-turn too: a second voice in a
  conversation cuts the turn it's in), and the conversation goes on in the right house with that message. Its own
  session (its slot) is resumed only in the seat it began in, or moved from the owner's seat into the conversation's
  own unknown house, where no one else's bodies are (`carriesSession`; another agent's answer to his thread lands that
  way). Every other move drops it and the body starts fresh from the digests: never into a person's house (it runs
  their other conversations), never out of one (one person's context never reaches another's work), and the owner's
  house never inherits a session someone else steered. No other conversation's session ever moves. A guest venue's rules
  still drop a session that wasn't a guest venue's (`sameRules`). A relay's answer that waits for the requesting turn
  to end (`untilIdle`) doesn't interrupt that turn: the move comes when it's over.
- **The limit on loom's machine.** A local body runs as the runtime's own account, so none of this holds against one
  set on getting round it: it can run itself under a pseudo-terminal (`script`) and type the id, read the signing
  key, rewrite a conversation's record, or call `principal --wake` (the clock's hand-over, which has no owner proof).
  The terminal and the signature stop a mistake and a body that only has the CLI; only running local bodies as
  another OS user than the runtime would wall them off. Until then, local bodies get only the owner's work (above).
- **The proof is bound to the seat too.** A body whose conversation has moved to another principal's house gets no
  statement and proves no place there, and speaks no more unless it's the owner's body and the move only narrows it
  (a relay's answer waiting on its turn); a reset also drops the running body's key at once.
- **Across the upgrade.** Bodies seated before this change have rules that name no seat, and count as the owner's
  house's (where they are). One in a conversation someone else steers moves at that conversation's next message, or
  idles out (`LOOM_RUNTIME_WARM_IDLE_S`); until then it sits in the owner's house. A proof with no caller at all is
  loom's own CLI on loom's machine, which no house reaches: there the house check doesn't apply.
- **Cost.** Houses for other people are capped per agent: `LOOM_RUNTIME_SEAT_HOUSES` (default 8 since t-2061, one per conversation; a value outside 1-64
  is taken as 8) live
  houses for seats other than the owner's and the asking seat's own (a seat's draining house and its new one count as
  one), counted in the same state write that makes a house (two starts at once can't both pass it). At the cap a
  conversation that needs another house waits (`queued`, saying so), keeping its slot; any other seat's house that
  holds no body is asked to stop at once rather than idling out its 600 s, and the tick starts what waits once there's
  room. It never shares a house. The owner's own seat is never held by the cap; but a conversation of his that heard
  something unplaced (another agent's answer, a wake with no word, history from before principals were kept) is a
  `u-` seat and counts, until he resets it (`principal --reset`). Every house idles out as before (a warm body after 600 s, its house 600 s after its last body), its seat's
  record is swept once its house is over, and all of an agent's houses run the same image (one build per repo tree,
  so more houses make no more images: t-1933).
- **What follows the house**: its Codex homes and run dirs (inside its container: t-1924), its key files, its harness
  sessions and its per-house state dir. Secrets are the agent's house config's, the same for every seat: a non-owner's
  house gets exactly what one house got before this, no more.
- **What doesn't**: the agent's own loom token reaches the agent's memory, knowledge and conversations from any of its
  houses (an agent token is the agent's; core doesn't scope it by principal); the runtime's `trace` and `send-status`
  answer any of the agent's houses about any of its conversations (mechanism only: run ids, body refs, outcomes, never
  a key, a session's files or a message's words); and the box's model login dir is one read-write dir every house of
  that agent on that box mounts. None of them is a run key or a session. (Which seat each house is for is the owner's
  to read: no answer to an agent's house names one. An agent stops a body host's house only from a house of the same
  seat; the rest is the owner's.)
- **Local bodies** (loom's machine, t-1830) have no houses and share the runtime account's keys dir, so they do the
  owner's work only, fail closed: a local conversation gets a body there only while its principal is the owner (the
  clock's explicit word for each local wake it fires, `--wake --for owner`, or his own Reply). Anything else (another
  person, a relay, a sender nobody names, a wake whose hand-over failed, history from before principals were kept)
  has its body ended and its start refused, saying why, until the owner vouches for it (`principal --reset` on loom's
  machine, typed at his terminal: it asks for the conversation's id on the controlling terminal, which a body has
  none of; refused from any body's environment; signed with the runtime's key as the owner's; dropping the
  conversation's slot and ending the body that heard what came before; an unsigned reset vouches for nothing; once
  what someone else wrote is no longer waiting there: what's queued is heard again). A refused start goes down the
  usual retry ladder, so it shows on the conversation's record as failed starts.
- **Asked on loom's page** (t-1975; Jonathan: "It needs to have the site ask me"). The typed reset is the fallback:
  where it was the only way back, a local conversation refused a body, the runtime asks the owner itself, with a
  `principal-reset` approval (loom-approvals, target `<agent>:<cv>`): "Count this conversation as your work from now
  on?", its details naming the conversation (its label, as plain words, and id) and listing each waiting message it
  counts. While the card is out, the conversation's messages wait for his answer (at most a day) instead of failing. Only where no person but the owner is named in it (an unplaced voice, a wake with no word
  from the clock, history from before), once per conversation (`resetAsk`, reserved under the lock before the card is
  filed, with the keys of what was waiting then); a clear refusal to file is logged and the reservation let go, and
  one with no answer in time is kept for ten minutes, then tried again (approvals hands back the same card if it was
  filed). `reset-approved` is refused from a body's environment (`HOUSE_ID`, `LOOM_BODY_KEY`, `LOOM_BODY_CONVERSATION`). A
  conversation walled off in a house of its own isn't asked about: it still runs. Right after the household owner's
  Allow, loom core posts `reset-approved` here as him, with the approval's id, agent and target (read back from the
  approvals piece). The runtime checks the conversation is that agent's and that no other person has written there
  since, spends the approval (`loom approvals use … --kind principal-reset --as <agent> --on-behalf owner`: allowed,
  for exactly that conversation, once, without the runtime's store grant) and only then resets it as `--reset` does,
  signed as the owner's (`actsFor.resetApproval` names the approval). Deny never reaches here, and approvals never
  asks about it again. A member, an agent, an agent's tab, or no caller is refused, and nothing is spent.
- **What a reset counts.** Waiting messages are noted again as they come: a person's as theirs, a wake as whom the
  clock said (kept on its queue row, `wakeFor`). The card lists each waiting message no person is named in (a relay
  from an agent, a wake with no word from the clock, a sender loom can't name; at most 12), and only those exact
  messages, by key, count as the owner's on his Allow: anything not on the card, a relay included, is noted as ever.
  Typed at a terminal, nothing waiting is counted (as before). Every body's brief says so: never hand the owner a
  command to type; file the approval.

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

"Quota left" means: no **hold**, and every window under 97%, where a window past its reset time counts as reset. A hold is written the moment a provider refuses a body's turn for a usage limit, and lasts until that limit's reset (30 minutes when the refusal names none, 8 days at most). Readings come from status lines and rollouts after a turn, so they lag; a hold doesn't. `loom runtime models resolve --agent art --venue slack --suppose-out claude` shows what the resolver would pick if Claude's accounts were out, without holding anything.

### When an account runs out

An agent keeps answering when its harness's account runs out (t-1907):

- **A new body** goes to the best allowed model with room. A pick on another harness than the one the agent would use with quota ignored is a **fallback**; the body's record says `switched`.
- **A resume** whose slot's harness has no room parks that slot as the conversation's **home** and starts a fresh body elsewhere, which continues from the conversation's digests. Codex can't continue a Claude session, or the other way round.
- **Going back.** The conversation returns to its home session at its next run once that harness has room again and the reset the switch waited on has passed. The fallback's own session is dropped, since its turns are in the digests, and the home session is told to read them. A live slot lasts up to 14 days, while a window resets in hours or days, so staying on the fallback until the conversation ends would keep a DM off the owner's chosen model for weeks. Every run already resumes from a slot, so going back costs one hand-off, the same as going. Waiting for the reset keeps a conversation from flapping at 97%.
- **A turn refused mid-way** (Claude Code's `rate_limit`/`billing_error` API error entry, a rejected `rate_limit_event`, or Codex's `usage_limit_exceeded`; never the words) holds that account and runs that same turn once more on another harness. The new body is told what the cut-off run already sent. A retry that's refused too isn't run again.
- **Everything out.** When no model the agent may use has room, each message is answered plainly in the conversation, as the agent ("I can't answer right now: …, ask me again after …"), and the owner is alerted once (`runtime-quota`).
- **What the owner sees.** One Inbox FYI per agent per switch ("Art is answering on Codex: Claude Max is out until …") and one when it's back. The agent's card reads "Model: on Codex". A Comms reply from a switched body carries `on: Codex` for its channel line. `loom runtime trace` shows the switch, the return and the retry.
- **A Codex body's deny list.** Kept by construction, not by reading Codex's config and hoping (t-1916). Every Codex body runs with `CODEX_HOME` set to a home the runtime makes (one per real home and deny list, 0700, under `codex-homes` beside the runner's run dirs): its `config.toml` is written by the runtime at each start and holds only the MCP servers the body may use, taken from the real home's `config.toml` (the body env's `CODEX_HOME`, else `~/.codex`), parsed as TOML; nothing else carries over: no profiles, no `[projects]` trust, no model provider or reasoning settings (a house that wants one for its Codex bodies sets it with `-c` in the runtime, not in its home's config). It links the real home's `auth.json` (so a refresh writes through to the one login), `AGENTS.md`, `skills` and `rules`, and its `sessions` is the runner's sessions dir, so resume, usage readings and continuity read where Codex writes. As a second layer, every `mcp__<server>` denied is also turned off on the command line (`-c mcp_servers.<server>={enabled=false, command="false"}`; a stub, since Codex refuses a server entry with no transport). Codex also reads config no `CODEX_HOME` replaces, with no documented flag to skip it: `/etc/codex/config.toml`, `managed_config.toml` and `requirements.toml`, and a project's `.codex/config.toml` from the project root down to the cwd, trusted or not. So a body with a deny list isn't started where any of those exists (from the cwd up to `/`; the real home's own `.codex/config.toml` above the project root is the one exception, as Codex never reads it there): only looked for, never parsed. Delivery keeps such a body off a local Codex, and the owner's alert names the file; a house's host refuses its start (its reason begins `codex won't run this body here:`), and delivery starts that body again off Codex in the same delivery, never a failed start (t-1924). A made home is one per real home and deny list, holding a copy of its allowed servers' definitions (a house's loom token among them), 0600 in a 0700 dir, and it goes once no live body uses it (t-1924): each body's run dir names its home, and the runner sweeps at every body's end (and the runtime's tick sweeps the local ones), deleting every home no live body's run dir names. A body's resume makes its home again; Codex resumes a thread from its rollout in a home it hasn't seen. A home with something moved aside in it keeps that and loses its config; a live body whose run dir names no home (an older runtime's) stops the sweep. A deny Codex can't be trusted to keep (one tool, `mcp__<server>__<tool>`, or a built-in like `Bash`) keeps that body off Codex: it never falls back there, and if nothing else has room the conversation is told why.

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
loom box session                                           # a runtime conversation in a house here; detach and reconnect without stopping it
loom box attach h-14                                       # reconnect its runtime conversation on this box
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

- **The image** is built from the repo's Containerfile and cached by the git tree of its build context, so an unchanged house reuses it. Optional `build.watch` lists up to 64 additional tracked repository paths read at boot (for example `[".claude", "bin", "routines"]`). Changes there also rotate warm body hosts through the existing drain path: running bodies finish in their old house, while new bodies start in a fresh house. Unwatched state exports do not cause rotation. Every watched path must exist at the checked revision.
- **Secrets** become the house's own podman secrets: a file under `/run/secrets/`, or an env var. `loom-token` is always there: an `agent:<agent>` token for this house only. The rest are the ones the control plane gives this agent's houses. The house file only says where each one lands; it can't ask for more.
- **Mounts** are only the box's own per-house dirs: `state` (thrown away after), `nested` (the house's own nested-container storage) and `mirror` (the box's mirror of the repo, read-only). There are no host paths, and nothing of the box's environment or home goes in.
- **Harnesses** (`"harnesses": ["claude"]`, per house or service: what it runs) get the box's own harness logins, for those harnesses only ([docs/model-accounts.md](docs/model-accounts.md)): the box's login dir, mounted read-write (`nosuid,nodev,noexec`) at `/run/loom/login/<harness>`, with `CLAUDE_SECURESTORAGE_CONFIG_DIR` set for Claude (the house's claude uses it and refreshes it in place) and `LOOM_LOGIN_CODEX` for Codex (the house links `$CODEX_HOME/auth.json` to `$LOOM_LOGIN_CODEX/auth.json`; Codex writes through the link). The house's user must be root inside the container (rootless podman makes that the box's user), so it can use the box's files. A box not logged in to one doesn't start the house.
- **Env** gets `LOOM_URL`, `HOUSE_ID` and `HOUSE_AGENT`, plus the house file's own plain values. The task arrives on stdin, or as `HOUSE_TASK`.
- **Ports** (`"ports": ["7401", "127.0.0.1:4747"]`, the same number inside and out) are published on the box only if the owner allows each one for that agent (`loom box agent <agent> --port 7401`, or the agents page). A service with a web side (a chat pane, an app) needs one; when it moves to another box, whatever routes to it has to follow.
- **Nested containers** (`"nested": true`: the extra capabilities Art's tank needs, still rootless) run only if the owner allows them for that agent (`loom box agent <agent> --nested`, or the agents page). The house file can only ask.
- **Anything else in the house file is refused,** not ignored: unknown keys, paths outside the repo (a symlinked Containerfile included), reserved env names.

When the container exits, the box removes its podman secrets and its dirs, then tells the control plane `done`, `failed` (with the exit code and the end of the log) or `stopped`, and the house's token is revoked.

### The house's command line

Every house image already fetches this repo at its runtime pin (for `loom-runtime`), so the command line houses share comes from here too, one copy for all of them: [`house/install-tools`](house/install-tools). Run it in the Containerfile after the last `ENV PATH` (which must hold `~/.local/bin`), as root (a house's user is root inside: see Harnesses above), with node on PATH. It fails rather than leave a house half set up:

```dockerfile
RUN sh /home/<agent>/.local/share/loom-runtime/house/install-tools
```

It writes `piece-call`, `loom-runtime` (node by its full path), and `taskstore`/`loom-tasks`, `wake` and `approvals` (loom's tasks, clock and approvals pieces, through `piece-call` as the house's own token) into `~/.local/bin`, and `/etc/profile.d/loom-house.sh`. That last one matters for Codex, which runs every command in a login shell: Debian's `/etc/profile` resets PATH to the system dirs, so without it a Codex body finds no `loom`, no `node` and none of the wrappers. The profile file puts back the image's PATH and reads `~/.house-env`, which the entrypoint writes for later shells. `install-tools --pieces` rewrites only the piece wrappers, for a house that links its own over them at start.

### Scopes: who gets which secret and tailnet (t-1963, t-1964)

An agent's secrets and tailnets go to every house of it unless the owner scopes them, on the agent's Houses tab ("Only
for", "Who steers which project") or `loom runtime agent <agent> … --scope github-token=owner+service:discord --scope
pond-dev-service-token=pond --scope tailnet:fleet=pond --steer patrick=pond`. A scope is one or more of, joined by `+`:
`owner` (the owner's own work), a project's slug (the owner's work, and that of the people he lets steer that
project), `service:<name>` (that service's houses; a secret scoped to services alone stays out of the owner's own
houses too, t-2118: keep a chat venue's raw token, which posts in any of its conversations, for its bridge). Whose work a house is for is the runtime's word: a body host's seat
(`owner.<conversation>`, `p-<person>.<conversation>`, `u-<conversation>`, t-1952, t-2061; a job's `j-h-<n>` is that house's, only while its conversation's
principal is the one it started with: one someone else joined moves to its principal's house, and a task's house is let
go once its body there is gone; an interactive terminal's house stays up with no body in it until it's taken down, t-2081), a task house's `taskActsFor` (the
owner's only when nobody else steered it), a service house is its own (people other than the owner may steer a chat
bridge, and a body can ask for one). "The owner" is whom the runtime counts as the agent's owner (owners.mjs): a
co-owner's word counts as the owner's here as it does everywhere else.

A claim never issues what's scoped away, and names it (`withheld`) so the box starts the house without it, saying so in
its log; anything else the house file wants and doesn't get still fails the house. Not given or blank, scopes and
steers stay as they were (dropping one would widen who gets a secret); `none` clears. A scope stays with a secret
taken away, so one added back comes back scoped; one stored secret under two names must be scoped alike. Secrets are
handed over when a house starts: houses already running keep what they had until they're stopped. The boundary is
the house: a seat's house is shared by that principal's conversations, so a person let steer pond has pond's secrets
in every conversation they steer. A scope that names `service:<name>` trusts that service's code in the agent's repo:
a body can ask for a service to start, and whoever can change the repo can change what the service runs.

## How it talks

A box never reads loom's stores, and loom never reaches into a box. The box polls `POST /api/<piece>/<call>` (loom's piece API, docs/extensions.md "The API") with its **box credential**, a loom token with the role `piece:<piece>/<id>` (the box's id is loom's; its name is only a label). That credential reaches this piece's API and nothing else in loom: no MCP, no CLI, no page.

| Call | Who | |
|---|---|---|
| `hello`, `poll` | a box | its facts in; houses to start, ones to stop, and ones it should have |
| `claim` | a box | take a waiting house, once: its token and secrets |
| `report` | a box | how a house is going; ending one revokes its token |
| `up`, `down`, `list` | owner, agent | ask for, stop and see houses (an agent only its own) |
| `body-sync` | an agent's house | its body host's report in; bodies to start, stop and feed out (its own agent's, its own house's only) |
| `task-bootstrap`, `task-status` | the allocated task house | register that house with common delivery and read its collected result; no service, session or other house can claim it |
| `send` | an agent | a body's message out, in its own agent's conversation, with its run's `LOOM_BODY_KEY` |
| `principal` | an agent | on whose behalf the body holding a conversation acts, proven as `send` is: a signed statement for approvals and the clock (t-1943) |
| `add-box`, `revoke-box`, `may-host`, `set-primary`, `set-agent` | owner | enrollment and config |
| `login-report` | a box | how an owner's login on it is going: the CLI's link and device code, then done or failed |
| `login-start`, `login-code`, `login-cancel` | owner | log a box in with the CLI's own login; the pasted code goes to the box once |
| `box-owner`, `box-lend` | owner | whose a box is, and which other members' agents it's lent to |
| `usage` | a house | how full its account is, from its harness's run output |

`<piece>` is the name loom runs it under: `box`, or `runtime` once it's installed by its new name. A box remembers the name it joined under (`piece` in its `box.json`), and one that joined before the rename keeps calling `/api/box/`, which its `piece:box/<id>` credential names.

## Host verbs (t-2096)

A body never gets a shell on loom's machine. A body doing its owner's own work asks for a **host verb** instead: a
named step from a fixed table, with typed arguments, run by a separate executor that has no model
(`src/hostverbs.mjs`; design: loom note `runtime/2026-11-10-t2049-phase3-local-bodies-off-loom`, step 3).

```
loom runtime host unit-status <unit>                 do    /usr/bin/systemctl --user status (loom-*, art-*, wake-rearm)
loom runtime host journal <unit> [--since 2h] [--lines 200]   do    journalctl --user -u <unit>
loom runtime host read <path>                        do    a runtime log (allocator-shadow.jsonl, allocator-readings.jsonl,
                                                           host-exec/log.jsonl) or hosts/<your agent>.json
loom runtime host art-chain-check --approval a-…     ask   ~/Art/bin/art-chain-check (a script a push can change)
loom runtime host deploy-loom <label> --approval a-… ask   flock /tmp/deploy-loom.lock ~/Art/bin/deploy-loom <label>
loom runtime host pieces-update <piece> --approval a-…  ask   loom pieces update <piece>
loom runtime host restart <unit> --approval a-…      ask   loom-http, loom-http-local, loom-http-lan, loom-piece-*
loom runtime host result hx-…                        a long verb's result
loom runtime host-exec                               loom's machine: the executor (contrib/host-exec)
```

- **Who.** Only a household owner's agent (every owner it has is a household owner: a member's own agent is that
  member's, and never touches loom's machine). The caller proves it holds its conversation in its current run (its run's key and harness session, as
  `send` does), from the house holding that body. The conversation's principal is the owner, and so is the caller's
  house (the owner's seat, or a job house doing the owner's work); a body on loom's machine only for a local
  conversation. Anyone else is refused before anything else is read, the verb included.
- **The tier.** Each verb's own: the fixed reads `do`; changes, and any script from a checkout that syncs by itself
  (`art-chain-check`, `deploy-loom`), `ask`. With `LOOM_RUNTIME_HOST_RULES=1` (once the approvals piece has standing
  rules for kind `host`, t-2104), the owner's rule for `<verb>:<arg>` (`approvals rule host …`) decides instead. An
  unreadable answer is the verb's own tier. `ask`: an approval of kind `host` for exactly that target, which the
  runtime spends once, for the owner (`approvals use … --as <the body> --on-behalf owner`); without one, the answer is
  the `approvals request` line to file, and the body parks on it. `tell`: the FYI is filed first, and a tell that can't
  be filed stops the verb. An approval offered for a verb that doesn't need one is refused, not spent.
- **The spool.** Only after that is the request written to `delivery/host-exec/queue` (0600 in a 0700 dir). The
  executor claims each by renaming it into `running/`, parses it again against the same table, runs the fixed argv
  with no shell, system tools by absolute path, in its own process group (ended whole past its time limit), with a
  PATH of node's dir and the system's only, and keeps the output's last 64 KB, every line through `redact.mjs`, in
  `done/` (7 days, 200 results). Changes run one at a time; reads alongside. One executor at a time
  (a kernel lock, `flock` on `executor.lock`, gone with the process however it ends). A verb past its time is a failure. A stop finishes what's running and begins nothing more. A request the executor was running when
  it stopped is recorded as `lost` and never run again; one that waited more than 15 minutes for the executor (none
  installed yet, or it was down) is recorded as `expired`, never run late. A tail cut from longer output starts at its
  first whole line. A request file that isn't a private file of the executor's
  user is dropped. The executor trusts the spool as the runtime trusts its own state: anything running as loom's user
  on loom's machine could write it (a local body already has that machine's shell), so the owner's yes is checked by
  the runtime before spooling, not again by the executor. `art-chain-check` and `deploy-loom` run what `~/Art/bin` holds when they run,
  and that checkout follows its repo by itself: the owner's yes is for the step by name, not a pinned copy of the
  script, which is why both ask. After `pieces-update runtime`, restart the executor's unit
  to run the new code. Every step is a line in `host-exec/log.jsonl`, without output.
- **Answers.** A body's call waits about 2 s; a longer verb answers with its id, and `host result` gives the result
  to the same conversation's holder only (any other is told there's no such request).
- **Why a separate executor.** A deploy or a `pieces-update runtime` restarts the process that asked; the executor is
  its own user unit (`contrib/host-exec/loom-runtime-host-exec.service`), so the step isn't cut off with it.

## Threat model

- **A box holds what it's given, while it's given it.** It only gets secrets for a house assigned to it, once, at claim time, and only the ones named in that agent's house config. That config lives on the control plane, so a box can't widen it. The secrets sit in the house's 0600 files until the house ends.
- **A box's model logins stay on it.** The CLI writes and refreshes them in the box's login dir (0700); a house that asks for them gets that dir, not a copy, and nothing of them goes to loom. A compromised house that was given a login can use it while it runs, as anything on that box could.
- **A compromised box** gets the agents it may host, for the houses it's given, with the secrets those houses get. It can't read memory, read knowledge, use the page or touch other boxes. Revoking it (on the page, or with `loom box revoke`) revokes its credential and every live house token it holds.
- **A body host's boot key is shown to nobody.** A house's task carries it (`--host-key`), and only the box that claims the house gets it whole: `list`, `down` and the page show `--host-key …`. It's good for one use anyway, traded on the host's first sync.
- **A body can't fetch secrets.** A house's token is an ordinary `agent:<name>` token. It reaches MCP and the CLI as that agent, and the secrets piece won't hand a value to a body. Only the box fetched them, for the house.
- **A box only runs containers.** The agent's code runs inside its container, which is rootless podman with no host home, no box env and only its own dirs and secrets. The agent's Containerfile builds under podman too. So a house can't read the box's credential, the box's files, or (on loom's own machine) the household. Nested containers widen what the container may do inside its own user namespace, which is why the owner has to allow them per agent.
- **One house per conversation (t-2061).** Below is how it stood with one house per principal: a sibling in a house
  could pose as another conversation of the same principal. Now no house holds two conversations, and core takes a
  digest from a body's house only for the one it holds (Permissions, "One house per conversation").
- **One house per steering principal (t-1952).** A house's bodies are one agent, one uid, in one container, so inside a house a body's run key and session only keep that house's bodies apart, not walled off: a body that sets out to pose as a sibling in its house can read the sibling's key file and session id and set `CLAUDE_CODE_SESSION_ID` itself. So a house holds one principal's conversations only (the owner's; one person's; or one unknown conversation's, alone), and a body moves house when its conversation's principal does (Permissions, "One house per steering principal"). What a sibling can pose as is a conversation of the same principal, toward approvals and the clock the same principal it already acts for. And the runtime refuses `send`, `principal`, `place` and a relay's return address from any house but the one holding the conversation's body, so a key or session id carried out of its house (a guest's house to the owner's, or back) proves nothing. A send is checked against the house's agent token first: never another agent's. A harness whose runner reports no session (Codex today: each body is its own process, with its own `LOOM_BODY_KEY`) is checked by its key and its house.
- **Host verbs are the one way from a house onto loom's machine.** Only the owner's own work, proved; a fixed table of
  verbs with typed arguments; the owner's yes for each change (or his standing rule); no shell; bounded, redacted
  output (Host verbs, above). The executor trusts its spool as it trusts the runtime's state: both are this user's.
- **Revocation doesn't fail open.** A revoke that fails (loom's token file busy) is queued and retried on every box poll until it goes, and a revoked box's name can't be reused until its old credential is gone.
- State on the control plane: `~/.config/loom-box/state.json` (0600, in a 0700 dir; `LOOM_BOX_HOME` moves it), and each service's saved state as its own gzipped tarball in `blobs/` beside it (up to 48 MB, moved in parts; only its size and hash are in state.json). On a box: `box.json` and `credential` (0600) in the same dir, and repo mirrors and house dirs under `~/.local/share/loom-box` (`LOOM_BOX_DATA`).

## Tests

```bash
npm test
```

They pin runtime.md's list: a box refuses an agent it may not host; a need nobody has fails and names itself; nothing else picks a box; a box credential gets only box calls; a revoked box gets nothing and its houses' tokens go with it; secrets go once, to the house's box; with nothing enrolled, everything goes to loom's own machine. There's also a house run end to end against a real git repo. And agent-runtime.md's: model choice (test 4, `test/models.test.mjs`), the runner interface against stand-in harnesses (`test/runners.test.mjs`), model logins and the accounts view, and that the package holds no credential (`test/accounts.test.mjs`), the rename (`test/rename.test.mjs`), and keeping on when an account runs out (`test/quota.test.mjs`).

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

A box with an agent's conversations on it that's silent 10 minutes gets the owner a card: carry them on elsewhere?
(`src/dark-box.mjs`). To rehearse that without stopping the box, on loom's machine: `loom runtime drill dark <box>
--agent <a> [--house h-…]… [--for 15m]` (at most 60 minutes; it ends by itself, or with `loom runtime drill end <box>`).
For that agent only, placement takes the box as long silent, so its warm house there drains and new bodies go to the
next box that's up; the named houses, and only they, go on a write-off card that starts "Drill:". An Allow writes them
off, and the box, still polling, is told to stop them on its next poll (seconds: until then the old body may overlap the
new one, which is what the rehearsal tests).

## Spawned jobs

A body can hand work to a fresh conversation of the same agent. It runs in an
agent venue, with the asker's principal, permissions and house rules; it cannot
choose another principal or a return address.

```bash
loom runtime spawn --brief 'Review this change' --prefer gpt-6.1-sol --title 'Review'
loom runtime spawn --brief - < brief.md
loom runtime spawn say cv-0123456789ab --text 'Also check authorization'
loom runtime spawn wait cv-0123456789ab --timeout 600
loom runtime spawn result cv-0123456789ab
```

`spawn` returns a JSON handle (the new conversation id). `wait` and `result`
print the final report when ready; a timed-out wait exits 3, a failed job exits
1. The shell on loom's machine can use these too, with `--agent <name>` (or the
household default). A body uses `--agent self`, the default: another agent is
refused. The matching `spawn` MCP tool takes `brief`, `prefer`, `role`, `failover`, `title` and your
`conversation`; `action: say` takes `handle` and `text`, `action: result` takes
`handle`, `action: roles` takes nothing. Where multiple bodies could be asking, use the shell, which proves
its current run without putting its key in a tool call.

Follow-ups use body feed mid-turn where supported, and otherwise wait for the
next turn. Reports are collected from the harness's final response, sealed on
disk, and returned to the asking conversation after its current turn finishes,
through the relay-return delivery path. Comms shows a separate thread with a
link to the asker; the agent card shows its working body. Reports and handles
survive runtime restarts. A principal reset invalidates the old handle's access
and return routing. A source conversation's guest rules and restrictions are
re-evaluated at each child start, and its inherited tool narrowing is retained.

### Work roles and a job's model

A body says what kind of work a job is; the runtime picks the model. The owner keeps a catalog of **work roles**
(`coding`, `review`, `light-task`… whatever the household wants: it is not a fixed list), each with the concrete models
eligible for it, most wanted first, or whole families. A role is not an agent and not a persona: it can name a
`dossier` to wear, and say what the job `needs`, takes (`input`) and returns (`output`).

```bash
loom runtime roles                                   # the catalog, for any body or the owner
loom runtime spawn roles                             # the same, as the spawn tool's action roles answers it
echo '{"id":"coding","description":"Write and fix code","models":["gpt-6.1-sol","claude-opus-5-5"]}' \
  | loom runtime roles set --why 'coding jobs on Sol first'      # the household owner's
loom runtime roles remove coding --why 'folded into review'      # the household owner's
loom runtime spawn --role coding --brief - < brief.md
```

Each edit is a new catalog version, logged with who and why (the last 20). A role only narrows: its models are
intersected with the agent's own `allow`, and accounts, quota, grants and spending rules are untouched by it. A model
the owner drops from the model list leaves every role too.

A spawned job keeps the version it was admitted under, and, from its first run, its **assignment**: the concrete model
and harness it ran on. Every later run of that job (a `say`, a resume after a restart) uses that model, whatever changes
meanwhile: a catalog edit, a new preference, the owner's harness choice, or the primary model's account getting room
back. This is unlike a live conversation, which falls back when its account is out and goes home when it has room. A
job whose model is out of quota waits, its session kept and its messages queued (`waiting` says why), unless
it was spawned with `--failover` (or its role sets `"failover": true`): then it moves to another eligible model,
pinned there, the move kept in `lineage`; it never goes back by itself. A job whose model left the list (or the agent's
`allow`) holds, its session and messages kept, until the owner restores it: failover is for quota only. Its rules come before its assignment: a
harness its rules can't be kept on (a deny list Codex can't hold, a body on loom's machine without the Codex opt-in) is
never used, pinned or not, and the job moves. A Claude session is never resumed on Codex: a move is a fresh body, from
the job's digests. `spawn result` says the job's assignment.

**Native subagents stay.** A body's harness may run its own subagents (Claude Code's Agent tool, Codex's) for work
inside its job: a few independent lookups or edits. They share the job's model and account, and the runtime neither
intercepts nor counts them one by one; plan their spend as part of the job. Use a loom job (spawn) for work that should
have its own model, account, lifecycle or report: it has a durable handle, survives restarts and returns its report.

`LOOM_RUNTIME_SPAWN_LIMIT` defaults to 3 concurrent spawned turns per agent;
extra jobs queue, and also respect delivery's overall busy limit. Spawn chains
count in the loop detector and stop before a ninth generation. Shell callers
outside the runtime have no parent conversation, so use wait/result for their
reports. A body can fetch or steer only its own spawned jobs.

A delivery that cannot start for quota returns `body: "failed", code: "quota"`
and, when known, `retryAfter` as an ISO timestamp for the earliest available account
reset. Its reason includes why another harness was excluded (for example the local
Codex opt-in), rather than implying every household account is exhausted. The clock
can wait for that reset without creating a failure-alert retry chain.

### Tasks in an already allocated house

A model-task entrypoint may run `loom-runtime task-host` instead of launching a native harness. The runtime reads the task from that house’s control record, registers the existing house as a dedicated job host, and runs the prompt through ordinary delivery, model/account choice, quota fallback, policy, native hooks, reports and session collection. It does not allocate a second warm house: the requested box, requirements and saved-state slot remain the box’s original allocation. A JSON `{prompt, model}` task treats `model` as its preference through that resolver.

`up` carries a body’s conversation/run proof when available. A verified parent’s principal and standing restrictions follow the task; an unproved agent call is unknown, never promoted to owner. The allocating house or a proved continuation can cancel its job. Only that raw-task house can bootstrap or inspect its completion; services, interactive session houses and unrelated callers cannot claim a task host. Bootstrap retries reuse one conversation and boot credential until the first body sync trades the credential. Established host credentials are never returned.

The entrypoint returns the common final report only after delivery has collected the session, then performs its existing Git rescue and lets the box save its state slot. A task whose allocated house terminates fails explicitly rather than silently moving onto an unconstrained box. Native task entrypoints must be updated together with their runtime pin; older native entrypoints retain their previous behavior until replaced. A deterministic script in a raw-task house may run `loom-runtime task-host --brief-stdin` with only its model prompt on stdin. The same house, principal, model preference and dedicated job host are used; the original `run: …` envelope is not sent to a model. One immutable brief hash binds bootstrap retries to that operation, without copying the derived text into house metadata. A different brief or a switch between ordinary and script bootstrap is refused. Script validation, local claims and posting stay with the script; stdout contains the collected final report. On SIGTERM or SIGINT, the host requests interruption of only its own task and continues syncing until the native writer is stopped and its session is collected. A failed cancellation acknowledgement is retried; acceptance alone does not end the host. A collected cancellation has an explicit `cancelled` result and CLI exit130. House entrypoints import `loom_host_process.run_host` from the same installed runtime; it forwards SIGTERM/SIGINT and waits before Git rescue. Only a requested cancellation becomes a clean physical stop; an unsolicited cancellation code or genuine child failure remains a failure. This command refuses execution outside an allocated raw-task house. `task-host` executes model prompts, not arbitrary shell commands. Interactive attachment uses the session host below.


A warm body host's ordinary Down drains its conversations before the box signals the container. An authenticated host is removed from admission, queued starts are refused, admitted launches settle, and every native session is packed through the existing body-sync channel. The host exits normally only after conversation slots are committed, allowing its entrypoint to finish Git rescue. Resume waits until the old physical house finishes. Raw task and interactive parents keep their acknowledged signal path.

Native transfer timeouts are not collection acknowledgements. A network outage retains the sender's pack; a stop remains pending until its received pack exists. The collector defers discarding that pack until it atomically commits the encrypted slot and a generation-bound retirement receipt in conversation state. Local transcripts and unread inbox data follow the same boundary. A retry after cleanup can finish from that receipt without re-reading deleted native files; releasing the body removes the receipt in the same state write that records its slot and queued unread messages.

### Interactive session houses

An interactive entrypoint runs `loom-runtime session-host` for `HOUSE_SESSION=1` after its usual login, repository and tool setup. The allocated house hosts common delivery and the same native runners as raw tasks and wakes. The terminal is an owner controller; its credential is not given to the model. An agent token can bootstrap only its own session host and cannot control a terminal. Captured principal, box, requirements and state slot stay attached to the session. A house without the new host refuses attachment clearly; it does not launch a separate native model.

`loom runtime session` opens the conversation. `loom runtime attach h-ID` reconnects it, including the latest final report. Tool activity appears while a turn runs, and a new message can steer the conversation during work. Use `/begin` and `/end` for one multiline message; `/cancel` discards an unfinished multiline message. `/stop` waits through common cancellation and saves native continuity; `/resume` uses that continuity. `/model auto|claude|codex` sets the same conversation choice as Comms. `/shell` opens the house’s ordinary shell, with its configured tools, mounts and network; `attach h-ID --shell` opens that shell directly.

`/detach` leaves the native conversation running for reconnect. `/close` stops and saves it before asking the box to close the house; new input cancels a pending close. An unconfirmed send stays in the terminal: `/retry` uses the same message ID, and `/discard` explicitly discards it. EOF prints unconfirmed or unfinished text and exits unsuccessfully so it is recoverable. `/status` and `/help` describe the current state and controls. Guest capacity cleanup never reaps a session house waiting for its owner to reconnect. The entrypoint still rescues repository changes when the house closes.


### Recovery and state collection

A lost attached launcher does not end its container. The box observes the physical container and adopts a running one without restarting its work. Inspection errors and containers still being created remain unknown; they do not authorize stop, removal or state cleanup.

After physical exit, stateful houses retain their local state until the control plane acknowledges its upload. A private atomic completion receipt records only bookkeeping and phase, never a prompt, run key or secret value. Uploads and terminal reports retry, including across a runner restart; a lost reply after a committed report is reconciled against the next authoritative poll. Cleanup follows these acknowledgements. Polls include the box’s own active house bookkeeping so an adopted service or slot retains its state requirements. An older control plane that cannot supply those requirements leaves collection pending and keeps the local data.

Pending collection appears as “Saving state” or “Finishing” on the Runtime page and CLI. The physically ended house is not offered new model work or counted as a running guest container while its local state is retained.
