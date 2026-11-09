import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
assert(process.env.GITHUB_ACTIONS==='true'&&process.platform==='win32','Use isolated Windows CI');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-linux-')),data=path.join(dir,'data'),root=path.join(dir,'工作 文件');fs.mkdirSync(root);fs.mkdirSync(data);
const version=JSON.parse(fs.readFileSync('runtime/manifest.json','utf8')).version;
for(const [name,source] of [['windows-qemu','runtime-build/qemu-runtime'],['windows-guest','runtime-build/guest-runtime']]){
 const dest=path.join(data,'linux-runtime',name);fs.cpSync(source,dest,{recursive:true});fs.writeFileSync(path.join(dest,'installed.json'),JSON.stringify({version}));
}
const backend=spawn(path.resolve('server-rs/target/debug/shellpilot-server.exe'),[],{env:{...process.env,SHELLPILOT_DATA:data,SHELLPILOT_PORT:'0',SHELLPILOT_OPEN:'0'},stdio:['ignore','pipe','inherit']});
let base;
try{
 base=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Backend timeout')),20000);backend.stdout.on('data',chunk=>{const match=chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(t);resolve(match[0]);}});});
 const api=async(route,method='GET',body)=>{const response=await fetch(base+'/api'+route,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(180000)});const value=await response.json();assert(response.ok,JSON.stringify(value));return value;};
 await api('/workspace','PUT',{directory:root,enabled:true,network:false,engine:'linux'});
 assert.equal((await api('/workspace/linux')).running,false,'Opening app must not boot Linux by default');
 fs.writeFileSync(path.join(root,'input.txt'),'original input');
 const task=await api('/workspace/action','POST',{name:'workspace_exec',arguments:{command:'cat input.txt; printf generated > answer.txt; printf persistent >/root/environment-marker; cat /etc/alpine-release',timeout:60000}});
 assert.equal(task.exitCode,0,JSON.stringify(task));assert(task.stdout.includes('original input'));assert(task.stdout.includes('3.24.4'));assert.equal(fs.readFileSync(path.join(root,'answer.txt'),'utf8'),'generated');
 assert.equal((await api('/workspace/linux')).running,true);
 const disk=path.join(root,'.shellpilot','linux-disk.qcow2');assert(fs.existsSync(disk));
 await api('/workspace/linux/stop','POST',{});assert.equal((await api('/workspace/linux')).running,false);
 const restart=await api('/workspace/action','POST',{name:'workspace_exec',arguments:{command:'test -f answer.txt; cat /root/environment-marker; rm input.txt; printf restored',timeout:60000}});assert.equal(restart.exitCode,0);assert(restart.stdout.includes('persistent'));assert(!fs.existsSync(path.join(root,'input.txt')));
 const socket=new WebSocket(base.replace('http:','ws:')+'/api/workspace/terminal/ws');
 let terminalText='';const terminalReady=new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Terminal timeout')),100000);socket.addEventListener('message',async event=>{terminalText+=typeof event.data==='string'?event.data:await event.data.text();if(terminalText.includes('manual-terminal-ok')){clearTimeout(t);resolve();}});socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'input',data:"printf 'manual-terminal-ok\\n'\r"})));});
 await terminalReady;socket.close();await new Promise(resolve=>setTimeout(resolve,1200));
 await api('/workspace/linux/uninstall','POST',{});assert.equal(fs.readFileSync(path.join(root,'answer.txt'),'utf8'),'generated');assert(fs.existsSync(disk));assert.equal((await api('/workspace/linux')).installed,false);
 console.log('PASS: real Windows packaged QEMU boots on demand, pins identity, syncs files, streams terminal, stops/restarts and uninstalls while preserving files and disk');
}catch(error){for(const name of ['linux-boot.log','linux-runtime.log']){const file=path.join(root,'.shellpilot',name);if(fs.existsSync(file))console.error(fs.readFileSync(file,'utf8').slice(-12000));}throw error;}finally{backend.kill();}
