// Box health (health.mjs, watch.mjs; loom docs/specs/keeping-watch.md, section 3 and "What the tests must pin").
// Pins that
//  - the sampler reads a Proxmox host's fake root (test/fixtures/proxmox) into the sample the rules expect, rates
//    over its 5 s window, SMART and container names from a fresh root-health.json, none from a stale one;
//  - an LXC container (test/fixtures/lxc) reports its cgroup's pressure, not /proc/pressure's, and no disks or ZFS;
//    a non-lxc container leaves out memory and load too;
//  - a condition alerts once it has held for its `for`, once; "(still)" 6 hours on; cleared, an FYI and cleared=1;
//    a gap (condition, none, condition) starts it over; a sample without its reading neither holds nor ends it;
//  - an always-on box silent 10 minutes is dark from a manifest read alone; its next poll clears it; a box not
//    always on never is; neither is any while the runtime's own box has been up under 10 minutes;
//  - a report-only box gets no houses, sessions, sign-ins or version, and claim refuses it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { api } from '../src/control.mjs';
import { runner } from '../src/box.mjs';
import { manifest } from '../src/ui.mjs';
import { problems, sampleHealth } from '../src/health.mjs';
import { watchOf } from '../src/watch.mjs';
import { scratch } from './scratch.mjs';

const FIX = new URL('./fixtures/', import.meta.url).pathname;
const statfs = (p) => (p.endsWith('/mnt/media') ? { blocks: 1000, bfree: 50, bavail: 40 } : { blocks: 1000, bfree: 500, bavail: 450 });
const runFor = (virt, zpool = 'rpool\tONLINE\t72%\n') => (argv) => (argv[0] === 'systemd-detect-virt' ? `${virt}\n` : argv[0] === 'zpool' ? zpool : null);

async function proxmoxSample(o = {}) {
  const root = scratch('rt-health-root-');
  cpSync(join(FIX, 'proxmox'), root, { recursive: true });
  const nowS = Math.round(Date.parse('2026-11-04T14:00:00Z') / 1000);
  writeFileSync(join(root, 'run/loom-box/root-health.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, 'run/loom-box/root-health.json'), 'utf-8')), t: nowS - (o.rootAge ?? 60) }));
  const sleep = async () => {
    // Five seconds later: sda took 10 reads at 400 ms each and was busy 4.5 s of 5; arc_prune ran 600 times.
    writeFileSync(join(root, 'proc/diskstats'), '   8       0 sda 1010 0 80800 34000 2000 0 160000 60000 0 8500 94000\n 259       0 nvme0n1 510 0 4100 101 510 0 4100 101 0 110 210\n');
    const arc = readFileSync(join(root, 'proc/spl/kstat/zfs/arcstats'), 'utf-8').replace(/arc_prune( +)4( +)1000/, 'arc_prune$14$21600');
    writeFileSync(join(root, 'proc/spl/kstat/zfs/arcstats'), arc);
  };
  return sampleHealth({ root, run: runFor('none', o.zpool), sleep, statfs, windowS: 5, cpus: 32, now: nowS * 1000 });
}

test('a Proxmox host: the sample the rules expect, rates over the 5 s window, SMART and names from root-health.json', async () => {
  const s = await proxmoxSample();
  assert.equal(s.container, null);
  assert.deepEqual(s.load, [24.5, 20.1, 18]);
  assert.equal(s.psi.io.full, 52);
  assert.deepEqual(s.fs, [{ mount: '/', used_pct: 52.6 }, { mount: '/mnt/media', used_pct: 96 }]);
  assert.equal(s.disks.sda.util, 90);
  assert.equal(s.disks.sda.r_await, 400);
  assert.equal(s.disks.sda.rotational, true);
  assert.equal(s.arc.prune_per_s, 120);
  assert.deepEqual(s.pools, [{ name: 'rpool', health: 'ONLINE', cap: 72 }]);
  assert.equal(s.containers['103'].name, 'loom');
  assert.equal(s.smart.sda.reallocated, 8);
  const keys = Object.keys(problems(s, 'wunder')).sort();
  assert.deepEqual(keys, ['arc-prune', 'ct-io-103', 'ct-mem-104', 'disk-sda', 'fs-/mnt/media', 'io', 'mem', 'smart-sda']);
  assert.equal(problems(s, 'wunder')['arc-prune'].title, 'wunder: ZFS\'s cache is thrashing');
  assert.match(problems(s, 'wunder')['ct-io-103'].detail, /CT 103 \(loom\) waiting on disk 45%/);
});

test('a root-health.json over 30 minutes old is ignored; no zpool is pools unread', async () => {
  const s = await proxmoxSample({ rootAge: 31 * 60, zpool: null });
  assert.equal(s.smart, null);
  assert.equal(s.containers['103'].name, undefined);
  assert.equal(s.pools, null);
  assert.deepEqual(s.unread.sort(), ['pools', 'smart']);
});

test('an LXC container reports its cgroup\'s pressure, its lxcfs memory, and no disks or ZFS; another container leaves memory out too', async () => {
  const root = join(FIX, 'lxc');
  const s = await sampleHealth({ root, run: runFor('lxc'), sleep: async () => {}, statfs, windowS: 5, cpus: 4 });
  assert.equal(s.container, 'lxc');
  assert.equal(s.psi.io.full, 0.28);
  assert.equal(s.disks, null);
  assert.equal(s.pools, null);
  assert.equal(s.arc, null);
  assert.equal(s.mem.total, 16777216 * 1024);
  assert.deepEqual(Object.keys(problems(s, 'loom')).sort(), ['mem', 'swap']);
  const p = await sampleHealth({ root, run: runFor('podman'), sleep: async () => {}, statfs, windowS: 5, cpus: 4 });
  assert.equal(p.mem, null);
  assert.equal(p.load, null);
  assert.deepEqual(Object.keys(problems(p, 'x')), []);
});

// ─── The control plane ──────────────────────────────────────────────────────────────────────────────────────────

let env, fx, clock, alerts;
const owner = { kind: 'owner' };
const T0 = Date.parse('2026-11-04T14:00:00Z');
const at = (s) => { clock = T0 + s * 1000; };
const local = { kind: 'piece', subject: 'one' };
const call = (caller, path, body = {}) => api(env, fx, { caller, path, body });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const sampleWith = (o = {}) => ({ t: Math.round(clock / 1000), container: null, load: [1, 1, 1], cpus: 4, mem: { total: 100, available: 50, swap_total: 0, swap_free: 0 },
  psi: { io: { some: 1, full: o.io ?? 0 } }, fs: [], disks: {}, arc: null, pools: o.pools === undefined ? [{ name: 'rpool', health: 'ONLINE', cap: 50 }] : o.pools, containers: null, smart: {}, unread: o.unread ?? [] });

beforeEach(() => {
  const HOME = scratch('rt-health-');
  env = { HOME, LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(HOME, 'state'), LOOM_BOX_DATA: join(HOME, 'data'), LOOM_RUNTIME_NOW_DIR: join(HOME, 'boards') };
  at(0);
  alerts = [];
  fx = { now: () => new Date(clock), mint: () => `loom_${'x'.repeat(30)}`, revoke: () => {}, secret: (n) => `v:${n}`, alert: (_e, a) => { alerts.push(a); return true; } };
  ok(call(owner, 'set-agent', { agent: 'art', repo: 'https://x/art.git' }));
});

const poll = (s, body) => { at(s); return ok(call(local, 'poll', body)); };
const healthAlerts = () => alerts.filter((a) => a.source === 'box-health');

test('a condition alerts once it has held its for, once; "(still)" 6 hours on; cleared, an FYI and cleared=1', () => {
  for (let m = 0; m <= 9; m++) poll(m * 60, { health: sampleWith({ io: 60 }) });
  assert.equal(healthAlerts().length, 0);
  poll(10 * 60, { health: sampleWith({ io: 60 }) });
  assert.deepEqual(healthAlerts().map((a) => [a.summary, a.facts.key, a.facts.minutes]), [['one is stalled on disk', 'io', 10]]);
  const ask = manifest(env, clock).asks.find((a) => a.text === 'one is stalled on disk');
  assert.equal(ask.kind, 'alert');
  for (let m = 11; m < 6 * 60 + 10; m += 30) poll(m * 60, { health: sampleWith({ io: 60 }) });
  assert.equal(healthAlerts().length, 1);
  poll((6 * 60 + 11) * 60, { health: sampleWith({ io: 60 }) });
  assert.equal(healthAlerts()[1].summary, 'one is stalled on disk (still)');
  poll((6 * 60 + 12) * 60, { health: sampleWith({ io: 0 }) });
  assert.equal(healthAlerts()[2].facts.cleared, 1);
  assert.equal(manifest(env, clock).asks.filter((a) => a.text === 'one is stalled on disk').length, 0);
  assert.match(manifest(env, clock).notices[0].text, /^one is stalled on disk: OK again after 6 h$/);
});

test('a gap starts it over: condition, none, condition for longer than its for in all does not alert', () => {
  for (let m = 0; m < 8; m++) poll(m * 60, { health: sampleWith({ io: 60 }) });
  poll(8 * 60, { health: sampleWith({ io: 0 }) });
  for (let m = 9; m < 18; m++) poll(m * 60, { health: sampleWith({ io: 60 }) });
  assert.equal(healthAlerts().length, 0);
});

test('a sample without its reading neither holds nor ends a condition; unread for 30 minutes is its own', () => {
  poll(0, { health: sampleWith({ pools: [{ name: 'rpool', health: 'DEGRADED', cap: 50 }] }) });
  assert.deepEqual(healthAlerts().map((a) => [a.summary, a.severity]), [['one: ZFS pool rpool is DEGRADED', 'bad']]);
  // zpool stops answering: not an all-clear.
  for (let m = 1; m < 30; m++) poll(m * 60, { health: sampleWith({ pools: null, unread: ['pools'] }) });
  assert.equal(healthAlerts().length, 1);
  assert.ok(manifest(env, clock).asks.find((a) => /DEGRADED/.test(a.text)));
  poll(30 * 60, { health: sampleWith({ pools: null, unread: ['pools'] }) });
  assert.deepEqual(healthAlerts().map((a) => a.facts.key), ['pool-rpool', 'unread-pools']);
  // It reads again, and the pool's fine: now it's over.
  poll(31 * 60, { health: sampleWith() });
  assert.deepEqual(healthAlerts().slice(2).map((a) => [a.facts.key, a.facts.cleared]).sort(), [['pool-rpool', 1], ['unread-pools', 1]]);
});

const boxId = (name) => Object.entries(JSON.parse(readFileSync(join(env.LOOM_BOX_HOME, 'state.json'), 'utf-8')).boxes).find(([, b]) => b.name === name)?.[0] ?? name;

test('dark: an always-on box silent 10 minutes, from a manifest read alone; its next poll clears it; others never', () => {
  ok(call(owner, 'add-box', { name: 'thor', mayHost: '*' }));
  ok(call(owner, 'add-box', { name: 'laptop', mayHost: '*' }));
  const thor = { kind: 'piece', subject: boxId('thor') }, laptop = { kind: 'piece', subject: boxId('laptop') };
  ok(call(owner, 'box-watch', { name: 'thor', alwaysOn: 'on' }));
  // loom's own box polls to 10.5 min; thor and the laptop last spoke at 1 min, so on those polls nothing is dark yet...
  for (let m = 0; m <= 10; m++) { poll(m * 60, {}); if (m === 1) { ok(call(thor, 'poll', {})); ok(call(laptop, 'poll', {})); } }
  poll(630, {});
  assert.equal(healthAlerts().length, 0);
  const before = healthAlerts().length;
  // ...and the manifest alone, at 11 min with no poll in between, finds thor dark (laptop isn't always on).
  at(11 * 60 + 30); manifest(env, clock, fx);
  assert.deepEqual(healthAlerts().slice(before).map((a) => [a.summary, a.severity]), [['thor is dark', 'bad']]);
  assert.ok(manifest(env, clock).asks.find((a) => a.text === 'thor is dark'));
  at(13 * 60); ok(call(thor, 'poll', {}));
  assert.deepEqual([healthAlerts().at(-1).summary, healthAlerts().at(-1).facts.cleared], ['thor is back', 1]);
  assert.equal(manifest(env, clock).asks.filter((a) => /thor/.test(a.text)).length, 0);
  assert.equal(healthAlerts().filter((a) => /laptop/.test(a.summary)).length, 0);
});

test('nobody is dark until the runtime\'s own box has been up 10 minutes, and polling now', () => {
  ok(call(owner, 'add-box', { name: 'thor', mayHost: '*' }));
  const thor = { kind: 'piece', subject: boxId('thor') };
  ok(call(owner, 'box-watch', { name: 'thor', alwaysOn: 'on' }));
  ok(call(thor, 'poll', {}));
  // The runtime comes up at 30 min (thor quiet 30 min): not for its first 10.
  for (let m = 30; m <= 39; m++) poll(m * 60, {});
  at(39 * 60 + 30); manifest(env, clock, fx);
  assert.equal(healthAlerts().length, 0);
  poll(40 * 60, {}); poll(41 * 60, {});
  assert.deepEqual(healthAlerts().map((a) => a.summary), ['thor is dark']);
  // The runtime down from 41 min to 3 h: thor's first poll back can't make anyone else dark.
  ok(call(owner, 'add-box', { name: 'odin', mayHost: '*' }));
  ok(call(owner, 'box-watch', { name: 'odin', alwaysOn: 'on' }));
  at(3 * 3600); ok(call(thor, 'poll', {}));
  at(3 * 3600 + 30); manifest(env, clock, fx);
  assert.equal(healthAlerts().filter((a) => /odin/.test(a.summary)).length, 0);
});

/** Each rule, from samples that hold it: not before its `for`, once at it. */
const RULES = [
  ['io', 10, () => ({ psi: { io: { some: 60, full: 60 } } })],
  ['ct-io-103', 15, () => ({ containers: { 103: { io: { some: 45 } } } })],
  ['ct-mem-104', 10, () => ({ containers: { 104: { memory: { some: 25 } } } })],
  ['disk-sda', 10, () => ({ disks: { sda: { rotational: true, util: 90, r_await: 400 } } })],
  ['disk-nvme0n1', 10, () => ({ disks: { nvme0n1: { rotational: false, util: 90, w_await: 35 } } })],
  ['arc-prune', 5, () => ({ arc: { prune_per_s: 150 } })],
  ['pool-rpool', 0, () => ({ pools: [{ name: 'rpool', health: 'DEGRADED', cap: 50 }] })],
  ['pool-full-rpool', 0, () => ({ pools: [{ name: 'rpool', health: 'ONLINE', cap: 86 }] })],
  ['fs-/', 10, () => ({ fs: [{ mount: '/', used_pct: 91 }] })],
  ['mem', 10, () => ({ mem: { total: 100, available: 7, swap_total: 0, swap_free: 0 } })],
  ['swap', 10, () => ({ mem: { total: 100, available: 20, swap_total: 100, swap_free: 10 } })],
  ['swap', 10, () => ({ mem: { total: 100, available: 50, swap_total: 100, swap_free: 10 }, psi: { io: { some: 1, full: 0 }, memory: { some: 12, full: 1 } } }), 'memory stalling'],
  ...[['passed', false], ['reallocated', 1], ['pending', 1], ['media_errors', 1], ['wear_pct', 80], ['temp_c', 56]].map(([k, v]) => [`smart-sda`, 0, () => ({ smart: { sda: { [k]: v } } }), k]),
  ['smart-nvme0n1', 0, () => ({ smart: { nvme0n1: { temp_c: 70 } } }), 'nvme hot'],
];
test('rule swap: full swap with memory free and no stall never fires', () => {
  for (let m = 0; m <= 15; m++) poll(m * 60, { health: { ...sampleWith(), mem: { total: 100, available: 60, swap_total: 100, swap_free: 5 }, psi: { io: { some: 0, full: 0 }, memory: { some: 0.3, full: 0 } }, t: Math.round((T0 + m * 60_000) / 1000) } });
  assert.equal(healthAlerts().length, 0);
});
for (const [key, mins, extra, why] of RULES) {
  test(`rule ${key}${why ? ` (${why})` : ''}: not before ${mins} min, once at it`, () => {
    const s = (m) => ({ ...sampleWith(), ...extra(), t: Math.round((T0 + m * 60_000) / 1000) });
    for (let m = 0; m < mins; m++) { poll(m * 60, { health: s(m) }); assert.equal(healthAlerts().length, 0, `minute ${m}`); }
    poll(mins * 60, { health: s(mins) });
    assert.deepEqual(healthAlerts().map((a) => a.facts.key), [key]);
    poll(mins * 60 + 60, { health: s(mins + 1) });
    assert.equal(healthAlerts().length, 1);
  });
}
// The thresholds' other side: just under each is nothing.
test('just under each threshold, nothing', () => {
  const under = [{ psi: { io: { some: 49, full: 49 } } }, { arc: { prune_per_s: 99 } }, { pools: [{ name: 'rpool', health: 'ONLINE', cap: 84 }] }, { fs: [{ mount: '/', used_pct: 89.9 }] },
    { disks: { nvme0n1: { rotational: false, util: 90, w_await: 29 } } }, { disks: { sda: { rotational: true, util: 79, r_await: 900 } } }, { smart: { sda: { temp_c: 54, wear_pct: 79 } } }];
  for (const u of under) assert.deepEqual(Object.keys(problems({ ...sampleWith(), ...u }, 'x')), [], JSON.stringify(u));
});

test('a report-only box: no houses, sessions, sign-ins or version from poll, and claim refuses it', () => {
  ok(call(owner, 'add-box', { name: 'wunder', mayHost: '*' }));
  const id = Object.entries(JSON.parse(readFileSync(join(env.LOOM_BOX_HOME, 'state.json'), 'utf-8')).boxes).find(([, b]) => b.name === 'wunder')?.[0] ?? 'wunder';
  const wunder = { kind: 'piece', subject: id };
  ok(call(owner, 'set-primary', { agent: 'art', box: 'wunder' }));
  ok(call(owner, 'up', { agent: 'art', box: 'wunder', task: 'x' }));
  const before = ok(call(wunder, 'poll', {}));
  assert.equal(before.start.length, 1);
  const p = ok(call(wunder, 'poll', { reportOnly: true }));
  assert.deepEqual([p.start, p.bodyHosts, p.remotes, p.logins, p.version, p.reportOnly], [[], [], [], [], undefined, true]);
  assert.equal(call(wunder, 'claim', { id: before.start[0].id }).status, 403);
  // A box can't take it back itself; the owner can, and the box saying report-only on every poll doesn't undo that.
  ok(call(wunder, 'poll', { reportOnly: false }));
  assert.equal(ok(call(wunder, 'poll', {})).reportOnly, true);
  ok(call(owner, 'box-watch', { name: 'wunder', reportOnly: 'off' }));
  assert.equal(ok(call(wunder, 'poll', { reportOnly: true })).start.length, 1);
  assert.equal(ok(call(wunder, 'poll', { reportOnly: true })).reportOnly, undefined);
  assert.ok(watchOf(env).boxes[id]);
});

test('what a box can send is bounded: one sample per 50 s, capped lists, strict names, printable text, few new conditions', async () => {
  const bad = {
    ...sampleWith(),
    pools: [...Array.from({ length: 40 }, (_, i) => ({ name: `p${i}`, health: 'FAULTED', cap: 99 })), { name: 'evil\u001b[2J', health: 'FAULTED', cap: 99 }],
    fs: [{ mount: '/ok', used_pct: 99 }, { mount: '/x\u001b]0;pwned\u0007', used_pct: 99 }, { mount: 'relative', used_pct: 99 }],
    disks: { sda: { util: 1 }, 'sd$(rm)': { util: 99, r_await: 999 } },
    containers: { 103: { name: 'loom\u009b', io: { some: 0 } }, abc: { io: { some: 99 } } },
    container: 'lxc\u0000x', extra: 'x'.repeat(100000),
  };
  poll(0, { health: bad });
  const w = watchOf(env).boxes.one;
  assert.equal(w.health.pools.length, 32);
  assert.ok(!JSON.stringify(w.health).match(/[\u0000-\u001f\u007f-\u009f]/));
  assert.deepEqual(w.health.fs.map((f) => f.mount), ['/ok']);
  assert.deepEqual(Object.keys(w.health.disks), ['sda']);
  assert.deepEqual(Object.keys(w.health.containers), ['103']);
  assert.equal(w.health.containers['103'].name, undefined);
  assert.equal(w.health.extra, undefined);
  // 32 pools faulted at once: only so many conditions open from one sample.
  assert.ok(Object.keys(w.conditions).length <= 16, String(Object.keys(w.conditions).length));
  assert.ok(healthAlerts().length <= 16);
  // A second sample 10 s later is dropped, history and all.
  const n = healthAlerts().length;
  poll(10, { health: sampleWith({ io: 99 }) });
  assert.equal(watchOf(env).boxes.one.healthAt, new Date(T0).toISOString());
  assert.equal(healthAlerts().length, n);
  const hist = readFileSync(join(env.LOOM_BOX_DATA, 'health', `one-${new Date(T0).toISOString().slice(0, 7)}.jsonl`), 'utf-8').trim().split('\n');
  assert.equal(hist.length, 1);
  // The alert command and the page get the same clean text.
  assert.ok(!JSON.stringify(alerts).match(/[\u0000-\u001f\u007f-\u009f]/));
  assert.ok(!JSON.stringify(manifest(env, clock)).match(/[\u0000-\u001f\u007f-\u009f]/));
});

test('loom runtime health escapes what it prints, whatever the watch holds', () => {
  poll(0, { health: sampleWith() });
  const f = join(env.LOOM_BOX_DATA, 'box-watch.json');
  const w = JSON.parse(readFileSync(f, 'utf-8'));
  w.boxes.one.conditions = { x: { title: 'bad\u001b[31mred', detail: 'd\u0007', since: 'now' } };
  writeFileSync(f, JSON.stringify(w));
  const r = spawnSync(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, 'health'], { env: { ...process.env, ...env }, encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bad\\x1b\[31mred: d\\x07/);
  assert.doesNotMatch(r.stdout, /\u001b/);
});

test('each threshold at equality alerts (≥, not >)', () => {
  const at = [['io', { psi: { io: { some: 50, full: 50 } } }], ['arc-prune', { arc: { prune_per_s: 100 } }], ['pool-full-rpool', { pools: [{ name: 'rpool', health: 'ONLINE', cap: 85 }] }],
    ['fs-/', { fs: [{ mount: '/', used_pct: 90 }] }], ['disk-sda', { disks: { sda: { rotational: true, util: 80, r_await: 300 } } }], ['disk-nvme0n1', { disks: { nvme0n1: { rotational: false, util: 80, w_await: 30 } } }],
    ['ct-io-1', { containers: { 1: { io: { some: 40 } } } }], ['ct-mem-1', { containers: { 1: { memory: { some: 20 } } } }], ['smart-sda', { smart: { sda: { temp_c: 55 } } }], ['smart-sda', { smart: { sda: { wear_pct: 80 } } }]];
  for (const [key, x] of at) assert.ok(problems({ ...sampleWith(), ...x }, 'x')[key], `${key} at ${JSON.stringify(x)}`);
});

test('an episode keeps its first title (the Inbox pushes once); its detail follows the samples', () => {
  poll(0, { health: sampleWith({ pools: [{ name: 'rpool', health: 'DEGRADED', cap: 50 }] }) });
  poll(60, { health: sampleWith({ pools: [{ name: 'rpool', health: 'FAULTED', cap: 50 }] }) });
  const c = watchOf(env).boxes.one.conditions['pool-rpool'];
  assert.equal(c.title, 'one: ZFS pool rpool is DEGRADED');
  assert.match(c.detail, /FAULTED/);
});

test('loom\'s own box quiet: it is the dark one, and no other is judged', () => {
  ok(call(owner, 'add-box', { name: 'thor', mayHost: '*' }));
  const thor = { kind: 'piece', subject: boxId('thor') };
  ok(call(owner, 'box-watch', { name: 'thor', alwaysOn: 'on' }));
  for (let m = 0; m <= 12; m++) { poll(m * 60, {}); if (m === 0) ok(call(thor, 'poll', {})); }
  const n = healthAlerts().length;
  // loom's own runner stops at 12 min; at 30 the manifest (loom's listeners still answering) reads.
  at(30 * 60); manifest(env, clock, fx);
  assert.deepEqual(healthAlerts().slice(n).map((a) => a.summary), ['one is dark']);
});

test('a report-only box never upgrades itself from what loom says', async () => {
  let upgrades = 0, now = T0;
  const client = { async call() { return { version: 'f'.repeat(40) }; } };
  const r = runner({ ...env, LOOM_BOX_PODMAN: '/bin/false' }, client, { loomUrl: 'http://x/mcp', log: () => {}, clock: () => now, status: () => ({}), sweep: () => [], runtime: () => ({}), codexUsage: () => null,
    upgrade: () => { upgrades++; return null; }, reportOnly: true, sampleUnits: async () => ({ at: '', units: [] }), sampleHealth: async () => null, bootInfo: () => null });
  await r.tick(); await r.settled();
  assert.equal(upgrades, 0);
  const r2 = runner({ ...env, LOOM_BOX_PODMAN: '/bin/false' }, client, { loomUrl: 'http://x/mcp', log: () => {}, clock: () => now, status: () => ({}), sweep: () => [], runtime: () => ({}), codexUsage: () => null,
    upgrade: () => { upgrades++; return null; }, reportOnly: false, sampleUnits: async () => ({ at: '', units: [] }), sampleHealth: async () => null, bootInfo: () => null });
  await r2.tick();
  assert.equal(upgrades, 1);
});

test('an install that already ran section 2 (its own box polled 15 s ago, no upSince): dark still fires after 10 minutes', () => {
  ok(call(owner, 'add-box', { name: 'thor', mayHost: '*' }));
  ok(call(owner, 'box-watch', { name: 'thor', alwaysOn: 'on' }));
  const f = join(env.LOOM_BOX_DATA, 'box-watch.json');
  poll(0, {}); ok(call({ kind: 'piece', subject: boxId('thor') }, 'poll', {}));
  const w = JSON.parse(readFileSync(f, 'utf-8')); delete w.boxes.one.upSince; writeFileSync(f, JSON.stringify(w));
  for (let m = 1; m <= 13; m++) poll(m * 60, {});
  assert.deepEqual(healthAlerts().map((a) => a.summary), ['thor is dark']);
});

test('severities: a pool full or unhealthy, SMART and dark are bad; the rest warn', () => {
  const sev = (x) => Object.values(problems({ ...sampleWith(), ...x }, 'x'))[0]?.severity;
  assert.equal(sev({ pools: [{ name: 'rpool', health: 'ONLINE', cap: 90 }] }), 'bad');
  assert.equal(sev({ pools: [{ name: 'rpool', health: 'DEGRADED', cap: 50 }] }), 'bad');
  assert.equal(sev({ smart: { sda: { pending: 1 } } }), 'bad');
  assert.equal(sev({ fs: [{ mount: '/', used_pct: 95 }] }), 'warn');
  assert.equal(sev({ psi: { io: { some: 60, full: 60 } } }), 'warn');
});

test('a sample with an odd load is no load, and words never throw; one box shows five alerts at most', () => {
  poll(0, { health: { ...sampleWith(), load: [] } });
  assert.equal(watchOf(env).boxes.one.health.load, null);
  assert.doesNotThrow(() => manifest(env, clock));
  const many = { ...sampleWith(), fs: Array.from({ length: 12 }, (_, i) => ({ mount: `/m${i}`, used_pct: 99 })), pools: Array.from({ length: 4 }, (_, i) => ({ name: `p${i}`, health: 'FAULTED', cap: 10 })) };
  for (let m = 1; m <= 12; m++) poll(m * 60, { health: many });
  const asks = manifest(env, clock).asks.filter((a) => a.text.startsWith('one'));
  assert.equal(asks.length, 5);
  // The four bad ones (the pools) are among them; the warn ones fill the rest.
  assert.equal(asks.filter((a) => /ZFS pool/.test(a.text)).length, 4);
});

test('the box sends health once a minute, taken beside the polls', async () => {
  let now = T0, samples = 0;
  const bodies = [];
  const client = { async call(path, body) { if (path === 'poll') bodies.push(body); return {}; } };
  const r = runner({ ...env, LOOM_BOX_PODMAN: '/bin/false' }, client, { loomUrl: 'http://x/mcp', log: () => {}, clock: () => now, status: () => ({}), sweep: () => [], upgrade: () => null, runtime: () => ({}), codexUsage: () => null,
    sampleUnits: async () => ({ at: '', units: [] }), sampleHealth: async () => { samples++; return sampleWith(); }, bootInfo: () => null });
  for (let i = 0; i < 10; i++) { await r.tick(); await r.settled(); now += 15_000; }
  assert.equal(samples, 3);
  assert.equal(bodies.filter((b) => b.health).length, 3);
});

test('a report-only box never sweeps for sign-in containers (it runs none, and has no podman)', async () => {
  let sweeps = 0;
  const logs = [];
  const client = { async call() { return {}; } };
  const r = runner({ ...env, LOOM_BOX_PODMAN: '/bin/false' }, client, { loomUrl: 'http://x/mcp', log: (m) => logs.push(m), clock: () => T0, status: () => ({}), sweep: () => { sweeps++; return null; },
    upgrade: () => null, runtime: () => ({}), codexUsage: () => null, reportOnly: true, sampleUnits: async () => ({ at: '', units: [] }), sampleHealth: async () => null, bootInfo: () => null });
  for (let i = 0; i < 3; i++) { await r.tick(); await r.settled(); }
  assert.equal(sweeps, 0);
  assert.equal(logs.filter((l) => /sweep/.test(l)).length, 0);
});
