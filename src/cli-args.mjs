// Validate before dispatch: help and malformed flags must never read stdin,
// contact loom, start a service, or open settings for writing.
// A trailing '=' means a value is required. Keep each verb's flags here.
export const commandFlags = {
  ui: 'json', api: 'json serve', bundle: 'force',
  add: 'may-host= labels=', revoke: '',
  agent: 'repo= house-file= nested gpu branch= repo-secret= secret= port= tailnet= logins= scope= steer=',
  remote: 'box= dir=', 'rename-local': '', 'always-on': '', 'report-only': '',
  drill: 'agent= house= for=', health: 'json', primary: 'clear',
  up: 'agent= box= needs= slot= task= json', service: 'agent= box= force from= to=', slot: 'agent= from= to=',
  session: 'agent=', attach: 'shell', down: '', list: 'json',
  join: 'name= labels= report-only credential',
  'upgrade-apply': 'recover commit= from= repo= piece= target=', 'carry-settings': 'from= to=', run: 'local once',
  oneshot: 'cwd= prefer= model-need= timeout=',
  body: 'agent= venue= venue-kind= prefer= model-need= place= cwd= deny= brief= slot= text= id= json',
  deliver: 'conversation= stdin ref= every= once json', review: 'limit= introspect= scheduled day= json',
  'context-boundary': 'conversation= note= piece=', continuation: 'conversation= handle= id= text= piece=', send: 'conversation= person= via= text= piece=',
  spawn: 'house= service= agent= brief= prefer= model-need= role= failover title= timeout= text=',
  principal: 'inspect-continuation= agent= scheduled-at= verify house= reset wake conversation= place= for= id= origin-conversation= piece=',
  'task-host': 'brief-stdin', 'session-host': '', 'body-host': 'piece= host-key= beats=',
  models: 'json agent= venue= venue-kind= prefer= model-need= suppose-out=', roles: 'json why=',
  grants: 'json dry-run force paths=', trace: 'agent= house= service= json thread= run= conversation= piece=',
  place: 'piece=', host: 'approval= conversation= since= lines= cause= why= alert= days= hours= piece=', 'host-exec': 'once', file: 'conversation= out= piece=',
  relay: 'agent= house= service= to= say= why= reply-to= from= approval= conversation= json', relays: 'thread= json',
  'secrets-map': 'json', gates: 'json agent= from= stdin force', policy: 'json agent=',
  accounts: 'json', logins: 'json', login: '', usage: 'harness= session= root= day= timezone= limit= agent= box= json', help: '',
};

export function checkArgs(argv) {
  // Help wins everywhere, even if another argument is invalid or incomplete.
  if (argv.some(a => a === '-h' || a === '--help')) return { help: true };
  const [cmd, ...args] = argv;
  if (cmd === undefined || cmd === 'help') return { help: true };
  if (!Object.hasOwn(commandFlags, cmd)) throw usageError(`unknown command: ${cmd}`);
  const spec = new Map(commandFlags[cmd].split(' ').filter(Boolean).map(s => [`--${s.replace(/=$/, '')}`, s.endsWith('=')]));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-' || !a.startsWith('-')) continue;
    if (!spec.has(a)) throw usageError(`${cmd}: unknown flag ${a}`);
    if (spec.get(a)) {
      if (args[i + 1] === undefined || (!['--text', '--task', '--brief', '--say', '--why', '--title'].includes(a) && args[i + 1].startsWith('--'))) throw usageError(`${cmd}: ${a} needs a value`);
      i++;
    }
  }
  return { help: false };
}
function usageError(message) { return Object.assign(new Error(message), { code: 2 }); }
