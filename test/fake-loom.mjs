#!/usr/bin/env node
// A stand-in for core's `loom` CLI, as the runtime runs it for who may do what (policy.mjs): `loom store <piece> get
// <collection> <key>` answers $FAKE_LOOM/<collection>.<key>.json as {doc, rev: 1} (an agent's gates default to a
// document naming no one; anything else not there is exit 3, none); `loom person show <slug>` prints
// $FAKE_LOOM/card.<slug>.md (else exit 3).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const D = process.env.FAKE_LOOM ?? '/nonexistent';
const [verb, ...a] = process.argv.slice(2);
const file = (n) => join(D, n);
if (verb === 'store' && a[1] === 'get') {
  const [, , coll, key] = a;
  const f = file(`${coll}.${key}.json`);
  if (existsSync(f)) { process.stdout.write(JSON.stringify({ doc: JSON.parse(readFileSync(f, 'utf-8')), rev: 1 })); process.exit(0); }
  if (coll === 'gates') { process.stdout.write(JSON.stringify({ doc: { people: {} }, rev: 1 })); process.exit(0); }
  process.exit(3);
}
if (verb === 'person' && a[0] === 'show') {
  const f = file(`card.${a[1]}.md`);
  if (existsSync(f)) { process.stdout.write(readFileSync(f, 'utf-8')); process.exit(0); }
  process.exit(3);
}
process.stderr.write(`fake loom: no ${verb} ${a.join(' ')}\n`);
process.exit(2);
