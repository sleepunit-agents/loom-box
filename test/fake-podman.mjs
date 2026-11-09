#!/usr/bin/env node
// A stand-in for podman in the tests: records what the box asked for, keeps
// secrets and images in a dir beside itself, and runs a "container" that does
// what that dir's config says (run: "exit:<n>" or "sleep"; build: an exit code).
// The box gives podman a minimal environment, so settings come from the file.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const D = join(dirname(realpathSync(fileURLToPath(import.meta.url))), 'podman-state');
const cfg = () => { try { return JSON.parse(readFileSync(join(D, 'config.json'), 'utf-8')); } catch { return {}; } };
for (const d of ['images', 'secrets', 'runs', 'log']) mkdirSync(join(D, d), { recursive: true });
const args = process.argv.slice(2);
writeFileSync(join(D, 'log', `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`), JSON.stringify(args));
const stdin = () => { try { return readFileSync(0, 'utf-8'); } catch { return ''; } };
const safe = (s) => s.replace(/[/:]/g, '_');
// A "container" is running while the process that ran it is.
function alive(name) {
  try { process.kill(Number(readFileSync(join(D, 'runs', `${name}.pid`), 'utf-8')), 0); return true; } catch { return false; }
}

// The box's own CLI runs (logins.mjs, cliRunArgs): a throwaway container with the shared login dir its one mount.
// Emulated here on the host, with the mount's path mapped to its source and the container's /tmp to a fresh dir, and
// the image's CLIs from config.json's cliBin. (Mount semantics, symlinks resolving inside the container, need real
// podman: test/accounts.test.mjs has that test.)
if (args[0] === 'images') {
  for (const i of cfg().images ?? ['localhost/loom-house-art:abc 2026-11-01 10:00:00 +0000 UTC']) console.log(i);
  process.exit(0);
}
if (args[0] === 'run' && args.includes('--entrypoint')) {
  const vols = args.filter((a, i) => args[i - 1] === '-v');
  if (vols.length !== 1) { console.error(`fake podman: a CLI run mounts exactly one dir, not ${vols.length}`); process.exit(125); }
  const [src, at] = vols[0].split(':');
  const tmp = join(D, 'cli-tmp', String(process.pid));
  mkdirSync(tmp, { recursive: true });
  const map = (s) => s.split(at).join(src).split('/tmp/cli').join(join(tmp, 'cli'));
  // Only the image's CLIs (cliBin) and the base system: never a real claude or codex the test machine has.
  const env = { PATH: `${cfg().cliBin ?? ''}:/usr/bin:/bin`, HOME: tmp };
  args.forEach((a, i) => { if (args[i - 1] === '-e') { const k = a.slice(0, a.indexOf('=')); env[k] = map(a.slice(a.indexOf('=') + 1)); } });
  const script = map(args[args.indexOf('-c') + 1]);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('sh', ['-c', script], { env, stdio: 'inherit' });
  rmSync(tmp, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}
// rmi: refused for an image config.json's inUse names (a container uses it), as podman without --force does.
if (args[0] === 'rmi') {
  if ((cfg().inUse ?? []).includes(args[1])) { console.error(`image used by a container: ${args[1]}`); process.exit(2); }
  writeFileSync(join(D, 'rmis'), `${(existsSync(join(D, 'rmis')) ? readFileSync(join(D, 'rmis'), 'utf-8') : '')}${args[1]}\n`);
  process.exit(0);
}
switch (`${args[0]} ${args[1] ?? ''}`) {
  case 'image exists': process.exit(existsSync(join(D, 'images', safe(args[2]))) ? 0 : 1);
  case 'container exists': process.exit(alive(args.at(-1)) ? 0 : 1);
  case 'info --format': console.log('true'); process.exit(0);
  case 'secret create': { writeFileSync(join(D, 'secrets', args[3]), stdin(), { mode: 0o600 }); process.exit(0); }
  case 'secret rm': { for (const n of args.slice(2)) rmSync(join(D, 'secrets', n), { force: true }); process.exit(0); }
  case 'secret ls': { console.log(readdirSync(join(D, 'secrets')).join('\n')); process.exit(0); }
  case 'unshare rm': { rmSync(args[3], { recursive: true, force: true }); process.exit(0); }
  case 'inspect --format': { console.log(alive(args.at(-1)) ? 'true' : 'false'); process.exit(existsSync(join(D, 'runs', `${args.at(-1)}.pid`)) ? 0 : 125); }
  default: break;
}
if (args[0] === 'build') {
  if (cfg().holdBuild) {
    writeFileSync(join(D, 'building'), '');
    const until = Date.now() + 10_000;
    while (cfg().holdBuild && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    if (cfg().holdBuild) process.exit(124);
  }
  if (cfg().build) { console.log('build broke'); process.exit(cfg().build); }
  writeFileSync(join(D, 'images', safe(args[args.indexOf('-t') + 1])), '');
  writeFileSync(join(D, 'builds'), `${(existsSync(join(D, 'builds')) ? readFileSync(join(D, 'builds'), 'utf-8') : '')}${args[2]}\n`);
  process.exit(0);
}
if (args[0] === 'wait') {
  const name = args.at(-1);
  const t = setInterval(() => { if (!alive(name)) { clearInterval(t); console.log('0'); process.exit(0); } }, 50);
} else if (args[0] === 'rm' || args[0] === 'stop') {
  const name = args.at(-1);
  writeFileSync(join(D, 'runs', `${name}.${args[0]}`), '');
  const pidf = join(D, 'runs', `${name}.pid`);
  if (args[0] === 'stop') {
    const tries=join(D,'runs',name+'.attempts');
    const attempt=Number(existsSync(tries)?readFileSync(tries,'utf8'):0)+1;writeFileSync(tries,String(attempt));
    if(attempt<=(cfg().stopFailures??0)||(cfg().run==='separate'&&!existsSync(pidf)))process.exit(125);
  }
  if (args[0] === 'stop' && existsSync(pidf)) { try { process.kill(Number(readFileSync(pidf, 'utf-8')), 'SIGTERM'); } catch { /* gone */ } }
  if(args[0]==='stop'&&cfg().run==='separate'){
    while(alive(name))await new Promise(r=>setTimeout(r,10));
  }
  process.exit(0);
} else if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1];
  // What the container would see: each secret's value, by where it lands.
  const seen = {};
  args.forEach((a, i) => {
    if (args[i - 1] !== '--secret') return;
    const [ps, type, target] = a.split(',');
    seen[`${type.split('=')[1]}:${target.split('=')[1]}`] = readFileSync(join(D, 'secrets', ps), 'utf-8');
  });
  // A service's state mount: read what's there, and leave a mark (its "cursor").
  const stateSrc = args.filter((a, i) => args[i - 1] === '-v').map((v) => v.split(':')[0]).find((p) => p.endsWith('/state'));
  let before = null;
  if (stateSrc) {
    try { before = readFileSync(join(stateSrc, 'cursor'), 'utf-8'); } catch { before = null; }
    writeFileSync(join(stateSrc, 'cursor'), `${before ?? ''}${name};`);
  }
  writeFileSync(join(D, 'runs', `${name}.json`), JSON.stringify({ args, seen, stdin: args.includes('-i') ? stdin() : null, stateBefore: before }));
  if (cfg().run === 'separate') {
    if(cfg().createGate){const end=Date.now()+8000;while(!existsSync(join(D,'runs',name+'.create'))&&Date.now()<end)await new Promise(r=>setTimeout(r,10));}
    const { spawn } = await import('node:child_process');
    const source = `
      const fs=require('node:fs'),path=require('node:path');
      const [folder,name,state]=process.argv.slice(1);
      const file=suffix=>path.join(folder,'runs',name+suffix);
      let stopping=false;
      process.on('SIGTERM',()=>{stopping=true;fs.writeFileSync(file('.stopping'),'');});
      const t=setInterval(()=>{
        if(!stopping||!fs.existsSync(file('.release')))return;
        clearInterval(t);
        try { if(state)fs.writeFileSync(path.join(state,'cursor'),'RESCUE-COMPLETED'); }
        finally { fs.writeFileSync(file('.exit'),'0');process.exit(0); }
      },10);
      setTimeout(()=>process.exit(124),10000).unref();
      fs.writeFileSync(file('.ready'),'');
    `;
    const native=spawn(process.execPath,['-e',source,D,name,stateSrc??''],{detached:true,stdio:'ignore'});
    writeFileSync(join(D,'runs',name+'.client.pid'),String(process.pid));
    writeFileSync(join(D,'runs',name+'.pid'),String(native.pid));
    process.on('SIGTERM',()=>process.exit(143));
    native.on('exit',code=>process.exit(code??125));
    await new Promise(()=>{});
  }
  writeFileSync(join(D, 'runs', `${name}.pid`), String(process.pid));
  const how = cfg().run || 'exit:0';
  if (how.startsWith('exit:')) { console.log('the house says hi'); process.exit(Number(how.slice(5))); }
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1000);
} else {
  console.error(`fake podman: ${args.join(' ')}`);
  process.exit(2);
}
