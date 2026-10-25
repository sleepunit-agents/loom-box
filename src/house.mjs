// A house is a container, and only a container (loom docs/specs/runtime.md,
// "Decided 2026-10-25"). The agent's repo describes it in its house file
// (default house/house.json); the box builds the image and runs it with
// podman itself, so no agent code ever runs on the box outside a container.
//
//   {
//     "build": { "containerfile": "house/Containerfile", "context": "house" },
//     "command": ["claude", "-p"],                  optional: the image's own otherwise
//     "task": "stdin",                              or "env" (HOUSE_TASK)
//     "secrets": {                                  where each secret lands; the control
//       "loom-token":   { "file": "loom-token" },   plane decides which ones it gets
//       "claude-oauth": { "env": "CLAUDE_CODE_OAUTH_TOKEN" }
//     },
//     "env": { "ART_REPO": "https://…" },           static, plain values
//     "mounts": {                                   only the box's own per-house dirs:
//       "state":  "/home/art/.local/state",         this house's state (thrown away after)
//       "nested": "/var/lib/containers",            this house's nested-container storage
//       "mirror": "/garage/git/art.git"             the box's mirror of the repo, read-only
//     },
//     "nested": true,                               wants the nested-container capabilities:
//                                                   only if the owner allows it for this agent
//     "hostname": "art-house"
//   }
//
// Files land under /run/secrets/<file> (podman secrets, 0400). LOOM_URL,
// HOUSE_ID and HOUSE_AGENT are always set; nothing from the box's own
// environment or filesystem goes in.
import { SECRET_NAME } from './state.mjs';

export class HouseFileError extends Error {}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const RESERVED_ENV = new Set(['LOOM_URL', 'HOUSE_ID', 'HOUSE_AGENT', 'HOUSE_TASK', 'PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH']);
const MOUNT_KINDS = new Set(['state', 'nested', 'mirror']);
const REL_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const ABS_PATH = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const HOSTNAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The capabilities nested containers need, and nothing more (Art's tank, t-1473). */
export const NESTED_ARGS = ['--cap-add=SYS_ADMIN,NET_ADMIN,SYS_PTRACE', '--device', '/dev/net/tun', '--security-opt', 'unmask=/proc/sys'];

const fail = (m) => { throw new HouseFileError(m); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const relOk = (p) => typeof p === 'string' && REL_PATH.test(p) && !p.split('/').some((s) => s === '.' || s === '..');
const absOk = (p) => typeof p === 'string' && ABS_PATH.test(p) && !p.split('/').some((s) => s === '.' || s === '..');

/** Validate a house file. Anything unexpected is refused, not ignored. */
export function parseHouseFile(text) {
  let h;
  try { h = JSON.parse(text); } catch (e) { fail(`the house file isn't JSON (${e.message})`); }
  if (!isObj(h)) fail('the house file is a JSON object');
  const known = new Set(['build', 'command', 'task', 'secrets', 'env', 'mounts', 'nested', 'hostname']);
  for (const k of Object.keys(h)) if (!known.has(k)) fail(`the house file has an unknown key: ${k}`);

  if (!isObj(h.build) || !relOk(h.build.containerfile) || !relOk(h.build.context)) {
    fail('build needs a containerfile and a context, each a path inside the repo');
  }
  for (const k of Object.keys(h.build)) if (!['containerfile', 'context'].includes(k)) fail(`build has an unknown key: ${k}`);

  let command = null;
  if (h.command !== undefined) {
    if (!Array.isArray(h.command) || !h.command.length || h.command.length > 32 || !h.command.every((c) => typeof c === 'string' && c.length <= 400)) {
      fail('command is a list of up to 32 strings');
    }
    command = h.command;
  }
  const task = h.task ?? 'stdin';
  if (task !== 'stdin' && task !== 'env') fail('task is "stdin" or "env"');

  const secrets = {};
  const files = new Set();
  const envs = new Set();
  for (const [name, where] of Object.entries(h.secrets ?? {})) {
    if (!SECRET_NAME.test(name)) fail(`secret name ${JSON.stringify(name)} has odd characters`);
    if (!isObj(where) || Object.keys(where).length !== 1) fail(`secret ${name} goes to one place: {"file": …} or {"env": …}`);
    if ('file' in where) {
      if (!SECRET_NAME.test(where.file ?? '') || files.has(where.file)) fail(`secret ${name}: the file is a plain name, used once`);
      files.add(where.file);
      secrets[name] = { file: where.file };
    } else if ('env' in where) {
      if (!ENV_NAME.test(where.env ?? '') || RESERVED_ENV.has(where.env) || envs.has(where.env)) fail(`secret ${name}: ${where.env} can't be its variable`);
      envs.add(where.env);
      secrets[name] = { env: where.env };
    } else fail(`secret ${name} goes to {"file": …} or {"env": …}`);
  }
  if (Object.keys(secrets).length > 32) fail('at most 32 secrets');

  const env = {};
  for (const [k, v] of Object.entries(h.env ?? {})) {
    if (!ENV_NAME.test(k) || RESERVED_ENV.has(k) || envs.has(k)) fail(`env ${k} isn't allowed`);
    if (typeof v !== 'string' || v.length > 2000 || /[\x00-\x1f]/.test(v)) fail(`env ${k} is a plain string`);
    env[k] = v;
  }

  const mounts = {};
  const targets = new Set();
  for (const [kind, target] of Object.entries(h.mounts ?? {})) {
    if (!MOUNT_KINDS.has(kind)) fail(`mount ${kind}: a house can mount only state, nested and mirror`);
    if (!absOk(target) || target === '/' || targets.has(target) || target === '/run/secrets' || target.startsWith('/run/secrets/')) fail(`mount ${kind}: ${target} isn't a usable path`);
    targets.add(target);
    mounts[kind] = target;
  }
  if (h.nested !== undefined && typeof h.nested !== 'boolean') fail('nested is true or false');
  if (h.hostname !== undefined && !HOSTNAME.test(h.hostname)) fail('hostname is lowercase letters, digits and dashes');
  return { build: { containerfile: h.build.containerfile, context: h.build.context }, command, task, secrets, env, mounts, nested: !!h.nested, hostname: h.hostname ?? null };
}

/** Which of the house's secrets the control plane didn't hand over. */
export function missingSecrets(house, given) {
  return Object.keys(house.secrets).filter((n) => !(n in given));
}

/** The podman secret name for one of a house's secrets: its own, never shared. */
export const podmanSecret = (id, name) => `loom-${id}-${name}`;
export const containerName = (id) => `loom-house-${id}`;

/**
 * The exact `podman run` arguments for a house. Everything that goes in is
 * named here: the house's own secrets, its own dirs, plain env. `allowNested`
 * is the owner's say; the house file only asks.
 */
export function runArgs(house, { id, agent, loomUrl, task, image, dirs, allowNested }) {
  const args = ['run', '--rm', '--name', containerName(id), '--hostname', house.hostname ?? `${agent}-house`];
  if (house.task === 'stdin') args.push('-i');
  if (house.nested) {
    if (!allowNested) throw new HouseFileError(`${agent}'s house asks for nested containers, and the owner hasn't allowed that`);
    args.push(...NESTED_ARGS);
  }
  for (const [name, where] of Object.entries(house.secrets)) {
    const ps = podmanSecret(id, name);
    if (where.file) args.push('--secret', `${ps},type=mount,target=${where.file},mode=0400`);
    else args.push('--secret', `${ps},type=env,target=${where.env}`);
  }
  for (const [k, v] of Object.entries(house.env)) args.push('-e', `${k}=${v}`);
  args.push('-e', `LOOM_URL=${loomUrl}`, '-e', `HOUSE_ID=${id}`, '-e', `HOUSE_AGENT=${agent}`);
  if (house.task === 'env') args.push('-e', `HOUSE_TASK=${task}`);
  for (const [kind, target] of Object.entries(house.mounts)) {
    const src = dirs[kind];
    if (!src) throw new HouseFileError(`no ${kind} dir for this house`);
    args.push('-v', `${src}:${target}${kind === 'mirror' ? ':ro' : ''}`);
  }
  args.push(image, ...(house.command ?? []));
  return args;
}
