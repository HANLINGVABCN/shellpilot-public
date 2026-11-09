import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';import {once} from 'node:events';
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
assert(process.env.GITHUB_ACTIONS==='true','Run backup checks only on isolated GitHub fixtures');
const keys=['hosts','providers','chats','memories'];
const select=key=>Object.fromEntries(keys.map(name=>[name,name===key]));
function derive(password,salt){let value=createHash('sha256').update(password).update(salt).digest();for(let index=0;index<2500;index++){const counter=Buffer.alloc(4);counter.writeUInt32LE(index);value=createHash('sha256').update(value).update(counter).update(salt).digest();}return value;}
function encode(value,password){const salt=randomBytes(16),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',derive(password,salt),nonce);const payload=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]);return Buffer.concat([Buffer.from('SPEXPT01'),salt,nonce,payload]);}
function decode(bytes,password){assert.equal(bytes.subarray(0,8).toString(),'SPEXPT01');const decipher=createDecipheriv('aes-256-gcm',derive(password,bytes.subarray(8,24)),bytes.subarray(24,36));decipher.setAuthTag(bytes.subarray(-16));return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(36,-16)),decipher.final()]).toString());}
function fixture(prefix){return{version:1,hosts:[{id:prefix+'_h',name:'Fixture host',host:prefix==='old'?'192.0.2.1':'192.0.2.2',port:22,username:'demo',password:prefix+'-host-secret'}],settings:{providers:[{id:prefix+'_p',name:'Fixture provider',baseURL:'https://'+prefix+'.example/v1',apiKey:prefix+'-provider-secret'}],models:[{id:prefix+'_m',providerId:prefix+'_p',name:'fixture-model'}],defaultModelId:prefix+'_m',mcpEnabled:false,autoMemory:false},chats:{__global__:[{id:prefix+'_c',title:prefix+' chat',messages:[{role:'user',content:prefix+' message'}]}]},memories:[{id:prefix+'_mem',content:prefix+' memory',enabled:false}]};}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sp-backup-'));
try{for(const mode of ['merge','overwrite'])for(const key of keys){
 const directory=path.join(root,mode+'-'+key);fs.mkdirSync(directory);const current=fixture('old');
 for(const [name,value]of [['hosts',current.hosts],['settings',current.settings],['chats',current.chats],['memories',current.memories]])fs.writeFileSync(path.join(directory,name+'.json'),JSON.stringify(value));
 const server=spawn(path.resolve('server-rs/target/debug/shellpilot-server'),[],{env:{...process.env,SHELLPILOT_DATA:directory,SHELLPILOT_PORT:'0',SHELLPILOT_OPEN:'0'},stdio:['ignore','pipe','inherit']});
 try{
  const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),15000);server.stdout.on('data',data=>{const match=data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
  const call=async(route,body,ok=true)=>{const response=await fetch(base+'/api'+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const value=await response.json();assert.equal(response.ok,ok,JSON.stringify(value));return value;};
  const preview=await call('/export/preview');assert.deepEqual(preview.counts,{hosts:1,providers:1,chats:1,memories:1});
  const exported=await fetch(base+'/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'fixture-password',sections:select(key)})});assert(exported.ok);const bytes=Buffer.from(await exported.arrayBuffer());const plain=decode(bytes,'fixture-password');
  const contentKey={hosts:'hosts',providers:'settings',chats:'chats',memories:'memories'};
  for(const candidate of keys)assert.equal(Object.hasOwn(plain,contentKey[candidate]),candidate===key);
  if(key!=='hosts')assert(!JSON.stringify(plain).includes('old-host-secret'));if(key!=='providers')assert(!JSON.stringify(plain).includes('old-provider-secret'));
  const detected=await call('/import/preview',{password:'fixture-password',data:bytes.toString('base64')});assert.equal(detected.counts[key],1);for(const candidate of keys)if(candidate!==key)assert.equal(detected.counts[candidate],0);
  await call('/export',{password:'fixture-password',sections:{}},false);
  const unavailable=key==='memories'?'hosts':'memories';await call('/import',{password:'fixture-password',data:bytes.toString('base64'),sections:select(unavailable),mode},false);
  const baseline=Object.fromEntries(['hosts','settings','chats','memories'].map(name=>[name,fs.readFileSync(path.join(directory,name+'.json'),'utf8')]));
  const incoming=fixture('new'),data=encode(incoming,'fixture-password').toString('base64');
  await call('/import',{password:'fixture-password',data,sections:select(key),mode});
  for(const candidate of keys)if(candidate!==key){const name=contentKey[candidate];assert.equal(fs.readFileSync(path.join(directory,name+'.json'),'utf8'),baseline[name],`Import ${key}/${mode} changed unselected ${candidate}`);}
  const changed=JSON.parse(fs.readFileSync(path.join(directory,contentKey[key]+'.json'),'utf8'));
  const serialized=JSON.stringify(changed);assert(serialized.includes(key==='hosts'?'new-host-secret':key==='providers'?'new-provider-secret':key==='chats'?'new message':'new memory'));
  const settings=JSON.parse(fs.readFileSync(path.join(directory,'settings.json'),'utf8'));assert.equal(settings.mcpEnabled,false);assert.equal(settings.autoMemory,false);
  if(key==='memories'){assert(changed.every(memory=>memory.enabled===false));}
  if(key==='chats'){await call('/import',{password:'fixture-password',data,sections:select(key),mode:'merge'});assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'chats.json'),'utf8')).__global__.length,changed.__global__.length);}
  await call('/import',{password:'wrong-password',data,sections:select(key)},false);
 }finally{if(server.exitCode===null){server.kill();await once(server,'exit');}}
}console.log('PASS: all four independent encrypted exports; detection, missing-category rejection, merge/overwrite only chosen files, memory enabled flags and repeatable chats');}finally{fs.rmSync(root,{recursive:true,force:true});}
