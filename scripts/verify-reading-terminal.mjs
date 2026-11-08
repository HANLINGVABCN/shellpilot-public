// Synthetic browser fixtures only; no user hosts, files or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
fs.mkdirSync('layout-screenshots',{recursive:true});
const browser=await chromium.launch();
let activePage;
const settings={providers:[{id:'p',name:'Demo'}],models:[{id:'m',providerId:'p',name:'demo'}],defaultModelId:'m',params:{temperature:0.3,maxTokens:0,historyLimit:0,maxSteps:0,contextChars:0},systemPrompt:'演示',autoMemory:false};
const host={id:'demo',name:'演示节点',host:'demo.example.com',username:'demo',port:22};
const terminalOutput='\x1bc'+Array.from({length:60},(_,index)=>`ROW_${String(index).padStart(2,'0')} abcdefghijklmnopqrstuvwxyz`).join('\r\n');
async function setup(page,{terminal=false,chat=false}={}){
  await page.addInitScript(({terminal,chat})=>{
    localStorage.setItem('shellpilot-last-view',terminal?'work':'home');
    localStorage.setItem('shellpilot-l1','terminal');
    if(terminal){localStorage.setItem('shellpilot-sess-term',JSON.stringify([{id:'terminal-demo',hostId:'demo',title:'演示节点'}]));localStorage.setItem('shellpilot-active-term','terminal-demo');localStorage.setItem('shellpilot-chat-open','hidden');}
    if(chat)localStorage.setItem('shellpilot-chat-id','reading-demo');
    window.__selectedText='';
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text)=>{window.__selectedText=text;},readText:async()=>window.__selectedText},configurable:true});
  },{terminal,chat});
  const linkCalls=[];
  const history=[{role:'user',content:'请显示演示文档。'},{role:'assistant',content:'[外部文档](https://example.com/docs?q=1&lang=zh)\n\n'+Array.from({length:85},(_,i)=>`第 ${i} 行：演示输出，仅用于检查浏览时保持滚动位置。`).join('\n')}];
  await page.route('**/api/**',async(route)=>{
    const url=new URL(route.request().url()).pathname;let value=[];
    if(url==='/api/settings')value=settings;
    if(url==='/api/hosts')value=[host];
    if(url==='/api/agent/status')value={busy:false,paused:false,queue:[],messages:[],approvals:[]};
    if(url==='/api/chats/__global__')value=[{id:'reading-demo',title:'阅读测试'}];
    if(url==='/api/chats/__global__/reading-demo')value={id:'reading-demo',title:'阅读测试',messages:history};
    if(url==='/api/open-external-url'){linkCalls.push(route.request().postDataJSON().url);value={ok:true};}
    await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  });
  let socket;
  await page.routeWebSocket('**/ws',(ws)=>{socket=ws;ws.onMessage((text)=>{
    const message=JSON.parse(text);
    if(message.type==='attach'&&terminal){
      ws.send(JSON.stringify({type:'status',sessionId:'terminal-demo',hostId:'demo',state:'connected'}));
      setTimeout(()=>ws.send(JSON.stringify({type:'term-replay',sessionId:'terminal-demo',hostId:'demo',data:terminalOutput})),150);
    }
  });});
  return {send:(message)=>socket.send(JSON.stringify(message)),linkCalls};
}
async function assertMouseRow(page){
  await page.waitForFunction(()=>[...document.querySelectorAll('.stage-pane.show .xterm-rows > div')].some((row)=>row.textContent.startsWith('ROW_')));
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForTimeout(120);
  const row=page.locator('.stage-pane.show .xterm-rows > div').filter({hasText:/ROW_\d+/}).nth(4);
  const text=await row.innerText(),expected=text.match(/ROW_\d+/)[0],box=await row.boundingBox();
  await page.mouse.dblclick(box.x+15,box.y+box.height/2);
  await page.waitForFunction(()=>window.__selectedText.length>0);
  const actual=await page.evaluate(()=>window.__selectedText);
  assert.equal(actual.trim(),expected,`Mouse at rendered ${expected} must select that row, received ${JSON.stringify(actual)}`);
  await page.mouse.click(box.x+80,box.y+box.height/2);
  await page.evaluate(()=>window.__selectedText='');
  await page.mouse.move(box.x+1,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+55,box.y+box.height/2,{steps:5});await page.mouse.up();
  const drag=await page.evaluate(()=>window.__selectedText);
  assert(drag.includes(expected.slice(0,4)),`Drag selection must remain on the pointed row: ${JSON.stringify(drag)}`);
}
try{
  for(const scale of [0.75,1,1.25,1.5]){
    const page=await browser.newPage({viewport:{width:1440,height:900},locale:'zh-CN',deviceScaleFactor:1.25});activePage=page;
    await setup(page,{terminal:true});
    await page.addInitScript((scale)=>localStorage.setItem('shellpilot-zoom',String(scale)),scale);
    await page.goto('http://127.0.0.1:4173');
    await assertMouseRow(page);
    const size=await page.locator('.stage-pane.show .xterm-screen').boundingBox();
    assert(size.height>200,'Neutral zoom terminal must fill available workspace');
    await page.setViewportSize({width:1100,height:800});await assertMouseRow(page);
    await page.evaluate(()=>{localStorage.setItem('shellpilot-zoom','1.1');window.dispatchEvent(new Event('shellpilot-zoom'));});await assertMouseRow(page);
    await page.screenshot({path:`layout-screenshots/terminal-selection-${scale}.png`});await page.close();
  }
  for(const width of [390,1040]){
    const page=await browser.newPage({viewport:{width,height:850},locale:'zh-CN'});activePage=page;
    const {send,linkCalls}=await setup(page,{chat:true});
    await page.goto('http://127.0.0.1:4173');
    if(width<760)await page.locator('.mobile-nav').getByRole('button',{name:'AI',exact:true}).click();
    await page.getByRole('link',{name:'外部文档',exact:true}).waitFor();
    const input=page.getByRole('textbox',{name:'AI 任务输入框',exact:true});
    const edge=page.getByRole('separator',{name:'调整 AI 输入框高度',exact:true});
    const initialHeight=width<760?72:64;
    assert(Math.abs((await input.boundingBox()).height-initialHeight)<1,'New composer defaults to a compact two-line height');
    assert.equal(await input.evaluate((element)=>getComputedStyle(element).resize),'none','The corner resize control must be replaced by the top edge');
    async function dragComposer(delta,fraction=0.5){
      const bounds=await edge.boundingBox();
      const x=bounds.x+bounds.width*fraction,y=bounds.y+bounds.height/2;
      await page.mouse.move(x,y);
      assert.equal(await edge.evaluate((element)=>getComputedStyle(element).cursor),'ns-resize');
      await page.mouse.down();
      await page.mouse.move(x,y-delta,{steps:10});
      await page.mouse.up();
      await page.waitForTimeout(80);
    }
    const draft=Array.from({length:12},(_,i)=>`多行任务 ${i}`).join('\n');
    await input.fill(draft);
    await dragComposer(180,0.05);
    assert(Math.abs((await input.boundingBox()).height-initialHeight-180)<2,'Dragging the left top edge upward enlarges the editor');
    assert.equal(await input.inputValue(),draft,'Dragging must preserve entered text');
    const preferred=await input.evaluate((element)=>element.offsetHeight);
    const preferenceKey=`shellpilot-composer-height-${width<760?'mobile':'desktop'}`;
    assert.equal(await page.evaluate((key)=>Number(localStorage.getItem(key)),preferenceKey),preferred,'Finished resize must save the selected size');
    await page.reload();
    if(width<760)await page.locator('.mobile-nav').getByRole('button',{name:'AI',exact:true}).click();
    await page.getByRole('link',{name:'外部文档',exact:true}).waitFor();
    assert(Math.abs((await input.boundingBox()).height-preferred)<2,'Reload restores the manually selected editor height');
    await page.setViewportSize({width,height:430});
    await page.waitForTimeout(150);
    const reducedActions=await page.locator('.chat-actions').boundingBox();
    assert(reducedActions.y+reducedActions.height<=430,'Shrinking the window must not hide composer actions');
    assert.equal(await page.evaluate((key)=>Number(localStorage.getItem(key)),preferenceKey),preferred,'Window fitting must not overwrite saved editor height');
    await page.setViewportSize({width,height:850});
    await page.waitForTimeout(150);
    assert(Math.abs((await input.boundingBox()).height-preferred)<2,'Restoring the window must recover the preferred height');
    await input.fill(draft);
    await dragComposer(-180,0.95);
    assert(Math.abs((await input.boundingBox()).height-initialHeight)<2,'Dragging the right top edge downward shrinks the editor');
    await dragComposer(-30);
    assert(Math.abs((await input.boundingBox()).height-(width<760?48:40))<2,'Editor can shrink to one-line space instead of the old large minimum');
    await edge.dblclick();
    assert(Math.abs((await input.boundingBox()).height-initialHeight)<2,'Double click resets only the editor size');
    await edge.press('ArrowUp');
    assert(Math.abs((await input.boundingBox()).height-initialHeight-8)<2,'Keyboard can resize the same divider');
    await edge.press('Home');
    const fullEdge=await edge.boundingBox();
    await dragComposer(fullEdge.y-20);
    assert((await input.boundingBox()).height>360,'Editor can grow beyond the old arbitrary height limit');
    const historySpace=await page.locator('.chat-list').boundingBox();
    assert(historySpace.height>=90,'Largest editor still leaves conversation space visible');
    const sendAction=await page.locator('.chat-actions').boundingBox();
    assert(sendAction.y+sendAction.height<=850,'Resizing must keep send/queue actions reachable');
    await edge.dblclick();
    if(width>=760){
      await page.evaluate(()=>{localStorage.setItem('shellpilot-zoom','1.25');window.dispatchEvent(new Event('shellpilot-zoom'));});
      await page.waitForTimeout(100);
      const before=await input.evaluate((element)=>({logical:element.offsetHeight,scale:element.getBoundingClientRect().height/element.offsetHeight}));
      await dragComposer(100);
      const after=await input.evaluate((element)=>element.offsetHeight);
      assert(Math.abs(after-before.logical-100/before.scale)<3,'Divider drag distance must account for interface scaling');
      await page.evaluate(()=>{localStorage.setItem('shellpilot-zoom','1');window.dispatchEvent(new Event('shellpilot-zoom'));});
      await page.waitForTimeout(100);await edge.dblclick();
    }
    assert(!await page.locator('body').evaluate((element)=>element.classList.contains('composer-resizing')),'Pointer capture and resize cursor must be released');
    const list=page.locator('.chat-list');
    await list.evaluate((element)=>new Promise((resolve)=>{
      element.scrollTop=element.scrollHeight;
      requestAnimationFrame(()=>requestAnimationFrame(resolve));
    }));
    send({type:'chat-start',text:'新的测试任务'});
    for(let i=0;i<8;i++)send({type:'chat-delta',delta:`\n最新输出 ${i}，跟随底部。`});
    await page.waitForFunction(()=>{const list=document.querySelector('.chat-list');return list.scrollHeight-list.clientHeight-list.scrollTop<30;});
    const listBox=await list.boundingBox();await page.mouse.move(listBox.x+50,listBox.y+100);await page.mouse.wheel(0,-700);
    await page.getByRole('button',{name:'滚到最新消息',exact:true}).waitFor();
    assert.equal(await page.locator('.chat-jump-latest').innerText(),'','Latest control must contain only an arrow');
    assert.equal(await page.getByText('正在浏览历史，输出不会拉动页面',{exact:true}).count(),0,'No reading notice should occupy a row');
    await page.waitForTimeout(100);
    const pausedTop=await list.evaluate((element)=>element.scrollTop);
    await dragComposer(50);
    assert(Math.abs((await list.evaluate((element)=>element.scrollTop))-pausedTop)<3,'Resizing while reading must not jump to the bottom');
    for(let i=0;i<25;i++)send({type:'chat-delta',delta:`\n新行 ${i}：继续输出但不能移动浏览位置。`});
    await page.getByText(/新行 24/).waitFor({state:'attached'});await page.waitForTimeout(100);
    assert(Math.abs((await list.evaluate((element)=>element.scrollTop))-pausedTop)<3,'Streaming updates must not move the user reading history');
    await page.screenshot({path:`layout-screenshots/${width}-read-history-during-stream.png`});
    await page.getByRole('button',{name:'滚到最新消息',exact:true}).click();
    send({type:'chat-delta',delta:'\n再跟随最新一行'});
    await page.waitForFunction(()=>{const list=document.querySelector('.chat-list');return list.scrollHeight-list.clientHeight-list.scrollTop<30;});
    await page.getByText(/再跟随最新一行/).waitFor({state:'attached'});
    const readingBox=await list.boundingBox();
    await page.mouse.move(readingBox.x+50,readingBox.y+100);await page.mouse.wheel(0,-10000);
    await page.getByRole('button',{name:'滚到最新消息',exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('.chat-list').scrollTop<10);
    const appUrl=page.url();await Promise.all([page.waitForResponse((response)=>response.url().endsWith('/api/open-external-url')),page.getByRole('link',{name:'外部文档',exact:true}).click()]);
    assert.equal(page.url(),appUrl,'External links cannot replace the app page');
    assert.equal(linkCalls[0],'https://example.com/docs?q=1&lang=zh');
    await page.getByRole('link',{name:'外部文档',exact:true}).click({button:'middle'});
    await page.waitForTimeout(100);assert.equal(linkCalls.length,2,'Middle click also hands the URL to the system browser');
    assert.equal(page.context().pages().length,1,'External link cannot create an embedded browser tab');
    const stillTop=await list.evaluate((element)=>element.scrollTop);send({type:'chat-delta',delta:'\n链接点击后继续生成'});await page.waitForTimeout(100);
    assert(Math.abs((await list.evaluate((element)=>element.scrollTop))-stillTop)<3);
    await page.close();
  }
  console.log('PASS: terminal row alignment; compact input with full-width top-edge resize, zoom handling and saved height; manual reading position; external links');
}catch(error){if(activePage&&!activePage.isClosed()){await activePage.screenshot({path:'layout-screenshots/reading-terminal-failure.png'});console.error(await activePage.locator('body').innerText());}throw error;}
finally{await browser.close();}
