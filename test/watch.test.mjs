// Keeping watch, boots and failed units (watch.mjs; loom docs/specs/keeping-watch.md, section 2 and "What the tests
// must pin"), through the real control plane's poll on one clock. Pins that
//  - a new boot id is one FYI (up and dark times; "its host restarted too" when the kernel changed) and one alert
//    command call; the same id again, or a box's first boot, is none;
//  - a failed unit is an Inbox alert and one alert command call (source unit-art-slack for art-slack.service); still
//    failed, no second call until 6 hours on ("(still)"); gone, an FYI and a cleared=1 call;
//  - looping: NRestarts rising by 3 in total over 15 minutes, one rise of 12 at once; 1 three times in 20 minutes is
//    not; a count that drops is a new baseline; it clears only after 15 minutes without a rise;
//  - LOOM_RUNTIME_UNITS_IGNORE is searched in the unit's name; journal lines are redacted.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { api } from '../src/control.mjs';
import { manifest } from '../src/ui.mjs';
import { bootInfo, redact, unitSampler, unitSource, watchOf } from '../src/watch.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { scratch } from './scratch.mjs';

let env, fx, clock, alerts;
const owner = { kind: 'owner' };
const T0 = Date.parse('2026-11-04T14:00:00Z');
const at = (s) => { clock = T0 + s * 1000; };
const box = { kind: 'piece', subject: 'one' };
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const K1 = '11111111-1111-1111-1111-111111111111';
const K2 = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  const HOME = scratch('rt-watch-');
  env = { HOME, LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(HOME, 'state'), LOOM_BOX_DATA: join(HOME, 'data'), LOOM_RUNTIME_NOW_DIR: join(HOME, 'boards') };
  at(0);
  alerts = [];
  fx = { now: () => new Date(clock), mint: () => `loom_${'x'.repeat(30)}`, revoke: () => {}, secret: (n) => `v:${n}`, alert: (_e, a) => { alerts.push(a); return true; } };
  ok(call(owner, 'set-agent', { agent: 'art', repo: 'https://x/art.git' }));
});

const failed = (unit, log = ['2026-11-04T08:00:00-0600 loom art-slack[12]: Error: EADDRINUSE']) => ({ at: new Date(clock).toISOString(), units: [{ unit, scope: 'user', state: 'failed', result: 'exit-code', log }] });
const none = () => ({ at: new Date(clock).toISOString(), units: [] });

test('a box back from a boot: one FYI with its up and dark times and one alert; the same boot again, none; its first, none', () => {
  ok(call(box, 'poll', { boot: { id: `${K1}:100`, kernel: K1, up: 5000 } }));
  assert.equal(alerts.length, 0);
  at(60);
  ok(call(box, 'poll', { boot: { id: `${K1}:100`, kernel: K1, up: 5060 } }));
  assert.equal(alerts.length, 0);
  // Dark from 60 s to 420 s (the boot, 40 s before the poll at 460 s): 360 s, 6 min.
  at(460);
  ok(call(box, 'poll', { boot: { id: `${K1}:9000`, kernel: K1, up: 40 } }));
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].source, alerts[0].severity], ['box-boot', 'warn']);
  assert.equal(alerts[0].facts.dark_s, 360);
  assert.equal(alerts[0].facts.kernel_restarted, 0);
  const fyi = manifest(env).notices.find((n) => /came back/.test(n.text));
  assert.match(fyi.text, /^one came back at 14:07 UTC, up 40 s after being dark 6 min$/);
  // The host too: the kernel's id changed.
  at(1000);
  ok(call(box, 'poll', { boot: { id: `${K2}:50`, kernel: K2, up: 30 } }));
  assert.equal(alerts[1].facts.kernel_restarted, 1);
  assert.match(manifest(env).notices[0].text, /Its host restarted too/);
});

test('a failed unit: an Inbox alert and one call; still failed, none until 6 hours on; gone, an FYI and cleared=1', () => {
  ok(call(box, 'poll', { units: failed('art-slack.service') }));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].source, 'unit-art-slack');
  assert.equal(alerts[0].severity, 'bad');
  assert.equal(alerts[0].summary, 'art-slack.service failed on one');
  assert.match(alerts[0].facts.log, /EADDRINUSE/);
  const ask = manifest(env).asks.find((a) => /art-slack/.test(a.text));
  assert.equal(ask.text, 'art-slack.service failed on one');
  assert.equal(ask.kind, 'alert');
  assert.match(ask.meta, /EADDRINUSE/);
  at(60); ok(call(box, 'poll', { units: failed('art-slack.service') }));
  at(5 * 3600); ok(call(box, 'poll', { units: failed('art-slack.service') }));
  assert.equal(alerts.length, 1);
  at(6 * 3600 + 5); ok(call(box, 'poll', { units: failed('art-slack.service') }));
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].summary, 'art-slack.service failed on one (still)');
  assert.equal(alerts[1].facts.minutes, 360);
  // A poll without a units sample changes nothing.
  at(6 * 3600 + 30); ok(call(box, 'poll', {}));
  assert.equal(alerts.length, 2);
  at(6 * 3600 + 60); ok(call(box, 'poll', { units: none() }));
  assert.equal(alerts.length, 3);
  assert.deepEqual([alerts[2].source, alerts[2].facts.cleared], ['unit-art-slack', 1]);
  assert.equal(manifest(env).asks.filter((a) => /art-slack/.test(a.text)).length, 0);
  assert.match(manifest(env).notices[0].text, /^art-slack\.service on one is OK again \(failed for 6 h\)$/);
});

test('unit sources: as art-unit-alert named them', () => {
  assert.equal(unitSource('art-slack.service'), 'unit-art-slack');
  assert.equal(unitSource('art-alert@loom-http.service'), 'unit-art-alert-loom-http');
  assert.equal(unitSource('Some_Unit.timer'), 'unit-some-unit-timer');
  assert.equal(unitSource('a'.repeat(50) + '.service').length, 39);
});

/** A sampler over a scripted systemctl: each sample's NRestarts for one user service, art-shuttle. */
function scripted(counts, o = {}) {
  let i = 0, n = 0;
  const run = (argv) => {
    if (argv[0] === 'journalctl') return '2026-11-04T08:00:00-0600 loom node[9]: token=abc123secret failed\n2026-11-04T08:00:01-0600 loom systemd[1]: art-shuttle.service: Failed\n';
    if (argv.includes('--user')) return `Id=art-shuttle.service\nActiveState=${o.state ?? 'activating'}\nSubState=auto-restart\nResult=exit-code\nNRestarts=${n}\n\nId=art-other.service\nActiveState=failed\nResult=exit-code\nNRestarts=\n`;
    return '';
  };
  const sample = unitSampler(o.env ?? {}, { run });
  return (ms) => { n = counts[i++]; return sample(ms); };
}

test('looping: a rise of 12 at once is looping; 1 three times in 20 minutes is not; a drop is a new baseline; it ends 15 minutes after its last rise', () => {
  const s = scripted([0, 12, 12, 12]);
  const loop = (r) => r.units.find((u) => u.unit === 'art-shuttle.service');
  assert.equal(loop(s(T0)), undefined);
  const r = s(T0 + 60_000);
  assert.equal(loop(r).state, 'looping');
  assert.equal(loop(r).restarts, 12);
  // The journal's lines: systemd's own dropped, a token redacted.
  assert.deepEqual(loop(r).log, ['2026-11-04T08:00:00-0600 loom node[9]: token=[REDACTED] failed']);
  assert.equal(loop(s(T0 + 14 * 60_000)).state, 'looping');
  assert.equal(loop(s(T0 + 16 * 60_000)), undefined);

  const slow = scripted([0, 1, 1, 2, 2, 3]);
  for (let m = 0; m <= 20; m += 4) assert.equal(loop(slow(T0 + m * 60_000)), undefined, `minute ${m}`);

  const reset = scripted([5, 0, 1, 2]);
  for (let m = 0; m < 4; m++) assert.equal(loop(reset(T0 + m * 60_000)), undefined, `sample ${m}`);
});

test('failed units come from systemctl show; LOOM_RUNTIME_UNITS_IGNORE is searched in the name', () => {
  const s = scripted([0], { env: {} });
  assert.deepEqual(s(T0).units.map((u) => [u.unit, u.state]), [['art-other.service', 'failed']]);
  const quiet = scripted([0], { env: { LOOM_RUNTIME_UNITS_IGNORE: '^art-oth' } });
  assert.deepEqual(quiet(T0).units, []);
});

test('the control plane takes a looping unit as one alert, and its end as one cleared', () => {
  const looping = (n) => ({ at: new Date(clock).toISOString(), units: [{ unit: 'art-shuttle.service', scope: 'user', state: 'looping', restarts: n, log: [] }] });
  ok(call(box, 'poll', { units: looping(12) }));
  at(60); ok(call(box, 'poll', { units: looping(14) }));
  assert.deepEqual(alerts.map((a) => a.summary), ['art-shuttle.service keeps restarting on one']);
  assert.equal(alerts[0].facts.restarts, 12);
  assert.match(manifest(env).asks.find((a) => /shuttle/.test(a.text)).text, /keeps restarting on one/);
  at(1000); ok(call(box, 'poll', { units: none() }));
  assert.equal(alerts[1].facts.cleared, 1);
  assert.match(manifest(env).notices[0].text, /kept restarting for/);
});

test('a box that isn\'t enrolled says nothing to the watch', () => {
  const r = call({ kind: 'piece', subject: 'nobody' }, 'poll', { boot: { id: `${K1}:1`, kernel: K1, up: 1 }, units: failed('x.service') });
  assert.equal(r.status, 403);
  assert.deepEqual(watchOf(env).boxes, {});
  assert.equal(alerts.length, 0);
});

test('bootInfo reads a container\'s boot: the kernel\'s id, PID 1\'s start, uptime', () => {
  const root = scratch('rt-boot-');
  mkdirSync(join(root, 'proc/sys/kernel/random'), { recursive: true });
  mkdirSync(join(root, 'proc/1'), { recursive: true });
  writeFileSync(join(root, 'proc/sys/kernel/random/boot_id'), `${K1}\n`);
  writeFileSync(join(root, 'proc/1/stat'), '1 (systemd (x)) S 0 1 1 0 -1 4194560 120 0 0 0 1 2 0 0 20 0 1 0 114291372 23000 3000 18446744073709551615\n');
  writeFileSync(join(root, 'proc/uptime'), '453415.97 453415.97\n');
  assert.deepEqual(bootInfo(root), { id: `${K1}:114291372`, kernel: K1, up: 453416 });
  assert.equal(bootInfo(join(root, 'nope')), null);
});

test('redact: webhook URLs, bearer tokens, key=value secrets, sk- and loom_ tokens', () => {
  const r = redact('hook https://discord.com/api/webhooks/123/abcDEF auth Authorization: Bearer xyz password=hunter2 sk-abcdefghijklmnopqrstu loom_abcdefghijklmnopqrstuvwx');
  assert.doesNotMatch(r, /abcDEF|xyz|hunter2|abcdefghijklmnopqrstu|loom_abcdefghij/);
});
