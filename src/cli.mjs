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
//   loom box agent <agent> --repo <url> [--house-cmd house/up] [--branch b]
//                  [--repo-secret <store-name>] [--secret as=from]...   how its house is made
//   loom box primary <agent> [<box>]                       an agent's primary (default: this machine)
//   loom box run --local                                   run houses here (a user service)
// Anywhere (here as the owner; elsewhere with LOOM_URL + LOOM_TOKEN_FILE, as that token):
//   loom box up [--agent a] [--box b] [--needs gpu:5090] --task <text|->   ask for a house
//   loom box list [--json]   |   loom box down <house>
// On a box:
//   loom box join <loom-url> --name <name> [--labels x,y]  the credential on stdin, or prompted
//   loom box run                                           poll and run houses (a user service)
// For loom (the piece contract):
//   loom box ui --json | ui page --json | ui act --json | api --json
//   loom box bundle export | bundle import [--force]       its part of loom's bundle
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { addBox, api, down, list, revokeBox, setAgent, setPrimary, up } from './control.mjs';
import { realEffects } from './effects.mjs';
import { act, manifest, page } from './ui.mjs';
import { BoxError, joinLoom, loadConfig, POLL_MS, remoteClient, runner } from './box.mjs';
import { localBoxName, stateDir } from './state.mjs';
import { exportPart, importPart } from './bundle.mjs';

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
      out(setAgent(env, realEffects(env), { agent, repo: flag(rest, '--repo'), houseCmd: flag(rest, '--house-cmd'), branch: flag(rest, '--branch'), repoSecret: flag(rest, '--repo-secret'), secrets }));
      return;
    }
    case 'primary': { const [agent, box] = positional(rest); out(setPrimary(env, realEffects(env), { agent, box })); return; }
    case 'up': {
      let task = flag(rest, '--task');
      if (task === '-' || task === undefined) task = await readStdin();
      const call = ownerOrRemote(env);
      const r = await call('up', { agent: flag(rest, '--agent'), box: flag(rest, '--box'), needs: flag(rest, '--needs'), task });
      if (json) return out(r);
      process.stdout.write(`${r.id}: ${r.agent} on ${r.box} (${r.state})\n`);
      return;
    }
    case 'down': { out(await ownerOrRemote(env)('down', { id: positional(rest)[0] })); return; }
    case 'list': {
      const r = await ownerOrRemote(env)('list', {});
      if (json) return out(r);
      for (const b of r.boxes) process.stdout.write(`box ${b.name}${b.local ? ' (loom\'s own)' : ''}${b.revoked ? ' REVOKED' : ''}: ${b.facts.join(', ')}\n`);
      for (const h of r.houses) process.stdout.write(`${h.id} ${h.agent} on ${h.box}: ${h.state}  ${h.task.slice(0, 60)}\n`);
      return;
    }
    case 'join': {
      const [url] = positional(rest);
      const credential = await prompt('Box credential (from the Boxes page): ');
      const labels = (flag(rest, '--labels') || '').split(',').filter(Boolean);
      const hi = await joinLoom(env, { url, name: flag(rest, '--name'), labels, credential });
      process.stdout.write(`Joined as ${hi.box}. Run \`loom box run\` (or its user service) to start taking houses.\n`);
      return;
    }
    case 'run': {
      const local = rest.includes('--local');
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
