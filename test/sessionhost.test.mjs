import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { bootstrapSession, sessionCommand } from '../src/sessionhost.mjs';
import { api, setAgent } from '../src/control.mjs';
import { HouseRunner, releaseEmptySeatHouses } from '../src/houserunner.mjs';
import { runBodyHost } from '../src/bodyhost.mjs';
import { ageSealer } from '../src/sealed.mjs';
import { deliveryDir, loadConv, tick } from '../src/delivery.mjs';
import { update, load } from '../src/state.mjs';
import { setModels } from '../src/models.mjs';
import { staticAccounts } from '../src/accounts.mjs';
import { world, fakeRunner, hasAge } from './delivery-world.mjs';
const until = async fn => { const end = Date.now() + 15000; while (!fn()) { if (Date.now() > end) throw Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };

for (const harness of ['claude', 'codex']) test(`terminal uses common ${harness} delivery, preserves its house and deduplicates steering`, { skip: !hasAge }, async () => {
  const w = world(); w.o.sealer = ageSealer(w.env, deliveryDir(w.env));
  if (harness === 'codex') {
    setModels(w.env, { list: [{ id: 'opus', harness: 'claude', family: 'anthropic' }, { id: 'gpt', harness: 'codex', family: 'openai' }] });
    w.o.accounts = staticAccounts({ accounts: [
      { name: 'max', provider: 'anthropic', harness: 'claude', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage: { '5h': 1 } },
      { name: 'pro', provider: 'openai', harness: 'codex', agents: ['art'], credentials: [{ kind: 'login', status: 'valid' }], usage: {} },
    ] });
  }
  setAgent(w.env, {}, { agent: 'art', repo: 'https://example.com/art.git' });
  update(w.env, s => { s.houses['h-7'] = { id: 'h-7', agent: 'art', box: 'chosen-box', needs: ['os:linux'], slot: 'terminal', state: 'running', session: true, taskActsFor: { owner: true, people: [], unknown: false } }; });
  const hr = new HouseRunner(w.env, harness, { sealer: w.o.sealer, poll: 5, up() { throw Error('must not allocate another house'); } });
  const o = { ...w.o, runner: () => hr, spawnWorker() {}, detach: true };
  const caller = { kind: 'agent', agent: 'art', house: 'h-7' }, owner = { kind: 'owner', agents: ['art'] };
  const boot = await bootstrapSession(w.env, caller, o);
  assert.equal((await bootstrapSession(w.env, caller, o)).conversation, boot.conversation);
  const native = fakeRunner(w.log, join(w.env.HOME, 'native'), harness);
  native.final = () => 'TERMINAL-REPORT';
  native.activity = () => [{ id: 'terminal-step', at: w.clock.now().toISOString(), tool: 'read', summary: 'Reading a file', state: 'running' },
    { id: 'terminal-words', at: w.clock.now().toISOString(), tool: 'text', summary: 'TERMINAL-WORDS', fixed: 'Wrote its words', state: 'done', body: 'TERMINAL-WORDS' },
    { id: 'terminal-cmd', at: w.clock.now().toISOString(), tool: 'Bash', summary: 'Ran a command', fixed: 'Ran a command', state: 'done', detail: 'echo TERMINAL-COMMAND' }];
  let leave = false;
  const host = runBodyHost({ client: async (path, body) => {
    const r = await api(w.env, {}, { caller, path, body });
    if (r.status !== 200) throw Error(r.body.error);
    return leave ? { ...r.body, exit: true } : r.body;
  }, runner: () => native, hostKey: boot.hostKey, env: { HOME: join(w.env.HOME, 'house'), CLAUDE_SECURESTORAGE_CONFIG_DIR: '/run/loom/login/claude', LOOM_LOGIN_CODEX: '/run/loom/login/codex' }, idleS: 0, beats: 3000, sleep: () => new Promise(r => setTimeout(r, 5)) });
  try {
    await tick(w.env, o);
    let c = loadConv(w.env, boot.conversation);
    assert.ok(c.body, JSON.stringify({starting:c.starting,retryAt:c.retryAt,runLog:c.runLog,paused:c.paused}));
    assert.match(c.body, new RegExp(`^${harness}:h-7-`));
    assert.equal(c.spawn.interactive, true);
    await until(() => hr.activity({ id: c.body.split(':')[1], agent: 'art', house: 'h-7', seat: 'j-h-7' }).length > 0);
    assert.deepEqual([load(w.env).houses['h-7'].box, load(w.env).houses['h-7'].slot], ['chosen-box', 'terminal']);
    await assert.rejects(bootstrapSession(w.env, caller, o), /already running/);
    const message = { id: 'h-7', action: 'send', message: 'abcdef0123456789', text: 'A multiline instruction.\nKeep this line too.' };
    const first = await sessionCommand(w.env, owner, message, o);
    assert.ok(Number.isInteger(first.seq), JSON.stringify(first));
    const again = await sessionCommand(w.env, owner, message, o);
    assert.equal(again.seq, first.seq);
    c = loadConv(w.env, boot.conversation);
    assert.equal(c.queue.filter(m => m.id === 'terminal-abcdef0123456789').length, 1, 'exactly one pending steering message');
    assert.equal(w.o.sealer.open(Buffer.from(c.queue[0].sealed, 'base64')).toString(), message.text);
    const status = await sessionCommand(w.env, owner, { id: 'h-7' }, o);
    assert.equal(status.conversation, boot.conversation);
    assert.equal(status.model.harness, harness);
    assert.equal(status.working, true);
    assert.equal(status.cards[0].summary, 'Reading a file', 'live activity reaches the terminal controller');
    // Owner-alone prose survives; an unrecognized command has only its fixed label.
    assert.ok(JSON.stringify(status.cards).includes('TERMINAL-WORDS'));
    assert.ok(!JSON.stringify(status.cards).includes('TERMINAL-COMMAND'));
    assert.equal(status.cards.find(c => c.id === 'terminal-cmd').summary, 'Ran a command');
    assert.ok(status.cards.every((k) => !('fixed' in k)), 'through the one gate (delivery shownCards), not the runner\'s cards as they are');
    const choice = await sessionCommand(w.env, owner, { id: 'h-7', action: 'model', harness }, o);
    assert.equal(choice.threadChoice, harness);
    const originalSession = native.slotOf({ id: c.body.replace(`${harness}:h-7-`, '') }).session;
    await sessionCommand(w.env, owner, { id: 'h-7', action: 'interrupt' }, o);
    for (let i=0;i<100;i++) {
      await tick(w.env, o); c=loadConv(w.env, boot.conversation);
      if(c.control?.state==='held') break;
      await new Promise(r=>setTimeout(r,10));
    }
    assert.equal(c.control?.state, 'held');
    assert.equal(c.slot.session, originalSession);
    await sessionCommand(w.env, owner, { id: 'h-7', action: 'resume' }, o);
    await tick(w.env, o); c=loadConv(w.env, boot.conversation);
    assert.equal(native.slotOf({ id: c.body.replace(`${harness}:h-7-`, '') }).session, originalSession);
    assert.ok(w.log.some(x=>x[0]==='resume'&&x[2]===originalSession));
    const body={id:c.body.split(':')[1],agent:'art',house:'h-7',seat:'j-h-7'};
    native.finish(c.body.replace(`${harness}:h-7-`, `${harness}:`), {worked:true,failed:false});
    await until(()=>hr.turn(body));
    await tick(w.env,o);
    const done=await sessionCommand(w.env,owner,{id:'h-7'},o);
    assert.equal(done.report, 'TERMINAL-REPORT');
    assert.equal(done.state, 'done');
    assert.equal(load(w.env).houses['h-7'].state,'running','a completed turn keeps the terminal house available for reconnect');

  } finally { leave = true; await host; }
});

test('terminal controller refuses body credentials and other owners, and never promotes an unknown session', async () => {
  const w = world();
  update(w.env, s => { s.houses['h-7'] = { id: 'h-7', agent: 'art', state: 'running', session: true, taskActsFor: { owner: false, people: [], unknown: true } }; });
  for (const caller of [{ kind: 'agent', agent: 'art', house: 'h-7' }, { kind: 'owner', agents: ['mark'] }]) await assert.rejects(sessionCommand(w.env, caller, { id: 'h-7' }, w.o), /owner|no such/);
  await assert.rejects(sessionCommand(w.env, { kind: 'owner' }, { id: 'h-7' }, w.o), /no shared terminal host/);
  for (const caller of [{ kind: 'owner' }, { kind: 'agent', agent: 'mark', house: 'h-7' }, { kind: 'agent', agent: 'art', house: 'h-7', service: 'bridge' }]) await assert.rejects(bootstrapSession(w.env, caller, w.o), /credential|session/);
  const boot = await bootstrapSession(w.env, { kind: 'agent', agent: 'art', house: 'h-7' }, { ...w.o, spawnWorker() {}, detach: true });
  assert.equal(loadConv(w.env, boot.conversation).actsFor.unknown, true);
  assert.equal(loadConv(w.env, boot.conversation).actsFor.owner, false);
});

test('guest capacity pressure cannot reap an idle interactive session waiting for reconnect', () => {
  const w=world(), now=Date.now();
  update(w.env,s=>{s.houses['h-7']={id:'h-7',agent:'art',kind:'body-host',seat:'j-h-7',state:'running',session:true};});
  const dir=join(w.env.LOOM_BOX_DATA,'delivery','hosts');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'art@j-h-7.json'),JSON.stringify({agent:'art',seat:'j-h-7',house:'h-7',report:{at:now,house:'h-7',bodies:{},done:{}},req:{},stop:{},inbox:{}}));
  assert.deepEqual(releaseEmptySeatHouses(w.env,'art','p-guest',now),[]);
  assert.equal(load(w.env).houses['h-7'].state,'running');
});
