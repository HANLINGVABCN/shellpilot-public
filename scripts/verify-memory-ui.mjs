import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch();
let activePage;
try{
  for(const width of [390,1040]){
    const page=await browser.newPage({viewport:{width,height:850},locale:'zh-CN'});
    activePage=page;
    let settings={providers:[{id:'p',name:'Mock'}],models:[{id:'m',providerId:'p',name:'mock'}],defaultModelId:'m',params:{temperature:0.3,maxTokens:0,historyLimit:0,maxSteps:0,contextChars:0},systemPrompt:'测试',autoMemory:true,mcpEnabled:false};
    let memories=[{id:'one',topic:'回答方式',content:'解释时使用简单的话',enabled:true,source:'manual',updatedAt:1762401600000},{id:'two',topic:'部署目录',content:'默认目录 /srv/demo',enabled:false,source:'ai',updatedAt:1762401600000}];
    let jobs={busy:true,paused:false,pauseReady:false,queue:[],activeId:'active',chatId:'chat'};
    let socket;const dialogs=[],errors=[];
    page.on('dialog',(dialog)=>{dialogs.push(dialog.type());dialog.dismiss();});page.on('pageerror',(error)=>errors.push(error.message));
    await page.routeWebSocket('**/ws',(ws)=>{socket=ws;ws.onMessage((text)=>{
      const message=JSON.parse(text);
      if(message.type==='chat-pause'){jobs={...jobs,paused:true,pauseReady:true};}
      if(message.type==='chat-resume'){jobs={...jobs,paused:false,pauseReady:false};}
      if(message.type==='chat'){jobs.queue.push({id:'queued',text:message.text});}
      if(message.type==='chat-queue-edit'){jobs.queue=jobs.queue.map((job)=>job.id===message.jobId?{...job,text:message.text}:job);}
      if(message.type==='chat-queue-remove'){jobs.queue=jobs.queue.filter((job)=>job.id!==message.jobId);}
      if(message.type==='chat-queue-clear')jobs.queue=[];
      if(message.type==='chat-queue-take'){const job=jobs.queue.find(job=>job.id===message.jobId);jobs.queue=jobs.queue.filter(job=>job.id!==message.jobId);ws.send(JSON.stringify({type:'chat-queue-taken',jobId:job.id,text:job.text}));}
      ws.send(JSON.stringify({type:'chat-job-state',...jobs}));
    });});
    const stored=[{role:'user',content:'检查目录'},{role:'assistant',tool_calls:[{id:'call',function:{name:'vps_exec',arguments:JSON.stringify({host:'demo',command:'ls -la /srv/demo\nprintf done'})}}]},
      {role:'tool',tool_call_id:'call',content:JSON.stringify({stdout:'first output line\nsecond output line',stderr:'',exitCode:0,host:'演示主机'})},{role:'assistant',content:'完成'}];
    await page.addInitScript(()=>{localStorage.setItem('shellpilot-last-view','settings');localStorage.setItem('shellpilot-chat-id','chat');});
    await page.route('**/api/**',async(route)=>{
      const url=new URL(route.request().url()).pathname,method=route.request().method();let value=[];
      if(url==='/api/settings'){if(method==='PUT')settings=route.request().postDataJSON();value=settings;}
      if(url==='/api/memories'){
        if(method==='POST'){const body=route.request().postDataJSON();memories.push({...body,id:'three',source:'manual',updatedAt:1762401600001});value={status:'saved',memory:memories.at(-1)};}
        else value={memories,autoMemory:settings.autoMemory};
      }
      if(url.startsWith('/api/memories/')&&url!=='/api/memories/batch'){
        const id=url.split('/').at(-1),body=route.request().postDataJSON();memories=memories.map((memory)=>memory.id===id?{...memory,...body,updatedAt:memory.updatedAt+1}:memory);value={status:'saved'};
      }
      if(url==='/api/memories/batch'){const body=route.request().postDataJSON();if(body.action==='delete')memories=memories.filter((memory)=>!body.ids.includes(memory.id));else memories=memories.map((memory)=>body.ids.includes(memory.id)?{...memory,enabled:body.enabled}:memory);value={changed:body.ids.length};}
      if(url==='/api/agent/status')value={...jobs,messages:stored,scope:[],approvals:[]};
      if(url==='/api/chats/__global__')value=[{id:'chat',title:'演示对话'}];
      if(url==='/api/chats/__global__/chat')value={id:'chat',title:'演示对话',messages:stored};
      if(url==='/api/mcp/config')value={command:'demo.exe',args:['--mcp']};
      await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    });
    await page.goto('http://127.0.0.1:4173');
    await Promise.all([page.waitForResponse((response)=>response.url().endsWith('/api/settings')&&response.request().method()==='PUT'),page.getByRole('checkbox',{name:'允许 AI 主动记住新内容',exact:true}).uncheck()]);
    assert.equal(settings.autoMemory,false);assert(memories[0].enabled,'Auto off cannot disable existing memory');
    await Promise.all([page.waitForResponse((response)=>response.url().endsWith('/api/memories/one')&&response.request().method()==='PUT'),page.getByRole('button',{name:'参与回答 1',exact:true}).click()]);
    await page.locator('.memory-row').filter({hasText:'解释时使用简单的话'}).waitFor({state:'detached'});
    await page.getByRole('combobox',{name:'记忆筛选',exact:true}).selectOption('disabled');
    await page.getByText('解释时使用简单的话',{exact:true}).waitFor();
    await page.getByRole('button',{name:'添加记忆',exact:true}).click();
    await page.getByRole('textbox',{name:'记忆内容',exact:true}).fill('优先中文');
    await page.getByRole('button',{name:'保存记忆',exact:true}).click();
    await page.getByRole('combobox',{name:'记忆筛选',exact:true}).selectOption('all');
    await page.getByText('优先中文',{exact:true}).waitFor();
    const row=page.locator('.memory-row').filter({hasText:'优先中文'});
    await row.locator('.memory-edit').click();await page.getByRole('textbox',{name:'记忆内容',exact:true}).fill('使用中文并保持简短');await page.getByRole('button',{name:'保存记忆',exact:true}).click();
    await page.getByText('使用中文并保持简短',{exact:true}).waitFor();
    await page.locator('.memory-row').filter({hasText:'使用中文并保持简短'}).getByRole('checkbox').check();await page.locator('.memory-row').filter({hasText:'解释时使用简单的话'}).getByRole('checkbox').check();
    await page.getByRole('button',{name:'停用所选',exact:true}).click();
    await page.getByRole('button',{name:'停用所选',exact:true}).waitFor({state:'detached'});
    await page.locator('.memory-row').filter({hasText:'使用中文并保持简短'}).getByRole('checkbox').check();await page.getByRole('button',{name:'删除所选记忆',exact:true}).click();await page.getByRole('button',{name:'确认删除记忆',exact:true}).click();
    await page.getByText('使用中文并保持简短',{exact:true}).waitFor({state:'detached'});assert.equal(memories.length,2);
    await page.locator('.memory-settings').screenshot({path:`layout-screenshots/${width}-memory-management.png`});
    if(width<760)await page.locator('.mobile-nav').getByRole('button',{name:'AI',exact:true}).click();
    const card=page.locator('.command-card');await card.waitFor();
    assert.equal(await card.getAttribute('aria-expanded'),'false');assert.equal(await card.locator('.command-card-preview > div').count(),2);
    await card.locator('.command-card-preview').click();assert.equal(await card.getAttribute('aria-expanded'),'true');
    await card.getByRole('button',{name:'复制输出',exact:true}).click();assert.equal(await card.getAttribute('aria-expanded'),'true','Copying output must not collapse');
    await card.locator('pre').last().click();assert.equal(await card.getAttribute('aria-expanded'),'false');
    await card.press('Enter');assert.equal(await card.getAttribute('aria-expanded'),'true');await card.press('Enter');
    await page.getByRole('button',{name:'暂停',exact:true}).click();await page.getByText('已暂停',{exact:false}).waitFor();
    await page.locator('.chat-input textarea').fill('第二个任务');await page.getByRole('button',{name:'加入队列',exact:true}).click();
    await page.locator('.queue-item').filter({hasText:'第二个任务'}).waitFor();
    await page.getByRole('button',{name:'取回排队消息 1',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.chat-input textarea').value==='第二个任务');
    await page.locator('.chat-input textarea').fill('修改后的任务');await page.getByRole('button',{name:'加入队列',exact:true}).click();
    await page.locator('.queue-item').filter({hasText:'修改后的任务'}).waitFor();
    await page.screenshot({path:`layout-screenshots/${width}-paused-queue-command.png`});
    await page.getByRole('button',{name:'取消排队',exact:true}).click();await page.locator('.queue-panel').waitFor({state:'detached'});
    await page.getByRole('button',{name:'继续',exact:true}).click();assert.equal(jobs.paused,false);
    socket.send(JSON.stringify({type:'error',requestType:'chat-queue-edit',message:'排队消息已开始执行，不能再编辑'}));
    await page.getByRole('alert').filter({hasText:'排队消息已开始执行'}).waitFor();
    await page.getByRole('button',{name:'知道了',exact:true}).click();
    assert.deepEqual(dialogs,[]);assert.deepEqual(errors,[]);await page.close();
  }
  console.log('PASS: memory auto toggle/per-item controls/CRUD/batch, two-line card and body toggle, copy exceptions, pause/queue editing');
}catch(error){if(activePage&&!activePage.isClosed()){await activePage.screenshot({path:'layout-screenshots/memory-ui-failure.png'});console.error(await activePage.locator('body').innerText());}throw error;}
finally{await browser.close();}
