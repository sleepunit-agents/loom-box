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
import { join } from 'node:path';
import { api } from '../src/control.mjs';
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

test('dark: an always-on box silent 10 minutes, from a manifest read alone; its next poll clears it; others never', () => {
  ok(call(owner, 'add-box', { name: 'thor', mayHost: '*' }));
  ok(call(owner, 'add-box', { name: 'laptop', mayHost: '*' }));
  const thor = { kind: 'piece', subject: Object.entries(JSON.parse(readFileSync(join(env.LOOM_BOX_HOME, 'state.json'), 'utf-8')).boxes).find(([, b]) => b.name === 'thor' || false)?.[0] ?? 'thor' };
  const laptop = { kind: 'piece', subject: Object.entries(JSON.parse(readFileSync(join(env.LOOM_BOX_HOME, 'state.json'), 'utf-8')).boxes).find(([, b]) => b.name === 'laptop')?.[0] ?? 'laptop' };
  ok(call(owner, 'box-watch', { name: 'thor', alwaysOn: 'on' }));
  poll(0, {});
  ok(call(thor, 'poll', {}));
  ok(call(laptop, 'poll', {}));
  // The runtime's own box has been up under 10 minutes: nobody's dark yet, whatever the clock says.
  at(9 * 60); manifest(env, clock);
  assert.equal(healthAlerts().length, 0);
  for (let m = 1; m <= 12; m++) poll(m * 60, {});
  at(12 * 60); manifest(env, clock);
  assert.deepEqual(healthAlerts().map((a) => [a.summary, a.severity]), [['thor is dark', 'bad']]);
  assert.ok(manifest(env, clock).asks.find((a) => a.text === 'thor is dark'));
  at(13 * 60); ok(call(thor, 'poll', {}));
  assert.deepEqual([healthAlerts()[1].summary, healthAlerts()[1].facts.cleared], ['thor is back', 1]);
  assert.equal(manifest(env, clock).asks.filter((a) => /thor/.test(a.text)).length, 0);
  assert.equal(healthAlerts().filter((a) => /laptop/.test(a.summary)).length, 0);
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
  // A box can't take it back itself; the owner can.
  ok(call(wunder, 'poll', { reportOnly: false }));
  assert.equal(ok(call(wunder, 'poll', {})).reportOnly, true);
  ok(call(owner, 'box-watch', { name: 'wunder', reportOnly: 'off' }));
  assert.equal(ok(call(wunder, 'poll', {})).start.length, 1);
  assert.ok(watchOf(env).boxes[id]);
});
