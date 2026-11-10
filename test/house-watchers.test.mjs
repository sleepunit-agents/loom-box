import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeHouse, reapHouseWaits } from '../src/house-watchers.mjs';

const options = { stdio: 'ignore' };
// Node ignores argv after -e's script, so it stands in for a long-lived wait.
const dir = mkdtempSync(join(tmpdir(), 'watchers-'));
const command = join(dir, 'podman');
writeFileSync(command, '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });

test('repeated adoption keeps exactly one live wait for each house', async () => {
  const other = observeHouse(command, 'house-other', options);
  let previous;
  try {
    for (let n = 0; n < 8; n++) {
      const next = observeHouse(command, 'house-one', options);
      await once(next, 'spawn');
      const group = pid => readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').pop().split(' ')[2];
      assert.equal(group(next.pid), group(process.pid), 'observer is not detached');
      if (previous) { if (previous.exitCode === null && previous.signalCode === null) await once(previous, 'exit'); assert.equal(previous.signalCode, 'SIGKILL'); }
      previous = next;
      assert.equal(other.signalCode, null);
      assert.equal(next.signalCode, null);
    }
  } finally { previous?.kill('SIGKILL'); other.kill('SIGKILL'); }
});

test('orphan sweep requires exact executable, argv, parent and assigned house', () => {
  const proc = join(dir, 'proc'); mkdirSync(proc);
  const add = (id, parent, args, exe = command) => { const p=join(proc,String(id)); mkdirSync(p); writeFileSync(join(p,'status'),`PPid:\t${parent}\n`); writeFileSync(join(p,'cmdline'),args.join('\0')+'\0'); symlinkSync(exe,join(p,'exe')); };
  mkdirSync(join(proc,'99')); writeFileSync(join(proc,'99','comm'),'systemd\n');
  mkdirSync(join(proc,'98')); writeFileSync(join(proc,'98','comm'),'node\n');
  add(10,1,['podman','wait','ours']); add(11,99,['podman','wait','ours']);
  add(12,98,['podman','wait','ours']); add(13,1,['podman','wait','theirs']);
  add(14,1,['podman','stop','ours']); add(15,1,['podman','wait','ours','theirs']);
  add(16,1,['podman','wait','ours'],process.execPath);
  add(17,1,['podman','wait','ours-extra']);
  mkdirSync(join(proc,'97')); writeFileSync(join(proc,'97','comm'),'tini\n');
  mkdirSync(join(proc,'96')); writeFileSync(join(proc,'96','comm'),'dumb-init\n');
  add(18,97,['podman','wait','ours']); add(19,96,['podman','wait','ours']);
  const expected=[[10,'SIGKILL'],[11,'SIGKILL'],[18,'SIGKILL'],[19,'SIGKILL']];
  const killed=[]; reapHouseWaits(command,new Set(['ours']),proc,(pid,sig)=>killed.push([pid,sig]));
  assert.deepEqual(killed,expected);
  killed.length = 0;
  reapHouseWaits('podman',new Set(['ours']),proc,(pid,sig)=>killed.push([pid,sig]),dir);
  assert.deepEqual(killed,expected, 'uses the runtime PATH');
  const nonexec=join(dir,'nonexec'), directory=join(dir,'directory');
  mkdirSync(nonexec); mkdirSync(directory);
  writeFileSync(join(nonexec,'podman'),'not executable',{mode:0o644});
  mkdirSync(join(directory,'podman'));
  killed.length=0;
  reapHouseWaits('podman',new Set(['ours']),proc,(pid,sig)=>killed.push([pid,sig]),[nonexec,directory,dir].join(':'));
  assert.deepEqual(killed,expected, 'skips non-executable files and directories');
  rmSync(proc,{recursive:true});
});
