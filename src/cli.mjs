#!/usr/bin/env node
// loom-box: loom's runtime piece (loom docs/specs/runtime.md). `loom box …`
// reaches it through loom's piece dispatch.
//
// Boxes are pets: machines enrolled once and kept (wunder, the 5090 box, a
// laptop). Houses are cattle: an agent's container on a box, built from the
// agent's repo for a task and thrown away. Nothing picks a box by itself.
//
// On loom's own machine (the control plane, and its first box):
//   loom box add <name> [--may-host a,b] [--labels x,y]   enroll a box; prints its credential once
//   loom box revoke <name>                                 revoke a box and its houses' tokens
//   loom box agent <agent> --repo <url> [--house-file house/house.json] [--nested]
//                  [--branch b] [--repo-secret <store-name>] [--secret as=from]... [--port n]...
//                  [--tailnet name=/run/…/tailscaled.sock]...
//                                                         how its house is made (--port: one it may publish;
//                                                         --tailnet: a box tailscaled.sock it may use, by name)
//   loom box primary <agent> [<box>]                       an agent's primary (default: this machine)
//   loom box rename-local                                  after renaming this machine: its box takes the new name
//   loom box remote up <agent> [--box b] [--dir /path]     a box session: Claude's remote-control on the box itself,
//                                                         in the agent's folder there (the box's whole reach; take it down after)
//   loom box remote down <agent>
//   loom box run --local                                   run houses here (a user service)
// Anywhere (here as the owner; elsewhere with LOOM_URL + LOOM_TOKEN_FILE, as that token):
//   loom box up [--agent a] [--box b] [--needs gpu:5090] [--slot s] --task <text|->   ask for a house
//                                                         (--slot: its bookkeeping, restored and saved; one house at a time)
//   loom box slot seed <name> --from <dir> | slot state <name> --to <dir>   a slot's state (the owner's)
//   loom box list [--json]   |   loom box down <house>
//   loom box session [--agent a]                           a house with an interactive session, here, at this terminal
//   loom box attach <house>                                into a session house on this box (again)
//   loom box service up <name> [--agent a] [--box b]       a long-lived house (a bridge), kept up
//   loom box service move <name> <box> [--force]           hand it off: stopped there, then started here
//   loom box service down <name>
//   loom box service seed <name> --from <dir>             its starting state (a bridge moving in)
//   loom box service state <name> --to <dir>              its saved state, unpacked (a bridge moving out)
// On a box:
//   loom box join <loom-url> --name <name> [--labels x,y]  asks loom; the owner lets it in on the page
//                                       [--credential]     or: a credential from Add a box, on stdin or prompted
//   loom box run                                           poll and run houses (a user service)
// For loom (the piece contract):
//   loom box ui --json | ui page --json | ui act --json | api --json
//   loom box bundle export | bundle import [--force]       its part of loom's bundle
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { addBox, api, down, list, remoteDown, remoteUp, revokeBox, setAgent, setPrimary, up } from './control.mjs';
import { realEffects } from './effects.mjs';
import { act, manifest, page } from './ui.mjs';
import { askToJoin, BoxError, joinLoom, loadConfig, packState, POLL_MS, remoteClient, restoreState, runner, runMode } from './box.mjs';
import { localBoxName, renameLocal, stateDir } from './state.mjs';
import { exportPart, importPart } from './bundle.mjs';
import { PART_RAW, joinParts, partsOf } from './blobs.mjs';

const USAGE = readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').slice(1).filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n') + '\n';

class Fail extends Error { constructor(m, code = 1) { super(m); this.code = code; } }

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flags = (args, name) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]] : []));
const positional = (args) => args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));

async function readStdin() {
  let s = '';
  for await (const d of process.stdin) s += d;
  return s;
}

async function prompt(question) {
  if (!process.stdin.isTTY) return (await readStdin()).trim();
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // No echo: the credential is a secret.
  rl._writeToOutput = () => {};
  process.stderr.write(question);
  const answer = await new Promise((r) => rl.question('', r));
  rl.close();
  process.stderr.write('\n');
  return answer.trim();
}

/** As the owner on loom's own machine, or remote through loom's piece API with LOOM_URL + LOOM_TOKEN_FILE. */
function ownerOrRemote(env) {
  if (env.LOOM_URL && env.LOOM_TOKEN_FILE) {
    const base = env.LOOM_URL.replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
    const token = readFileSync(env.LOOM_TOKEN_FILE, 'utf-8').trim();
    return async (path, body) => {
      const r = await fetch(`${base}/api/box/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Fail(out.error ?? `${r.status} ${r.statusText}`);
      return out;
    };
  }
  const effects = realEffects(env);
  return async (path, body) => {
    const r = api(env, effects, { caller: { kind: 'owner' }, path, body });
    if (r.status !== 200) throw new Fail(r.body.error);
    return r.body;
  };
}

/** The household's default agent ($LOOM_HOME/household.json), if there's one. */
function defaultAgent(env) {
  try {
    const h = JSON.parse(readFileSync(`${env.LOOM_HOME || `${env.HOME}/.config/loom`}/household.json`, 'utf-8'));
    return typeof h.default === 'string' ? h.default : undefined;
  } catch { return undefined; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv, env) {
  const [cmd, ...rest] = argv;
  const json = rest.includes('--json');
  switch (cmd) {
    case 'ui': {
      const sub = rest[0] === '--json' ? '' : rest[0];
      if (sub === '') return out(manifest(env));
      if (sub === 'page') return out(page(env, JSON.parse(await readStdin())));
      if (sub === 'act') return out(act(env, realEffects(env), JSON.parse(await readStdin()), env.LOOM_BOX_PUBLIC_URL));
      throw new Fail(USAGE, 2);
    }
    case 'api': {
      if (!json) throw new Fail(USAGE, 2);
      return out(api(env, realEffects(env), JSON.parse(await readStdin())));
    }
    case 'bundle': {
      if (rest[0] === 'export') { process.stdout.write(exportPart(env)); return; }
      if (rest[0] === 'import') {
        const r = importPart(env, await readStdin(), { force: rest.includes('--force') });
        process.stderr.write(`loom-box: restored ${r.boxes} boxes and ${r.houses} houses\n`);
        return;
      }
      throw new Fail('usage: loom-box bundle export | bundle import [--force]', 2);
    }
    case 'add': {
      const [name] = positional(rest);
      const { box, token } = addBox(env, realEffects(env), { name, mayHost: flag(rest, '--may-host'), labels: flag(rest, '--labels') });
      process.stderr.write(`Added ${box}. On ${box}: loom box join ${env.LOOM_BOX_PUBLIC_URL || '<loom-url>'} --name ${box}, and paste this when it asks. It won't be shown again.\n`);
      process.stdout.write(`${token}\n`);
      return;
    }
    case 'revoke': { revokeBox(env, realEffects(env), { name: positional(rest)[0] }); process.stdout.write('revoked\n'); return; }
    case 'agent': {
      const [agent] = positional(rest);
      const secrets = Object.fromEntries(flags(rest, '--secret').map((p) => { const [k, v] = p.split('='); return [k, v ?? k]; }));
      out(setAgent(env, realEffects(env), { agent, repo: flag(rest, '--repo'), houseFile: flag(rest, '--house-file'), nested: rest.includes('--nested'), branch: flag(rest, '--branch'), repoSecret: flag(rest, '--repo-secret'), secrets, ports: flags(rest, '--port'), tailnets: flags(rest, '--tailnet') }));
      return;
    }
    case 'remote': {
      const [sub, agent] = positional(rest);
      if (sub === 'up') return out(remoteUp(env, realEffects(env), { agent, box: flag(rest, '--box'), dir: flag(rest, '--dir') }));
      if (sub === 'down') return out(remoteDown(env, realEffects(env), { agent }));
      throw new Fail('usage: loom box remote up|down <agent> [--box b] [--dir /path]', 2);
    }
    case 'rename-local': { out(renameLocal(env)); return; }
    case 'primary': { const [agent, box] = positional(rest); out(setPrimary(env, realEffects(env), { agent, box })); return; }
    case 'up': {
      let task = flag(rest, '--task');
      if (task === '-' || task === undefined) task = await readStdin();
      const call = ownerOrRemote(env);
      // On loom's own machine, a body asking for "a house" means its own: the household's default agent.
      const agent = flag(rest, '--agent') ?? (env.LOOM_URL && env.LOOM_TOKEN_FILE ? undefined : defaultAgent(env));
      const r = await call('up', { agent, box: flag(rest, '--box'), needs: flag(rest, '--needs'), task, slot: flag(rest, '--slot') });
      if (json) return out(r);
      process.stdout.write(`${r.id}: ${r.agent} on ${r.box} (${r.state})\n`);
      return;
    }
    case 'service': {
      const [sub, name, box] = positional(rest);
      const call = ownerOrRemote(env);
      const agent = flag(rest, '--agent') ?? (env.LOOM_URL && env.LOOM_TOKEN_FILE ? undefined : defaultAgent(env));
      if (sub === 'up') return out(await call('service-up', { agent, name, box: flag(rest, '--box') }));
      if (sub === 'down') return out(await call('service-down', { agent, name }));
      if (sub === 'move') return out(await call('service-move', { agent, name, box, force: rest.includes('--force') }));
      if (sub === 'seed') return out(await seedFrom(call, { agent, name }, flag(rest, '--from')));
      if (sub === 'state') return stateTo(call, { agent, name }, flag(rest, '--to'));
      throw new Fail('usage: loom box service up|move|down <name> …', 2);
    }
    case 'slot': {
      const [sub, name] = positional(rest);
      const call = ownerOrRemote(env);
      const agent = flag(rest, '--agent') ?? defaultAgent(env);
      if (sub === 'seed') return out(await seedFrom(call, { agent, name, slot: true }, flag(rest, '--from')));
      if (sub === 'state') return stateTo(call, { agent, name, slot: true }, flag(rest, '--to'));
      throw new Fail('usage: loom box slot seed|state <name> …', 2);
    }
    case 'session': {
      // A house on this box that waits instead of working a task; you're
      // attached to it at this terminal, and it goes when you leave.
      const call = ownerOrRemote(env);
      const agent = flag(rest, '--agent') ?? defaultAgent(env);
      const r = await call('up', { agent, box: localBoxName(env), session: true });
      process.stderr.write(`${r.id}: ${r.agent}'s session house on ${r.box}; starting (a first build can take a while)…\n`);
      const ready = await waitRunning(call, r.id);
      if (ready !== 'running') throw new Fail(`${r.id} didn't start (${ready}); see loom box list`);
      const code = attachHere(env, r.id);
      await call('down', { id: r.id }).catch(() => {});
      process.stderr.write(`${r.id}: left; the house is going (what it left unpushed is pushed first)\n`);
      process.exitCode = code;
      return;
    }
    case 'attach': {
      const id = positional(rest)[0];
      if (!/^h-\d+$/.test(id ?? '')) throw new Fail('usage: loom box attach <house>', 2);
      process.exitCode = attachHere(env, id);
      return;
    }
    case 'down': { out(await ownerOrRemote(env)('down', { id: positional(rest)[0] })); return; }
    case 'list': {
      const r = await ownerOrRemote(env)('list', {});
      if (json) return out(r);
      for (const b of r.boxes) process.stdout.write(`box ${b.name}${b.local ? ' (loom\'s own)' : ''}${b.revoked ? ' REVOKED' : ''}: ${b.facts.join(', ')}\n`);
      for (const v of r.services ?? []) process.stdout.write(`service ${v.service} on ${v.box}${v.moveTo ? ` → ${v.moveTo}` : ''}: ${v.want}, house ${v.house} ${v.state ?? ''}\n`);
      for (const v of r.remotes ?? []) if (v.want === 'up' || v.state !== 'stopped') process.stdout.write(`box session "${v.name}" in ${v.dir}: ${v.want}, ${v.state}${v.url ? ` ${v.url}` : ''}${v.error ? ` (${v.error})` : ''}\n`);
      for (const h of r.houses) process.stdout.write(`${h.id} ${h.agent} on ${h.box}: ${h.state}  ${h.task.slice(0, 60)}\n`);
      return;
    }
    case 'join': {
      const [url] = positional(rest);
      const labels = (flag(rest, '--labels') || '').split(',').filter(Boolean);
      // At a terminal with no credential: ask loom, and the owner lets it in on the page.
      // --credential (or one piped in) is the old way: one the owner copied from Add a box.
      const hi = !rest.includes('--credential') && process.stdin.isTTY
        ? await askToJoin(env, { url, name: flag(rest, '--name'), labels })
        : await joinLoom(env, { url, name: flag(rest, '--name'), labels, credential: await prompt('Box credential (from the Boxes page): ') });
      process.stdout.write(`Joined as ${hi.box}. Run \`loom box run\` (or its user service) to start taking houses.\n`);
      return;
    }
    case 'run': {
      const mode = runMode(env, rest.includes('--local'));
      if (mode === 'unjoined') {
        process.stdout.write('loom-box: this machine hasn\'t joined a loom yet (and isn\'t one): run `loom box join <loom-url> --name <name>`, then restart this service.\n');
        return;
      }
      const local = mode === 'local';
      if (rest.includes('--local') && !local) process.stderr.write('loom-box: this machine joined a loom (box.json): running as that box, not a local control plane\n');
      let client, loomUrl, labels = [];
      if (local) {
        // loom's own machine: the control plane in-process, as its own box.
        const effects = realEffects(env);
        const caller = { kind: 'piece', subject: localBoxName(env) };
        client = { async call(path, body) { const r = api(env, effects, { caller, path, body }); if (r.status !== 200) throw new BoxError(`${path}: ${r.body.error}`); return r.body; } };
        loomUrl = env.LOOM_BOX_LOOM_URL || 'http://127.0.0.1:8787/mcp';
      } else {
        const c = loadConfig(env);
        client = remoteClient(c.url, readFileSync(`${stateDir(env)}/credential`, 'utf-8').trim());
        loomUrl = `${c.url.replace(/\/+$/, '')}/mcp`;
        labels = c.labels || [];
      }
      const r = runner(env, client, { loomUrl, labels });
      const every = Number(env.LOOM_BOX_POLL_MS) || POLL_MS;
      for (;;) {
        try { await r.tick(); } catch (err) { process.stderr.write(`loom-box: poll: ${err.message}\n`); }
        if (rest.includes('--once')) return;
        await sleep(every);
      }
    }
    case undefined: case '-h': case '--help': case 'help':
      process.stdout.write(USAGE);
      return;
    default:
      throw new Fail(USAGE, 2);
  }
}

function out(v) { process.stdout.write(JSON.stringify(v) + '\n'); }

/** A dir packed and handed over as a service's (or slot's) starting state, in parts inside loom's body cap. */
async function seedFrom(call, who, from) {
  if (!from) throw new Fail('--from <dir>', 2);
  const t = packState(from);
  if (!t) throw new Fail(`couldn't pack ${from}`);
  const parts = partsOf(t.length);
  let r;
  for (let part = 0; part < parts; part++) {
    r = await call('seed-state', { ...who, part, parts, state: t.subarray(part * PART_RAW, (part + 1) * PART_RAW).toString('base64') });
  }
  return r;
}

/** A saved state, fetched in parts and unpacked into a new, empty dir with the box's own checks. */
async function stateTo(call, who, to) {
  if (!to) throw new Fail('--to <dir>', 2);
  if (existsSync(to) && readdirSync(to).length) throw new Fail(`${to} isn't empty: unpack into a new directory, then move what you need`);
  const r = await call('saved-state', { ...who, part: 0 });
  const chunks = [Buffer.from(r.state, 'base64')];
  for (let part = 1; part < r.parts; part++) chunks.push(Buffer.from((await call('saved-state', { ...who, part })).state, 'base64'));
  mkdirSync(to, { recursive: true, mode: 0o700 });
  restoreState(to, joinParts(chunks, r));
  process.stdout.write(`unpacked ${r.service}'s state from ${r.at} (${r.from}) into ${to}\n`);
}

/** Until a house is running (or over): its state then. */
async function waitRunning(call, id, timeoutMs = 30 * 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const h = (await call('list', {})).houses.find((x) => x.id === id);
    const st = h?.state ?? 'gone';
    if (!['wanted', 'starting'].includes(st)) return st;
    if (Date.now() > until) return st;
    await new Promise((res) => setTimeout(res, 3000));
  }
}

/** Into a session house that runs on this box, at this terminal: what its house file says to run. */
function attachHere(env, id) {
  const f = `${env.LOOM_BOX_DATA || `${env.HOME}/.local/share/loom-box`}/houses/${id}/attach.json`;
  if (!existsSync(f)) throw new Fail(`${id} isn't a session house on this box`);
  const { container, command } = JSON.parse(readFileSync(f, 'utf-8'));
  const r = spawnSync(env.LOOM_BOX_PODMAN || 'podman', ['exec', '-it', container, ...command], { stdio: 'inherit' });
  return r.status ?? 1;
}

// `loom box list | head` closes stdout early: that's fine, not a crash.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  main(process.argv.slice(2), process.env).then(
    () => {},
    (err) => {
      process.stderr.write(`loom box: ${err.message}\n`);
      process.exit(err instanceof Fail ? err.code : 1);
    },
  );
}

export { main };
