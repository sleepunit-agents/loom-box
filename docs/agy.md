# Antigravity runner (work in progress)

The third adapter uses the official `agy` CLI with stream-json input and
output. Each turn sends one user event on stdin, then EOF. A detached private
host writes events, diagnostics and a terminal exit witness to files; runtime
restarts never cause another prompt to be submitted. Prompts and credentials
are absent from argv. Step labels use the existing redaction gate.

Every body gets a new HOME and only the allowed entries from the configured
MCP file. Workspace MCP and plugin layers that could add servers are refused.
Individual-tool and built-in denies are refused rather than weakened. Provider
and harness environment overrides are removed. Nothing reads, links, copies or
exports an agy login. The CLI must authenticate itself on its own box, through
that box's unlocked OS keyring. This has **not yet been proved in a house**.

`house/install-agy` is an optional image-build step. It installs Google's binary
without a sign-in. Never mount or copy `.gemini`, auth profiles, or keyrings
from another machine. A sign-in is an owner card; it is not a body operation.
The script follows Google's installer; the tested binary was 1.5.4, not a
verified minimum version.

`AGY_MODELS` exports example Google-family entries; they are deliberately absent
from `DEFAULT_MODELS`. Check the box's `agy models` before adding entries.
Even a listed agy model is ineligible without an explicit model preference or
owner harness choice. Opting in puts it into the ordinary account/quota and
fallback resolver; no agent or conversation default is changed by installation.

Runner settings: `LOOM_RUNTIME_AGY` (binary), `LOOM_RUNTIME_AGY_RUNS` (private run
files), `LOOM_RUNTIME_AGY_MCP_FILE` (source of MCP definitions only). Token usage
is cumulative in result events and must not be interpreted as a subscription
quota percentage.

## Remaining before production

- Prove that an isolated HOME can use the box's existing agy keyring login,
  without copying credentials or forwarding a host keyring into a house.
- Add owner sign-in cards and verified health/account reporting for this
  authentication model. The existing Claude/Codex shared-login container path
  must **not** be reused for agy.
- Verify native conversation storage on a signed-in box. This adapter returns
  no portable slot and refuses native resume rather than guessing which files
  can safely travel. Native-history collection is not yet integrated for agy.
- Cold authorization review, then merge and catalog pin. This is not ready to
  enable. The task stays open until these requirements are met.

## Google verification

Checked against Google's own pages on November 9–10, 2026; detailed findings
are in loom note `t-1987/claims-check`. The headless guide confirms stream-json,
write-then-EOF, `step_update.state`, nested `result` and cumulative usage.
`agy --help`, `agy mcp list` with an isolated HOME, and an unauthenticated
headless run were independently exercised with the official 1.5.4 binary.
The actual binary also offers `--settings`; no strict MCP-config flag was found.

The FAQ says consumer-plan wrappers are unsupported. ACP invites custom
clients, but does not explicitly override that restriction. The terms have
broader third-party-product language than Gemini's notes acknowledged. No
claim here that Google approved loom: Jonathan's accepted account risk is the
basis for the requested build. No forum message was posted by this lane.

Sources:
- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/reference/
- https://antigravity.google/docs/mcp/
- https://antigravity.google/docs/install/
- https://antigravity.google/docs/ide/extensions/acp/
- https://antigravity.google/docs/faq/
- https://antigravity.google/terms
