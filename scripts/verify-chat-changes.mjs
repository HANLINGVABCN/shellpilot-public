import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import fs from 'node:fs';
fs.mkdirSync('layout-screenshots',{recursive:true});
const browser=await chromium.launch({executablePath:process.env.SHELLPILOT_CHROMIUM});
try{
 for(const width of [390,1040]){
  const page=await browser.newPage({locale:'zh-CN',timezoneId:'Asia/Shanghai',viewport:{width,height:850}});
  let socket;let jobs={busy:true,activeId:'active',paused:false,queue:[],revision:1,chatId:'chat'};
  page.on('dialog',()=>{throw Error('Unexpected dialog')});
  await page.routeWebSocket('**/ws',ws=>{socket=ws;ws.onMessage(text=>{
   const m=JSON.parse(text);
   if(m.type==='chat'){jobs={...jobs,queue:[...jobs.queue,{id:'queued',text:m.text}],revision:jobs.revision+1};}
   if(m.type==='chat-queue-take'){const job=jobs.queue.find(j=>j.id===m.jobId);jobs={...jobs,queue:jobs.queue.filter(j=>j.id!==m.jobId),revision:jobs.revision+1};ws.send(JSON.stringify({type:'chat-queue-taken',jobId:m.jobId,text:job.text}));}
   if(m.type==='chat-pause')jobs={...jobs,paused:true,pauseReady:true,revision:jobs.revision+1};
   if(m.type==='chat-resume')jobs={...jobs,paused:false,pauseReady:false,revision:jobs.revision+1};
   ws.send(JSON.stringify({type:'chat-job-state',...jobs}));
  });});
  await page.addInitScript(()=>{localStorage.setItem('shellpilot-chat-id','chat');});
  await page.route('**/api/**',async route=>{
   const path=new URL(route.request().url()).pathname;let value=[];
   if(path==='/api/hosts')value=[{id:'a',name:'演示主机',host:'alpha.example.com',username:'demo'}];
   if(path==='/api/settings')value={providers:[{id:'p',name:'DemoProvider'}],models:[{id:'m',providerId:'p',name:'DemoModel'}],defaultModelId:'m',params:{}};
   if(path==='/api/agent/status')value={...jobs,messages:[],scope:['a'],approvals:[]};
   if(path==='/api/chats/__global__')value=[{id:'chat',title:'演示对话'}];
   if(path==='/api/chats/__global__/chat')value={messages:[]};
   await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  });
  await page.goto('http://127.0.0.1:4173');if(width<760)await page.locator('.mobile-nav').getByRole('button',{name:'AI',exact:true}).click();
  assert.equal(await page.locator('.mode-wrap > button').innerText(),'完全托管');
  await page.getByRole('button',{name:'暂停',exact:true}).waitFor();
  socket.send(JSON.stringify({type:'chat-start',chatId:'chat',text:'当前任务'}));
  socket.send(JSON.stringify({type:'chat-delta',delta:'正在输出'}));
  await page.getByRole('textbox',{name:'AI 任务输入框',exact:true}).fill('稍后处理的消息');
  await page.getByRole('button',{name:'加入队列',exact:true}).click();
  await page.getByRole('button',{name:'取回排队消息 1',exact:true}).waitFor();
  assert(await page.getByRole('button',{name:'暂停',exact:true}).isVisible());
  assert(await page.getByRole('button',{name:'停止当前任务',exact:true}).isVisible());
  socket.send(JSON.stringify({type:'chat-job-state',revision:1,busy:false,queue:[],paused:false}));
  await page.getByRole('button',{name:'取回排队消息 1',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.chat-input textarea').value==='稍后处理的消息');
  assert.equal(jobs.queue.length,0);assert(await page.getByRole('button',{name:'暂停',exact:true}).isVisible());
  await page.getByRole('button',{name:'暂停',exact:true}).click();await page.getByRole('button',{name:'继续',exact:true}).waitFor();
  await page.getByRole('button',{name:'继续',exact:true}).click();
  socket.send(JSON.stringify({type:'chat-done',stats:{startedAt:Date.UTC(2026,10,8,19,20),inputTokens:1200,cachedTokens:800,outputTokens:300,durationMs:12000,tokensPerSecond:25,provider:'DemoProvider',model:'DemoModel'}}));
  socket.send(JSON.stringify({type:'chat-job-state',revision:100,busy:false,paused:false,queue:[],activeId:null}));
  const stats=page.getByLabel('回答统计');await stats.waitFor();
  assert.equal(await stats.innerText(),'2026-11-09 03:20 ↑1,200（800） ↓300 12s 25tok/s DemoProvider/DemoModel');
  assert(!await stats.innerText().then(s=>s.includes(' · ')||s.includes('25 tok/s')||s.includes('1.2k')));
  await page.screenshot({path:'layout-screenshots/'+width+'-queue-stats.png'});
  await page.close();
 }
 console.log('PASS: queue preserves active pause/stop, stale states ignored, message take edits in main input, compact full dated statistics');
}finally{await browser.close();}
