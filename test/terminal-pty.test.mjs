// Real terminal input must survive asynchronous activity redraws, not only line-oriented stream fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const probe = spawnSync('python3', ['-c', 'import pty']);
test('an unfinished terminal prompt survives tool activity arriving while the owner types', { skip: probe.status !== 0 }, () => {
  const py = String.raw`
import os,pty,select,subprocess,sys,tempfile,time,json,pathlib
node,module=sys.argv[1:]
source='''import {runTerminal} from MODULE;
let polls=0;const messages=[];
const call=async(path,q)=>{if(q.action==='send'){messages.push(q.text);return {seq:1};}
return {agent:'art',conversation:'cv-123456789abc',run:'run-1',working:true,cards:++polls>=3?[{id:'step',state:'running',summary:'Tool step while typing'}]:[]};};
await runTerminal({call,id:'h-7',every:30});console.log('PTY-RESULT '+JSON.stringify(messages));
'''.replace('MODULE',json.dumps(pathlib.Path(module).as_uri()))
with tempfile.TemporaryDirectory() as folder:
 script=pathlib.Path(folder)/'terminal.mjs';script.write_text(source)
 master,slave=pty.openpty()
 child=subprocess.Popen([node,str(script)],stdin=slave,stdout=slave,stderr=slave,close_fds=True)
 os.close(slave);data=b''
 def wait_for(needle):
  global data
  end=time.monotonic()+5
  while needle not in data:
   if time.monotonic()>end:raise AssertionError('terminal did not reach '+repr(needle))
   if select.select([master],[],[],.1)[0]:
    try:data+=os.read(master,65536)
    except OSError:raise AssertionError('terminal ended early')
 try:
  wait_for(b'you> ')
  os.write(master,b'my unfinished prompt')
  wait_for(b'Tool step while typing')
  os.write(master,b' stays intact\n/detach\n'.replace(b'\\n',b'\n'))
  wait_for(b'PTY-RESULT ')
  while child.poll() is None:
   if select.select([master],[],[],.1)[0]:
    try:data+=os.read(master,65536)
    except OSError:break
  child.wait(timeout=5)
  assert b'PTY-RESULT ["my unfinished prompt stays intact"]' in data,repr(data)
  assert child.returncode==0,child.returncode
 finally:
  if child.poll() is None:child.kill();child.wait()
  os.close(master)
`;
  const result = spawnSync('python3', ['-c', py, process.execPath, fileURLToPath(new URL('../src/terminal.mjs', import.meta.url))], { encoding:'utf8', timeout:10000 });
  assert.equal(result.status,0,result.stderr||result.error?.message);
});
