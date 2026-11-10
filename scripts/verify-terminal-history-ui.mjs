import {chromium} from 'playwright';import assert from 'node:assert/strict';import fs from 'node:fs';
const browser=await chromium.launch({executablePath:process.env.SHELLPILOT_CHROMIUM});
try{for(const mobile of [false,true])for(const zoom of [1,1.35]){
 const page=await browser.newPage({viewport:{width:mobile?390:1200,height:820},locale:'zh-CN',userAgent:mobile?'Mozilla/5.0 (Linux; Android 13) Chrome/141 Mobile':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141'});const errors=[],sent=[];let socket,typed='',cursor=0;
 const hosts=[{id:'a',name:'Demo A',host:'a.example',username:'demo',port:22},{id:'b',name:'Demo B',host:'b.example',username:'demo',port:22}];
 const histories={a:['systemctl status demo.service','echo 中文完成','uptime'],b:['uname -a']};
 const osc=(host,code)=>'\x1b]777;ShellPilot;token-'+host+';'+code+'\x07';
 await page.addInitScript(zoom=>{localStorage.setItem('shellpilot-last-view','work');localStorage.setItem('shellpilot-l1','terminal');localStorage.setItem('shellpilot-chat-open','hidden');localStorage.setItem('shellpilot-zoom',String(zoom));localStorage.setItem('shellpilot-sess-term',JSON.stringify([{id:'sa',hostId:'a',title:'Demo A'},{id:'sb',hostId:'b',title:'Demo B'}]));localStorage.setItem('shellpilot-active-term','sa');},zoom);
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());let value=[];if(url.pathname==='/api/hosts')value=hosts;if(url.pathname==='/api/settings')value={providers:[],models:[],params:{}};if(url.pathname==='/api/agent/status')value={busy:false,queue:[],approvals:[]};if(url.pathname==='/api/terminal/history')value={commands:histories[url.searchParams.get('host')]||[]};await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});});
 let active='a',holdEcho=false;const delayed=[];const output=(data,host=active)=>{const message={type:'term-data',hostId:host,sessionId:'s'+host,data};if(holdEcho)delayed.push(message);else socket.send(JSON.stringify(message));};
 function prompt(host=active){typed='';cursor=0;output('\r\n'+osc(host,'P')+'\x1b[32m演示$ \x1b[0m'+osc(host,'I'),host);}
 await page.routeWebSocket('**/ws',ws=>{socket=ws;ws.onMessage(text=>{const message=JSON.parse(text);if(message.type==='attach'){
  active=message.hostId;ws.send(JSON.stringify({type:'status',hostId:active,sessionId:message.sessionId,state:'connected',shellIntegration:'token-'+active}));
  ws.send(JSON.stringify({type:'term-replay',hostId:active,sessionId:message.sessionId,data:'\x1bc'+osc(active,'P')+'演示$ '+osc(active,'I')}));typed='';cursor=0;
 }else if(message.type==='term-input'){
  sent.push(message);active=message.sessionId.slice(1);let data=message.data;
  if(data==='\r'){output(osc(active,'C')+'\r\n');typed='';cursor=0;return;}
  if(data==='\x03'){prompt();return;}
  if(data==='\x1b[D'){cursor=Math.max(0,cursor-1);output(data);return;}
  if(data==='\x1b[C'){if(cursor<typed.length){cursor++;output(data);}return;}
  if(data==='\x7f'){if(cursor>0){typed=typed.slice(0,cursor-1)+typed.slice(cursor);cursor--;output('\b \b');}return;}
  if(data==='\x1b')return;
  if(data.startsWith('\x1b[200~'))data=data.slice(6,-6);
  typed=typed.slice(0,cursor)+data+typed.slice(cursor);cursor+=data.length;output(data);
 }});});
 await page.goto('http://127.0.0.1:4173');if(mobile)await page.locator('.mobile-nav').getByRole('button',{name:'工作台',exact:true}).click();const terminal=page.locator('.stage-pane.show .terminal-el'),input=terminal.locator('.xterm-helper-textarea'),ghost=terminal.locator('.terminal-history-suggestion');
 await input.waitFor();await input.focus();await input.pressSequentially('systemctl sta');await ghost.waitFor({state:'visible'});assert.equal(await ghost.textContent(),'tus demo.service');
 const screen=await terminal.locator('.xterm-screen').boundingBox(),position=await ghost.boundingBox();assert(position.x>screen.x&&position.x<screen.x+screen.width);assert(position.y>=screen.y&&position.y<screen.y+screen.height);
 const before=sent.length;await input.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('.terminal-history-suggestion')?.hidden);assert(sent.slice(before).some(message=>message.data==='tus demo.service'));assert(!sent.slice(before).some(message=>message.data==='\r'));
 await input.press('Enter');prompt();await input.pressSequentially('systemctl st');await ghost.waitFor({state:'visible'});await input.press('ArrowLeft');await ghost.waitFor({state:'hidden'});await input.press('Control+c');
 await input.pressSequentially('up');await ghost.waitFor({state:'visible'});holdEcho=true;const lagStart=sent.length;await input.pressSequentially('t');await input.press('ArrowRight');assert(await ghost.isHidden());assert(!sent.slice(lagStart).some(message=>message.data==='time'),'Delayed remote echo must not accept the old suggestion');holdEcho=false;for(const message of delayed.splice(0))socket.send(JSON.stringify(message));await ghost.waitFor({state:'visible'});await input.press('Escape');await ghost.waitFor({state:'hidden'});await input.pressSequentially('i');await ghost.waitFor({state:'visible'});
 await input.press('Control+c');await input.pressSequentially('echo 中');await ghost.waitFor({state:'visible'});assert.equal(await ghost.textContent(),'文完成');await ghost.dispatchEvent('pointerdown',{pointerType:'touch'});await ghost.waitFor({state:'hidden'});
 await input.press('Enter');output('Password: ');await input.pressSequentially('up');assert(await ghost.isHidden(),'No history suggestion inside password input');
 output('\x1b[?1049h');assert(await ghost.isHidden(),'No history suggestion in editors');output('\x1b[?1049l');prompt();
 await page.locator('.subtab').filter({hasText:'Demo B'}).click();const other=page.locator('.stage-pane.show .terminal-el'),otherInput=other.locator('.xterm-helper-textarea'),otherGhost=other.locator('.terminal-history-suggestion');await otherInput.focus();await otherInput.pressSequentially('up');assert(await otherGhost.isHidden(),'Other hosts must not use this history');await otherInput.press('Control+c');await otherInput.pressSequentially('una');await otherGhost.waitFor({state:'visible'});assert.equal(await otherGhost.textContent(),'me -a');
 assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));fs.mkdirSync('layout-screenshots',{recursive:true});await page.screenshot({path:'layout-screenshots/terminal-history-'+(mobile?'android-':'windows-')+zoom+'.png'});await page.close();
}console.log('PASS: inline history suggestions, right-arrow/touch acceptance without Enter, editing/dismissal/Chinese, password/editor exclusion, host isolation and zoom');}finally{await browser.close();}
