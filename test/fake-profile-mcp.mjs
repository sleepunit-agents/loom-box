// Real stdio MCP peer for executable profile conformance; never calls a model.
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const marker = process.argv[2];
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
createInterface({input:process.stdin}).on('line', line => {
  const q = JSON.parse(line); if (q.id === undefined) return;
  switch(q.method) {
    case 'initialize': return send(q.id,{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'profile-fixture',version:'1'}});
    case 'tools/list': return send(q.id,{tools:[{name:'profile_probe',description:'Return the declared MCP fixture content.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]});
    case 'tools/call':
      if(q.params.name !== 'profile_probe') return send(q.id,{content:[{type:'text',text:'unknown tool'}],isError:true});
      appendFileSync(marker,'called\n');
      return send(q.id,{content:[{type:'text',text:'DECLARED-MCP-CONTENT-CANARY'}]});
    case 'ping': return send(q.id,{});
    default: process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'Method not found'}})+'\n');
  }
});
