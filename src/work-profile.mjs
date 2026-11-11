// Job declarations are selected by the runtime, never from a prompt or the house's environment.
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const PROFILE_CAP = 'job-profile-v1';
export const profileHostProblem = (profile, report) => profile !== undefined && !report?.caps?.includes(PROFILE_CAP)
  ? 'its body host cannot enforce job profiles; update its house runtime' : null;
const FIELDS = ['mcp', 'tools', 'skills', 'secrets'];
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
export const minimalProfile = () => ({ v: 1, mcp: [], tools: [], skills: [], secrets: [] });
export function validateProfile(p) {
  if (!p || p.v !== 1 || Object.keys(p).some(k => !['v', ...FIELDS].includes(k))) throw Error('invalid job profile version or field');
  for (const k of FIELDS) if (!Array.isArray(p[k]) || p[k].length > 128 || p[k].some(n => typeof n !== 'string' || !NAME.test(n)) || new Set(p[k]).size !== p[k].length) throw Error(`invalid job profile ${k}`);
  if (p.tools.includes('default')) throw Error('a job profile must name each tool');
  return Object.fromEntries(['v', ...FIELDS].map(k => [k, Array.isArray(p[k]) ? [...p[k]].sort() : p[k]]));
}
export const jobProfileKey = ({ agent, venue, kind, place }) => JSON.stringify([agent, venue, kind, place ?? null]);
export const isWork = env => env?.LOOM_BODY_PROFILE !== undefined;
export function selectedProfile(env) {
  if (!isWork(env)) return null;
  try { return validateProfile(JSON.parse(env.LOOM_BODY_PROFILE)); }
  catch { throw Error('invalid transported job profile; refusing unrestricted launch'); }
}
export function workServers(servers, profile) {
  const p = validateProfile(profile);
  const missing = p.mcp.filter(n => !servers[n] || servers[n].enabled === false);
  if (missing.length) throw Error(`job profile MCP unavailable: ${missing.join(', ')}`);
  for (const n of p.mcp) if (!p.secrets.includes(`mcp.${n}`)) throw Error(`job profile must explicitly declare configured MCP credentials: mcp.${n}`);
  return Object.fromEntries(p.mcp.map(n => [n, servers[n]]));
}
export function selectProfile(settings, job) {
  const key = jobProfileKey(job);
  try {
    const file = settings.LOOM_RUNTIME_JOB_PROFILES;
    if (!file) throw Error('no job profile store configured');
    const store = JSON.parse(readFileSync(file, 'utf8'));
    if (store.v !== 1 || !store.jobs || !Object.hasOwn(store.jobs, key)) throw Error('job has no declared profile');
    return { key, profile: validateProfile(store.jobs[key]) };
  } catch (e) { return { key, profile: minimalProfile(), problem: `JOB PROFILE PROBLEM: ${e.message}; using minimal profile (no tools, MCP, skills or secrets).` }; }
}
// Small explicit infrastructure environment. No provider key, launcher setting or inherited secret survives by default.
const BASE_ENV = ['CLAUDE_SECURESTORAGE_CONFIG_DIR', 'HOME', 'PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'LOOM_BODY_KEY', 'LOOM_BODY_CONVERSATION', 'LOOM_BODY_MODEL'];
export function restrictedEnv(env, profile, { deferSecrets = false } = {}) {
  const p = validateProfile(profile);
  const out = Object.fromEntries(BASE_ENV.filter(k => env[k] !== undefined).map(k => [k, env[k]]));
  for (const k of p.secrets) {
    if (k.startsWith('mcp.')) continue;
    if (BASE_ENV.includes(k) || (/^(LOOM_|CLAUDE_|CODEX_|NODE_|BASH_|ENV$)/.test(k) && !['LOOM_URL', 'LOOM_TOKEN', 'LOOM_TOKEN_FILE'].includes(k))) throw Error(`job profile secret cannot configure the harness: ${k}`);
    if (env[k] === undefined) { if (deferSecrets) continue; throw Error(`job profile secret unavailable: ${k}`); }
    out[k] = env[k];
  }
  out.LOOM_BODY_PROFILE = JSON.stringify(p);
  return out;
}
export function profileEnv(env, kind, settings = process.env, job = {}, options = {}) {
  const source = env ?? process.env;
  const { LOOM_BODY_PROFILE: _old, LOOM_BODY_PROFILE_PROBLEM: _problem, ...clean } = source;
  const selected = selectProfile(settings, { ...job, kind });
  return { ...restrictedEnv(clean, selected.profile, options), ...(selected.problem ? { LOOM_BODY_PROFILE_PROBLEM: selected.problem } : {}) };
}
export function profileNotice(env) { return env?.LOOM_BODY_PROFILE_PROBLEM ?? ''; }
const json = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw Error('cannot read job profile MCP configuration'); } };
export function privateJson(dir, value) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(value), name = createHash('sha256').update(body).digest('hex');
  const file = join(dir, `${name}.json`), tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' }); renameSync(tmp, file);
  return file;
}
export function claudeWorkArgs(env, cwd, jobsDir) {
  const p = selectedProfile(env);
  if (!p) return [];
  const home = env.HOME;
  if (!home) throw Error('job profile needs HOME');
  const conf = json(join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'));
  const project = cwd ? json(join(cwd, '.mcp.json')) : {};
  const scoped = conf.projects?.[resolve(cwd || home)] ?? {};
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const layers = [json(join(configDir, 'settings.json')), ...(cwd ? [json(join(cwd, '.claude/settings.json')), json(join(cwd, '.claude/settings.local.json'))] : [])];
  const disabled = new Set([conf, scoped, ...layers].flatMap(c => c.disabledMcpServers ?? []));
  const all = Object.fromEntries(Object.entries({ ...conf.mcpServers, ...scoped.mcpServers, ...project.mcpServers }).filter(([name]) => !disabled.has(name)));
  const servers = workServers(all, p);
  const supported = new Set(['Task', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit', 'EnterWorktree', 'ExitWorktree', 'ListAgents', 'ListMcpResourcesTool', 'Monitor', 'NotebookEdit', 'PushNotification', 'Read', 'ReadMcpResourceDirTool', 'ReadMcpResourceTool', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'TaskStop', 'ToolSearch', 'WebSearch', 'Workflow', 'Write']);
  if (p.tools.some(t => !supported.has(t))) throw Error('job profile names an unsupported Claude built-in tool');
  if (p.skills.length) throw Error('this Claude profile adapter cannot yet isolate named skills; refusing launch');
  const dir = join(jobsDir, '..', 'work-profiles');
  const mcp = privateJson(dir, { mcpServers: servers });
  const priorDenies = [conf, scoped, ...layers].flatMap(c => c.permissions?.deny ?? []);
  if (priorDenies.some(rule => typeof rule !== 'string')) throw Error('invalid inherited permission deny rules');
  const settings = privateJson(dir, { permissions: { deny: [...new Set([...priorDenies, 'Skill'])] }, enabledPlugins: {} });
  return ['--strict-mcp-config', '--mcp-config', mcp, '--safe-mode', '--disable-slash-commands', '--tools', p.tools.join(','), '--settings', settings];
}
