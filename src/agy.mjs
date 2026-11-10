// Antigravity's one-turn file runner. No login/profile/keyring file is opened,
// linked or copied here. agy alone authenticates through the box's keyring.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agyCards } from './activity.mjs';
import { agyActionNow } from './ticker.mjs';

const ID = /^[0-9a-f]{8,24}$/;
const read = p => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const json = p => { try { return JSON.parse(read(p)); } catch { return null; } };
const refused = message => Object.assign(new Error(message), { nativeNotStarted: true });

export class AgyRunner {
  harness = 'agy';
  roots = {};
  constructor({ agy = 'agy', runsDir = join(homedir(), '.local/share/loom-runtime/agy-runs'), mcpFile = join(homedir(), '.gemini/config/mcp_config.json'), spawn = nodeSpawn, key = () => randomBytes(12).toString('hex') } = {}) {
    Object.assign(this, { agy, runsDir, mcpFile, spawn, key });
  }
  // Only whole MCP servers can be removed from the generated config. Built-ins
  // and individual-tool denies must never silently become a wider permission.
  plan(deny = [], cwd = process.cwd()) {
    const off = new Set();
    for (const name of deny) {
      const m = /^mcp__([A-Za-z0-9_-]+)$/.exec(name);
      if (!m || m[1].includes('__')) return { why: 'agy cannot enforce this individual-tool or built-in deny' };
      off.add(m[1]);
    }
    // A project or plugin can add servers outside the private HOME. Until agy
    // exposes a strict config flag, refuse these layers, even without denies.
    let canonical;
    try { canonical = realpathSync(cwd); } catch { return { why: 'agy workspace cannot be inspected' }; }
    for (let at = canonical; ; at = dirname(at)) {
      for (const name of ['.agents/mcp_config.json', '.agents/plugins', '.gemini/settings.json', '.gemini/extensions']) {
        if (existsSync(join(at, name))) return { why: 'agy workspace configuration can add tool servers outside the allowed list' };
      }
      if (at === dirname(at)) break;
    }
    let config = {};
    try { config = JSON.parse(readFileSync(this.mcpFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') return { why: 'agy MCP configuration is unreadable' }; }
    if (!config || typeof config !== 'object' || Array.isArray(config) || config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) return { why: 'agy MCP configuration is invalid' };
    return { servers: Object.fromEntries(Object.entries(config.mcpServers ?? {}).filter(([name]) => !off.has(name))) };
  }
  wontRun(deny, cwd) { return this.plan(deny, cwd).why ?? null; }
  start({ brief, model, cwd = process.cwd(), env = process.env, deny = [], launchToken }) {
    const plan = this.plan(deny, cwd);
    if (plan.why) throw refused(plan.why);
    const id = launchToken ?? this.key();
    if (!ID.test(id)) throw refused('invalid agy launch token');
    const dir = join(this.runsDir, id), home = join(dir, 'home');
    if (existsSync(dir)) throw Error('agy launch already exists; recover its original admission');
    mkdirSync(join(home, '.gemini/config'), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, '.gemini/antigravity-cli'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.gemini/config/mcp_config.json'), JSON.stringify({ mcpServers: plan.servers }), { mode: 0o600 });
    writeFileSync(join(home, '.gemini/antigravity-cli/settings.json'), JSON.stringify({ trustedWorkspaces: [resolve(cwd)] }), { mode: 0o600 });
    // No caller settings or provider keys can redirect this login or re-add MCP.
    // DBUS_SESSION_BUS_ADDRESS may point agy at the box's own unlocked keyring;
    // the runtime neither opens that connection nor reads its contents.
    const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !/^(AGY_|ANTIGRAVITY_|GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|CLAUDE_|CODEX_|XDG_CONFIG_HOME$|XDG_DATA_HOME$)/.test(k) && k !== 'CLAUDECODE'));
    const argv = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--dangerously-skip-permissions',
      '--log-file', join(dir, 'cli.log'), ...(model ? ['--model', model] : [])];
    const out = openSync(join(dir, 'events.jsonl'), 'a', 0o600), err = openSync(join(dir, 'stderr.txt'), 'a', 0o600);
    let child;
    try {
      child = this.spawn(process.execPath, [fileURLToPath(new URL('./agy-host.mjs', import.meta.url)), dir], {
        cwd, env: { ...clean, HOME: home, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, stdio: ['pipe', out, err], detached: true,
      });
    } finally { closeSync(out); closeSync(err); }
    child.on?.('error', () => {});
    if (!child.pid) throw refused('agy host did not start');
    writeFileSync(join(dir, 'pid'), String(child.pid), { mode: 0o600 });
    // Host receives private executable/argv and exactly one user event on stdin.
    // Closing stdin cannot lose the final result: the host waits for agy exit.
    const piped = new Promise((done, fail) => {
      child.stdin.once('error', fail);
      child.stdin.end(JSON.stringify({ executable: this.agy, argv, prompt: { event: 'user', message: { content: brief } } }), error => error ? fail(error) : done());
    });
    const inputReady = piped.then(async () => {
      const deadline = Date.now() + 10000;
      while (!existsSync(join(dir, 'input-ready'))) {
        if (existsSync(join(dir, 'exit.json')) || Date.now() >= deadline) throw Error('agy prompt delivery is unconfirmed');
        await new Promise(done => setTimeout(done, 20));
      }
    });
    child.unref();
    return { id, harness: 'agy', model, inputReady };
  }
  events(id) { return read(join(this.runsDir, id, 'events.jsonl')).split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }); }
  alive(id) {
    if (!ID.test(id ?? '')) return false;
    const pid = Number(read(join(this.runsDir, id, 'pid')));
    if (!Number.isInteger(pid) || pid < 1) return false;
    try { return readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from(join(this.runsDir, id))); } catch { return false; }
  }
  recoverLaunch(id, { model } = {}) {
    if (!ID.test(id ?? '')) return { state: 'pending' };
    // A missing pid registration is uncertainty. Never launch a duplicate.
    if (!this.alive(id) && !existsSync(join(this.runsDir, id, 'exit.json'))) return { state: 'pending' };
    return { state: 'ready', body: { id, harness: 'agy', model } };
  }
  stopped(body) { return !this.alive(body.id); }
  status(body) { return this.alive(body.id) ? 'working' : existsSync(join(this.runsDir, body.id, 'exit.json')) ? 'idle' : 'unknown'; }
  turn(body) {
    if (this.alive(body.id)) return null;
    const end = json(join(this.runsDir, body.id, 'exit.json'));
    if (!end) return null;
    const events = this.events(body.id), result = events.findLast(e => e.event === 'result')?.result;
    const auth = /authentication required|authentication failed|sign in/i.test(read(join(this.runsDir, body.id, 'stderr.txt')));
    return { failed: end.code !== 0 || result?.status !== 'SUCCESS', worked: events.some(e => e.event === 'step_update' && e.step_update?.step_type === 'tool'),
      ...(auth ? { error: 'AUTH_REQUIRED: sign in on this box through the owner card' } : end.code !== 0 || result?.status !== 'SUCCESS' ? { error: 'agy did not complete its turn' } : {}) };
  }
  final(body) { return this.events(body.id).findLast(e => e.event === 'result' && e.result?.status === 'SUCCESS')?.result.response ?? null; }
  activity(body) { return agyCards(this.events(body.id), `${body.id}:`); }
  tickerAction(body) { return agyActionNow(this.events(body.id)); }
  usage() { return null; } // Token counts are not subscription quota windows.
  waiting() { return null; }
  feed() { return { fed: false, reason: 'agy file mode has one turn; wait for its result' }; }
  // Do not promise portable resume from an unverified native-file layout. The
  // runtime retains its own conversation context for a new body instead.
  slotOf() { return null; }
  resume() { throw refused('agy native session portability has not been verified on a signed-in box'); }
  sessionFiles(_slot, body) { return { keep: [], drop: body?.id && ID.test(body.id) ? [join(this.runsDir, body.id)] : [] }; }
  end(body) { if (this.alive(body.id)) { try { process.kill(-Number(read(join(this.runsDir, body.id, 'pid'))), 'SIGTERM'); } catch {} } }
  ids() { try { return readdirSync(this.runsDir).filter(id => ID.test(id)); } catch { return []; } }
}
