// IDs only: message text remains in delivery's sealed copies. Unknown receipts
// must replay conservatively; a missing or malformed file cannot prove delivery.
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const validPendingInbox = value => value === null || Array.isArray(value) && value.length <= 10_000 &&
  value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64) && new Set(value).size === value.length;

export function nativePendingInbox(root, id) {
  if (!root || !/^[A-Za-z0-9-]{4,64}$/.test(id ?? '')) return null;
  const dir = join(root, id.slice(0, 8));
  const read = (name, max, absent) => {
    let fd;
    try {
      fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > max) throw Error('invalid inbox receipt');
      const data = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(data) > max) throw Error('invalid inbox receipt');
      return data;
    } catch (error) { if (error.code === 'ENOENT' && absent !== undefined) return absent; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    const meta = JSON.parse(read('meta.json', 64 * 1024));
    if (meta.chan !== id || meta.bridge !== 'runtime' || meta.venue !== 'runtime') return null;
    const ids = name => read(name, 2 * 1024 * 1024, '').split('\n').filter(Boolean).map(line => JSON.parse(line).id);
    const pending = ids('pending.jsonl'), taken = ids('delivered.jsonl');
    // Duplicated records are harmless; invalid IDs are not proof of absence.
    const all = [...new Set([...pending, ...taken])];
    if (!validPendingInbox(all)) return null;
    const delivered = new Set(taken);
    return [...new Set(pending)].filter(key => !delivered.has(key)).sort();
  } catch { return null; }
}
