smol-toml 1.9.1 (https://github.com/squirrelchat/smol-toml, BSD-3-Clause, see LICENSE): its `dist/*.js`, unchanged,
from the npm tarball (`npm pack smol-toml@1.9.1`). Vendored, not a dependency: a house runs this piece from a git
checkout with no `npm install` (loom-box house/install-tools). The Codex runner reads a Codex config.toml with it
(runners.mjs, t-1916).
