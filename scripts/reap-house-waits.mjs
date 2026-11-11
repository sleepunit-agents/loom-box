#!/usr/bin/env node
// Run as the box's runtime user. Dry-run is the default; this only signals
// exact Podman waits for house receipts owned by this runtime data directory.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { reapHouseWaits } from '../src/house-watchers.mjs';
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !/^--legacy-pids=[1-9][0-9]*(,[1-9][0-9]*)*$/.test(args[0]))) {
  throw Error('usage: node scripts/reap-house-waits.mjs [--legacy-pids=PID,PID]');
}
const legacyPids = new Set(args.length ? args[0].slice('--legacy-pids='.length).split(',').map(Number) : []);
const data = process.env.LOOM_BOX_DATA || join(homedir(), '.local/share/loom-box');
const command = process.env.LOOM_BOX_PODMAN || 'podman';
const names = new Set(readdirSync(join(data, 'houses')).filter(n => /^h-[0-9]+$/.test(n)).map(n => `loom-house-${n}`));
reapHouseWaits(command, names, '/proc', (pid, signal) => {
  console.log(`${process.env.REAP === '1' ? 'reap' : 'would reap'} ${pid} ${signal}`);
  if (process.env.REAP === '1') process.kill(pid, signal);
}, process.env.PATH, legacyPids);
