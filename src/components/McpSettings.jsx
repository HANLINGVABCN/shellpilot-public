import React,{useEffect,useState} from 'react';
import {api} from '../api.js';
import {isAndroidDevice} from '../android.js';

const types=[['stdio','STDIO'],['http','HTTP'],['sse','SSE']];
export default function McpSettings({settings,onSave}){
  const android=isAndroidDevice();
  const [transport,setTransport]=useState(android?'http':'stdio');
  const [config,setConfig]=useState(null),[hosts,setHosts]=useState([]),[error,setError]=useState('');
  const [copied,setCopied]=useState(''),[testing,setTesting]=useState(false),[result,setResult]=useState('');
  const load=()=>api('/mcp/config?transport=all').then(value=>{setConfig(value.command?{stdio:value,supported:android?['http','sse']:['stdio','http','sse']}:value);setError('');}).catch(error=>setError(error.message));
  useEffect(()=>{load();api('/hosts').then(setHosts).catch(()=>{});},[]);
  useEffect(()=>{load();if(!android||!settings.mcpEnabled)return;const timer=setInterval(load,5000);return()=>clearInterval(timer);},[settings.mcpEnabled]);
  const selected=config?.[transport];
  const copy=async(text,name)=>{try{await navigator.clipboard.writeText(text);setCopied(name);setTimeout(()=>setCopied(''),2000);}catch{setError('复制失败，请手动复制配置');}};
  const test=async()=>{setTesting(true);setResult('正在测试…');try{const value=await api('/mcp/test','POST',{transport},{timeoutMs:20000});setResult(`连接成功 · ${value.tools} 个工具 · ${value.protocolVersion}`);}catch(error){setResult(error.message);}finally{setTesting(false);}};
  const changeType=value=>{setTransport(value);setResult('');setCopied('');};
  const jsonConfig=JSON.stringify({mcpServers:{shellpilot:selected}},null,2);
  const toml=transport==='stdio'?`[mcp_servers.shellpilot]\ncommand = ${JSON.stringify(selected?.command||'')}\nargs = ["--mcp"]\n\n[mcp_servers.shellpilot.env]\nSHELLPILOT_DATA = ${JSON.stringify(selected?.env?.SHELLPILOT_DATA||'')}\n`:`[mcp_servers.shellpilot]\nurl = ${JSON.stringify(selected?.url||'')}\nhttp_headers = { Authorization = ${JSON.stringify(selected?.headers?.Authorization||'')} }\n`;
  return <>
    <div className="sec-title">外部 Agent 联动 (MCP)</div>
    <div className="tip-line">其他 AI 客户端可以调用 ShellPilot 的服务器工具。HTTP 和 SSE 连接当前设备，电脑还可使用 STDIO。</div>
    <div className="mcp-card">
      <div className="mcp-header"><div className="mcp-title"><span>外部 Agent 接口</span><span className={'mcp-badge'+(settings.mcpEnabled?'':' off')}>{settings.mcpEnabled?'● 接口已开启':'○ 已关闭'}</span></div>
        <button type="button" className={'mcp-toggle'+(settings.mcpEnabled?' on':'')} aria-label="开启 MCP 接口" aria-pressed={!!settings.mcpEnabled} onClick={()=>onSave({...settings,mcpEnabled:!settings.mcpEnabled})}><div className="mcp-toggle-knob"/></button>
      </div>
      <div className="mcp-tabs" role="tablist" aria-label="MCP 传输类型">
        {types.map(([id,label])=><button type="button" key={id} role="tab" aria-selected={id===transport} disabled={android&&id==='stdio'} className={'mcp-tab-btn'+(id===transport?' active':'')} onClick={()=>changeType(id)}>{label}</button>)}
      </div>
      {android&&<div className="menu-note">手机使用 HTTP 或 SSE。开启后，通知栏的 MCP 服务维持后台连接。</div>}
      {android&&settings.mcpEnabled&&config?.backgroundActive===false&&<div className="menu-note">MCP 后台服务尚未启动，可重新关闭再开启接口。</div>}
      <div className="mcp-body">
        {transport==='http'&&<div className="menu-note">HTTP：新版 Streamable HTTP 接入。</div>}
        {transport==='sse'&&<div className="menu-note">SSE：兼容旧版 HTTP + SSE 客户端。</div>}
        {transport==='stdio'?<>
          <div className="mcp-field-row"><span className="mcp-field-label">启动命令</span><code className="mcp-field-val">{selected?.command||'正在获取…'}</code><button className="btn btn-sm" disabled={!selected?.command} onClick={()=>copy(selected.command,'command')}>{copied==='command'?'✓ 已复制':'复制'}</button></div>
          <div className="mcp-field-row"><span className="mcp-field-label">参数</span><code className="mcp-field-val">--mcp</code><button className="btn btn-sm" onClick={()=>copy('--mcp','args')}>{copied==='args'?'✓ 已复制':'复制'}</button></div>
        </>:<>
          <div className="mcp-field-row"><span className="mcp-field-label">连接地址</span><code className="mcp-field-val">{selected?.url||'正在获取…'}</code><button className="btn btn-sm" disabled={!selected?.url} onClick={()=>copy(selected.url,'url')}>{copied==='url'?'✓ 已复制':'复制地址'}</button></div>
          <div className="mcp-field-row"><span className="mcp-field-label">连接密钥</span><input className="mcp-secret" type="password" readOnly aria-label="MCP 连接密钥" value={selected?.headers?.Authorization?.replace(/^Bearer /,'')||''}/><button className="btn btn-sm" disabled={!selected?.headers?.Authorization} onClick={()=>copy(selected.headers.Authorization,'header')}>{copied==='header'?'✓ 已复制':'复制认证头'}</button></div>
        </>}
        <div className="mcp-copy-actions"><button className="btn btn-sm" disabled={!selected} onClick={()=>copy(jsonConfig,'json')}>{copied==='json'?'✓ 已复制完整配置':'复制完整 JSON 配置'}</button>{transport!=='sse'&&<button className="btn btn-sm" disabled={!selected} onClick={()=>copy(toml,'toml')}>{copied==='toml'?'✓ 已复制':'复制 Codex TOML 配置'}</button>}</div>
        {error&&<p className="form-err" role="alert">{error}</p>}
        <div className="mcp-opts"><label className="mcp-mode-field"><span>MCP 执行模式</span><select value={settings.mcpReadOnly?'readonly':settings.mcpApprovalMode||'ask'} onChange={e=>onSave({...settings,mcpReadOnly:e.target.value==='readonly',mcpApprovalMode:e.target.value==='readonly'?'ask':e.target.value})}><option value="readonly">只读查询</option><option value="ask">主窗口人工审批</option><option value="ai">AI 审批</option><option value="auto">自动执行（高风险仍拦截）</option><option value="full">完全托管（所有命令直接执行）</option></select></label>
          <button className="btn btn-sm" disabled={!settings.mcpEnabled||testing||!selected} onClick={test}>测试 MCP 连接</button><span role="status">{result}</span>
        </div>
        <label>允许外部 AI 操作的机器</label><div className="mcp-hosts">{hosts.map(host=><label key={host.id}><input type="checkbox" checked={!Array.isArray(settings.mcpHostIds)||settings.mcpHostIds.includes(host.id)} onChange={e=>{const ids=Array.isArray(settings.mcpHostIds)?settings.mcpHostIds:hosts.map(h=>h.id);onSave({...settings,mcpHostIds:e.target.checked?[...ids,host.id]:ids.filter(id=>id!==host.id)});}}/><span title={host.name}>{host.name}</span></label>)}</div>
        <div className="menu-note">三种接入使用相同机器范围和执行模式。需要人工审批时保持应用界面可用。</div>
      </div>
    </div>
  </>;
}
