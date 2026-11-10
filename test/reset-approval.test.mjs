// Asked on loom's page (t-1975, Jonathan: "It needs to have the site ask me"): a local conversation refused a body for
// being unknown, where only the owner's typed `principal --reset` brought it back, has the runtime file a
// `principal-reset` approval, once; the owner's Allow, posted here by
// loom core as him (`reset-approved`), spends it and resets the conversation, signed as his. Deny never reaches here;
// a member, an agent, an agent's tab or no caller is refused, and nothing is spent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from '../src/ui.mjs';
import { askOwnerReset, conversationJobs, deliveryNotices, drain, deliver, deliveryDir, depsOf, loadConv, resetPrincipal, runtimeAs, seatMoved, shownRows } from '../src/delivery.mjs';
import { putWakeFor, resetSigned } from '../src/principal.mjs';
import { cvOf, fakeRunner, world } from './delivery-world.mjs';
import { scratch } from './scratch.mjs';

const LOCAL = JSON.stringify({ agents: ['art'], cwd: '/home/art/Art', claude: '/home/art/.local/bin/claude', args: [], path: '/usr/bin' });
const OWNER = { kind: 'owner', who: 'jonathan', agents: '*' };
const fx = { now: () => new Date(), mint: () => 'loom_' + 'x'.repeat(30), revoke: () => {}, secret: () => 's' };

/** A fake approvals piece: what was filed, and what it lets be spent (`allowed`, which the test sets as the owner would). */
function approvals() {
  const filed = [];
  const allowed = {};
  const spent = [];
  const withdrawn = [];
  return { filed, allowed, spent, withdrawn, onRequest: null, withdraw(aid) { withdrawn.push(aid); },
    request(target, words) { filed.push({ target, ...words }); this.onRequest?.(); return `a-${String(filed.length).padStart(8, '0')}`; },
    spend(aid, target, agent, kind) {
      const a = allowed[aid];
      if (!a) return `${aid} is pending, waiting on the owner`;
      if (a.used) return `${aid} is used`;
      if (kind !== 'principal-reset' || a.target !== target || agent !== a.agent) return `${aid} allows ${a.target}, not ${target}`;
      a.used = true;
      spent.push(aid);
      return '';
    } };
}

function setup() {
  const ap = approvals();
  const w = world({ LOOM_RUNTIME_LOCAL_BODIES: LOCAL, LOOM_RUNTIME_TEST_APPROVALS: ap });
  const dir = join(w.env.HOME, '.config', 'loom');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], members: [{ person: 'jonathan', agents: '*' }] }));
  const localRunner = fakeRunner([], scratch('rt-reset-'));
  w.o.runner = (h, local) => (local ? localRunner : w.runner);
  const lwake = (place, text, handOver) => {
    const m = w.msg(place, text, { venue: 'wake', from: { kind: 'schedule' }, kind: 'wake', source: 'clock', local: true });
    if (handOver) putWakeFor(deliveryDir(w.env), { agent: m.agent, place: m.place, id: m.id, for: handOver });
    return m;
  };
  return { w, ap, lwake, localRunner };
}
const allow = (env, fields, caller = OWNER) => act(env, fx, { action: 'reset-approved', fields, ...(caller ? { caller } : {}) });

test('a local conversation refused for being unknown asks the owner on the page, once', async () => {
  const { w, ap, lwake } = setup();
  const r = await deliver(w.env, lwake('alert:q', 'disk', null), w.o);
  assert.notEqual(r.body, 'started');
  const cv = cvOf('art', 'wake', 'alert:q');
  assert.equal(ap.filed.length, 1);
  assert.equal(ap.filed[0].target, `art:${cv}`);
  assert.match(ap.filed[0].why, /can't run on loom's machine/);
  assert.equal(loadConv(w.env, cv).resetAsk.approval, 'a-00000001');
  // Never repeated: the next refusal asks nothing new.
  await deliver(w.env, lwake('alert:q', 'disk again', null), w.o);
  assert.equal(ap.filed.length, 1);
});

test('the card says whether the clock handed nothing over or said the wake was no one\'s (t-2009)', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('alert:n', 'none', null), w.o);
  await deliver(w.env, lwake('alert:u', 'unknown', '-'), w.o);
  const rows = (place) => loadConv(w.env, cvOf('art', 'wake', place)).queue;
  assert.equal(rows('alert:n')[0].noWord, true);
  assert.equal(rows('alert:n')[0].wakeFor, '-');
  assert.equal(rows('alert:u')[0].noWord, undefined);
  assert.match(ap.filed.find((f) => f.target.endsWith(cvOf('art', 'wake', 'alert:n'))).details, /a wake the clock said nothing about/);
  assert.match(ap.filed.find((f) => f.target.endsWith(cvOf('art', 'wake', 'alert:u'))).details, /a wake set by work loom couldn't say was yours/);
});

test('a conversation a person other than the owner spoke in is theirs: no ask', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('alert:l', 'one', 'owner'), w.o);
  await deliver(w.env, w.msg('alert:l', 'what is this?', { venue: 'wake', from: { kind: 'person', slug: 'loren' } }), w.o);
  assert.equal(ap.filed.length, 0);
  assert.equal(await askOwnerReset(w.env, loadConv(w.env, cvOf('art', 'wake', 'alert:l')), 'local'), null);
});

test('the owner\'s Allow resets it, signed as his: the approval spent first, and a body may run it here again', async () => {
  const { w, ap, lwake, localRunner } = setup();
  await deliver(w.env, lwake('alert:r', 'disk', null), w.o);
  const cv = cvOf('art', 'wake', 'alert:r');
  const target = `art:${cv}`;
  ap.allowed['a-00000001'] = { target, agent: 'art' };
  const r = allow(w.env, { id: 'a-00000001', agent: 'art', target });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /counts as your work now/);
  assert.deepEqual(ap.spent, ['a-00000001']);
  const c = loadConv(w.env, cv);
  assert.equal(resetSigned(deliveryDir(w.env), c), true);
  assert.equal(c.actsFor.resetApproval, 'a-00000001');
  assert.equal(c.resetAsk, undefined);
  // Spent once: the same Allow again changes nothing.
  assert.equal(allow(w.env, { id: 'a-00000001', agent: 'art', target }).ok, false);
  // A body on loom's machine may run it now: it's the owner's (localForeign, through seatMoved).
  assert.equal(seatMoved(w.env, { ...c, body: 'claude:x0000001' }), false);
});

test('an approval not allowed (pending, or denied: approvals refuses the spend) changes nothing', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('alert:d', 'disk', null), w.o);
  const cv = cvOf('art', 'wake', 'alert:d');
  const before = JSON.stringify(loadConv(w.env, cv).actsFor);
  const r = allow(w.env, { id: 'a-00000001', agent: 'art', target: `art:${cv}` });
  assert.equal(r.ok, false);
  assert.match(r.message, /Nothing changed/);
  assert.equal(JSON.stringify(loadConv(w.env, cv).actsFor), before);
  assert.deepEqual(ap.spent, []);
});

test('only the household owner\'s call applies it, for exactly its conversation and agent', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('alert:o', 'disk', null), w.o);
  const cv = cvOf('art', 'wake', 'alert:o');
  const target = `art:${cv}`;
  ap.allowed['a-00000001'] = { target, agent: 'art' };
  const before = JSON.stringify(loadConv(w.env, cv).actsFor);
  for (const caller of [{ kind: 'owner', who: 'loren', agents: ['art'] }, { kind: 'agent', agent: 'art' }, null]) {
    assert.equal(allow(w.env, { id: 'a-00000001', agent: 'art', target }, caller).ok, false, JSON.stringify(caller));
  }
  assert.equal(allow({ ...w.env, LOOM_SCOPE: 'art' }, { id: 'a-00000001', agent: 'art', target }).ok, false, 'an agent\'s tab');
  // Another agent's name on it, or another conversation: refused before anything is spent.
  assert.equal(allow(w.env, { id: 'a-00000001', agent: 'mark', target: `mark:${cv}` }).ok, false);
  assert.equal(allow(w.env, { id: 'a-00000001', agent: 'art', target: 'art:cv-0000000000ff' }).ok, false);
  // A malformed id, or more than one conversation: refused too.
  for (const t of ['art:cv-123', `art:${cv},${cv}`, `art:${cv.toUpperCase()}`, 'art:*', `art::${cv}`]) {
    assert.equal(allow(w.env, { id: 'a-00000001', agent: 'art', target: t }).ok, false, t);
  }
  assert.deepEqual(ap.spent, []);
  assert.equal(JSON.stringify(loadConv(w.env, cv).actsFor), before);
});

test('only what was waiting when he was asked counts as his; a person who wrote since keeps theirs, and is checked again', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('alert:p', 'disk', null), w.o);
  const cv = cvOf('art', 'wake', 'alert:p');
  const target = `art:${cv}`;
  // The card asked about what this refused start had taken: the wake that was refused.
  assert.equal(loadConv(w.env, cv).resetAsk.queued.length, 1);
  assert.equal(loadConv(w.env, cv).queue.some((q) => q.key === loadConv(w.env, cv).resetAsk.queued[0]), true);
  // After the card: a relay waits (unplaced, not counted), then Loren writes.
  await deliver(w.env, lwake('alert:p', 'later, no word', null), w.o);
  ap.allowed['a-00000001'] = { target, agent: 'art' };
  await deliver(w.env, w.msg('alert:p', 'is this mine?', { venue: 'wake', from: { kind: 'person', slug: 'loren' } }), w.o);
  const r = allow(w.env, { id: 'a-00000001', agent: 'art', target });
  assert.equal(r.ok, false);
  assert.match(r.message, /someone else has written there since/);
  assert.deepEqual(ap.spent, [], 'the owner\'s yes isn\'t spent');
});

test('only the rows shown on the card he allowed count as his: a relay not on it stays unknown; the terminal counts none', () => {
  const { w } = setup();
  const cv = 'cv-00000000000e';
  const dir = join(deliveryDir(w.env), 'conversations');
  mkdirSync(dir, { recursive: true });
  const k1 = { key: 'k1', from: { kind: 'schedule' }, kind: 'wake', wakeFor: '-', at: '2026-11-08T10:00:00Z' };
  const k2 = { key: 'k2', from: { kind: 'schedule' }, kind: 'wake', wakeFor: 'loren' };
  const relay = { key: 'k3', from: { kind: 'agent', id: 'mark' }, kind: 'message', at: '2026-11-08T10:01:00Z' };
  const c = { conversation: cv, agent: 'art', venue: 'wake', place: 'alert:t', local: true, actsFor: { owner: false, people: [], unknown: true }, queue: [k1, k2, relay] };
  // What a card lists: the unplaced wake and the relay, in words; never Loren's wake.
  assert.deepEqual(shownRows(c.queue).map((r) => r.key), ['k1', 'k3']);
  assert.match(shownRows(c.queue)[1].words, /^a relay from Mark/);
  // When each arrived, in the household's time zone and saying which (t-2008: a bare UTC time read as hours off).
  assert.equal(shownRows(c.queue, { LOOM_RUNTIME_TZ: 'America/Chicago' })[0].words, 'a wake set by work loom couldn\'t say was yours (Sun, Nov 8, 4:00 AM CST)');
  // The clock saying nothing (a failed hand-over) reads differently from its word that the wake is no one's (t-2009).
  assert.match(shownRows([{ ...k1, noWord: true }])[0].words, /^a wake the clock said nothing about \(/);
  assert.match(shownRows(c.queue)[1].words, /\(Sun, Nov 8, 10:01 AM UTC\)$/);
  assert.match(shownRows([{ ...relay, at: undefined }])[0].words, /\(time unknown\)$/);
  // The card showed only k1: k1 is his, the relay (not shown) leaves it unknown, Loren's wake is hers.
  // (Loren's wake was noted as hers when it queued: then she's named, and no reset counts it as his.)
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify({ ...c, actsFor: { ...c.actsFor, people: ['loren'] }, resetAsk: { at: 'x', queued: ['k1'], approval: 'a-00000001' } }));
  assert.equal(resetPrincipal(w.env, cv, { agent: 'art', approval: 'a-00000001' }).ok, false, 'Loren is named: not only his to count');
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify({ ...c, queue: [k1, relay], resetAsk: { at: 'x', queued: ['k1'], approval: 'a-00000001' } }));
  assert.equal(resetPrincipal(w.env, cv, { agent: 'art', approval: 'a-00000001' }).ok, true);
  const a = loadConv(w.env, cv).actsFor;
  assert.equal(a.owner, true, 'the shown wake: his');
  assert.equal(a.unknown, true, 'the relay not on the card: unknown');
  // Shown on the card: the relay is his too.
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify({ ...c, queue: [k1, relay], resetAsk: { at: 'x', queued: ['k1', 'k3'], approval: 'a-00000001' } }));
  assert.equal(resetPrincipal(w.env, cv, { agent: 'art', approval: 'a-00000001' }).ok, true);
  assert.equal(loadConv(w.env, cv).actsFor.unknown, false);
  // Typed at a terminal: nothing waiting is counted (as before): the waiting wake leaves it unknown.
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify({ ...c, queue: [k1] }));
  assert.equal(resetPrincipal(w.env, cv).ok, true);
  assert.equal(loadConv(w.env, cv).actsFor.unknown, true);
});

test('two drains of one conversation file one card: reserved before it is filed', async () => {
  const { w, ap } = setup();
  const cv = 'cv-00000000000f';
  const dir = join(deliveryDir(w.env), 'conversations');
  mkdirSync(dir, { recursive: true });
  const c = { conversation: cv, agent: 'art', venue: 'wake', place: 'alert:u', local: true, actsFor: { owner: false, people: [], unknown: true }, queue: [] };
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify(c));
  // A second drain arriving while the first is filing (inside its request): it finds the reservation and files nothing.
  let inner;
  ap.onRequest = () => { ap.onRequest = null; inner = askOwnerReset(w.env, c); };
  assert.equal(await askOwnerReset(w.env, c), 'a-00000001');
  assert.equal(await inner, null);
  assert.equal(await askOwnerReset(w.env, c), null);
  assert.equal(ap.filed.length, 1);
  // The owner's own conversation that an unplaced voice wedged is asked about too (he's named, no one else is).
  const c2 = { ...c, conversation: 'cv-000000000010', actsFor: { owner: true, owners: ['jonathan'], people: [], unknown: true } };
  writeFileSync(join(dir, 'cv-000000000010.json'), JSON.stringify(c2));
  assert.equal(await askOwnerReset(w.env, c2), 'a-00000002');
});

test('the real calls: the card filed and the approval spent with the approvals piece\'s exact argv, never the store grant', async () => {
  const { w } = setup();
  const env = { ...w.env, LOOM_STORE_GRANT: 'abc.def' };
  delete env.LOOM_RUNTIME_TEST_APPROVALS;
  const bin = join(env.HOME, 'fake-loom');
  const log = join(env.HOME, 'loom-argv');
  writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs');\nconst a = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ a, grant: process.env.LOOM_STORE_GRANT || null }) + '\\n');\n`
    + `if (a[1] === 'request') console.log('a-0000abcd: asked the owner (a card on loom\\'s Home)');\nelse if (a[1] === 'use') console.log(a[2] + ': used');\nelse process.exit(1);\n`);
  chmodSync(bin, 0o755);
  env.LOOM_BIN = bin;
  const cv = 'cv-000000000011';
  const dir = join(deliveryDir(env), 'conversations');
  mkdirSync(dir, { recursive: true });
  const c = { conversation: cv, agent: 'art', venue: 'wake', place: 'alert:v', label: 'Disk alert', local: true, actsFor: { owner: false, people: [], unknown: true }, queue: [] };
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify(c));
  assert.equal(await askOwnerReset(env, c), 'a-0000abcd');
  assert.equal(allow(env, { id: 'a-0000abcd', agent: 'art', target: `art:${cv}` }).ok, true);
  const [filed, spent] = readFileSync(log, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const flag = (a, f) => a[a.indexOf(f) + 1];
  assert.deepEqual(filed.a.slice(0, 2), ['approvals', 'request']);
  assert.equal(flag(filed.a, '--kind'), 'principal-reset');
  assert.equal(flag(filed.a, '--target'), `art:${cv}`);
  assert.equal(flag(filed.a, '--on-behalf'), 'owner');
  assert.equal(flag(filed.a, '--as'), JSON.stringify({ kind: 'agent', agent: 'art', house: 'loom\'s runtime' }), 'approvals spends it from the plain caller (its test pins that)');
  assert.match(flag(filed.a, '--details'), /Disk alert/);
  for (const f of ['--ask', '--why', '--if-yes', '--if-no']) assert.ok(flag(filed.a, f), f);
  // Spent as it was filed (the same --as), on the owner's behalf; approvals' own test pins that it's spendable so.
  assert.deepEqual(spent.a, ['approvals', 'use', 'a-0000abcd', '--kind', 'principal-reset', '--target', `art:${cv}`, '--as', runtimeAs('art'), '--on-behalf', 'owner']);
  assert.equal(filed.grant, null);
  assert.equal(spent.grant, null);
});

test('a conversation walled off in a house of its own still runs, and isn\'t asked about', async () => {
  const { w, ap } = setup();
  const r = await deliver(w.env, w.msg('dm:R', 'from mark', { from: { kind: 'agent', id: 'mark' } }), w.o);
  assert.equal(r.body, 'started', JSON.stringify(r));
  assert.equal(loadConv(w.env, r.conversation).bodyRules.seat.startsWith('u-'), true);
  assert.equal(ap.filed.length, 0);
});

test('a card from before a typed reset is out of date: the typed reset takes it back, and its Allow changes nothing', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('alert:s', 'disk', null), w.o);
  const cv = cvOf('art', 'wake', 'alert:s');
  assert.equal(resetPrincipal(w.env, cv).ok, true);
  assert.deepEqual(ap.withdrawn, ['a-00000001']);
  ap.allowed['a-00000001'] = { target: `art:${cv}`, agent: 'art' };
  const r = allow(w.env, { id: 'a-00000001', agent: 'art', target: `art:${cv}` });
  assert.equal(r.ok, false);
  assert.match(r.message, /out of date/);
  assert.deepEqual(ap.spent, []);
});

test('the refusal says the owner is asked only when a card is out', async () => {
  const { w, lwake } = setup();
  await deliver(w.env, lwake('alert:m', 'one', 'owner'), w.o);
  await deliver(w.env, w.msg('alert:m', 'mine?', { venue: 'wake', from: { kind: 'person', slug: 'loren' } }), w.o);
  const c = loadConv(w.env, cvOf('art', 'wake', 'alert:m'));
  assert.equal(c.resetAsk, undefined);
  assert.equal(JSON.stringify(c).includes('asked on loom\'s page'), false);
});

test('a wake queued before rows kept the clock\'s word is never counted as the owner\'s', () => {
  const { w } = setup();
  const cv = 'cv-000000000012';
  const dir = join(deliveryDir(w.env), 'conversations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify({ conversation: cv, agent: 'art', venue: 'wake', place: 'alert:old', local: true,
    actsFor: { owner: false, people: [], unknown: true }, queue: [{ key: 'k1', from: { kind: 'schedule' }, kind: 'wake' }] }));
  assert.equal(resetPrincipal(w.env, cv).ok, true);
  assert.equal(loadConv(w.env, cv).actsFor.unknown, true);
});

test('the runtime refuses another agent\'s conversation itself, whatever approvals would let be spent', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('alert:x', 'disk', null), w.o);
  const cv = cvOf('art', 'wake', 'alert:x');
  // An approvals piece that would spend it for Mark, for Art's conversation: the runtime refuses first.
  ap.allowed['a-00000001'] = { target: `mark:${cv}`, agent: 'mark' };
  const r = allow(w.env, { id: 'a-00000001', agent: 'mark', target: `mark:${cv}` });
  assert.equal(r.ok, false);
  assert.match(r.message, /no conversation/);
  assert.deepEqual(ap.spent, []);
});

test('an Allow after something unplaced arrived says so, never a plain done', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('alert:y', 'disk', null), w.o);
  const cv = cvOf('art', 'wake', 'alert:y');
  await deliver(w.env, w.msg('alert:y', 'from mark', { venue: 'wake', from: { kind: 'agent', id: 'mark' } }), w.o);
  ap.allowed['a-00000001'] = { target: `art:${cv}`, agent: 'art' };
  const r = allow(w.env, { id: 'a-00000001', agent: 'art', target: `art:${cv}` });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /arrived there since/);
});

test('an agent another member owns is theirs: the household owner isn\'t asked to count its conversation as his', async () => {
  const { w, ap, lwake } = setup();
  writeFileSync(join(w.env.HOME, '.config', 'loom', 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'],
    members: [{ person: 'jonathan', agents: '*' }, { person: 'loren', agents: ['art'] }] }));
  await deliver(w.env, lwake('alert:l2', 'disk', null), w.o);
  assert.equal(ap.filed.length, 0);
});

test('no answer in time from the approvals piece keeps the reservation: never a second card', async () => {
  const { w } = setup();
  const env = { ...w.env };
  delete env.LOOM_RUNTIME_TEST_APPROVALS;
  const bin = join(env.HOME, 'slow-loom');
  writeFileSync(bin, `#!${process.execPath}\nsetTimeout(() => {}, 20000);\n`);
  chmodSync(bin, 0o755);
  env.LOOM_BIN = bin;
  const cv = 'cv-000000000013';
  const dir = join(deliveryDir(env), 'conversations');
  mkdirSync(dir, { recursive: true });
  const c = { conversation: cv, agent: 'art', venue: 'wake', place: 'alert:z', local: true, actsFor: { owner: false, people: [], unknown: true }, queue: [] };
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify(c));
  assert.equal(await askOwnerReset(env, c, () => {}), null);
  assert.ok(loadConv(env, cv).resetAsk, 'kept: it may be filed');
  assert.equal(await askOwnerReset(env, c, () => {}), null);
  // Ten minutes on with no card behind it: tried again (approvals answers the same card for the same target).
  const stale = loadConv(env, cv);
  stale.resetAsk.at = new Date(Date.now() - 11 * 60_000).toISOString();
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify(stale));
  const ok = join(env.HOME, 'ok-loom');
  writeFileSync(ok, `#!${process.execPath}\nconsole.log('a-0000abcd: asked the owner');\n`);
  chmodSync(ok, 0o755);
  assert.equal(await askOwnerReset({ ...env, LOOM_BIN: ok }, c, () => {}), 'a-0000abcd');
});

test('the reset re-checks under its own lock: a card that changed, or someone who wrote, after the check resets nothing', () => {
  const { w } = setup();
  const cv = 'cv-000000000014';
  const dir = join(deliveryDir(w.env), 'conversations');
  mkdirSync(dir, { recursive: true });
  const c = { conversation: cv, agent: 'art', venue: 'wake', place: 'alert:r2', local: true, actsFor: { owner: false, people: [], unknown: true }, queue: [],
    resetAsk: { at: 'x', queued: [], approval: 'a-00000002' } };
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify(c));
  assert.equal(resetPrincipal(w.env, cv, { agent: 'art', approval: 'a-00000001' }).ok, false);
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify({ ...c, actsFor: { ...c.actsFor, people: ['loren'] }, resetAsk: { ...c.resetAsk, approval: 'a-00000001' } }));
  assert.equal(resetPrincipal(w.env, cv, { agent: 'art', approval: 'a-00000001' }).ok, false);
  assert.equal(resetPrincipal(w.env, cv, { agent: 'mark', approval: 'a-00000001' }).ok, false);
  assert.equal(loadConv(w.env, cv).actsFor.reset, undefined, 'nothing reset');
});

test('reset-approved is never a body\'s: refused from a body\'s environment before anything is spent', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('alert:b', 'disk', null), w.o);
  const cv = cvOf('art', 'wake', 'alert:b');
  ap.allowed['a-00000001'] = { target: `art:${cv}`, agent: 'art' };
  for (const k of ['HOUSE_ID', 'LOOM_BODY_KEY', 'LOOM_BODY_CONVERSATION']) {
    assert.equal(allow({ ...w.env, [k]: 'x' }, { id: 'a-00000001', agent: 'art', target: `art:${cv}` }).ok, false, k);
  }
  assert.deepEqual(ap.spent, []);
});

test('a person\'s message is never listed or counted, even if its key were', () => {
  const { w } = setup();
  const p = { key: 'kp', from: { kind: 'person', slug: 'loren' }, kind: 'message' };
  assert.deepEqual(shownRows([p]), []);
  const cv = 'cv-000000000015';
  const dir = join(deliveryDir(w.env), 'conversations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify({ conversation: cv, agent: 'art', venue: 'wake', place: 'alert:pp', local: true,
    actsFor: { owner: false, people: [], unknown: true }, queue: [p], resetAsk: { at: 'x', queued: ['kp'], approval: 'a-00000001' } }));
  assert.equal(resetPrincipal(w.env, cv, { agent: 'art', approval: 'a-00000001' }).ok, true);
  assert.deepEqual(loadConv(w.env, cv).actsFor.people, ['loren']);
  assert.equal(loadConv(w.env, cv).actsFor.owner, false);
});

test('while the owner is asked, its messages wait for him (never failed), and his Allow lets them run', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('alert:h', 'disk', null), w.o);
  const cv = cvOf('art', 'wake', 'alert:h');
  let c = loadConv(w.env, cv);
  assert.equal(c.queue.length, 1, 'the refused wake waits');
  assert.match(c.waiting, /asked on loom's page/);
  const { tick } = await import('../src/delivery.mjs');
  await tick(w.env, w.o);
  c = loadConv(w.env, cv);
  assert.equal(c.queue.length, 1, 'still waiting after a tick, not failed');
  assert.notEqual(c.outcomes?.[c.queue[0].key]?.body, 'failed');
  ap.allowed['a-00000001'] = { target: `art:${cv}`, agent: 'art' };
  assert.equal(allow(w.env, { id: 'a-00000001', agent: 'art', target: `art:${cv}` }).ok, true);
  assert.equal(seatMoved(w.env, { ...loadConv(w.env, cv), body: 'claude:x0000001' }), false, 'his now: a body may start for it');
});

test('a retry after no answer keeps what the first filing listed: never widened', async () => {
  const { w } = setup();
  const env = { ...w.env };
  delete env.LOOM_RUNTIME_TEST_APPROVALS;
  const slow = join(env.HOME, 'slow-loom2');
  writeFileSync(slow, `#!${process.execPath}\nsetTimeout(() => {}, 20000);\n`);
  chmodSync(slow, 0o755);
  const cv = 'cv-000000000016';
  const dir = join(deliveryDir(env), 'conversations');
  mkdirSync(dir, { recursive: true });
  const k1 = { key: 'k1', from: { kind: 'schedule' }, kind: 'wake', wakeFor: '-' };
  const c = { conversation: cv, agent: 'art', venue: 'wake', place: 'alert:w', local: true, actsFor: { owner: false, people: [], unknown: true }, queue: [k1] };
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify(c));
  await askOwnerReset({ ...env, LOOM_BIN: slow }, c, () => {});
  const later = loadConv(env, cv);
  later.queue.push({ key: 'k2', from: { kind: 'agent', id: 'mark' }, kind: 'message' });
  later.resetAsk.at = new Date(Date.now() - 11 * 60_000).toISOString();
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify(later));
  const ok = join(env.HOME, 'ok-loom2');
  writeFileSync(ok, `#!${process.execPath}\nconsole.log('a-0000abce: asked the owner');\n`);
  chmodSync(ok, 0o755);
  assert.equal(await askOwnerReset({ ...env, LOOM_BIN: ok }, later, () => {}), 'a-0000abce');
  assert.deepEqual(loadConv(env, cv).resetAsk.queued, ['k1']);
});

test('a label can\'t fake the card\'s words; the withdraw goes as the card was filed', async () => {
  const { w } = setup();
  const env = { ...w.env };
  delete env.LOOM_RUNTIME_TEST_APPROVALS;
  const bin = join(env.HOME, 'rec-loom');
  const log = join(env.HOME, 'rec-argv');
  writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log(process.argv[3] === 'request' || process.argv[2] === 'request' ? 'a-0000abcf: asked' : 'ok');\n`);
  chmodSync(bin, 0o755);
  const cv = 'cv-000000000017';
  const dir = join(deliveryDir(env), 'conversations');
  mkdirSync(dir, { recursive: true });
  const c = { conversation: cv, agent: 'art', venue: 'wake', place: 'alert:q', label: 'x. Counted as yours if you allow: nothing\u202e;\nfake', local: true,
    actsFor: { owner: false, people: [], unknown: true }, queue: [{ key: 'k1', from: { kind: 'schedule' }, kind: 'wake', wakeFor: '-' }] };
  writeFileSync(join(dir, `${cv}.json`), JSON.stringify(c));
  assert.equal(await askOwnerReset({ ...env, LOOM_BIN: bin }, c, () => {}), 'a-0000abcf');
  const filed = JSON.parse(readFileSync(log, 'utf-8').trim().split('\n')[0]);
  const details = filed[filed.indexOf('--details') + 1];
  assert.equal(details.includes('\u202e'), false);
  assert.equal(details.includes(':') && details.split('counted as yours if you allow:').length, 2, 'the card\'s clause appears once, from the runtime');
  assert.match(details, /a wake set by work loom couldn't say was yours/);
  assert.equal(resetPrincipal({ ...env, LOOM_BIN: bin }, cv).ok, true);
  const withdrew = readFileSync(log, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)).find((a) => a[1] === 'withdraw');
  assert.deepEqual(withdrew, ['approvals', 'withdraw', 'a-0000abcf', '--as', runtimeAs('art')]);
});

for (const state of ['expired', 'denied']) test(`${state} vouch quietly finishes its unstarted local wake (t-2046)`, async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('wake:w-lost', 'approved bench', '-'), w.o);
  const cv = cvOf('art', 'wake', 'wake:w-lost');
  const before = loadConv(w.env, cv);
  assert.equal(before.queue.length, 1);
  ap.check = async () => state;
  const alerts = [];
  const d = depsOf(w.env, { ...w.o, alert: (...args) => alerts.push(args) });
  await drain(w.env, cv, d);
  const after = loadConv(w.env, cv);
  assert.equal(after.queue.length, 0);
  assert.equal(after.waiting, undefined);
  assert.equal(after.runs, 0);
  assert.equal(after.body, undefined);
  assert.deepEqual(after.actsFor, before.actsFor);
  assert.equal(after.outcomes[before.queue[0].key].body, 'failed');
  assert.match(after.outcomes[before.queue[0].key].reason, /not run: nobody vouched for it/);
  assert.deepEqual(conversationJobs(w.env, d), []);
  assert.deepEqual(alerts, []);
  assert.deepEqual(deliveryNotices(w.env, w.clock.now().getTime()), []);
  await drain(w.env, cv, d);
  assert.equal(loadConv(w.env, cv).queue.length, 0);
});

for (const state of ['pending', 'allowed', 'used', 'unreadable']) test(`${state} vouch never discards the wake`, async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('wake:w-keep', 'bench', '-'), w.o);
  const cv = cvOf('art', 'wake', 'wake:w-keep');
  ap.check = async () => { if (state === 'unreadable') throw new Error('offline'); return state; };
  await drain(w.env, cv, depsOf(w.env, w.o));
  assert.equal(loadConv(w.env, cv).queue.length, 1);
});

test('a reset racing the vouch read keeps the wake for the allowed body', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('wake:w-race', 'bench', '-'), w.o);
  const cv = cvOf('art', 'wake', 'wake:w-race');
  ap.allowed['a-00000001'] = { target: `art:${cv}`, agent: 'art' };
  ap.check = async () => { assert.equal(allow(w.env, { id: 'a-00000001', agent: 'art', target: `art:${cv}` }).ok, true); return 'expired'; };
  await drain(w.env, cv, depsOf(w.env, w.o));
  assert.equal(loadConv(w.env, cv).runs, 1);
});

test('terminal vouch drops only the scheduled wake shown, preserving later messages', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('wake:w-later', 'bench', '-'), w.o);
  const cv = cvOf('art', 'wake', 'wake:w-later');
  await deliver(w.env, w.msg('wake:w-later', 'later', { venue: 'wake', from: { kind: 'person', slug: 'loren' } }), w.o);
  const c = loadConv(w.env, cv);
  ap.check = async () => 'denied';
  await drain(w.env, cv, depsOf(w.env, w.o));
  const after = loadConv(w.env, cv);
  assert.equal(after.queue.some(x => x.key === c.queue.find(x => x.from.kind === 'schedule').key), false);
  assert.deepEqual(after.actsFor, c.actsFor);
  assert.equal(after.queue.some(x => x.key === c.queue.find(x => x.from.kind === 'person').key), true);
  assert.equal(after.runs, 0);
});

test('a new wake after the terminal queue finished can ask on its own card', async () => {
  const { w, ap, lwake } = setup();
  const cv = cvOf('art', 'wake', 'wake:w-new');
  await deliver(w.env, lwake('wake:w-new', 'first', '-'), w.o);
  ap.check = async () => 'expired';
  await drain(w.env, cv, depsOf(w.env, w.o));
  assert.equal(loadConv(w.env, cv).resetAsk, undefined);
  await deliver(w.env, lwake('wake:w-new', 'second', '-'), w.o);
  assert.equal(loadConv(w.env, cv).resetAsk.approval, 'a-00000002');
  assert.equal(loadConv(w.env, cv).queue.length, 1);
});

test('terminal vouch reads the real approvals CLI as the filing agent, without a store grant', async () => {
  const { w, lwake } = setup();
  await deliver(w.env, lwake('wake:w-cli', 'bench', '-'), w.o);
  const cv = cvOf('art', 'wake', 'wake:w-cli');
  const bin = join(w.env.HOME, 'check-loom');
  const log = join(w.env.HOME, 'check-argv');
  writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2),grant:process.env.LOOM_STORE_GRANT ?? null}));\nconsole.log('expired');\n`);
  chmodSync(bin, 0o755);
  const env = { ...w.env, LOOM_BIN: bin, LOOM_STORE_GRANT: 'private-grant' };
  delete env.LOOM_RUNTIME_TEST_APPROVALS;
  await drain(env, cv, depsOf(env, w.o));
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), { argv: ['approvals', 'check', 'a-00000001', '--as', runtimeAs('art')], grant: null });
  assert.equal(loadConv(env, cv).queue.length, 0);
});

test('a leftover runtime note does not retain the expired card', async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('wake:w-note', 'first', '-'), w.o);
  const cv = cvOf('art', 'wake', 'wake:w-note');
  const c = loadConv(w.env, cv);
  c.queue.push({ key: 'note-000000000001', note: true });
  writeFileSync(join(deliveryDir(w.env), 'conversations', `${cv}.json`), JSON.stringify(c));
  ap.check = async () => 'expired';
  await drain(w.env, cv, depsOf(w.env, w.o));
  assert.equal(loadConv(w.env, cv).resetAsk, undefined);
  assert.equal(loadConv(w.env, cv).queue.length, 0);
  assert.deepEqual(conversationJobs(w.env, depsOf(w.env, w.o)), []);
  assert.deepEqual(deliveryNotices(w.env, w.clock.now().getTime()), []);
});

for (const gate of ['control', 'retiring', 'paused']) test(`vouch cleanup respects ${gate} set while the card is read`, async () => {
  const { w, ap, lwake } = setup();
  await deliver(w.env, lwake('wake:w-held', 'bench', '-'), w.o);
  const cv = cvOf('art', 'wake', 'wake:w-held');
  ap.check = async () => {
    const c = loadConv(w.env, cv);
    c[gate] = { state: 'held', reason: 'held' };
    writeFileSync(join(deliveryDir(w.env), 'conversations', `${cv}.json`), JSON.stringify(c));
    return 'expired';
  };
  await drain(w.env, cv, depsOf(w.env, w.o));
  assert.equal(loadConv(w.env, cv).queue.length, 1);
});
