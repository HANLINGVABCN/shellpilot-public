// Keep one initialized MCP process alive across main-app and credential changes.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {createInterface} from 'node:readline';
assert(process.env.GITHUB_ACTIONS==='true','MCP restart checks use isolated GitHub data');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sp-mcp-restart-'));const executable=path.resolve('server-rs/target/debug/shellpilot-server'+(process.platform==='win32'?'.exe':''));
fs.writeFileSync(path.join(directory,'hosts.json'),JSON.stringify([{id:'h',name:'Fixture',host:'127.0.0.1',port:1,username:'fixture',password:'never-export'}]));
fs.writeFileSync(path.join(directory,'settings.json'),JSON.stringify({mcpEnabled:true,mcpReadOnly:false,mcpApprovalMode:'full',mcpHostIds:['h']}));
const mcp=spawn(executable,['--mcp'],{env:{...process.env,SHELLPILOT_DATA:directory},stdio:['pipe','pipe','inherit']});let id=0,backend,mock,token='old',rotate=false,requests=0,accepted=0,drop=false,authFail=false;
const pending=new Map();createInterface({input:mcp.stdout}).on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}const entry=pending.get(message.id);if(entry){pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(Error(message.error.message)):entry.resolve(message.result);}});
const testTimer=setTimeout(()=>{console.error('MCP lifecycle fixture exceeded its time budget');process.exit(1);},90000);
const request=(method,params={})=>new Promise((resolve,reject)=>{const next=++id,timer=setTimeout(()=>{pending.delete(next);reject(Error('MCP response timeout'));},10000);pending.set(next,{resolve,reject,timer});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');});
const call=(name='vps_list',args={})=>request('tools/call',{name,arguments:args});
const runtimeFile=path.join(directory,'runtime.json');
const writeRuntime=port=>fs.writeFileSync(runtimeFile,JSON.stringify({port,token}));
const stop=async child=>{if(child?.exitCode===null&&child.signalCode===null){const closed=once(child,'exit');child.kill();await closed;}};
const startMain=async()=>{
 backend=spawn(executable,[],{env:{...process.env,SHELLPILOT_DATA:directory,SHELLPILOT_PORT:'0',SHELLPILOT_OPEN:'0'},stdio:['ignore','pipe','inherit']});
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Main app startup timeout')),10000);backend.stdout.on('data',data=>{const match=data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
};
try{
 await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'persistent-fixture',version:'1'}});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const pid=mcp.pid;assert.equal((await call()).isError,false);
 for(let round=0;round<3;round++){
  await startMain();const runtime=JSON.parse(fs.readFileSync(runtimeFile));assert.equal((await call()).isError,false);
  await stop(backend);assert.equal((await call()).isError,false,'Main app closing must leave STDIO usable');await startMain();assert.notEqual(JSON.parse(fs.readFileSync(runtimeFile)).token,runtime.token);assert.equal((await call()).isError,false);assert.equal(mcp.pid,pid);assert.equal(mcp.exitCode,null);await stop(backend);console.log('PASS: persistent MCP main-app restart '+(round+1));
 }
 mock=http.createServer(async(req,res)=>{
  for await(const data of req){}requests++;
  if(rotate){rotate=false;token='rotated';writeRuntime(mock.address().port);res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'authentication failed'}));return;}
  if(authFail||req.headers.authorization!=='Bearer '+token){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'authentication failed'}));return;}
  accepted++;if(drop){res.destroy();return;}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({marker:'gui-result'}));
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');token='old';writeRuntime(mock.address().port);
 rotate=true;const renewed=await call('vps_exec',{host:'h',command:'echo fixture'});assert.equal(renewed.isError,false);assert.equal(renewed.structuredContent.result.marker,'gui-result');assert.equal(requests,2);assert.equal(accepted,1,'Only the authenticated request may execute');
 authFail=true;const denied=await call();assert.equal(denied.isError,true);assert.equal(requests,3,'Unchanged bad token cannot loop or fall back');authFail=false;
 drop=true;const unknown=await call('vps_exec',{host:'h',command:'echo operation'});assert.equal(unknown.isError,true);assert(unknown.content[0].text.includes('没有自动重放'));assert.equal(requests,4);assert.equal(accepted,2,'A lost response cannot retry the operation');
 drop=false;assert.equal((await call()).isError,false,'The same process recovers on the next request');assert.equal(mcp.exitCode,null);
 const settings=JSON.parse(fs.readFileSync(path.join(directory,'settings.json')));settings.mcpEnabled=false;fs.writeFileSync(path.join(directory,'settings.json'),JSON.stringify(settings));const disabled=await call();assert.equal(disabled.isError,true,'Restart recovery cannot bypass disabling MCP');
 console.log('PASS: one MCP PID survives 3 main-app restarts and credential rotations; 401 refreshes before execution, bad auth/disabled MCP remain denied, lost write response is not replayed');
}finally{clearTimeout(testTimer);for(const entry of pending.values())clearTimeout(entry.timer);await stop(backend);mcp.stdin.end();await stop(mcp);mock?.closeAllConnections();mock?.close();fs.rmSync(directory,{recursive:true,force:true});}
