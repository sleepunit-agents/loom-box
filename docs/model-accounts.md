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
  A box knows a login exists only because the CLI's status says so. loom never
  opens a credential file.
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
  `loom runtime usage report --harness claude|codex`. The box reads none itself:
  its shared login dir holds only the credential file. A house can report only
  for a login it was given. The owner-only rule bounds what a wrong reading can
  do: it's the owner's own agent, misreporting the owner's own account, which
  can make the resolver skip or overuse that one account. Values are clamped
  (utilization 0 to 1, a reset within 8 days). The model resolver skips an
  account whose window is full.

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

**The box keeps its own CLI home.** A house can write the shared login dir, so
anything it plants there (a Codex `config.toml` with a `notify` command, Claude
settings with hooks) would run on the box if the box ran a CLI with that dir as
its home. Checking first can't make that safe, because the dir can change
between the check and the run. So the box runs its own `claude` / `codex`
(status, login) with a private home of its own
(`~/.local/share/loom-box/cli-home/<harness>`, 0700, never mounted) as home,
config and working dir. Nothing is copied:

- **Claude:** `CLAUDE_CONFIG_DIR` is the private home, and
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` is the shared dir. The CLI reads and writes
  its credential there in place, and never reads settings or hooks from it.
  Checked with Claude Code 2.1.316: a run with that split fired none of the 14
  hooks in the secure-storage dir's `settings.json`, and the same run without
  the split fired 9.
- **Codex:** `CODEX_HOME` is the private home. Its `auth.json` is a symlink to
  the shared one, so `codex login status` reads the houses' current login; it
  doesn't write the file (codex-cli 0.162.1, checked). A login runs with no link
  there. Its new `auth.json` is then renamed into the shared dir (rename(2): never
  opened) and linked again.

Before every use, the box lstats the shared credential file. It must be a plain
file of the box's user, or the box doesn't use that login, and its page shows
it as unhealthy. Before each mount, the shared dir is cut down to that file and
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
