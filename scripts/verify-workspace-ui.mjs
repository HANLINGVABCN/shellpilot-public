import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const browser=await chromium.launch({executablePath:process.env.SHELLPILOT_CHROMIUM});
try{
 const page=await browser.newPage({locale:'zh-CN',viewport:{width:1200,height:850},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36'});
 let config={directory:'',enabled:false,network:false,supported:true},files=new Map([['input.txt','workspace fixture']]);
 let releaseSave;const saveGate=new Promise(resolve=>{releaseSave=resolve;});let saveFail=false;
 await page.addInitScript(()=>localStorage.setItem('shellpilot-last-view','settings'));
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),p=url.pathname;let value=[];
  if(p==='/api/settings')value={providers:[{id:'p',name:'Demo'}],models:[{id:'m',providerId:'p',name:'DemoModel'}],defaultModelId:'m',params:{}};
  if(p==='/api/agent/status')value={busy:false,queue:[],messages:[],approvals:[]};
  if(p==='/api/workspace'){
   if(request.method()==='PUT'){
    await saveGate;
    if(saveFail){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'工作区权限设置失败'})});return;}
    config=request.postDataJSON();
   }value=config;
  }
  if(p==='/api/workspace/pick')value={directory:'C:\\Workspace\\Demo'};
  if(p==='/api/workspace/files')value={entries:[...files.keys()].map(name=>({name,size:files.get(name).length,directory:false}))};
  if(p==='/api/workspace/action'){
   const {name,arguments:args}=request.postDataJSON();
   if(name==='workspace_read')value={path:args.path,content:files.get(args.path),sha256:'fixture-hash'};
   if(name==='workspace_write'){files.set(args.path,args.content);value={written:true};}
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('http://127.0.0.1:4173');
 await page.getByRole('button',{name:'选择目录',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="工作区目录"]').value==='C:\\Workspace\\Demo');
 await page.getByLabel('启用工作区',{exact:true}).check();
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/workspace')&&r.request().method()==='PUT');
 await page.getByRole('button',{name:'保存工作区',exact:true}).click();
 await page.getByRole('status').filter({hasText:'正在保存中，权限设置可能耗时较长，请稍候'}).waitFor();
 assert(await page.locator('.workspace-saving .spinner-dot').isVisible());
 assert(await page.getByRole('button',{name:'保存中…',exact:true}).isDisabled());
 releaseSave();await saved;
 await page.locator('.workspace-saving').waitFor({state:'detached'});
 saveFail=true;await page.getByRole('button',{name:'保存工作区',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'工作区权限设置失败'}).waitFor();
 assert.equal(await page.locator('.workspace-saving').count(),0);
 assert(await page.getByRole('button',{name:'保存工作区',exact:true}).isEnabled());saveFail=false;
 await page.getByRole('button',{name:'工作区',exact:true}).click();
 await page.getByRole('button',{name:'📄 input.txt',exact:true}).click();
 await page.getByLabel('工作区文件内容').fill('user and AI collaborate');
 await page.getByRole('button',{name:'保存文件',exact:true}).click();
 await page.getByRole('button',{name:'📄 input.txt',exact:true}).waitFor();
 assert.equal(files.get('input.txt'),'user and AI collaborate');
 await page.getByRole('button',{name:'新建文本',exact:true}).click();
 await page.getByLabel('工作区文件名').fill('answer.txt');
 await page.getByLabel('工作区文件内容').fill('generated file');
 await page.getByRole('button',{name:'保存文件',exact:true}).click();
 await page.getByRole('button',{name:'📄 answer.txt',exact:true}).waitFor();
 fs.mkdirSync('layout-screenshots',{recursive:true});
 await page.screenshot({path:'layout-screenshots/workspace-files.png'});
 await page.getByRole('button',{name:'关闭工作区列表',exact:true}).click();
 assert.equal(await page.locator('.workspace-panel').count(),0);
 console.log('PASS: workspace save shows spinner and explanation, failed save recovers controls, directory selection and file collaboration without dialogs');
}finally{await browser.close();}
