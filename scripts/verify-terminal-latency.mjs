// Echo must remain responsive while unrelated SSH authentication/OS probes wait.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';import ssh2 from 'ssh2';
assert(process.env.GITHUB_ACTIONS==='true','Latency fixtures run only in GitHub');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sp-echo-')),key=path.join(root,'key');execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',key]);
const clients=new Set(),timers=new Set(),shells=new Map();let server,socket;
const delay=(work,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);work();},ms);timers.add(timer);};
const ssh=new ssh2.Server({hostKeys:[fs.readFileSync(key)]},client=>{
 clients.add(client);client.on('close',()=>clients.delete(client));client.on('error',error=>{if(error.code!=='ECONNRESET')throw error;});let user='';
 client.on('authentication',context=>{user=context.username;if(user.startsWith('slow'))delay(()=>{try{context.accept();}catch{}},1500);else context.accept();});
 client.on('ready',()=>client.on('session',accept=>accept().on('pty',accept=>accept?.()).on('window-change',accept=>accept?.())
  .on('exec',(accept,reject,info)=>{const stream=accept();const send=()=>{stream.write(info.command.includes('$SHELL')?'/bin/sh':'fixture Linux');stream.exit(0);stream.end();};if(user==='metadata'&&!info.command.includes('$SHELL'))delay(send,1500);else send();})
  .on('shell',accept=>{const stream=accept();shells.set(user,(shells.get(user)||0)+1);stream.write('fixture> ');stream.on('data',data=>stream.write(data));})
 ));
});
try{
 ssh.listen(0,'127.0.0.1');await once(ssh,'listening');const ids=['ready','slow','parallel','metadata','slow-cancel'];
 fs.writeFileSync(path.join(root,'hosts.json'),JSON.stringify(ids.map(id=>({id,name:'Fixture '+id,host:'127.0.0.1',port:ssh.address().port,username:id}))));
 server=spawn(path.resolve('server-rs/target/debug/shellpilot-server'+(process.platform==='win32'?'.exe':'')),[],{env:{...process.env,SHELLPILOT_DATA:root,SHELLPILOT_PORT:'0',SHELLPILOT_OPEN:'0'},stdio:['ignore','pipe','inherit']});
 const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),15000);server.stdout.on('data',data=>{const match=data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
 const events=[],outputs=new Map();socket=new WebSocket(base.replace('http:','ws:')+'/ws');socket.onmessage=event=>{const message=JSON.parse(event.data);events.push({...message,received:performance.now()});if(['term-data','term-replay'].includes(message.type))outputs.set(message.sessionId,(outputs.get(message.sessionId)||'')+message.data);};await once(socket,'open');
 const send=message=>socket.send(JSON.stringify(message));const attach=(id,sessionId=id)=>send({type:'attach',hostId:id,sessionId});
 const until=async(check,ms=6000)=>{const end=Date.now()+ms;while(!check()){assert(Date.now()<end,'Terminal latency timeout: '+JSON.stringify(events.filter(event=>event.type==='error')));await new Promise(resolve=>setTimeout(resolve,10));}};
 const connected=id=>events.some(event=>event.type==='status'&&event.sessionId===id&&event.state==='connected');
 attach('ready');await until(()=>connected('ready'));
 const start=performance.now();attach('slow');attach('parallel');attach('metadata');
 send({type:'term-input',sessionId:'ready',data:'FIRST_ECHO'});await until(()=>outputs.get('ready')?.includes('FIRST_ECHO'));
 const echoMs=performance.now()-start;assert(echoMs<350,'Unrelated connection blocked ready terminal input: '+echoMs);
 await until(()=>connected('parallel')&&connected('metadata'));
 for(const id of ['parallel','metadata']){const status=events.find(event=>event.type==='status'&&event.sessionId===id&&event.state==='connected');assert(status.received-start<1000,id+' waited for unrelated handshake/metadata');}
 const samples=[];
 for(let index=0;index<12;index++){const marker='ECHO_'+index+';';const started=performance.now();send({type:'term-input',sessionId:'ready',data:marker});send({type:'term-resize',sessionId:'ready',cols:90+index,rows:24});await until(()=>outputs.get('ready')?.includes(marker));samples.push(performance.now()-started);}
 assert(Math.max(...samples)<350,'Typing stalled during handshake: '+samples);
 await until(()=>connected('slow'));
 for(let index=0;index<10;index++)attach('ready');await new Promise(resolve=>setTimeout(resolve,100));assert.equal(shells.get('ready'),1,'Duplicate attach created another shell');
 attach('slow-cancel','cancelled');await new Promise(resolve=>setTimeout(resolve,40));send({type:'detach',sessionId:'cancelled'});await new Promise(resolve=>setTimeout(resolve,1700));assert(!connected('cancelled'),'Closed tab reappeared after its handshake');
 send({type:'term-input',sessionId:'ready',data:'FINAL_ECHO'});await until(()=>outputs.get('ready')?.includes('FINAL_ECHO'));
 console.log('PASS: active PTY input is independent of slow connects and metadata; first echo='+Math.round(echoMs)+'ms, maximum='+Math.round(Math.max(...samples))+'ms; different sessions connect concurrently, duplicate/cancelled attaches remain correct');
}finally{socket?.close();for(const timer of timers)clearTimeout(timer);for(const client of clients)client.end();ssh.close();if(server?.exitCode===null){const exited=once(server,'exit');server.kill();await exited;}fs.rmSync(root,{recursive:true,force:true});}
