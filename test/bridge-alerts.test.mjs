// A bridge's alerts (nowboard.mjs, bridgeStatus and watchBridges; Jonathan, 2026-11-03: notify when a bridge is
// actually down, not on every blip). Driven through the real control plane (services, their houses and crashes) and
// the board's files, on one clock. Pins that
//  - a restart the runtime is doing (a restart, a drain, a service down and up) is "restarting", never an alert;
//  - silence past LOOM_RUNTIME_BRIDGE_DARK_S (default 5 min) while its house runs is an alert, its text fixed;
//  - a crash loop (3 unasked ends within 15 min) alerts at once, whatever the snapshot says;
//  - a blip leaves nothing; an outage that recovers leaves one FYI, never an alert.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, serviceRestart } from '../src/control.mjs';
import { load } from '../src/state.mjs';
import { darkAfterS, nowManifest, nowPage } from '../src/nowboard.mjs';
import { agentReports } from '../src/ui.mjs';
import { scratch } from './scratch.mjs';

let env, fx, clock;
const owner = { kind: 'owner' };
const art = { kind: 'agent', agent: 'art' };
const T0 = Date.parse('2026-11-03T14:00:00Z');
const nowS = () => clock / 1000;
const at = (s) => { clock = T0 + s * 1000; };
const one = () => ({ kind: 'piece', subject: Object.entries(load(env).boxes).find(([, b]) => (b.name ?? '') === 'one' && !b.revoked)?.[0] ?? 'one' });
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

beforeEach(() => {
  const HOME = scratch('rt-bridge-alerts-');
  env = { HOME, LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(HOME, 'state'), LOOM_BOX_DATA: join(HOME, 'data'), LOOM_RUNTIME_NOW_DIR: join(HOME, 'boards') };
  at(0);
  fx = { now: () => new Date(clock), mint: () => `loom_${'x'.repeat(30)}`, revoke: () => {}, secret: (n) => `v:${n}` };
  ok(call(owner, 'set-agent', { agent: 'art', repo: 'https://x/art.git' }));
});

/** The box starts what's wanted: claim, then running. */
function startWanted() {
  const p = ok(call(one(), 'poll'));
  assert.equal(p.start.length, 1, JSON.stringify(p));
  ok(call(one(), 'claim', { id: p.start[0].id }));
  ok(call(one(), 'report', { id: p.start[0].id, state: 'running' }));
  return p.start[0].id;
}
const houseOf = (name = 'slack') => load(env).services[`art/${name}`].house;
/** The bridge in its house writes a snapshot (nowlog), now. */
function snap(name = 'slack') {
  const d = join(env.LOOM_RUNTIME_NOW_DIR, 'art-now');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${name}.json`), JSON.stringify({ v: 1, bridge: name, at: nowS(), interval_s: 5, talking: [], waiting: [] }));
}
const view = () => nowManifest(env, nowS());
const row = () => nowPage(env, { nowS: nowS() }).sections.find((s) => s.id === 'board-art').blocks[0].items[0];
function bridgeUp(name = 'slack') {
  ok(call(art, 'service-up', { name }));
  startWanted();
  snap(name);
}

test('a restart the runtime is doing is "restarting": no alert, nothing to push, and nothing left after', () => {
  bridgeUp();
  at(60); snap();
  // The owner restarts it (as a drain or a deploy does): its house stops, a fresh one is wanted, claimed, running.
  assert.equal(serviceRestart(env, fx, owner, { agent: 'art', name: 'slack' }).restarting, true);
  at(200);
  assert.deepEqual(view().asks, []);
  assert.deepEqual([row().badge, row().tone], ['restarting', 'warn']);
  ok(call(one(), 'report', { id: houseOf(), state: 'stopped' }));
  at(380); // over the dark threshold since its last word: still the runtime's restart
  assert.deepEqual(view().asks, []);
  assert.match(row().meta, /starting its house/);
  startWanted();
  at(500); // its house up, the bridge connecting
  assert.deepEqual(view().asks, []);
  assert.equal(row().badge, 'restarting');
  const pg = nowPage(env, { nowS: nowS() });
  assert.deepEqual([pg.sections[0].blocks[0].tone, pg.sections[0].blocks[0].text], ['warn', 'A bridge is restarting']);
  at(510); snap();
  const m = view();
  assert.deepEqual([m.asks, m.notices], [[], []], 'never noted as an outage, so nothing to say it\'s back');
  assert.deepEqual([row().badge, row().tone], ['live', 'ok']);
});

test('a service taken down and brought up the normal way never alerts; its Home reading says restarting', () => {
  bridgeUp();
  ok(call(owner, 'service-down', { agent: 'art', name: 'slack' }));
  at(30); ok(call(one(), 'report', { id: houseOf(), state: 'stopped' }));
  at(400);
  assert.deepEqual(view().asks, [], 'taken down: nothing is meant to be running');
  assert.equal(row().badge, 'off');
  ok(call(owner, 'service-up', { agent: 'art', name: 'slack' }));
  at(420);
  assert.deepEqual(view().asks, []);
  assert.equal(row().badge, 'restarting');
  assert.deepEqual(agentReports(load(env), clock).art.readings[0], { label: 'Bridges', value: 'slack restarting', tone: 'warn' });
  startWanted();
  at(440); snap();
  assert.deepEqual([view().asks, view().notices], [[], []]);
  assert.deepEqual(agentReports(load(env), clock).art.readings[0], { label: 'Bridges', value: 'slack ✓', tone: 'ok' });
});

test('silence past the threshold while its house runs is an alert, its text fixed for the outage (pushed once)', () => {
  bridgeUp();
  assert.equal(darkAfterS(env), 300);
  at(299);
  assert.deepEqual(view().asks, [], 'under five minutes: late, not down');
  assert.deepEqual([row().badge, row().tone], ['live', 'warn']);
  at(301);
  const a = view().asks;
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].text, a[0].kind, a[0].agent, a[0].page], ['Art\'s slack bridge is down: no word since 14:00 UTC', 'alert', 'art', 'now']);
  assert.match(a[0].meta, /while its house is up/);
  at(900);
  assert.equal(view().asks[0].text, a[0].text, 'the same ask, so loom pushes it once (its key is its text)');
  assert.deepEqual([row().badge, row().tone], ['down', 'bad']);
  // The threshold is a setting.
  env.LOOM_RUNTIME_BRIDGE_DARK_S = '1200';
  assert.deepEqual(view().asks, []);
});

test('a house stuck starting is explained for a while, then it\'s down', () => {
  ok(call(art, 'service-up', { name: 'slack' }));
  const p = ok(call(one(), 'poll')).start[0];
  ok(call(one(), 'claim', { id: p.id }));
  snap();
  at(800);
  assert.deepEqual(view().asks, [], 'its house is starting (a build, say)');
  at(15 * 60 + 5);
  const a = view().asks;
  assert.equal(a.length, 1);
  assert.match(a[0].meta, /its house has been starting for 15 min/);
});

test('a crash loop alerts at once, saying what\'s happening; the runtime\'s own restart isn\'t a crash', () => {
  bridgeUp();
  // The runner restarted under it: not a crash.
  ok(call(one(), 'report', { id: houseOf(), state: 'failed', log: 'the box no longer has this house (it restarted while the house was up)' }));
  assert.equal(load(env).services['art/slack'].crashes, undefined);
  for (let i = 1; i <= 3; i++) {
    at(i * 60);
    // Back-off: it starts again once its notBefore has passed.
    startWanted();
    snap();
    at(i * 60 + 20);
    ok(call(one(), 'report', { id: houseOf(), state: 'failed', exit: 1, log: `starting\nslack: invalid_auth (${i})` }));
    if (i < 3) assert.deepEqual(view().asks, [], `${i} restart(s): not a loop yet`);
  }
  const a = view().asks;
  assert.equal(a.length, 1, 'even with its snapshot still fresh');
  assert.deepEqual([a[0].text, a[0].kind], ['Art\'s slack bridge keeps restarting, since 14:01 UTC', 'alert']);
  assert.equal(a[0].meta, '3 restarts in 2 min, last error: slack: invalid_auth (3)');
  assert.deepEqual([row().badge, row().tone], ['restarting', 'bad']);
  at(300);
  startWanted();
  ok(call(one(), 'report', { id: houseOf(), state: 'failed', exit: 1, log: 'slack: invalid_auth (4)' }));
  const b = view().asks;
  assert.equal(b[0].text, a[0].text, 'the same ask while the loop lasts');
  assert.match(b[0].meta, /^4 restarts in /);
  // Fixed, it runs; once the restarts are out of the window it's steady, and says so once.
  at(400); startWanted(); snap();
  at(1200); snap();
  const m = view();
  assert.deepEqual(m.asks, []);
  assert.equal(m.notices.length, 1);
  assert.match(m.notices[0].text, /^Art's slack bridge is steady again after 4 restarts, back at 14:20 UTC$/);
});

test('a short blip leaves nothing; a long outage that recovers leaves one FYI, not an alert', () => {
  bridgeUp();
  at(120);
  view();
  at(130); snap();
  assert.deepEqual([view().asks, view().notices], [[], []], 'a blip');
  const w = join(env.LOOM_BOX_DATA, 'now-watch.json');
  assert.deepEqual(existsSync(w) ? JSON.parse(readFileSync(w, 'utf-8')).bridges : {}, {}, 'no outage noted');
  at(500);
  assert.equal(view().asks.length, 1, 'down');
  at(130 + 7 * 60); // it's back
  snap();
  const m = view();
  assert.deepEqual(m.asks, [], 'recovery clears the alert');
  assert.deepEqual(m.notices, [{ text: 'Art\'s slack bridge was down 7 min, back at 14:09 UTC', at: new Date(clock).toISOString(), agent: 'art', page: 'now' }]);
  at(130 + 8 * 60); snap();
  assert.equal(view().notices.length, 1, 'one FYI, not one per read');
});
