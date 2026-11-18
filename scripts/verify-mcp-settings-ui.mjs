import assert from 'node:assert/strict';import fs from 'node:fs';import {chromium} from 'playwright';
const browser=await chromium.launch({executablePath:process.env.SHELLPILOT_CHROMIUM});
const base=process.env.SHELLPILOT_PREVIEW_URL||'http://127.0.0.1:4173';fs.mkdirSync('layout-screenshots',{recursive:true});
try{for(const [mobile,width] of [[true,320],[true,393],[false,1100]]){
 const page=await browser.newPage({viewport:{width,height:850},hasTouch:mobile,userAgent:mobile?'Mozilla/5.0 (Linux; Android 14) Chrome/141 Mobile':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141'});
 const errors=[],tests=[],writes=[];let settings={providers:[],models:[],params:{},mcpEnabled:true,mcpReadOnly:true,mcpHostIds:['a']};
 const hosts=[{id:'a',name:'测试主机 A',host:'a.example.invalid'},{id:'b',name:'测试主机 B',host:'b.example.invalid'}];
 const config={supported:mobile?['http','sse']:['stdio','http','sse'],http:{type:'http',url:'http://127.0.0.1:3737/mcp',headers:{Authorization:'Bearer fixture-key'}},sse:{type:'sse',url:'http://127.0.0.1:3737/mcp/sse',headers:{Authorization:'Bearer fixture-key'}},stdio:{command:'C:\\Test App\\shellpilot-mcp.exe',args:['--mcp'],env:{SHELLPILOT_DATA:'C:\\Test Data'}}};
 await page.addInitScript(()=>{localStorage.setItem('shellpilot-last-view','settings');window.__copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.__copied.push(text)}});});
 page.on('pageerror',error=>errors.push(error.message));await page.routeWebSocket('**/ws',()=>{});
 await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;let data=[];if(p==='/api/settings'){if(route.request().method()==='PUT'){settings=route.request().postDataJSON();writes.push(settings);}data=settings;}if(p==='/api/mcp/config')data=config;if(p==='/api/hosts')data=hosts;if(p==='/api/agent/status')data={busy:false,messages:[],approvals:[]};if(p==='/api/mcp/test'){const transport=route.request().postDataJSON().transport;tests.push(transport);data={tools:9,protocolVersion:'2025-06-18',transport};}await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});});
 await page.goto(base);const card=page.locator('.mcp-card');await card.scrollIntoViewIfNeeded();
 assert.equal(await card.getByRole('tab',{name:'STDIO',exact:true}).isDisabled(),mobile);
 for(const transport of mobile?['HTTP','SSE']:['STDIO','HTTP','SSE']){
  await card.getByRole('tab',{name:transport,exact:true}).click();
  if(transport==='STDIO'){assert(await card.getByText(config.stdio.command,{exact:true}).isVisible());assert.equal(await card.getByText('连接地址',{exact:true}).count(),0);}
  else{
   assert(await card.getByText(transport==='HTTP'?config.http.url:config.sse.url,{exact:true}).isVisible());assert.equal(await card.getByLabel('MCP 连接密钥').getAttribute('type'),'password');
   await card.getByRole('button',{name:'复制地址',exact:true}).click();await page.waitForFunction(()=>window.__copied.length>0);assert.equal((await page.evaluate(()=>window.__copied)).at(-1),transport==='HTTP'?config.http.url:config.sse.url);
   await card.getByRole('button',{name:'复制认证头',exact:true}).click();assert.equal((await page.evaluate(()=>window.__copied)).at(-1),'Bearer fixture-key');
  }
  await card.getByRole('button',{name:'复制完整 JSON 配置',exact:true}).click();const copied=JSON.parse((await page.evaluate(()=>window.__copied)).at(-1));assert.deepEqual(copied.mcpServers.shellpilot,config[transport.toLowerCase()]);
  await card.getByRole('button',{name:'测试 MCP 连接',exact:true}).click();await card.getByRole('status').filter({hasText:'连接成功 · 9 个工具'}).waitFor();assert.equal(tests.at(-1),transport.toLowerCase());
 }
 await card.getByRole('checkbox').nth(1).click();await page.waitForFunction(()=>document.querySelectorAll('.mcp-hosts input')[1]?.checked);assert.deepEqual(writes.at(-1).mcpHostIds,['a','b']);await card.getByRole('combobox').selectOption('auto');await page.waitForFunction(()=>document.querySelector('.mcp-mode-field select').value==='auto');assert.equal(writes.at(-1).mcpApprovalMode,'auto');
 await card.getByRole('button',{name:'开启 MCP 接口',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.mcp-card .mcp-toggle').getAttribute('aria-pressed')==='false');assert.equal(settings.mcpEnabled,false);assert(await card.getByRole('button',{name:'测试 MCP 连接',exact:true}).isDisabled());
 const overflow=await card.evaluate(el=>{const box=el.getBoundingClientRect();return box.x>=0&&box.right<=innerWidth+1&&el.scrollWidth<=el.clientWidth+1;});assert(overflow,'MCP settings overflow narrow device');
 await page.screenshot({path:`layout-screenshots/mcp-types-${mobile?'android':'windows'}-${width}.png`});assert.deepEqual(errors,[]);await page.close();console.log(`PASS: ${mobile?'Android':'Windows'} ${width}px three transport picker, URL/headers/config copy, real test selection and permissions`);
}}finally{await browser.close();}
