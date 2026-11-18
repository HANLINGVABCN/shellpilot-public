import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
const browser=await chromium.launch({executablePath:process.env.SHELLPILOT_CHROMIUM});
const base=process.env.SHELLPILOT_PREVIEW_URL||'http://127.0.0.1:4173';fs.mkdirSync('layout-screenshots',{recursive:true});
try {
 for(const [width,height,grouped] of [[320,520,false],[393,844,false],[393,520,true],[844,393,false]]) {
  const page=await browser.newPage({viewport:{width,height},hasTouch:true,isMobile:true,userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36'});
  let hosts=Array.from({length:24},(_,i)=>({id:'edit-'+i,name:'演示机器 '+(i+1),host:'machine'+i+'.example.invalid',username:'demo',port:22,authType:'password',...(grouped?{group:i<12?'演示分组 A':'演示分组 B'}:{})}));
  const writes=[],connections=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('shellpilot-last-view','work');localStorage.setItem('shellpilot-sess-term',JSON.stringify([{id:'connected-fixture',hostId:'edit-0',title:'演示机器 1'}]));});
  await page.routeWebSocket('**/ws',socket=>socket.onMessage(raw=>{const m=JSON.parse(raw);if(m.type==='attach'){connections.push(m.hostId);socket.send(JSON.stringify({type:'status',sessionId:m.sessionId,hostId:m.hostId,state:'connected'}));}}));
  await page.route('**/api/**',async route=>{
   const p=new URL(route.request().url()).pathname;let value=[];
   if(p==='/api/hosts')value=hosts;
   if(p.startsWith('/api/hosts/')&&route.request().method()==='PUT'){
    const id=p.split('/').at(-1),body=route.request().postDataJSON();writes.push({id,body});hosts=hosts.map(h=>h.id===id?{...h,...body}:h);value={ok:true};
   }
   if(p==='/api/settings')value={providers:[],models:[],params:{}};
   if(p==='/api/storage/status')value={error:null};
   if(p==='/api/agent/status')value={busy:false,messages:[],approvals:[]};
   if(p==='/api/terminal/history')value={commands:[]};
   await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  });
  await page.goto(base);await page.locator('.terminal-el').waitFor();await page.getByRole('button',{name:'展开侧栏',exact:true}).tap();
  await page.locator('.host-item').first().locator('.dot.green').waitFor();
  const connectionsBefore=connections.length;
  for(const index of [0,11,23]) {
   const row=page.locator('.host-item').filter({has:page.getByRole('button',{name:'更多操作：演示机器 '+(index+1),exact:true})});
   await row.getByRole('button',{name:'更多操作：演示机器 '+(index+1),exact:true}).tap();
   const edit=row.getByRole('button',{name:'编辑机器 演示机器 '+(index+1),exact:true});await edit.scrollIntoViewIfNeeded();
   const hit=await edit.evaluate(el=>{const b=el.getBoundingClientRect(),row=el.closest('.host-item').getBoundingClientRect(),target=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return{reachable:el.contains(target),insideRow:b.bottom<=row.bottom+1,width:b.width,height:b.height};});
   assert(hit.reachable&&hit.insideRow,'Editor button is covered by a neighbouring machine');assert(hit.width>=44&&hit.height>=44,'Touch action is too small');
   await edit.tap();const modal=page.locator('.overlay .modal');await modal.getByText('编辑服务器',{exact:true}).waitFor();
   assert.equal(await modal.locator('input[placeholder="我的 VPS"]').inputValue(),'演示机器 '+(index+1));
   assert.equal(await modal.locator('input[placeholder="1.2.3.4"]').inputValue(),'machine'+index+'.example.invalid');
   if(index===23){await modal.locator('input[placeholder="我的 VPS"]').fill('编辑后的最后一台');await modal.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'更多操作：编辑后的最后一台',exact:true}).waitFor();}
   else await modal.getByRole('button',{name:'取消',exact:true}).tap();
   if(index===0)await page.screenshot({path:`layout-screenshots/android-edit-${width}-${height}-${grouped?'groups':'list'}.png`});
  }
  assert.equal(writes.length,1);assert.equal(writes[0].id,'edit-23');assert.equal(writes[0].body.name,'编辑后的最后一台');assert.equal(connections.length,connectionsBefore,'More/edit must not open another SSH connection');
  const overflow=await page.locator('.host-list').evaluate(el=>el.scrollWidth<=el.clientWidth+1);assert(overflow,'Action rows overflow the machine list');
  assert.deepEqual(errors,[]);await page.close();console.log(`PASS: Android ${width}×${height} ${grouped?'grouped':'ungrouped'} long list edit touch targets, scroll, correct record, save/cancel and no connection side effects`);
 }
}finally{await browser.close();}
