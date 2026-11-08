import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
assert(process.env.GITHUB_ACTIONS==='true'&&process.platform==='win32','Run sandbox checks only on isolated Windows CI');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-workspace-')),root=path.join(dir,'working'),data=path.join(dir,'data');
fs.mkdirSync(root);fs.mkdirSync(data);
const outside=path.join(process.env.USERPROFILE,'Documents','shellpilot-outside-'+Date.now());
fs.mkdirSync(outside,{recursive:true});const canary=path.join(outside,'private.txt');fs.writeFileSync(canary,'outside-fixture-must-be-protected');
const script=path.resolve('server-rs/target/debug/shellpilot-server.exe');
const backend=spawn(script,[],{env:{...process.env,SHELLPILOT_DATA:data,SHELLPILOT_PORT:'0',SHELLPILOT_OPEN:'0'},stdio:['ignore','pipe','inherit']});
let base;
try{
 base=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Workspace backend timeout')),15000);backend.stdout.on('data',b=>{const m=b.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(t);resolve(m[0]);}});});
 const api=async(route,method='GET',body,ok=true)=>{
  const res=await fetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await res.json();
  assert.equal(res.ok,ok,route+': '+JSON.stringify(data));return data;
 };
 const action=async(name,args)=>api('/workspace/action','POST',{name,arguments:args});
 const execute=command=>action('workspace_exec',{command,timeout:45000});
 await api('/workspace','PUT',{directory:root,enabled:true,network:false});
 assert.equal((await api('/workspace')).enabled,true);
 await action('workspace_write',{path:'input.txt',content:'hello workspace'});
 assert.equal((await action('workspace_read',{path:'input.txt'})).content,'hello workspace');
 const pending=execute("Get-Content -LiteralPath './input.txt'; Set-Content -LiteralPath './output.txt' -Value 'sandbox output' -Encoding UTF8; $env:USERNAME");
 const trace=setTimeout(()=>{
  try{console.log(execFileSync('powershell.exe',['-NoProfile','-Command',"Get-Process powershell -ErrorAction SilentlyContinue|Select-Object Id,CPU,Handles,Threads,Responding|ConvertTo-Json -Depth 1;Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=(Get-Date).AddMinutes(-2)} -MaxEvents 4 -ErrorAction SilentlyContinue|Select-Object ProviderName,Id,Message|ConvertTo-Json"],{encoding:'utf8',timeout:5000}));}catch{}
 },5000);
 const run=await pending;clearTimeout(trace);
 assert.equal(run.exitCode,0,JSON.stringify(run));assert(run.stdout.includes('hello workspace'));assert(fs.readFileSync(path.join(root,'output.txt'),'utf8').includes('sandbox output'));
 assert.equal(run.sandbox,'AppContainer');
 const outsidePs=canary.replaceAll("'","''");
 const denied=await execute("Get-Content -LiteralPath '"+outsidePs+"'");
 assert.notEqual(denied.exitCode,0,'AppContainer must deny outside user-file reads');
 assert(!denied.stdout.includes('outside-fixture-must-be-protected'));
 const modify=await execute("Set-Content -LiteralPath '"+outsidePs+"' -Value 'bad'");
 assert.notEqual(modify.exitCode,0);assert.equal(fs.readFileSync(canary,'utf8'),'outside-fixture-must-be-protected');
 for(const p of ['../private.txt','C:/Windows/win.ini','.shellpilot/task.ps1']){
  await api('/workspace/action','POST',{name:'workspace_read',arguments:{path:p}},false);
 }
 const previous=await action('workspace_read',{path:'input.txt'});
 await api('/workspace/action','POST',{name:'workspace_write',arguments:{path:'input.txt',content:'bad',expectedHash:'wrong'}},false);
 assert.equal((await action('workspace_read',{path:'input.txt'})).content,previous.content);
 // A junction in the workspace cannot bypass the server or AppContainer boundary.
 const junction=path.join(root,'outside-link');
 fs.symlinkSync(outside,junction,'junction');
 await api('/workspace/action','POST',{name:'workspace_read',arguments:{path:'outside-link/private.txt'}},false);
 const linkRead=await execute("Get-Content -LiteralPath './outside-link/private.txt'");
 assert.notEqual(linkRead.exitCode,0);assert(!linkRead.stdout.includes('outside-fixture-must-be-protected'));fs.unlinkSync(junction);
 const hardlink=path.join(root,'private-hardlink.txt');fs.linkSync(canary,hardlink);
 await api('/workspace/action','POST',{name:'workspace_read',arguments:{path:'private-hardlink.txt'}},false);
 await api('/workspace/action','POST',{name:'workspace_write',arguments:{path:'private-hardlink.txt',content:'bad'}},false);
 fs.unlinkSync(hardlink);assert.equal(fs.readFileSync(canary,'utf8'),'outside-fixture-must-be-protected');
 const form=new FormData();form.append('files',new Blob(['uploaded workspace file']),'upload.txt');
 const upload=await fetch(base+'/api/workspace/upload',{method:'POST',body:form});assert(upload.ok);
 const download=await fetch(base+'/api/workspace/download?path=upload.txt');assert.equal(await download.text(),'uploaded workspace file');
 const timed=await action('workspace_exec',{command:"Start-Sleep -Seconds 20; Set-Content late.txt 'bad'",timeout:300});
 assert(timed.error?.includes('超时'));await new Promise(r=>setTimeout(r,500));assert(!fs.existsSync(path.join(root,'late.txt')));
 await api('/workspace','PUT',{directory:root,enabled:false,network:false});
 await api('/workspace/action','POST',{name:'workspace_list',arguments:{}},false);
 console.log('PASS: actual AppContainer workspace read/write/command, private-file denial, junction denial, uploads/downloads, stale hashes, timeout and disable');
}finally{
 if(backend.exitCode===null){backend.kill();await once(backend,'exit');}
 fs.rmSync(outside,{recursive:true,force:true});
}
