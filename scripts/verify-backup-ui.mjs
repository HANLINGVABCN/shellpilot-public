import {chromium} from 'playwright';import assert from 'node:assert/strict';import fs from 'node:fs';
const browser=await chromium.launch({executablePath:process.env.SHELLPILOT_CHROMIUM});
try{for(const mobile of [false,true]){
 const page=await browser.newPage({locale:'zh-CN',viewport:{width:mobile?390:1200,height:850},userAgent:mobile?'Mozilla/5.0 (Linux; Android 13) Chrome/141 Mobile':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141'});
 let detected={hosts:2,providers:1,chats:3,memories:4},importBody=null,exportBody=null,previewCalls=0,importCalls=0;
 const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',()=>{throw Error('Unexpected browser confirmation')});
 await page.addInitScript(()=>localStorage.setItem('shellpilot-last-view','settings'));
 await page.route('**/api/**',async route=>{
  const request=route.request(),p=new URL(request.url()).pathname;let value=[];
  if(p==='/api/settings')value={providers:[],models:[],params:{}};
  if(p==='/api/agent/status')value={busy:false,messages:[],approvals:[],queue:[]};
  if(p==='/api/export/preview')value={counts:{hosts:2,providers:1,chats:3,memories:4}};
  if(p==='/api/export'){exportBody=request.postDataJSON();await route.fulfill({contentType:'application/octet-stream',body:Buffer.from('SPEXPT01-fixture')});return;}
  if(p==='/api/import/preview'){previewCalls++;value={counts:detected,hosts:detected.hosts?[{id:'h1',name:'Demo one',username:'demo',host:'192.0.2.1',port:22},{id:'h2',name:'Demo two',username:'demo',host:'192.0.2.2',port:22}]:[],providers:detected.providers?[{id:'p',name:'Demo provider',modelCount:1}]:[]};}
  if(p==='/api/import'){importBody=request.postDataJSON();importCalls++;value={ok:true};}
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('http://127.0.0.1:4173');if(mobile)await page.locator('.mobile-nav').getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('button',{name:'📤 导出数据',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByText('选择要导出的内容').waitFor();assert.equal(await dialog.getByRole('checkbox').count(),4);
 const optionRects=await dialog.locator('.backup-option').evaluateAll(options=>options.map(option=>{const rect=option.getBoundingClientRect();return{x:rect.x,y:rect.y,height:rect.height,width:rect.width};}));
 assert(optionRects.every(rect=>rect.height===optionRects[0].height),'Backup option rows stay aligned');if(!mobile)assert.equal(optionRects[0].y,optionRects[1].y,'Two columns share the same top edge');
 await dialog.getByRole('button',{name:'取消全选',exact:true}).click();assert(await dialog.getByRole('button',{name:'确认导出',exact:true}).isDisabled());
 await dialog.getByRole('button',{name:'全选',exact:true}).click();await dialog.getByLabel('服务器',{exact:true}).uncheck();await dialog.getByLabel('AI 提供商',{exact:true}).uncheck();await dialog.getByLabel('对话记录',{exact:true}).uncheck();
 await dialog.getByLabel('导出密码',{exact:true}).fill('fixture-password');const download=page.waitForEvent('download');await dialog.getByRole('button',{name:'确认导出',exact:true}).click();await download;await dialog.waitFor({state:'hidden'});assert.deepEqual(exportBody.sections,{hosts:false,providers:false,chats:false,memories:true});
 await page.getByLabel('导入配置文件',{exact:true}).setInputFiles({name:'fixture.spex',mimeType:'application/octet-stream',buffer:Buffer.from('encrypted fixture')});await page.getByLabel('导入密码',{exact:true}).fill('fixture-password');
 detected={hosts:0,providers:0,chats:0,memories:4};await page.getByRole('button',{name:'📂 检测并选择',exact:true}).click();await dialog.getByText('选择要导入的内容').waitFor();assert.equal(previewCalls,1);assert.equal(importCalls,0);
 for(const name of ['服务器','AI 提供商','对话记录'])assert(await dialog.getByLabel(name,{exact:true}).isDisabled());assert(await dialog.getByLabel('记忆',{exact:true}).isEnabled());assert(await dialog.getByRole('button',{name:'确认导入',exact:true}).isDisabled());
 await dialog.getByRole('button',{name:'全选',exact:true}).click();assert(await dialog.getByLabel('记忆',{exact:true}).isChecked());assert.equal(await dialog.locator('input[type=checkbox]:checked').count(),1);
 await dialog.getByRole('radio').nth(1).check();await dialog.getByRole('button',{name:'确认导入',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.deepEqual(importBody.sections,{hosts:false,providers:false,chats:false,memories:true});assert.equal(importBody.mode,'overwrite');
 detected={hosts:2,providers:1,chats:3,memories:0};await page.getByRole('button',{name:'📂 检测并选择',exact:true}).click();await dialog.waitFor();assert(await dialog.getByLabel('记忆',{exact:true}).isDisabled());await dialog.getByRole('button',{name:'全选',exact:true}).click();assert(await dialog.getByLabel('服务器',{exact:true}).isChecked());assert(await dialog.getByLabel('AI 提供商',{exact:true}).isChecked());assert(await dialog.getByLabel('对话记录',{exact:true}).isChecked());
 await dialog.getByLabel('全选服务器',{exact:true}).uncheck();assert(await dialog.getByRole('button',{name:'确认导入',exact:true}).isDisabled());await dialog.getByRole('button',{name:'全选',exact:true}).click();assert(await dialog.getByRole('button',{name:'确认导入',exact:true}).isEnabled());
 const exports=exportBody;await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(importCalls,1);assert.equal(exports,exportBody);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 fs.mkdirSync('layout-screenshots',{recursive:true});await page.getByRole('button',{name:'📂 检测并选择',exact:true}).click();await dialog.waitFor();await page.screenshot({path:'layout-screenshots/backup-'+(mobile?'android':'windows')+'.png'});await page.close();
}console.log('PASS: four export choices; import detects before showing options, absent items disabled, select-all respects availability and cancellation never imports');}finally{await browser.close();}
