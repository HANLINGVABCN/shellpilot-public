import assert from 'node:assert/strict';
const base=process.env.WORKSPACE_TEST_URL||'http://127.0.0.1:3738';
const action=async(name,args)=>{const response=await fetch(base+'/api/workspace/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});const value=await response.json();assert(response.ok,JSON.stringify(value));return value;};
await action('workspace_mkdir',{path:'terminal-one'});await action('workspace_mkdir',{path:'terminal-two'});
function terminal(path,marker,file){
 const socket=new WebSocket(base.replace('http:','ws:')+'/api/workspace/terminal/ws?path='+path);let text='';const waits=[];
 socket.addEventListener('message',async event=>{text+=typeof event.data==='string'?event.data:await event.data.text();for(const wait of waits)if(text.includes(wait.marker))wait.resolve();});
 const wait=marker=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Terminal '+path+' timed out: '+text)),100000);waits.push({marker,resolve:()=>{clearTimeout(timer);resolve();}});if(text.includes(marker)){clearTimeout(timer);resolve();}});
 socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'input',data:`pwd; printf ${file} > ${file}.txt; printf '__%s__\\n' '${marker}'\r`})));
 return {socket,wait,text:()=>text};
}
const a=terminal('terminal-one','A_READY','one'),b=terminal('terminal-two','B_READY','two');
try{
 await Promise.all([a.wait('__A_READY__'),b.wait('__B_READY__')]);
 assert(a.text().includes('/workspace/terminal-one'));assert(b.text().includes('/workspace/terminal-two'));assert(!a.text().includes('__B_READY__'));assert(!b.text().includes('__A_READY__'));
 a.socket.close();await new Promise(resolve=>setTimeout(resolve,600));
 b.socket.send(JSON.stringify({type:'input',data:"printf '__%s__\\n' 'B_ALIVE'\r"}));await b.wait('__B_ALIVE__');
 b.socket.close();let saved=false;
 for(let attempt=0;attempt<40;attempt++){await new Promise(resolve=>setTimeout(resolve,300));try{assert.equal((await action('workspace_read',{path:'terminal-one/one.txt'})).content,'one');assert.equal((await action('workspace_read',{path:'terminal-two/two.txt'})).content,'two');saved=true;break;}catch{}}
 assert(saved,'Both terminal outputs must be saved after final close');console.log('PASS: two independent terminal PTYs use their directories, closing one preserves the other, both outputs remain');
}finally{a.socket.close();b.socket.close();}
