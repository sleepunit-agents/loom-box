# Model accounts

How loom's agents get to Claude and Codex, and why it's done this way.

## Each box signs in itself

A box runs the real `claude` and `codex` binaries, unmodified, and each one is
logged in on that box with its owner's own subscription. loom passes prompts
to those binaries. It does not log in for them.

- **Logging in.** On loom's page, Boxes, **Model logins**, a box has **Log in
  Claude** and **Log in Codex**. The button runs the CLI's own login on that box:
  `claude auth login --claudeai`, or `codex login --device-auth`. The page shows
  the link the CLI printed. For Claude, you sign in and paste the code
  Anthropic's page shows. For Codex, you enter the code shown, and the CLI
  finishes by itself. The CLI then writes its own login into the box's login dir
  (`~/.local/share/loom-box/logins/<harness>`), and refreshes it itself from then
  on. `loom runtime login <box> claude|codex` starts the same from a terminal.
- **The sign-in page keeps up by itself.** While the box starts the CLI, checks
  a pasted code, or waits for a device sign-in, the page says so beside a
  spinner and reloads itself (loom core's page `refresh`). It then shows
  "✓ Claude logged in (claude.ai, Max)", or why the login didn't work, with
  **Try again**. A failure keeps the CLI's last few lines and its exit status.
  Anything in them that looks like a code or a token is cut out first: the text
  after `code=` or "token", any long base64-like string, and the pasted code
  itself.
- **The sign-in link is kept only while it's needed.** Claude's authorize link
  carries the sign-in's `state` and `code_challenge`, and the owner has to open
  it, so it can't be scrubbed. loom keeps it in its state only while that
  sign-in is `waiting`, and deletes it at any other step: checking, cancelled,
  failed, expired, or done. It never goes into a log line. Anywhere else it
  turns up, such as the CLI's last lines, its query is cut out. The risk this
  leaves is small. Someone who can read loom's state during the few minutes a
  sign-in waits learns the `state` and the challenge. Without the code the
  owner pastes, those can't finish the sign-in, and the code itself is never
  written to state.
- **A box's sign-ins are its owner's.** Log in, the sign-in page, pasting a
  code, Cancel, and Update now go only to the box's owner (`boxOwner`: who let
  it in, else the first household owner). Another household owner sees the
  card but has nothing to press, and the calls answer 403.
- **Log in always starts something that's alive.** The box tells loom which
  sign-ins its runner has going. A sign-in handed to an earlier runner (the
  runtime restarted) or one the runner lost is marked failed with the reason,
  and **Log in** starts a fresh one. So is one older than 16 minutes, or one on
  a box that's been silent for 2 minutes since the later of its last poll and
  the sign-in's start. That includes one the box never picked up. A runner that goes down tells loom first ("the
  runtime restarted during the sign-in; start again") and stops its sign-in
  containers. A runner that starts removes any sign-in container left behind,
  found by their `loom.cli` label. If podman can't list or remove them, it logs
  that and tries again on each poll until it works once.
- **The pasted code.** It's never written to loom's state. It waits in the
  user's runtime dir (`$XDG_RUNTIME_DIR`, a tmpfs) for the box's next poll,
  goes to the CLI's stdin on that box once, and is deleted. A code nobody picks
  up expires after 10 minutes. It crosses the box's channel to loom, so that
  channel must be HTTPS or the tailnet. A box that joined over plain HTTP
  outside the tailnet refuses to run a login.
- **What the box reports.** Each box asks the CLIs' own status commands
  (`claude auth status --json`, `codex login status`) whether they're installed
  and logged in, and reports that, with the auth method and plan. For Claude it
  also reports a short hash of the org and account, so boxes on the same account
  share its quota. The email stays on the box. loom keys an account by the
  box's owner and that hash, salted with a secret of the household's own, so
  one owner's box can't merge into another owner's account. Bodies and agent
  owners see only a label ("Claude Max (jonathan's)"), never the key.
  A status check runs in a fresh container with no network, and neither CLI
  can tell offline who the account is. So the box also asks each CLI who it
  is, with the network, after a login and every 6 hours: Claude after a
  start-up that fetches its profile (`claude mcp list`, which spends no
  usage), Codex through its app server's `account/read`. Only a hash of the
  org (or account id) and email is reported. A check that can't reach the
  provider keeps the last answer (and tries again in 30 minutes, not every
  status check). A box not seen lately offers nothing, but its readings
  still count for the account. A login never named is an account of its
  own (t-1913: box `one` and loom's machine, on one Claude Max and one Codex
  Pro, showed as four accounts).
  A box knows a login exists only because the CLI's status says so. loom never
  opens a credential file.
- **Renew before a login ends.** When the CLI reports a hard sign-in deadline
  (Claude's `loginExpiresAt`), the runtime keeps that date with the box's login.
  Within ten days, Inbox warns which login on which box needs renewal; the box
  offers **Renew login**, opening its existing owner-only CLI sign-in flow.
  The warning becomes urgent within three days and says when it has expired.
  Alerts fire on each urgency change and otherwise daily. A renewed deadline
  outside the warning window clears the alert automatically. Missing dates
  remain unknown: loom never infers a hard deadline from an access token, and
  never reads credentials. Codex currently reports no hard deadline through
  its status command. Each box's login is renewed separately, even when
  several boxes share one subscription's quota.
- **Houses use their box's login.** A house file that says
  `"harnesses": ["claude"]` (what it, or one of its services, runs) gets the
  box's login for those harnesses and no other, mounted at
  `/run/loom/login/<harness>`. For Claude, `CLAUDE_SECURESTORAGE_CONFIG_DIR`
  points the house's own `claude` at it, and the house keeps its own settings.
  For Codex, `LOOM_LOGIN_CODEX` says where it is. The house links
  `$CODEX_HOME/auth.json` to `$LOOM_LOGIN_CODEX/auth.json`, and Codex refreshes
  it in place through the link. The house keeps its own `CODEX_HOME`, so its
  config and transcripts aren't shared. A box that isn't logged in
  doesn't start such a house, and says how to fix it. The runtime offers a
  harness for an agent only where a box that may run the agent reports it
  logged in.
- **Usage comes from the harness's own output, as houses report it.** Claude
  Code's stream-json `rate_limit_event` and Codex's `token_count` events (in the
  session files under the house's own `CODEX_HOME`) say how full each usage
  window is. A house reports them with
  `loom runtime usage report --harness claude|codex`. A body the runtime's body
  host starts reports too, when its turn ends: a `claude --bg` body writes no
  stream-json, so the runner gives it a status line (`src/statusline.mjs`),
  which Claude Code runs for a background session as well, with its
  `rate_limits`; only those are kept, by session, in
  `~/.local/state/loom-runtime/usage` (`LOOM_RUNTIME_USAGE_DIR`). A Codex body's
  reading is the last `token_count` in its thread's rollout. Another body host
  (shuttle's) can do the same with `loom runtime usage statusline` as the
  status line and `usage report --harness claude --session <id>`. The box reads none itself:
  its shared login dir holds only the credential file. A house can report only
  for a login it was given. The owner-only rule bounds what a wrong reading can
  do: it's the owner's own agent, misreporting the owner's own account, which
  can make the resolver skip or overuse that one account. Values are clamped
  (utilization 0 to 1, a reset within 8 days). The model resolver skips an
  account whose window is full. An account on several boxes has one quota:
  per window, the newest reading from any of its boxes or houses; a box that
  has read nothing adds nothing, so it can't make a full account look roomy;
  a full window whose reset has passed counts as reset; only an account with
  no reading at all counts as having room (`src/accounts.mjs`).

**Which houses get a box's login.** Only a house whose agent's owner owns the
box, and only the logins the owner granted that agent (`loom box agent <agent>
--logins claude,codex|none|default`, or the agent's form). By default a
household owner's own agents get both, and any other member's agent gets none.
A box lent to another member's agent runs that agent's work, but never on the
box owner's login. The model resolver offers an account by exactly the rule the
claim mounts a login by, so it never offers what a house won't be given. A box
not seen for 10 minutes offers nothing. The login dir is mounted read-write on purpose: the CLI
refreshes its token in place, and the refresh token rotates, so copies per
house would revoke each other.

**Why not a narrower token, or a read-only mount.** A program on the box that
refreshed the login and handed each house a short-lived token would be the
broker the providers' terms rule out, and the one this replaced. A read-only
mount breaks the CLI's own refresh. So the login dir is mounted read-write
(`nosuid,nodev,noexec`), and what's narrowed is who gets it: only the harnesses
a house runs, only on its agent's owner's own box, only with the owner's grant.

**The box runs its own CLI in a throwaway container.** A house can write the
shared login dir. It could plant a Codex `config.toml` with a `notify` command,
or swap the credential file for a symlink to one of the box's files between any
check the box makes and the CLI's open. A CLI running on the box would then run
that command, or read and write through that link as the box's user. So the box
never runs `claude` / `codex` itself. Its status checks and logins each run in
a `podman run --rm` container:

- The shared login dir is the only mount, at the path houses use (`rw,nosuid,nodev,noexec`).
- Config and home are the container's own: a tmpfs plus its own overlay, gone when it ends.
- It runs with no capabilities and `no-new-privileges`. A status check gets no network; a login, and the identity check, get the network they need to reach the provider (the identity check is the CLI's own start-up, with the same login a house of the same image gets with the network anyway).

Any symlink therefore resolves inside the container, where nothing of the box's
is. The box process itself never opens a path in the shared dir.

- **Claude:** `CLAUDE_CONFIG_DIR` is the container's tmpfs, and
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` is the mounted dir. The CLI reads and
  writes its credential there in place, and never reads settings or hooks from
  it. Checked with Claude Code 2.1.316: a run with that split fired none of the
  14 hooks in the secure-storage dir's `settings.json`, and the same run without
  the split fired 9. `claude auth status` works offline.
- **Codex:** `CODEX_HOME` is the container's tmpfs. For a status check, its
  `auth.json` is a link (made in the container) to the mounted file;
  `codex login status` doesn't write it (codex-cli 0.162.1, checked). A login
  runs in the container's own home, and its new `auth.json` is then put in the
  mounted dir by a rename, inside the container.
- **The image** is one that has both CLIs. It's `LOOM_RUNTIME_LOGIN_IMAGE` if
  the box's owner set one. Otherwise it's the newest house image built on this
  box for an agent that may use that login (its owner owns the box and granted
  it). That agent's houses get the login anyway, so its image sees nothing new.
  A box with no container runtime, or no such image yet, can't offer logins,
  and its page says why. A first house of the agent builds the image, even when
  it then can't start for want of a login.

Before every use, the box lstats the shared credential file (it never opens
it). It must be a plain file of the box's user, or the box doesn't use that
login, and its page shows it as unhealthy. The lstat is for reporting only;
the container is what keeps a swapped link off the box. Before each mount, the shared dir is cut down to that file and
the CLI's own temp and lock files beside it.

**What that leaves open.** An agent in a house that has its owner's login can
read the login file. It's the owner's own agent, on the owner's own box, using
the owner's own subscription. That's the same reach a program the owner runs on
their own laptop has, and the reason the grant exists. That agent can also
replace the login file with another login (its own `auth.json`, say), and the
box and the owner's other houses would then run on that. It's the owner's own
agent swapping the owner's login, within the same grant. loom accepts that and
doesn't try to detect it, because detecting it would mean reading the file.

**Usage readings.** A house's rollout file is read only if it's a regular
file, never through a symlink, and only its last 256 KB.

**loom never handles a model login.** It never reads, stores, copies, refreshes
or issues a token. It never calls a provider's API, and it never pretends to be
a provider's own client. A login stays on the box it was made on.

## API keys

An API key is the developer path, and it's just a secret. Put it in the secrets
store and map it into an agent's houses as `anthropic-api-key` or
`openai-api-key`. The house file puts it where the harness reads it:
`{"env": "ANTHROPIC_API_KEY"}` or `{"env": "OPENAI_API_KEY"}`. The resolver
counts it as an account for that agent on any box.

## Whose box runs whose agent

An agent's houses and bodies run only on boxes owned by that agent's owner. A
box's owner is a household member: the first household owner unless set
(Boxes, Manage boxes, "Whose it is"). An agent's owners are the members who
list it. An agent nobody lists belongs to the household owners. A box's owner
can lend it to another member's agent by name ("Lend"). Without that loan, the
agent's work doesn't run there, and the box's logins don't count for it. That
keeps each subscription doing its owner's work when two people share one loom.

## What a subscription is for

A Claude or ChatGPT subscription belongs to one person, and it's for that
person's own work. Their agents doing their work counts. So do a few colleagues
bringing that agent work in a small, private workspace, because it's still the
owner's agent doing the owner's work.

Serving the public, or a large community, through a subscription is against
the providers' terms. Anthropic's terms say subscription logins are for
"ordinary use of Claude Code and other native Anthropic applications". Their
usage policy rules out "services that route requests through consumer
subscriptions". For that kind of work, use an API key. It's a poor fit anyway: a
bridge runs only a few bodies per agent, and one subscription's limits are
shared by everything on it.

loom explains this. It doesn't enforce it in code. Which work belongs on whose
subscription is the owner's call.

## Owner model preference

An agent's Houses tab offers Auto, Claude and Codex. A thread can override that
choice in its Comms menu. Auto on a thread follows its agent's preference; Auto
on an agent uses the existing model preferences and scorecards. The runtime API
`model-choice` reads `{agent?, conversation?}` and saves
`{agent?, conversation?, harness: "auto"|"claude"|"codex"}` for an authenticated
owner. A conversation's actual agent is read from its record. Agent tokens cannot
change the choice, and agent owners cannot change another agent's choice.

A saved choice affects new turns and does not interrupt a running turn. It
prefers models on the selected harness over cross-harness scorecard ranking,
while retaining the model allow-list, tool restrictions and quota checks. When
that harness is unavailable the same resolver chooses an available fallback.
Switching back can resume the conversation's saved session. The preference is
stored by the runtime in `state.json` under `modelChoices`, separate from model
allow-lists; it grants no new model or tool access.

## Worker capacity: keeping room for conversations (t-2037)

The allocator (`src/allocator.mjs`) decides whether a **new worker job** may start on an account: a handed-off job
(spawn) or a wake. It keeps a reserve per account window for conversations until that window resets: the larger of a
floor (5%) and the conversations' forecast use until the reset, plus a 50% margin. Both numbers are first guesses, to
be checked against the shadow log. The forecast comes from the readings history (`allocator-readings.jsonl`), using
only intervals in which no worker body was held on that account. A job's own use is a guess too: 3% of an hourly
window and 0.5% of a daily or weekly one, the same for each job already running on that account.

- **Off (the default, "shadow"):** nothing changes. Each start logs, without any brief or text, what admission would
  have decided and why, in `allocator-shadow.jsonl`.
- **On ("enforce", the household owner's switch under *Worker capacity* on the runtime page):** a new worker job only
  takes an account that leaves the reserve. Of a model's accounts, it takes the one with the most headroom. A model
  whose accounts are all kept for conversations counts as having no room, so the next eligible model (a Codex model,
  for example) is chosen as an ordinary pick. When every model with room is kept, the job **waits**: its messages stay
  queued, it is not failed, and the owner gets no alert. It is checked again within 15 minutes, or at the reset if
  that comes sooner. The deferral is logged with `enforced: true`.
- **Never gated:** live conversations (the final chat fallback), including a terminal session.
- **A job that has already run** (it has an assigned model) is checked again each time it continues. If its own
  account is short of the reserve, it waits, keeping its session and messages, and is checked again within 15
  minutes. It moves only if its spawn allowed a failover and another eligible model has headroom. Its lineage then
  says it was "kept for conversations; failover allowed".

## The local Claude daemon

The legacy machine daemon uses the native CLI's private `~/.claude` login,
not the shared house login. Renewing one never renews the other. On loom's
own box only, `"machineClaudeLogin":true` in `LOOM_RUNTIME_LOCAL_BODIES` adds **Claude on this
machine** to its Model logins panel. Its separate expiry warning leads to
that row; Renew login runs the native CLI's own login against its own trusted
config. The same owner-only flow takes the provider code. Status uses only
`claude auth status --json`; no credential is read or copied by loom.

This is an explicit exception for the trusted local daemon, not the box's
shared login runner. It never points a host CLI at the shared login dir.
Remote boxes cannot report or request this target, houses never get this
private login, and it is never offered as a house account. A failed/cancelled
renewal cannot count the old, still-working login as successful: the CLI must
exit successfully and extend the reported hard deadline.

## Short read-only calls (t-2145)

`loom-runtime oneshot --cwd <frozen-directory> [--prefer <model>] [--timeout <seconds>]`
reads its prompt from stdin and prints only the final answer. Cold reviews use this
entry point. It runs in a runtime house, using that house's mounted box logins;
calling it on a machine outside a house fails explicitly. A missing runtime is
never permission to launch another harness directly. Host callers must run their
review in a house until trusted native one-shots have an account binding.

The control-plane `oneshot-choice` API accepts only the calling agent's running
house. It derives accounts from that house's box and mounted harnesses, intersects
them with the agent's model allow-list, and uses `resolveFor`: the same owner
harness preference, per-agent model order, scorecards and 97% quota boundary as
bodies. A one-shot uses the worker reserve when the owner enabled enforcement, with
the same in-flight worker counts and forecast as ordinary worker admission.
Without an explicit preference, a body host supplies its assigned model through
`LOOM_BODY_MODEL`, so a Codex job reviews on Codex. A per-call `--prefer` is a
preference, never an account or allow-list override. The owner’s saved harness
choice still wins when it has room.
The API returns a model, harness, account label and reasons; never an account key
or credential. It does not accept another agent or box from the caller.

The CLI runs Claude in safe mode or Codex with a read-only sandbox and a fresh
Codex home linked to its existing auth file. Hooks and skill-driven MCP installs
are disabled. System or project Codex configuration layers that the fresh home
cannot replace cause refusal before launch, using the canonical runner’s
`codexLayers` check, so an external MCP write tool cannot bypass the sandbox. A caller supplies a frozen tree
outside any instruction-bearing checkout. Read-only Codex can read outside the
working tree: this is a review isolation convention, not a filesystem secrecy
boundary. Do not put secrets in the review tree. Prompts go on stdin, never argv;
neither prompt nor answer is sent to the choice API. Usage comes from Claude's
stream events or Codex's temporary session rollout and is reported through the
existing house `usage` API before the temporary home is removed. The account-wide
reading then appears in `loom runtime accounts usage`. It is measured account
quota, not a fabricated token cost per review. No reading means an explicit warning
and the previous measurement remains; execution failures are never retried as
quota failures.

A structured usage-limit refusal holds only the house's own account through
`oneshot-refused` and retries once with that harness avoided. No prose classifier,
no unbounded retries, and no retry on timeout or an ordinary process error. A
second refusal fails. Near-cap choice happens before execution. Choice and launch
are not an atomic capacity reservation: concurrent calls may consume headroom
between readings; cold review retains its existing concurrency gate.

Blind grading is a deliberate choice constraint: it grades across families, not
according to the producing agent's favorite model. `graderPool` uses the same
account derivation and `hasRoom`, plus the worker reserve when enabled; `pickGraders` retains
its independence rules and least-producing-model rule. A family with no room is
skipped, never quietly substituted with the producer's family. Grading uses the
owner's pinned container image and egress proxy; the one-shot API does not replace
that privacy boundary. Claude stream events and Codex rollout quota metadata are
reported into the same local box account readings. Codex's rollout exists only
inside the disposable container, until quota extraction, then goes with it.
The grader image must be rebuilt after `grader/quota.mjs` is added.

Native harness subagents are work inside a runtime-selected body: they share its
account, and their use reaches that account's next quota reading. They must inherit
the parent's model; independent work requiring its own model uses runtime spawn.
Remote-control remains a Claude-only vendor interface, with no Codex substitute
for that interface; its profile preflight uses `claude mcp list`, with no model
call. Old shuttle runners remain compatibility paths pending bridge retirement;
they are inventoried exceptions, not a new entry point to copy.
