import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const browser=await chromium.launch({executablePath:process.env.SHELLPILOT_CHROMIUM});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-ui-')),folder=path.join(temp,'project');
fs.mkdirSync(path.join(folder,'docs'),{recursive:true});fs.writeFileSync(path.join(folder,'docs','readme.txt'),'nested upload');
try {for(const mobile of [false,true]) {
 const page=await browser.newPage({locale:'zh-CN',viewport:{width:mobile?390:1280,height:850},userAgent:mobile?'Mozilla/5.0 (Linux; Android 13) Chrome/141 Mobile':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141'});
 let config={directory:mobile?'/workspace':'C:\\DemoWorkspace',enabled:true,network:false,autoStart:false,engine:'linux',supported:true};
 let runtime={phase:'installed',installed:true,available:true,running:false,version:'alpine-test'};
 const files=new Map([['demo.txt','initial'],['docs/existing.txt','existing']]),dirs=new Set(['docs']);
 let installedCalls=0,releaseSave,saveFail=false;const saveGate=new Promise(resolve=>releaseSave=resolve),connections=[];const errors=[];
 page.on('dialog',()=>{throw Error('Unexpected browser dialog')});page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('shellpilot-last-view','work');localStorage.setItem('shellpilot-l1','workspace');localStorage.setItem('shellpilot-chat-open','hidden');});
 await page.routeWebSocket('**/api/workspace/terminal/ws?*',socket=>{connections.push(new URL(socket.url()).searchParams.get('path'));socket.send('workspace shell ready\r\n');socket.onMessage(()=>socket.send('independent terminal output\r\n'));});
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),p=url.pathname;let value=[];
  if(p==='/api/settings')value={providers:[],models:[],params:{}};
  if(p==='/api/agent/status')value={busy:false,queue:[],approvals:[]};
  if(p==='/api/workspace'){
   if(request.method()==='PUT'){await saveGate;if(saveFail){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'保存失败'})});return;}config=request.postDataJSON();}value=config;
  }
  if(p==='/api/workspace/pick')value={directory:'C:\\DemoWorkspace'};
  if(p==='/api/workspace/linux')value=runtime;
  if(p==='/api/workspace/linux/start'){runtime.running=true;value={running:true};}
  if(p==='/api/workspace/linux/stop'){runtime.running=false;value={stopped:true};}
  if(p==='/api/workspace/linux/uninstall'){runtime={...runtime,phase:'not-installed',installed:false};value={uninstalled:true};}
  if(p==='/api/workspace/linux/install'){installedCalls++;runtime={...runtime,phase:'downloading',received:200,total:1000};value={started:true};}
  if(p==='/api/workspace/files'){
   const current=url.searchParams.get('path')||'',prefix=current?current+'/':'';
   const children=[...dirs].filter(name=>name.startsWith(prefix)&&!name.slice(prefix.length).includes('/')).map(name=>({name:name.slice(prefix.length),directory:true,size:0}));
   for(const[name,text]of files)if(name.startsWith(prefix)&&!name.slice(prefix.length).includes('/'))children.push({name:name.slice(prefix.length),directory:false,size:text.length,mtime:1730000000000});
   value={entries:children};
  }
  if(p==='/api/workspace/action'){
   const{name,arguments:args}=request.postDataJSON();
   if(name==='workspace_read')value={path:args.path,content:files.get(args.path),sha256:'fixture-hash'};
   if(name==='workspace_write'){files.set(args.path,args.content);value={written:true};}
  }
  if(p==='/api/workspace/upload'){
   const text=request.postDataBuffer().toString(),match=text.match(/name="manifest"\r\n\r\n([^\r]*)/),manifest=JSON.parse(match[1]);
   assert(manifest.files.includes('project/docs/readme.txt'));
   files.set('project/docs/readme.txt','nested upload');dirs.add('project');dirs.add('project/docs');value={files:manifest.files};
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('http://127.0.0.1:4173');
 if(mobile)await page.locator('.mobile-nav').getByRole('button',{name:'工作台',exact:true}).click();
 const panel=page.locator('.workspace-page'),visible=panel.locator('.workspace-tab-pane.on');
 await visible.locator('[data-name="demo.txt"]').waitFor();
 assert.equal(await panel.getByRole('tab').count(),1);assert.equal(await panel.getByLabel('工作区运行环境').count(),0);
 assert.equal(await visible.locator('.workspace-settings').count(),0,'Files are the main page');
 await visible.locator('[data-name="demo.txt"]').dblclick();await page.getByLabel('工作区文件内容').fill('updated');await page.getByRole('button',{name:'保存文件',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.workspace-editor'));assert.equal(files.get('demo.txt'),'updated');
 if(!mobile){await visible.getByLabel('上传工作区文件夹').setInputFiles(folder);await visible.locator('[data-name="project"]').waitFor();}
 await visible.locator('[data-name="docs"]').click({button:'right'});await page.getByRole('button',{name:'在此处打开终端',exact:true}).click();
 await visible.locator('.workspace-terminal-body .xterm').waitFor();assert.equal(connections[0],'docs');
 await panel.locator('.workspace-tab-actions').getByRole('button',{name:'⚙ 配置',exact:true}).click();
 await visible.getByLabel('随软件启动 Linux 环境').check();await visible.getByRole('button',{name:'保存工作区',exact:true}).click();await visible.locator('.workspace-saving .spinner-dot').waitFor();
 assert(await visible.getByRole('button',{name:'保存中…',exact:true}).isDisabled());releaseSave();await visible.locator('.workspace-saving').waitFor({state:'detached'});assert(config.autoStart);assert.equal(config.engine,'linux');
 saveFail=true;await visible.getByRole('button',{name:'保存工作区',exact:true}).click();await visible.getByRole('alert').filter({hasText:'保存失败'}).waitFor();assert(await visible.getByRole('button',{name:'保存工作区',exact:true}).isEnabled());saveFail=false;
 await visible.getByRole('button',{name:'启动环境',exact:true}).click();await visible.getByRole('button',{name:'停止运行',exact:true}).waitFor();
 await visible.getByRole('button',{name:'打开终端',exact:true}).click();await visible.locator('.xterm').waitFor();assert.equal(connections.length,2);
 await panel.locator('.workspace-tab-actions').getByRole('button',{name:'⚙ 配置',exact:true}).click();assert.equal(await panel.getByRole('tab').filter({hasText:'配置'}).count(),1);
 await panel.getByLabel('新建工作区标签').click();await page.getByRole('button',{name:'📁 文件管理',exact:true}).click();await visible.locator('[data-name="demo.txt"]').waitFor();
 const current=panel.getByRole('tab').filter({has:page.locator('[aria-selected="true"]')});
 const activeTab=panel.locator('[role="tab"][aria-selected="true"]');await activeTab.getByRole('button',{name:'固定标签',exact:true}).click();
 const widths=await panel.getByRole('tab').evaluateAll(tabs=>tabs.map(tab=>tab.getBoundingClientRect().width));assert(widths.every(width=>width===192),'Workspace tabs use fixed widths');
 if(!mobile){const tabs=panel.getByRole('tab');const firstId=await tabs.first().getAttribute('data-tab-id');await tabs.first().dragTo(tabs.last());assert.notEqual(await tabs.first().getAttribute('data-tab-id'),firstId);}
 const count=await panel.getByRole('tab').count();await page.reload();await panel.getByRole('tab').first().waitFor();assert.equal(await panel.getByRole('tab').count(),count);assert.equal(await panel.getByRole('button',{name:'取消固定标签',exact:true}).count(),1);
 await panel.getByRole('tab').filter({hasText:'配置'}).click();await visible.getByRole('button',{name:'卸载运行环境',exact:true}).click();await visible.getByRole('button',{name:'卸载并保留文件',exact:true}).click();await visible.getByRole('button',{name:'安装 Linux 工作区',exact:true}).waitFor();assert(files.has('demo.txt'));assert.equal(installedCalls,0);
 await visible.getByRole('button',{name:'安装 Linux 工作区',exact:true}).click();await visible.locator('.linux-progress').waitFor();assert.equal(installedCalls,1);
 await panel.getByRole('tab').filter({hasText:'文件管理'}).first().click();await visible.locator('[data-name="demo.txt"]').waitFor();
 const list=await visible.locator('.fm-list').boundingBox();assert(list.height>350,'File list fills the page');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal page overflow');assert.deepEqual(errors,[]);
 fs.mkdirSync('layout-screenshots',{recursive:true});await page.screenshot({path:'layout-screenshots/workspace-tabs-'+(mobile?'android':'windows')+'.png'});
 await page.close();
}console.log('PASS: Windows/Android file-first workspace, separate config tab, per-directory terminal tabs, persistent fixed tabs, folder picker, saving and runtime lifecycle');}finally{await browser.close();fs.rmSync(temp,{recursive:true,force:true});}
