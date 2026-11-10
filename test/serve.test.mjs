// `loom-runtime api --serve` (t-2065): the declared paths from one long-lived process, each answer what `api --json`
// would print, each request's store grant its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { SERVED, serveApi, serveOne } from '../src/serve.mjs';
import { scratch } from './scratch.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

test('what it serves is what the loom block declares', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  assert.deepEqual(pkg.loom.api_serve, [...SERVED]);
});

test('a path it doesn\'t serve, a bad grant or a bad line is refused, never answered', async () => {
  const call = () => { throw Error('never called'); };
  assert.deepEqual(await serveOne({}, JSON.stringify({ id: 1, grant: null, request: { caller: { kind: 'owner' }, path: 'up', body: {} } }), { call }), { id: 1, exit: 2 });
  assert.deepEqual(await serveOne({}, JSON.stringify({ id: 2, grant: 7, request: { caller: { kind: 'agent', agent: 'art' }, path: 'body-sync', body: {} } }), { call }), { id: 2, exit: 2 });
  assert.equal(await serveOne({}, 'not json', { call }), null);
  assert.equal(await serveOne({}, JSON.stringify({ id: 'x; rm', request: {} }), { call }), null);
});

test('each request\'s grant is its own: never the process\'s, never kept for the next', async () => {
  const seen = [];
  const call = (env, _fx, req) => { seen.push({ grant: env.LOOM_STORE_GRANT, path: req.path }); return { status: 200, body: { n: seen.length } }; };
  const input = new PassThrough(), output = new PassThrough();
  let got = '';
  output.on('data', (d) => { got += d; });
  const done = serveApi({ HOME: '/nowhere', LOOM_STORE_GRANT: 'inherited' }, { input, output, call });
  const req = (id, grant) => JSON.stringify({ id, grant, request: { caller: { kind: 'agent', agent: 'art', house: 'h-1' }, path: 'body-sync', body: {} } });
  input.end([req(1, 'g-one'), req(2, null), req(3, 'g-three'), req(4)].join('\n') + '\n');
  await done;
  assert.deepEqual(seen.map((x) => x.grant), ['g-one', undefined, 'g-three', undefined]);
  const answers = got.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(answers.map((a) => [a.id, a.exit, JSON.parse(a.stdout).body.n]), [[1, 0, 1], [2, 0, 2], [3, 0, 3], [4, 0, 4]]);
});

test('served, a body-sync is answered exactly as `api --json` answers it, and stray prints stay off the answers', async () => {
  const home = scratch('serve-');
  const env = { ...process.env, HOME: home, LOOM_BOX_HOME: join(home, 'state'), LOOM_BOX_DATA: join(home, 'data'), LOOM_STORE_GRANT: '' };
  const request = { caller: { kind: 'agent', agent: 'art' }, path: 'body-sync', body: { hostKey: 'x', report: {} } };
  const once = spawnSync(process.execPath, [CLI, 'api', '--json'], { env, input: JSON.stringify(request), encoding: 'utf-8' });
  assert.equal(once.status, 0, once.stderr);
  const child = spawn(process.execPath, [CLI, 'api', '--serve'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stdin.end(JSON.stringify({ id: 9, grant: null, request }) + '\n' + JSON.stringify({ id: 10, grant: null, request }) + '\n');
  await new Promise((r) => child.on('exit', r));
  const answers = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(answers.map((a) => a.id), [9, 10]);
  for (const a of answers) { assert.equal(a.exit, 0); assert.equal(a.stdout, once.stdout); }
  assert.match(once.stdout, /a house/, 'the refusal for a token naming no house, as one-shot');
});
