import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
const browser=await chromium.launch({executablePath:process.env.SHELLPILOT_CHROMIUM});
const base=process.env.SHELLPILOT_PREVIEW_URL||'http://127.0.0.1:4173';
try {
 for(const mobile of [false,true]){
  const page=await browser.newPage({viewport:{width:mobile?393:1100,height:850},userAgent:mobile?'Mozilla/5.0 (Linux; Android 14) Chrome/141 Mobile':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141'});
  const errors=[],exports=[],imports=[];let result='saved',releaseSave,pending=false,downloads=0;
  page.on('pageerror',error=>errors.push(error.message));page.on('download',()=>downloads++);
  await page.addInitScript(()=>localStorage.setItem('shellpilot-last-view','settings'));
  await page.routeWebSocket('**/ws',()=>{});
  await page.route('**/api/**',async route=>{
   const p=new URL(route.request().url()).pathname;let value=[];
   if(p==='/api/settings')value={providers:[],models:[],params:{}};
   if(p==='/api/agent/status')value={busy:false,messages:[],approvals:[],queue:[]};
   if(p==='/api/storage/status')value={error:null};
   if(p==='/api/export/preview')value={counts:{hosts:0,providers:0,chats:0,memories:1},nativeSave:true};
   if(p==='/api/export/save'){
    const body=route.request().postDataJSON();exports.push(body);
    if(pending)await new Promise(resolve=>releaseSave=resolve);
    if(result==='failed'){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'模拟保存失败'})});return;}
    value=result==='cancelled'?{saved:false,cancelled:true}:{saved:true,path:body.password?'选择的目录/加密备份.spex':'选择的目录/普通备份.json'};
   }
   if(p==='/api/import/preview'){
    const body=route.request().postDataJSON();const encrypted=Buffer.from(body.data,'base64').subarray(0,8).toString()==='SPEXPT01';
    if(encrypted&&!body.password){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'此备份已加密，请输入导入密码'})});return;}
    value={counts:{hosts:0,providers:0,chats:0,memories:1},hosts:[],providers:[]};
   }
   if(p==='/api/import'){imports.push(route.request().postDataJSON());value={ok:true};}
   await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  });
  await page.goto(base);
  const open=page.getByRole('button',{name:'📤 导出数据',exact:true}),confirm=page.getByRole('button',{name:'确认导出',exact:true}),dialog=page.getByRole('dialog');
  await open.click();await dialog.waitFor();assert(await confirm.isEnabled(),'No password must still allow export');
  pending=true;await confirm.click();await page.getByRole('button',{name:'选择位置并保存…',exact:true}).waitFor();
  assert.equal(await page.locator('.backup-done').count(),0,'Export must wait for chosen location and completed write');
  pending=false;releaseSave();await page.getByText('已保存到：选择的目录/普通备份.json',{exact:true}).waitFor();assert.equal(exports[0].password,'');
  result='cancelled';await open.click();await confirm.click();await page.getByText('已取消导出，未保存文件',{exact:true}).waitFor();
  result='failed';await open.click();await confirm.click();await page.getByRole('alert').filter({hasText:'模拟保存失败'}).waitFor();assert(await dialog.isVisible());assert.equal(await page.locator('.backup-done').count(),0);
  result='saved';await dialog.getByRole('button',{name:'取消',exact:true}).click();await open.click();await page.getByLabel('导出密码',{exact:true}).fill('fixture-password');await confirm.click();await page.getByText('已保存到：选择的目录/加密备份.spex',{exact:true}).waitFor();assert.equal(exports.at(-1).password,'fixture-password');assert.equal(downloads,0,'Native save must not start a browser download');
  await page.getByLabel('导入配置文件',{exact:true}).setInputFiles({name:'普通备份.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,memories:[{id:'m',content:'fixture memory'}]}))});
  const detect=page.getByRole('button',{name:'📂 检测并选择',exact:true});assert(await detect.isEnabled());await detect.click();await dialog.getByRole('button',{name:'全选',exact:true}).click();await dialog.getByRole('button',{name:'确认导入',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(imports[0].password,'');assert.equal(imports[0].sections.memories,true);
  await page.getByLabel('导入配置文件',{exact:true}).setInputFiles({name:'加密备份.spex',mimeType:'application/octet-stream',buffer:Buffer.from('SPEXPT01-fixture')});await detect.click();await page.getByRole('alert').filter({hasText:'此备份已加密'}).waitFor();await page.getByLabel('导入密码',{exact:true}).fill('fixture-password');await detect.click();await dialog.waitFor();await dialog.getByRole('button',{name:'取消',exact:true}).click();
  fs.mkdirSync('layout-screenshots',{recursive:true});await open.click();await page.screenshot({path:`layout-screenshots/backup-optional-password-${mobile?'android':'windows'}.png`});await dialog.getByRole('button',{name:'取消',exact:true}).click();
  assert.deepEqual(errors,[]);await page.close();console.log(`PASS: ${mobile?'Android':'Windows'} native save result, cancel/failure, optional export password and plain import`);
 }
 const page=await browser.newPage({viewport:{width:1100,height:850}});let exportCalls=0;
 await page.addInitScript(()=>{
  localStorage.setItem('shellpilot-last-view','settings');window.__pickerMode='cancel';window.__chosenOptions=null;window.__written=null;
  window.showSaveFilePicker=async options=>{window.__chosenOptions=options;if(window.__pickerMode==='cancel')throw new DOMException('Cancelled','AbortError');return{name:'自己选择的备份.json',createWritable:async()=>({write:async blob=>{window.__written=await blob.text();},close:async()=>{},abort:async()=>{}})};};
 });
 await page.routeWebSocket('**/ws',()=>{});
 await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;let value=[];if(p==='/api/settings')value={providers:[],models:[],params:{}};if(p==='/api/agent/status')value={busy:false,messages:[],approvals:[]};if(p==='/api/export/preview')value={counts:{memories:1},nativeSave:false};if(p==='/api/export'){exportCalls++;value={version:1,memories:[{id:'m',content:'fixture'}]};}await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});});
 await page.goto(base);await page.getByRole('button',{name:'📤 导出数据',exact:true}).click();await page.getByRole('button',{name:'确认导出',exact:true}).click();await page.getByText('已取消导出，未保存文件',{exact:true}).waitFor();assert.equal(exportCalls,0);
 await page.evaluate(()=>window.__pickerMode='save');await page.getByRole('button',{name:'📤 导出数据',exact:true}).click();await page.getByRole('button',{name:'确认导出',exact:true}).click();await page.getByText('已保存：自己选择的备份.json',{exact:true}).waitFor();
 assert((await page.evaluate(()=>window.__chosenOptions.suggestedName)).endsWith('.json'));assert.equal(JSON.parse(await page.evaluate(()=>window.__written)).version,1);await page.close();console.log('PASS: browser path selection before export, cancellation avoids download, chosen file receives plain JSON');
}finally{await browser.close();}
