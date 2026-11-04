// Box health (loom docs/specs/keeping-watch.md, "3. Box health"): each box samples itself once a minute, without root,
// and the control plane checks each sample against host-watch's rules (Art's bin/host-watch since 2026-10-30, plus a
// full filesystem and a dark box). A condition holds from the first sample that shows it; a sample that reads it fine
// ends it; one that couldn't read it leaves it as it was (a missing reading is unknown, never fine).
//
// sampleHealth (the box's half) reads a root directory ('' on a real machine; a fake one in the tests): /proc, /sys,
// `zpool list`, and /run/loom-box/root-health.json if a root timer writes it (SMART, container names).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { cpus as osCpus } from 'node:os';

export const WINDOW_MS = 5000;
const ROOT_HEALTH_MAX_AGE_S = 30 * 60;
const FS_TYPES = new Set(['ext4', 'ext3', 'xfs', 'btrfs', 'zfs', 'vfat', 'f2fs']);

const read = (p) => { try { return readFileSync(p, 'utf-8'); } catch { return null; } };

export function psiOf(text) {
  if (!text) return null;
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^(some|full) .*avg60=([\d.]+)/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return Object.keys(out).length ? out : null;
}

function diskstats(root) {
  const t = read(`${root}/proc/diskstats`);
  if (!t) return null;
  const out = {};
  for (const line of t.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length > 13 && /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+)$/.test(f[2])) out[f[2]] = f.slice(3).map(Number);
  }
  return out;
}

function arcstats(root) {
  const t = read(`${root}/proc/spl/kstat/zfs/arcstats`);
  if (!t) return null;
  const out = {};
  for (const line of t.split('\n').slice(2)) { const p = line.trim().split(/\s+/); if (p.length === 3) out[p[0]] = Number(p[2]); }
  return out;
}

function meminfo(root) {
  const t = read(`${root}/proc/meminfo`);
  if (!t) return null;
  const m = {};
  for (const line of t.split('\n')) { const x = /^(\w+):\s+(\d+)/.exec(line); if (x) m[x[1]] = Number(x[2]) * 1024; }
  if (!m.MemTotal) return null;
  return { total: m.MemTotal, available: m.MemAvailable ?? m.MemFree, swap_total: m.SwapTotal ?? 0, swap_free: m.SwapFree ?? 0 };
}

function sh(argv) {
  try {
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf-8', timeout: 15_000 });
    return r.status === 0 ? r.stdout : null;
  } catch { return null; }
}

/** 'lxc', another container's name (podman, docker, …), or null on a machine of its own. */
export function containerKind(root, run) {
  const v = (run(['systemd-detect-virt', '--container']) ?? '').trim();
  if (v && v !== 'none') return v;
  if (existsSync(`${root}/run/.containerenv`)) return 'podman';
  if (existsSync(`${root}/.dockerenv`)) return 'docker';
  return null;
}

/**
 * One sample. `o.run(argv)` is a command's stdout or null; `o.sleep(ms)` waits (the 5 s window for rates); `o.statfs`
 * is fs.statfsSync. Async only for the window.
 */
export async function sampleHealth(o = {}) {
  const root = o.root ?? '';
  const run = o.run ?? sh;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
  const statfs = o.statfs ?? statfsSync;
  const nowS = Math.round((o.now ?? Date.now()) / 1000);
  const container = containerKind(root, run);
  const own = !container;
  const lxcfs = container === 'lxc';
  const unread = [];
  const s = { t: nowS, container };

  const load = (lxcfs || own) ? read(`${root}/proc/loadavg`) : null;
  s.load = load ? load.split(' ').slice(0, 3).map(Number) : null;
  s.cpus = o.cpus ?? osCpus().length;
  s.mem = (lxcfs || own) ? meminfo(root) : null;
  if (!s.mem) unread.push('mem');
  // Pressure: the machine's, or in a container its own cgroup's (/proc/pressure there is the host's).
  const psiBase = own ? `${root}/proc/pressure/` : `${root}/sys/fs/cgroup/`;
  const psiFile = (r) => (own ? `${psiBase}${r}` : `${psiBase}${r}.pressure`);
  s.psi = { cpu: psiOf(read(psiFile('cpu'))), io: psiOf(read(psiFile('io'))), memory: psiOf(read(psiFile('memory'))) };
  if (!s.psi.io) unread.push('psi');

  // Filesystems: each real one, once per device.
  const mounts = read(`${root}/proc/mounts`);
  if (mounts) {
    const seen = new Set();
    s.fs = [];
    for (const line of mounts.split('\n')) {
      const [dev, mount, type] = line.split(' ');
      if (!FS_TYPES.has(type) || seen.has(dev)) continue;
      seen.add(dev);
      try {
        const st = statfs(`${root}${mount}`);
        const used = st.blocks - st.bfree;
        const total = used + st.bavail;
        if (total > 0) s.fs.push({ mount: mount.replace(/\\040/g, ' '), used_pct: Math.round((1000 * used) / total) / 10 });
      } catch { /* unreadable: left out */ }
    }
  } else { s.fs = null; unread.push('fs'); }

  if (own) {
    // Rates over 5 seconds, as host-watch measured them, so its thresholds mean what they meant.
    const d0 = diskstats(root), a0 = arcstats(root), t0 = Date.now();
    await sleep(WINDOW_MS);
    const d1 = diskstats(root), a1 = arcstats(root);
    const dt = Math.max(0.001, (o.windowS ?? (Date.now() - t0) / 1000));
    if (d0 && d1) {
      s.disks = {};
      for (const [name, b] of Object.entries(d1)) {
        const a = d0[name];
        if (!a) continue;
        const x = b.map((v, i) => v - a[i]);
        const [rio, , rsec, rms, wio, , wsec, wms, , busy] = x;
        const rot = read(`${root}/sys/block/${name}/queue/rotational`);
        s.disks[name] = { rotational: rot === null ? null : rot.trim() === '1', util: Math.min(100, Math.round((1000 * busy) / (dt * 1000)) / 10),
          r_mb_s: Math.round((rsec * 512) / dt / 1e5) / 10, w_mb_s: Math.round((wsec * 512) / dt / 1e5) / 10,
          r_await: rio ? Math.round((10 * rms) / rio) / 10 : null, w_await: wio ? Math.round((10 * wms) / wio) / 10 : null };
      }
    } else { s.disks = null; unread.push('disks'); }
    s.arc = a0 && a1 ? { size: a1.size, c_max: a1.c_max, dnode_size: a1.dnode_size, dnode_limit: a1.arc_dnode_limit,
      prune_per_s: Math.round((10 * ((a1.arc_prune ?? 0) - (a0.arc_prune ?? 0))) / dt) / 10 } : null;
    const zp = run(['zpool', 'list', '-H', '-o', 'name,health,capacity']);
    s.pools = zp === null ? null : zp.split('\n').filter(Boolean).map((l) => { const [name, health, cap] = l.split('\t'); return { name, health, cap: Number(String(cap).replace('%', '')) || 0 }; });
    if (s.pools === null) unread.push('pools');
    // Containers (a Proxmox host): their own pressure.
    const lxc = `${root}/sys/fs/cgroup/lxc`;
    if (existsSync(lxc)) {
      s.containers = {};
      for (const id of readdirSync(lxc).filter((n) => /^\d+$/.test(n))) s.containers[id] = { io: psiOf(read(`${lxc}/${id}/io.pressure`)), memory: psiOf(read(`${lxc}/${id}/memory.pressure`)) };
    } else s.containers = null;
  } else { s.disks = null; s.arc = null; s.pools = null; s.containers = null; }

  // What a root timer may write: SMART and the containers' names, ignored once it's 30 minutes old.
  s.smart = null;
  const rh = read(`${root}/run/loom-box/root-health.json`);
  if (rh) {
    try {
      const j = JSON.parse(rh);
      if (Number.isFinite(j.t) && nowS - j.t <= ROOT_HEALTH_MAX_AGE_S) {
        if (j.smart && typeof j.smart === 'object') s.smart = j.smart;
        if (s.containers && j.containers) for (const [id, name] of Object.entries(j.containers)) if (s.containers[id] && typeof name === 'string') s.containers[id].name = name.slice(0, 64);
      }
    } catch { /* unreadable: left out */ }
  }
  if (own && !s.smart) unread.push('smart');
  s.unread = unread;
  return s;
}

// ─── The rules ───────────────────────────────────────────────────────────────────────────────────────────────────

const ct = (s, id) => `CT ${id}${s.containers?.[id]?.name ? ` (${s.containers[id].name})` : ''}`;
const gb = (b) => Math.round(b / 2 ** 30);

/**
 * What's wrong in one sample: { key: { for: minutes, title (fixed for the episode), detail, severity, reading } }.
 * `reading` is which reading the condition rests on: a sample without it can't end it.
 */
export function problems(s, label = 'this box') {
  const out = {};
  const io = s.psi?.io;
  if (io && (io.full ?? 0) >= 50) out.io = { for: 10, reading: 'psi', severity: 'warn', title: `${label} is stalled on disk`, detail: `every task stalled on disk ${Math.round(io.full)}% of the last minute${s.load ? ` (load ${Math.round(s.load[0])})` : ''}` };
  for (const [id, c] of Object.entries(s.containers ?? {})) {
    if ((c.io?.some ?? 0) >= 40) out[`ct-io-${id}`] = { for: 15, reading: 'containers', severity: 'warn', title: `${label}: ${ct(s, id)} is waiting on disk`, detail: `${ct(s, id)} waiting on disk ${Math.round(c.io.some)}% of the time` };
    if ((c.memory?.some ?? 0) >= 20) out[`ct-mem-${id}`] = { for: 10, reading: 'containers', severity: 'warn', title: `${label}: ${ct(s, id)} is short of memory`, detail: `${ct(s, id)} stalled on memory ${Math.round(c.memory.some)}% of the time` };
  }
  for (const [name, d] of Object.entries(s.disks ?? {})) {
    const slow = d.rotational ? 300 : 30;
    const lat = Math.max(d.r_await ?? 0, d.w_await ?? 0);
    if ((d.util ?? 0) >= 80 && lat >= slow) out[`disk-${name}`] = { for: 10, reading: 'disks', severity: 'warn', title: `${label}: ${name} is slow`, detail: `${name} ${Math.round(d.util)}% busy, requests taking ${Math.round(lat)} ms (${d.r_mb_s} MB/s read, ${d.w_mb_s} written)` };
  }
  if (s.arc && (s.arc.prune_per_s ?? 0) >= 100) out['arc-prune'] = { for: 5, reading: 'arc', severity: 'warn', title: `${label}: ZFS's cache is thrashing`, detail: `arc_prune ${Math.round(s.arc.prune_per_s)} calls/s (dnodes ${(s.arc.dnode_size ?? 0) >> 20} MB of a ${(s.arc.dnode_limit ?? 0) >> 20} MB limit)` };
  for (const p of s.pools ?? []) {
    if (p.health !== 'ONLINE') out[`pool-${p.name}`] = { for: 0, reading: 'pools', severity: 'bad', title: `${label}: ZFS pool ${p.name} is ${p.health}`, detail: `zpool says ${p.name} is ${p.health}` };
    if (p.cap >= 85) out[`pool-full-${p.name}`] = { for: 0, reading: 'pools', severity: 'warn', title: `${label}: ZFS pool ${p.name} is filling up`, detail: `${p.name} is ${p.cap}% full` };
  }
  for (const f of s.fs ?? []) {
    if (f.used_pct >= 90) out[`fs-${f.mount}`] = { for: 10, reading: 'fs', severity: 'warn', title: `${label}: ${f.mount} is nearly full`, detail: `${f.mount} is ${f.used_pct}% full` };
  }
  const m = s.mem;
  if (m?.total && m.available < 0.08 * m.total) out.mem = { for: 10, reading: 'mem', severity: 'warn', title: `${label} is short of memory`, detail: `${gb(m.available)} GB of ${gb(m.total)} GB left` };
  if (m?.swap_total && m.swap_free < 0.15 * m.swap_total) out.swap = { for: 10, reading: 'mem', severity: 'warn', title: `${label}'s swap is nearly full`, detail: `swap ${Math.round(100 - (100 * m.swap_free) / m.swap_total)}% full` };
  for (const [name, h] of Object.entries(s.smart ?? {})) {
    const hot = name.startsWith('nvme') ? 70 : 55;
    const bad = [[h.passed === false, 'SMART says it\'s failing'], [(h.reallocated ?? 0) > 0, `${h.reallocated} reallocated sectors`], [(h.pending ?? 0) > 0, `${h.pending} sectors pending`],
      [(h.media_errors ?? 0) > 0, `${h.media_errors} media errors`], [(h.wear_pct ?? 0) >= 80, `${h.wear_pct}% worn`], [(h.temp_c ?? 0) >= hot, `at ${h.temp_c}°C`]].filter(([x]) => x).map(([, w]) => w);
    if (bad.length) out[`smart-${name}`] = { for: 0, reading: 'smart', severity: 'bad', title: `${label}: disk ${name} is in trouble`, detail: `${name}: ${bad.join(', ')}` };
  }
  return out;
}

/** The sample in a line or two, for the box's page and `loom runtime health`. */
export function healthWords(s) {
  if (!s) return 'No health sample yet.';
  const parts = [];
  if (s.load) parts.push(`load ${s.load[0].toFixed(1)} on ${s.cpus} CPUs`);
  if (s.mem) parts.push(`${gb(s.mem.available)} of ${gb(s.mem.total)} GB memory free${s.mem.swap_total ? `, swap ${Math.round(100 - (100 * s.mem.swap_free) / s.mem.swap_total)}% used` : ''}`);
  if (s.psi?.io) parts.push(`io stalled ${Math.round(s.psi.io.full ?? 0)}% (all) / ${Math.round(s.psi.io.some ?? 0)}% (some)`);
  const fullest = [...(s.fs ?? [])].sort((a, b) => b.used_pct - a.used_pct)[0];
  if (fullest) parts.push(`${fullest.mount} ${fullest.used_pct}% full`);
  const busiest = Object.entries(s.disks ?? {}).sort((a, b) => b[1].util - a[1].util)[0];
  if (busiest) parts.push(`${busiest[0]} ${Math.round(busiest[1].util)}% busy`);
  for (const p of s.pools ?? []) parts.push(`pool ${p.name} ${p.health} ${p.cap}%`);
  if (s.arc) parts.push(`arc_prune ${Math.round(s.arc.prune_per_s)}/s`);
  return parts.join(' · ');
}
