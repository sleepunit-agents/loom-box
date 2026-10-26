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
//     "hostname": "art-house",
//     "attach": ["/home/art/Art/house/attach"],    what `loom box attach` runs in a session house
//     "ports": ["7401", "127.0.0.1:4747"],         a port published on the box (same number
//                                                   inside): only ones the owner allows this agent,
//                                                   bound where the owner's grant says
//     "tailnets": { "fleet": "/run/tailscale-fleet.sock" }   a tailscaled's socket, by the name the
//                                                   owner granted it under, at this path inside:
//                                                   `tailscale --socket=<path> status|ping|nc`
//   }
//
// Files land under /run/secrets/<file> (podman secrets, 0400). LOOM_URL,
// HOUSE_ID and HOUSE_AGENT are always set; nothing from the box's own
// environment or filesystem goes in.
import { SECRET_NAME } from './state.mjs';

export class HouseFileError extends Error {}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const RESERVED_ENV = new Set(['LOOM_URL', 'HOUSE_ID', 'HOUSE_AGENT', 'HOUSE_TASK', 'HOUSE_SERVICE', 'HOUSE_SESSION', 'PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH']);
const MOUNT_KINDS = new Set(['state', 'nested', 'mirror']);
const REL_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const ABS_PATH = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const HOSTNAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PORT = /^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{4,5})$/;
const TAILNET = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * The owner's grant of one tailnet: "fleet=/run/tailscale-fleet/tailscaled.sock",
 * a name and the box's tailscaled socket for it. Null if it isn't one.
 */
export function parseTailnetGrant(g) {
  if (g && typeof g === 'object') g = `${g.name}=${g.socket}`;
  const m = typeof g === 'string' ? /^([^=]+)=(.+)$/.exec(g) : null;
  return m && TAILNET.test(m[1]) && ABS_PATH.test(m[2]) && m[2].endsWith('.sock') ? { name: m[1], socket: m[2] } : null;
}

/** The capabilities nested containers need, and nothing more (Art's tank, t-1473). */
export const NESTED_ARGS = ['--cap-add=SYS_ADMIN,NET_ADMIN,SYS_PTRACE', '--device', '/dev/net/tun', '--security-opt', 'unmask=/proc/sys'];

const fail = (m) => { throw new HouseFileError(m); };

/**
 * The owner's grant of one port: "7401" binds loopback (127.0.0.1), and an
 * address in front ("0.0.0.0:7401", "192.168.6.30:7401") binds there. Null if
 * it isn't one.
 */
export function parsePortGrant(g) {
  if (g && typeof g === 'object') g = `${g.ip}:${g.port}`;
  const m = typeof g === 'string' || typeof g === 'number' ? PORT.exec(String(g)) : null;
  const n = m ? Number(m[2]) : NaN;
  if (!m || n < 1024 || n > 65535 || (m[1] && m[1].split('.').some((o) => Number(o) > 255))) return null;
  return { ip: m[1] ?? '127.0.0.1', port: n };
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const relOk = (p) => typeof p === 'string' && REL_PATH.test(p) && !p.split('/').some((s) => s === '.' || s === '..');
const absOk = (p) => typeof p === 'string' && ABS_PATH.test(p) && !p.split('/').some((s) => s === '.' || s === '..');

/** The parts a house and each of its services share: what runs, with what. */
function runSpec(h, where, { task: allowTask }) {
  let command = null;
  if (h.command !== undefined) {
    if (!Array.isArray(h.command) || !h.command.length || h.command.length > 32 || !h.command.every((c) => typeof c === 'string' && c.length <= 400)) {
      fail(`${where}command is a list of up to 32 strings`);
    }
    command = h.command;
  }
  let task = null;
  if (allowTask) {
    task = h.task ?? 'stdin';
    if (task !== 'stdin' && task !== 'env') fail('task is "stdin" or "env"');
  }

  const secrets = {};
  const files = new Set();
  const envs = new Set();
  for (const [name, at] of Object.entries(h.secrets ?? {})) {
    if (!SECRET_NAME.test(name)) fail(`${where}secret name ${JSON.stringify(name)} has odd characters`);
    if (!isObj(at) || Object.keys(at).length !== 1) fail(`${where}secret ${name} goes to one place: {"file": …} or {"env": …}`);
    if ('file' in at) {
      if (!SECRET_NAME.test(at.file ?? '') || files.has(at.file)) fail(`${where}secret ${name}: the file is a plain name, used once`);
      files.add(at.file);
      secrets[name] = { file: at.file };
    } else if ('env' in at) {
      if (!ENV_NAME.test(at.env ?? '') || RESERVED_ENV.has(at.env) || envs.has(at.env)) fail(`${where}secret ${name}: ${at.env} can't be its variable`);
      envs.add(at.env);
      secrets[name] = { env: at.env };
    } else fail(`${where}secret ${name} goes to {"file": …} or {"env": …}`);
  }
  if (Object.keys(secrets).length > 32) fail(`${where}at most 32 secrets`);

  const env = {};
  for (const [k, v] of Object.entries(h.env ?? {})) {
    if (!ENV_NAME.test(k) || RESERVED_ENV.has(k) || envs.has(k)) fail(`${where}env ${k} isn't allowed`);
    if (typeof v !== 'string' || v.length > 2000 || /[\x00-\x1f]/.test(v)) fail(`${where}env ${k} is a plain string`);
    env[k] = v;
  }

  const mounts = {};
  const targets = new Set();
  for (const [kind, target] of Object.entries(h.mounts ?? {})) {
    if (!MOUNT_KINDS.has(kind)) fail(`${where}mount ${kind}: a house can mount only state, nested and mirror`);
    if (!absOk(target) || target === '/' || targets.has(target) || target === '/run/secrets' || target.startsWith('/run/secrets/')) fail(`${where}mount ${kind}: ${target} isn't a usable path`);
    targets.add(target);
    mounts[kind] = target;
  }
  if (h.nested !== undefined && typeof h.nested !== 'boolean') fail(`${where}nested is true or false`);
  if (h.hostname !== undefined && !HOSTNAME.test(h.hostname)) fail(`${where}hostname is lowercase letters, digits and dashes`);
  const ports = [];
  if (h.ports !== undefined) {
    if (!Array.isArray(h.ports) || h.ports.length > 8) fail(`${where}ports is a list of up to 8`);
    for (const p of h.ports) {
      const m = typeof p === 'string' ? PORT.exec(p) : null;
      const n = m ? Number(m[2]) : NaN;
      if (!m || n < 1024 || n > 65535 || (m[1] && m[1].split('.').some((o) => Number(o) > 255))) fail(`${where}port ${JSON.stringify(p)}: a number from 1024, optionally after an IPv4 address to bind ("127.0.0.1:4747")`);
      if (ports.some((q) => q.port === n)) fail(`${where}port ${n} is listed twice`);
      ports.push({ ip: m[1] ?? null, port: n });
    }
  }
  const tailnets = {};
  if (h.tailnets !== undefined) {
    if (!isObj(h.tailnets) || Object.keys(h.tailnets).length > 4) fail(`${where}tailnets is an object of up to 4`);
    for (const [name, target] of Object.entries(h.tailnets)) {
      if (!TAILNET.test(name)) fail(`${where}tailnet ${JSON.stringify(name)}: lowercase letters, digits and dashes`);
      if (!absOk(target) || targets.has(target) || target === '/run/secrets' || target.startsWith('/run/secrets/')) fail(`${where}tailnet ${name}: ${target} isn't a usable path`);
      targets.add(target);
      tailnets[name] = target;
    }
  }
  return { command, task, secrets, env, mounts, nested: !!h.nested, hostname: h.hostname ?? null, ports, tailnets };
}

const SERVICE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const RUN_KEYS = ['command', 'secrets', 'env', 'mounts', 'nested', 'hostname', 'ports', 'tailnets'];

/**
 * Validate a house file. Anything unexpected is refused, not ignored. A house
 * file may also name services: long-lived houses from the same image, each
 * with its own command, secrets, env and mounts, and no task. A service's
 * `state` mount is the state that travels with it (a bridge's read position).
 */
export function parseHouseFile(text) {
  let h;
  try { h = JSON.parse(text); } catch (e) { fail(`the house file isn't JSON (${e.message})`); }
  if (!isObj(h)) fail('the house file is a JSON object');
  const known = new Set(['build', 'task', 'services', 'attach', ...RUN_KEYS]);
  for (const k of Object.keys(h)) if (!known.has(k)) fail(`the house file has an unknown key: ${k}`);

  if (!isObj(h.build) || !relOk(h.build.containerfile) || !relOk(h.build.context)) {
    fail('build needs a containerfile and a context, each a path inside the repo');
  }
  for (const k of Object.keys(h.build)) if (!['containerfile', 'context'].includes(k)) fail(`build has an unknown key: ${k}`);

  const services = {};
  if (h.services !== undefined) {
    if (!isObj(h.services) || Object.keys(h.services).length > 16) fail('services is an object of up to 16 services');
    for (const [name, sv] of Object.entries(h.services)) {
      if (!SERVICE_NAME.test(name)) fail(`service name ${JSON.stringify(name)}: lowercase letters, digits and dashes`);
      if (!isObj(sv)) fail(`service ${name} is an object`);
      for (const k of Object.keys(sv)) if (!RUN_KEYS.includes(k)) fail(`service ${name} has an unknown key: ${k}`);
      services[name] = runSpec(sv, `service ${name}: `, { task: false });
    }
  }
  // What `loom box attach` runs in a session house, at a terminal: the house's own shell by default.
  let attach = ['sh'];
  if (h.attach !== undefined) {
    if (!Array.isArray(h.attach) || !h.attach.length || h.attach.length > 16 || !h.attach.every((c) => typeof c === 'string' && c.length <= 400)) fail('attach is a list of up to 16 strings');
    attach = h.attach;
  }
  return { build: { containerfile: h.build.containerfile, context: h.build.context }, ...runSpec(h, '', { task: true }), services, attach };
}

/** What runs for one house: the house itself, or one of its services. */
export function specFor(house, service) {
  if (!service) return house;
  const sv = house.services[service];
  if (!sv) throw new HouseFileError(`the house file has no service ${service}`);
  return { ...sv, build: house.build };
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
export function runArgs(house, { id, agent, loomUrl, task, service, session, image, dirs, allowNested, allowPorts = [], allowTailnets = [] }) {
  // --init: a real PID 1 (catatonit) that reaps orphans. Without it the house's
  // own program is PID 1; every grandchild whose parent exits (claude's git
  // calls) is reparented to it and never reaped, until the pids limit is full
  // and nothing in the house can fork. The Slack and Discord bridges jammed
  // that way on 2026-10-26 (2033 zombie git), still "up" but answering no one.
  const args = ['run', '--rm', '--init', '--name', containerName(id), '--hostname', house.hostname ?? `${agent}-house`];
  if (house.task === 'stdin') args.push('-i');
  // A service runs until it's stopped; podman stop gives it this long to finish.
  if (!house.task) args.push('--stop-timeout', '25');
  if (house.nested) {
    if (!allowNested) throw new HouseFileError(`${agent}'s house asks for nested containers, and the owner hasn't allowed that`);
    args.push(...NESTED_ARGS);
  }
  // The owner's grant says where each port binds (loopback unless it names an
  // address); the house file only asks for the port, or for exactly that address.
  for (const { ip, port } of house.ports ?? []) {
    const grant = allowPorts.find((g) => g.port === port);
    if (!grant) throw new HouseFileError(`${agent}'s house asks to publish port ${port}, and the owner hasn't allowed that`);
    if (ip && ip !== grant.ip) throw new HouseFileError(`${agent}'s house asks to publish port ${port} on ${ip}; the owner allowed it on ${grant.ip}`);
    args.push('-p', `${grant.ip}:${port}:${port}`);
  }
  // A tailnet is the owner's grant too: the house names it, the grant says which socket on the box.
  for (const [name, target] of Object.entries(house.tailnets ?? {})) {
    const grant = allowTailnets.find((g) => g.name === name);
    if (!grant) throw new HouseFileError(`${agent}'s house asks for the ${name} tailnet, and the owner hasn't allowed that`);
    args.push('-v', `${grant.socket}:${target}`);
  }
  for (const [name, where] of Object.entries(house.secrets)) {
    const ps = podmanSecret(id, name);
    if (where.file) args.push('--secret', `${ps},type=mount,target=${where.file},mode=0400`);
    else args.push('--secret', `${ps},type=env,target=${where.env}`);
  }
  for (const [k, v] of Object.entries(house.env)) args.push('-e', `${k}=${v}`);
  args.push('-e', `LOOM_URL=${loomUrl}`, '-e', `HOUSE_ID=${id}`, '-e', `HOUSE_AGENT=${agent}`);
  if (house.task === 'env') args.push('-e', `HOUSE_TASK=${task}`);
  // A session house waits for someone to attach, instead of working a task.
  if (session) args.push('-e', 'HOUSE_SESSION=1');
  if (!house.task) args.push('-e', `HOUSE_SERVICE=${service}`);
  for (const [kind, target] of Object.entries(house.mounts)) {
    const src = dirs[kind];
    if (!src) throw new HouseFileError(`no ${kind} dir for this house`);
    args.push('-v', `${src}:${target}${kind === 'mirror' ? ':ro' : ''}`);
  }
  args.push(image, ...(house.command ?? []));
  return args;
}
