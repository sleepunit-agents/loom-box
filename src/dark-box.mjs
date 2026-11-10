// A box gone dark with an agent's conversations on it (t-2057). The runtime can't prove its houses stopped, so their
// bodies are held, never written off by a timeout: the box may come back, and two bodies must never run one
// conversation. What moves them is the household owner's word: a card per agent and box ("Carry on Art's 2 conversations
// from one on another box?"). His Allow writes that agent's houses there off (control.mjs, writeOffBox): each body is
// retired as terminated without history, with the notice that its effects may already have happened, and its
// conversation goes on in a house on the next box of the agent's list. A box that's heard from again withdraws its card.
import { approvalsFake, approvalsRunAsync, approvalsWhy } from './approvals-call.mjs';
import { LIVE, WRITE_OFF_AFTER_MS, boxNameOf, householdOwner, resolveBox, writeOffBox } from './control.mjs';
import { load, update } from './state.mjs';

export const WRITE_OFF_KIND = 'box-write-off';
/** `<agent>:<box id>`: the agent's houses on that box. */
export const WRITE_OFF_TARGET = /^([a-z][a-z0-9-]{0,39}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
/** A filing that may or may not have happened (timed out) is tried again after this; approvals hands back the same card. */
const RETRY_MS = 10 * 60_000;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dark = (b, nowMs) => !!b && !b.local && !b.revoked && !b.reportOnly && !!b.lastSeen && nowMs - Date.parse(b.lastSeen) >= WRITE_OFF_AFTER_MS;

/** Each dark box's agents with conversations held in its houses: {`agent:box`: {agent, box, conversations: [cv]}}. */
export function heldOnDarkBoxes(s, convs, nowMs) {
  const out = {};
  for (const c of convs) {
    const m = /^(?:claude|codex):(h-[0-9]+)-/.exec(c.body ?? '');
    const h = m && s.houses?.[m[1]];
    if (!h || h.service || !LIVE.has(h.state) || h.agent !== c.agent || !dark(s.boxes?.[h.box], nowMs)) continue;
    const key = `${h.agent}:${h.box}`;
    (out[key] ??= { agent: h.agent, box: h.box, conversations: [] }).conversations.push(c.conversation);
  }
  return out;
}

/**
 * One pass, from delivery's tick: a card for each agent and dark box that holds its conversations and has none yet,
 * and each card whose box is back (or holds none of them now) withdrawn. Never throws; says what it couldn't do.
 */
export async function askDarkBoxes(env, { convs, runtimeAs, nowMs = Date.now(), warn = (m) => console.warn(m) }) {
  let s;
  try { s = load(env); } catch { return; }
  const held = heldOnDarkBoxes(s, convs, nowMs);
  const asks = s.writeOffAsks ?? {};
  // Answered (written off), back, or holding nothing now: its card goes.
  for (const [key, a] of Object.entries(asks)) {
    if (held[key]) continue;
    update(env, (st) => { if (st.writeOffAsks?.[key]?.at === a.at) delete st.writeOffAsks[key]; });
    if (a.approval && !a.applied) withdraw(env, key.split(':')[0], a.approval, warn);
  }
  for (const [key, x] of Object.entries(held)) {
    const at = new Date(nowMs).toISOString();
    const mine = update(env, (st) => {
      const cur = st.writeOffAsks?.[key];
      if (cur && (cur.approval || nowMs - Date.parse(cur.at) < RETRY_MS)) return false;
      (st.writeOffAsks ??= {})[key] = { at, ...(cur?.first ? { first: cur.first } : { first: at }) };
      return true;
    });
    if (!mine) continue;
    const name = String(boxNameOf(s, x.box)).normalize('NFKC').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').replace(/[;:"“”]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    const n = x.conversations.length, mins = Math.floor((nowMs - Date.parse(s.boxes[x.box].lastSeen)) / 60_000);
    const work = n === 1 ? 'conversation' : `${n} conversations`;
    const target = `${x.agent}:${x.box}`;
    const ask = `The box “${name}” has been silent for ${mins} minutes. Carry on ${cap(x.agent)}'s ${work} from there on another box?`.slice(0, 140);
    const why = `${cap(x.agent)}'s ${work} can't go on until that box answers, or you say it's gone.`;
    const ifYes = `It goes on, on the next box ${cap(x.agent)} may use; it checks what it already did. If the box comes back, it's stopped there.`.slice(0, 140);
    const ifNo = 'It waits for that box to come back.';
    const details = `Box ${x.box}, last heard ${s.boxes[x.box].lastSeen}. Its conversations there: ${x.conversations.join(', ')}. Its houses' history stays on that box, so each goes on without its last session and is told its work may already have had effects.`;
    const argv = ['request', '--kind', WRITE_OFF_KIND, '--target', target, '--ask', ask, '--why', why, '--if-yes', ifYes, '--if-no', ifNo,
      '--details', details, '--as', runtimeAs(x.agent), '--on-behalf', 'owner'];
    const release = () => update(env, (st) => { if (st.writeOffAsks?.[key]?.at === at && !st.writeOffAsks[key].approval) delete st.writeOffAsks[key]; });
    let aid;
    try {
      const fx = approvalsFake(env);
      if (fx) aid = fx.request?.(target, { kind: WRITE_OFF_KIND, ask, why, details });
      else {
        const r = await approvalsRunAsync(env, argv);
        aid = r.status === 0 ? /^(a-[0-9a-f]{8}):/.exec(r.stdout || '')?.[1] : undefined;
        if (!aid) {
          warn(`couldn't ask the owner about ${x.agent}'s work on dark box ${x.box}: ${approvalsWhy(r).slice(-200)}`);
          // A clear refusal lets it go; a timeout or unreadable answer keeps the reservation (it may be filed).
          if (!r.error && typeof r.status === 'number' && r.status !== 0) release();
          continue;
        }
      }
    } catch (e) { warn(`couldn't ask the owner about ${x.agent}'s work on dark box ${x.box}: ${e.message}`); release(); continue; }
    if (!/^a-[0-9a-f]{8}$/.test(aid ?? '')) { release(); continue; }
    update(env, (st) => { if (st.writeOffAsks?.[key]?.at === at) st.writeOffAsks[key].approval = aid; });
  }
}

function withdraw(env, agent, aid, warn) {
  try {
    const fx = approvalsFake(env);
    if (fx) return void fx.withdraw?.(aid);
    approvalsRunAsync(env, ['withdraw', aid, '--as', JSON.stringify({ kind: 'agent', agent, house: 'loom\'s runtime' })])
      .then((r) => { if (r.error || r.status !== 0) warn(`couldn't withdraw ${aid}: ${approvalsWhy(r).slice(-200)}`); });
  } catch (e) { warn(`couldn't withdraw ${aid}: ${e.message}`); }
}

/** Why the card can't be applied now, or '' (checked before the owner's yes is spent, and again by writeOffBox). */
export function writeOffProblem(env, { agent, box, approval }, nowMs = Date.now()) {
  let s;
  try { s = load(env); } catch { return 'the runtime couldn\'t read its state'; }
  let id;
  try { id = resolveBox(s, box); } catch { return 'that box isn\'t one of loom\'s now'; }
  if (id !== box) return 'that box isn\'t one of loom\'s now';
  const b = s.boxes[id];
  if (b.local) return 'that is loom\'s own machine';
  if (!dark(b, nowMs)) return `${boxNameOf(s, id)} has been heard from since you were asked`;
  const a = s.writeOffAsks?.[`${agent}:${id}`];
  if (!a || a.approval !== approval) return 'this card is out of date (it was asked again, or answered)';
  return '';
}

/**
 * The owner's Allow on a `box-write-off` card, applied: loom core posts it as the household owner right after the
 * Allow, with the approval's id, its agent and target. Only the household owner's call, never a body's; the card must be
 * the one the runtime filed for exactly that agent and box, the box still dark; then the approval is spent and that
 * agent's houses there are written off.
 */
export function writeOffApproved(env, effects, caller, fields, spend) {
  if (env.HOUSE_ID || env.LOOM_BODY_KEY || env.LOOM_BODY_CONVERSATION) return { ok: false, message: 'Writing off a box\'s houses is the household owner\'s call, never a body\'s.', page: '' };
  if (!(caller && householdOwner(caller) && (caller.agents === undefined || caller.agents === '*'))) return { ok: false, message: 'Writing off a box\'s houses is the household owner\'s call.', page: '' };
  const id = String(fields.id ?? ''), asker = String(fields.agent ?? ''), target = typeof fields.target === 'string' ? fields.target : '';
  const m = WRITE_OFF_TARGET.exec(target);
  if (!/^a-[0-9a-f]{8}$/.test(id) || !m || asker !== m[1]) return { ok: false, message: 'That isn\'t an agent\'s work on a box.', page: '' };
  const why = writeOffProblem(env, { agent: m[1], box: m[2], approval: id }, +(effects.now?.() ?? new Date()));
  if (why) return { ok: false, message: `Nothing changed: ${why}.`, page: '' };
  const spent = spend(env, id, WRITE_OFF_KIND, target, asker, { onBehalf: 'owner' });
  if (spent) return { ok: false, message: `Nothing changed: the approval couldn't be spent (${String(spent).slice(0, 200)}).`, page: '' };
  let r;
  try { r = writeOffBox(env, effects, { name: m[2], agent: m[1] }); } catch (e) {
    return { ok: false, message: `The approval was spent, but nothing was written off: ${String(e.message || e).slice(0, 200)}.`, page: '' };
  }
  update(env, (st) => { const a = st.writeOffAsks?.[target]; if (a?.approval === id) a.applied = true; });
  const n = r.writtenOff.length;
  return { ok: true, message: n ? `${cap(m[1])}'s work on ${r.name} goes on elsewhere now (${n === 1 ? 'one house' : `${n} houses`} written off).` : `${cap(m[1])} had nothing left on ${r.name}.`, page: '' };
}
