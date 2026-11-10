// house/install-tools: the command line every house shares (Art's and Mark's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { chmodSync, statSync, rmSync } from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'house', 'install-tools');
const NODE_DIR = dirname(process.execPath);
const SYS = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function house() {
  const home = mkdtempSync(join(tmpdir(), 'house-tools-'));
  const profileD = join(home, 'profile.d');
  mkdirSync(profileD);
  // The house's own taskstore build, as the images lay it down.
  mkdirSync(join(home, '.local/share/taskstore/dist'), { recursive: true });
  writeFileSync(join(home, '.local/share/taskstore/dist/cli.js'), 'console.log("local taskstore", process.env.TASKSTORE_DB || "", process.argv.slice(2).join(" "))\n');
  const path = `${home}/.local/bin:${home}/bin:${NODE_DIR}:${SYS}`;
  return { home, profileD, path };
}

function install(h, ...args) {
  return spawnSync('sh', [TOOLS, ...args], { env: { HOME: h.home, PATH: h.path, LOOM_HOUSE_PROFILE_D: h.profileD }, encoding: 'utf8' });
}

// A command as a login shell runs it: /etc/profile's PATH, then the profile.d file.
function login(h, cmd, env = {}) {
  const script = `PATH=${SYS}; export PATH; . ${h.profileD}/loom-house.sh; ${cmd}`;
  return spawnSync('sh', ['-c', script], { env: { HOME: h.home, PATH: SYS, ...env }, encoding: 'utf8' });
}

test('the installed Python stop adapter comes from the same runtime checkout', () => {
  const h = house();
  try {
    const r = install(h); assert.equal(r.status, 0, r.stderr);
    assert.equal(readlinkSync(join(h.home, '.local/bin/loom_host_process.py')), join(ROOT, 'house/loom_host_process.py'));
    const imported = spawnSync('python3', ['-c', 'from loom_host_process import run_host; assert callable(run_host)'], { env: { HOME: h.home, PATH: h.path }, cwd: h.home, encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('it writes the shared wrappers into ~/.local/bin', () => {
  const h = house();
  const r = install(h);
  assert.equal(r.status, 0, r.stderr);
  for (const name of ['piece-call', 'loom-runtime', 'taskstore', 'loom-tasks', 'wake', 'approvals']) {
    assert.ok(existsSync(join(h.home, '.local/bin', name)), `${name} written`);
  }
  assert.ok(lstatSync(join(h.home, '.local/bin/piece-call')).isSymbolicLink());
  assert.equal(readlinkSync(join(h.home, '.local/bin/piece-call')), join(ROOT, 'house/piece-call'));
  assert.match(readFileSync(join(h.home, '.local/bin/wake'), 'utf8'), /piece-call" clock "\$@"/);
  assert.match(readFileSync(join(h.home, '.local/bin/approvals'), 'utf8'), /piece-call" approvals "\$@"/);
});

test('a login shell gets the house PATH back, and node, loom-runtime and the pieces resolve', () => {
  const h = house();
  assert.equal(install(h).status, 0);
  const r = login(h, 'echo "$PATH"; for c in node loom-runtime taskstore wake approvals piece-call; do command -v $c; done');
  assert.equal(r.status, 0, r.stderr);
  const [path, ...found] = r.stdout.trim().split('\n');
  assert.equal(path, h.path);
  assert.deepEqual(found, [join(NODE_DIR, 'node'),
    ...['loom-runtime', 'taskstore', 'wake', 'approvals', 'piece-call'].map((n) => join(h.home, '.local/bin', n))]);
});

test('loom-runtime runs on node by its full path, even with node off PATH', () => {
  const h = house();
  assert.equal(install(h).status, 0);
  const r = spawnSync(join(h.home, '.local/bin/loom-runtime'), ['body-host'], { env: { HOME: h.home, PATH: SYS }, encoding: 'utf8' });
  assert.match(r.stdout + r.stderr, /LOOM_URL and LOOM_TOKEN_FILE/);
});

test('the profile file reads ~/.house-env (LOOM_TOKEN_FILE for a shell Codex started)', () => {
  const h = house();
  assert.equal(install(h).status, 0);
  writeFileSync(join(h.home, '.house-env'), 'export LOOM_TOKEN_FILE=/run/secrets/loom-token\n');
  assert.equal(login(h, 'echo "$LOOM_TOKEN_FILE"').stdout.trim(), '/run/secrets/loom-token');
  // and is harmless without one
  const bare = house();
  assert.equal(install(bare).status, 0);
  assert.equal(login(bare, 'echo ok').stdout.trim(), 'ok');
});

test('wake, taskstore and approvals go through piece-call; a TASKSTORE_DB call runs the local build', () => {
  const h = house();
  assert.equal(install(h).status, 0);
  // A stand-in piece-call that records its argv, where the wrappers look for it.
  writeFileSync(join(h.home, 'fake-piece-call'), '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done; echo\n', { mode: 0o755 });
  spawnSync('ln', ['-sfn', join(h.home, 'fake-piece-call'), join(h.home, '.local/bin/piece-call')]);
  const run = (cmd, env) => login(h, cmd, env).stdout.trim();
  assert.equal(run('wake in 4h --note "two words"'), '[clock][in][4h][--note][two words]');
  assert.equal(run('taskstore ready'), '[tasks][ready]');
  assert.equal(run('loom-tasks show t-1'), '[tasks][show][t-1]');
  assert.equal(run('approvals list'), '[approvals][list]');
  assert.equal(run('taskstore ready', { TASKSTORE_DB: '/tmp/x.db' }), 'local taskstore /tmp/x.db ready');
  assert.equal(run('taskstore ready', { TANK_LOCAL_PIECES: '1' }), 'local taskstore  ready');
});

test('--pieces puts the piece wrappers back over links a house laid down, and nothing else', () => {
  const h = house();
  assert.equal(install(h).status, 0);
  spawnSync('ln', ['-sfn', '/nowhere/wake', join(h.home, '.local/bin/wake')]);
  writeFileSync(join(h.profileD, 'loom-house.sh'), '# untouched\n');
  assert.equal(install(h, '--pieces').status, 0);
  writeFileSync(join(h.home, '.local/bin/loom-runtime'), '#!/bin/sh\n# the house\'s own\n');
  assert.equal(install(h, '--pieces').status, 0);
  assert.ok(!lstatSync(join(h.home, '.local/bin/wake')).isSymbolicLink());
  assert.match(readFileSync(join(h.home, '.local/bin/wake'), 'utf8'), /piece-call" clock/);
  assert.equal(readFileSync(join(h.profileD, 'loom-house.sh'), 'utf8'), '# untouched\n');
  assert.equal(readFileSync(join(h.home, '.local/bin/loom-runtime'), 'utf8'), "#!/bin/sh\n# the house's own\n");
});

test('a TASKSTORE_DB call with no local build fails, and never reaches the piece', () => {
  const h = house();
  rmSync(join(h.home, '.local/share/taskstore'), { recursive: true });
  assert.equal(install(h).status, 0);
  writeFileSync(join(h.home, 'fake-piece-call'), '#!/bin/sh\necho REACHED-PIECE\n', { mode: 0o755 });
  spawnSync('ln', ['-sfn', join(h.home, 'fake-piece-call'), join(h.home, '.local/bin/piece-call')]);
  for (const env of [{ TASKSTORE_DB: '/tmp/x.db' }, { TANK_LOCAL_PIECES: '1' }]) {
    for (const name of ['taskstore', 'loom-tasks']) {
      const r = login(h, `${name} ready`, env);
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stdout, /REACHED-PIECE/);
      assert.match(r.stderr, /no local taskstore build/);
    }
  }
});

test('a PATH without ~/.local/bin is refused, and so is an unwritable profile dir', () => {
  const h = house();
  const r = spawnSync('sh', [TOOLS], { env: { HOME: h.home, PATH: `${NODE_DIR}:${SYS}`, LOOM_HOUSE_PROFILE_D: h.profileD }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't on PATH/);
  if (process.getuid && process.getuid() !== 0) {
    chmodSync(h.profileD, 0o555);
    const u = install(h);
    chmodSync(h.profileD, 0o755);
    assert.equal(u.status, 1);
    assert.match(u.stderr, /isn't writable/);
  }
});

test('an unknown flag is a usage error', () => {
  const h = house();
  const r = install(h, '--nope');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: install-tools/);
});

test('piece-call says what it needs when loom is not configured', () => {
  const r = spawnSync('python3', [join(ROOT, 'house/piece-call'), 'clock', '--help'], { env: { PATH: SYS }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /LOOM_URL and LOOM_TOKEN_FILE must be set/);
});

// The real piece-call against a stand-in loom: what it sends, and what it gives back.
function fakeLoom(reply) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, argv: JSON.parse(body).argv });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

function pieceCall(loomUrl, tok, args, input) {
  return new Promise((ok) => {
    const child = execFile(join(ROOT, 'house/piece-call'), args, { env: { PATH: SYS, LOOM_URL: loomUrl, LOOM_TOKEN_FILE: tok } },
      (err, stdout, stderr) => ok({ code: err ? err.code : 0, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

test('piece-call posts the argv to /api/<piece>/run as the token, and reads back exit, stdout and stderr', async () => {
  const tok = join(mkdtempSync(join(tmpdir(), 'pc-')), 'tok');
  writeFileSync(tok, 'sekrit\n');
  assert.ok(statSync(join(ROOT, 'house/piece-call')).mode & 0o111, 'piece-call is executable');
  const a = await fakeLoom({ exit: 3, stdout: 'out\n', stderr: 'err\n' });
  try {
    const r = await pieceCall(a.url, tok, ['clock', 'in', '4h', '--note', 'two words']);
    assert.deepEqual(a.seen, [{ url: '/api/clock/run', auth: 'Bearer sekrit', argv: ['in', '4h', '--note', 'two words'] }]);
    assert.deepEqual([r.code, r.stdout, r.stderr], [3, 'out\n', 'err\n']);
    // A bare piece (`wake` alone) asks the piece, with no argv.
    await pieceCall(a.url, tok, ['clock']);
    assert.deepEqual(a.seen[1].argv, []);
  } finally { a.server.close(); }
  const b = await fakeLoom({ exit: 0, stdoutGz: gzipSync('big\n').toString('base64') });
  try {
    const r = await pieceCall(b.url, tok, ['tasks', 'export']);
    assert.deepEqual([r.code, r.stdout], [0, 'big\n']);
    // `tasks comment --file -`: the text is read here and sent as the comment's own argument (t-1854).
    await pieceCall(b.url, tok, ['tasks', 'comment', 't-1', '--file', '-'], 'the text\n');
    assert.deepEqual(b.seen[1].argv, ['comment', 't-1', 'the text']);
  } finally { b.server.close(); }
});

test('the installed approvals wrapper carries conversation provenance even for an unknown principal', async () => {
  const h = house();
  assert.equal(install(h).status, 0);
  const token = join(h.home, 'token'), runtime = join(h.home, 'fake-runtime');
  writeFileSync(token, 'diagnostic-token\n');
  writeFileSync(runtime, '#!/bin/sh\necho \'{"ok":true,"owner":false,"for":"?","statement":"ACTUAL.sig"}\'\n', { mode: 0o755 });
  const server = await fakeLoom({ exit: 0, stdout: 'pending\n', stderr: '' });
  const request = ['request', '--kind', 'codex-diagnostic', '--target', 'receipt'];
  const invoke = (args, cv = 'cv-0123456789ab') => new Promise(resolve => {
    const child = execFile(join(h.home, '.local/bin/approvals'), args, {
      env: { HOME: h.home, PATH: h.path, LOOM_URL: server.url, LOOM_TOKEN_FILE: token, LOOM_BODY_CONVERSATION: cv, PIECE_CALL_RUNTIME: runtime },
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin.end();
  });
  try {
    assert.equal((await invoke(request)).code, 0);
    assert.deepEqual(server.seen.at(-1).argv, [...request, '--conversation', 'cv-0123456789ab', '--principal', 'ACTUAL.sig']);
    await invoke([...request, '--conversation=cv-111111111111', '--principal', 'FORGED']);
    assert.deepEqual(server.seen.at(-1).argv, [...request, '--conversation=cv-111111111111', '--principal', 'ACTUAL.sig']);
    await invoke(request, 'not-a-conversation');
    assert.deepEqual(server.seen.at(-1).argv, request);
    await invoke(['check', 'a-12345678']);
    assert.deepEqual(server.seen.at(-1).argv, ['check', 'a-12345678', '--principal', 'ACTUAL.sig']);
  } finally { server.server.close(); }
});

test('a tasks call with a --source carries the runtime statement; one without asks the runtime nothing (t-2117)', async () => {
  const h = house();
  assert.equal(install(h).status, 0);
  const token = join(h.home, 'token'), runtime = join(h.home, 'fake-runtime'), asked = join(h.home, 'asked');
  writeFileSync(token, 'diagnostic-token\n');
  writeFileSync(runtime, `#!/bin/sh\necho x >> ${asked}\necho '{"ok":true,"owner":true,"conversation":"cv-0123456789ab","statement":"ACTUAL.sig"}'\n`, { mode: 0o755 });
  const server = await fakeLoom({ exit: 0, stdout: '{}\n', stderr: '' });
  const invoke = (args) => new Promise(resolve => {
    const child = execFile(join(h.home, '.local/bin/taskstore'), args, {
      env: { HOME: h.home, PATH: h.path, LOOM_URL: server.url, LOOM_TOKEN_FILE: token, LOOM_BODY_CONVERSATION: 'cv-0123456789ab', PIECE_CALL_RUNTIME: runtime },
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin.end();
  });
  try {
    await invoke(['ready']);
    assert.deepEqual(server.seen.at(-1).argv, ['ready']);
    assert.equal(existsSync(asked), false, 'no --source: the runtime is not asked');
    const made = ['create', 'x', '--source', 'conversation:cv-0123456789ab'];
    await invoke([...made, '--principal', 'FORGED']);
    assert.deepEqual(server.seen.at(-1).argv, [...made, '--principal', 'ACTUAL.sig']);
  } finally { server.server.close(); }
});
