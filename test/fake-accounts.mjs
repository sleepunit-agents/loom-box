#!/usr/bin/env node
// A stand-in accounts provider (src/accounts.mjs, "A command provider"): what a household's own accounts code
// answers. Its list and what it issues come from $FAKE_ACCOUNTS (a JSON file); every call is logged beside it.
import { appendFileSync, readFileSync } from 'node:fs';

const f = process.env.FAKE_ACCOUNTS;
const cfg = JSON.parse(readFileSync(f, 'utf-8'));
const args = process.argv.slice(2);
appendFileSync(`${f}.log`, JSON.stringify(args) + '\n');
if (args[0] === 'accounts' && args[1] === '--json') { process.stdout.write(JSON.stringify(cfg.list)); process.exit(0); }
if (args[0] === 'issue') {
  const [, agent, provider] = args;
  const kind = args[3] === '--kind' ? args[4] : '';
  const got = cfg.issue?.[`${agent}/${provider}${kind ? `/${kind}` : ''}`];
  if (!got) { process.stderr.write(`subscriptions: can't issue ${provider} for ${agent}: LookupError\n`); process.exit(1); }
  process.stderr.write(`issued ${got.account}/${got.name}\n`);
  process.stdout.write(got.value);
  process.exit(0);
}
process.exit(2);
