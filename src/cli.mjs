#!/usr/bin/env node
// loom-runtime: loom's runtime piece (loom docs/specs/agent-runtime.md, docs/specs/runtime.md). `loom runtime …`
// reaches it through loom's piece dispatch; `loom runtime …` (the bin loom-box) is the same program, kept through the
// move from the piece's old name.
//
// Boxes are pets: machines enrolled once and kept (wunder, the 5090 box, a
// laptop). Houses are cattle: an agent's container on a box, built from the
// agent's repo for a task and thrown away. Nothing picks a box by itself.
//
// On loom's own machine (the control plane, and its first box):
//   loom runtime add <name> [--may-host a,b] [--labels x,y]   enroll a box; prints its credential once
//   loom runtime revoke <name>                                 revoke a box and its houses' tokens
//   loom runtime agent <agent> --repo <url> [--house-file house/house.json] [--nested] [--gpu]
//                  [--branch b] [--repo-secret <store-name>] [--secret as=from]... [--port n]...
//                  [--tailnet name=/run/…/tailscaled.sock]...
//                                                         how its house is made (--port: one it may publish;
//                                                         --tailnet: a box tailscaled.sock it may use, by name)
//   loom runtime primary <agent> [<box>]                       an agent's primary (default: this machine)
//   loom runtime rename-local                                  after renaming this machine: its box takes the new name
//   loom runtime remote up <agent> [--box b] [--dir /path]     a box session: Claude's remote-control on the box itself,
//                                                         in the agent's folder there (the box's whole reach; take it down after)
//   loom runtime remote down <agent>
//   loom runtime run --local                                   run houses here (a user service)
// Anywhere (here as the owner; elsewhere with LOOM_URL + LOOM_TOKEN_FILE, as that token):
//   loom runtime up [--agent a] [--box b] [--needs gpu:5090] [--slot s] --task <text|->   ask for a house
//                                                         (--slot: its bookkeeping, restored and saved; one house at a time)
//   loom runtime slot seed <name> --from <dir> | slot state <name> --to <dir>   a slot's state (the owner's)
//   loom runtime list [--json]   |   loom runtime down <house>
//   loom runtime session [--agent a]                           a house with an interactive session, here, at this terminal
//   loom runtime attach <house>                                into a session house on this box (again)
//   loom runtime service up <name> [--agent a] [--box b]       a long-lived house (a bridge), kept up
//   loom runtime service move <name> <box> [--force]           hand it off: stopped there, then started here
//   loom runtime service down <name>
//   loom runtime service seed <name> --from <dir>             its starting state (a bridge moving in)
//   loom runtime service state <name> --to <dir>              its saved state, unpacked (a bridge moving out)
// On a box:
//   loom runtime join <loom-url> --name <name> [--labels x,y]  asks loom; the owner lets it in on the page
//                                       [--credential]     or: a credential from Add a box, on stdin or prompted
//   loom runtime run                                           poll and run houses (a user service)
// For loom (the piece contract):
// Bodies (on the machine they run on; the model is the runtime's choice):
//   loom runtime body start --agent a --venue v [--venue-kind live|scheduled|agent] [--prefer m]... [--place p]
//                      [--cwd d] [--deny tool]... --brief <text|->        a body on the model the resolver picks
//   loom runtime body feed <body> --text <text|->                      a message mid-turn, where the harness allows
//   loom runtime body resume <body> | --slot <harness>:<session> [--agent a --venue v] --brief <text|->
//   loom runtime body end <body>   |   loom runtime body list [--json]
// Models and accounts (the owner's, on loom's machine):
//   loom runtime models [--json]                                         the model list and each agent's settings
//   loom runtime models set --json < {list?, agent?, allow?, prefer?}    change them
//   loom runtime models resolve --agent a --venue v [--venue-kind k] [--prefer m]...   which model, and why
//   loom runtime accounts [--json] | accounts usage [--json]           the accounts the boxes report, and their usage
//   loom runtime logins [--json]                                       each box's harnesses: installed, logged in
//   loom runtime login <box> claude|codex                              log a box in (its CLI's own login; prints the link)
// From a house (its loom token):
//   loom runtime usage report --harness claude|codex < output.jsonl    how full its account is, from the harness's run
//                                                                      output (stream-json, or a Codex rollout)
// For loom (the piece contract):
//   loom runtime ui --json | ui page --json | ui act --json | api --json
//   loom runtime bundle export | bundle import [--force]       its part of loom's bundle
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
import { pieceName, setting } from './piece.mjs';
import { accountsFrom } from './accounts.mjs';
import { lastRateLimit } from './logins.mjs';
import { readModels, resolveFor, setModels } from './models.mjs';
import { endBody, feedBody, listBodies, resumeBody, startBody } from './bodies.mjs';
import { PART_RAW, joinParts, partsOf } from './blobs.mjs';

/**
 * Whether this box's houses should outlive it: LOOM_BOX_ON_EXIT=keep|stop says so; else it's whether the systemd
 * unit it runs in keeps a stopped unit's other processes (KillMode=process). Under any other unit systemd would kill
 * the houses' podman clients anyway, uncleanly, so they're stopped first (t-1498).
 */
export function keepsHousesOnExit(env, read = {}) {
  if (env.LOOM_BOX_ON_EXIT === 'keep') return true;
  if (env.LOOM_BOX_ON_EXIT === 'stop') return false;
  const cgroup = read.cgroup ?? (() => { try { return readFileSync('/proc/self/cgroup', 'utf-8'); } catch { return ''; } });
  const unit = /\/([^/\n]+\.service)\s*$/m.exec(cgroup())?.[1];
  if (!unit) return false;
  const show = read.killMode ?? ((u) => spawnSync('systemctl', ['--user', 'show', '-p', 'KillMode', '--value', u], { encoding: 'utf-8', timeout: 5_000 }).stdout ?? '');
  return show(unit).trim() === 'process';
}

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
      const r = await fetch(`${base}/api/${pieceName(env)}/${path}`, {
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
      if (sub === 'act') return out(act(env, realEffects(env), JSON.parse(await readStdin()), setting(env, 'PUBLIC_URL')));
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
      process.stderr.write(`Added ${name} (${box}). On ${name}: loom box join ${setting(env, 'PUBLIC_URL') || '<loom-url>'} --name ${name} --credential, and paste this when it asks. It won't be shown again.\n`);
      process.stdout.write(`${token}\n`);
      return;
    }
    case 'revoke': { revokeBox(env, realEffects(env), { name: positional(rest)[0] }); process.stdout.write('revoked\n'); return; }
    case 'agent': {
      const [agent] = positional(rest);
      const secrets = Object.fromEntries(flags(rest, '--secret').map((p) => { const [k, v] = p.split('='); return [k, v ?? k]; }));
      out(setAgent(env, realEffects(env), { agent, repo: flag(rest, '--repo'), houseFile: flag(rest, '--house-file'), nested: rest.includes('--nested'), gpu: rest.includes('--gpu'), branch: flag(rest, '--branch'), repoSecret: flag(rest, '--repo-secret'), secrets, ports: flags(rest, '--port'), tailnets: flags(rest, '--tailnet') }));
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
      process.stdout.write(`${r.id}: ${r.agent} on ${r.boxName ?? r.box} (${r.state})\n`);
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
      process.stderr.write(`${r.id}: ${r.agent}'s session house on ${r.boxName ?? r.box}; starting (a first build can take a while)…\n`);
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
      for (const b of r.boxes) process.stdout.write(`box ${b.name}${b.id !== b.name ? ` [${b.id}]` : ''}${b.local ? ' (loom\'s own)' : ''}${b.revoked ? ' REVOKED' : ''}: ${b.facts.join(', ')}\n`);
      for (const v of r.services ?? []) process.stdout.write(`service ${v.service} on ${v.box}${v.moveTo ? ` → ${v.moveTo}` : ''}: ${v.want}, house ${v.house} ${v.state ?? ''}\n`);
      for (const v of r.remotes ?? []) if (v.want === 'up' || v.state !== 'stopped') process.stdout.write(`box session "${v.name}" in ${v.dir}: ${v.want}, ${v.state}${v.url ? ` ${v.url}` : ''}${v.error ? ` (${v.error})` : ''}\n`);
      for (const h of r.houses) process.stdout.write(`${h.id} ${h.agent} on ${h.box}: ${h.state}  ${h.task.slice(0, 60)}\n`);
      return;
    }
    case 'join': {
      const [url] = positional(rest);
      const labels = (flag(rest, '--labels') || '').split(',').filter(Boolean);
      // Ask loom, and the owner lets it in on the page: with or without a terminal (an agent
      // running the join has none, and a quiet switch to reading a credential failed it).
      // --credential is the old way: one the owner copied from Add a box, typed or piped in.
      const hi = !rest.includes('--credential')
        ? await askToJoin(env, { url, name: flag(rest, '--name'), labels })
        : await joinLoom(env, { url, name: flag(rest, '--name'), labels, credential: await prompt('Box credential (from the Boxes page): ') });
      process.stdout.write(`Joined as ${hi.name ?? hi.box} (${hi.box}). Run \`loom box run\` (or its user service) to start taking houses.\n`);
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
        loomUrl = setting(env, 'LOOM_URL') || 'http://127.0.0.1:8787/mcp';
      } else {
        const c = loadConfig(env);
        client = remoteClient(c.url, readFileSync(`${stateDir(env)}/credential`, 'utf-8').trim(), fetch, c.piece);
        loomUrl = `${c.url.replace(/\/+$/, '')}/mcp`;
        labels = c.labels || [];
      }
      const r = runner(env, client, { loomUrl, labels });
      const every = Number(env.LOOM_BOX_POLL_MS) || POLL_MS;
      // systemd restarting this service with a house up (t-1498): a bare SIGTERM
      // used to drop the process at once, leaving every house running until
      // systemd's own stop timeout gave up on them. This waits for them first,
      // the same way `down` does, so the restart is a clean exit instead.
      // Unless its unit keeps what it started (loom's does: KillMode=process): then the houses outlive this
      // process and the next start adopts them (box.mjs), so a restart for an update doesn't take every house
      // down at once (2026-10-30: 7 houses, 10 minutes back at load 120+).
      let stopping = null;
      process.on('SIGTERM', () => {
        if (stopping) return;
        if (keepsHousesOnExit(env)) {
          process.stderr.write(`loom-box: SIGTERM: leaving ${r.houses.size} house(s) running; the next start adopts them\n`);
          stopping = Promise.resolve();
          process.exit(0);
        }
        process.stderr.write(`loom-box: SIGTERM: stopping ${r.houses.size} house(s) before exit\n`);
        stopping = r.shutdown().then(() => process.exit(0));
      });
      for (;;) {
        if (stopping) return;
        try { await r.tick(); } catch (err) { process.stderr.write(`loom-box: poll: ${err.message}\n`); }
        if (rest.includes('--once') || stopping) return;
        await sleep(every);
      }
    }
    case 'body': return body(rest, env, json);
    case 'models': return models(rest, env, json);
    case 'accounts': {
      const a = accountsFrom(env);
      if (rest[0] === 'usage') {
        const u = a.usage();
        if (json) return out(u);
        for (const x of u) process.stdout.write(`${x.label} (${x.provider}): ${Object.entries(x.windows).map(([w, v]) => `${w} ${Math.round(v * 100)}%`).join(', ') || 'not read yet'}${x.room ? '' : ' — out of room'}\n`);
        return;
      }
      const l = a.list();
      if (json) return out(l);
      if (!l.accounts.length) process.stdout.write('no accounts: no box is logged in to a harness, and no agent has an API key\n');
      for (const x of l.accounts) process.stdout.write(`${x.label}  ${x.kind}${x.boxes.length ? `  on ${x.boxes.join(', ')}` : ''}  for ${x.agents.join(', ') || 'no agent'}\n`);
      return;
    }
    case 'logins': {
      const r = list(env, { kind: 'owner' });
      if (json) return out(r.boxes.filter((b) => !b.revoked).map((b) => ({ id: b.id, name: b.name, owner: b.owner, harnesses: b.harnesses })));
      for (const b of r.boxes.filter((x) => !x.revoked)) {
        const hs = Object.entries(b.harnesses ?? {});
        process.stdout.write(`${b.name}${b.id !== b.name ? ` [${b.id}]` : ''}: ${hs.length ? hs.map(([h, v]) => `${h} ${!v.installed ? 'not installed' : v.loggedIn ? `logged in (${v.method ?? '?'}${v.plan ? `, ${v.plan}` : ''})` : 'not logged in'}`).join('; ') : 'no report yet'}\n`);
      }
      return;
    }
    case 'login': {
      const [box, harness] = rest;
      if (!box || !harness) throw new Fail('usage: loom runtime login <box> claude|codex', 2);
      const call = ownerOrRemote(env);
      const st = await call('login-start', { box, harness });
      process.stderr.write(`login ${st.id}: the box runs ${harness}'s own login on its next poll; its link shows on the box's page.\n`);
      return out(st);
    }
    case 'usage': {
      const h = flag(rest, '--harness');
      if (rest[0] !== 'report' || !h) throw new Fail('usage: loom runtime usage report --harness claude|codex < output.jsonl', 2);
      const reading = lastRateLimit(h, await readStdin());
      if (!reading) { process.stderr.write('no rate-limit reading in that output\n'); return; }
      return out(await ownerOrRemote(env)('usage', { harness: h, reading: { ...reading, checked: Math.floor(Date.now() / 1000) } }));
    }
    case undefined: case '-h': case '--help': case 'help':
      process.stdout.write(USAGE);
      return;
    default:
      throw new Fail(USAGE, 2);
  }
}

function out(v) { process.stdout.write(JSON.stringify(v) + '\n'); }

/** `--text -` or `--brief -` (or none): stdin. */
async function textOf(args, name) {
  const v = flag(args, name);
  return v === undefined || v === '-' ? readStdin() : v;
}

/** loom runtime body …: on the machine the body runs on. */
async function body(rest, env, json) {
  const [sub, ref] = positional(rest);
  const said = (r, line) => (json ? out(r) : process.stdout.write(line + '\n'));
  if (sub === 'start' || sub === 'resume') {
    const slotArg = flag(rest, '--slot');
    const slot = slotArg ? { harness: slotArg.split(':')[0], session: slotArg.slice(slotArg.indexOf(':') + 1) } : undefined;
    const o = {
      agent: flag(rest, '--agent') ?? (sub === 'start' ? defaultAgent(env) : undefined), venue: flag(rest, '--venue'), venueKind: flag(rest, '--venue-kind'),
      prefer: flags(rest, '--prefer'), place: flag(rest, '--place'), cwd: flag(rest, '--cwd'), deny: flags(rest, '--deny'), brief: await textOf(rest, '--brief'),
    };
    const r = sub === 'start' ? await startBody(env, o) : await resumeBody(env, { ...o, body: ref, slot });
    return said(r, `${r.body}: ${r.agent} on ${r.model} (${r.harness}, ${r.family})${r.resumed ? `, resuming ${r.resumed}` : ''}`);
  }
  if (sub === 'feed') {
    const r = feedBody(env, ref, { text: await textOf(rest, '--text'), ...(flag(rest, '--id') ? { id: flag(rest, '--id') } : {}) });
    if (!r.fed) process.exitCode = 3;
    return said(r, r.fed ? `${ref}: fed` : `${ref}: not fed: ${r.reason}`);
  }
  if (sub === 'end') return said(endBody(env, ref), `${ref}: ended`);
  if (sub === 'list') {
    const l = listBodies(env);
    if (json) return out(l);
    for (const b of l) process.stdout.write(`${b.body} ${b.agent} ${b.venue}${b.place ? ` ${b.place}` : ''} on ${b.model}: ${b.status}\n`);
    return;
  }
  throw new Fail('usage: loom runtime body start|feed|resume|end|list …', 2);
}

/** loom runtime models …: the list, each agent's settings, and the resolver. */
async function models(rest, env, json) {
  const [sub] = positional(rest);
  if (sub === undefined) {
    const m = readModels(env);
    if (json) return out(m);
    for (const x of m.list) process.stdout.write(`${x.id}  ${x.harness}  ${x.family}${x.window ? `  (window ${x.window})` : ''}\n`);
    for (const [a, v] of Object.entries(m.agents)) process.stdout.write(`${a}: prefers ${(v.prefer ?? []).join(' → ') || '(the list\'s order)'}${v.allow?.length ? `; may use ${v.allow.join(', ')}` : ''}\n`);
    return;
  }
  if (sub === 'set') return out(setModels(env, JSON.parse(await readStdin())));
  if (sub === 'resolve') {
    const r = await resolveFor(env, { agent: flag(rest, '--agent') ?? defaultAgent(env), venue: flag(rest, '--venue'), venueKind: flag(rest, '--venue-kind'), prefer: flags(rest, '--prefer'), accounts: accountsFrom(env) });
    if (json) return out(r);
    process.stdout.write(`${r.model} (${r.harness}, ${r.family})${r.account ? ` on ${r.account}` : ''}\n${r.why.map((w) => `  ${w}`).join('\n')}\n`);
    return;
  }
  throw new Fail('usage: loom runtime models [set|resolve] …', 2);
}

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
      process.stderr.write(`loom ${/loom-box$/.test(process.argv[1] ?? '') ? 'box' : 'runtime'}: ${err.message}\n`);
      process.exit(err instanceof Fail ? err.code : 1);
    },
  );
}

export { main };
