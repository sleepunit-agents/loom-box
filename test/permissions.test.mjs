// Permissions (loom docs/specs/agent-runtime.md, section 6): the runtime as the grants authority, and the gates moved
// in from shuttle. Spec test 9 (gates migration) is the "import" describe; test 5's core half is in loom's suite
// (src/grants.integration.test.ts), and its runtime half (the ask's answers) is here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ask, decide, GRANTS, KEY, paired, seed, seedDoc, setPiece, currentLists } from '../src/grants.mjs';
import { answer, asks, annotate, exportGates, followMerge, gatesOf, GATES, importGates, mergePeople, ownersRunOf, parseExport, propose, PROPOSALS, renamed, seen, status } from '../src/gates.mjs';
import { loomStore, memStore } from '../src/store.mjs';
import { runFor } from '../src/gates-api.mjs';
import { grantIn } from '../src/perms-cli.mjs';

// ---------------------------------------------------------------- grants

function household(pieces) {
  const home = mkdtempSync(join(tmpdir(), 'rt-grants-'));
  for (const [name, { settings = [], values = {} }] of Object.entries(pieces)) {
    mkdirSync(join(home, 'pieces', name), { recursive: true });
    writeFileSync(join(home, 'pieces', name, 'piece.json'), JSON.stringify({ name, loom: { settings } }));
    writeFileSync(join(home, 'pieces', name, 'settings.json'), JSON.stringify(values));
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], relay: { art: ['mark'], mark: ['art'] } }));
  return home;
}

const PIECES = [
  { name: 'tasks', managed: {} }, { name: 'clock', managed: {} }, { name: 'shuttle', managed: {} }, { name: 'machine', managed: {} },
  { name: 'runtime', managed: {} }, { name: 'box', managed: { partOf: 'runtime' } }, { name: 'now', path: '/usr/local/bin/loom-now' },
];
const HOUSEHOLD = {
  tasks: { settings: [{ name: 'TASKSTORE_AGENTS' }], values: { TASKSTORE_AGENTS: 'art' } },
  clock: { settings: [{ name: 'WAKE_AGENTS' }, { name: 'WAKE_REPO' }], values: { WAKE_AGENTS: 'art,mark' } },
  shuttle: { settings: [{ name: 'SHUTTLE_INSTANCE' }] },
  machine: { settings: [{ name: 'MACHINE_AGENTS', default: 'art' }] },
  runtime: { settings: [{ name: 'LOOM_RUNTIME_LOOM_URL' }] },
};

describe('the seed: today\'s lists, so nothing that works stops working', () => {
  test('each piece\'s own *_AGENTS list (its value, else its default); every agent for a piece with none, or on PATH', () => {
    const home = household(HOUSEHOLD);
    try {
      const lists = currentLists({ LOOM_HOME: home }, { pieces: PIECES });
      assert.deepEqual(Object.fromEntries(Object.entries(lists).map(([p, l]) => [p, l.agents])), {
        tasks: ['art'], clock: ['art', 'mark'], shuttle: '*', machine: ['art'], runtime: '*', box: '*', now: '*',
      });
      const doc = seedDoc({ LOOM_HOME: home }, { pieces: PIECES, now: new Date('2026-11-02T00:00:00Z') });
      assert.deepEqual(doc.pieces.tasks, { art: ['*'] });
      assert.deepEqual(doc.pieces.shuttle, { '*': ['*'] });
      assert.deepEqual(doc.relay, { art: ['mark'], mark: ['art'] });
      assert.equal(doc.seeded.from.clock, 'WAKE_AGENTS=art,mark');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('every call allowed today is allowed after the seed, for every agent, piece and path', () => {
    const home = household(HOUSEHOLD);
    try {
      const doc = seedDoc({ LOOM_HOME: home }, { pieces: PIECES });
      const today = { tasks: ['art'], clock: ['art', 'mark'], machine: ['art'] };
      for (const p of PIECES) for (const agent of ['art', 'mark']) for (const path of ['run', 'people/x', 'deliver', 'render', '']) {
        const before = !today[p.name] || today[p.name].includes(agent);
        assert.equal(decide(doc, { agent, piece: p.name, path }).allow, before, `${agent} ${p.name} ${path}`);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('seed writes once; --force replaces; a write core refuses (not the owner) says so', () => {
    const home = household(HOUSEHOLD);
    try {
      const st = memStore();
      assert.equal(seed({ LOOM_HOME: home }, st, { pieces: PIECES }).written, true);
      assert.throws(() => seed({ LOOM_HOME: home }, st, { pieces: PIECES }), /already has grants/);
      assert.equal(seed({ LOOM_HOME: home }, st, { pieces: PIECES, force: true }).rev, 2);
      const locked = memStore({ writable: (c) => c !== GRANTS });
      assert.throws(() => seed({ LOOM_HOME: home }, locked, { pieces: PIECES }), /the grants are the owner's/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('the ask (the `grants` offer core runs)', () => {
  const doc = { v: 1, pieces: { tasks: { art: ['*'] }, shuttle: { '*': ['people', 'routes'] }, clock: { mark: ['run', 'wakes/*'] } }, relay: { art: ['mark'] } };

  test('no grants yet: every ask is allowed, the pieces decide as before', () => {
    assert.deepEqual(ask(memStore(), JSON.stringify({ agent: 'mark', piece: 'tasks', path: 'run' })), { allow: true });
  });

  test('a grant allows; no grant is a refusal that says why', () => {
    assert.deepEqual(decide(doc, { agent: 'art', piece: 'tasks', path: 'run' }), { allow: true });
    assert.match(decide(doc, { agent: 'mark', piece: 'tasks', path: 'run' }).reason, /mark isn't granted tasks/);
    assert.match(decide(doc, { agent: 'art', piece: 'approvals', path: 'run' }).reason, /no agent is granted approvals/);
  });

  test('paths: *, exact, a prefix ending in /*; * for every agent', () => {
    assert.equal(decide(doc, { agent: 'mark', piece: 'shuttle', path: 'people' }).allow, true);
    assert.equal(decide(doc, { agent: 'art', piece: 'shuttle', path: 'routes' }).allow, true);
    assert.match(decide(doc, { agent: 'art', piece: 'shuttle', path: 'run' }).reason, /granted shuttle for people, routes, not run/);
    assert.equal(decide(doc, { agent: 'mark', piece: 'clock', path: 'wakes/w-1' }).allow, true);
    assert.equal(decide(doc, { agent: 'mark', piece: 'clock', path: 'wakesx' }).allow, false);
  });

  test('an unreadable document refuses everything (never guesses); a bad ask is refused', () => {
    assert.match(decide({ v: 2, pieces: {} }, { agent: 'art', piece: 'tasks', path: 'run' }).reason, /can't be read/);
    assert.match(ask(memStore(), 'nope').reason, /isn't JSON/);
    assert.match(decide(doc, { agent: 'art' }).reason, /\{agent, piece, path\}/);
  });

  test('a store that can\'t be read throws: the CLI exits 1, and core fails closed (503)', () => {
    const broken = { get() { throw new Error('loom store: no answer'); } };
    assert.throws(() => ask(broken, JSON.stringify({ agent: 'art', piece: 'tasks', path: 'run' })), /no answer/);
  });

  test('a piece\'s grant set by the owner; pairing from the grants only, never household.json', () => {
    const st = memStore();
    st.put(GRANTS, KEY, doc);
    setPiece(st, { piece: 'approvals', agents: ['art'], paths: ['*'] });
    assert.equal(decide(st.get(GRANTS, KEY).doc, { agent: 'art', piece: 'approvals', path: 'run' }).allow, true);
    setPiece(st, { piece: 'approvals', agents: [] });
    assert.equal(decide(st.get(GRANTS, KEY).doc, { agent: 'art', piece: 'approvals', path: 'run' }).allow, false);
    assert.equal(paired(doc, 'mark', 'art'), false);
    assert.equal(paired(null, 'mark', 'art'), false);
    assert.equal(paired({ ...doc, relay: { mark: ['art'] } }, 'mark', 'art'), true);
  });
});

// ---------------------------------------------------------------- gates

const ART_DOC = {
  _comment: 'who is who', _updated: '2026-11-01',
  people: {
    jonathan: { name: 'Jonathan', tier: 3, discord: ['111'], slack: { T1: ['U1'] } },
    grace: { name: 'Grace Aquino', role: 'toxicologist', tier: 2, slack: { T1: ['U8'] }, grant: ['pond'] },
  },
  agents: { mark: { name: 'Mark', kind: 'agent', discord: ['222'] } },
};
const MARK_DOC = { people: { jonathan: { name: 'Jonathan', tier: 3, discord: ['111'] } }, agents: {} };
const EXPORT = JSON.stringify({ v: 1, from: 'shuttle', agents: { art: { doc: ART_DOC, rev: 2 }, mark: { doc: MARK_DOC, rev: 2 } } });

/** A core whose people are `cards` ({slug: {name, ids: ['slack U1', ...]}}); ensure answers as loom's does, dry or not. */
function fakeCore({ fail = {}, cards = { jonathan: { name: 'Jonathan', ids: ['slack U1', 'discord 111'] } } } = {}) {
  const calls = [];
  return {
    calls,
    cards,
    async ensure(b) {
      calls.push([b.dry_run ? 'dry' : 'ensure', b]);
      if (fail.ensure) throw new Error(fail.ensure);
      const ids = Object.entries(b.where ?? {}).flatMap(([f, e]) => [].concat(e.value).map((v) => `${f} ${v}`));
      const card = cards[b.slug];
      if (!card) { if (!b.dry_run) cards[b.slug] = { name: b.name, ids }; return { slug: b.slug, created: true, added: {}, unchanged: false, card: { name: b.name } }; }
      const missing = ids.filter((x) => !card.ids.includes(x));
      if (!b.dry_run) card.ids.push(...missing);
      const added = {};
      for (const m of missing) { const [f, v] = m.split(' '); (added[f] ??= []).push(v); }
      return { slug: b.slug, created: false, added, unchanged: !missing.length, card: { name: card.name } };
    },
    async merge(b) { calls.push(['merge', b]); if (fail.merge) throw new Error(fail.merge); return { ok: true }; },
    async deliver(b) { calls.push(['deliver', b]); if (fail.deliver) throw new Error(fail.deliver); return { conversation: 'cv-0123456789ab', seq: 1, body: 'started' }; },
  };
}

describe('spec test 9: the gates migration', () => {
  test('a stub shuttle\'s export, imported, gives the runtime\'s collection entry for entry; every person gets a card ensured', async () => {
    const st = memStore();
    const core = fakeCore();
    const r = await importGates(st, core, EXPORT, { owner: true });
    assert.deepEqual(r.agents, { art: 'imported', mark: 'imported' });
    assert.deepEqual(gatesOf(st, 'art').doc, ART_DOC);
    assert.deepEqual(gatesOf(st, 'mark').doc, MARK_DOC);
    assert.deepEqual(exportGates(st).agents.art.doc, ART_DOC);
    const ensured = core.calls.filter(([k]) => k === 'ensure').map(([, b]) => [b.agent, b.slug]);
    assert.deepEqual(ensured, [['art', 'jonathan'], ['art', 'grace'], ['mark', 'jonathan']]);
    // A card carries who they are and where, never what gates (tier, grant).
    const grace = core.calls.find(([, b]) => b.slug === 'grace')[1];
    assert.deepEqual(grace.where, { slack: { value: 'U8' } });
    assert.equal(grace.role, 'toxicologist');
    assert.equal('tier' in grace || 'grant' in grace, false);
    assert.match(r.cards, /person cards: 1 made, 2 already there|person cards: 2 made, 1 already there/);
  });

  test('the import refuses anything but an owner\'s run: a house, a granted agent call, no grant, and core\'s own refusal', async () => {
    assert.match(String(ownersRunOf({ HOUSE_ID: 'h-1', LOOM_STORE_GRANT: 'x.y' })), /a house/);
    assert.match(String(ownersRunOf({ LOOM_URL: 'http://x', LOOM_TOKEN_FILE: '/t', LOOM_STORE_GRANT: 'x.y' })), /a house/);
    assert.match(String(ownersRunOf({})), /no owner's grant/);
    const agentGrant = `${Buffer.from(JSON.stringify({ piece: 'runtime', agent: 'art' })).toString('base64url')}.mac`;
    assert.match(String(ownersRunOf({ LOOM_STORE_GRANT: agentGrant }, grantIn({ LOOM_STORE_GRANT: agentGrant }))), /for an agent/);
    const ownerGrant = `${Buffer.from(JSON.stringify({ piece: 'runtime', owner: true })).toString('base64url')}.mac`;
    assert.equal(ownersRunOf({ LOOM_STORE_GRANT: ownerGrant }, grantIn({ LOOM_STORE_GRANT: ownerGrant })), true);
    const st = memStore();
    await assert.rejects(importGates(st, fakeCore(), EXPORT, { owner: 'a house' }), /the owner's run only/);
    assert.equal(st.docs.size, 0);
    // Even past the CLI's check, core refuses a write to the owner-written collection without the owner's grant.
    await assert.rejects(importGates(memStore({ writable: (c) => c !== GATES }), fakeCore(), EXPORT, { owner: true }), /core refused the write/);
  });

  test('it never reads another piece\'s store: every store call is the runtime\'s own', async () => {
    const seenArgv = [];
    const docs = new Map();
    const run = (_bin, argv, opts) => {
      seenArgv.push(argv);
      const [, piece, op, c, k] = argv;
      if (piece !== 'runtime') return { status: 1, stdout: '', stderr: 'wrong piece' };
      if (op === 'get') return docs.has(`${c}/${k}`) ? { status: 0, stdout: JSON.stringify(docs.get(`${c}/${k}`)) } : { status: 3, stdout: '', stderr: '' };
      if (op === 'put') { const rev = (docs.get(`${c}/${k}`)?.rev ?? 0) + 1; docs.set(`${c}/${k}`, { doc: JSON.parse(opts.input), rev }); return { status: 0, stdout: JSON.stringify({ rev }) }; }
      if (op === 'list') return { status: 0, stdout: JSON.stringify([...docs].filter(([kk]) => kk.startsWith(`${c}/`)).map(([kk, d]) => ({ key: kk.slice(c.length + 1), ...d }))) };
      return { status: 0, stdout: '' };
    };
    const st = loomStore({ LOOM_PIECE_NAME: 'runtime' }, { run, piece: 'runtime' });
    await importGates(st, fakeCore(), EXPORT, { owner: true });
    assert.ok(seenArgv.length > 0);
    assert.ok(seenArgv.every((a) => a[0] === 'store' && a[1] === 'runtime'), JSON.stringify(seenArgv));
    assert.deepEqual(docs.get('gates/art').doc, ART_DOC);
  });

  test('again: the same document is "same"; a different one is kept unless --force', async () => {
    const st = memStore();
    await importGates(st, fakeCore(), EXPORT, { owner: true });
    assert.deepEqual((await importGates(st, fakeCore(), EXPORT, { owner: true })).agents, { art: 'same', mark: 'same' });
    const changed = JSON.stringify({ v: 1, agents: { art: { doc: { people: {} } } } });
    assert.match((await importGates(st, fakeCore(), changed, { owner: true })).agents.art, /kept/);
    assert.equal((await importGates(st, fakeCore(), changed, { owner: true, force: true })).agents.art, 'imported');
  });

  test('an export that isn\'t one is refused, nothing written', () => {
    assert.match(parseExport('nope'), /isn't JSON/);
    assert.match(parseExport('{"v":1,"agents":{"art":{"doc":{"people":{},"x":1}}}}'), /aren't a people document/);
  });

  test('a card that can\'t be made never undoes the gate write, and the answer says why', async () => {
    const st = memStore();
    const r = await importGates(st, fakeCore({ fail: { ensure: 'core refused people/ensure: slack U8 is already pat\'s' } }), EXPORT, { owner: true });
    assert.deepEqual(gatesOf(st, 'art').doc, ART_DOC);
    assert.match(r.cards, /no card for jonathan .*slack U8 is already pat's/);
  });
});

describe('a body proposes; the owner allows or denies', () => {
  const caller = { agent: 'art', service: 'slack' };
  const entry = { name: 'Pat Lee', role: 'pharmacist', tier: 2, slack: { T1: ['U9'] } };
  const setup = async () => { const st = memStore(); await importGates(st, fakeCore(), EXPORT, { owner: true }); return st; };

  test('propose keeps one proposal; checks the entry, tier 3 and taken ids', async () => {
    const st = await setup();
    const r = propose(st, caller, { slug: 'pat-lee', entry: JSON.stringify(entry), why: 'asked in #lab' }, { rand: () => 'abc123' });
    assert.equal(r.ok, true, r.message);
    assert.equal(st.get(PROPOSALS, 'art.p-abc123').doc.slug, 'pat-lee');
    assert.match(propose(st, caller, { slug: 'x', entry: JSON.stringify({ ...entry, tier: 3 }) }).message, /can't propose tier 3/);
    assert.match(propose(st, caller, { slug: 'pat', entry: JSON.stringify({ ...entry, slack: { T1: ['U8'] } }) }).message, /slack id U8 is already grace's/);
    assert.match(propose(st, caller, { slug: 'jonathan', entry: JSON.stringify(entry) }).message, /tier 3; only the owner/);
    assert.match(propose(memStore(), caller, { slug: 'pat', entry: JSON.stringify(entry) }).message, /aren't in the runtime yet/);
  });

  test('the Inbox has it, with Allow and Deny; Allow merges it, ensures the card, and the bridges read it', async () => {
    const st = await setup();
    propose(st, caller, { slug: 'pat-lee', entry: JSON.stringify(entry) }, { rand: () => 'abc123' });
    const [a] = asks(st);
    assert.equal(a.kind, 'permission');
    assert.equal(a.page, 'gates/art');
    assert.deepEqual(a.actions.map((x) => x.action), ['gates-allow', 'gates-deny']);
    const core = fakeCore();
    const r = await answer(st, core, 'gates-allow', a.actions[0].fields);
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(gatesOf(st, 'art').doc.people['pat-lee'], entry);
    assert.equal(st.get(PROPOSALS, 'art.p-abc123'), null);
    // A new slug: checked dry, then its card made.
    assert.deepEqual(core.calls.map(([k, b]) => [k, b.slug]), [['dry', 'pat-lee'], ['ensure', 'pat-lee']]);
    assert.match(r.message, /Person card: card made/);
    assert.deepEqual(asks(st), []);
  });

  test('Allow refuses what changed since the owner looked; Deny drops it and changes nothing', async () => {
    const st = await setup();
    propose(st, caller, { slug: 'grace', entry: JSON.stringify({ name: 'Grace Aquino', tier: 1, slack: { T1: ['U8'] } }) }, { rand: () => 'aaaaaa' });
    const [a] = asks(st);
    const g = gatesOf(st, 'art');
    st.put(GATES, 'art', { ...g.doc, people: { ...g.doc.people, grace: { ...g.doc.people.grace, role: 'chemist' } } }, g.rev);
    assert.match((await answer(st, fakeCore(), 'gates-allow', a.actions[0].fields)).message, /changed since you looked/);
    const d = await answer(st, fakeCore(), 'gates-deny', a.actions[1].fields);
    assert.match(d.message, /Denied/);
    assert.equal(gatesOf(st, 'art').doc.people.grace.tier, 2);
    // Allowing a change keeps what the owner gave the entry (grant) untouched.
    propose(st, caller, { slug: 'grace', entry: JSON.stringify({ name: 'Grace Aquino', tier: 1, slack: { T1: ['U8'] } }) }, { rand: () => 'bbbbbb' });
    const [b] = asks(st);
    assert.equal((await answer(st, fakeCore(), 'gates-allow', b.actions[0].fields)).ok, true);
    assert.deepEqual(gatesOf(st, 'art').doc.people.grace.grant, ['pond']);
    assert.equal(gatesOf(st, 'art').doc.people.grace.tier, 1);
  });

  test('a follow-up the body asked for goes to its agent as a relay delivery once allowed', async () => {
    const st = await setup();
    propose(st, caller, { slug: 'pat-lee', entry: JSON.stringify(entry), 'then-relay-say': 'You\'re in.', 'then-relay-via': 'slack' }, { rand: () => 'cccccc' });
    const core = fakeCore();
    const r = await answer(st, core, 'gates-allow', asks(st)[0].actions[0].fields);
    const [, d] = core.calls.find(([k]) => k === 'deliver');
    assert.equal(d.venue, 'relay');
    assert.equal(d.agent, 'art');
    assert.match(d.text, /You're in\./);
    assert.match(r.message, /told to send the follow-up on slack/);
  });

  test('a body reaches its own agent\'s gates only, through the run path', async () => {
    const st = await setup();
    const out = await runFor({}, { kind: 'agent', agent: 'mark' }, ['gates', 'people'], st, fakeCore());
    assert.deepEqual(JSON.parse(out.stdout).doc, MARK_DOC);
    const p = await runFor({}, { kind: 'agent', agent: 'mark', service: 'discord' }, ['propose-person', '--slug', 'pat-lee', '--entry', JSON.stringify(entry)], st, fakeCore());
    assert.equal(p.exit, 0, p.stderr);
    assert.equal(asks(st)[0].page, 'gates/mark');
  });
});

describe('merges: a card merge is followed by the gates', () => {
  test('renamed: a rename into a new slug; into an existing one, both ids kept and the second wins the rest', () => {
    const [r1] = renamed(ART_DOC, 'grace', 'grace-aquino');
    assert.deepEqual(Object.keys(r1.people), ['jonathan', 'grace-aquino']);
    const doc = { people: { pat: { name: 'Pat', tier: 1, slack: { T1: ['U2'] } }, 'pat-lee': { name: 'Pat Lee', tier: 2, slack: { T1: ['U3'] } } } };
    const [r2, what] = renamed(doc, 'pat', 'pat-lee');
    assert.deepEqual(r2.people, { 'pat-lee': { name: 'Pat Lee', tier: 2, slack: { T1: ['U3', 'U2'] } } });
    assert.equal(what, 'merged pat into pat-lee');
    assert.equal(renamed(doc, 'nope', 'x')[0], null);
  });

  test('gates-merge renames in every agent\'s gates, and merges the cards in core', async () => {
    const st = memStore();
    await importGates(st, fakeCore(), EXPORT, { owner: true });
    const core = fakeCore();
    const r = await mergePeople(st, core, { agent: 'art', from: 'jonathan', to: 'jonathan-barket', rev: String(gatesOf(st, 'art').rev) });
    assert.equal(r.ok, true, r.message);
    assert.ok(gatesOf(st, 'art').doc.people['jonathan-barket']);
    assert.ok(gatesOf(st, 'mark').doc.people['jonathan-barket']);
    assert.deepEqual(core.calls[0], ['merge', { from: 'jonathan', into: 'jonathan-barket' }]);
    // A stale page is refused.
    assert.match((await mergePeople(st, core, { agent: 'art', from: 'grace', to: 'g', rev: '1' })).message, /changed since you opened/);
  });

  test('followMerge, after a merge made elsewhere: every agent\'s gates follow', async () => {
    const st = memStore();
    await importGates(st, fakeCore(), EXPORT, { owner: true });
    assert.deepEqual(followMerge(st, 'jonathan', 'jb'), ['art: jonathan is jb now', 'mark: jonathan is jb now']);
    assert.deepEqual(status(st), { art: 2, mark: 2 });
  });

  test('seen() is stable however the document\'s keys were ordered', () => {
    const p = { id: 'p-1', slug: 'grace', entry: { tier: 1, name: 'G' } };
    assert.equal(seen(p, { people: { grace: { a: 1, b: 2 } } }), seen({ ...p, entry: { name: 'G', tier: 1 } }, { people: { grace: { b: 2, a: 1 } } }));
  });
});

describe('shuttle\'s hand-off: gates propose takes the proposal on stdin, never as flags', () => {
  const entry = { name: 'Pat Lee', tier: 2, slack: { T1: ['U9'] } };
  const run = async (args, input, st) => {
    const { gatesCli } = await import('../src/perms-cli.mjs');
    const writes = [];
    const w = process.stdout.write;
    process.stdout.write = (x) => { writes.push(String(x)); return true; };
    try { await gatesCli(['propose', ...args], {}, { store: st, core: fakeCore(), stdin: async () => input }); return { ok: true, out: writes.join('') }; }
    catch (e) { return { ok: false, code: e.code, message: e.message }; }
    finally { process.stdout.write = w; }
  };

  test('exactly --agent A --from F --stdin; the proposal is the stdin JSON', async () => {
    const st = memStore();
    await importGates(st, fakeCore(), EXPORT, { owner: true });
    const r = await run(['--agent', 'art', '--from', 'slack', '--stdin'], JSON.stringify({ slug: 'pat-lee', entry: JSON.stringify(entry) }), st);
    assert.equal(r.ok, true, r.message);
    assert.equal(asks(st)[0].page, 'gates/art');
  });

  test('a body\'s own --agent (or anything after) is refused: nothing written', async () => {
    const st = memStore();
    await importGates(st, fakeCore(), EXPORT, { owner: true });
    for (const args of [['--agent', 'art', '--from', 'slack', '--stdin', '--agent', 'mark'], ['--agent', 'art', '--from', 'slack', '--slug', 'x'], ['--from', 'x', '--agent', 'art', '--stdin']]) {
      const r = await run(args, JSON.stringify({ slug: 'pat-lee', entry: JSON.stringify(entry) }), st);
      assert.equal(r.ok, false, args.join(' '));
      assert.equal(r.code, 2);
    }
    // Flags smuggled in the JSON are no flags: an unknown key is refused by propose's allowlist.
    const r = await run(['--agent', 'art', '--from', 'slack', '--stdin'], JSON.stringify({ slug: 'pat-lee', entry: JSON.stringify(entry), agent: 'mark' }), st);
    assert.match(r.message, /doesn't take --agent/);
    assert.deepEqual(asks(st), []);
  });
});

describe('a proposal never puts a body\'s ids on someone else\'s card', () => {
  const setup = async (core) => { const st = memStore(); await importGates(st, core, EXPORT, { owner: true }); return st; };

  test('a new gate slug that is another person\'s card, with the body\'s own Slack id: shown, and Allow refused', async () => {
    const core = fakeCore({ cards: { 'jonathan-barket': { name: 'Jonathan Barket', ids: ['slack U1'] } } });
    const st = await setup(core);
    const ok = runFor({}, { kind: 'agent', agent: 'mark', service: 'discord' },
      ['propose-person', '--slug', 'jonathan-barket', '--entry', JSON.stringify({ name: 'Jonathan', tier: 2, slack: { T1: ['UEVIL'] } })], st, core);
    assert.equal((await ok).exit, 0);
    const [a] = asks(st);
    assert.match(a.text, /\(jonathan-barket\): this slug is Jonathan Barket's card/);
    assert.deepEqual(a.actions.map((x) => x.action), ['gates-deny']);
    // Even an Allow sent by hand (the action's fields made up) is refused, and nothing is written anywhere.
    const before = structuredClone(gatesOf(st, 'mark').doc);
    const p = st.list(PROPOSALS)[0].doc;
    const r = await answer(st, core, 'gates-allow', { agent: 'mark', id: p.id, seen: seen(p, gatesOf(st, 'mark').doc) });
    assert.equal(r.ok, false);
    assert.match(r.message, /this slug is Jonathan Barket's card, which doesn't have slack UEVIL/);
    assert.deepEqual(core.cards['jonathan-barket'].ids, ['slack U1']);
    assert.deepEqual(gatesOf(st, 'mark').doc, before);
    assert.equal(core.calls.filter(([k, b]) => k === 'ensure' && b.slug === 'jonathan-barket').length, 0);
  });

  test('the slug\'s card already has the proposal\'s ids: Allow goes ahead, and the card isn\'t written', async () => {
    const core = fakeCore({ cards: { 'jonathan-barket': { name: 'Jonathan Barket', ids: ['slack U1'] } } });
    const st = await setup(core);
    await runFor({}, { kind: 'agent', agent: 'mark' }, ['propose-person', '--slug', 'jonathan-barket', '--entry', JSON.stringify({ name: 'Jonathan', tier: 2, slack: { T1: ['U1'] } })], st, core);
    const [a] = asks(st);
    assert.match(a.text, /\(jonathan-barket\)/);
    assert.deepEqual(a.actions.map((x) => x.action), ['gates-allow', 'gates-deny']);
    const r = await answer(st, core, 'gates-allow', a.actions[0].fields);
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /Jonathan Barket's, which has these ids already/);
    assert.equal(core.calls.filter(([k, b]) => k === 'ensure' && b.slug === 'jonathan-barket').length, 0);
  });

  test('a card check core can\'t answer refuses Allow (fail closed)', async () => {
    const st = await setup(fakeCore());
    propose(st, { agent: 'art' }, { slug: 'pat-lee', entry: JSON.stringify({ name: 'Pat', tier: 2, slack: { T1: ['U9'] } }) }, { rand: () => 'dddddd' });
    const [a] = asks(st);
    const r = await answer(st, fakeCore({ fail: { ensure: 'core didn\'t answer people/ensure' } }), 'gates-allow', a.actions[0].fields);
    assert.equal(r.ok, false);
    assert.match(r.message, /couldn't be checked/);
    assert.equal(gatesOf(st, 'art').doc.people['pat-lee'], undefined);
  });
});

describe('paths: only a call\'s canonical path is ever granted', () => {
  const doc = { v: 1, pieces: { tasks: { art: ['*'] }, secrets: {}, clock: { art: ['wakes/*'] } } };
  test('tasks/../secrets, empty segments, backslashes and percent-encoding are refused, whatever the grant', () => {
    for (const path of ['tasks/../secrets', '../secrets', './run', 'run/', '/run', 'a//b', 'a\\b', '%2e%2e/secrets', 'wakes/%2e%2e', 'wakes/..']) {
      assert.equal(decide(doc, { agent: 'art', piece: 'tasks', path }).allow, false, path);
      assert.equal(decide(doc, { agent: 'art', piece: 'clock', path }).allow, false, path);
      assert.equal(decide(null, { agent: 'art', piece: 'tasks', path }).allow, false, path);
    }
    assert.equal(decide(doc, { agent: 'art', piece: 'tasks', path: 'run' }).allow, true);
    assert.equal(decide(doc, { agent: 'art', piece: 'tasks', path: '' }).allow, true);
    assert.equal(decide(doc, { agent: 'art', piece: 'clock', path: 'wakes/w-1.json' }).allow, true);
  });
});

describe('a house reads its effective grants from the runtime', () => {
  test('wildcard and own paths are combined without exposing other agents or mutation verbs', async () => {
    const st = memStore();
    st.put(GRANTS, KEY, { v: 1, pieces: { tasks: { art: ['run'], mark: ['private'], '*': ['read'] }, secrets: { mark: ['*'] } }, relay: { art: ['mark'], mark: ['gabe'] } });
    const r = await runFor({}, { kind: 'agent', agent: 'art' }, ['grants', 'list', '--json'], st);
    assert.equal(r.exit, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { agent: 'art', configured: true, pieces: { tasks: ['run', 'read'] }, relay: ['mark'] });
    for (const args of [['grants', 'list', '--agent', 'mark'], ['grants', 'set', 'tasks', 'art'], ['grants', 'seed']]) {
      assert.notEqual((await runFor({}, { kind: 'agent', agent: 'art' }, args, st)).exit, 0);
    }
  });
  test('absent configuration is explicit and a broken store is never reported as no grants', async () => {
    const st = memStore();
    assert.equal(JSON.parse((await runFor({}, { kind: 'agent', agent: 'art' }, ['grants', 'list'], st)).stdout).configured, false);
    const broken = { get() { throw new Error('store unavailable'); } };
    const r = await runFor({}, { kind: 'agent', agent: 'art' }, ['grants', 'list'], broken);
    assert.equal(r.exit, 1);
    assert.match(r.stderr, /store unavailable/);
    assert.throws(() => loomStore({ HOUSE_ID: 'h-test' }, { run() { throw new Error('must not run'); } }).get(GRANTS, KEY), /store lives on loom/);
  });

  test('a store that names no managed piece is a failed read, never "no grants" (which allows everyone)', () => {
    const run = () => ({ status: 3, stdout: '', stderr: 'loom store: no managed piece named runtim\n' });
    assert.throws(() => loomStore({}, { run, piece: 'runtim' }).get(GRANTS, KEY), /no managed piece/);
    assert.throws(() => ask(loomStore({}, { run, piece: 'runtim' }), JSON.stringify({ agent: 'art', piece: 'tasks', path: 'run' })), /no managed piece/);
    const none = () => ({ status: 3, stdout: '', stderr: 'loom store: no grants/household\n' });
    assert.equal(loomStore({}, { run: none, piece: 'runtime' }).get(GRANTS, KEY), null);
    // The store says whose it is: the piece loom store is given (LOOM_RUNTIME_PIECE first, as pieceName says).
    assert.equal(loomStore({ LOOM_RUNTIME_PIECE: 'elsewhere', LOOM_PIECE_NAME: 'runtime' }, { run: none }).piece, 'elsewhere');
  });

  test('asked with basis: true, the answer names what it decided on: the document and its text\'s sha256 (t-2065)', () => {
    const q = (more = {}) => JSON.stringify({ agent: 'art', piece: 'tasks', path: 'run', ...more });
    // A store that doesn't say whose it is gives no basis.
    assert.deepEqual(ask(memStore(), q({ basis: true })), { allow: true });
    const st = Object.assign(memStore(), { piece: 'runtime' });
    assert.deepEqual(ask(st, q()), { allow: true });
    assert.deepEqual(ask(st, q({ basis: true })), { allow: true, basis: { piece: 'runtime', key: KEY, sha256: null } });
    const doc = { v: 1, pieces: { tasks: { mark: ['*'] } } };
    st.put(GRANTS, KEY, doc);
    const a = ask(st, q({ basis: true }));
    assert.equal(a.allow, false);
    // The text loom's store holds is JSON.stringify of the document: core hashes that same text.
    assert.deepEqual(a.basis, { piece: 'runtime', key: KEY, sha256: createHash('sha256').update(JSON.stringify(doc)).digest('hex') });
    assert.equal(ask(st, q()).basis, undefined);
  });
});
