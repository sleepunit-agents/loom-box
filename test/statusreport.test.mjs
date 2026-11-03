// The off-box status board's reports (statusreport.mjs): what art-now-report.service sent, from the runtime's tick.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport, statusReporter, statusTargets, statusUrl } from '../src/statusreport.mjs';
import { scratch } from './scratch.mjs';

const TOKEN = 'tok-0123456789abcdef';

function world(more = {}) {
  const HOME = scratch('rt-status-');
  const env = { HOME, LOOM_BOX_DATA: join(HOME, 'data'), LOOM_RUNTIME_NOW_DIR: join(HOME, 'boards'), LOOM_RUNTIME_STATUS_URL: 'https://status.example.com/api/report', ...more };
  const board = (agent, bridge, snap) => {
    mkdirSync(join(env.LOOM_RUNTIME_NOW_DIR, `${agent}-now`), { recursive: true });
    writeFileSync(join(env.LOOM_RUNTIME_NOW_DIR, `${agent}-now`, `${bridge}.json`), JSON.stringify(snap));
  };
  return { env, board };
}
const snap = (at) => ({ v: 1, bridge: 'discord', at, interval_s: 15, slots: { used: 0, cap: 5 }, socket: { state: 'up' }, talking: [], waiting: [] });

function fakes({ secret = () => TOKEN, status = 204 } = {}) {
  const calls = [], logs = [], asked = [];
  let t = 1_793_700_000_000;
  const fx = {
    effects: { secret: (name, o) => { asked.push([name, o.agent]); return secret(name, o); } },
    fetch: async (url, o) => { calls.push({ url, ...o, report: JSON.parse(o.body) }); return { status: typeof status === 'function' ? status() : status }; },
    now: () => t,
    log: (m) => logs.push(m),
  };
  return { fx, calls, logs, asked, advance: (ms) => { t += ms; } };
}

describe('the status board report', () => {
  test('nothing is sent without a URL; only http(s)', async () => {
    const { env, board } = world({ LOOM_RUNTIME_STATUS_URL: '' });
    board('art', 'discord', snap(1));
    assert.equal(statusUrl(env), null);
    assert.deepEqual(statusTargets(env), []);
    const f = fakes();
    assert.deepEqual(await statusReporter(env, f.fx).tick(), []);
    assert.equal(f.calls.length, 0);
    assert.equal(statusUrl({ LOOM_RUNTIME_STATUS_URL: 'file:///etc/passwd' }), null);
  });

  test('by default every agent with a board reports, its token in <agent>-status-token; the setting names them', () => {
    const { env, board } = world();
    board('art', 'discord', snap(1));
    board('mark', 'discord', snap(1));
    assert.deepEqual(statusTargets(env), [{ agent: 'art', secret: 'art-status-token' }, { agent: 'mark', secret: 'mark-status-token' }]);
    assert.deepEqual(statusTargets({ ...env, LOOM_RUNTIME_STATUS_TOKENS: 'art:status-art, bad name:x, mark:../etc' }), [{ agent: 'art', secret: 'status-art' }]);
  });

  test('a v1 report: the agent\'s bridges as its board holds them (not convs.json), on this clock', () => {
    const { env, board } = world();
    board('art', 'discord', snap(100));
    board('art', 'slack', { ...snap(101), bridge: 'slack' });
    board('art', 'convs', { 'art|discord|1': {} });
    const r = buildReport(env, 'art', { nowS: 200, mem: () => 1234 });
    assert.deepEqual(Object.keys(r).sort(), ['agent', 'at', 'bridges', 'interval_s', 'plumbing', 'v']);
    assert.equal(r.v, 1);
    assert.equal(r.agent, 'art');
    assert.equal(r.at, 200);
    assert.ok(r.interval_s > 0 && r.interval_s <= 60);
    assert.deepEqual(r.plumbing, { mem_mb: 1234 });
    assert.deepEqual(Object.keys(r.bridges), ['discord', 'slack']);
    assert.equal(r.bridges.discord.at, 100);
    // An agent with no board yet still reports (up, no bridges).
    assert.deepEqual(buildReport(env, 'nobody', { nowS: 1, mem: () => null }).bridges, {});
  });

  test('it posts with the secret as a bearer token; the token is asked once, never logged', async () => {
    const { env, board } = world();
    board('art', 'discord', snap(1));
    const f = fakes();
    const rep = statusReporter(env, f.fx);
    const got = await rep.tick();
    assert.deepEqual(got, [{ agent: 'art', ok: true, status: 204 }]);
    assert.equal(f.calls[0].url, 'https://status.example.com/api/report');
    assert.equal(f.calls[0].method, 'POST');
    assert.equal(f.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(f.calls[0].report.agent, 'art');
    assert.ok(!f.calls[0].body.includes(TOKEN), 'the token is in the header, not the report');
    f.advance(10_000);
    await rep.tick();
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.asked, [['art-status-token', 'art']], 'kept in memory between ticks');
    assert.deepEqual(f.logs, [], 'sending fine says nothing');
  });

  test('a 401 drops the token (asked again next tick); a failure is logged once while it lasts, and its end once', async () => {
    const { env, board } = world();
    board('art', 'discord', snap(1));
    let code = 401;
    const f = fakes({ status: () => code });
    const rep = statusReporter(env, f.fx);
    await rep.tick();
    f.advance(10_000);
    await rep.tick();
    assert.equal(f.asked.length, 2);
    assert.deepEqual(f.logs, ['art: the board answered 401']);
    code = 204;
    f.advance(10_000);
    await rep.tick();
    f.advance(10_000);
    await rep.tick();
    assert.deepEqual(f.logs, ['art: the board answered 401', 'art: sending again']);
    assert.ok(f.logs.every((l) => !l.includes(TOKEN)));
  });

  test('no token: nothing is posted, the refusal is said (never a value), and it\'s tried again after a minute', async () => {
    const { env, board } = world();
    board('art', 'discord', snap(1));
    const f = fakes({ secret: () => { throw new Error('getting secret art-status-token for art: refused: ask for art'); } });
    const rep = statusReporter(env, f.fx);
    await rep.tick();
    f.advance(10_000);
    await rep.tick();
    assert.equal(f.calls.length, 0);
    assert.equal(f.asked.length, 1, 'not asked again within the minute');
    assert.equal(f.logs.length, 1);
    assert.match(f.logs[0], /^art: no token: getting secret art-status-token for art: refused/);
    f.advance(60_000);
    await rep.tick();
    assert.equal(f.asked.length, 2);
  });

  test('a send that throws (the board unreachable) is logged, and the tick goes on', async () => {
    const { env, board } = world();
    board('art', 'discord', snap(1));
    const f = fakes();
    f.fx.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
    const got = await statusReporter(env, f.fx).tick();
    assert.deepEqual(got, [{ agent: 'art', ok: false }]);
    assert.deepEqual(f.logs, ['art: send failed: connect ECONNREFUSED']);
  });
});
