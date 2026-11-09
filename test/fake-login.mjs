#!/usr/bin/env node
// A stand-in harness CLI, for its login and status commands only (logins.mjs): `claude auth status --json`,
// `claude auth login --claudeai`, `codex login status`, `codex login --device-auth`. It's logged in when its home
// (CLAUDE_SECURESTORAGE_CONFIG_DIR, or CODEX_HOME) holds its credential file, which its login writes, the way a
// real CLI does. Like Codex, it runs a `notify` command from its home's config.toml, so a test can tell whether
// a config planted anywhere else ever runs. FAKE_LOGIN_AS says which CLI it is.
//
// Who the account is, as the real CLIs give it (checked 2026-11-06, Claude Code 2.1.309/2.1.319, codex-cli 0.162.1):
// Claude's `auth status` names the org and email only once its config ($CLAUDE_CONFIG_DIR/.claude.json) holds the
// profile, which a fresh config doesn't until a command that starts up properly (`claude mcp list`) fetches it.
// Codex names it only through its app server's `account/read` (JSON-RPC over stdio), never `login status`.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const as = process.env.FAKE_LOGIN_AS;
const home = as === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
const marker = join(home, as === 'codex' ? 'auth.json' : '.credentials.json');
try {
  const notify = /^notify\s*=\s*"(.*)"$/m.exec(readFileSync(join(home, 'config.toml'), 'utf-8'))?.[1];
  if (notify) execSync(notify);
} catch { /* no config */ }
const args = process.argv.slice(2).join(' ');
// Who the login is (FAKE_LOGIN_WHO, default the owner): a different one is a different account.
const who = process.env.FAKE_LOGIN_WHO || '';
const email = `${who || 'owner'}@example.com`, org = who ? `org-${who}` : 'org-1', acctId = who ? `acct-${who}` : 'acct-1';
const profile = join(process.env.CLAUDE_CONFIG_DIR || home, '.claude.json');
const profiled = () => { try { return !!JSON.parse(readFileSync(profile, 'utf-8')).oauthAccount; } catch { return false; } };
if (as === 'claude' && args === 'auth status --json') {
  process.stdout.write(JSON.stringify(existsSync(marker)
    ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: profiled() ? email : null, orgId: profiled() ? org : null, orgName: null, subscriptionType: 'max' }
    : { loggedIn: false }));
  process.exit(0);
}
if (as === 'claude' && args === 'mcp list') {
  if (existsSync(marker) && process.env.FAKE_LOGIN_OFFLINE !== '1') writeFileSync(profile, JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: org } }));
  process.stdout.write('No MCP servers configured.\n');
  process.exit(0);
}
if (as === 'codex' && args === 'app-server') {
  let buf = '';
  process.stdin.on('data', (b) => {
    buf += b.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method === 'initialize') process.stdout.write(`${JSON.stringify({ id: m.id, result: { userAgent: 'fake' } })}\n`);
      if (m.method === 'account/read') {
        const result = !existsSync(marker) ? { account: null, requiresOpenaiAuth: true }
          : process.env.FAKE_LOGIN_OFFLINE === '1' ? null
          : { account: { type: 'chatgpt', email, planType: 'pro' }, requiresOpenaiAuth: true, workspaceRouting: { chatgptAccountId: acctId } };
        process.stdout.write(`${JSON.stringify(result ? { id: m.id, result } : { id: m.id, error: { code: -32603, message: 'workspace routing discovery timed out' } })}\n`);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else if (as === 'claude' && args === 'auth login --claudeai') {
  process.stdout.write('Opening browser to sign in…\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=s1\nPaste code here if prompted > ');
  let got = '';
  process.stdin.on('data', (b) => {
    got += b.toString();
    if (!/[\r\n]/.test(got)) return;
    if (got.trim() === 'good-code#s1') { writeFileSync(marker, '{"fake":true}'); process.stdout.write('\nLogin successful.\n'); process.exit(0); }
    process.stdout.write('\nInvalid code\n');
    process.exit(1);
  });
} else if (as === 'codex' && args === 'login status') {
  if (existsSync(marker)) { process.stdout.write('Logged in using ChatGPT\n'); process.exit(0); }
  process.stdout.write('Not logged in\n');
  process.exit(1);
} else if (as === 'codex' && args === 'login --device-auth') {
  process.stdout.write('1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   ABCD-EFGH1\n');
  const confirm = () => {
    if (process.env.FAKE_LOGIN_DEVICE_GATE && !existsSync(process.env.FAKE_LOGIN_DEVICE_GATE)) return setTimeout(confirm, 25);
    writeFileSync(marker, '{"fake":true}'); process.exit(0);
  };
  setTimeout(confirm, Number(process.env.FAKE_LOGIN_DEVICE_MS || 300));
} else if (!['claude', 'codex'].includes(as)) process.exit(2);
