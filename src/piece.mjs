// The piece's own name, through the move from `box` to `runtime` (loom docs/specs/agent-runtime.md, section 1).
//
// loom serves a piece's API at /api/<name>/… and a box credential is the role piece:<name>/<id>, so the name is
// part of the wire. loom tells an installed piece its name (LOOM_PIECE_NAME): `runtime` once it's installed under
// its new name, `box` while a household still runs it as box. Outside loom (a dev checkout, the tests) it's `box`,
// the name every enrolled box was given its credential under.
export function pieceName(env = process.env) {
  const n = env.LOOM_RUNTIME_PIECE || env.LOOM_PIECE_NAME || 'box';
  return /^[a-z][a-z0-9-]{0,39}$/.test(n) ? n : 'box';
}

/**
 * A setting by its new name or its old one: LOOM_RUNTIME_<X>, else LOOM_BOX_<X>. loom only lets a piece declare
 * settings under its own prefix, so the runtime's are LOOM_RUNTIME_*; a household that set LOOM_BOX_* keeps working.
 */
export function setting(env, x) {
  return env[`LOOM_RUNTIME_${x}`] || env[`LOOM_BOX_${x}`] || undefined;
}
