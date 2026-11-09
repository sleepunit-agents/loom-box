// Opt-in cross-repository bench. Imports the built companion core, never an installed service.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.CONTINUATION_CORE;
const load = (p) => import(pathToFileURL(join(root, p)));
const { loadHousehold, agentDir, createToken } = await load('dist/household.js');
const { createConversationTables } = await load('dist/backends/conversations.js');
const { openThread, setArchived, deleteThread, sweepComms } = await load('dist/comms.js');
const { startHttpServer } = await load('dist/transport/http-server.js');
const { default: Sqlite } = await load('node_modules/better-sqlite3/lib/index.js');
const home = process.env.LOOM_HOME;
mkdirSync(join(home, 'agents', 'art'), { recursive: true });
writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# Art\n');
const db = new Sqlite(join(home, 'agents', 'art', 'memories.db'));
createConversationTables(db); db.close();
writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
mkdirSync(join(home, 'pieces', 'runtime'), { recursive: true });
writeFileSync(join(home, 'pieces', 'runtime', 'piece.json'), JSON.stringify({ v: 1, name: 'runtime', source: { repo: 'test/runtime', commit: 'a'.repeat(40) }, package: 'runtime', version: '1', installed: 'x', bins: ['loom-runtime'], loom: { name: 'runtime', role: 'runtime', settings: [], services: [] } }));
// Optional managed delivery bridge: the core still authenticates and launches
// its declared offer; the bridge substitutes only the harness-backed runtime world.
if (process.env.CONTINUATION_BRIDGE) {
  const bin = join(home, 'pieces', 'bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'loom-runtime'), `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nif (process.argv[2] === 'api' && process.env.CONTINUATION_RUNTIME_CLI) {\n  const r = spawnSync(process.execPath, [process.env.CONTINUATION_RUNTIME_CLI, ...process.argv.slice(2)], {stdio:'inherit', env:process.env});\n  process.exit(r.status ?? 1);\n}\nlet b=''; for await (const c of process.stdin) b+=c; const r=await fetch(${JSON.stringify(process.env.CONTINUATION_BRIDGE)}, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:process.argv[2],input:JSON.parse(b)})}); process.stdout.write(await r.text());\n`, {mode:0o755});
  const file = join(home, 'pieces', 'runtime', 'piece.json');
  const {readFileSync} = await import('node:fs');
  const record = JSON.parse(readFileSync(file)); record.loom.delivery=['loom-runtime','deliver','--json'];
  writeFileSync(file, JSON.stringify(record));
  for (const name of ['clock', 'impostor']) {
    mkdirSync(join(home,'pieces',name),{recursive:true});
    writeFileSync(join(home,'pieces',name,'piece.json'),JSON.stringify({v:1,name,source:{repo:'test/'+name,commit:'b'.repeat(40)},package:name,version:'1',installed:'x',bins:[],loom:{name,role:name==='clock'?'clock':undefined,delivers_wake:true,venues:{wake:{}}}}));
  }
}
const h = loadHousehold(home);
const thread = process.env.CONTINUATION_PLACE ? { id: process.env.CONTINUATION_PLACE } : openThread(h, process.env, h.members[0], { agent: 'art', id: 'aaaaaaaaaaaaaaaa', text: 'source' }).thread;
const token = createToken(h, { role: { kind: 'runtime', piece: 'runtime' }, label: `bench-${process.pid}`, runtimePieces: ['runtime'] }).token;
const server = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
const clockToken = process.env.CONTINUATION_BRIDGE ? createToken(h, {role:{kind:'piece',piece:'clock'},label:'clock'}).token : undefined;
const impostorToken = process.env.CONTINUATION_BRIDGE ? createToken(h, {role:{kind:'piece',piece:'impostor'},label:'impostor'}).token : undefined;
const agentToken = process.env.CONTINUATION_BRIDGE ? createToken(h, {role:{kind:'agent',agent:'art'},label:'agent'}).token : undefined;
process.send({ port: server.port, token, clockToken, impostorToken, agentToken, place: thread.id });

// Test control stays on the parent IPC channel; never an HTTP production route.
process.on('message', ({ action }) => {
  if (action === 'sweep') sweepComms(h, new Date('2027-02-01T00:00:00Z'));
  else if (action === 'archive') setArchived(h, thread, true);
  else if (action === 'delete') deleteThread(h, thread);
  else if (action === 'delete-crash') {
    const original = Sqlite.prototype.prepare;
    Sqlite.prototype.prepare = function(sql) {
      const statement = original.call(this, sql);
      if (sql === 'DELETE FROM comms_messages WHERE thread = ?') {
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          const result = run(...args);
          process.send({ applied: 'delete-crash' });
          // Parent kills the process after words/receipt removal and before
          // deleteThread can continue. This is an actual SQLite commit boundary.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          return result;
        };
      }
      return statement;
    };
    deleteThread(h, thread);
  }
  else throw new Error('unknown retention fixture action');
  process.send({ applied: action });
});
