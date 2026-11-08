// GitHub-only browser checks and screenshots; no real hosts or model requests.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';

fs.mkdirSync('layout-screenshots', { recursive: true });
const browser = await chromium.launch();
const hosts = [{id:'a',name:'演示主机 A',host:'alpha.example.com',username:'demo',port:22},{id:'b',name:'演示主机 B',host:'2001:db8::2',username:'demo',port:22},
  ...['测试节点 C','测试节点 D','测试节点 E','测试节点 F','测试节点 G','测试节点 H','测试节点 I','长名称演示节点 J'].map((name,index)=>({id:`extra-${index}`,name,host:`demo-node-${index}.example.com`,username:'demo',port:22}))];
const settings = {providers:[],models:[],params:{temperature:0.3,maxTokens:2048,historyLimit:12,maxSteps:20,contextChars:60000},systemPrompt:'运维助手',mcpEnabled:true,mcpReadOnly:true};
try {
  for (const [width, height] of [[360,800],[390,844],[760,600],[1040,720]]) {
    const page = await browser.newPage({viewport:{width,height},deviceScaleFactor:1,locale:'zh-CN'});
    const errors = [];
    await page.addInitScript(() => {
      localStorage.setItem('shellpilot-agent-scope', JSON.stringify(['a','b','deleted','a']));
      localStorage.setItem('shellpilot-chat-id', 'fold-test');
    });
    page.on('pageerror', (error) => { errors.push(error.message); console.error(error.stack); });
    page.on('console', (message) => { if (message.type() === 'error') console.error(message.text()); });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url()).pathname;
      let data = [];
      if (url === '/api/hosts') data = hosts;
      if (url === '/api/probe') data = hosts.map((host) => ({hostId:host.id,name:host.name,state:'online',sample:{cpu:12.3,memPct:40,memUsed:409600,memTotal:1024000,diskPct:30,diskTotalKB:10485760,diskUsedKB:3145728,load1:0.2,txS:2048,rxS:1024,uptime:7200}}));
      if (url === '/api/settings') data = settings;
      if (url === '/api/agent/status') data = {busy:false,messages:[],approvals:[]};
      if (url === '/api/chats/__global__') data = [{id:'fold-test',title:'长消息示例'}];
      if (url === '/api/chats/__global__/fold-test') data = {id:'fold-test',title:'长消息示例',messages:[{role:'user',content:'请帮我检查服务器。'},{role:'user',content:Array.from({length:14},(_,index)=>`第${index+1}项：检查服务状态、日志、磁盘空间，并保留诊断结果。`).join('\n')}]};
      if (url === '/api/mcp/config') data = {command:'C:\\Program Files\\ShellPilot\\shellpilot-app.exe',args:['--mcp'],env:{SHELLPILOT_DATA:'C:\\Users\\test\\AppData\\Roaming\\ShellPilot'}};
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.goto('http://127.0.0.1:4173');
    try { await page.locator('#app').waitFor({timeout:10000}); }
    catch (error) { await page.screenshot({path:`layout-screenshots/${width}-failure.png`}); console.error('Page errors:', errors); throw error; }
    const mobile = width <= 760;
    for (const view of mobile ? ['总览','服务器','工作台','AI','设置'] : ['desktop']) {
      if (mobile) await page.locator('.mobile-nav').getByRole('button',{name:view,exact:true}).click();
      await page.screenshot({path:`layout-screenshots/${width}-${view}.png`});
      const bounds = await page.evaluate(() => ({scroll:document.documentElement.scrollWidth,width:window.innerWidth}));
      assert(bounds.scroll <= bounds.width + 1, `${width}/${view}: horizontal page overflow`);
      if (mobile && view === 'AI') {
        await page.getByRole('button', {name:`机器 2/${hosts.length}`,exact:true}).waitFor();
        const box = await page.locator('.chat-input textarea').boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height, 'Chat input must be reachable');
        const toggle = page.getByRole('button', {name:'展开全文',exact:true});
        await toggle.waitFor();
        assert.equal(await toggle.count(), 1, 'Only the long user message should fold');
        const collapsed = await page.locator('.user-text.collapsed').boundingBox();
        await toggle.click();
        assert.equal(await page.getByRole('button',{name:'收起',exact:true}).getAttribute('aria-expanded'),'true');
        const expanded = await page.locator('.user-text').last().boundingBox();
        assert(expanded.height > collapsed.height, 'Expanded message must reveal the full text');
        await page.getByRole('button',{name:'收起',exact:true}).click();
        await page.getByRole('button',{name:`机器 2/${hosts.length}`,exact:true}).click();
        const positions=await page.locator('.scope-item').evaluateAll((rows)=>rows.map((row)=>{
          const children=[...row.children].map((child)=>{const r=child.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,center:r.y+r.height/2};});
          return children;
        }));
        assert.equal(positions.length,hosts.length);
        for(const row of positions) {
          assert(Math.abs(row[0].w-16)<1,'Checkbox cannot stretch to full row width');
          assert(row.every((item)=>Math.abs(item.center-row[0].center)<2),'All four columns must be vertically aligned');
          assert(row.every((item,index)=>Math.abs(item.x-positions[0][index].x)<1),'Checkbox, dot, name and address columns must align across rows');
          assert(row[2].h<24,'Machine names must not wrap into uneven rows');
        }
        await page.screenshot({path:`layout-screenshots/${width}-machine-alignment.png`});
        await page.getByRole('button',{name:`机器 2/${hosts.length}`,exact:true}).click();
      }
      if (mobile && view === '设置') {
        await page.locator('.mcp-card').scrollIntoViewIfNeeded();
        const rows=await page.locator('.mcp-hosts label').evaluateAll((labels)=>labels.map((label)=>{const checkbox=label.querySelector('input').getBoundingClientRect();const text=label.querySelector('span').getBoundingClientRect();return{width:checkbox.width,cy:checkbox.y+checkbox.height/2,ty:text.y+text.height/2,margin:getComputedStyle(label).marginTop};}));
        assert(rows.every((row)=>Math.abs(row.width-16)<1 && Math.abs(row.cy-row.ty)<2 && row.margin==='0px'),'MCP checkboxes and labels must align without inherited label margins');
        await page.screenshot({path:`layout-screenshots/${width}-MCP.png`});
      }
      if(!mobile) {
        await page.getByRole('button',{name:`机器 2/${hosts.length}`,exact:true}).click();
        const menu=await page.locator('.scope-menu').boundingBox();
        const panel=await page.locator('.chat-panel').boundingBox();
        assert(menu.x>=panel.x && menu.x+menu.width<=width,'Desktop machine menu must fit inside chat panel and window');
        await page.screenshot({path:`layout-screenshots/${width}-desktop-machine-alignment.png`});
        await page.getByRole('button',{name:`机器 2/${hosts.length}`,exact:true}).click();
      }
    }
    assert.deepEqual(errors, [], 'Browser errors');
    await page.close();
  }
  console.log('PASS: mobile navigation, reachable input, valid machine counts, long-message folding, no overflow or browser exceptions');
  for(const width of [390,1040]) {
    const page=await browser.newPage({viewport:{width,height:800},locale:'zh-CN'});
    let trusted=false; let attachesAfterTrust=0;
    const keys=[...Array.from({length:98},(_,index)=>({key:`unrelated-${index}:22`,hostId:`unrelated-${index}`,host:`unrelated-${index}`,port:22,name:`其他服务器${index}`,fingerprint:`other-${index}`,changed:true,previous:'old'})),
      {key:'db.example:22',hostId:'b',host:'db.example',port:22,name:'第二台测试',fingerprint:'db-fingerprint',changed:true,previous:'old-db'},
      {key:'test.example:22',hostId:'a',host:'test.example',port:22,name:'演示主机 A',fingerprint:'test-fingerprint',changed:true,previous:'old-a'}];
    const dialogs=[];
    page.on('dialog',(dialog)=>{dialogs.push(dialog.type());dialog.dismiss();});
    await page.addInitScript(()=>{
      localStorage.setItem('shellpilot-last-view','work');
      localStorage.setItem('shellpilot-sess-term',JSON.stringify([{id:'identity-session',hostId:'a',title:'演示主机 A'},{id:'other-session',hostId:'b',title:'第二台测试'}]));
      localStorage.setItem('shellpilot-active-term','identity-session');
      localStorage.setItem('shellpilot-l1','terminal');
    });
    await page.routeWebSocket('**/ws',(socket)=>socket.onMessage((text)=>{
      const message=JSON.parse(text);
      if(message.type==='attach') {
        const connected=trusted && message.hostId==='a';
        if(connected) attachesAfterTrust++;
        socket.send(JSON.stringify({type:'status',sessionId:message.sessionId,hostId:message.hostId,state:connected?'connected':'host-key-required',message:connected?'':'服务器身份已变化，连接已暂停'}));
      }
    }));
    await page.route('**/api/**',async(route)=>{
      const url=new URL(route.request().url()).pathname;
      let value=[];
      if(url==='/api/hosts') value=hosts;
      if(url==='/api/settings') value=settings;
      if(url==='/api/probe') value=[{hostId:'a',name:'演示主机 A',state:'offline',error:'Linux metrics failed'}];
      if(url==='/api/agent/status') value={busy:false,messages:[],approvals:[]};
      if(url==='/api/ssh/host-keys') value=keys.filter((key)=>!trusted || key.hostId!=='a');
      if(url==='/api/ssh/trust') {const request=route.request().postDataJSON();assert.equal(request.fingerprint,'test-fingerprint');trusted=true;value={ok:true};}
      await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    });
    await page.goto('http://127.0.0.1:4173');
    await page.getByRole('button',{name:'信任新指纹并连接',exact:true}).waitFor();
    assert.equal(await page.locator('.identity-panel').count(),1,'100 queued changed keys can show only the selected server');
    assert.equal(await page.locator('.identity-server strong').textContent(),'演示主机 A');
    await page.locator('.subtab').filter({hasText:'第二台测试'}).click();
    assert.equal(await page.locator('.identity-server strong').textContent(),'第二台测试','Switching tabs must switch the visible identity');
    await page.locator('.subtab').filter({hasText:'演示主机 A'}).click();
    assert.equal(await page.locator('.identity-server strong').textContent(),'演示主机 A');
    assert.equal(await page.getByRole('dialog').count(),0,'Identity UI must be inline, never a dialog');
    const position=await page.locator('.identity-panel').evaluate((element)=>getComputedStyle(element).position);
    assert(!['fixed','absolute'].includes(position),'Identity UI must occupy normal document space');
    const terminalBefore=await page.locator('.stage-pane.show .terminal-wrap').boundingBox();
    const card=await page.locator('.identity-panel').boundingBox();
    const topNavigation=await page.locator('.tabbar').boundingBox();
    const machineNavigation=await page.locator('.subtabs').boundingBox();
    assert.equal(await page.locator('.main > .identity-panel').count(),0,'Connection controls can never precede top-level navigation');
    assert(card.y>=machineNavigation.y+machineNavigation.height-1,'Connection controls belong below both fixed navigation levels');
    assert.equal(await page.locator('.stage > .identity-panel').count(),1,'Connection controls belong to the selected machine content area');
    assert(terminalBefore.y>=card.y+card.height-1,'The identity card must never cover the terminal');
    await page.screenshot({path:`layout-screenshots/${width}-identity-inline.png`});
    await page.getByRole('button',{name:'信任新指纹并连接',exact:true}).click();
    await page.locator('.identity-panel').waitFor({state:'detached'});
    const navigationAfter=await page.locator('.tabbar').boundingBox();
    const machinesAfter=await page.locator('.subtabs').boundingBox();
    assert.equal(navigationAfter.y,topNavigation.y,'Trusting identity must not move top-level tabs');
    assert.equal(machinesAfter.y,machineNavigation.y,'Trusting identity must not move machine tabs');
    await page.waitForFunction(()=>document.querySelector('.host-item .dot')?.classList.contains('green'));
    await page.locator('.subtabs').evaluate((element)=>element.scrollLeft=0);
    const beforeClose=await page.locator('.subtab').first().locator('.st-close').boundingBox();
    const tabWidths=await page.locator('.subtab').evaluateAll((tabs)=>tabs.map((tab)=>tab.getBoundingClientRect().width));
    assert(tabWidths.every((width)=>Math.abs(width-192)<1),'Machine tabs must have a fixed longer width');
    await page.locator('.subtab').first().locator('.st-close').click();
    const afterClose=await page.locator('.subtab').first().locator('.st-close').boundingBox();
    assert(Math.abs(beforeClose.x-afterClose.x)<1 && Math.abs(beforeClose.y-afterClose.y)<1,'Closing successive tabs must keep the close target at the same position');
    assert(attachesAfterTrust>0,'Trusting identity must retry the terminal automatically');
    assert.deepEqual(dialogs,[],'No browser alert or confirm is allowed');
    await page.screenshot({path:`layout-screenshots/${width}-connected-sidebar.png`});
    await page.close();
  }
  console.log('PASS: 100 pending identities stay scoped to active server, fixed navigation, no dialogs, automatic reconnect, Windows connected status');
  const overview=await browser.newPage({viewport:{width:1040,height:800},locale:'zh-CN'});
  await overview.addInitScript(()=>localStorage.setItem('shellpilot-last-view','home'));
  await overview.routeWebSocket('**/ws',()=>{});
  await overview.route('**/api/**',async(route)=>{
    const pathname=new URL(route.request().url()).pathname;
    let result=[];
    if(pathname==='/api/hosts')result=hosts;
    if(pathname==='/api/settings')result=settings;
    if(pathname==='/api/agent/status')result={busy:false,messages:[],approvals:[]};
    if(pathname==='/api/probe')result=[{hostId:'a',name:hosts[0].name,state:'host-key-required',error:'服务器身份已变化，连接已暂停'}];
    if(pathname==='/api/ssh/host-keys')result=[{key:'test.example:22',hostId:'a',host:'test.example',port:22,name:hosts[0].name,fingerprint:'changed',previous:'old',changed:true}];
    await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
  });
  await overview.goto('http://127.0.0.1:4173');
  await overview.getByRole('button',{name:'查看指纹并连接',exact:true}).waitFor();
  assert.equal(await overview.locator('.terminal-wrap').count(),0,'No terminal needs to be open to see pending identities');
  await overview.locator('.identity-summary').getByRole('button',{name:'查看',exact:true}).waitFor();
  await overview.screenshot({path:'layout-screenshots/1040-identity-before-opening-pages.png'});
  await overview.getByRole('button',{name:'查看指纹并连接',exact:true}).click();
  await overview.locator('.stage > .identity-panel').waitFor();
  assert.equal(await overview.getByRole('dialog').count(),0);
  await overview.close();
  console.log('PASS: changed identity visible and actionable from overview and sidebar before opening any workspace');
  for(const width of [390,1040]) {
    const page=await browser.newPage({viewport:{width,height:800},locale:'zh-CN'});
    let conversations=[1,2,3,4].map((number)=>({id:`delete-${number}`,title:`对话${number}`,createdAt:1762401600000,updatedAt:1762401600000,messages:[{role:'user',content:`测试消息${number}`}]}));
    let failOnce=true;
    const dialogs=[];
    page.on('dialog',(dialog)=>{dialogs.push(dialog.type());dialog.dismiss();});
    await page.addInitScript(()=>{
      localStorage.setItem('shellpilot-chat-id','delete-1');
      localStorage.setItem('shellpilot-last-view','home');
    });
    await page.routeWebSocket('**/ws',()=>{});
    await page.route('**/api/**',async(route)=>{
      const pathname=new URL(route.request().url()).pathname;
      let data=[];
      if(pathname==='/api/settings')data=settings;
      if(pathname==='/api/hosts')data=hosts;
      if(pathname==='/api/agent/status')data={busy:false,messages:[],approvals:[]};
      if(pathname==='/api/chats/__global__')data=conversations;
      if(pathname.startsWith('/api/chats/__global__/delete-')) {
        data=conversations.find((chat)=>pathname.endsWith(chat.id));
        if(!data) {await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'对话不存在'})});return;}
      }
      if(pathname==='/api/chats/__global__/delete') {
        if(failOnce) {failOnce=false;await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'测试删除失败，请重试'})});return;}
        const request=route.request().postDataJSON();
        const ids=request.all?conversations.map((chat)=>chat.id):request.ids;
        const before=conversations.length;
        conversations=conversations.filter((chat)=>!ids.includes(chat.id));
        data={ok:true,deleted:before-conversations.length,currentCleared:ids.includes('delete-1')};
      }
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.goto('http://127.0.0.1:4173');
    if(width<760)await page.locator('.mobile-nav').getByRole('button',{name:'AI',exact:true}).click();
    await page.getByText('测试消息1',{exact:true}).waitFor();
    await page.locator('.chat-avatar').evaluate((image)=>image.decode());
    assert.equal(await page.locator('.chat-avatar').getAttribute('src'),'/shellpilot.svg');
    await page.locator('.chat-title-btn').click();
    await page.getByRole('button',{name:'删除对话 对话2',exact:true}).click();
    const historyBounds=await page.locator('.chat-menu').boundingBox();
    const chatBounds=await page.locator('.chat-panel').boundingBox();
    assert(historyBounds.x>=chatBounds.x && historyBounds.x+historyBounds.width<=chatBounds.x+chatBounds.width+1,'History and delete actions must fit the chat panel');
    await page.screenshot({path:`layout-screenshots/${width}-delete-conversation.png`});
    await page.getByRole('button',{name:'确认删除',exact:true}).click();
    await page.getByText('测试删除失败，请重试',{exact:true}).waitFor();
    assert(conversations.some((chat)=>chat.id==='delete-2'),'Failure must never pretend to delete a conversation');
    await page.getByRole('button',{name:'确认删除',exact:true}).click();
    await page.getByRole('button',{name:'删除对话 对话2',exact:true}).waitFor({state:'detached'});
    await page.getByRole('button',{name:'管理对话',exact:true}).click();
    await page.getByRole('checkbox',{name:'选择对话 对话3',exact:true}).check();
    await page.getByRole('checkbox',{name:'选择对话 对话4',exact:true}).check();
    await page.getByRole('button',{name:'删除所选（2）',exact:true}).click();
    await page.getByRole('button',{name:'确认删除',exact:true}).click();
    await page.getByRole('button',{name:'删除对话 对话3',exact:true}).waitFor({state:'detached'});
    assert.deepEqual(conversations.map((chat)=>chat.id),['delete-1']);
    await page.getByRole('button',{name:'清空对话',exact:true}).click();
    await page.getByRole('button',{name:'确认删除',exact:true}).click();
    await page.getByText('还没有历史对话',{exact:true}).waitFor();
    assert.equal(await page.locator('.msg.user').count(),0,'Deleting current conversation clears visible messages');
    assert.deepEqual(conversations,[]);
    assert.deepEqual(dialogs,[],'Deletion confirmation must stay in the page, never native dialogs');
    await page.reload();
    if(width<760)await page.locator('.mobile-nav').getByRole('button',{name:'AI',exact:true}).click();
    await page.locator('.chat-title-btn').click();
    await page.getByText('还没有历史对话',{exact:true}).waitFor();
    assert.equal(await page.locator('.msg.user').count(),0);
    await page.close();
  }
  console.log('PASS: supplied avatar, visible single/batch/clear deletion with inline confirmation, error recovery and reload');
} finally { await browser.close(); }
