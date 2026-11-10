// A file someone sent a body's conversation (t-1961): asked of the venue's adapter for that conversation's own place,
// only for the body proving it holds the conversation, and handed back whole in parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { deliver, depsOf, loadConv } from '../src/delivery.mjs';
import { FILE_PART, fileOf } from '../src/files.mjs';
import { runFor } from '../src/gates-api.mjs';
import { memStore } from '../src/store.mjs';
import { world } from './delivery-world.mjs';

const DATA = Buffer.alloc(FILE_PART * 2 + 17, 7);
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function setup(adapterFile = { name: 'photo.jpg', data: DATA }, messages = ['art:D1:1.0']) {
  const w = world();
  const asked = [];
  Object.assign(w.o, {
    venues: () => ({ slack: { kind: 'live', send: ['loom-slack', 'send'] } }),
    adapter: async (argv, c, args) => {
      if (args[0] !== '--file') return { ok: true };
      asked.push({ argv, place: c.place, agent: c.agent, id: args[1] });
      if (!adapterFile) throw new Error('no file F0ABC was sent in this conversation');
      writeFileSync(args[3], adapterFile.data);
      return { ok: true, name: adapterFile.name, size: adapterFile.size ?? adapterFile.data.length, sha256: adapterFile.sha ?? sha(adapterFile.data), messages };
    },
  });
  const cv = (await deliver(w.env, w.msg('dm:U1', 'look [file: photo.jpg; to read it: loom runtime file F0ABC]', { source: 'slack', id: 'art:D1:1.0', venue: 'slack', from: { kind: 'person', slug: 'phil' } }), w.o)).conversation;
  // Another conversation in the same place, earlier (another seat's, say): its message carried a file too.
  await deliver(w.env, w.msg('dm:U2', 'elsewhere', { source: 'slack', id: 'art:D2:1.0', venue: 'slack', from: { kind: 'person', slug: 'sam' } }), w.o);
  const c = loadConv(w.env, cv);
  const proof = { key: w.runner.envs[c.body.split(':')[1]].LOOM_BODY_KEY, session: w.sessionFor(cv) };
  const d = depsOf(w.env, w.o);
  return { w, cv, proof, d, asked, get: (part, p = proof, caller = { kind: 'agent', agent: 'art' }, id = 'F0ABC') => fileOf(w.env, cv, id, part, p, caller, d) };
}

test('the body holding the conversation gets a file sent in its place, whole, in parts', async () => {
  const { asked, get } = await setup();
  const first = await get(0);
  assert.equal(first.ok, true, first.reason);
  assert.deepEqual([first.name, first.size, first.parts], ['photo.jpg', DATA.length, 3]);
  assert.deepEqual(asked.map((a) => [a.place, a.agent, a.id, a.argv.join(' ')]), [['dm:U1', 'art', 'F0ABC', 'loom-slack send']], 'its own place, asked of the venue\'s adapter');
  const parts = [first, await get(1), await get(2)];
  assert.equal(asked.length, 1, 'fetched once');
  const whole = Buffer.concat(parts.map((p) => Buffer.from(p.data, 'base64')));
  assert.equal(sha(whole), first.sha256);
  assert.equal((await get(3)).ok, false);
});

test('no other body, agent or proof gets it, and nothing is asked of the adapter for them', async () => {
  const { proof, asked, get } = await setup();
  assert.equal((await get(0, { key: proof.key })).ok, false, 'no session');
  assert.equal((await get(0, { key: proof.key, session: 'someone-else' })).ok, false, 'another session');
  assert.equal((await get(0, { key: 'f'.repeat(64), session: proof.session })).ok, false, 'another key');
  assert.equal((await get(0, proof, { kind: 'agent', agent: 'mark' })).ok, false, 'another agent');
  assert.equal((await get(0, proof, undefined, '../x')).ok, false, 'not an id');
  assert.equal((await get(0, proof, undefined, '--describe')).ok, false, 'never a flag to the adapter');
  assert.equal(asked.length, 0);
});

test('a part before the file was fetched, or an adapter that hands over something else, gets nothing', async () => {
  assert.match((await (await setup()).get(1)).reason, /part 0/);
  assert.match((await (await setup(null)).get(0)).reason, /no file F0ABC/);
  assert.match((await (await setup({ name: 'photo.jpg', data: DATA, sha: 'f'.repeat(64) })).get(0)).reason, /something other/);
  assert.match((await (await setup({ name: '../x', data: DATA })).get(0)).reason, /something other/);
});

test('a file sent in its place but not in this conversation gets nothing', async () => {
  for (const messages of [[], ['art:D2:1.0'], ['art:D9:9.0'], null]) {
    const r = await (await setup(undefined, messages)).get(0);
    assert.match(r.reason, /no message delivered to this conversation/, JSON.stringify(messages));
  }
  assert.equal((await (await setup(undefined, ['art:D2:1.0', 'art:D1:1.0'])).get(0)).ok, true, 'one of its deliveries came here');
});

test('through the runtime\'s run path, the call names its conversation, id and part', async () => {
  const { w, cv, proof } = await setup();
  const r = await runFor(w.env, { kind: 'agent', agent: 'art' }, ['file', '--conversation', cv, '--id', 'F0ABC'], memStore(), undefined, undefined, proof);
  assert.equal(r.exit, 2);
});
