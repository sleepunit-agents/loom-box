// Read-only native observation runs outside the host event loop. It never
// admits, starts, resumes, restores or stops native work.
import { configuredNativeRunner } from './runners.mjs';

let input = '';
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 4 * 1024 * 1024) throw Error('observation input exceeds its bound');
  }
  const { harness, configuration, token, model, bodyEnv } = JSON.parse(input);
  if (!['claude', 'codex'].includes(harness) || !/^[0-9a-f]{24}$/.test(token ?? '')) throw Error('invalid native observation');
  const runner = configuredNativeRunner(harness, configuration, process.env);
  const observed = runner.recoverLaunch(token, { model, env: bodyEnv });
  const body = observed?.body;
  if (observed?.state !== 'ready' || body?.harness !== harness || !/^[A-Za-z0-9-]{4,64}$/.test(body?.id ?? '')
      || (body.slot && (body.slot.harness !== harness || !/^[A-Za-z0-9-]{4,64}$/.test(body.slot.session ?? '')))) throw Error('native identity is not established');
  process.stdout.write(JSON.stringify({ state: 'ready', body: { id: body.id, harness,
    ...(body.slot ? { slot: { harness, session: body.slot.session } } : {}) } }));
} catch {
  // Neither a query failure nor an invalid reply establishes native absence.
  process.stdout.write(JSON.stringify({ state: 'pending' }));
}
