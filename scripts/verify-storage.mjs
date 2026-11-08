import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
assert(process.env.CI,'Storage integration checks run only in an isolated build environment');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shellpilot-storage-'));
const hosts=[{id:'a',name:'演示主机 A',host:'127.0.0.1',port:1,username:'demo'}];
fs.writeFileSync(path.join(dir,'hosts.json'),JSON.stringify(hosts));
const settings=JSON.stringify({providers:[{id:'p',name:'演示模型',baseURL:'https://model.example.com/v1',apiKey:'fixture-only'}],models:[],aiBudgetVersion:3});
fs.writeFileSync(path.join(dir,'settings.json'),'{invalid');
const executable=path.resolve('server-rs/target/debug/shellpilot-server'+(process.platform==='win32'?'.exe':''));
const app=spawn(executable,[],{env:{...process.env,SHELLPILOT_DATA:dir,SHELLPILOT_PORT:'0',SHELLPILOT_OPEN:'0'},stdio:['ignore','pipe','pipe']});
app.stderr.on('data',()=>{});
const base=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Error('Storage test startup timeout')),15000);
 app.stdout.on('data',bytes=>{const match=bytes.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
});
async function api(route,method='GET',body){
 const response=await fetch(base+'/api/'+route,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 return {status:response.status,value:await response.json()};
}
try{
 const failed=await api('hosts');assert.equal(failed.status,503);assert(failed.value.storageError);
 assert.equal(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),'{invalid','Failed startup must preserve the original file');
 assert.equal((await api('hosts','POST',{name:'overwrite',host:'127.0.0.1'})).status,503);
 assert.equal((await api('settings','PUT',{providers:[]})).status,503);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'hosts.json'),'utf8')),hosts);
 fs.writeFileSync(path.join(dir,'settings.json'),settings);
 assert.equal((await api('storage/retry','POST',{})).status,200);
 assert.equal((await api('hosts')).value.length,1);
 assert.equal((await api('settings')).value.providers.length,1);
 assert.equal(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),settings);
 const corrupt='{}';fs.writeFileSync(path.join(dir,'hosts.json'),corrupt);
 // read through the file-backed MCP context; no connection or remote operation.
 const runtime=JSON.parse(fs.readFileSync(path.join(dir,'runtime.json'),'utf8'));
 const response=await fetch(base+'/api/mcp/call',{method:'POST',headers:{Authorization:'Bearer '+runtime.token,'Content-Type':'application/json'},body:JSON.stringify({name:'vps_list',arguments:{}})});
 // MCP may be disabled; force a file-backed data export to detect invalid shape.
 await api('export','POST',{password:'fixture'});
 assert.equal((await api('hosts')).status,503);
 assert.equal(fs.readFileSync(path.join(dir,'hosts.json'),'utf8'),corrupt);
 fs.writeFileSync(path.join(dir,'hosts.json'),'\ufeff'+JSON.stringify(hosts));
 assert.equal((await api('storage/retry','POST',{})).status,200);
 assert.equal((await api('hosts')).value.length,1);
 console.log('PASS: storage read/format failures block empty-data success and default writes; retry and UTF8 BOM preserve records');
}finally{app.kill();await once(app,'exit');}
