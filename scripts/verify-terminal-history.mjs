import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';import ssh2 from 'ssh2';
assert(process.env.GITHUB_ACTIONS==='true','Terminal history tests use isolated GitHub fixtures only');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sp-terminal-history-')),key=path.join(root,'key');execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',key]);
const children=new Set(),clients=new Set();let backend,socket;
const testTimer=setTimeout(()=>{console.error('Terminal history fixture exceeded its time budget');process.exit(1);},90000);
const stop=child=>{if(child.ptyGroup){try{process.kill(-child.pid,'SIGKILL');}catch{}}else child.kill('SIGKILL');child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();};
const ssh=new ssh2.Server({hostKeys:[fs.readFileSync(key)]},client=>{clients.add(client);client.on('error',error=>{if(error.code!=='ECONNRESET')throw error;});client.on('close',()=>clients.delete(client));let shell;
 client.on('authentication',context=>{shell=context.username==='zsh'?'/bin/zsh':'/bin/bash';context.accept();});
 client.on('ready',()=>client.on('session',accept=>accept().on('pty',accept=>accept?.()).on('window-change',accept=>accept?.()).on('exec',(accept,reject,info)=>{
  const stream=accept(),child=spawn('bash',['-c',info.command],{env:{...process.env,SHELL:shell},cwd:root});children.add(child);child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream.stderr,{end:false});child.on('close',code=>{children.delete(child);stream.exit(code??1);stream.end();});
 }).on('shell',accept=>{
  const stream=accept(),rc=path.join(root,shell.endsWith('zsh')?'zshrc':'bashrc');
  const cmd=shell.endsWith('zsh')?`env ZDOTDIR=${root} zsh -i`:`bash --noprofile --rcfile ${rc} -i`;
  const child=spawn('script',['-qefc',cmd,'/dev/null'],{detached:true,cwd:root,env:{...process.env,SHELL:shell}});child.ptyGroup=true;children.add(child);child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream.stderr,{end:false});stream.on('data',data=>child.stdin.write(data));stream.on('close',()=>stop(child));child.on('close',()=>{children.delete(child);stream.end();});
 })));
});
try{
 fs.writeFileSync(path.join(root,'bash-history'),'echo OLD_BASH\n');fs.writeFileSync(path.join(root,'bashrc'),`HISTFILE=${root}/bash-history\nHISTSIZE=1000\nPS1='demo$ '\n`);
 fs.writeFileSync(path.join(root,'.zshrc'),`HISTFILE=${root}/zsh-history\nHISTSIZE=1000\nSAVEHIST=1000\nPS1='demo%# '\n`);fs.writeFileSync(path.join(root,'zsh-history'),'echo OLD_ZSH\n');
 ssh.listen(0,'127.0.0.1');await once(ssh,'listening');fs.writeFileSync(path.join(root,'hosts.json'),JSON.stringify(['bash','zsh'].map(name=>({id:name,name,host:'127.0.0.1',port:ssh.address().port,username:name}))));
 backend=spawn(path.resolve('server-rs/target/debug/shellpilot-server'),[],{env:{...process.env,SHELLPILOT_DATA:root,SHELLPILOT_OPEN:'0',SHELLPILOT_PORT:'0'},stdio:['ignore','pipe','inherit']});
 const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),20000);backend.stdout.on('data',data=>{const match=data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
 const get=async host=>{const response=await fetch(base+'/api/terminal/history?host='+host,{signal:AbortSignal.timeout(3000)});assert(response.ok);return(await response.json()).commands;};
 for(const host of ['bash','zsh']){
  const events=[],data=[];socket=new WebSocket(base.replace('http:','ws:')+'/ws');socket.onmessage=event=>{const message=JSON.parse(event.data);events.push(message);if(message.type==='term-data'||message.type==='term-replay')data.push(message.data||'');};await once(socket,'open');
  console.log('Testing real '+host+' shell');socket.send(JSON.stringify({type:'attach',sessionId:host+'-terminal',hostId:host}));
  const until=async check=>{const deadline=Date.now()+20000;while(!await check()){assert(Date.now()<deadline,'Shell integration timeout: '+host+' '+data.join('').slice(-1000));await new Promise(resolve=>setTimeout(resolve,50));}};
  await until(()=>events.some(event=>event.type==='status'&&event.state==='connected'&&event.shellIntegration));await until(()=>data.join('').includes(';I\x07'));console.log(host+' prompt integration ready');await until(async()=> (await get(host)).includes('echo OLD_'+host.toUpperCase()));
  socket.send(JSON.stringify({type:'term-input',sessionId:host+'-terminal',data:'echo HISTORY_'+host.toUpperCase()+'\r'}));await until(async()=> (await get(host)).includes('echo HISTORY_'+host.toUpperCase()));
  socket.send(JSON.stringify({type:'term-input',sessionId:host+'-terminal',data:'echo 中文完成\r'}));await until(async()=> (await get(host)).includes('echo 中文完成'));assert(!data.join('').includes('�'),'UTF-8 stays intact');
  socket.send(JSON.stringify({type:'term-input',sessionId:host+'-terminal',data:'echo token=fixture-secret\r'}));await new Promise(resolve=>setTimeout(resolve,300));assert(!(await get(host)).some(command=>command.includes('fixture-secret')));
  socket.send(JSON.stringify({type:'term-input',sessionId:host+'-terminal',data:host==='bash'?'read -s -p "Password: " value; echo DONE\r':'read -s "value?Password: "; echo DONE\r'}));await until(()=>data.join('').includes('Password: '));socket.send(JSON.stringify({type:'term-input',sessionId:host+'-terminal',data:'RAW_PASSWORD_CANARY\r'}));await until(()=>data.join('').includes('DONE'));assert(!(await get(host)).some(command=>command.includes('RAW_PASSWORD_CANARY')));
  assert(!(await get(host)).some(command=>command.includes('__shellpilot_')),'Bootstrap is never saved');
  socket.send(JSON.stringify({type:'detach',sessionId:host+'-terminal'}));socket.close();await once(socket,'close');socket=null;
 }
 assert(!(await get('bash')).includes('echo OLD_ZSH'));assert(!(await get('zsh')).includes('echo OLD_BASH'));
 assert(fs.existsSync(path.join(root,'terminal-history.json')));console.log('PASS: real Bash/Zsh prompt hooks report old/executed commands; UTF-8, password and credential exclusion; separate persistent host histories');
}finally{clearTimeout(testTimer);socket?.close();backend?.kill();for(const child of children)stop(child);for(const client of clients)client.end();ssh.close();fs.rmSync(root,{recursive:true,force:true});}
