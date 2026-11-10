#!/usr/bin/env node
// loom-runtime: loom's runtime piece (loom docs/specs/agent-runtime.md, docs/specs/runtime.md). `loom runtime …`
// reaches it through loom's piece dispatch; `loom runtime …` (the bin loom-box) is the same program, kept through the
// move from the piece's old name.
//
// Boxes are pets: machines enrolled once and kept (wunder, the 5090 box, a
// laptop). Houses are cattle: an agent's container on a box, built from the
// agent's repo for a task and thrown away. An agent's boxes are in the order its owner set: the first that's up.
//
// On loom's own machine (the control plane, and its first box):
//   loom runtime add <name> [--may-host a,b] [--labels x,y]   enroll a box; prints its credential once
//   loom runtime revoke <name>                                 revoke a box and its houses' tokens
//   loom runtime agent <agent> --repo <url> [--house-file house/house.json] [--nested] [--gpu]
//                  [--branch b] [--repo-secret <store-name>] [--secret as=from]... [--port n]...
//                  [--tailnet name=/run/…/tailscaled.sock]...
//                  [--logins claude,codex|none|default]       which of a box's logins its houses may have
//                                                         how its house is made (--port: one it may publish;
//                                                         --tailnet: a box tailscaled.sock it may use, by name)
//   loom runtime primary <agent> [<box>...]                    its boxes in order: the first that's up (default: this machine)
//   loom runtime rename-local                                  after renaming this machine: its box takes the new name
//   loom runtime health [<box>] [--json]                       each box's last health sample and what's wrong now
//   loom runtime always-on <box> on|off                        silent 10 minutes is an alert (loom's own and report-only boxes always are)
//   loom runtime report-only <box> on|off                      it reports its numbers and hosts nothing
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
//   loom runtime attach <house> [--shell]                      reconnect its runtime conversation, or open its shell
//   loom runtime service up <name> [--agent a] [--box b]       a long-lived house (a bridge), kept up
//   loom runtime service move <name> <box> [--force]           hand it off: stopped there, then started here
//   loom runtime service down <name>
//   loom runtime service seed <name> --from <dir>             its starting state (a bridge moving in)
//   loom runtime service state <name> --to <dir>              its saved state, unpacked (a bridge moving out)
// On a box:
//   loom runtime join <loom-url> --name <name> [--labels x,y] [--report-only]  asks loom; the owner lets it in on the page
//                                       [--credential]     or: a credential from Add a box, on stdin or prompted
//   loom runtime run                                           poll and run houses (a user service)
// For loom (the piece contract):
// Bodies (on the machine they run on; the model is the runtime's choice):
//   loom runtime body start --agent a --venue v [--venue-kind live|scheduled|agent] [--prefer m]... [--place p]
//                      [--cwd d] [--deny tool]... --brief <text|->        a body on the model the resolver picks
//   loom runtime body feed <body> --text <text|->                      a message mid-turn, where the harness allows
//   loom runtime body resume <body> | --slot <harness>:<session> [--agent a --venue v] --brief <text|->
//   loom runtime body end <body>   |   loom runtime body list [--json]
// Delivery (agent-runtime.md, section 5; the runtime's `delivery` offer, which core runs):
//   loom runtime deliver < {source, id, agent, venue, place, label?, from, kind, at, text}   (core adds source)
//                      the turn to core, then the conversation's body: {conversation, seq, body, reason?}
//   loom runtime send --conversation <cv> --text <text|->              a body's message out, in its venue: {accepted, ref}
//        [--person <slug> --via <venue>]                               … or one DM to a person there, through its adapter
//                                                                        at once; a failed post comes back through its inbox
//   loom runtime principal [--conversation <cv>]                       on whose behalf this body acts (t-1943): {for, owner,
//                                                                        people, statement}; the statement is what a piece checks
//   loom runtime principal --verify < statement                        loom's machine: a statement checked (and still true), {ok, agent, for, owner, …}
//   loom runtime principal --reset --conversation <cv>                 loom's machine, the owner's: what it heard before is set aside
//   loom runtime principal --wake --agent a --place p --id <delivery id> --for owner|<slug>|-   loom's machine (the clock): who that firing wake is for
//   loom runtime deliver tick [--conversation <cv>] | deliver run [--every <ms>] | deliver list [--json]
//   loom runtime deliver stale-runs [--json]   read only: open runs whose body is gone (t-1958)
//   loom runtime deliver resume|dismiss <cv>   a conversation paused as a loop (loops.mjs): start what waited, or drop it
//   loom runtime task-host [--brief-stdin]                  allocated raw task, or a script’s model brief: common delivery
//   loom runtime session-host                               in a session house: keep its common body host alive
//   loom runtime body-host [--piece <name>] --host-key <boot key>   in an agent's house, as its task: the bodies delivery asks for
// Models and accounts (the owner's, on loom's machine):
//   loom runtime models [--json]                                         the model list and each agent's settings
//   loom runtime models set --json < {list?, agent?, allow?, prefer?}    change them
//   loom runtime models resolve --agent a --venue v [--venue-kind k] [--prefer m]... [--suppose-out claude|codex]...
//                                                                        which model, and why (as if a harness were out)
//   loom runtime accounts [--json] | accounts usage [--json]           the accounts the boxes report, and their usage
//   loom runtime logins [--json]                                       each box's harnesses: installed, logged in
//   loom runtime login <box> claude|codex                              log a box in (its CLI's own login; prints the link)
//   loom runtime carry-settings [--from box --to runtime]             after swapping the old box piece by hand: its settings, renamed
// The review job (agent-runtime.md, section 7; conversations.md, "Review"): daily at 04:00 in the household's tz,
// started by the delivery service's tick; grading by bare models, then each agent's own introspection:
//   loom runtime review run [--limit n] [--introspect all|none|a,b] [--json]   one run now, by hand
//   loom runtime review status [--json]                                the schedule and the last runs (counts only)
// From a house (its loom token):
//   loom runtime usage report --harness claude|codex < output.jsonl    how full its account is, from the harness's run
//                                                                      output (stream-json, or a Codex rollout)
//   loom runtime usage report --harness claude --session <id>         … from a Claude session's status line (usage statusline)
//   loom runtime usage statusline                                      a Claude status line command: keeps its rate limits
// Permissions (agent-runtime.md, section 6; the runtime is the grants authority, and holds the gates):
//   loom runtime grants ask | list [--json] | seed [--dry-run] [--force] | set <piece> <agents|*> [--paths p,p] | paired <a> <b>
//   loom runtime gates people --agent a | status | propose --agent a --from w --stdin < proposal | export --json
//   loom runtime gates import [--force]                  the owner's run: loom shuttle gates export --json | loom runtime gates import
//   loom runtime gates follow-merge <from> <into>        the owner's: after a card merge, every agent's gates follow
//   loom runtime policy --agent a [--json] | policy set --agent a < doc   what an agent's bodies may use and are told (policy.mjs)
//   loom runtime secrets-map --json                      which secret each agent's houses get (for: | loom secrets policy houses-import)
// A reply's trace (loom comms.md, "Tracing a reply"; trace.mjs, t-1895): what happened, from the message in to shown.
//   loom runtime trace tool --agent a [--house h] < {thread?, run?, conversation?}   the comms_trace MCP tool core runs
//   loom runtime trace --thread th:… | --run run-… | --conversation cv-… [--json]   in a house: its own agent's, through
//                      the piece API; at loom's machine: the owner's, any agent's
// Relay (agent-runtime.md, section 5, "Agent-to-agent relay"; relay.mjs):
//   loom runtime relay tool --agent a [--house h] [--service s] < {to, say, why?, reply_to?, from?, approval?}
//                      the relay MCP tool core offers an agent's session: {text, isError?}
//   loom runtime relay --to b --say <text> [--why w] [--reply-to r-…] [--from discord:#x] [--approval a-…]   from a house
//   loom runtime relays [--thread r-…]                  from a house: its agent's relays, sent and received
// A body's own place (gates-api.mjs, placeOf; t-1745): proved by its run key and session, in a house or on loom's machine
//   loom runtime place                                   {conversation, agent, venue, place, label?, members, membersAt?, principal}
// The now board (nowboard.mjs): a bridge's POST /api/runtime/now/snapshot | now/event, and from a house:
//   loom runtime now talking                            its agent's bridges: talking, waiting, how fresh
// For loom (the piece contract):
//   loom runtime ui --json | ui page --json | ui act --json | api --json
//   loom runtime bundle export | bundle import [--force]       its part of loom's bundle
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { closeSync, openSync, readSync, writeSync } from 'node:fs';

/**
 * The owner, at a terminal: the controlling terminal (/dev/tty, not stdin, which a caller can pipe) asks `prompt`, and
 * the line typed must be `want`. False with no controlling terminal (a body's: `claude --bg`, a detached process).
 */
function ownerAtTerminal(prompt, want) {
  let fd;
  try { fd = openSync('/dev/tty', 'r+'); } catch { return false; }
  try {
    writeSync(fd, prompt);
    const buf = Buffer.alloc(1);
    let line = '';
    while (line.length < 200) {
      let n;
      try { n = readSync(fd, buf, 0, 1, null); } catch (e) { if (e?.code === 'EAGAIN') continue; return false; }
      if (n === 0 || buf[0] === 10) break;
      line += String.fromCharCode(buf[0]);
    }
    return !!want && line.trim() === want;
  } finally { closeSync(fd); }
}
import { addBox, api, inProcessBoxClient, down, list, remoteDown, remoteUp, revokeBox, setAgent, setBoxWatch, setPrimary, up } from './control.mjs';
import { watchOf } from './watch.mjs';
import { healthWords } from './health.mjs';
import { realEffects } from './effects.mjs';
import { act, houseBadge, manifest, page } from './ui.mjs';
import { askToJoin, BoxError, joinLoom, loadConfig, packState, POLL_MS, remoteClient, restoreState, runner, runMode } from './box.mjs';
import { load as loadState, localBoxName, renameLocal, stateDir } from './state.mjs';
import { exportPart, importPart } from './bundle.mjs';
import { pieceName, setting } from './piece.mjs';
import { accountsFrom, supposeOut } from './accounts.mjs';
import { codexUsageOnBox, lastRateLimit, secureLoomUrl } from './logins.mjs';
import { join } from 'node:path';
import { readModels, resolveFor, setModels } from './models.mjs';
import { endBody, feedBody, listBodies, resumeBody, startBody } from './bodies.mjs';
import { PART_RAW, joinParts, partsOf } from './blobs.mjs';
import { answerLoop, deliver, listConvs, post, staleRuns, send, sendOutcome, sendStatus, tick, workingConversations, workingPrint } from './delivery.mjs';
import { coreFrom } from './core.mjs';
import { watchBridges } from './nowboard.mjs';
import { reviewStatus, reviewTick, runReview } from './review.mjs';
import { bodyConversation, bodyKeyFor, bodySession, runBodyHost } from './bodyhost.mjs';
import { runnerFor, usageDirOf } from './runners.mjs';
import { capture as captureStatusline, keptReading, lineOf as statuslineText } from './statusline.mjs';
import { applyUpgrade, carrySettings, loadCarried, recoverUpgrade } from './version.mjs';
import { gatesCli, grantsCli, policyCli } from './perms-cli.mjs';

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

/** How often the delivery service notes the bridges' outages (nowboard.mjs, watchBridges). */
const WATCH_EVERY_MS = 30_000;

/**
 * What the agents' cards show at work (ui.mjs agentReports), as one string: each delivered body mid-turn (a Comms
 * thread, a bridge's chat, a wake) and each task house up. When it moves, core hears at once (POST
 * /api/loom/pieces/changed) and asks this manifest again, so a card goes working, and back to quiet, within a tick
 * of the body (t-1945), not at loom's next look at the pieces.
 */
let atWork;
export async function tellAtWork(env, o = {}) {
  let print;
  try {
    const s = loadState(env);
    const houses = Object.entries(s.houses ?? {}).filter(([, h]) => h.agent && !h.service && (h.state === 'running' || h.state === 'starting')).map(([k]) => k).sort().join(',');
    // Renew explicit idle observations too; a silent working set must not leave a 30-second observation cached for 45 seconds.
    print = `${workingPrint(o.deps ? workingConversations(env, o.deps) : workingConversations(env))}|${houses}|${Math.floor((o.nowMs ?? Date.now()) / 10000)}`;
  } catch { return false; }
  if (print === atWork) return false;
  atWork = print;
  try { await (o.core ?? coreFrom(env, { timeoutMs: 2000 })).changed(); } catch (e) { process.stderr.write(`loom-runtime deliver: couldn't tell core what's at work: ${e.message}\n`); }
  return true;
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
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Fail(out.error ?? `${r.status} ${r.statusText}`), { status: r.status });
      return out;
    };
  }
  const effects = realEffects(env);
  return async (path, body) => {
    const r = await api(env, effects, { caller: { kind: 'owner' }, path, body });
    if (r.status !== 200) throw Object.assign(new Fail(r.body.error), { status: r.status });
    return r.body;
  };
}

/** The runtime's piece API, as this token (a house's): its answer, whatever its status. */
function pieceCall(env, piece) {
  const base = env.LOOM_URL.replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
  const name = piece && /^[a-z][a-z0-9-]{0,39}$/.test(piece) ? piece : pieceName(env);
  return async (path, body) => {
    const token = readFileSync(env.LOOM_TOKEN_FILE, 'utf-8').trim();
    const r = await fetch(`${base}/api/${name}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const out = await r.json().catch(() => ({}));
    return r.ok || out.ok === false ? out : { ok: false, error: out.error ?? `${r.status}`, reason: out.error ?? `${r.status}` };
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
      if (sub === 'page') return out(await page(env, JSON.parse(await readStdin())));
      if (sub === 'act') return out(await act(env, realEffects(env), JSON.parse(await readStdin()), setting(env, 'PUBLIC_URL')));
      throw new Fail(USAGE, 2);
    }
    case 'api': {
      if (!json) throw new Fail(USAGE, 2);
      return out(await api(env, realEffects(env), JSON.parse(await readStdin())));
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
      out(setAgent(env, realEffects(env), { agent, repo: flag(rest, '--repo'), houseFile: flag(rest, '--house-file'), nested: rest.includes('--nested'), gpu: rest.includes('--gpu'), branch: flag(rest, '--branch'), repoSecret: flag(rest, '--repo-secret'), secrets, ports: flags(rest, '--port'), tailnets: flags(rest, '--tailnet'), logins: flag(rest, '--logins') }));
      return;
    }
    case 'remote': {
      const [sub, agent] = positional(rest);
      if (sub === 'up') return out(remoteUp(env, realEffects(env), { agent, box: flag(rest, '--box'), dir: flag(rest, '--dir') }));
      if (sub === 'down') return out(remoteDown(env, realEffects(env), { agent }));
      throw new Fail('usage: loom box remote up|down <agent> [--box b] [--dir /path]', 2);
    }
    case 'rename-local': { out(renameLocal(env)); return; }
    case 'always-on': case 'report-only': {
      const [box, v] = positional(rest);
      if (!box || !['on', 'off'].includes(v)) throw new Fail(`usage: loom runtime ${cmd} <box> on|off`, 2);
      out(setBoxWatch(env, realEffects(env), { name: box, [cmd === 'always-on' ? 'alwaysOn' : 'reportOnly']: v }));
      return;
    }
    case 'health': {
      const [box] = positional(rest);
      const w = watchOf(env);
      const s = loadState(env);
      const ids = box ? [Object.keys(s.boxes).find((id) => id === box || s.boxes[id].name === box)].filter(Boolean) : Object.keys(w.boxes).filter((id) => s.boxes[id] && !s.boxes[id].revoked);
      if (box && !ids.length) throw new Fail(`no box ${box}`, 1);
      if (json) return out(Object.fromEntries(ids.map((id) => [id, { health: w.boxes[id]?.health ?? null, conditions: w.boxes[id]?.conditions ?? {}, units: w.boxes[id]?.units ?? {} }])));
      // Whatever a box sent is escaped again here: nothing it says reaches the owner's terminal as a control sequence.
      const esc = (v) => String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
      for (const id of ids) {
        const b = w.boxes[id] ?? {};
        process.stdout.write(`${esc(s.boxes[id].name ?? id)}: ${esc(healthWords(b.health))}${b.healthAt ? ` (${esc(b.healthAt)})` : ''}\n`);
        for (const c of Object.values(b.conditions ?? {})) process.stdout.write(`  now: ${esc(c.title)}: ${esc(c.detail)} (since ${esc(c.since)}${c.alerted ? ', alerted' : ''})\n`);
        for (const u of Object.values(b.units ?? {})) process.stdout.write(`  unit: ${esc(u.unit)} ${esc(u.state)} since ${esc(u.since)}\n`);
      }
      return;
    }
    case 'primary': { const [agent, ...boxes] = positional(rest); out(setPrimary(env, realEffects(env), { agent, boxes })); return; }
    case 'up': {
      let task = flag(rest, '--task');
      if (task === '-' || task === undefined) task = await readStdin();
      const call = ownerOrRemote(env);
      // On loom's own machine, a body asking for "a house" means its own: the household's default agent.
      const agent = flag(rest, '--agent') ?? (env.LOOM_URL && env.LOOM_TOKEN_FILE ? undefined : defaultAgent(env));
      const r = await call('up', { agent, box: flag(rest, '--box'), needs: flag(rest, '--needs'), task, slot: flag(rest, '--slot'), ...(ownConversation(env) ? bodyProof(env, ownConversation(env)) : {}), ...(ownConversation(env) ? { conversation: ownConversation(env) } : {}) });
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
      const code = await attachHere(env, r.id);
      process.stderr.write(`${r.id}: terminal left; use attach to reconnect or down to close its house\n`);
      process.exitCode = code;
      return;
    }
    case 'attach': {
      const id = positional(rest)[0];
      if (!/^h-\d+$/.test(id ?? '')) throw new Fail('usage: loom box attach <house>', 2);
      process.exitCode = await attachHere(env, id, { shell: rest.includes('--shell') });
      return;
    }
    case 'down': { out(await ownerOrRemote(env)('down', { id: positional(rest)[0], ...(ownConversation(env) ? { conversation: ownConversation(env), ...bodyProof(env, ownConversation(env)) } : {}) })); return; }
    case 'list': {
      const r = await ownerOrRemote(env)('list', {});
      if (json) return out(r);
      for (const b of r.boxes) process.stdout.write(`box ${b.name}${b.id !== b.name ? ` [${b.id}]` : ''}${b.local ? ' (loom\'s own)' : ''}${b.revoked ? ' REVOKED' : ''}: ${b.facts.join(', ')}\n`);
      for (const v of r.services ?? []) process.stdout.write(`service ${v.service} on ${v.box}${v.moveTo ? ` → ${v.moveTo}` : ''}: ${v.want}, house ${v.house} ${v.state ?? ''}\n`);
      for (const v of r.remotes ?? []) if (v.want === 'up' || v.state !== 'stopped') process.stdout.write(`box session "${v.name}" in ${v.dir}: ${v.want}, ${v.state}${v.url ? ` ${v.url}` : ''}${v.error ? ` (${v.error})` : ''}\n`);
      for (const h of r.houses) process.stdout.write(`${h.id} ${h.agent}${h.seat && h.seat !== 'owner' ? ` (for ${h.seat.startsWith('p-') ? h.seat.slice(2) : `one conversation, ${h.seat.slice(2)}`})` : ''} on ${h.box}: ${houseBadge(h)}  ${h.task.slice(0, 60)}\n`);
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
      // A report-only box (keeping-watch.md, "The hypervisor"): it reports its numbers and takes nothing, and never
      // upgrades itself from what loom says. Kept in box.json, and said on every poll.
      if (rest.includes('--report-only')) {
        const p = `${stateDir(env)}/box.json`;
        writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf-8')), reportOnly: true }, null, 2) + '\n', { mode: 0o600 });
        process.stdout.write(`Joined as ${hi.name ?? hi.box} (${hi.box}), report-only. Run \`loom box run\` (or its user service) to start reporting.\n`);
        return;
      }
      process.stdout.write(`Joined as ${hi.name ?? hi.box} (${hi.box}). Run \`loom box run\` (or its user service) to start taking houses.\n`);
      return;
    }
    case 'upgrade-apply': {
      // The recovery timer's run: a swap that stopped part-way, finished or rolled back (version.mjs).
      if (rest.includes('--recover')) {
        const r = recoverUpgrade({ env, stateDir: stateDir(env) });
        out(r ?? { state: 'nothing to recover' });
        if (r && r.state === 'rolling-back') throw new Fail(r.error, 1);
        return;
      }
      // The detached unit maybeUpgrade starts (version.mjs): the install, or the box→runtime swap.
      const r = applyUpgrade({ commit: flag(rest, '--commit'), from: flag(rest, '--from'), repo: flag(rest, '--repo') || undefined,
        piece: flag(rest, '--piece'), target: flag(rest, '--target'), env, stateDir: stateDir(env) });
      out(r);
      if (r.state !== 'done') throw new Fail(r.error, 1);
      return;
    }
    case 'carry-settings': {
      // After swapping the old box piece for runtime by hand: its settings, under the new names (version.mjs).
      const r = carrySettings(env, { from: flag(rest, '--from') || 'box', to: flag(rest, '--to') || 'runtime' });
      if (r.error) throw new Fail(r.error, 1);
      process.stdout.write(`carried ${r.carried} setting${r.carried === 1 ? '' : 's'} from ${flag(rest, '--from') || 'box'} to ${flag(rest, '--to') || 'runtime'} (${r.declared} also under the new names)\n`);
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
        client = inProcessBoxClient(env, effects, caller);
        loomUrl = setting(env, 'LOOM_URL') || 'http://127.0.0.1:8787/mcp';
      } else {
        const c = loadConfig(env);
        client = remoteClient(c.url, readFileSync(`${stateDir(env)}/credential`, 'utf-8').trim(), fetch, c.piece);
        loomUrl = `${c.url.replace(/\/+$/, '')}/mcp`;
        labels = c.labels || [];
      }
      // A login's pasted code travels this channel: only over HTTPS, the tailnet or loopback (logins.mjs).
      const r = runner(env, client, { loomUrl, labels, secureChannel: local || secureLoomUrl(loadConfig(env).url) });
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
          // A sign-in under way doesn't outlive this process: loom is told why, and its container stopped.
          stopping = Promise.all([r.endStarts(), r.endLogins()]).finally(() => process.exit(0));
          return;
        }
        process.stderr.write(`loom-box: SIGTERM: stopping ${r.houses.size} house(s) before exit\n`);
        stopping = r.shutdown().then(() => process.exit(0));
      });
      for (;;) {
        if (stopping) return;
        try { await r.tick({ wait: rest.includes('--once') }); } catch (err) { process.stderr.write(`loom-box: poll: ${err.message}\n`); }
        if (rest.includes('--once') || stopping) return;
        await sleep(every);
      }
    }
    case 'body': return body(rest, env, json);
    case 'deliver': return delivery(rest, env, json);
    case 'review': return reviewCli(rest, env, json);
    case 'send': {
      // From a body in its house: through the piece API, as its own agent (its house's token), with its run's key.
      // The key for that conversation as its house keeps it (bodyhost.mjs), else this body's environment's.
      const conversation = flag(rest, '--conversation');
      // And its harness's own session id: the runtime checks it's the session holding the conversation. Claude Code
      // sets CLAUDE_CODE_SESSION_ID per session (under a shared daemon too); Codex gives each command it runs
      // CODEX_THREAD_ID, the thread its `thread.started` named, which is a Codex body's slot (runners.mjs). Without
      // it every send from a Codex body was refused as naming no session (t-1898, Mark's Comms reply of 2026-11-06).
      const session = bodySession(env);
      // --person <slug> --via <venue>: one DM to that person instead, through that venue's adapter (delivery.mjs).
      const person = flag(rest, '--person');
      const via = flag(rest, '--via');
      const msg = { conversation, text: await textOf(rest, '--text'), key: bodyKeyFor(env, conversation), ...(session ? { session } : {}), ...(person !== undefined ? { person } : {}), ...(via !== undefined ? { via } : {}) };
      const remote = env.LOOM_URL && env.LOOM_TOKEN_FILE;
      const call = remote ? pieceCall(env, flag(rest, '--piece')) : null;
      const r = await untilSessionKnown(() => (remote ? call('send', msg) : send(env, msg, { detach: true })));
      // Accepted isn't posted (t-1920): wait for what the venue said, so a body never reports a message it didn't send.
      const answer = r.accepted ? await sendOutcome({
        status: (q) => (remote ? call('send-status', q) : sendStatus(env, q)),
        relay: remote ? (piece, argv) => pieceCall(env, piece)('run', { argv }) : null,
        sleep,
      }, { conversation, ref: r.ref, text: msg.text, person, via }) : r;
      out(answer);
      if (!answer.ok) process.exitCode = 1;
      return;
    }
    case 'spawn': {
      const { spawnCall, spawnTool } = await import('./spawn.mjs');
      if (rest[0] === 'tool') {
        const r = await spawnTool(env, rest.slice(1), await readStdin());
        out(r); if (r.isError) process.exitCode = 1; return;
      }
      const action = ['wait', 'result', 'say', 'roles'].includes(rest[0]) ? rest[0] : 'start';
      const cv = ownConversation(env);
      const body = !!(env.HOUSE_ID || env.LOOM_BODY_KEY || env.LOOM_BODY_CONVERSATION);
      const remote = !!(env.LOOM_URL && env.LOOM_TOKEN_FILE);
      if (body && !cv) throw new Fail('spawn: cannot identify this body\'s conversation');
      let agent = flag(rest, '--agent');
      if (!agent || agent === 'self') agent = (body || remote) ? undefined : defaultAgent(env);
      const callerAgent = !remote && body ? (await import('./delivery.mjs')).loadConv(env, cv)?.agent : agent;
      const q = { action: action === 'wait' ? 'result' : action, agent, ...(cv ? { conversation: cv, ...bodyProof(env, cv) } : {}),
        ...(action === 'start' ? { brief: await textOf(rest, '--brief'), prefer: flag(rest, '--prefer'), role: flag(rest, '--role'), ...(rest.includes('--failover') ? { failover: true } : {}), title: flag(rest, '--title') } : { handle: rest[1] }),
        ...(action === 'say' ? { text: await textOf(rest, '--text') } : {}) };
      const call = () => remote ? pieceCall(env)('spawn', q) : spawnCall(env, body ? { kind: 'agent', agent: callerAgent } : { kind: 'owner' }, q, { detach: true });
      const timeout = Number(flag(rest, '--timeout') ?? 600);
      if (!Number.isFinite(timeout) || timeout < 0 || timeout > 86400) throw new Fail('spawn: timeout is 0–86400 seconds');
      const end = Date.now() + timeout * 1000;
      for (;;) {
        const r = await call();
        if (action !== 'wait' || r.state !== 'pending' || Date.now() >= end) {
          if ((action === 'wait' || action === 'result') && r.state === 'done') process.stdout.write(r.report + '\n');
          else out(r);
          if (action === 'wait' && r.state !== 'done') process.exitCode = r.state === 'pending' ? 3 : 1;
          return;
        }
        await sleep(1000);
      }
    }
    case 'principal': {
      // On whose behalf a body acts (principal.mjs, t-1943). --verify and --wake read and write this machine's runtime
      // state only, never through the piece API: a house has no signing key (so nothing verifies there) and can't
      // hand over a wake's principal (only the clock, here, does).
      const { bodyPrincipal, handOverWake, verifyStatement, resetPrincipal } = await import('./delivery.mjs');
      const { AGENT_NAME } = await import('./state.mjs');
      if (rest.includes('--verify')) {
        const r = verifyStatement(env, (await readStdin()).trim());
        out(r);
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (rest.includes('--reset')) {
        // The owner's, on loom's machine: this conversation is his from here (it ran before the runtime kept who
        // steered it, or heard someone he vouches for). Never through the piece API.
        // Never a body's, wherever it runs: a house's, or a local one's on this machine (its run's key and conversation
        // are in its environment). t-1952: the reset it makes is signed as the owner's.
        if ((env.LOOM_URL && env.LOOM_TOKEN_FILE && env.HOUSE_ID) || env.HOUSE_ID || env.LOOM_BODY_KEY || env.LOOM_BODY_CONVERSATION) throw new Fail('principal --reset is the owner\'s, on loom\'s machine, never a body\'s');
        // The environment is the caller's to unset, so the owner says it at the point of action: at a terminal, typing
        // the conversation's id (t-1952). A body has no controlling terminal (`claude --bg`, a house, a detached worker).
        const cv = flag(rest, '--conversation');
        if (!ownerAtTerminal(`Reset who ${cv ?? '?'} acts for, as the owner (its session is dropped)? Type its id to confirm: `, cv)) throw new Fail('principal --reset is the owner\'s, at a terminal on loom\'s machine, never a body\'s: run it yourself and type the conversation id');
        const r = resetPrincipal(env, cv);
        out(r);
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (rest.includes('--wake')) {
        const agent = flag(rest, '--agent');
        const place = flag(rest, '--place');
        const who = flag(rest, '--for');
        const id = flag(rest, '--id');
        if (!AGENT_NAME.test(agent ?? '') || typeof place !== 'string' || !place || place.length > 200) throw new Fail('principal --wake --agent <agent> --place <place> --id <delivery id> --for owner|<slug>|-');
        try { handOverWake(env, { agent, place, id, for: who, origin: flag(rest, '--origin-conversation') }); } catch (e) { throw new Fail(e.message); }
        out({ ok: true });
        return;
      }
      // A body asking: in a house through the piece API (its house's token), else here; with its run's key and session.
      const conversation = flag(rest, '--conversation') || ownConversation(env);
      if (!conversation) throw new Fail('principal: this body can\'t tell its own conversation yet (name it with --conversation)');
      const session = bodySession(env);
      const q = { conversation, key: bodyKeyFor(env, conversation), ...(session ? { session } : {}) };
      const remote = env.LOOM_URL && env.LOOM_TOKEN_FILE;
      const r = await untilSessionKnown(async () => (remote ? pieceCall(env, flag(rest, '--piece'))('principal', q) : bodyPrincipal(env, q)));
      out(r);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'task-host': {
      if (!env.HOUSE_ID || !env.LOOM_URL || !env.LOOM_TOKEN_FILE) throw new Fail('task-host runs only in its allocated house');
      const call = pieceCall(env);
      const { runTaskClient } = await import('./taskclient.mjs');
      const result = await runTaskClient({ call, env, brief: rest.includes('--brief-stdin') ? await readStdin() : undefined,
        runner: h => runnerFor(h, env), log: m => process.stderr.write(`loom-runtime task-host: ${m}\n`) });
      if (result?.report) process.stdout.write(result.report + '\n');
      if (!result?.ok) throw new Fail(result?.reason || 'task host ended before its result was collected', result?.cancelled ? 130 : 1);
      return;
    }
    case 'session-host': {
      if (!env.HOUSE_ID || !env.LOOM_URL || !env.LOOM_TOKEN_FILE) throw new Fail('session-host runs only in its allocated house');
      const call = pieceCall(env);
      const boot = await call('session-bootstrap', {});
      if (boot.error || !boot.hostKey) throw new Fail(boot.error || 'the runtime did not bootstrap this session');
      await runBodyHost({ client: async (p, b) => { const r = await call(p, b); if (r.error) throw new Fail(r.error); return r; }, runner: h => runnerFor(h, env), env, hostKey: boot.hostKey, idleS: 0,
        log: m => process.stderr.write(`loom-runtime session-host: ${m}\n`) });
      return;
    }
    case 'body-host': {
      // In an agent's house, as its task (houserunner.mjs, hostTask): wake the bodies the runtime asks for, here.
      if (!env.LOOM_URL || !env.LOOM_TOKEN_FILE) throw new Fail('the body host runs in a house: it needs LOOM_URL and LOOM_TOKEN_FILE');
      const call = pieceCall(env, flag(rest, '--piece'));
      await runBodyHost({ client: async (p, b) => { const r = await call(p, b); if (r.error) throw new Fail(r.error); return r; }, runner: (h) => runnerFor(h, env), env, hostKey: flag(rest, '--host-key'), log: (m) => process.stderr.write(`loom-runtime body-host: ${m}\n`), ...(flag(rest, '--beats') ? { beats: Number(flag(rest, '--beats')) } : {}) });
      return;
    }
    case 'models': return models(rest, env, json);
    case 'roles': return roles(rest, env, json);
    case 'grants': {
      if (env.LOOM_URL && env.LOOM_TOKEN_FILE) return runAnswer(await pieceCall(env)('run', { argv: ['grants', ...rest] }));
      if (env.HOUSE_ID) throw new Fail('grants in a house need LOOM_URL and LOOM_TOKEN_FILE; the grants live on loom', 2);
      return grantsCli(rest, env);
    }
    case 'trace': {
      const { trace, traceText, traceTool } = await import('./trace.mjs');
      if (rest[0] === 'tool') {
        const r = await traceTool(env, rest.slice(1), await readStdin());
        process.stdout.write(`${JSON.stringify(r.answer)}\n`);
        process.exitCode = r.exit;
        return;
      }
      const q = {};
      for (const k of ['thread', 'run', 'conversation']) { const v = flag(rest, `--${k}`); if (v !== undefined) q[k] = v; }
      // In a house: its own agent's, as its token says, through the piece API. At loom's machine: the owner's.
      const t = env.LOOM_URL && env.LOOM_TOKEN_FILE ? await pieceCall(env, flag(rest, '--piece'))('trace', q) : await trace(env, { agents: '*' }, q);
      if (t?.ok === false || t?.error) { process.stderr.write(`${t.reason ?? t.error}\n`); process.exitCode = 1; return; }
      if (json) return out(t);
      process.stdout.write(`${traceText(t)}\n`);
      return;
    }
    case 'place': {
      // Where this body is (gates-api.mjs, placeOf): its own conversation, proved as a relay or `send` proves it. In a
      // house, through the piece API; on loom's machine (a local body), here.
      const mine = ownConversation(env);
      if (!mine) throw new Fail('loom runtime place: can\'t tell this body\'s own conversation (none mapped for its session, or none in its environment)', 2);
      if (env.LOOM_URL && env.LOOM_TOKEN_FILE) return runAnswer(await pieceCall(env, flag(rest, '--piece'))('run', { argv: ['place', '--conversation', mine], ...bodyProof(env, mine) }));
      const { placeOf } = await import('./gates-api.mjs');
      const r = await placeOf(env, mine, bodyProof(env, mine));
      if (!r.ok) throw new Fail(r.reason);
      return out(r.place);
    }
    case 'relays':
    case 'relay': {
      if (cmd === 'relays' || rest[0] !== 'tool') {
        if ((!env.LOOM_URL || !env.LOOM_TOKEN_FILE) && ownConversation(env)) {
          // A body on loom's machine (a local wake, t-1953): no house token, so here, as `place` is. Only with its proof
          // (its run's key and session): it relays as its conversation's agent, and spends an approval for whom that
          // conversation acts. Without the proof nothing is sent: loom's machine is no shortcut past it.
          const mine = ownConversation(env);
          const { loadConv, holdsRun } = await import('./delivery.mjs');
          const c = loadConv(env, mine);
          const proof = bodyProof(env, mine);
          const caller = { kind: 'agent', agent: c?.agent };
          if (!c?.agent || !proof.key || !holdsRun(env, mine, proof, { caller })) throw new Fail(`loom runtime relay: this body can't prove it holds ${mine} (its run's key and session), so it can't relay from here`, 1);
          const named = rest.includes('--conversation') ? rest[rest.indexOf('--conversation') + 1] : undefined;
          if (named !== undefined && named !== mine) throw new Fail(`relay: --conversation is this body's own (${mine}); a relay's answer comes back only to the conversation that asked`, 2);
          const argv = [cmd, ...rest, ...(cmd === 'relay' && named === undefined ? ['--conversation', mine] : [])];
          const { runFor } = await import('./gates-api.mjs');
          return runAnswer(await runFor(env, caller, argv, undefined, undefined, undefined, cmd === 'relay' ? proof : {}));
        }
        if (!env.LOOM_URL || !env.LOOM_TOKEN_FILE) throw new Fail('loom runtime relay and relays are a body\'s, from its house (its token: LOOM_URL and LOOM_TOKEN_FILE) or a body on loom\'s machine (LOOM_BODY_CONVERSATION): loom runtime relay --to <agent> --say <text>; the tool core runs is `relay tool`', 2);
        // A relay from a body names its own conversation (LOOM_BODY_CONVERSATION, unless it names one) and proves it
        // holds it, as `send` does: its run's key and harness session, in the body of the call, never in argv.
        let argv = [cmd, ...rest];
        let proof = {};
        if (cmd === 'relay') {
          const mine = ownConversation(env);
          const named = argv.includes('--conversation') ? argv[argv.indexOf('--conversation') + 1] : undefined;
          // Only this body's own conversation: naming another is refused here, and proved nowhere (the runtime checks too).
          if (mine && named !== undefined && named !== mine) throw new Fail(`relay: --conversation is this body's own (${mine}); a relay's answer comes back only to the conversation that asked`, 2);
          if (mine && named === undefined) argv = [...argv, '--conversation', mine];
          proof = mine ? bodyProof(env, mine) : {};
        }
        return runAnswer(await pieceCall(env)('run', { argv, ...proof }));
      }
      const { relayTool } = await import('./relay.mjs');
      const r = await relayTool(env, rest.slice(1), await readStdin());
      process.stdout.write(`${JSON.stringify(r.answer)}\n`);
      process.exitCode = r.exit;
      return;
    }
    case 'secrets-map': {
      // Which secret each agent's houses got from the runtime's own map, for the secrets piece's policy to take over
      // (agent-runtime.md, section 6, Secrets): loom runtime secrets-map --json | loom secrets policy houses-import.
      const s = loadState(env);
      const m = {};
      for (const [agent, a] of Object.entries(s.agents ?? {})) {
        const names = [...Object.values(a.secrets ?? {}).filter((v) => typeof v === 'string' && !v.startsWith('sub:')), ...(a.repoSecret ? [a.repoSecret] : [])];
        if (names.length) m[agent] = [...new Set(names)].sort();
      }
      return out(m);
    }
    case 'gates': return gatesCli(rest, env);
    case 'policy': return policyCli(rest, env);
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
      // A Claude session's status line (statusline.mjs): its rate limits kept by session, for `report --session`.
      if (rest[0] === 'statusline') {
        const got = (() => { try { return captureStatusline(usageDirOf(env), process.stdin.isTTY ? '' : readFileSync(0, 'utf-8')); } catch { return null; } })();
        process.stdout.write(`${statuslineText(got?.reading)}\n`);
        return;
      }
      const h = flag(rest, '--harness');
      if (rest[0] !== 'report' || !h) throw new Fail('usage: loom runtime usage report --harness claude|codex [--session <id>] < output.jsonl', 2);
      // A Claude session whose status line kept its reading (a `claude --bg` body: it has no stream-json to pipe).
      const session = flag(rest, '--session');
      // Codex with nothing piped: its own newest session rollout ($CODEX_HOME/sessions).
      const piped = session || process.stdin.isTTY ? '' : await readStdin();
      const reading = session ? (h === 'claude' ? keptReading(usageDirOf(env), session) : null)
        : piped.trim() ? lastRateLimit(h, piped)
        : h === 'codex' ? codexUsageOnBox(env, { root: join(env.CODEX_HOME || join(env.HOME, '.codex'), 'sessions') }) : null;
      if (!reading) { process.stderr.write('no rate-limit reading in that output\n'); return; }
      return out(await ownerOrRemote(env)('usage', { harness: h, reading: { ...reading, checked: reading.checked ?? Math.floor(Date.now() / 1000) } }));
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

/**
 * loom runtime deliver …: with no verb, one delivery (the body on stdin, the answer on stdout; a refusal or a turn
 * core couldn't write is {status, error}, exit 1). The body is reached from a detached process, so a harness slow to
 * start doesn't hold the source past its 2 s.
 */
async function delivery(rest, env, json) {
  const [sub] = positional(rest);
  if (sub === undefined) {
    let raw;
    try { raw = JSON.parse(await readStdin()); } catch { raw = null; }
    const r = await deliver(env, raw, { detach: true });
    out(r);
    if (r.status) process.exitCode = 1;
    return;
  }
  if (sub === 'tick') {
    // A delivery's worker: a message the runtime couldn't seal comes on stdin ({key: text}), never in a file or argv.
    let mem = new Map();
    if (rest.includes('--stdin')) { try { mem = new Map(Object.entries(JSON.parse((await readStdin()) || '{}')).filter(([, v]) => typeof v === 'string')); } catch { mem = new Map(); } }
    return tick(env, {}, flag(rest, '--conversation'), mem);
  }
  if (sub === 'post') {
    // A body's accepted message, posted (delivery.mjs, post): its text on stdin, never a file or argv.
    let m = {};
    try { m = JSON.parse((await readStdin()) || '{}'); } catch { m = {}; }
    if (typeof m.text !== 'string') throw new Fail('post takes {text, body?, run?} on stdin');
    return out(await post(env, flag(rest, '--conversation'), flag(rest, '--ref'), m.text, { body: m.body, run: m.run, ...(m.to !== undefined ? { to: m.to } : {}) }));
  }
  if (sub === 'run') {
    const every = Number(flag(rest, '--every')) || 5000;
    let watched = 0;
    for (;;) {
      try { await tick(env); } catch (err) { process.stderr.write(`loom-runtime deliver: tick: ${err.message}\n`); }
      await tellAtWork(env);
      // The bridges' outages, noted even while nothing reads the manifest (loom down for a deploy): each half minute.
      if (Date.now() - watched >= WATCH_EVERY_MS) { watched = Date.now(); try { watchBridges(env); } catch (err) { process.stderr.write(`loom-runtime deliver: bridge watch: ${err.message}\n`); } }
      // The day's review, once it's due (review.mjs): started detached, so the tick never waits on it.
      try { const r = await reviewTick(env); if (r?.started) process.stderr.write(`loom-runtime deliver: started the review for ${r.started}\n`); } catch (err) { process.stderr.write(`loom-runtime deliver: review tick: ${err.message}\n`); }
      if (rest.includes('--once')) return;
      await sleep(every);
    }
  }
  if (sub === 'list') {
    // Names and states only: a waiting message's text stays sealed.
    const l = listConvs(env).map(({ outcomes: _o, queue, ...c }) => ({ ...c, queued: queue?.length ?? 0 }));
    if (json) return out(l);
    for (const c of l) process.stdout.write(`${c.conversation} ${c.agent} ${c.venue} ${c.label ?? c.place}: ${c.paused ? `PAUSED (${c.paused.reason}), ` : ''}${c.body ?? (c.slot ? `slot until ${c.slot.until}` : 'no body')}${c.queued ? `, ${c.queued} waiting (${c.waiting})` : ''}\n`);
    return;
  }
  if (sub === 'stale-runs') {
    // Read only (t-1958): conversations whose current run is still open with its body gone, what a sweep would close.
    const l = staleRuns(env);
    if (json) return out(l);
    // A 'live' one is off its record but may still be mid-turn: never one to close without looking.
    for (const r of l) process.stdout.write(`${r.conversation} ${r.agent} ${r.venue} ${r.place}: ${r.run} open since ${r.since}, body ${r.body ?? 'none'} ${r.bodyState}${r.onRecord ? '' : ', off its record'}${r.bodyState === 'live' ? ' (may still be working: look first)' : ''}\n`);
    const live = l.filter((r) => r.bodyState === 'live').length;
    process.stdout.write(`${l.length} open run${l.length === 1 ? '' : 's'} off a body at work${live ? `, ${live} whose body may still be working` : ''}\n`);
    return;
  }
  if (sub === 'resume' || sub === 'dismiss') {
    // A conversation paused as a loop (loops.mjs): resume starts what waited; dismiss drops it.
    const cv = positional(rest)[1];
    const r = await answerLoop(env, cv, sub, { detach: true }).catch((e) => { throw new Fail(e.message); });
    if (json) return out(r);
    process.stdout.write(`${cv}: ${sub === 'resume' ? `resumed, ${r.waiting} waiting starts` : `dismissed, ${r.waiting} waiting dropped`}\n`);
    return;
  }
  throw new Fail('usage: loom runtime deliver [tick|run|list|stale-runs|resume <cv>|dismiss <cv>] …', 2);
}

/** loom runtime review …: a run by hand, and what the runs did (counts and families, never text). */
async function reviewCli(rest, env, json) {
  const [sub] = positional(rest);
  if (sub === 'run') {
    const limit = flag(rest, '--limit');
    const r = await runReview(env, {
      ...(limit !== undefined ? { limit: Number(limit) } : {}), ...(flag(rest, '--introspect') !== undefined ? { introspect: flag(rest, '--introspect') } : {}),
      trigger: rest.includes('--scheduled') ? 'scheduled' : 'by-hand', ...(flag(rest, '--day') ? { day: flag(rest, '--day') } : {}),
    });
    if (r.error) process.exitCode = 1;
    if (json) return out(r);
    return process.stdout.write(reviewLine(r));
  }
  if (sub === 'status') {
    const st = reviewStatus(env);
    if (json) return out(st);
    process.stdout.write(st.schedule ? `schedule: ${st.schedule.day ? `last run for ${st.schedule.day}` : 'armed for the next 04:00'}\n` : 'schedule: not seen yet\n');
    for (const r of st.runs) process.stdout.write(reviewLine(r));
    return;
  }
  throw new Fail('usage: loom runtime review run|status …', 2);
}

const reviewLine = (r) => `${r.at} ${r.day ?? ''} (${r.trigger}): ${r.error ? `failed: ${r.error}` : r.off ? 'off' : r.replaced ? `replaced by the household's command (exit ${r.exit})`
  : `${r.taken} taken, ${r.graded} graded (${Object.entries(r.graders ?? {}).map(([f, n]) => `${f} ${n}`).join(', ') || 'no graders'}${r.same_family ? `, ${r.same_family} same-family` : ''}), `
  + `${r.scores} scores, ${r.findings} findings${r.findings_refused ? ` (${r.findings_refused} past the day's cap)` : ''}, ${r.unscorable} unscorable, ${r.ungraded} ungraded, ${r.failed} failed, ${r.done} done`
  + `${r.nothing_graded ? `; nothing graded: ${r.nothing_graded}` : ''}${r.introspection ? `; introspection: ${r.introspection.map((x) => `${x.agent} ${x.body}`).join(', ') || 'none'}` : ''}`}\n`
  + (r.why?.length ? r.why.map((w) => `  ${w}\n`).join('') : '');

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
    // --suppose-out <harness>: what it would pick if that harness's accounts were out (nothing is spent or held).
    const gone = flags(rest, '--suppose-out');
    const accounts = gone.length ? supposeOut(accountsFrom(env), gone) : accountsFrom(env);
    const r = await resolveFor(env, { agent: flag(rest, '--agent') ?? defaultAgent(env), venue: flag(rest, '--venue'), venueKind: flag(rest, '--venue-kind'), prefer: flags(rest, '--prefer'), accounts });
    if (json) return out(r);
    process.stdout.write(`${r.model} (${r.harness}, ${r.family})${r.account ? ` on ${r.account}` : ''}\n${r.why.map((w) => `  ${w}`).join('\n')}\n`);
    return;
  }
  throw new Fail('usage: loom runtime models [set|resolve] …', 2);
}

/**
 * The worker roles (models.mjs, t-2036): `loom runtime roles` lists them, for any body or the owner; `roles set`
 * (a role as JSON on stdin) and `roles remove <id>` are the household owner's, each with `--why`. Here on loom's
 * machine it reads the runtime's state; elsewhere (a house) it asks the piece.
 */
async function roles(rest, env, json) {
  const [sub, id] = positional(rest);
  const remote = !!(env.LOOM_URL && env.LOOM_TOKEN_FILE);
  const why = flag(rest, '--why');
  let q = {};
  if (sub === 'set') q = { role: JSON.parse(await readStdin()), ...(why ? { why } : {}) };
  else if (sub === 'remove') { if (!id) throw new Fail('usage: loom runtime roles remove <id> --why …', 2); q = { remove: id, ...(why ? { why } : {}) }; }
  else if (sub !== undefined) throw new Fail('usage: loom runtime roles [set|remove <id>] [--why …]', 2);
  let r;
  if (remote) r = await pieceCall(env)('roles', q);
  else if (env.HOUSE_ID) throw new Fail('roles in a house need LOOM_URL and LOOM_TOKEN_FILE', 2);
  else {
    const m = await import('./models.mjs');
    r = sub === undefined ? m.readRoles(env) : m.setRole(env, { ...q, by: 'owner' });
  }
  if (r?.error) throw new Fail(r.error);
  if (json || sub !== undefined) return out(r);
  if (!r.roles.length) { process.stdout.write('no roles yet: the owner adds them (loom runtime roles set)\n'); return; }
  process.stdout.write(`catalog v${r.version}\n`);
  for (const x of r.roles) {
    process.stdout.write(`${x.id}: ${x.description}\n  eligible: ${x.eligible.join(', ') || '(none: its models left the list)'}${x.failover ? '; may move to another eligible model when out of quota' : ''}\n`);
    for (const k of ['needs', 'input', 'output', 'dossier']) if (x[k]) process.stdout.write(`  ${k}: ${x[k]}\n`);
  }
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

/** Reconnect its owner-controlled runtime conversation; an explicit shell keeps the same house's reach. */
async function attachHere(env, id, { shell = false } = {}) {
  const f = `${env.LOOM_BOX_DATA || `${env.HOME}/.local/share/loom-box`}/houses/${id}/attach.json`;
  if (!existsSync(f)) throw new Fail(`${id} isn't a session house on this box`);
  const { container } = JSON.parse(readFileSync(f, 'utf-8'));
  const intoShell = async () => {
    const r = spawnSync(env.LOOM_BOX_PODMAN || 'podman', ['exec', '-it', container, '/bin/sh'], { stdio: 'inherit' });
    if (r.status) throw new Fail(`house shell exited ${r.status}`);
  };
  if (shell) { await intoShell(); return 0; }
  const { runTerminal, waitTerminalReady } = await import('./terminal.mjs');
  const call = ownerOrRemote(env);
  await waitTerminalReady(call, id);
  return runTerminal({ call, id, shell: intoShell });
}

// `loom box list | head` closes stdout early: that's fine, not a crash.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  // A runtime swapped in for the old box piece: the old piece's settings it carried (version.mjs, carried.env).
  loadCarried(process.env);
  main(process.argv.slice(2), process.env).then(
    () => {},
    (err) => {
      if (err.message) process.stderr.write(`loom ${/loom-box$/.test(process.argv[1] ?? '') ? 'box' : 'runtime'}: ${err.message}\n`);
      process.exit(typeof err.code === 'number' ? err.code : 1);
    },
  );
}

export { main };

/**
 * This body's own conversation, or undefined: the one its house says its harness session holds (bodyhost.mjs,
 * bodyConversation), its LOOM_BODY_CONVERSATION only when nothing says otherwise. A reused `claude --bg` session keeps
 * the environment of the body it was first started for (t-2053), so the environment alone never names it.
 */
function ownConversation(env) {
  // Told once per command (it may wait on its house): a property, as main runs before this module's own lets do.
  const m = ownConversation.memo;
  if (m?.env === env) return m.cv;
  const cv = bodyConversation(env);
  ownConversation.memo = { env, cv };
  return cv;
}

/** A body's proof that it holds `cv` in its current run (as `send` takes it): its run's key and harness session. */
function bodyProof(env, cv) {
  const key = bodyKeyFor(env, cv);
  const session = bodySession(env);
  return { ...(key ? { key } : {}), ...(key && session ? { session } : {}) };
}

/**
 * A proof the runtime refused only because it can't name this body's session yet (a house body's host reports it
 * within a beat of the start, t-2053): asked again a few times, never with anything else changed.
 */
async function untilSessionKnown(ask, { tries = 6, ms = 2000 } = {}) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await ask();
    if (r?.ok !== false || !/session can't be told yet/.test(String(r.reason ?? r.error ?? ''))) return r;
    if (i < tries - 1) await sleep(ms);
  }
  return r;
}

/** A piece API `run` answer, as this command's own output and exit. */
function runAnswer(r) {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (!Number.isInteger(r.exit) && r.ok !== false) throw new Fail('runtime did not return a command outcome');
  if (r.exit || r.ok === false) throw new Fail(r.error ?? r.reason ?? '', r.exit || 1);
}
