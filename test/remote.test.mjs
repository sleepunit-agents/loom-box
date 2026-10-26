// Box sessions (control.mjs "box sessions", remote.mjs): Claude's
// remote-control on a box itself, for an agent, brought up and taken down by
// the owner:
//  - only the owner brings one up or down; an agent sees only its own;
//  - one per agent, in a folder on the box (an absolute path), named for what it is;
//  - the box runs it as a user unit, never with an env token, with
//    permissions bypassed, on the owner's login PATH, and reports its link; down stops the unit;
//  - a session that ends is started again, at most once a minute; a missing folder fails, saying so.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from '../src/control.mjs';
import { boxSessions, loginPath, unitOf } from '../src/remote.mjs';

let env, fx, fake, folder;
const owner = { kind: 'owner' };
const art = { kind: 'agent', agent: 'art' };
const box = (subject) => ({ kind: 'piece', subject });
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const client = { call: async (path, body) => ok(call(box('one'), path, body)) };
const runs = () => (existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : []);

beforeEach(() => {
  env = { HOME: mkdtempSync(join(tmpdir(), 'loom-box-remote-')), LOOM_BOX_LOCAL_NAME: 'one', PATH: process.env.PATH };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  env.LOOM_BOX_DATA = join(env.HOME, 'data');
  fx = { now: () => new Date('2026-10-25T03:00:00Z'), mint: () => 'loom_x', revoke: () => {}, secret: (n) => `v-${n}` };
  ok(call(owner, 'set-agent', { agent: 'art', repo: 'https://github.com/x/art.git' }));
  folder = join(env.HOME, 'Art');
  mkdirSync(folder);
  // A stand-in systemctl/systemd-run: records each call; a unit is "active"
  // while its file exists, and systemd-run writes the output remote-control would.
  fake = join(env.HOME, 'fake');
  mkdirSync(join(fake, 'units'), { recursive: true });
  const script = (body) => `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), f = ${JSON.stringify(fake)};
fs.appendFileSync(path.join(f, 'calls'), JSON.stringify({ cmd: path.basename(process.argv[1]), args }) + '\\n');
${body}`;
  writeFileSync(join(fake, 'systemctl'), script(`
const unit = args[args.length - 1], u = path.join(f, 'units', unit);
if (args[1] === 'is-active') { process.stdout.write(fs.existsSync(u) ? 'active\\n' : 'inactive\\n'); process.exit(fs.existsSync(u) ? 0 : 3); }
if (args[1] === 'stop') fs.rmSync(u, { force: true });`));
  writeFileSync(join(fake, 'systemd-run'), script(`
const unit = args.find((a) => a.startsWith('--unit=')).slice(7);
const out = args.find((a) => a.startsWith('--property=StandardOutput=truncate:')).split('truncate:')[1];
fs.writeFileSync(path.join(f, 'units', unit), '');
fs.writeFileSync(out, '\\x1b[7A\\x1b[J·✔︎· Connected · Art\\nContinue coding in the Claude mobile app or https://claude.ai/code?environment=env_01ABCdef\\n');`));
  chmodSync(join(fake, 'systemctl'), 0o755);
  chmodSync(join(fake, 'systemd-run'), 0o755);
  env.LOOM_BOX_SYSTEMCTL = join(fake, 'systemctl');
  env.LOOM_BOX_SYSTEMD_RUN = join(fake, 'systemd-run');
  env.LOOM_BOX_CLAUDE = '/opt/claude';
});

test('only the owner brings a box session up, in an absolute folder, named for what it is', () => {
  assert.equal(call(art, 'remote-up', { agent: 'art', dir: folder }).status, 403);
  assert.equal(call(owner, 'remote-up', { agent: 'art' }).status, 400, 'a folder is needed');
  assert.equal(call(owner, 'remote-up', { agent: 'art', dir: 'Art' }).status, 400);
  assert.equal(call(owner, 'remote-up', { agent: 'art', dir: '/home/../etc' }).status, 400);
  assert.equal(call(owner, 'remote-up', { agent: 'nobody', dir: folder }).status, 409);
  const r = ok(call(owner, 'remote-up', { agent: 'art', dir: folder }));
  assert.deepEqual([r.box, r.name, r.want, r.state], ['one', 'art on one (box session)', 'up', 'starting']);
  // Again is the same one; an agent sees its own in its list.
  assert.equal(ok(call(owner, 'remote-up', { agent: 'art' })).dir, folder);
  assert.equal(ok(call(art, 'list')).remotes[0].name, 'art on one (box session)');
  assert.equal(call(art, 'remote-down', { agent: 'art' }).status, 403);
  assert.equal(ok(call(owner, 'remote-down', { agent: 'art' })).want, 'down');
  assert.equal(call(owner, 'remote-down', { agent: 'art' }).status, 404);
  // Brought up again, it remembers its folder on that box.
  assert.equal(ok(call(owner, 'remote-up', { agent: 'art' })).dir, folder);
});

test('the box runs it as a user unit without an env token, bypassing permissions, and reports its link; down stops it', async () => {
  ok(call(owner, 'remote-up', { agent: 'art', dir: folder }));
  const sync = boxSessions(env, client, { dataDir: env.LOOM_BOX_DATA, log: () => {} });
  await sync(ok(call(box('one'), 'poll')).remotes);
  const run = runs().find((c) => c.cmd === 'systemd-run');
  assert.ok(run.args.includes(`--unit=${unitOf('art')}`));
  assert.ok(run.args.includes(`--property=WorkingDirectory=${folder}`));
  const cmd = run.args.slice(run.args.indexOf('--') + 1);
  assert.deepEqual(cmd, ['env', '-u', 'CLAUDE_CODE_OAUTH_TOKEN', '-u', 'ANTHROPIC_API_KEY', '/opt/claude', 'remote-control',
    '--name', 'art on one (box session)', '--permission-mode', 'bypassPermissions']);
  await sync(ok(call(box('one'), 'poll')).remotes);
  const up = ok(call(owner, 'list')).remotes[0];
  assert.deepEqual([up.state, up.url], ['running', 'https://claude.ai/code?environment=env_01ABCdef']);
  // A box can't report a link that isn't remote-control's, or for a session that isn't its.
  assert.equal(call(box('one'), 'remote-report', { agent: 'art', state: 'running', url: 'https://evil.example/x' }).status, 400);
  assert.equal(call(box('one'), 'remote-report', { agent: 'mark', state: 'running' }).status, 404);
  ok(call(owner, 'remote-down', { agent: 'art' }));
  await sync(ok(call(box('one'), 'poll')).remotes);
  assert.ok(runs().some((c) => c.cmd === 'systemctl' && c.args[1] === 'stop' && c.args[2] === unitOf('art')));
  const down = ok(call(owner, 'list')).remotes[0];
  assert.deepEqual([down.state, down.url], ['stopped', null]);
});

test("the session gets the owner's login PATH, as a terminal would, with ~/.local/bin on it", async () => {
  // A user unit starts on systemd's bare PATH; the work calls wake, taskstore and loom by name.
  const shell = join(fake, 'shell');
  writeFileSync(shell, '#!/bin/sh\necho "a greeting the profile prints"\nprintf "\\nLOOM_BOX_PATH=%s" "/opt/tools/bin:/usr/bin"\n');
  chmodSync(shell, 0o755);
  ok(call(owner, 'remote-up', { agent: 'art', dir: folder }));
  await boxSessions({ ...env, SHELL: shell }, client, { dataDir: env.LOOM_BOX_DATA, log: () => {} })(ok(call(box('one'), 'poll')).remotes);
  const run = runs().filter((c) => c.cmd === 'systemd-run').pop();
  assert.ok(run.args.includes(`--setenv=PATH=${join(env.HOME, '.local', 'bin')}:/opt/tools/bin:/usr/bin`), run.args.join(' '));
  // A shell that fails: the box's own PATH, still with ~/.local/bin; one that has it already is left as it is.
  const local = join(env.HOME, '.local', 'bin');
  assert.equal(loginPath({ HOME: env.HOME, SHELL: join(fake, 'no-such-shell'), PATH: '/usr/bin' }), `${local}:/usr/bin`);
  assert.equal(loginPath({ HOME: env.HOME, SHELL: join(fake, 'no-such-shell'), PATH: `/usr/bin:${local}` }), `/usr/bin:${local}`);
});

test('a session that ends is started again, at most once a minute, saying why; a missing folder fails', async () => {
  ok(call(owner, 'remote-up', { agent: 'art', dir: folder }));
  const sync = boxSessions(env, client, { dataDir: env.LOOM_BOX_DATA, log: () => {} });
  await sync(ok(call(box('one'), 'poll')).remotes);
  // It ends (the unit goes); the next tick within the minute leaves it.
  writeFileSync(join(env.LOOM_BOX_DATA, 'remotes', 'art.log'), 'Error: Unable to determine your organization\n');
  const { rmSync } = await import('node:fs');
  rmSync(join(fake, 'units', unitOf('art')));
  await sync(ok(call(box('one'), 'poll')).remotes);
  assert.equal(runs().filter((c) => c.cmd === 'systemd-run').length, 1);
  // A fresh box (nothing tried yet, as after its minute is up) starts it again.
  const later = boxSessions(env, client, { dataDir: env.LOOM_BOX_DATA, log: () => {} });
  await later(ok(call(box('one'), 'poll')).remotes);
  assert.equal(runs().filter((c) => c.cmd === 'systemd-run').length, 2);

  ok(call(owner, 'remote-down', { agent: 'art' }));
  await later(ok(call(box('one'), 'poll')).remotes);
  ok(call(owner, 'remote-up', { agent: 'art', dir: join(env.HOME, 'gone') }));
  await boxSessions(env, client, { dataDir: env.LOOM_BOX_DATA, log: () => {} })(ok(call(box('one'), 'poll')).remotes);
  const r = ok(call(owner, 'list')).remotes[0];
  assert.equal(r.state, 'failed');
  assert.match(r.error, /no folder/);
});
