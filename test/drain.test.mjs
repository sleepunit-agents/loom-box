// Draining a body host's house on an outdated image (t-1764): a warm house built from an older image than its agent's
// current build gets no new bodies; the next delivery starts a fresh house on the new image; bodies in the old house
// finish there (fed, stopped and packed through its own part of the host record), and a conversation whose body was
// there resumes in the new house from its slot. An unchanged image never drains. The control plane knows each house's
// build (the box's report when it starts it, or its container's image) and the agent's current one (the newest a box
// has said: a house it built, or a check of the repo that builds nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, buildTag, outdatedHouse, setAgent } from '../src/control.mjs';
import { HouseRunner, hostOf, hostTask } from '../src/houserunner.mjs';
import { runBodyHost } from '../src/bodyhost.mjs';
import { houseBadge } from '../src/ui.mjs';
import { buildNow, buildTagAt } from '../src/box.mjs';
import { load, update } from '../src/state.mjs';
import { scratch } from './scratch.mjs';

const until = async (f, ms = 20_000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
const bootOf = (env, house) => /--host-key ([0-9a-f]{48})/.exec(load(env).houses[house]?.task ?? '')?.[1];
const OLD = 'loom-house-art:aaaaaaaaaaaabbbbbbbb';
const NEW = 'loom-house-art:ccccccccccccdddddddd';

function world(prefix) {
  const D = scratch(prefix);
  const env = { PATH: process.env.PATH, HOME: D, LOOM_HOME: join(D, 'loomhome'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_DATA: join(D, 'data') };
  mkdirSync(env.LOOM_HOME, { recursive: true });
  setAgent(env, { now: () => new Date() }, { agent: 'art', repo: 'https://example.com/art.git' });
  update(env, (s) => { const k = Object.keys(s.boxes).find((x) => s.boxes[x].local); s.boxes[k].harnesses = { claude: { loggedIn: true } }; });
  // Houses come up as the box would run them: each `up` is a running house on the image the box builds now.
  let image = OLD;
  const ups = [];
  const upFn = (e, fx, who, b) => {
    const id = `h-${ups.length + 1}`;
    ups.push(id);
    update(env, (s) => { s.houses[id] = { id, agent: 'art', box: 'one', state: 'running', task: b.task, build: image }; (s.builds ??= {}).art = { id: image, at: new Date().toISOString() }; });
    return { id };
  };
  // A house's local runner: its sessions are files, so a pack carries something.
  const runnerIn = (D2) => {
    const roots = { sess: D2 };
    mkdirSync(D2, { recursive: true });
    const st = {};
    const session = {};
    const fedTo = {};
    let n = 0;
    const tfile = (s) => join(D2, `${s}.jsonl`);
    return {
      st, fedTo, started: [],
      harness: 'claude', roots, inbox: { pending: () => [] },
      start(o) { const id = `b000000${n++}`; st[id] = 'working'; session[id] = `s-${id}`; writeFileSync(tfile(session[id]), `transcript of ${id}`); this.started.push(['start', id]); return { id, harness: 'claude' }; },
      resume(slot, o) { const id = `b000000${n++}`; st[id] = 'working'; session[id] = slot.session; this.started.push(['resume', slot.session, existsSync(tfile(slot.session)) ? readFileSync(tfile(slot.session), 'utf-8') : null]); return { id, harness: 'claude' }; },
      status: (b) => st[b.id] ?? 'unknown',
      slotOf: (b) => (session[b.id] ? { harness: 'claude', session: session[b.id] } : null),
      feed(b, m) { (fedTo[b.id] ??= []).push(m.text); return { fed: true }; },
      end(b) { st[b.id] = 'ended'; },
      sessionFiles: (slot) => ({ keep: slot && existsSync(tfile(slot.session)) ? [{ root: 'sess', rel: `${slot.session}.jsonl` }] : [], drop: [] }),
    };
  };
  const host = (house, local, o = {}) => {
    const client = async (p, b) => { const r = await api(env, { now: () => new Date() }, { caller: { kind: 'agent', agent: 'art', house }, path: p, body: b }); if (r.status !== 200) throw new Error(r.body.error); return r.body; };
    let left = null;
    const done = runBodyHost({ client, runner: () => local, env: { HOME: join(D, `${house}-home`), CLAUDE_SECURESTORAGE_CONFIG_DIR: '/run/loom/login/claude' }, hostKey: bootOf(env, house), sleep: () => new Promise((r) => setTimeout(r, 5)), beats: 4000, idleS: 0, log: (m) => { if (/^leaving/.test(m)) left = m; }, ...o });
    return { done, left: () => left };
  };
  const hr = new HouseRunner(env, 'claude', { poll: 5, up: upFn });
  return { D, env, hr, ups, host, runnerIn, setImage: (t) => { image = t; } };
}

test('a build tag is what box.mjs names it, for its own agent; unknown either way is never outdated', () => {
  assert.equal(buildTag(`localhost/${OLD}`, 'art'), OLD, 'podman\'s localhost/ dropped');
  assert.equal(buildTag(OLD, 'mark'), null, 'another agent\'s image is never art\'s build');
  assert.equal(buildTag('loom-house-art:../x', 'art'), null);
  assert.equal(outdatedHouse({ houses: { 'h-1': { agent: 'art', build: OLD } }, builds: {} }, 'h-1'), false, 'no current build known');
  assert.equal(outdatedHouse({ houses: { 'h-1': { agent: 'art' } }, builds: { art: { id: NEW } } }, 'h-1'), false, 'its own build not known');
  assert.equal(outdatedHouse({ houses: { 'h-1': { agent: 'art', build: NEW } }, builds: { art: { id: NEW } } }, 'h-1'), false);
  assert.equal(outdatedHouse({ houses: { 'h-1': { agent: 'art', build: OLD } }, builds: { art: { id: NEW } } }, 'h-1'), true);
});

test('an unchanged image doesn\'t drain: every delivery goes to the warm house', async () => {
  const w = world('rt-drain-same-');
  const local = w.runnerIn(join(w.D, 'h1'));
  const first = w.hr.start({ agent: 'art', brief: 'one', model: 'opus', env: { LOOM_BODY_KEY: 'k1' } });
  await until(() => load(w.env).houses['h-1']);
  const h1 = w.host('h-1', local);
  try {
    await first;
    // A box checks the repo again and finds the same image: nothing changes.
    update(w.env, (s) => { s.builds.art = { id: OLD, at: new Date().toISOString() }; });
    for (const k of ['k2', 'k3']) assert.equal((await w.hr.start({ agent: 'art', brief: k, model: 'opus', env: { LOOM_BODY_KEY: k } })).house, 'h-1');
    assert.deepEqual(w.ups, ['h-1'], 'no other house asked for');
    assert.equal(load(w.env).houses['h-1'].draining, undefined);
    assert.equal(hostOf(w.env, 'art').draining, undefined);
  } finally {
    writeFileSync(join(w.env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art.json'), JSON.stringify({ agent: 'art', house: 'h-9', req: {}, stop: {}, inbox: {} }));
    await h1.done;
  }
});

test('a warm house on an outdated image gets no new bodies: the next delivery starts a fresh house; its own bodies finish there, never killed', async () => {
  const w = world('rt-drain-');
  const old = w.runnerIn(join(w.D, 'h1'));
  const fresh = w.runnerIn(join(w.D, 'h2'));
  const first = w.hr.start({ agent: 'art', brief: 'one', model: 'opus', env: { LOOM_BODY_KEY: 'k1' } });
  await until(() => load(w.env).houses['h-1']);
  const h1 = w.host('h-1', old);
  let h2;
  try {
    const b1 = await first;
    assert.equal(b1.house, 'h-1');
    const body1 = { id: b1.id, agent: 'art', house: 'h-1', harness: 'claude' };
    await until(() => w.hr.status(body1) === 'working');
    // The agent's repo changes its house: a newer image is its current build now (a box built it, or checked).
    w.setImage(NEW);
    update(w.env, (s) => { s.builds.art = { id: NEW, at: new Date().toISOString() }; });
    assert.equal(outdatedHouse(load(w.env), 'h-1'), true);
    // The next delivery: a fresh house is asked for, and the body starts there.
    const second = w.hr.start({ agent: 'art', brief: 'two', model: 'opus', env: { LOOM_BODY_KEY: 'k2' } });
    await until(() => load(w.env).houses['h-2']);
    h2 = w.host('h-2', fresh);
    const b2 = await second;
    assert.equal(b2.house, 'h-2');
    assert.deepEqual(w.ups, ['h-1', 'h-2']);
    assert.deepEqual(old.started.map((x) => x[0]), ['start'], 'the old house started nothing new');
    assert.deepEqual(fresh.started.map((x) => x[0]), ['start']);
    // The old house is draining: the page and the CLI say so; the record keeps its host and its body.
    const rec = load(w.env).houses['h-1'];
    assert.equal(rec.draining.reason, 'outdated image');
    assert.equal(houseBadge(rec), 'draining (outdated image)');
    assert.equal(houseBadge(load(w.env).houses['h-2']), 'running');
    assert.ok(hostOf(w.env, 'art').draining['h-1'], 'its part of the record kept');
    assert.equal(hostOf(w.env, 'art').house, 'h-2');
    // Its running body isn't killed: still working, and its host is still syncing (it hasn't been told to leave).
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(w.hr.status(body1), 'working');
    assert.equal(old.st[b1.id.replace(/^h-1-/, '')], 'working');
    assert.equal(h1.left(), null, 'the old house\'s host wasn\'t told to leave');
    // A follow-up mid-turn still reaches it, in its house.
    assert.equal(w.hr.feed(body1, { id: 'm1', text: 'and also' }).fed, true);
    await until(() => (old.fedTo[b1.id.replace(/^h-1-/, '')] ?? []).includes('and also'));
    // A third delivery: the fresh house again, never the old one.
    const b3 = await w.hr.start({ agent: 'art', brief: 'three', model: 'opus', env: { LOOM_BODY_KEY: 'k3' } });
    assert.equal(b3.house, 'h-2');
    assert.deepEqual(old.started.map((x) => x[0]), ['start']);
    // Its turn ends there, normally; once its house is over, its part of the record goes.
    old.st[b1.id.replace(/^h-1-/, '')] = 'idle';
    await until(() => w.hr.status(body1) === 'idle');
    update(w.env, (s) => { s.houses['h-1'].state = 'done'; });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hostOf(w.env, 'art').draining, undefined, 'a drained house that\'s over leaves the record');
  } finally {
    writeFileSync(join(w.env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art.json'), JSON.stringify({ agent: 'art', house: 'h-9', req: {}, stop: {}, inbox: {} }));
    await Promise.all([h1.done, h2?.done]);
  }
});

test('a conversation whose body is in the drained house resumes in the new house from its slot', async () => {
  const w = world('rt-drain-slot-');
  const old = w.runnerIn(join(w.D, 'h1'));
  const fresh = w.runnerIn(join(w.D, 'h2'));
  const first = w.hr.start({ agent: 'art', brief: 'one', model: 'opus', env: { LOOM_BODY_KEY: 'k1' } });
  await until(() => load(w.env).houses['h-1']);
  const h1 = w.host('h-1', old);
  let h2;
  try {
    const b1 = await first;
    const raw = b1.id.replace(/^h-1-/, '');
    const body1 = { id: b1.id, agent: 'art', house: 'h-1', harness: 'claude' };
    old.st[raw] = 'idle';
    await until(() => w.hr.status(body1) === 'idle');
    // A newer image, and another conversation's delivery drains h-1 into h-2.
    w.setImage(NEW);
    update(w.env, (s) => { s.builds.art = { id: NEW, at: new Date().toISOString() }; });
    const other = w.hr.start({ agent: 'art', brief: 'other', model: 'opus', env: { LOOM_BODY_KEY: 'k2' } });
    await until(() => load(w.env).houses['h-2']);
    h2 = w.host('h-2', fresh);
    await other;
    // This conversation's next message: its body is packed from the old house into its slot...
    assert.deepEqual(w.hr.slotOf(body1), { harness: 'claude', session: `s-${raw}` });
    const files = await w.hr.pack(body1);
    assert.equal(files.length, 1, 'its session came back from the draining house');
    assert.equal(Buffer.from(files[0].data, 'base64').toString(), `transcript of ${raw}`);
    // ...and resumed from it in the new house, its session put back there first.
    const r = await w.hr.resume({ harness: 'claude', session: `s-${raw}` }, { agent: 'art', brief: 'again', model: 'opus', env: { LOOM_BODY_KEY: 'k3' }, files });
    assert.equal(r.house, 'h-2');
    assert.deepEqual(fresh.started.at(-1), ['resume', `s-${raw}`, `transcript of ${raw}`]);
    assert.deepEqual(old.started.map((x) => x[0]), ['start'], 'nothing new in the old house');
    // The old house has nothing left: it idles out the usual way (its host's idle time, nothing else).
    assert.equal(h1.left(), null);
  } finally {
    writeFileSync(join(w.env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art.json'), JSON.stringify({ agent: 'art', house: 'h-9', req: {}, stop: {}, inbox: {} }));
    await Promise.all([h1.done, h2?.done]);
  }
});

test('a drained house idles out the usual way once its bodies are done', async () => {
  const w = world('rt-drain-idle-');
  const old = w.runnerIn(join(w.D, 'h1'));
  const fresh = w.runnerIn(join(w.D, 'h2'));
  let t = 0;
  const first = w.hr.start({ agent: 'art', brief: 'one', model: 'opus', env: { LOOM_BODY_KEY: 'k1' } });
  await until(() => load(w.env).houses['h-1']);
  // Its host's clock is a counter: a second each beat, idle after 30 (the usual idle time, scaled).
  const h1 = w.host('h-1', old, { idleS: 30, now: () => (t += 1000) });
  let h2;
  const b1 = await first;
  w.setImage(NEW);
  update(w.env, (s) => { s.builds.art = { id: NEW, at: new Date().toISOString() }; });
  const second = w.hr.start({ agent: 'art', brief: 'two', model: 'opus', env: { LOOM_BODY_KEY: 'k2' } });
  await until(() => load(w.env).houses['h-2']);
  h2 = w.host('h-2', fresh);
  await second;
  // While its body works it stays; once its turn is over, it leaves on its own idle time.
  old.st[b1.id.replace(/^h-1-/, '')] = 'idle';
  await h1.done;
  assert.equal(h1.left(), null, 'it left on idle, not because it was told to');
  writeFileSync(join(w.env.LOOM_BOX_DATA, 'delivery', 'hosts', 'art.json'), JSON.stringify({ agent: 'art', house: 'h-9', req: {}, stop: {}, inbox: {} }));
  await h2.done;
});

test('the control plane: a house\'s build from its box\'s report, the current one from a build or a check; a changed house file forgets it', () => {
  const D = scratch('rt-drain-ctl-');
  const env = { PATH: process.env.PATH, HOME: D, LOOM_HOME: join(D, 'loomhome'), LOOM_BOX_LOCAL_NAME: 'one', LOOM_BOX_HOME: join(D, 'state'), LOOM_BOX_DATA: join(D, 'data') };
  mkdirSync(env.LOOM_HOME, { recursive: true });
  const secrets = [];
  const fx = { now: () => new Date(), mint: () => 'loom_house_token_aaaaaaaaaaaaaaaa', revoke: () => {}, secret: (n, o) => { secrets.push([n, o]); return `secret:${n}`; } };
  const ok = (x) => { assert.equal(x.status, 200, JSON.stringify(x.body)); return x.body; };
  const owner = { kind: 'owner' };
  const box = { kind: 'piece', subject: 'one' };
  ok(api(env, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo: 'https://example.com/art.git', repoSecret: 'gh-art' } }));
  const id = ok(api(env, fx, { caller: owner, path: 'up', body: { agent: 'art', box: 'one', task: hostTask(env, 'ab'.repeat(24)) } })).id;
  ok(api(env, fx, { caller: box, path: 'claim', body: { id } }));
  ok(api(env, fx, { caller: box, path: 'report', body: { id, state: 'running', build: OLD } }));
  assert.equal(load(env).houses[id].build, OLD);
  assert.equal(load(env).builds.art.id, OLD, 'the newest build its repo made');
  // The box's poll names its running body hosts' houses; a check gets the repo and its secret, for this house.
  const p = ok(api(env, fx, { caller: box, path: 'poll', body: {} }));
  assert.deepEqual(p.bodyHosts, [{ id, agent: 'art', known: true }]);
  const c = ok(api(env, fx, { caller: box, path: 'build-check', body: { id } }));
  assert.deepEqual([c.repo, c.repoAuth, c.houseFile, c.known], ['https://example.com/art.git', 'secret:gh-art', 'house/house.json', true]);
  assert.deepEqual(secrets.at(-1), ['gh-art', { agent: 'art', house: id }]);
  // Another box can't check it; a house that isn't a body host's isn't checked.
  assert.equal(api(env, fx, { caller: { kind: 'piece', subject: 'two' }, path: 'build-check', body: { id } }).status, 403);
  const task = ok(api(env, fx, { caller: owner, path: 'up', body: { agent: 'art', box: 'one', task: 'say hi' } })).id;
  ok(api(env, fx, { caller: box, path: 'claim', body: { id: task } }));
  ok(api(env, fx, { caller: box, path: 'report', body: { id: task, state: 'running', build: OLD } }));
  assert.equal(api(env, fx, { caller: box, path: 'build-check', body: { id: task } }).status, 404);
  // The repo's image is the same: not outdated. Then it changes: outdated.
  assert.equal(ok(api(env, fx, { caller: box, path: 'build-report', body: { id, current: OLD } })).outdated, false);
  const r = ok(api(env, fx, { caller: box, path: 'build-report', body: { id, current: `localhost/${NEW}`, house: 'loom-house-art:eeeeeeeeeeeeffffffff' } }));
  assert.deepEqual([r.build, r.current, r.outdated], [OLD, NEW, true], 'a house\'s own build, once known, isn\'t overwritten');
  // A house checked out before that check, reporting its older build late, doesn't take the current build back.
  update(env, (s) => { s.houses[task].claimedAt = new Date(Date.now() - 60_000).toISOString(); delete s.houses[task].build; s.houses[task].state = 'starting'; });
  ok(api(env, fx, { caller: box, path: 'report', body: { id: task, state: 'running', build: OLD } }));
  assert.equal(load(env).builds.art.id, NEW);
  // Another agent's image is never art's build.
  ok(api(env, fx, { caller: box, path: 'build-report', body: { id, current: 'loom-house-mark:ccccccccccccdddddddd' } }));
  assert.equal(load(env).builds.art.id, NEW);
  // A box that may no longer host art (the owner narrowed it): no repo secret, no say in art's current build, and its
  // report of a house's build is no build that ran for art.
  ok(api(env, fx, { caller: owner, path: 'may-host', body: { name: 'one', mayHost: 'mark' } }));
  const n = secrets.length;
  assert.equal(api(env, fx, { caller: box, path: 'build-check', body: { id } }).status, 403);
  assert.equal(secrets.length, n, 'the repo secret wasn\'t asked for');
  assert.equal(api(env, fx, { caller: box, path: 'build-report', body: { id, current: 'loom-house-art:999999999999aaaaaaaa' } }).status, 403);
  update(env, (s) => { s.houses[task].claimedAt = new Date(Date.now() + 60_000).toISOString(); delete s.houses[task].build; s.houses[task].state = 'starting'; });
  ok(api(env, fx, { caller: box, path: 'report', body: { id: task, state: 'running', build: 'loom-house-art:999999999999aaaaaaaa' } }));
  assert.equal(load(env).builds.art.id, NEW, 'a box that may not host art never moves its current build');
  assert.equal(load(env).houses[task].build, undefined);
  ok(api(env, fx, { caller: owner, path: 'may-host', body: { name: 'one', mayHost: '*' } }));
  // A house's own build, once known, is never overwritten by a later report.
  ok(api(env, fx, { caller: box, path: 'build-report', body: { id, house: NEW } }));
  assert.equal(load(env).houses[id].build, OLD);
  // The agent's repo secret changed since the house's claim: its check is refused, and nothing is handed out.
  ok(api(env, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo: 'https://example.com/art.git', repoSecret: 'gh-art-2' } }));
  const m = secrets.length;
  const changed = api(env, fx, { caller: box, path: 'build-check', body: { id } });
  assert.equal(changed.status, 409);
  assert.match(changed.body.error, /another repo, house file, branch or repo secret/);
  assert.equal(secrets.length, m);
  assert.equal(api(env, fx, { caller: box, path: 'build-report', body: { id, current: NEW } }).status, 409);
  // A house claimed before houses kept how they were made (h-844, live): its own image only, no repo, no secret.
  update(env, (s) => { delete s.houses[id].made; delete s.houses[id].build; });
  const k = secrets.length;
  assert.deepEqual(ok(api(env, fx, { caller: box, path: 'build-check', body: { id } })), { id, agent: 'art', check: false, known: false });
  assert.equal(secrets.length, k);
  ok(api(env, fx, { caller: box, path: 'build-report', body: { id, house: OLD } }));
  assert.equal(load(env).houses[id].build, OLD);
  assert.equal(api(env, fx, { caller: box, path: 'build-report', body: { id, current: NEW } }).status, 409, 'but no say in the current build');
  // The owner points art at another house file: the current build isn't known until a box says.
  ok(api(env, fx, { caller: owner, path: 'set-agent', body: { agent: 'art', repo: 'https://example.com/art.git', repoSecret: 'gh-art-2', houseFile: 'house2/house.json' } }));
  assert.equal(load(env).builds?.art, undefined);
  assert.equal(outdatedHouse(load(env), id), false);
});

test('a box checks a warm body host\'s repo without building: the tag the next house would get, and the house\'s own image when it isn\'t known', async () => {
  const { runner } = await import('../src/box.mjs');
  const D = scratch('rt-drain-box-');
  const repo = join(D, 'repo');
  mkdirSync(join(repo, 'house'), { recursive: true });
  writeFileSync(join(repo, 'house', 'Containerfile'), 'FROM scratch\n');
  writeFileSync(join(repo, 'house', 'house.json'), JSON.stringify({ build: { containerfile: 'house/Containerfile', context: 'house' } }));
  writeFileSync(join(repo, 'README'), 'not in the image\n');
  const git = (...a) => assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo }).status, 0, a.join(' '));
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'one');
  const env = { PATH: process.env.PATH, HOME: D, LOOM_BOX_DATA: join(D, 'data') };
  const c = { agent: 'art', repo, houseFile: 'house/house.json', branch: null, repoAuth: null };
  const a = buildNow(env, c);
  assert.equal(a, buildTagAt(repo, 'HEAD', 'art', { context: 'house', containerfile: 'house/Containerfile' }), 'the tag a clone at HEAD builds (box.mjs, image)');
  // A commit outside the build context: the same image.
  writeFileSync(join(repo, 'README'), 'still not in the image\n'); git('commit', '-qam', 'two');
  assert.equal(buildNow(env, c), a);
  // One inside it: a new one.
  writeFileSync(join(repo, 'house', 'brief.md'), 'a new brief file\n'); git('add', '-A'); git('commit', '-qm', 'three');
  const b = buildNow(env, c);
  assert.notEqual(b, a);
  assert.match(b, /^loom-house-art:[0-9a-f]{20}$/);

  // The runner's side: each body host's house checked when first seen, then at the harness status's pace.
  const calls = [];
  let now = 0;
  let poll = { bodyHosts: [{ id: 'h-4', agent: 'art', known: false }] };
  const client = { async call(path, body) { calls.push([path, body]); if (path === 'poll') return poll; if (path === 'build-check') return { ...c, id: body.id, known: false }; if (path === 'build-report') return { outdated: true, build: OLD, current: b }; return {}; } };
  const r = runner(env, client, { loomUrl: 'http://loom.test/mcp', log: () => {}, status: () => null, upgrade: () => null, sweep: () => [], runtime: () => ({}), clock: () => now, houseImage: (id) => (id === 'h-4' ? OLD : null), buildOf: (x) => buildNow(env, x) });
  await r.tick();
  assert.deepEqual(calls.filter(([p]) => p.startsWith('build')), [['build-check', { id: 'h-4' }], ['build-report', { id: 'h-4', house: OLD, current: b }]]);
  calls.length = 0;
  now += 60_000;
  poll = { bodyHosts: [{ id: 'h-4', agent: 'art', known: true }] };
  await r.tick();
  assert.deepEqual(calls.filter(([p]) => p.startsWith('build')), [], 'not again before the status pace');
  now += 5 * 60_000;
  await r.tick();
  assert.deepEqual(calls.filter(([p]) => p.startsWith('build')).map(([p]) => p), ['build-check', 'build-report']);
});
