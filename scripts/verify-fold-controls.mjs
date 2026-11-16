import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';

const browser=await chromium.launch({executablePath:process.env.SHELLPILOT_CHROMIUM});
const url=process.env.SHELLPILOT_PREVIEW_URL||'http://127.0.0.1:4173';
fs.mkdirSync('layout-screenshots',{recursive:true});
const hosts=[{id:'fold-a',name:'演示服务器',host:'demo.example.invalid',username:'demo',port:22}];
const settings={providers:[{id:'fold-p',name:'演示服务商'}],models:[{id:'fold-m',providerId:'fold-p',name:'用于检查标题栏的长模型名称'}],defaultModelId:'fold-m',params:{},systemPrompt:''};
const tick=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
try{
  for(const [android,width] of [[true,320],[true,393],[false,600],[false,1280]]){
    const page=await browser.newPage({viewport:{width,height:850},hasTouch:android,userAgent:android?'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile Safari/537.36':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36'});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      localStorage.setItem('shellpilot-sidebar','hidden');localStorage.setItem('shellpilot-chat-open','hidden');localStorage.setItem('shellpilot-last-view','work');
      localStorage.setItem('shellpilot-sess-term',JSON.stringify([{id:'fold-session',hostId:'fold-a',title:'演示服务器'}]));
    });
    await page.route('**/api/**',async route=>{
      const path=new URL(route.request().url()).pathname;let data=[];
      if(path==='/api/hosts')data=hosts;
      if(path==='/api/settings')data=settings;
      if(path==='/api/agent/status')data={busy:false,messages:[],approvals:[],queue:[]};
      if(path==='/api/storage/status')data={error:null};
      if(path==='/api/terminal/history')data={commands:[]};
      if(path==='/api/workspace')data={enabled:false,supported:true,directory:'/workspace'};
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.routeWebSocket('**/ws',socket=>socket.onMessage(raw=>{
      const message=JSON.parse(raw);
      if(message.type==='attach'){
        socket.send(JSON.stringify({type:'status',sessionId:message.sessionId,hostId:message.hostId,state:'connected'}));
        socket.send(JSON.stringify({type:'term-replay',sessionId:message.sessionId,data:'演示终端\r\ndemo@host:~$ '}));
      }
    }));
    await page.goto(url);await page.locator('.terminal-el').waitFor();await tick(page);
    const sideOpen=()=>page.getByRole('button',{name:'展开侧栏',exact:true});
    const aiOpen=()=>page.getByRole('button',{name:'展开 AI 对话',exact:true});
    const click=button=>android?button.tap():button.click();
    async function checkBar(button){
      const size=await button.locator('.edge-grip').evaluate(el=>({width:getComputedStyle(el).width,height:getComputedStyle(el).height}));
      assert(Math.abs(parseFloat(size.width)-5)<.1&&Math.abs(parseFloat(size.height)-34)<.1,'Fold rectangle dimensions changed');
      const box=await button.boundingBox(),app=await page.locator('#app').boundingBox();assert(box.y<app.y+50,'Fold control left the upper corner');
    }
    await checkBar(sideOpen());await checkBar(aiOpen());
    if(!android){
      const before=await page.locator('.tabbar').boundingBox();await sideOpen().hover();await sideOpen().locator('.edge-hover').waitFor();
      assert.deepEqual(await page.locator('.tabbar').boundingBox(),before,'Hover changed the work header');
      await page.locator('.tab-left').hover();await sideOpen().locator('.edge-hover').waitFor({state:'hidden'});
    }
    await click(sideOpen());
    const side=page.locator('#sidebar-panel'),extra=side.getByRole('button',{name:'从右侧收起侧栏',exact:true});
    await extra.waitFor();await checkBar(side.getByRole('button',{name:'收起侧栏',exact:true}));
    assert.equal(await extra.locator('.edge-grip,.edge-hover').count(),0);
    assert.equal(await extra.getAttribute('title'),null);
    assert.equal(await extra.locator('.edge-symbol').evaluate(el=>getComputedStyle(el).width),'16px');
    const direct=await extra.evaluate(el=>({border:getComputedStyle(el).borderTopWidth,background:getComputedStyle(el).backgroundColor}));
    assert.deepEqual(direct,{border:'0px',background:'rgba(0, 0, 0, 0)'});
    await page.screenshot({path:`layout-screenshots/fold-${android?'android':'windows'}-${width}-sidebar.png`});
    await click(extra);await sideOpen().waitFor();await click(sideOpen());await click(side.getByRole('button',{name:'收起侧栏',exact:true}));
    await sideOpen().waitFor();await click(aiOpen());
    const aiClose=page.getByRole('button',{name:'收起 AI 对话',exact:true});await aiClose.waitFor();await checkBar(aiClose);
    assert.equal(await page.locator('.chat-head img').count(),0);
    const pane=await page.locator('.chat-panel').boundingBox();
    for(const control of [page.locator('.chat-title-btn'),page.locator('.model-wrap > .chat-model')]){
      const box=await control.boundingBox();assert(box.x>=pane.x-1&&box.x+box.width<=pane.x+pane.width+1,'A chat picker leaves its panel');
    }
    await page.screenshot({path:`layout-screenshots/fold-${android?'android':'windows'}-${width}-ai.png`});
    await click(aiClose);await aiOpen().waitFor();
    for(const view of ['机器总览','配置','工作台']){
      await click(sideOpen());await side.getByRole('button',{name:view,exact:true}).click();
      if(!android)await click(side.getByRole('button',{name:'从右侧收起侧栏',exact:true}));
      await sideOpen().waitFor();await checkBar(sideOpen());await checkBar(aiOpen());
      await click(aiOpen());await click(page.getByRole('button',{name:'收起 AI 对话',exact:true}));
    }
    if(!android&&width===1280){
      await click(sideOpen());await click(aiOpen());
      const handles=page.locator('.drag-handle-v'),before=await side.boundingBox(),handle=await handles.first().boundingBox();
      await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+50,handle.y+handle.height/2);await page.mouse.up();await tick(page);
      const resized=await side.boundingBox();assert(resized.width>before.width+30,'Sidebar resize stopped working');
      const chatBefore=await page.locator('.chat-panel').boundingBox(),chatHandle=await handles.last().boundingBox();
      await page.mouse.move(chatHandle.x+chatHandle.width/2,chatHandle.y+chatHandle.height/2);await page.mouse.down();await page.mouse.move(chatHandle.x+30,chatHandle.y+chatHandle.height/2);await page.mouse.up();await tick(page);
      assert((await page.locator('.chat-panel').boundingBox()).width<chatBefore.width-15,'AI resize stopped working');
      const preferred=JSON.parse(await page.evaluate(()=>localStorage.getItem('shellpilot-widths')));
      await page.setViewportSize({width:600,height:850});await tick(page);await page.setViewportSize({width:1280,height:850});await tick(page);
      assert(Math.abs((await side.boundingBox()).width-preferred.side)<2,'Viewport restore lost preferred sidebar width');
      assert(Math.abs((await page.locator('.chat-panel').boundingBox()).width-preferred.chat)<2,'Viewport restore lost preferred AI width');
    }
    assert.deepEqual(errors,[]);await page.close();
    console.log(`PASS: ${android?'Android':'Windows'} ${width}px fold positions, hover, dual close, page navigation and layout`);
  }
}finally{await browser.close();}
