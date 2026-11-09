import {chromium} from 'playwright';import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.SHELLPILOT_CHROMIUM});
try{for(const mobile of [false,true]){
 const page=await browser.newPage({viewport:{width:mobile?390:1200,height:850},userAgent:mobile?'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/141 Mobile':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141'});
 let config={directory:mobile?'/workspace':'C:\\DemoWorkspace',enabled:true,network:false,autoStart:false,engine:'linux',supported:true};let runtime={phase:'installed',installed:true,available:true,running:false,total:10000000,received:10000000,version:'alpine-test'};const files=new Map([['demo.txt','initial']]);let installedCalls=0;
 page.on('dialog',()=>{throw Error('Unexpected dialog')});
 await page.addInitScript(()=>{localStorage.setItem('shellpilot-last-view','work');localStorage.setItem('shellpilot-l1','workspace');localStorage.setItem('shellpilot-chat-open','hidden');});
 await page.routeWebSocket('**/terminal/ws',socket=>{socket.onMessage(text=>socket.send('manual terminal response\r\n'));});
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url()),p=url.pathname,method=route.request().method();let value=[];
  if(p==='/api/settings')value={providers:[],models:[],params:{}};
  if(p==='/api/workspace'){if(method==='PUT')config=route.request().postDataJSON();value=config;}
  if(p==='/api/workspace/linux')value=runtime;
  if(p==='/api/workspace/linux/start'){runtime={...runtime,running:true};value={running:true};}
  if(p==='/api/workspace/linux/stop'){runtime={...runtime,running:false};value={stopped:true};}
  if(p==='/api/workspace/linux/uninstall'){runtime={...runtime,installed:false,phase:'not-installed'};value={uninstalled:true,filesPreserved:true};}
  if(p==='/api/workspace/linux/install'){installedCalls++;runtime={...runtime,phase:'downloading',received:1000};value={started:true};}
  if(p==='/api/workspace/files')value={entries:[...files.keys()].map(name=>({name,size:files.get(name).length,directory:false}))};
  if(p==='/api/workspace/action'){const {name,arguments:args}=route.request().postDataJSON();if(name==='workspace_read')value={path:args.path,content:files.get(args.path),sha256:'hash'};if(name==='workspace_write'){files.set(args.path,args.content);value={written:true};}}
  if(p==='/api/agent/status')value={busy:false,queue:[],approvals:[]};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('http://127.0.0.1:4173');
 await page.locator('.tabs').getByRole('button',{name:'📁 工作区',exact:true}).waitFor();
 assert.equal(await page.locator('.subtabs').count(),0,'Workspace has no server subtabs');assert.equal(await page.locator('.sidebar').getByText('本机工作区',{exact:true}).count(),0);
 await page.getByLabel('随软件启动 Linux 环境').check();await page.getByRole('button',{name:'保存工作区',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.workspace-saving')===null);assert(config.autoStart);
 await page.getByRole('button',{name:'启动环境',exact:true}).click();await page.getByRole('button',{name:'停止运行',exact:true}).waitFor();
 await page.getByRole('button',{name:'打开终端',exact:true}).click();await page.locator('.workspace-terminal-body .xterm').waitFor();await page.getByRole('button',{name:'关闭终端',exact:true}).click();
 await page.getByRole('button',{name:'📄 demo.txt',exact:true}).click();await page.getByLabel('工作区文件内容').fill('updated');await page.getByRole('button',{name:'保存文件',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.workspace-editor')===null);assert.equal(files.get('demo.txt'),'updated');
 await page.getByRole('button',{name:'卸载运行环境',exact:true}).click();await page.getByRole('button',{name:'卸载并保留文件',exact:true}).click();await page.getByRole('button',{name:'安装 Linux 工作区',exact:true}).waitFor();assert(files.has('demo.txt'));assert.equal(installedCalls,0);
 await page.getByRole('button',{name:'安装 Linux 工作区',exact:true}).click();await page.locator('.linux-progress').waitFor();assert.equal(installedCalls,1);
 await page.close();
}console.log('PASS: desktop/Android workspace big tab has no subtabs/left entry; startup toggle, inline terminal, file edit and uninstall preserving files; download begins only on install click');}finally{await browser.close();}
