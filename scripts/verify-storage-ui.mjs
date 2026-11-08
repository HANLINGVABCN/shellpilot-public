import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const browser=await chromium.launch({executablePath:process.env.SHELLPILOT_CHROMIUM});
const page=await browser.newPage({locale:'zh-CN',viewport:{width:1040,height:720}});
let failed=true;
await page.route('**/api/**',async route=>{
 const path=new URL(route.request().url()).pathname;
 let value=[],status=200;
 if(path==='/api/storage/status')value={error:failed?'读取 hosts.json 失败：访问被拒绝':null};
 else if(path==='/api/storage/retry'){failed=false;value={ok:true};}
 else if(failed){value={storageError:true,error:'读取 hosts.json 失败：访问被拒绝'};status=503;}
 else if(path==='/api/hosts')value=[{id:'a',name:'演示主机 A',host:'alpha.example.com',username:'demo'}];
 else if(path==='/api/settings')value={providers:[],models:[],params:{}};
 else if(path==='/api/agent/status')value={busy:false,messages:[],queue:[],approvals:[]};
 await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
});
try{
 await page.goto('http://127.0.0.1:4173');
 await page.getByText('读取本机数据失败',{exact:true}).waitFor();
 assert.equal(await page.getByText('还没有服务器',{exact:false}).count(),0);
 assert(await page.getByRole('button',{name:'＋ 添加服务器',exact:true}).isDisabled());
 await page.getByRole('button',{name:'重新读取',exact:true}).click();
 await page.getByText('演示主机 A',{exact:true}).first().waitFor();
 assert.equal(await page.getByText('读取本机数据失败',{exact:true}).count(),0);
 fs.mkdirSync('layout-screenshots',{recursive:true});
 await page.screenshot({path:'layout-screenshots/storage-recovered.png'});
 console.log('PASS: data failure stays in-page, never looks like a fresh empty account, and recovers without a dialog');
}finally{await browser.close();}
