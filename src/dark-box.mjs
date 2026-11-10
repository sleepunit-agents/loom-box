// A box gone dark with an agent's conversations on it (t-2057). The runtime can't prove its houses stopped, so their
// bodies are held, never written off by a timeout: the box may come back, and two bodies must never run one
// conversation. What moves them is the household owner's word: a card per agent and stretch of silence ("Carry on Art's
// 2 conversations from one on another box?"). His Allow writes exactly those houses off (control.mjs, writeOffBox): each
// body is retired as terminated without history, with the notice that its effects may already have happened, and its
// conversation goes on in a house on the next box of the agent's list. A box that's heard from again withdraws its card.
//
// Silence is the box's and its houses': a house whose own body host still reports (the box's process died, its
// containers didn't) is running, and is never on a card.
import { approvalsFake, approvalsRunAsync, approvalsWhy } from './approvals-call.mjs';
import { LIVE, WRITE_OFF_AFTER_MS, boxNameOf, householdOwner, writeOffBox } from './control.mjs';
import { houseHeard } from './houserunner.mjs';
import { load, update } from './state.mjs';

export const WRITE_OFF_KIND = 'box-write-off';
/** `<agent>:<box id>@<last heard, unix seconds>`: the agent's houses on that box, for that one stretch of silence. */
export const WRITE_OFF_TARGET = /^([a-z][a-z0-9-]{0,39}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})@([0-9]{1,12})$/;
/** A filing that may or may not have happened (timed out) is tried again after this; approvals hands back the same card. */
const RETRY_MS = 10 * 60_000;
/** An approval in one of these can't be applied any more: the card is filed again while the work is still held. */
const OVER = new Set(['expired', 'used', 'withdrawn', 'gone']);
/** After a No, the same houses are asked about again after this, in case that box is gone for good. */
export const DENIED_FOR = 12 * 3_600_000;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const runtimeAs = (agent) => JSON.stringify({ kind: 'agent', agent, house: 'loom\'s runtime' });
const dark = (b, nowMs) => !!b && !b.local && !b.revoked && !b.reportOnly && !!b.lastSeen && nowMs - Date.parse(b.lastSeen) >= WRITE_OFF_AFTER_MS;
const targetOf = (agent, box, lastSeen) => `${agent}:${box}@${Math.floor(Date.parse(lastSeen) / 1000)}`;

/**
 * Each dark box's agents with conversations held in its silent houses:
 * {`agent:box`: {agent, box, target, houses: [h], conversations: [cv]}}.
 */
export function heldOnDarkBoxes(env, s, convs, nowMs) {
  const out = {};
  for (const c of convs) {
    const m = /^(?:claude|codex):(h-[0-9]+)-/.exec(c.body ?? '');
    const h = m && s.houses?.[m[1]];
    if (!h || h.service || !LIVE.has(h.state) || h.agent !== c.agent || !dark(s.boxes?.[h.box], nowMs)) continue;
    if (houseHeard(env, h.agent, h.id, nowMs)) continue;
    const key = `${h.agent}:${h.box}`;
    const x = (out[key] ??= { agent: h.agent, box: h.box, target: targetOf(h.agent, h.box, s.boxes[h.box].lastSeen), houses: [], conversations: [] });
    if (!x.houses.includes(h.id)) x.houses.push(h.id);
    x.conversations.push(c.conversation);
    ((x.byHouse ??= {})[h.id] ??= []).push(c.conversation);
  }
  for (const x of Object.values(out)) x.houses.sort();
  return out;
}

/** The approval's state as the approvals piece says it (pending, allowed, denied, used, expired, withdrawn, gone), or null. */
async function stateOf(env, agent, aid) {
  const fx = approvalsFake(env);
  if (fx) return fx.state?.(aid) ?? null;
  const r = await approvalsRunAsync(env, ['check', aid, '--as', runtimeAs(agent)]);
  if (r.error) return null;
  if (r.status !== 0) return /no approval/.test(r.stderr || '') ? 'gone' : null;
  return /^[a-z]+/.exec((r.stdout || '').trim())?.[0] ?? null;
}

/**
 * One pass, from delivery's tick: a card for each agent and dark box that holds its conversations and has none that can
 * still be answered, and each card whose box is back (or holds none of them now) withdrawn. Never throws.
 */
export async function askDarkBoxes(env, { convs, nowMs = Date.now(), warn = (m) => console.warn(m) }) {
  let s;
  try { s = load(env); } catch { return; }
  const held = heldOnDarkBoxes(env, s, convs, nowMs);
  // A card taken back this pass is asked anew on the next one, once its withdraw has landed: never two cards at once.
  const later = new Set();
  for (const [key, a] of Object.entries(s.writeOffAsks ?? {})) {
    const x = held[key];
    const agent = key.split(':')[0];
    const st = a.approval && !a.applied ? await stateOf(env, agent, a.approval) : null;
    const same = !!x && x.houses.length === (a.houses ?? []).length && x.houses.every((h) => a.houses.includes(h));
    // A No stands while the same houses wait: asked again after DENIED_FOR, or at once if more went quiet.
    if (st === 'denied') {
      a.deniedAt ??= nowMs;
      if (a.deniedAt === nowMs) update(env, (w) => { if (w.writeOffAsks?.[key]?.at === a.at) w.writeOffAsks[key].deniedAt = a.deniedAt; });
    }
    const retire = !x || a.applied || (a.target && x.target !== a.target) || OVER.has(st)
      || (['pending', 'allowed', 'denied'].includes(st) && !same) || (st === 'denied' && nowMs - a.deniedAt >= DENIED_FOR);
    if (!retire) continue;
    // A card that can still be answered is taken back first; only once that's done is its record let go, so a new filing
    // can never be handed back this one with other houses on it. If it can't be taken back (an answered one can't), it
    // stays as it was until it's over (an Allow on it still writes off exactly the houses it listed).
    if (a.approval && !a.applied && (st === 'pending' || st === null) && !(await withdraw(env, agent, a.approval, warn))) { later.add(key); continue; }
    if (a.approval && !a.applied && st === 'allowed') { later.add(key); continue; }
    update(env, (w) => { if (w.writeOffAsks?.[key]?.at === a.at) delete w.writeOffAsks[key]; });
    if (a.approval) later.add(key);
  }
  for (let [key, x] of Object.entries(held)) {
    if (later.has(key)) continue;
    const at = new Date(nowMs).toISOString();
    const mine = update(env, (st) => {
      const cur = st.writeOffAsks?.[key];
      if (cur && (cur.approval || nowMs - Date.parse(cur.at) < RETRY_MS)) return false;
      // A retry after a filing that may have landed files exactly what it first reserved: if approvals hands that card
      // back, it lists the same houses as the record. A change in houses is taken up once it has an id (taken back first).
      const houses = cur && cur.target === x.target && Array.isArray(cur.houses) ? cur.houses : x.houses;
      (st.writeOffAsks ??= {})[key] = { at, target: x.target, houses };
      return houses;
    });
    if (!mine) continue;
    if (mine !== x.houses) x = { ...x, houses: mine, conversations: mine.flatMap((h) => x.byHouse?.[h] ?? []) };
    const name = String(boxNameOf(s, x.box)).normalize('NFKC').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').replace(/[;:"“”]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    const n = x.conversations.length, mins = Math.floor((nowMs - Date.parse(s.boxes[x.box].lastSeen)) / 60_000);
    const work = n === 1 ? 'conversation' : `${n} conversations`;
    const ask = `The box “${name}” has been silent for ${mins} minutes. Carry on ${cap(x.agent)}'s ${work} from there on another box?`.slice(0, 140);
    const why = `${cap(x.agent)}'s ${work} can't go on until that box answers, or you say it's gone.`;
    const ifYes = `It goes on, on the next box ${cap(x.agent)} may use; it checks what it already did. If the box comes back, it's stopped there.`.slice(0, 140);
    const ifNo = 'It waits for that box to come back.';
    const details = `Box ${x.box}, last heard ${s.boxes[x.box].lastSeen}. Its houses there: ${x.houses.join(', ')}; their conversations: ${x.conversations.join(', ')}. Their history stays on that box, so each goes on without its last session and is told its work may already have had effects.`;
    const argv = ['request', '--kind', WRITE_OFF_KIND, '--target', x.target, '--ask', ask, '--why', why, '--if-yes', ifYes, '--if-no', ifNo,
      '--details', details, '--as', runtimeAs(x.agent), '--on-behalf', 'owner'];
    const release = () => update(env, (st) => { if (st.writeOffAsks?.[key]?.at === at && !st.writeOffAsks[key].approval) delete st.writeOffAsks[key]; });
    let aid;
    try {
      const fx = approvalsFake(env);
      if (fx) aid = fx.request?.(x.target, { kind: WRITE_OFF_KIND, ask, why, details });
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

/** Take back a card it filed: true once it's withdrawn (or was already). */
async function withdraw(env, agent, aid, warn) {
  try {
    const fx = approvalsFake(env);
    if (fx) return fx.withdraw?.(aid) !== false;
    const r = await approvalsRunAsync(env, ['withdraw', aid, '--as', runtimeAs(agent)]);
    if (!r.error && r.status === 0) return true;
    warn(`couldn't withdraw ${aid}: ${approvalsWhy(r).slice(-200)}`);
    return (await stateOf(env, agent, aid)) === 'withdrawn';
  } catch (e) { warn(`couldn't withdraw ${aid}: ${e.message}`); return false; }
}

/** The ask a card is about, or why it can't be applied now (checked before the owner's yes is spent, and again by writeOffBox). */
export function writeOffAsk(env, { agent, box, target, approval }, nowMs = Date.now()) {
  let s;
  try { s = load(env); } catch { return { why: 'the runtime couldn\'t read its state' }; }
  const b = s.boxes?.[box];
  if (!b || b.revoked) return { why: 'that box isn\'t one of loom\'s now' };
  if (b.local) return { why: 'that is loom\'s own machine' };
  const a = s.writeOffAsks?.[`${agent}:${box}`];
  if (!a || a.approval !== approval || a.target !== target || a.applied) return { why: 'this card is out of date (it was asked again, or answered)' };
  if (!dark(b, nowMs) || targetOf(agent, box, b.lastSeen) !== target) return { why: `${boxNameOf(s, box)} has been heard from since you were asked` };
  const heard = (a.houses ?? []).filter((h) => houseHeard(env, agent, h, nowMs));
  if (heard.length) return { why: `${heard.join(', ')} ${heard.length === 1 ? 'has' : 'have'} been heard from since you were asked, so ${heard.length === 1 ? 'it is' : 'they are'} still running` };
  return { ask: a, lastSeen: b.lastSeen };
}

/**
 * The owner's Allow on a `box-write-off` card, applied: loom core posts it as the household owner right after the
 * Allow, with the approval's id, its agent and target. Only the household owner's call, never a body's; the card must be
 * the one the runtime filed for exactly that agent, box and stretch of silence, its houses still unheard; then the
 * approval is spent and exactly the houses on the card are written off.
 */
export function writeOffApproved(env, effects, caller, fields, spend) {
  if (env.HOUSE_ID || env.LOOM_BODY_KEY || env.LOOM_BODY_CONVERSATION) return { ok: false, message: 'Writing off a box\'s houses is the household owner\'s call, never a body\'s.', page: '' };
  if (!(caller && householdOwner(caller) && (caller.agents === undefined || caller.agents === '*'))) return { ok: false, message: 'Writing off a box\'s houses is the household owner\'s call.', page: '' };
  const id = String(fields.id ?? ''), asker = String(fields.agent ?? ''), target = typeof fields.target === 'string' ? fields.target : '';
  const m = WRITE_OFF_TARGET.exec(target);
  if (!/^a-[0-9a-f]{8}$/.test(id) || !m || asker !== m[1]) return { ok: false, message: 'That isn\'t an agent\'s work on a box.', page: '' };
  const { why, ask, lastSeen } = writeOffAsk(env, { agent: m[1], box: m[2], target, approval: id }, +(effects.now?.() ?? new Date()));
  if (why) return { ok: false, message: `Nothing changed: ${why}.`, page: '' };
  const spent = spend(env, id, WRITE_OFF_KIND, target, asker, { onBehalf: 'owner' });
  if (spent) return { ok: false, message: `Nothing changed: the approval couldn't be spent (${String(spent).slice(0, 200)}).`, page: '' };
  let r;
  try { r = writeOffBox(env, effects, { name: m[2], agent: m[1], houses: ask.houses, lastSeen, heard: (h) => houseHeard(env, m[1], h, +(effects.now?.() ?? new Date())) }); } catch (e) {
    // Spent and not applied: the next pass sees it used and asks again while the work is still held.
    return { ok: false, message: `The approval was spent, but nothing was written off: ${String(e.message || e).slice(0, 200)}. You'll be asked again if it's still waiting.`, page: '' };
  }
  update(env, (st) => { const a = st.writeOffAsks?.[`${m[1]}:${m[2]}`]; if (a?.approval === id) a.applied = true; });
  const n = r.writtenOff.length;
  return { ok: true, message: n ? `${cap(m[1])}'s work on ${r.name} goes on elsewhere now (${n === 1 ? 'one house' : `${n} houses`} written off).` : `${cap(m[1])} had nothing left on ${r.name}.`, page: '' };
}
