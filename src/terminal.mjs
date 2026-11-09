// A terminal controller over delivery; it never launches a model or owns its native session.
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
/** A running container can still be setting up its repository and native host. Never allocate another one. */
export async function waitTerminalReady(call, id, { timeoutMs = 150_000, every = 1000, now = () => Date.now(), sleep = delay } = {}) {
  const end = now() + timeoutMs;
  for (;;) {
    try { return await call('session-command', { id, action: 'status' }); }
    catch (e) {
      if (e.status !== 409 || !e.message.includes('no shared terminal host yet')) throw e;
      if (now() >= end) throw Error(`${id}: its shared terminal host did not become ready. Reconnect to this same house after checking its image and entrypoint, or use attach --shell.`);
      await sleep(every);
    }
  }
}
export async function runTerminal({ call, id, input = process.stdin, output = process.stdout, shell = async () => { throw Error('no local shell for this house'); }, every = 1000 }) {
  const rl = createInterface({ input, output, terminal: !!output.isTTY });
  rl.pause();
  const command = (action, body = {}) => call('session-command', { id, action, ...body });
  const help = 'Write a message to steer the conversation, including while it works. /begin … /end sends several lines together. /stop, /resume, /model auto|claude|codex, /status, /shell, /retry, /discard, /detach, /close.';
  let closed = false, shellBusy = false, closing = false, closingSent = false, multiline = null, work = Promise.resolve();
  let lastRun, lastModel, lastState, reportRun, lastError, lastFailure, cards = new Map();
  const pending = [];
  const say = text => { output.write(`\n${text}\n`); if (!closed && !shellBusy) rl.prompt(true); };
  rl.setPrompt('you> ');
  const show = q => {
    const state = q.control ? `stop: ${q.control}` : q.paused ? 'paused' : q.working ? 'working' : q.queued ? `${q.queued} queued` : 'waiting';
    const model = q.model ? `${q.model.harness} / ${q.model.model}` : '';
    if (q.run !== lastRun) { lastRun = q.run; cards = new Map(); }
    if (model && model !== lastModel) { say(model); lastModel = model; }
    if (state !== lastState) { say(state); lastState = state; }
    for (const card of q.cards ?? []) {
      const signature = `${card.state}:${card.summary}`;
      if (cards.get(card.id) !== signature) { say(`${card.state}: ${card.summary}`); cards.set(card.id, signature); }
    }
    if (q.report && q.reportRun !== reportRun) { say(q.report); reportRun = q.reportRun; }
    if (q.state === 'failed' && q.reason && q.reason !== lastFailure) { say(q.reason); lastFailure = q.reason; }
  };
  const initial = await command('status').catch(e => { rl.close(); throw e; });
  output.write(`${id}: ${initial.agent} · ${initial.conversation}\n${help}\n`);
  show(initial); rl.prompt();
  const transmit = async message => {
    const answer = await command('send', message);
    if (answer.error || answer.status) throw Error(answer.error ?? 'The message was refused.');
    pending.splice(pending.indexOf(message), 1);
    say(`Message ${answer.seq} accepted${answer.reason ? `: ${answer.reason}` : ''}.`);
  };
  const handle = async line => {
    if (closing && !['/status', '/close', '/detach'].includes(line)) { closing = false; say('Closing cancelled by new input. Use /resume to continue the stopped conversation.'); }
    if (multiline !== null) {
      if (line === '/cancel') { multiline = null; say('Message cancelled.'); return; }
      if (line !== '/end') { multiline.push(line); return; }
      line = multiline.join('\n'); multiline = null;
    } else {
      if (line === '/begin') { multiline = []; say('Enter several lines; /end sends them, /cancel discards them.'); return; }
      if (line === '/help') { say(help); return; }
      if (line === '/retry') { for (const message of [...pending]) await transmit(message); return; }
      if (line === '/discard') { pending.length = 0; say('Unconfirmed messages discarded from this terminal.'); return; }
      if ((line === '/detach' || line === '/close') && pending.length) { say('Your unconfirmed message is kept here. /retry sends the same message ID; /discard explicitly discards it.'); return; }
      if (line === '/detach') { rl.close(); return; }
      if (line === '/close') { await command('interrupt'); closing = true; say('Stopping and saving the native session before closing its house.'); return; }
      if (line === '/stop') { say(JSON.stringify(await command('interrupt'))); return; }
      if (line === '/resume') { say(JSON.stringify(await command('resume'))); return; }
      if (line === '/status') { const q = await command('status'); show(q); say(JSON.stringify({ working: q.working, queued: q.queued, control: q.control, state: q.state })); return; }
      if (line === '/model' || line.startsWith('/model ')) {
        const harness = line.slice(6).trim();
        if (harness && !['auto', 'claude', 'codex'].includes(harness)) throw Error('/model auto|claude|codex');
        say(JSON.stringify(await command('model', harness ? { harness } : {}))); return;
      }
      if (line === '/shell') {
        shellBusy = true; rl.pause();
        try { await shell(); } finally { shellBusy = false; rl.resume(); rl.prompt(true); }
        return;
      }
    }
    if (!line.trim()) return;
    const message = { message: randomBytes(12).toString('hex'), text: line };
    pending.push(message);
    try { await transmit(message); } catch (e) { say(`${e.message}. Message retained; /retry sends its same ID, /discard discards it.`); }
  };
  rl.on('line', line => { work = work.then(() => handle(line)).catch(e => say(e.message)); if (!shellBusy) rl.prompt(); });
  rl.on('SIGINT', () => { work = work.then(() => command('interrupt')).then(() => say('Stop requested; the runtime is saving its session.')).catch(e => say(e.message)); });
  rl.once('close', () => { closed = true; });
  rl.resume();
  while (!closed) {
    await delay(every);
    if (closed || shellBusy) continue;
    try {
      const q = await command('status');
      if (lastError) { say('Runtime connected again.'); lastError = undefined; }
      show(q);
      if (closing && q.control === 'held' && !closingSent) {
        closingSent = true;
        try { await call('down', { id }); say('Session saved; the house is closing.'); rl.close(); }
        catch (e) { closingSent = false; throw e; }
      }
    } catch (e) { if (lastError !== e.message) say(`Runtime unavailable: ${e.message}. Your conversation remains with the runtime; /detach leaves this terminal.`); lastError = e.message; }
  }
  await work;
  if (multiline?.length) { output.write(`Unsent multiline message; save this text to retry:\n${multiline.join('\n')}\n`); return 1; }
  if (pending.length) { for (const message of pending) output.write(`Unconfirmed message ${message.message}; save this text to retry:\n${message.text}\n`); return 1; }
  return 0;
}
