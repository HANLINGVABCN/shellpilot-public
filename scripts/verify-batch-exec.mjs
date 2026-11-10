// Real SSH and a synthetic model on GitHub only; no user hosts or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';import {createInterface} from 'node:readline';
import ssh2 from 'ssh2';
assert(process.env.GITHUB_ACTIONS==='true'&&process.platform==='linux','Run batch acceptance only on GitHub Linux fixtures');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sp-batch-')),key=path.join(root,'ssh-key');
execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',key]);
const executed=[],children=new Set(),clients=new Set();let active=0,maximum=0,hostId,denyCommand='',approvals=[],pendingCommands=[];
const ssh=new ssh2.Server({hostKeys:[fs.readFileSync(key)]},client=>{
 clients.add(client);client.on('close',()=>clients.delete(client));
 client.on('authentication',context=>context.accept());
 client.on('ready',()=>client.on('session',accept=>accept().on('exec',(accept,reject,info)=>{
  const stream=accept(),tracked=info.command.includes('batch-test-');executed.push(info.command);
  if(tracked){active++;maximum=Math.max(maximum,active);}
  const child=spawn('bash',['-c',info.command],{cwd:root});children.add(child);
  child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream.stderr,{end:false});
  child.on('close',code=>{children.delete(child);if(tracked)active--;stream.exit(code??1);stream.end();});
  stream.on('close',()=>{if(child.exitCode===null)child.kill();});
 })));
});
const model=http.createServer(async(request,response)=>{
 const buffers=[];for await(const data of request)buffers.push(data);const body=JSON.parse(Buffer.concat(buffers));
 const messages=body.messages,lastUser=messages.findLastIndex(message=>message.role==='user');const toolFinished=messages.slice(lastUser+1).some(message=>message.role==='tool');
 const toolArgs={commands:pendingCommands};
 const delta=toolFinished?{content:'Batch completed'}:{tool_calls:[{index:0,id:'batch-fixture',type:'function',function:{name:'vps_exec_batch',arguments:JSON.stringify(toolArgs)}}]};
 response.writeHead(200,{'Content-Type':'text/event-stream'});
 response.write('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
 response.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:toolFinished?'stop':'tool_calls'}],usage:{prompt_tokens:30,completion_tokens:20,total_tokens:50}})+'\n\n');response.end('data: [DONE]\n\n');
});
let server,socket,mcp;
try{
 ssh.listen(0,'127.0.0.1');await once(ssh,'listening');model.listen(0,'127.0.0.1');await once(model,'listening');
 hostId='fixture_host';fs.writeFileSync(path.join(root,'hosts.json'),JSON.stringify([{id:hostId,name:'Fixture',host:'127.0.0.1',port:ssh.address().port,username:'fixture',password:'fixture-only'}]));
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({providers:[{id:'p',name:'Fixture',baseURL:'http://127.0.0.1:'+model.address().port+'/v1'}],models:[{id:'m',name:'fixture-model',providerId:'p'}],defaultModelId:'m',mcpEnabled:true,mcpReadOnly:false,mcpApprovalMode:'auto',mcpHostIds:[hostId],autoMemory:false,params:{maxSteps:4,maxTokens:0,contextChars:0}}));
 const executable=path.resolve('server-rs/target/debug/shellpilot-server');
 server=spawn(executable,[],{env:{...process.env,SHELLPILOT_DATA:root,SHELLPILOT_PORT:'0',SHELLPILOT_OPEN:'0'},stdio:['ignore','pipe','inherit']});
 const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),15000);server.stdout.on('data',data=>{const match=data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
 const runtime=JSON.parse(fs.readFileSync(path.join(root,'runtime.json'),'utf8'));
 const api=async(route,method='GET',body)=>{const response=await fetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});const value=await response.json();assert(response.ok,JSON.stringify(value));return value;};
 let settings=await api('/settings');const mode=async value=>{settings={...settings,mcpReadOnly:value==='readonly',mcpApprovalMode:value==='readonly'?'ask':value};await api('/settings','PUT',settings);};
 const call=async(commands,ok=true,name='vps_exec_batch')=>{
  const response=await fetch(base+'/api/mcp/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+runtime.token},body:JSON.stringify({name,arguments:name==='vps_exec_batch'?{commands}:commands}),signal:AbortSignal.timeout(25000)});
  const value=await response.json();assert.equal(response.ok,ok,JSON.stringify(value));return value;
 };
 const command=text=>({host:hostId,command:text,timeout:10});
 const marker='printf batch-test-preflight > preflight.txt';
 // Preflight checks the entire batch: no earlier command runs if a later one fails.
 for(const bad of [command("printf 'mkfs.ext4'"),{host:'outside_scope',command:'uname -a'},{host:hostId,command:''}]){
  const before=executed.filter(text=>text===marker).length;await call([command(marker),bad],false);assert.equal(executed.filter(text=>text===marker).length,before);assert(!fs.existsSync(path.join(root,'preflight.txt')));
 }
 await call([],false);await call(Array.from({length:17},()=>command('uname -a')),false);
 const compound="printf 'batch-test-disk\\n'; lsblk -d -o NAME,SIZE,TYPE 2>/dev/null | head -n 3";
 const result=await call([command(compound),command("printf 'batch-test-write' > output.txt; cat output.txt")]);
 assert.equal(result.results.length,2);assert(result.results[0].stdout.includes('batch-test-disk'));assert(result.results[0].stdout.includes('NAME'));assert.equal(result.results[1].stdout,'batch-test-write');assert.equal(fs.readFileSync(path.join(root,'output.txt'),'utf8'),'batch-test-write');
 maximum=0;const parallel=Array.from({length:8},(_,index)=>command(`sleep ${index===0?'0.4':'0.15'}; printf 'batch-test-parallel-${index}'`));
 const concurrent=await call(parallel);assert(maximum>1&&maximum<=4,'Expected 2-4 parallel command channels: '+maximum);concurrent.results.forEach((item,index)=>{assert.equal(item.stdout,'batch-test-parallel-'+index);assert.equal(item.command,parallel[index].command);assert.equal(item.hostId,hostId);});
 const failures=await call([command("printf 'batch-test-error' >&2; exit 7"),command("printf 'batch-test-success'")]);assert.equal(failures.results[0].exitCode,7);assert.equal(failures.results[0].stderr,'batch-test-error');assert.equal(failures.results[1].stdout,'batch-test-success');
 await mode('readonly');await call([command('uname -a')]);await call([command('uname -a'),command('printf batch-test-readonly > denied.txt')],false);assert(!fs.existsSync(path.join(root,'denied.txt')));
 await mode('full');const full=await call([command("printf 'mkfs.ext4'")]);assert.equal(full.results[0].stdout,'mkfs.ext4');
 const events=[];socket=new WebSocket(base.replace('http:','ws:')+'/ws');
 socket.onmessage=event=>{const message=JSON.parse(event.data);events.push(message);if(message.type==='tool-request'){
  assert(!executed.includes('printf batch-test-approved-first > approved-first.txt'),'Batch ran before all approvals finished');
  approvals.push(message.command);socket.send(JSON.stringify({type:message.command===denyCommand?'tool-deny':'tool-approve',reqId:message.reqId}));
 }};await once(socket,'open');
 await mode('ask');denyCommand='printf batch-test-denied-second > denied-second.txt';await call([command('printf batch-test-approved-first > approved-first.txt'),command(denyCommand)],false);assert(!fs.existsSync(path.join(root,'approved-first.txt')));assert(!fs.existsSync(path.join(root,'denied-second.txt')));assert.equal(approvals.length,2);
 denyCommand='';approvals=[];const approved=await call([command("printf 'batch-test-approval-ok'")]);assert.equal(approved.results[0].stdout,'batch-test-approval-ok');assert.equal(approved.results[0].approval.by,'user');assert.equal(approvals.length,1);
 await mode('ai');approvals=[];const aiFallback=await call([command("printf 'batch-test-AI-approval-fallback'")]);assert.equal(aiFallback.results[0].stdout,'batch-test-AI-approval-fallback');assert.equal(aiFallback.results[0].approval.by,'user');assert.equal(approvals.length,1);
 await mode('auto');pendingCommands=[command("printf 'batch-test-AI-query'; uname -s | head -n 1"),command('printf batch-test-AI-write > ai-output.txt')];events.length=0;
 socket.send(JSON.stringify({type:'agent-scope',hostIds:[hostId]}));socket.send(JSON.stringify({type:'chat',text:'Run fixture batch',mode:'full',effort:'off'}));
 const deadline=Date.now()+25000;while(!events.some(event=>event.type==='chat-done')){assert(Date.now()<deadline,'AI batch timeout');await new Promise(resolve=>setTimeout(resolve,50));}
 assert(!events.some(event=>event.type==='chat-done'&&event.error),JSON.stringify(events.filter(event=>event.error)));assert.equal(fs.readFileSync(path.join(root,'ai-output.txt'),'utf8'),'batch-test-AI-write');
 // Standalone MCP uses the same annotations and does not wait for GUI approval.
 socket.close();await once(socket,'close');server.kill();await once(server,'exit');fs.rmSync(path.join(root,'runtime.json'),{force:true});
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({...settings,mcpReadOnly:false,mcpApprovalMode:'ask'}));
 mcp=spawn(executable,['--mcp'],{env:{...process.env,SHELLPILOT_DATA:root},stdio:['pipe','pipe','inherit']});const replies=new Map();createInterface({input:mcp.stdout}).on('line',line=>{const value=JSON.parse(line);if(value.id)replies.set(value.id,value);});
 const send=value=>mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');const wait=async id=>{const deadline=Date.now()+5000;while(!replies.has(id)){assert(Date.now()<deadline,'MCP timeout');await new Promise(resolve=>setTimeout(resolve,20));}return replies.get(id);};
 send({id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'batch-test',version:'1'}}});await wait(1);send({method:'notifications/initialized'});send({id:2,method:'tools/list'});const listed=await wait(2);const batchTool=listed.result.tools.find(tool=>tool.name==='vps_exec_batch');assert.equal(batchTool.annotations.readOnlyHint,false);assert.equal(batchTool.annotations.destructiveHint,true);assert(!batchTool.description.includes('写操作必须单独'));
 send({id:3,method:'tools/call',params:{name:'vps_exec_batch',arguments:{commands:[command(compound)]}}});const needsGui=await wait(3);assert(needsGui.result.isError);assert(needsGui.result.content[0].text.includes('主窗口'));
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({...settings,mcpReadOnly:false,mcpApprovalMode:'full'}));send({id:4,method:'tools/call',params:{name:'vps_exec_batch',arguments:{commands:[command(compound)]}}});const standalone=await wait(4);assert.equal(standalone.result.isError,false);assert(standalone.result.structuredContent.result.results[0].stdout.includes('batch-test-disk'));
 console.log('PASS: compound and write batches; shared policy/blacklist/scope, whole-batch authorization, 4-way concurrency and ordered results; built-in AI plus GUI/standalone MCP');
}finally{
 socket?.close();mcp?.kill();if(server?.exitCode===null)server.kill();for(const child of children)child.kill();for(const client of clients)client.end();ssh.close();model.closeAllConnections();model.close();fs.rmSync(root,{recursive:true,force:true});
}
