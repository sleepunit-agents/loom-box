// `loom box run --local` is what the box piece's service runs, on every machine
// it's installed on. On loom's own machine that's the control plane's own box;
// on a box that joined a loom (box.json, from `loom box join`) it's that join,
// never a second, empty control plane (box-two, 2026-10-27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runsLocal } from '../src/box.mjs';

test('run --local is the control plane\'s own box, unless this machine joined a loom', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-box-mode-'));
  const env = { HOME: home, LOOM_BOX_HOME: join(home, 'state') };
  assert.equal(runsLocal(env, true), true);
  assert.equal(runsLocal(env, false), false);
  mkdirSync(env.LOOM_BOX_HOME, { recursive: true });
  writeFileSync(join(env.LOOM_BOX_HOME, 'box.json'), JSON.stringify({ url: 'http://loom:8787', name: 'two', labels: [] }));
  assert.equal(runsLocal(env, true), false);
});
