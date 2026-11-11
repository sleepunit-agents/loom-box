// Opt-in executable conformance: no model calls in ordinary CI. Run one process at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {fileURLToPath} from 'node:url';
import { minimalProfile, restrictedEnv, claudeWorkArgs } from '../src/work-profile.mjs';
test('installed Claude advertises and calls the declared MCP tool with no undeclared MCP or skills', { skip: process.env.PROFILE_EXECUTABLE_CHECK !== '1' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-executable-'));
  try {
    const marker = join(root,'mcp-called');
    writeFileSync(join(root,'.claude.json'),JSON.stringify({mcpServers:{declared:{command:process.execPath,args:[fileURLToPath(new URL('./fake-profile-mcp.mjs',import.meta.url)),marker]}}}));
    const p = { ...minimalProfile(), mcp:['declared'], tools: ['Read'], secrets:['mcp.declared'] };
    const env = restrictedEnv({...process.env,CLAUDE_CONFIG_DIR:root}, p);
    const args = claudeWorkArgs(env, root, join(root, 'jobs'));
    const r = spawnSync('claude', ['-p', '--verbose', '--output-format', 'stream-json', ...args, '--', 'Call mcp__declared__profile_probe once and reply with its returned content.'], { cwd: root, env, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr);
    const records = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const init = records.find(d => d.type === 'system' && d.subtype === 'init');
    assert.deepEqual(init.tools.sort(), ['Read','mcp__declared__profile_probe'], JSON.stringify({servers:init.mcp_servers,result:records.find(r=>r.type==='result')})); assert.deepEqual(init.skills, []);
    assert.ok(init.mcp_servers.some(s=>s.name==='declared' && s.status==='connected'));
    assert.ok(existsSync(marker), 'declared MCP tool was actually called');
    assert.ok(records.some(r=>r.type==='user' && Array.isArray(r.message?.content) && r.message.content.some(c=>c.type==='tool_result' && !c.is_error && JSON.stringify(c.content).includes('DECLARED-MCP-CONTENT-CANARY'))));
    const final = records.find(d => d.type === 'result'); assert.equal(final.is_error, false);
    const u = final.usage;
    console.log(`profile executable first-call input=${u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens}; session=${final.session_id}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
