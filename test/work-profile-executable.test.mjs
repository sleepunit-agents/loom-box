// Opt-in executable conformance: no model calls in ordinary CI. Run one process at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minimalProfile, restrictedEnv, claudeWorkArgs } from '../src/work-profile.mjs';
test('installed Claude advertises precisely the declared Read tool and no undeclared MCP or skills', { skip: process.env.PROFILE_EXECUTABLE_CHECK !== '1' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-executable-'));
  try {
    const p = { ...minimalProfile(), tools: ['Read'] };
    const env = restrictedEnv(process.env, p);
    const args = claudeWorkArgs(env, root, join(root, 'jobs'));
    const r = spawnSync('claude', ['-p', '--verbose', '--output-format', 'stream-json', ...args, '--', 'Reply OK. Do not use tools.'], { cwd: root, env, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr);
    const records = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const init = records.find(d => d.type === 'system' && d.subtype === 'init');
    assert.deepEqual(init.tools, ['Read']); assert.deepEqual(init.skills, []); assert.deepEqual(init.mcp_servers, []);
    const final = records.find(d => d.type === 'result'); assert.equal(final.is_error, false);
    const u = final.usage;
    console.log(`profile executable first-call input=${u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens}; session=${final.session_id}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
