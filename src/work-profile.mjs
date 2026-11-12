// Job declarations are selected by the runtime, never from a prompt or the house's environment.
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const PROFILE_CAP = 'job-profile-v1';
export const CONTEXT_PROFILE_CAP = 'context-profile-v1';
// A bounded, data-only native floor; missing/corrupt provenance never means unrestricted.
export function cleanProfileFloor(value) {
  if (!value || typeof value !== 'object' || !['deny', 'disabled'].every(k => Array.isArray(value[k]) && value[k].length <= 4096 && value[k].every(x => typeof x === 'string' && x.length > 0 && x.length <= 4096)) || (value.unknown !== undefined && typeof value.unknown !== 'boolean')) return null;
  return { deny: [...new Set(value.deny)], disabled: [...new Set(value.disabled)], ...(value.unknown ? { unknown: true } : {}) };
}
export const unknownProfileFloor = () => ({ deny: [], disabled: [], unknown: true });
export function mergeProfileFloors(...values) {
  const floors = values.map(v => cleanProfileFloor(v) ?? unknownProfileFloor());
  return { deny: [...new Set(floors.flatMap(f => f.deny))], disabled: [...new Set(floors.flatMap(f => f.disabled))], ...(floors.some(f => f.unknown) ? { unknown: true } : {}) };
}

export const profileHostProblem = (profile, report) => profile !== undefined && !report?.caps?.includes(PROFILE_CAP)
  ? 'its body host cannot enforce job profiles; update its house runtime' : null;
const FIELDS = ['mcp', 'tools', 'skills', 'secrets'];
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
export const CLAUDE_TOOLS = new Set(['Task', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit', 'EnterWorktree', 'ExitWorktree', 'ListAgents', 'ListMcpResourcesTool', 'Monitor', 'NotebookEdit', 'PushNotification', 'Read', 'ReadMcpResourceDirTool', 'ReadMcpResourceTool', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'TaskStop', 'ToolSearch', 'WebSearch', 'Workflow', 'Write']);
const forbiddenSecret = k => BASE_ENV.includes(k) || (/^(LOOM_|CLAUDE_|CODEX_|ANTHROPIC_|OPENAI_|NODE_|BASH_|LD_|DYLD_|ENV$|API_TIMEOUT_MS$|SSL_CERT_FILE$|SSL_CERT_DIR$)/.test(k) && !['LOOM_URL', 'LOOM_TOKEN', 'LOOM_TOKEN_FILE'].includes(k)) || /^(https?_proxy|all_proxy|no_proxy)$/i.test(k);
export const minimalProfile = () => ({ v: 1, mcp: [], tools: [], skills: [], secrets: [] });
export function validateProfile(p) {
  if (!p || p.v !== 1 || Object.keys(p).some(k => !['v', ...FIELDS].includes(k))) throw Error('invalid job profile version or field');
  for (const k of FIELDS) if (!Array.isArray(p[k]) || p[k].length > 128 || p[k].some(n => typeof n !== 'string' || !NAME.test(n)) || new Set(p[k]).size !== p[k].length) throw Error(`invalid job profile ${k}`);
  if (p.tools.some(t => !CLAUDE_TOOLS.has(t))) throw Error('job profile names an unsupported built-in tool');
  for (const k of p.secrets) if (!k.startsWith('mcp.') && forbiddenSecret(k)) throw Error(`job profile secret cannot configure the harness: ${k}`);
  for (const n of p.mcp) if (!p.secrets.includes(`mcp.${n}`)) throw Error(`job profile must explicitly declare configured MCP credentials: mcp.${n}`);
  return Object.fromEntries(['v', ...FIELDS].map(k => [k, Array.isArray(p[k]) ? [...p[k]].sort() : p[k]]));
}
export const jobProfileKey = ({ agent, venue, kind, place }) => JSON.stringify([agent, venue, kind, place ?? null]);
export const isWork = env => env?.LOOM_BODY_PROFILE !== undefined;
export function selectedProfile(env) {
  if (!isWork(env)) return null;
  try { return validateProfile(JSON.parse(env.LOOM_BODY_PROFILE)); }
  catch {
    env.LOOM_BODY_PROFILE = JSON.stringify(minimalProfile());
    env.LOOM_BODY_PROFILE_PROBLEM = 'JOB PROFILE PROBLEM: invalid transported job profile; using minimal profile (no tools, MCP, skills or secrets).';
    return minimalProfile();
  }
}
export function workServers(servers, profile) {
  const p = validateProfile(profile);
  const missing = p.mcp.filter(n => !Object.hasOwn(servers, n) || !servers[n] || typeof servers[n] !== 'object' || Array.isArray(servers[n]) || servers[n].enabled === false);
  if (missing.length) throw Error(`job profile MCP unavailable: ${missing.join(', ')}`);
  return Object.fromEntries(p.mcp.map(n => [n, servers[n]]));
}
export function selectProfile(settings, job) {
  const key = jobProfileKey(job);
  let declared = !!settings.LOOM_RUNTIME_JOB_PROFILES;
  try {
    const file = settings.LOOM_RUNTIME_JOB_PROFILES;
    if (!file) throw Error('no job profile store configured');
    const store = JSON.parse(readFileSync(file, 'utf8'));
    if (store.v !== 1 || !store.jobs || typeof store.jobs !== 'object' || Array.isArray(store.jobs)) throw Error('invalid job profile store');
    if (!Object.hasOwn(store.jobs, key)) { declared = false; throw Error('job has no declared profile'); }
    return { key, declared: true, profile: validateProfile(store.jobs[key]) };
  } catch (e) { return { key, declared, profile: minimalProfile(), problem: `JOB PROFILE PROBLEM: ${e.message}; using minimal profile (no tools, MCP, skills or secrets).` }; }
}
// Small explicit infrastructure environment. No provider key, launcher setting or inherited secret survives by default.
const BASE_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'LOOM_BODY_PROFILE_PROBLEM', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'HOME', 'PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'LOOM_BODY_KEY', 'LOOM_BODY_CONVERSATION', 'LOOM_BODY_MODEL'];
export function restrictedEnv(env, profile, { deferSecrets = false } = {}) {
  const p = validateProfile(profile);
  const out = Object.fromEntries(BASE_ENV.filter(k => env[k] !== undefined).map(k => [k, env[k]]));
  for (const k of p.secrets) {
    if (k.startsWith('mcp.')) continue;
    if (forbiddenSecret(k)) throw Error(`job profile secret cannot configure the harness: ${k}`);
    if (env[k] === undefined) { if (deferSecrets) continue; throw Error(`job profile secret unavailable: ${k}`); }
    out[k] = env[k];
  }
  // Provider-side advisor tools are otherwise injected even with --tools ''.
  out.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1';
  out.LOOM_BODY_PROFILE = JSON.stringify(p);
  return out;
}
export function profileEnv(env, kind, settings = process.env, job = {}, options = {}) {
  const source = { ...(!options.deferSecrets ? Object.fromEntries(['CLAUDE_CONFIG_DIR', 'CODEX_HOME'].filter(k => settings[k] !== undefined).map(k => [k, settings[k]])) : {}), ...(env ?? process.env) };
  const { LOOM_BODY_PROFILE: _old, LOOM_BODY_PROFILE_PROBLEM: _problem, ...clean } = source;
  const frozen = { LOOM_BODY_PROFILE: options.frozenProfile };
  const selected = options.frozenProfile !== undefined ? { profile: selectedProfile(frozen), declared: true, problem: frozen.LOOM_BODY_PROFILE_PROBLEM } : selectProfile(settings, { ...job, kind });
  if (options.harness === 'codex' && !selected.declared && !options.forceProfile) {
    const { LOOM_BODY_PROFILE: _marker, LOOM_BODY_PROFILE_PROBLEM: _notice, ...legacy } = env ?? process.env;
    return legacy;
  }
  return { ...restrictedEnv(clean, options.minimal ? minimalProfile() : selected.profile, { ...options, deferSecrets: options.deferSecrets || options.nativeSecrets }), ...(selected.problem ? { LOOM_BODY_PROFILE_PROBLEM: selected.problem } : {}) };
}
export function profileNotice(env) { return [env?.LOOM_BODY_PROFILE_PROBLEM, ...(isWork(env) ? ['If a capability is missing, request its permanent owner approval with loom runtime profile request --field mcp|tools|skills|secrets --name NAME. Do not work around the profile.'] : [])].filter(Boolean).join('\n'); }
const json = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw Error('cannot read job profile MCP configuration'); } };
export function privateJson(dir, value) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(value), name = createHash('sha256').update(body).digest('hex');
  const file = join(dir, `${name}.json`), tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' }); renameSync(tmp, file);
  return file;
}
export function claudeWorkArgs(env, cwd, jobsDir, floor = { deny: [], disabled: [] }) {
  const p = selectedProfile(env);
  if (!p) return [];
  const home = env.HOME;
  if (!home) throw Error('job profile needs HOME');
  const conf = json(join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'));
  const project = cwd ? json(join(cwd, '.mcp.json')) : {};
  const scoped = conf.projects?.[resolve(cwd || home)] ?? {};
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const layers = [json(join(configDir, 'settings.json')), ...(cwd ? [json(join(cwd, '.claude/settings.json')), json(join(cwd, '.claude/settings.local.json'))] : [])];
  const disabled = new Set([...floor.disabled, ...[conf, scoped, project, ...layers].flatMap(c => [...(c.disabledMcpServers ?? []), ...(c.disabledMcpjsonServers ?? []), ...Object.entries(c.mcpServers ?? {}).filter(([,v]) => v?.enabled === false).map(([n]) => n)])]);
  const all = Object.fromEntries(Object.entries({ ...conf.mcpServers, ...scoped.mcpServers, ...project.mcpServers }).filter(([name]) => !disabled.has(name)));
  const servers = workServers(all, p);
  // Preload only the declared skill text through the supported prompt control.
  // Safe mode disables discovery; Skill stays denied so the inherited catalog
  // cannot reappear. References remain subject to the declared file tools.
  const skills = p.skills.map(name => {
    let body, source;
    for (const base of [cwd && join(cwd, '.claude/skills'), join(configDir, 'skills')].filter(Boolean)) {
      try { source = join(base, name, 'SKILL.md'); body = readFileSync(source, 'utf8'); break; }
      catch (e) { if (e.code !== 'ENOENT') throw Error(`job profile skill unreadable: ${name}`); }
    }
    if (body === undefined) throw Error(`job profile skill unavailable: ${name}`);
    return `### Declared skill: ${name}\nSource (resolve relative references here): ${source}\n${body}`;
  });
  const dir = join(jobsDir, '..', 'work-profiles');
  const mcp = privateJson(dir, { mcpServers: servers });
  const priorDenies = [...floor.deny, ...[conf, scoped, ...layers].flatMap(c => c.permissions?.deny ?? [])];
  if (priorDenies.some(rule => typeof rule !== 'string')) throw Error('invalid inherited permission deny rules');
  floor.deny = [...new Set(priorDenies)];
  floor.disabled = [...disabled];
  const settings = privateJson(dir, { permissions: { allow: p.mcp.map(n => `mcp__${n}__*`), deny: [...new Set([...priorDenies, 'Skill'])] }, enabledPlugins: {} });
  return [...(skills.length ? ['--append-system-prompt', skills.join('\n\n')] : []), '--system-prompt-snapshot', 'off', '--strict-mcp-config', '--mcp-config', mcp, ...(p.mcp.length ? ['--restricted'] : ['--safe-mode']), '--disable-slash-commands', '--tools', p.tools.join(','), '--settings', settings];
}
