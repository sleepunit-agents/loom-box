import test from 'node:test';
import assert from 'node:assert/strict';
import { commitPreparedBody, endBody, readBody, resumeBody, startBody } from '../src/bodies.mjs';
import { world } from './delivery-world.mjs';

test('a body is selected and its generation prepared before the only native launch', async () => {
  const w = world();
  let selected, native;
  const body = await startBody(w.env, { agent: 'art', venue: 'slack', brief: 'private fixture input', place: 'dm:prepared' }, {
    ...w.o, bodyEnv: { LOOM_BODY_KEY: 'private-fixture-key' },
    async launch({ runner, harness, options, prepared }) {
      assert.equal(w.log.filter(row => row[0] === 'start').length, 0);
      assert.equal(harness, 'claude');
      assert.match(prepared.metadata.instance, /^[0-9a-f]{24}$/);
      assert.doesNotMatch(JSON.stringify(prepared), /private fixture input|private-fixture-key/);
      assert.equal(options.brief, 'private fixture input');
      selected = prepared;
      native = await runner.start(options);
      return native;
    },
  });
  assert.equal(body.instance, selected.metadata.instance);
  assert.equal(readBody(w.env, body.body).instance, selected.metadata.instance);
  assert.equal(w.log.filter(row => row[0] === 'start').length, 1);
  endBody(w.env, body.body, w.o);
  const ended = readBody(w.env, body.body).ended;
  const recovered = commitPreparedBody(w.env, selected, native, new Date(w.clock.now().getTime() + 10_000).toISOString());
  assert.equal(recovered.ended, ended, 'recovering the same commit cannot revive an ended generation');
  assert.ok(recovered.ended);
  assert.equal(recovered.started, body.started, 'recovery preserves the original start time');
});

test('failure of the preparation barrier starts no native work', async () => {
  const w = world();
  await assert.rejects(startBody(w.env, { agent: 'art', venue: 'slack', brief: 'fixture input' }, {
    ...w.o, launch() { throw new Error('prepared record could not commit'); },
  }), /could not commit/);
  assert.equal(w.log.filter(row => row[0] === 'start').length, 0);
});

test('a recovered native receipt does not lose its explicit input uncertainty at body commit', async () => {
  const w = world();
  const body = await startBody(w.env, { agent: 'art', venue: 'slack', brief: 'fixture input' }, {
    ...w.o, async launch({ runner, options }) { return { ...await runner.start(options), inputUncertain: true }; },
  });
  assert.equal(body.inputUncertain, true);
  assert.equal(readBody(w.env, body.body).inputUncertain, true);
});

test('resume prepares its new generation with the same native slot before dispatch', async () => {
  const w = world();
  const first = await startBody(w.env, { agent: 'art', venue: 'slack', brief: 'first fixture' }, w.o);
  endBody(w.env, first.body, w.o);
  let selected;
  const resumed = await resumeBody(w.env, { body: first.body, brief: 'resume fixture' }, {
    ...w.o, async launch({ runner, options, prepared, resume }) {
      selected = prepared;
      assert.equal(w.log.filter(row => row[0] === 'resume').length, 0);
      assert.equal(resume.session, first.slot.session);
      assert.equal(prepared.metadata.slot.session, first.slot.session);
      assert.notEqual(prepared.metadata.instance, first.instance);
      return runner.resume(resume, options);
    },
  });
  assert.equal(resumed.instance, selected.metadata.instance);
  assert.equal(resumed.slot.session, first.slot.session);
  assert.equal(resumed.resumed, first.body);
});
