// Context economy only: existing deny lists and principal/seat checks still apply.
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const SERVERS = new Set(['loom', 'github', 'gh-art', 'gh_art', 'taskstore']);
export const workServers = servers => Object.fromEntries(Object.entries(servers).filter(([name]) => SERVERS.has(name)));
export const isWork = env => env?.LOOM_BODY_PROFILE === 'work';
export function profileEnv(env, kind, settings = process.env) {
  if (settings.LOOM_RUNTIME_WORK_PROFILE !== 'off' && ['scheduled', 'agent'].includes(kind)) return { ...(env ?? process.env), LOOM_BODY_PROFILE: 'work' };
  if (!(env ?? process.env).LOOM_BODY_PROFILE) return env;
  const { LOOM_BODY_PROFILE: _marker, ...clean } = env ?? process.env;
  return clean;
}

const json = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw Error('cannot read work profile MCP configuration'); } };
export function claudeWorkArgs(env, cwd, jobsDir) {
  if (!isWork(env)) return [];
  const home = env.HOME;
  if (!home) throw Error('work profile needs HOME');
  const conf = json(join(home, '.claude.json'));
  const project = cwd ? json(join(cwd, '.mcp.json')) : {};
  const servers = workServers({ ...conf.mcpServers, ...conf.projects?.[resolve(cwd || home)]?.mcpServers, ...project.mcpServers });
  if (!servers.loom) throw Error('work profile needs the loom MCP server in ~/.claude.json or .mcp.json');
  const dir = join(jobsDir, '..', 'work-profiles');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ mcpServers: servers });
  const name = createHash('sha256').update(body).digest('hex').slice(0, 24);
  const file = join(dir, `${name}.json`), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 }); renameSync(tmp, file);
  return ['--strict-mcp-config', '--mcp-config', file];
}
