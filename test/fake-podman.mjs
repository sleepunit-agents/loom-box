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

switch (`${args[0]} ${args[1] ?? ''}`) {
  case 'image exists': process.exit(existsSync(join(D, 'images', safe(args[2]))) ? 0 : 1);
  case 'info --format': console.log('true'); process.exit(0);
  case 'secret create': { writeFileSync(join(D, 'secrets', args[3]), stdin(), { mode: 0o600 }); process.exit(0); }
  case 'secret rm': { for (const n of args.slice(2)) rmSync(join(D, 'secrets', n), { force: true }); process.exit(0); }
  case 'secret ls': { console.log(readdirSync(join(D, 'secrets')).join('\n')); process.exit(0); }
  case 'unshare rm': { rmSync(args[3], { recursive: true, force: true }); process.exit(0); }
  default: break;
}
if (args[0] === 'build') {
  if (cfg().build) { console.log('build broke'); process.exit(cfg().build); }
  writeFileSync(join(D, 'images', safe(args[args.indexOf('-t') + 1])), '');
  writeFileSync(join(D, 'builds'), `${(existsSync(join(D, 'builds')) ? readFileSync(join(D, 'builds'), 'utf-8') : '')}${args[2]}\n`);
  process.exit(0);
}
if (args[0] === 'rm' || args[0] === 'stop') {
  const name = args.at(-1);
  writeFileSync(join(D, 'runs', `${name}.${args[0]}`), '');
  const pidf = join(D, 'runs', `${name}.pid`);
  if (args[0] === 'stop' && existsSync(pidf)) { try { process.kill(Number(readFileSync(pidf, 'utf-8')), 'SIGTERM'); } catch { /* gone */ } }
  process.exit(0);
}
if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1];
  // What the container would see: each secret's value, by where it lands.
  const seen = {};
  args.forEach((a, i) => {
    if (args[i - 1] !== '--secret') return;
    const [ps, type, target] = a.split(',');
    seen[`${type.split('=')[1]}:${target.split('=')[1]}`] = readFileSync(join(D, 'secrets', ps), 'utf-8');
  });
  writeFileSync(join(D, 'runs', `${name}.json`), JSON.stringify({ args, seen, stdin: args.includes('-i') ? stdin() : null }));
  writeFileSync(join(D, 'runs', `${name}.pid`), String(process.pid));
  const how = cfg().run || 'exit:0';
  if (how.startsWith('exit:')) { console.log('the house says hi'); process.exit(Number(how.slice(5))); }
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1000);
} else {
  console.error(`fake podman: ${args.join(' ')}`);
  process.exit(2);
}
