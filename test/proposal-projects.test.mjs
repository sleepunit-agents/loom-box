import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryProblem, after, propose, gatesOf, GATES, PROPOSALS, view, answer, asks } from '../src/gates.mjs';
import { memStore } from '../src/store.mjs';
const entry = { name: 'Sebastian Niestepski', role: 'BASIN teammate', tier: 2, projects: ['pond'], slack: { T02AYL3QM: ['U0AS6KQQ8J3'] } };
test('project-scoped colleague is proposed and shown, then allowed through the owner action', async () => {
  const st = memStore(); st.put(GATES, 'art', { people: {} });
  const r = propose(st, { agent: 'art' }, { slug: 'sebastian-niestepski', entry: JSON.stringify(entry) });
  assert.equal(r.ok, true, r.message);
  const p = st.get(PROPOSALS, `art.${r.pid}`).doc;
  assert.deepEqual(p.entry.projects, ['pond']);
  assert.match(view('art', p, gatesOf(st, 'art').doc).detail, /pond/);
  assert.deepEqual(gatesOf(st, 'art').doc.people, {});
  const core = { ensure: async (b) => ({ ok: true, state: 'new', slug: b.slug }) };
  const r2 = await answer(st, core, 'gates-allow', asks(st)[0].actions[0].fields);
  assert.equal(r2.ok, true, r2.message);
  assert.deepEqual(gatesOf(st, 'art').doc.people['sebastian-niestepski'], entry);
});
test('projects are bounded unique slugs; no arbitrary grant fields', () => {
  assert.equal(entryProblem(entry), null);
  for (const projects of [null, 'pond', [], ['*'], ['Pond'], ['a/b'], ['pond', 'pond'], ['a'.repeat(65)], Array.from({ length: 11 }, (_, i) => `p${i}`)]) {
    assert.match(entryProblem({ ...entry, projects }), /projects/);
  }
  for (const key of ['restrict', 'field', 'grant']) assert.match(entryProblem({ ...entry, [key]: {} }), /carries only/);
});
test('omission preserves existing scope; explicit scope replaces it', () => {
  const doc = { people: { colleague: { ...entry, restrict: { x: true }, field: { x: true } } } };
  const { projects, ...unscoped } = entry;
  assert.deepEqual(after(doc, 'colleague', unscoped), doc.people.colleague);
  assert.deepEqual(after(doc, 'colleague', { ...entry, projects: ['other'] }).projects, ['other']);
});
