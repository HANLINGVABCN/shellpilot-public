import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';

const browser=await chromium.launch({executablePath:process.env.SHELLPILOT_CHROMIUM});
const base=process.env.SHELLPILOT_PREVIEW_URL||'http://127.0.0.1:4173';
fs.mkdirSync('layout-screenshots',{recursive:true});
try {
  for(const [android,width,height] of [[true,320,800],[true,393,844],[true,393,430],[false,600,800],[false,1280,850]]) {
    const page=await browser.newPage({viewport:{width,height},hasTouch:android,userAgent:android?'Mozilla/5.0 (Linux; Android 14) Chrome/141 Mobile':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141'});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    let hosts=[{id:'a',name:'演示机器 A',host:'a.example.invalid',username:'demo',port:22},{id:'b',name:'演示机器 B',host:'b.example.invalid',username:'demo',port:22}];
    let settings={providers:[{id:'p',name:'测试服务商'}],models:[{id:'m1',providerId:'p',name:'用于检查省略的超长模型名称'},{id:'m2',providerId:'p',name:'AnotherVeryLongModelNameWithoutSpacesForOverflowVerification'}],defaultModelId:'m1',params:{}};
    let socket,busy=false;const scopeUpdates=[];
    await page.addInitScript(()=>{localStorage.setItem('shellpilot-last-view','work');localStorage.setItem('shellpilot-sidebar','hidden');localStorage.setItem('shellpilot-chat-id','demo');localStorage.setItem('shellpilot-agent-scope',JSON.stringify(['a']));});
    await page.route('**/api/**',async route=>{
      const p=new URL(route.request().url()).pathname;let value=[];
      if(p==='/api/hosts')value=hosts;
      if(p==='/api/settings'){if(route.request().method()==='PUT')settings=route.request().postDataJSON();value=settings;}
      if(p==='/api/storage/status')value={error:null};
      if(p==='/api/agent/status')value={busy,queue:[],approvals:[],messages:[]};
      if(p==='/api/chats/__global__')value=[{id:'demo',title:'检查很长的对话名称是否挤压机器入口'}];
      if(p==='/api/chats/__global__/demo')value={id:'demo',title:'检查很长的对话名称是否挤压机器入口',messages:[]};
      if(p==='/api/workspace')value={enabled:true,supported:true,directory:'/workspace'};
      await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    });
    await page.routeWebSocket('**/ws',ws=>{socket=ws;ws.onMessage(raw=>{const m=JSON.parse(raw);if(m.type==='agent-scope')scopeUpdates.push(m.hostIds);});});
    await page.goto(base);if(android)await page.getByRole('button',{name:'展开 AI 对话',exact:true}).click();
    await page.getByRole('button',{name:'机器 1/2',exact:true}).waitFor();
    assert.equal(await page.locator('.chat-panel button[aria-label="工作区"],.chat-panel .workspace-panel,.chat-panel .pre-input').count(),0);
    assert.equal(await page.locator('.chat-head .model-wrap').count(),0);
    assert.equal(await page.locator('.chat-head .scope-wrap').count(),1);
    assert.equal(await page.locator('.chat-actions > .mode-wrap').count(),1);
    assert.equal(await page.locator('.chat-actions .model-wrap').count(),1);
    const title=await page.locator('.chat-title-btn').boundingBox(),machine=await page.locator('.chat-head .scope-wrap > button').boundingBox();
    assert(machine.x>=title.x+title.width-1,'Machines must be to the right of conversation');
    assert(Math.abs(title.y+title.height/2-machine.y-machine.height/2)<2,'Header controls must share a row');
    const mode=await page.locator('.chat-actions > .mode-wrap > button').boundingBox(),model=await page.getByRole('button',{name:'选择模型',exact:true}).boundingBox();
    assert(model.x>mode.x+mode.width,'Model entry must follow execution mode');
    assert(Math.abs(model.y+model.height/2-mode.y-mode.height/2)<2,'Bottom controls must fit the same row');
    async function fits(selector) {
      const b=await page.locator(selector).boundingBox(),panel=await page.locator('.chat-panel').boundingBox();
      assert(b&&b.x>=panel.x-1&&b.x+b.width<=panel.x+panel.width+1&&b.y>=0&&b.y+b.height<=height+1,selector+' outside the visible chat area');return b;
    }
    await fits('.chat-actions');
    const machines=page.locator('.chat-head .scope-wrap > button');await machines.click();await fits('.scope-menu');
    const all=page.getByRole('checkbox',{name:'全选',exact:true});assert.equal(await all.evaluate(el=>el.indeterminate),true);
    await all.check();await page.getByRole('button',{name:'机器 2/2',exact:true}).waitFor();assert.equal(await page.getByRole('checkbox',{name:'选择机器 演示机器 B'}).isChecked(),true);
    await all.uncheck();await page.getByRole('button',{name:'机器 0/2',exact:true}).waitFor();assert.equal(await page.getByRole('checkbox',{name:'选择机器 演示机器 A'}).isChecked(),false);
    await page.getByRole('checkbox',{name:'选择机器 演示机器 A'}).check();assert.equal(await all.evaluate(el=>el.indeterminate),true);
    await machines.click();
    hosts=[...hosts,{id:'c',name:'新增机器 C',host:'c.example.invalid',username:'demo',port:22}];socket.send(JSON.stringify({type:'hosts-changed'}));
    await page.getByRole('button',{name:'机器 1/3',exact:true}).waitFor();await machines.click();assert.equal(await page.getByRole('checkbox',{name:'选择机器 新增机器 C'}).isChecked(),false);
    busy=true;socket.send(JSON.stringify({type:'chat-job-state',revision:10,busy:true,activeId:'task'}));await all.waitFor();assert.equal(await all.isEnabled(),false);
    assert.equal(await page.getByRole('checkbox',{name:'选择机器 演示机器 A'}).isEnabled(),false);
    await machines.click();busy=false;socket.send(JSON.stringify({type:'chat-job-state',revision:11,busy:false,activeId:null}));
    await page.getByRole('button',{name:'选择模型',exact:true}).click();const menu=await fits('.model-menu');
    assert(menu.y+menu.height<=(await page.locator('.chat-actions').boundingBox()).y+1,'Model menu must open above the composer actions');
    assert(await page.locator('.model-menu').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Long model name overflows the menu');
    await page.locator('.model-menu button').filter({hasText:'AnotherVeryLongModelName'}).click();
    await page.waitForFunction(()=>document.querySelector('.model-select-label')?.textContent.startsWith('AnotherVeryLong'));
    assert.equal(settings.defaultModelId,'m2');
    await page.locator('.chat-actions > .mode-wrap > button').click();await fits('.chat-actions > .mode-wrap .mode-menu');
    await page.locator('.chat-actions > .mode-wrap .menu-item').filter({hasText:'审批执行'}).click();assert.equal(await page.locator('.chat-actions > .mode-wrap > button').innerText(),'审批执行');
    await page.locator('.effort-wrap > button').click();await fits('.effort-wrap .mode-menu');await page.locator('.effort-wrap > button').click();
    assert(scopeUpdates.some(ids=>ids.length===2)&&scopeUpdates.some(ids=>ids.length===0),'Select all changes must reach the simulated backend');
    const before=await page.evaluate(()=>localStorage.getItem('shellpilot-agent-scope'));assert.deepEqual(JSON.parse(before),['a']);
    await page.screenshot({path:`layout-screenshots/chat-controls-${android?'android':'windows'}-${width}-${height}.png`});
    await page.reload();if(android)await page.getByRole('button',{name:'展开 AI 对话',exact:true}).click();await page.getByRole('button',{name:'机器 1/3',exact:true}).waitFor();
    assert.equal(await page.locator('.chat-actions > .mode-wrap > button').innerText(),'审批执行');
    assert.deepEqual(errors,[]);await page.close();console.log(`PASS: ${android?'Android':'Windows'} ${width}×${height} chat row, select all/none, busy lock, model switch, upward menus and saved choices`);
  }
}finally{await browser.close();}
