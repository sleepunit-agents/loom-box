#!/usr/bin/env node
// A stand-in harness CLI, for its login and status commands only (logins.mjs): `claude auth status --json`,
// `claude auth login --claudeai`, `codex login status`, `codex login --device-auth`. It's logged in when its home
// (CLAUDE_SECURESTORAGE_CONFIG_DIR, or CODEX_HOME) holds a `logged-in` file, which its login writes, the way a
// real CLI writes its own credentials there. FAKE_LOGIN_AS says which CLI it is.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const as = process.env.FAKE_LOGIN_AS;
const home = as === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
const marker = join(home, 'logged-in');
const args = process.argv.slice(2).join(' ');
if (as === 'claude' && args === 'auth status --json') {
  process.stdout.write(JSON.stringify(existsSync(marker)
    ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'owner@example.com', orgId: 'org-1', orgName: 'Owner', subscriptionType: 'max' }
    : { loggedIn: false }));
  process.exit(0);
}
if (as === 'claude' && args === 'auth login --claudeai') {
  process.stdout.write('Opening browser to sign in…\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=s1\nPaste code here if prompted > ');
  let got = '';
  process.stdin.on('data', (b) => {
    got += b.toString();
    if (!/[\r\n]/.test(got)) return;
    if (got.trim() === 'good-code#s1') { writeFileSync(marker, 'x'); process.stdout.write('\nLogin successful.\n'); process.exit(0); }
    process.stdout.write('\nInvalid code\n');
    process.exit(1);
  });
} else if (as === 'codex' && args === 'login status') {
  if (existsSync(marker)) { process.stdout.write('Logged in using ChatGPT\n'); process.exit(0); }
  process.stdout.write('Not logged in\n');
  process.exit(1);
} else if (as === 'codex' && args === 'login --device-auth') {
  process.stdout.write('1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   ABCD-EFGH1\n');
  setTimeout(() => { writeFileSync(marker, 'x'); process.exit(0); }, Number(process.env.FAKE_LOGIN_DEVICE_MS || 300));
} else if (!['claude', 'codex'].includes(as)) process.exit(2);
