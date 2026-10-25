// Every page answer, run through loom's own validator (loom src/ui/vocab.ts),
// so a shape loom would drop whole is caught here, not on the live page.
// Needs a built loom: LOOM_DIST, else ~/Code/loom/dist. Skipped without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, manifest, page } from '../src/ui.mjs';
import { api } from '../src/control.mjs';

const dist = process.env.LOOM_DIST || join(homedir(), 'Code', 'loom', 'dist');
const vocab = existsSync(join(dist, 'ui', 'vocab.js')) ? await import(join(dist, 'ui', 'vocab.js')) : null;

test('the manifest, both pages and every action result are valid page vocabulary', { skip: !vocab && 'no built loom to validate against' }, () => {
  const env = { HOME: mkdtempSync(join(tmpdir(), 'loom-box-c-')), LOOM_BOX_LOCAL_NAME: 'one' };
  env.LOOM_BOX_HOME = join(env.HOME, 'state');
  const fx = { now: () => new Date(), mint: () => 'loom_' + 'x'.repeat(30), revoke: () => {}, secret: () => 's' };
  const check = (what, r) => assert.notEqual(typeof r, 'string', `${what}: ${r}`);
  check('empty manifest', vocab.parseManifest(manifest(env)));
  check('empty page', vocab.parsePage(page(env, { path: '' })));
  check('empty agents page', vocab.parsePage(page(env, { path: 'agents' })));
  // Fill it: an agent, two boxes, houses in every state.
  for (const r of [
    act(env, fx, { action: 'set-agent', fields: { agent: 'art', repo: 'https://x/art.git', secrets: 'github-token=gh' } }),
    act(env, fx, { action: 'add-box', fields: { name: 'thor', may_host: 'art', labels: 'jonathan-rig' } }),
    act(env, fx, { action: 'set-primary', fields: { agent: 'art', box: 'thor' } }),
    act(env, fx, { action: 'up', fields: { agent: 'art', task: 'x'.repeat(300) } }),
    act(env, fx, { action: 'up', fields: { agent: 'art', box: 'one', task: 'y' } }),
    act(env, fx, { action: 'may-host', fields: { name: 'thor', may_host: 'anyone' } }),
    act(env, fx, { action: 'nope', fields: {} }),
  ]) check('act', vocab.parseActResult(r));
  api(env, fx, { caller: { kind: 'piece', subject: 'one' }, path: 'claim', body: { id: 'h-2' } });
  api(env, fx, { caller: { kind: 'piece', subject: 'one' }, path: 'report', body: { id: 'h-2', state: 'failed', exit: 2, log: 'boom' } });
  check('full manifest', vocab.parseManifest(manifest(env)));
  check('full page', vocab.parsePage(page(env, { path: '' })));
  check('full agents page', vocab.parsePage(page(env, { path: 'agents' })));
  check('down', vocab.parseActResult(act(env, fx, { action: 'down', fields: { id: 'h-1' } })));
  check('revoke', vocab.parseActResult(act(env, fx, { action: 'revoke-box', fields: { name: 'thor' } })));
  check('not found', vocab.parsePage(page(env, { path: 'x' })));
});
