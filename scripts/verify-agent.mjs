// Runs only in CI: real local SSH, mock model, agent loop, file changes, and MCP.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import ssh2 from 'ssh2';
const { Server } = ssh2;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-agent-'));
const key = path.join(dir, 'ssh-key');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
const configFile = path.join(dir, 'config.txt');
fs.writeFileSync(configFile, 'before\n');
let authentications = 0;
let metricsUnavailable = false;
const commands = [];
const ssh = new Server({ hostKeys: [fs.readFileSync(key)] }, (client) => {
  client.on('authentication', (context) => { authentications++; context.accept(); });
  client.on('ready', () => client.on('session', (accept) => accept()
    .on('pty',(accept)=>accept?.())
    .on('window-change',(accept)=>accept?.())
    .on('shell',(accept)=>{const stream=accept(); stream.write('SSH test terminal ready\r\n'); stream.on('data',()=>{});})
    .on('exec', (accept, _reject, info) => {
    const stream = accept();
    commands.push(info.command);
    if(metricsUnavailable && info.command.startsWith('powershell.exe')) {
      stream.write(JSON.stringify({platform:'windows',os:'Microsoft Windows Server 2022',cpu:27,memTotal:8192000,memUsed:4096000,memPct:50,diskTotalKB:104857600,diskUsedKB:52428800,diskPct:50,rxSum:10000,txSum:5000,uptime:7200}));
      stream.exit(0);stream.end();return;
    }
    if(metricsUnavailable && info.command.includes('===CPU===')) { stream.stderr.write('Linux metrics not supported'); stream.exit(1); stream.end(); return; }
    const process = spawn('sh', ['-c', info.command], { cwd: dir });
    stream.pipe(process.stdin);
    process.stdout.pipe(stream, { end: false });
    process.stderr.pipe(stream.stderr, { end: false });
    process.on('close', (code) => { stream.exit(code ?? 1); stream.end(); });
    stream.on('close', () => { if (process.exitCode === null) process.kill('SIGTERM'); });
  })));
});
ssh.listen(0, '127.0.0.1');
await new Promise((resolve) => ssh.once('listening', resolve));

let round = 0;
let unlimitedRound=0;
const memoryTasks=new Map(),queueTasks=new Map();
let hostId;
const model = http.createServer((req, res) => {
  let body = '';
  req.on('data', (part) => body += part);
  req.on('end', () => {
    const request = JSON.parse(body);
    const task = request.messages.filter((message) => message.role === 'user').at(-1)?.content;
    if(task?.startsWith('memory-')){
      const count=(memoryTasks.get(task)||0)+1;memoryTasks.set(task,count);
      const prompt=request.messages[0].content;
      let choice;
      if(task==='memory-use-off'){
        assert(prompt.includes('请使用简短中文回答'),'Enabled memory must be present with auto capture off');
        assert(!request.tools.some((tool)=>tool.function.name==='remember_memory'),'Auto capture off must remove memory writer tool');
        choice={delta:{content:'已使用现有记忆'},finish_reason:'stop'};
      }else if(task==='memory-disabled'){
        assert(!prompt.includes('请使用简短中文回答'),'Disabled memory content must not enter model context');
        choice={delta:{content:'已停用'},finish_reason:'stop'};
      }else if(count===1){
        choice={delta:{tool_calls:[{index:0,id:'mem-'+task,function:{name:'remember_memory',arguments:JSON.stringify({topic:'回答风格',content:task==='memory-protected'?'AI 尝试覆盖手动记忆':task==='memory-update'?'中文回答，尽量简短':'请使用简短中文回答'})}}]},finish_reason:'tool_calls'};
      }else{choice={delta:{content:'记忆处理完成'},finish_reason:'stop'};}
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[choice]})}\n\ndata: [DONE]\n\n`);return;
    }
    if(task?.startsWith('queue-')){
      const count=(queueTasks.get(task)||0)+1;queueTasks.set(task,count);
      const pathToWrite=path.join(dir,task);
      const choice=count===1?{delta:{tool_calls:[{index:0,id:'tool-'+task,function:{name:'vps_exec',arguments:JSON.stringify({host:hostId,command:`sleep 0.4; printf done >> ${pathToWrite}`})}}]},finish_reason:'tool_calls'}:{delta:{content:task+' finished'},finish_reason:'stop'};
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[choice]})}\n\ndata: [DONE]\n\n`);return;
    }
    if(task==='unlimited-test') {
      assert(!Object.hasOwn(request,'max_tokens') && !Object.hasOwn(request,'max_completion_tokens'),'Zero output budget must omit model token limits');
      unlimitedRound++;
      if(unlimitedRound===65) assert(request.messages.some((message)=>message.role==='tool' && message.tool_call_id==='unlimited-1'),'Zero history/context budgets must preserve the first tool result');
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const choice=unlimitedRound<=65 ? {delta:{tool_calls:[{index:0,id:`unlimited-${unlimitedRound}`,function:{name:'vps_list',arguments:'{}'}}]},finish_reason:'tool_calls'} : {delta:{content:'不限轮数测试完成'},finish_reason:'stop'};
      res.end(`data: ${JSON.stringify({choices:[choice]})}\n\ndata: [DONE]\n\n`);return;
    }
    if (task === 'repeat-test') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'repeat-' + Date.now(),function:{name:'vps_exec',arguments:JSON.stringify({host:hostId,command:'false'})}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (task === 'stop-exec') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'long-command',function:{name:'vps_exec',arguments:JSON.stringify({host:hostId,command:`sleep 2; printf done > ${path.join(dir,'must-stay-absent')}`})}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (task === 'stop-test') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"开始等待"}}]}\n\n');
      return;
    }
    const call = (name, args) => ({ index: 0, id: `call_${round}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    round++;
    let tool;
    if (round === 1) tool = call('vps_exec_batch', { commands: [{ host: hostId, command: 'uname -a' }, { host: hostId, command: 'ls -la /tmp' }] });
    if (round === 2) tool = call('vps_write_file', { host: hostId, path: configFile, content: 'after\n' });
    if (round === 3) {
      const preview = JSON.parse(request.messages.filter((m) => m.role === 'tool').at(-1).content);
      assert.equal(preview.preview, true);
      tool = call('vps_write_file', { host: hostId, path: configFile, content: 'after\n', preview: false, expectedHash: preview.expectedHash });
    }
    if (round === 4) tool = call('vps_read_file', { host: hostId, path: configFile, limit: 4096 });
    if (round === 5) tool = call('vps_exec', { host: hostId, command: `touch ${path.join(dir, 'remembered')}` });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    if (tool) {
      const args = tool.function.arguments;
      send({ choices: [{ delta: { tool_calls: [{ ...tool, function: { name: tool.function.name, arguments: args.slice(0, 5) } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] }, finish_reason: 'tool_calls' }] });
    } else send({ choices: [{ delta: { content: '任务完成，文件已验证。' }, finish_reason: 'stop' }], usage: { total_tokens: 100 } });
    res.end('data: [DONE]\n\n');
  });
});
model.listen(0, '127.0.0.1');
await new Promise((resolve) => model.once('listening', resolve));
const executable = path.resolve('server-rs/target/debug/shellpilot-server');
let backend = spawn(executable, [], { env: { ...process.env, SHELLPILOT_DATA: dir, SHELLPILOT_PORT: '0', SHELLPILOT_OPEN: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
let ws;
try {
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Backend startup timed out')), 15000);
    backend.stdout.on('data', (data) => {
      const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
  });
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(base + '/api' + route, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert(response.ok, route + ': ' + response.status);
    return response.json();
  };
  hostId = (await api('/hosts', 'POST', { name: 'ci-ssh', host: '127.0.0.1', port: ssh.address().port, username: 'ci', password: 'ci-test-only' })).id;
  let keys;
  const savedKey=`127.0.0.1:${ssh.address().port}`;
  let pinned;
  for (let n = 0; n < 60; n++) {
    try {pinned=JSON.parse(fs.readFileSync(path.join(dir,'trusted-host-keys.json'),'utf8'))[savedKey];}catch{}
    if(pinned && authentications>0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(pinned,'First connection must pin the host key automatically');
  assert(authentications>0,'First use must connect without manual confirmation');
  assert.equal((await api('/ssh/host-keys')).length,0,'First use must not leave a pending prompt');
  const trustedFile=path.join(dir,'trusted-host-keys.json');
  const saved=JSON.parse(fs.readFileSync(trustedFile,'utf8'));
  saved[savedKey]='changed-test-key';
  fs.writeFileSync(trustedFile,JSON.stringify(saved));
  const authenticationsBeforeChange=authentications;
  const identityEvents=[];
  const terminalSocket=new WebSocket(base.replace('http:','ws:')+'/ws');
  terminalSocket.onmessage=(event)=>identityEvents.push(JSON.parse(event.data));
  await new Promise((resolve)=>terminalSocket.onopen=resolve);
  terminalSocket.send(JSON.stringify({type:'attach',sessionId:'identity-test',hostId}));
  const identityDeadline=Date.now()+10000;
  while(!identityEvents.some((event)=>event.type==='ssh-host-key-required')) {assert(Date.now()<identityDeadline);await new Promise((r)=>setTimeout(r,100));}
  const identityState=identityEvents.find((event)=>event.type==='status' && event.state==='host-key-required');
  assert(identityState?.message.includes('服务器身份已变化'),'Terminal must receive the real changed-identity error, not generic connection failure');
  keys=await api('/ssh/host-keys');
  assert.equal(keys[0].changed,true);
  assert.equal(authentications,authenticationsBeforeChange,'A changed server identity must block authentication');
  assert.equal(identityEvents.find((event)=>event.type==='ssh-host-key-required').key.fingerprint,keys[0].fingerprint);
  await api('/ssh/trust', 'POST', { hostId, fingerprint: keys[0].fingerprint });
  terminalSocket.send(JSON.stringify({type:'attach',sessionId:'identity-test',hostId}));
  const connectedDeadline=Date.now()+15000;
  while(!identityEvents.some((event)=>event.type==='status' && event.state==='connected')) {assert(Date.now()<connectedDeadline);await new Promise((r)=>setTimeout(r,100));}
  terminalSocket.close();
  await api('/settings', 'PUT', {
    providers: [{ id: 'p', name: 'ci-model', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'ci-only' }],
    models: [{ id: 'm', providerId: 'p', name: 'ci-model' }], defaultModelId: 'm',
    mcpEnabled: true, mcpReadOnly: true, mcpHostIds: [hostId], params: { maxSteps: 12 },
  });
  const events = [];
  ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    events.push(message);
    if (message.type === 'tool-request') {
      if (message.command.startsWith('写入文件')) assert(message.preview, 'File writes must include an approval preview');
      ws.send(JSON.stringify({ type: 'tool-approve', reqId: message.reqId, remember: message.command.includes('remembered') }));
    }
  };
  await new Promise((resolve) => ws.onopen = resolve);
  ws.send(JSON.stringify({ type: 'agent-scope', hostIds: [hostId,hostId,'deleted-host'] }));
  ws.send(JSON.stringify({ type: 'chat', text: 'preview, update, verify', mode: 'ask', effort: 'off' }));
  async function until(predicate, timeout = 20000) {
    const start = Date.now();
    while (!predicate()) { assert(Date.now() - start < timeout, 'Timed out waiting for event'); await new Promise((r) => setTimeout(r, 100)); }
  }
  await until(() => events.some((event) => event.type === 'chat-done'));
  assert(!events.some((event) => event.type === 'chat-done' && event.error), JSON.stringify(events.filter((event) => event.error)));
  assert.equal(fs.readFileSync(configFile, 'utf8'), 'after\n');
  const backups = fs.readdirSync(dir).filter((name) => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), 'before\n');
  const chats = await api('/chats/__global__');
  const detail = await api('/chats/__global__/' + chats[0].id);
  assert.equal(detail.messages.at(-1).content, '任务完成，文件已验证。');
  assert.equal(detail.messages.filter((message) => message.role === 'tool').length, 5);
  assert.deepEqual((await api('/agent/status')).scope,[hostId], 'Server scope must remove duplicate and deleted IDs');

  // Use the actual MCP child and GUI bridge, checking read-only enforcement.
  const mcp = spawn(executable, ['--mcp'], { env: { ...process.env, SHELLPILOT_DATA: dir }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: mcp.stdout });
  const replies = new Map();
  lines.on('line', (line) => { const message = JSON.parse(line); replies.set(message.id, message); });
  const send = (value) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await until(() => replies.has(1));
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'vps_read_file', arguments: { host: hostId, path: configFile } } });
  await until(() => replies.has(2));
  assert.equal(replies.get(2).result.structuredContent.result.content, 'after\n');
  send({ id: 3, method: 'tools/call', params: { name: 'vps_exec', arguments: { host: hostId, command: `touch ${path.join(dir, 'forbidden')}` } } });
  await until(() => replies.has(3));
  assert.equal(replies.get(3).result.isError, true);
  assert(!fs.existsSync(path.join(dir, 'forbidden')));
  const count = commands.filter((command) => command.includes('remembered')).length;
  send({ id: 4, method: 'tools/call', params: { name: 'vps_exec', arguments: { host: hostId, command: `touch ${path.join(dir, 'remembered')}` } } });
  await until(() => replies.has(4));
  assert.equal(replies.get(4).result.isError, true, 'Remembered AI approvals cannot override MCP read-only');
  assert.equal(commands.filter((command) => command.includes('remembered')).length, count);
  const mcpSettings=await api('/settings');
  await api('/settings','PUT',{...mcpSettings,mcpReadOnly:false,mcpApprovalMode:'full'});
  send({id:5,method:'tools/call',params:{name:'vps_exec',arguments:{host:hostId,command:"printf 'mkfs'"}}});
  await until(()=>replies.has(5));
  assert.equal(replies.get(5).result.isError,false,'MCP full mode must honor user-selected full delegation');
  assert.equal(replies.get(5).result.structuredContent.result.stdout,'mkfs');
  await api('/settings','PUT',{...mcpSettings,mcpReadOnly:false,mcpApprovalMode:'auto'});
  send({id:6,method:'tools/call',params:{name:'vps_exec',arguments:{host:hostId,command:"printf 'mkfs'"}}});
  await until(()=>replies.has(6));
  assert.equal(replies.get(6).result.isError,true,'MCP automatic mode must still enforce its block policy');
  await api('/settings','PUT',mcpSettings);
  mcp.kill();

  events.length = 0;
  ws.send(JSON.stringify({ type: 'chat', text: 'stop-test', mode: 'ask', effort: 'off' }));
  await until(() => events.some((event) => event.type === 'chat-delta'));
  ws.send(JSON.stringify({ type: 'chat-select', chatId: chats[0].id }));
  ws.send(JSON.stringify({ type: 'chat-stop' }));
  await until(() => events.some((event) => event.type === 'chat-done'));
  assert(events.some((event) => event.type === 'chat-done' && event.error.includes('停止')));
  assert(events.some((event) => event.type === 'error' && event.message.includes('停止')));
  assert.equal((await api('/agent/status')).busy, false);
  assert.equal((await api('/agent/status')).pauseReady,true,'Stopping current task must report an idle paused queue');
  ws.send(JSON.stringify({type:'chat-resume'}));
  events.length = 0;
  ws.send(JSON.stringify({type:'chat',text:'stop-exec',mode:'auto',effort:'off'}));
  await until(() => commands.some((command) => command.includes('must-stay-absent')));
  ws.send(JSON.stringify({type:'chat-stop'}));
  await until(() => events.some((event) => event.type === 'chat-done'));
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert(!fs.existsSync(path.join(dir,'must-stay-absent')), 'Cancelled SSH command must not finish its write');
  ws.send(JSON.stringify({type:'chat-resume'}));
  events.length = 0;
  const failuresBefore = commands.filter((command) => command === 'false').length;
  ws.send(JSON.stringify({type:'chat',text:'repeat-test',mode:'auto',effort:'off'}));
  await until(() => events.some((event) => event.type === 'chat-done'));
  assert(events.some((event) => event.type === 'chat-done' && event.error.includes('重复失败')));
  assert.equal(commands.filter((command) => command === 'false').length - failuresBefore, 2, 'Repeated failures must not cause 20 executions');
  metricsUnavailable=true;
  const otherId=(await api('/hosts','POST',{name:'windows-like',host:'127.0.0.1',port:ssh.address().port,username:'ci',password:'ci-test-only'})).id;
  const metricsDeadline=Date.now()+15000;
  while(!events.some((event)=>event.type==='probe' && event.hostId===otherId && event.sample?.platform==='windows')) {assert(Date.now()<metricsDeadline);await new Promise((r)=>setTimeout(r,100));}
  const native=events.find((event)=>event.type==='probe' && event.hostId===otherId && event.sample?.platform==='windows');
  assert.equal(native.state,'online','Windows SSH must stay connected');
  assert.equal(native.sample.cpu,27,'Windows must provide real CPU metrics');
  assert.equal(native.sample.memPct,50);assert.equal(native.sample.diskPct,50);
  const snapshot=await api('/probe');
  assert.equal(snapshot.find((probe)=>probe.hostId===otherId).state,'online');
  assert.equal(snapshot.find((probe)=>probe.hostId===otherId).sample.platform,'windows');
  const unlimitedSettings=await api('/settings');
  await api('/settings','PUT',{...unlimitedSettings,params:{...unlimitedSettings.params,maxTokens:0,maxSteps:0,historyLimit:0,contextChars:0}});
  events.length=0;
  ws.send(JSON.stringify({type:'chat',text:'unlimited-test',mode:'auto',effort:'off'}));
  await until(()=>events.some((event)=>event.type==='chat-done'),40000);
  assert(!events.some((event)=>event.type==='chat-done' && event.error),'Zero budgets must not stop a valid task');
  assert.equal(unlimitedRound,66,'Valid tasks must continue beyond previous 60-round default');
  assert(events.some((event)=>event.type==='chat-progress' && event.step===65 && event.maxSteps===0));
  const activeChat=(await api('/agent/status')).chatId;
  events.length=0;
  ws.send(JSON.stringify({type:'chat',text:'stop-test',mode:'ask',effort:'off'}));
  await until(()=>events.some((event)=>event.type==='chat-delta'));
  const blockedDeletion=await fetch(base+'/api/chats/__global__/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[activeChat]})});
  assert.equal(blockedDeletion.status,409,'Running conversations cannot be deleted');
  ws.send(JSON.stringify({type:'chat-stop'}));
  await until(()=>events.some((event)=>event.type==='chat-done'));
  const deleted=await api('/chats/__global__/delete','POST',{ids:[activeChat,activeChat,'missing']});
  assert.equal(deleted.deleted,1);assert.equal(deleted.currentCleared,true);
  const cleared=await api('/agent/status');assert.equal(cleared.chatId,null);assert.deepEqual(cleared.messages,[]);
  assert.equal((await fetch(base+'/api/chats/__global__/'+activeChat)).status,404);
  assert(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir,'chats.json'),'utf8'))).includes(activeChat),'Deleted conversation must be removed from disk');
  const allDeleted=await api('/chats/__global__/delete','POST',{all:true});assert.equal(allDeleted.ok,true);
  assert.deepEqual(await api('/chats/__global__'),[]);
  ws.send(JSON.stringify({type:'chat-resume'}));
  async function runTask(text){events.length=0;ws.send(JSON.stringify({type:'chat',text,mode:'auto',effort:'off'}));await until(()=>events.some((event)=>event.type==='chat-done'));assert(!events.some((event)=>event.type==='chat-done'&&event.error),JSON.stringify(events.filter((event)=>event.error)));await until(()=>events.some((event)=>event.type==='chat-job-state'&&!event.busy));}
  await runTask('memory-capture');
  let memories=(await api('/memories')).memories;assert.equal(memories.length,1);assert.equal(memories[0].source,'ai');
  await runTask('memory-duplicate');assert.equal((await api('/memories')).memories.length,1,'Duplicate memory must not create another record');
  const settingsBeforeMemory=await api('/settings');await api('/settings','PUT',{...settingsBeforeMemory,autoMemory:false});
  const captureChat=(await api('/agent/status')).chatId;ws.send(JSON.stringify({type:'chat-clear'}));
  await runTask('memory-use-off');
  assert.notEqual((await api('/agent/status')).chatId,captureChat,'Enabled memory must be used in a new conversation with automatic memory off');
  await api('/memories/'+memories[0].id,'PUT',{enabled:false});
  await runTask('memory-disabled');
  await api('/settings','PUT',{...settingsBeforeMemory,autoMemory:true});
  await runTask('memory-no-reenable');assert.equal((await api('/memories')).memories[0].enabled,false,'Duplicate memory cannot reactivate a disabled record');
  const manual=await api('/memories','POST',{topic:'站点目录',content:'站点位于 /srv/demo',enabled:true});assert.equal(manual.memory.source,'manual');
  await api('/memories/'+manual.memory.id,'PUT',{topic:'站点目录',content:'站点位于 /opt/demo',expectedUpdatedAt:manual.memory.updatedAt});
  const conflict=await fetch(base+'/api/memories/'+manual.memory.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:'站点目录',content:'old',expectedUpdatedAt:manual.memory.updatedAt})});assert.equal(conflict.status,400,'Stale editor cannot overwrite updated memory');
  await api('/memories/batch','POST',{ids:[memories[0].id,manual.memory.id],enabled:true});
  await api('/settings','PUT',{...settingsBeforeMemory,autoMemory:true});
  await runTask('memory-update');
  const updatedMemory=(await api('/memories')).memories.find((memory)=>memory.topic==='回答风格');
  assert.equal(updatedMemory.id,memories[0].id,'Same-topic AI updates must replace the original entry');assert.equal(updatedMemory.content,'中文回答，尽量简短');
  await runTask('memory-duplicate-again');assert.equal((await api('/memories')).memories.length,2);
  const existing=(await api('/memories')).memories.find((memory)=>memory.topic==='回答风格');
  await api('/memories/'+existing.id,'PUT',{topic:'回答风格',content:'由用户手动维护的回答偏好'});
  await runTask('memory-protected');assert.equal((await api('/memories')).memories.find((memory)=>memory.id===existing.id).content,'由用户手动维护的回答偏好','AI cannot overwrite user-managed memory');
  const memoryFile=JSON.parse(fs.readFileSync(path.join(dir,'memories.json'),'utf8'));assert.equal(memoryFile.length,2);
  const exported=await fetch(base+'/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test-backup'})});assert(exported.ok);
  const exportData=Buffer.from(await exported.arrayBuffer()).toString('base64');await api('/import/preview','POST',{password:'test-backup',data:exportData});
  await api('/memories/batch','POST',{ids:[memories[0].id,manual.memory.id],action:'delete'});assert.equal((await api('/memories')).memories.length,0);
  await api('/import','POST',{password:'test-backup',data:exportData});assert.equal((await api('/memories')).memories.length,2,'Encrypted backup must restore memories');

  events.length=0;
  ws.send(JSON.stringify({type:'chat',text:'queue-first',mode:'auto',effort:'off'}));
  await until(()=>commands.some((command)=>command.includes('queue-first')));
  ws.send(JSON.stringify({type:'chat-pause'}));
  ws.send(JSON.stringify({type:'chat',text:'queue-edit',mode:'auto',effort:'off'}));
  ws.send(JSON.stringify({type:'chat',text:'queue-cancel',mode:'auto',effort:'off'}));
  await until(()=>events.some((event)=>event.type==='chat-job-state'&&event.queue?.length===2));
  const queued=(await api('/agent/status')).queue;
  ws.send(JSON.stringify({type:'chat-queue-edit',jobId:queued[0].id,text:'queue-second'}));
  ws.send(JSON.stringify({type:'chat-queue-remove',jobId:queued[1].id}));
  await until(()=>events.some((event)=>event.type==='chat-job-state'&&event.pauseReady));
  assert(fs.existsSync(path.join(dir,'queue-first')),'Already started command should finish before pause');
  assert(!fs.existsSync(path.join(dir,'queue-second'))&&!fs.existsSync(path.join(dir,'queue-cancel')));
  assert.equal(queueTasks.get('queue-first'),1,'Pause must not request the next model round');
  ws.send(JSON.stringify({type:'chat-resume'}));
  await until(()=>fs.existsSync(path.join(dir,'queue-second')));
  await until(()=>events.filter((event)=>event.type==='chat-done').length===2);
  assert.equal(fs.readFileSync(path.join(dir,'queue-first'),'utf8'),'done','Resume must never replay already completed writes');
  assert(!queueTasks.has('queue-edit')&&!queueTasks.has('queue-cancel'));
  const order=events.filter((event)=>event.type==='chat-start').map((event)=>event.text);assert.deepEqual(order,['queue-first','queue-second']);
  await until(()=>events.some((event)=>event.type==='chat-job-state'&&!event.busy&&!event.queue.length));
  ws.send(JSON.stringify({type:'chat-pause'}));
  ws.send(JSON.stringify({type:'chat',text:'queue-after-restart',mode:'auto',effort:'off'}));
  await until(()=>events.some((event)=>event.type==='chat-job-state'&&event.queue?.some((job)=>job.text==='queue-after-restart')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'agent-jobs.json'),'utf8')).queue.length,1,'Paused queues must persist');
  ws.close();
  const exit=new Promise((resolve)=>backend.once('exit',resolve));backend.kill();await exit;
  const port=new URL(base).port;
  backend=spawn(executable,[],{env:{...process.env,SHELLPILOT_DATA:dir,SHELLPILOT_PORT:port,SHELLPILOT_OPEN:'0'},stdio:['ignore','pipe','inherit']});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Restart timed out')),15000);backend.stdout.on('data',(data)=>{if(data.toString().includes(base)){clearTimeout(timeout);resolve();}});});
  const restored=await api('/agent/status');assert.equal(restored.paused,true);assert.equal(restored.queue[0].text,'queue-after-restart');
  assert(!fs.existsSync(path.join(dir,'queue-after-restart')),'Restored work must not start before explicit continue');
  assert.equal((await api('/memories')).memories.length,2,'Memories survive backend restart');
  events.length=0;
  ws=new WebSocket(base.replace('http:','ws:')+'/ws');ws.onmessage=(event)=>events.push(JSON.parse(event.data));await new Promise((resolve)=>ws.onopen=resolve);
  ws.send(JSON.stringify({type:'chat-resume'}));await until(()=>events.some((event)=>event.type==='chat-done'));
  assert.equal(fs.readFileSync(path.join(dir,'queue-after-restart'),'utf8'),'done');
  console.log('PASS: deleting current conversation clears agent state and disk; running tasks protected; batch/clear supported');
  console.log('PASS: auto-memory control independent of enabled memories, deduplication, editor conflicts, encrypted backup, pause/resume, FIFO/edit/cancel queue and no duplicate writes');
  console.log('PASS: SSH trust, parallel diagnostics, file preview/approval/backup/verification, persisted final reply, MCP bridge/read-only, task cancellation');
} finally {
  ws?.close();
  backend.kill();
  ssh.close(); model.closeAllConnections(); model.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
