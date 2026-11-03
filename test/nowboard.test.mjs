// The now board (nowboard.mjs; loom docs/specs/agent-runtime.md, "The sources": the now board is the runtime's own
// state, shown on its page; t-1731): the bridges' inbox (loom-now's, moved in), the board on the runtime's page, and
// the manifest's part of it (a dark bridge's alert, each agent's doing), checked against loom's own validator.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { api } from '../src/control.mjs';
import { runFor } from '../src/gates-api.mjs';
import { boardDir, bridgesOf, nowManifest, nowPage, talking } from '../src/nowboard.mjs';
import { manifest, page } from '../src/ui.mjs';
import { memStore } from '../src/store.mjs';
import { scratch } from './scratch.mjs';

const dist = process.env.LOOM_DIST || join(homedir(), 'Code', 'loom', 'dist');
const vocab = existsSync(join(dist, 'ui', 'vocab.js')) ? await import(join(dist, 'ui', 'vocab.js')) : null;

function world() {
  const HOME = scratch('rt-now-');
  const env = { HOME, LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(HOME, 'state'), LOOM_BOX_DATA: join(HOME, 'data'), LOOM_HOME: join(HOME, 'loom'), LOOM_RUNTIME_NOW_DIR: join(HOME, 'boards') };
  mkdirSync(env.LOOM_HOME, { recursive: true });
  writeFileSync(join(env.LOOM_HOME, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art' }));
  return env;
}
const fx = { now: () => new Date() };
const art = { kind: 'agent', agent: 'art', house: 'h-1', service: 'discord' };
const mark = { kind: 'agent', agent: 'mark', house: 'h-2', service: 'discord' };
const snap = (at, more = {}) => ({ v: 1, bridge: 'discord', at, interval_s: 15, slots: { used: 1, cap: 5 }, talking: [], waiting: [], ...more });

describe('the inbox: a bridge in a house writes its board through the runtime', () => {
  test('a snapshot lands in its own agent\'s board, private, by rename; the owner\'s is the default agent\'s', () => {
    const env = world();
    const r = api(env, fx, { caller: mark, path: 'now/snapshot', body: { bridge: 'discord', snap: snap(1000) } });
    return Promise.resolve(r).then(async (a) => {
      assert.deepEqual(a, { status: 200, body: { ok: true } });
      const f = join(env.LOOM_RUNTIME_NOW_DIR, 'mark-now', 'discord.json');
      assert.equal(JSON.parse(readFileSync(f, 'utf-8')).at, 1000);
      assert.equal(statSync(f).mode & 0o777, 0o600);
      const o = await api(env, fx, { caller: { kind: 'owner' }, path: 'now/snapshot', body: { bridge: 'slack', snap: snap(2000) } });
      assert.equal(o.status, 200);
      assert.ok(existsSync(join(env.LOOM_RUNTIME_NOW_DIR, 'art-now', 'slack.json')));
      assert.equal(boardDir(env, 'art'), join(env.LOOM_RUNTIME_NOW_DIR, 'art-now'), 'loom-now\'s layout, so its readers read the same files');
    });
  });

  test('an agent owner reaches only their own agents\' boards; only a household owner gets the default agent\'s', async () => {
    const env = world();
    const pollock = { kind: 'owner', who: 'pollock', agents: ['mark'] };
    // Without naming an agent, an agent owner isn't handed the household's default agent's (art's) board.
    assert.equal((await api(env, fx, { caller: pollock, path: 'now/snapshot', body: { bridge: 'discord', snap: snap(1) } })).status, 403);
    assert.equal((await api(env, fx, { caller: pollock, path: 'now/snapshot', body: { agent: 'art', bridge: 'discord', snap: snap(1) } })).status, 403);
    assert.equal((await api(env, fx, { caller: pollock, path: 'now/event', body: { agent: 'art', record: { bridge: 'discord' } } })).status, 403);
    assert.equal(existsSync(join(env.LOOM_RUNTIME_NOW_DIR, 'art-now')), false, 'nothing of art\'s board is touched');
    assert.equal((await api(env, fx, { caller: pollock, path: 'now/snapshot', body: { agent: 'mark', bridge: 'discord', snap: snap(2) } })).status, 200);
    assert.equal(JSON.parse(readFileSync(join(env.LOOM_RUNTIME_NOW_DIR, 'mark-now', 'discord.json'), 'utf-8')).at, 2);
    // The household owner (no agents list, or '*' resolved as none) gets the default agent's, as loom-now did.
    assert.equal((await api(env, fx, { caller: { kind: 'owner', who: 'jonathan' }, path: 'now/snapshot', body: { bridge: 'discord', snap: snap(3) } })).status, 200);
    assert.equal(JSON.parse(readFileSync(join(env.LOOM_RUNTIME_NOW_DIR, 'art-now', 'discord.json'), 'utf-8')).at, 3);
    // The read, too: an agent owner's `now talking` isn't the default agent's.
    const r = await runFor(env, pollock, ['now', 'talking'], memStore());
    assert.equal(r.exit, 1);
    assert.match(r.stderr, /only their own agents/);
  });

  test('an event is appended to its month; anything else is refused and writes nothing', async () => {
    const env = world();
    const t = Date.parse('2026-11-03T10:00:00Z') / 1000;
    assert.equal((await api(env, fx, { caller: art, path: 'now/event', body: { record: { v: 1, t, bridge: 'slack', kind: 'socket', state: 'up' } } })).status, 200);
    const f = join(env.LOOM_RUNTIME_NOW_DIR, 'art-now', 'events-2026-11.jsonl');
    assert.equal(readFileSync(f, 'utf-8').trim().split('\n').length, 1);
    const no = async (caller, path, body) => (await api(env, fx, { caller, path, body })).status;
    assert.equal(await no(art, 'now/snapshot', { bridge: '../x', snap: {} }), 400);
    assert.equal(await no(art, 'now/snapshot', { bridge: 'discord', snap: { pad: 'x'.repeat(70_000) } }), 413);
    assert.equal(await no(art, 'now/event', { record: { bridge: 'slack', pad: 'x'.repeat(17_000) } }), 413);
    assert.equal(await no(art, 'now/event', { record: { kind: 'x' } }), 400);
    assert.equal(await no({ kind: 'piece', subject: 'one' }, 'now/snapshot', { bridge: 'discord', snap: {} }), 403);
    assert.equal(readFileSync(f, 'utf-8').trim().split('\n').length, 1);
  });

  test('`now talking`, over the run path: the caller\'s own bridges, how many talk and wait, and how fresh', async () => {
    const env = world();
    const now = Date.now() / 1000;
    await api(env, fx, { caller: art, path: 'now/snapshot', body: { bridge: 'discord', snap: snap(now, { talking: [{ chan: 'D1', who: ['Loren'] }], waiting: [{ chan: 'D2', reason: 'busy' }] }) } });
    await api(env, fx, { caller: art, path: 'now/snapshot', body: { bridge: 'slack', snap: snap(now - 600) } });
    const r = await runFor(env, art, ['now', 'talking'], memStore());
    assert.equal(r.exit, 0);
    const got = JSON.parse(r.stdout);
    assert.deepEqual({ ...got.discord, age_s: 0 }, { talking: 1, waiting: 1, age_s: 0, fresh: true });
    assert.equal(got.slack.fresh, false);
    assert.deepEqual(JSON.parse((await runFor(env, mark, ['now', 'talking'], memStore())).stdout), {}, 'another agent\'s board isn\'t its own');
    assert.equal((await runFor(env, art, ['now', 'what'], memStore())).exit, 2);
  });
});

describe('the board on the runtime\'s page and in its manifest', () => {
  test('a dark bridge is an alert, a live one\'s conversations are its agent\'s doing; nothing anyone said', async () => {
    const env = world();
    const now = Date.now() / 1000;
    await api(env, fx, { caller: art, path: 'now/snapshot', body: { bridge: 'discord', snap: snap(now, { talking: [{ chan: 'D1', venue: 'discord-dm', who: ['Grace Aquino'], active_s: 120, body_since: now - 300 }] }) } });
    await api(env, fx, { caller: mark, path: 'now/snapshot', body: { bridge: 'discord', snap: snap(now - 3600) } });
    const m = nowManifest(env, now);
    assert.equal(m.asks.length, 1);
    assert.match(m.asks[0].text, /^Mark's discord bridge is dark since /);
    assert.deepEqual([m.asks[0].kind, m.asks[0].agent, m.asks[0].page], ['alert', 'mark', 'now']);
    assert.deepEqual(m.agents.art[0], { text: 'Talking with Grace Aquino', kind: 'talk', where: 'Discord discord-dm · active 2m ago', since: new Date((now - 300) * 1000).toISOString() });
    assert.equal(m.agents.mark, undefined);
    // The whole manifest carries them, beside the runtime's own.
    const full = manifest(env);
    assert.ok(full.asks.some((a) => a.text.startsWith('Mark\'s discord bridge is dark')));
    assert.equal(full.agents.art.doing[0].text, 'Talking with Grace Aquino');
    assert.deepEqual(full.tile.label, 'Boxes', 'the runtime\'s tile is still its boxes');
    const p = nowPage(env, { usage: [{ account: 'max', provider: 'anthropic', label: 'Claude Max', windows: { '5h': 0.4, '7d': 0.97 }, resets: { '5h': now + 3600 } }], nowS: now });
    const stats = p.sections[0].blocks[0].items;
    assert.deepEqual(stats.map((x) => [x.label, x.value]), [['Bridges', '1 live'], ['Talking', '1'], ['Waiting', '0']]);
    assert.equal(stats[0].detail, '1 dark');
    assert.deepEqual(p.sections[1].blocks[0].items.map((x) => x.label), ['Claude Max · 5h', 'Claude Max · 7d']);
    assert.equal(p.sections[1].blocks[0].items[1].tone, 'bad');
    assert.deepEqual(p.sections.map((s) => s.id), ['now', 'quota', 'board-art', 'board-mark']);
  });

  test('loom\'s validator takes the Now page and the manifest with a board in it', { skip: !vocab && 'no built loom to validate against' }, async () => {
    const env = world();
    const now = Date.now() / 1000;
    assert.notEqual(typeof vocab.parsePage(page(env, { path: 'now' })), 'string', 'an empty board');
    await api(env, fx, { caller: art, path: 'now/snapshot', body: { bridge: 'discord', snap: snap(now, { talking: [{ chan: 'D1', venue: 'discord-dm', who: ['Grace'], active_s: 5 }], waiting: [{ chan: 'C1', who: ['Pat'], reason: 'cap' }] }) } });
    await api(env, fx, { caller: mark, path: 'now/snapshot', body: { bridge: 'slack', snap: snap(now - 3600) } });
    const pg = vocab.parsePage(page(env, { path: 'now' }));
    assert.notEqual(typeof pg, 'string', pg);
    const mf = vocab.parseManifest(manifest(env));
    assert.notEqual(typeof mf, 'string', mf);
  });

  test('a board with nothing readable shows nothing, and never breaks the manifest', () => {
    const env = world();
    mkdirSync(join(env.LOOM_RUNTIME_NOW_DIR, 'art-now'), { recursive: true });
    writeFileSync(join(env.LOOM_RUNTIME_NOW_DIR, 'art-now', 'discord.json'), 'not json');
    writeFileSync(join(env.LOOM_RUNTIME_NOW_DIR, 'art-now', 'convs.json'), '{"at": 1}');
    assert.deepEqual(bridgesOf(join(env.LOOM_RUNTIME_NOW_DIR, 'art-now')), []);
    assert.deepEqual(talking(join(env.LOOM_RUNTIME_NOW_DIR, 'art-now')), {});
    assert.deepEqual(nowManifest(env), { asks: [], agents: {} });
    assert.equal(manifest(env).tile.label, 'Boxes');
  });
});
