// Atomic durable JSON publication, including newly created directory entries.
import { mkdirSync, rmSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
export function durableJson(file, value) {
  mkdirSync(dirname(file), {recursive:true,mode:0o700});
  // Publish every new directory entry too, including concurrent mkdir races.
  for (let dir = resolve(dirname(file)); ; dir = dirname(dir)) {
    const parent = openSync(dir,'r'); try {fsyncSync(parent);} finally {closeSync(parent);}
    if (dirname(dir) === dir) break;
  }
  const tmp = `${file}.${randomBytes(12).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tmp,'wx',0o600);
    try {writeFileSync(fd,JSON.stringify(value)); fsyncSync(fd);} finally {closeSync(fd);}
    renameSync(tmp,file);
    fd = openSync(dirname(file),'r'); try {fsyncSync(fd);} finally {closeSync(fd);}
  } finally {rmSync(tmp,{force:true});}
}
