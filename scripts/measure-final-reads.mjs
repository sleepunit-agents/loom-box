#!/usr/bin/env node
// Reproduce the 64-entry cliff against this tree or a baseline checkout supplied as argv[2].
// Count actual bytes returned by fs.readSync on transcript descriptors, separately from checkpoint I/O.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = fs.mkdtempSync(join(tmpdir(), 'final-population-'));
const original = fs.readSync;
const repo = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url));
const { ClaudeRunner } = await import(pathToFileURL(join(repo, 'src/runners.mjs')));
const event = text => JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}})+'\n';
try {
  for (const count of [64, 65, 128]) {
    const dir = join(root, String(count)), jobsDir = join(dir, 'jobs'), projectsDir = join(dir, 'projects');
    const project = join(projectsDir, 'p'); fs.mkdirSync(project, {recursive:true});
    const data = JSON.stringify({type:'tool',padding:'x'.repeat(1024*1024)})+'\n'+event('last 界 🐟');
    const jobs = Array.from({length:count}, (_,i) => {
      const id = i.toString(16).padStart(8,'0'), session = `${id}-session`, job = join(jobsDir,id), file = join(project,`${session}.jsonl`);
      fs.mkdirSync(job,{recursive:true}); fs.writeFileSync(join(job,'state.json'),JSON.stringify({sessionId:session}));
      fs.writeFileSync(file,data);
      return {id,slot:{harness:'claude',session},file};
    });
    const inodes = new Set(jobs.map(j=>fs.statSync(j.file).ino));
    const runner = new ClaudeRunner({jobsDir,projectsDir});
    let bytes = 0, reads = 0, otherBytes = 0;
    fs.readSync = (...args) => {
      const n = original(...args);
      if (inodes.has(fs.fstatSync(args[0]).ino)) { bytes+=n; reads++; } else otherBytes+=n;
      return n;
    };
    syncBuiltinESMExports();
    for (let poll=1; poll<=3; poll++) {
      bytes=0;reads=0;otherBytes=0;
      for (const job of jobs) assert.equal(runner.final(job),'last 界 🐟');
      console.log(JSON.stringify({count,poll,transcriptBytes:bytes,transcriptReads:reads,otherReadSyncBytes:otherBytes}));
    }
    fs.readSync=original; syncBuiltinESMExports(); fs.rmSync(dir,{recursive:true,force:true});
  }
} finally { fs.readSync=original; syncBuiltinESMExports(); fs.rmSync(root,{recursive:true,force:true}); }
