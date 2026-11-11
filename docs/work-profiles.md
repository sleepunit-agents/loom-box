# Work tool profiles

Scheduled and agent jobs get the work tool profile by default. Claude uses a private
strict MCP file assembled from its usual global and project MCP definitions, keeping
only loom, github, gh-art/gh_art and taskstore. Codex filters those same servers and
passes `--disable apps --disable remote_plugin`, using a distinct generated home.
Shell and coding tools remain available; `gh-art` and taskstore need no MCP schema.
Existing deny flags remain in force. A conflicting custom Claude MCP config or Codex
config layer fails the lean launch rather than silently loading extra connectors.
`LOOM_RUNTIME_WORK_PROFILE=off` restores the ordinary tool profile.

The start brief asks identity for `profile: work`. Core needs the matching optional
identity API and the agent's authored `work-identity.md` (at most 8000 bytes). Missing,
empty or oversized files fall back to the full identity. Owners, room, project,
explicit role/project context, client adapter restrictions and health warnings are
preserved. Full identity remains available on demand. Install core before runtime.
