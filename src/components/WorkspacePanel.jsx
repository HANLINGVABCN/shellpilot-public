import React,{useEffect,useState} from 'react';
import {api} from '../api.js';
import {ws} from '../ws.js';
import WorkspaceTerminal from './WorkspaceTerminal.jsx';
export const workspaceSupported=()=>/Windows|Android/i.test(navigator.userAgent);
const phaseLabels={'not-installed':'未安装',downloading:'正在下载',verifying:'正在校验',extracting:'正在解压',installed:'已安装',paused:'已暂停',failed:'安装失败','confirm-installation':'等待安卓安装确认'};
export function LinuxRuntimeSettings({onTerminal}){
 const [state,setState]=useState({phase:'not-installed'}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirmUninstall,setConfirmUninstall]=useState(false);
 const load=()=>api('/workspace/linux','GET',undefined,{timeoutMs:10000}).then(setState).catch(e=>setError(e.message));
 useEffect(()=>{load();const off=ws.on('linux-install-state',()=>load());const timer=setInterval(load,2500);return()=>{off();clearInterval(timer);};},[]);
 const action=async path=>{setBusy(true);setError('');try{await api('/workspace/linux/'+path,'POST',{});await load();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const installing=['downloading','verifying','extracting','confirm-installation'].includes(state.phase);
 const received=Number(state.received)||0,total=Number(state.total)||0;
 return <div className="card linux-runtime"><div className="workspace-heading"><strong>Linux 环境</strong><span>{state.running?'运行中':phaseLabels[state.phase]||state.phase} {state.version||''}</span></div>
  <p className="memory-help">首次安装才下载 Alpine 和运行组件。普通更新继续使用已有环境，工作文件保持在工作区中。</p>
  {installing&&<div className="linux-progress" role="status"><span className="spinner-dot" aria-hidden="true"/>{phaseLabels[state.phase]} {received.toLocaleString('en-US')}/{total.toLocaleString('en-US')}B{total>0&&<progress value={received} max={total}/>}</div>}
  <div className="memory-controls">{!state.installed&&<button className="btn primary" disabled={busy||installing||state.available===false} onClick={()=>action('install')}>{state.phase==='paused'||state.phase==='failed'?'继续安装':'安装 Linux 工作区'}</button>}
   {installing&&<button className="btn" disabled={busy} onClick={()=>action('pause')}>暂停安装</button>}
   {state.installed&&<><button className="btn" disabled={busy} onClick={()=>action(state.running?'stop':'start')}>{state.running?'停止运行':'启动环境'}</button>{onTerminal&&<button className="btn" disabled={busy} onClick={onTerminal}>打开终端</button>}<button className="btn danger" disabled={busy} onClick={()=>setConfirmUninstall(true)}>卸载运行环境</button></>}
  </div>
  {confirmUninstall&&<div className="workspace-uninstall"><p>卸载 Linux 运行环境，保留工作文件。需要时可重新安装。</p><div className="memory-controls"><button className="btn" onClick={()=>setConfirmUninstall(false)}>取消</button><button className="btn danger" disabled={busy} onClick={async()=>{await action('uninstall');setConfirmUninstall(false);}}>卸载并保留文件</button></div></div>}
  {(error||state.error)&&<p className="form-err" role="alert">{error||state.error}</p>}
 </div>;
}
export function WorkspaceSettings({onTerminal}){
 const [config,setConfig]=useState({directory:/Android/i.test(navigator.userAgent)?'/workspace':'',enabled:false,network:false,autoStart:false,engine:/Android/i.test(navigator.userAgent)?'linux':'native'}),[busy,setBusy]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
 const load=()=>api('/workspace','GET',undefined,{timeoutMs:10000}).then(value=>{setConfig(value);setLoaded(true);setError('');}).catch(e=>setError(e.message));
 useEffect(()=>{if(workspaceSupported())load();return ws.on('workspace-changed',()=>{if(workspaceSupported())load();});},[]);
 if(!workspaceSupported())return null;
 const act=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const save=async()=>{setSaving(true);try{await act(async()=>{await api('/workspace','PUT',config,{timeoutMs:60000});await load();});}finally{setSaving(false);}};
 return <><div className="sec-title">本机 AI 工作区</div><div className="card workspace-settings">
  {/Windows/i.test(navigator.userAgent)?<div className="workspace-directory"><input aria-label="工作区目录" disabled={busy||!loaded} placeholder="选择一个专门的文件夹" value={config.directory} onChange={e=>setConfig({...config,directory:e.target.value})}/><button className="btn" disabled={busy||!loaded} onClick={()=>act(async()=>{const value=await api('/workspace/pick','POST',{});if(value.directory)setConfig({...config,directory:value.directory});})}>选择目录</button></div>:<p className="memory-help">文件放在手机本机工作区。可从下方上传，也可下载导出到其他应用。</p>}
  {/Windows/i.test(navigator.userAgent)&&<label className="workspace-engine">运行环境<select aria-label="工作区运行环境" value={config.engine||'native'} disabled={busy} onChange={e=>setConfig({...config,engine:e.target.value})}><option value="native">Windows PowerShell</option><option value="linux">内置 Alpine Linux</option></select></label>}
  <div className="memory-controls"><label className="memory-auto"><input type="checkbox" disabled={busy||!loaded} checked={config.enabled} onChange={e=>setConfig({...config,enabled:e.target.checked})}/>启用工作区</label><label className="memory-auto"><input type="checkbox" disabled={busy||!loaded} checked={config.network} onChange={e=>setConfig({...config,network:e.target.checked})}/>允许工作区联网</label><button className="btn primary" aria-busy={saving} disabled={busy||!loaded||!config.directory.trim()} onClick={save}>{saving?'保存中…':'保存工作区'}</button></div>
  {saving&&<p className="workspace-saving" role="status"><span className="spinner-dot" aria-hidden="true"/>正在保存中，权限设置可能耗时较长，请稍候</p>}
  <label className="memory-auto"><input type="checkbox" disabled={busy||!loaded} checked={!!config.autoStart} onChange={e=>setConfig({...config,autoStart:e.target.checked})}/>随软件启动 Linux 环境</label>
  <p className="memory-help">AI 可在工作区处理文件、运行命令，再上传到你授权的服务器。安装和卸载运行环境由你操作。</p>
  {error&&<p className="form-err" role="alert">{error}{!loaded&&<button className="btn btn-sm" onClick={load}>重新读取工作区</button>}</p>}
 </div><LinuxRuntimeSettings onTerminal={onTerminal}/></>;
}
export default function WorkspacePanel({onClose,onSettings,fullPage=false}){
 const [config,setConfig]=useState({}),[entries,setEntries]=useState([]),[path,setPath]=useState(''),[editing,setEditing]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [terminal,setTerminal]=useState(false);
 const load=async()=>{const value=await api('/workspace');setConfig(value);if(value.enabled){const files=await api('/workspace/files?path='+encodeURIComponent(path));setEntries(files.entries||[]);}};
 useEffect(()=>{load().catch(e=>setError(e.message));const off=ws.on('workspace-changed',()=>load().catch(e=>setError(e.message)));return off;},[path]);
 const act=async fn=>{setBusy(true);setError('');try{await fn();await load();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const relative=name=>path?path+'/'+name:name;
 const download=name=>act(async()=>{const response=await fetch('/api/workspace/download?path='+encodeURIComponent(relative(name)));if(!response.ok)throw Error((await response.json()).error);const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
 const upload=chosen=>act(async()=>{const body=new FormData();chosen.forEach(file=>body.append('files',file));const response=await fetch('/api/workspace/upload?path='+encodeURIComponent(path),{method:'POST',body});const data=await response.json();if(!response.ok)throw Error(data.error);});
 return <section className={'workspace-panel'+(fullPage?' workspace-page':'')} onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}} onDrop={event=>{if(event.dataTransfer.files.length){event.preventDefault();event.stopPropagation();upload([...event.dataTransfer.files]);}}}><div className="workspace-heading"><strong>工作区</strong><span title={config.directory}>{path||config.directory||'未配置'}</span>{!fullPage&&<><button className="btn btn-sm" onClick={onSettings}>配置</button><button className="workspace-close" aria-label="关闭工作区列表" onClick={onClose}>×</button></>}</div>
  {fullPage&&<div className="workspace-page-settings"><WorkspaceSettings onTerminal={()=>setTerminal(true)}/></div>}
  {terminal&&<WorkspaceTerminal onClose={()=>{setTerminal(false);setTimeout(()=>load().catch(e=>setError(e.message)),500);}}/>}
  {config.enabled?<><div className="workspace-tools"><button className="btn btn-sm" disabled={!path} onClick={()=>setPath(path.split('/').slice(0,-1).join('/'))}>上一级</button><button className="btn btn-sm" onClick={()=>act(load)}>刷新</button><label className="btn btn-sm workspace-upload">上传文件<input type="file" multiple disabled={busy} onChange={e=>{const chosen=[...e.target.files];e.target.value='';act(async()=>{const body=new FormData();chosen.forEach(file=>body.append('files',file));const response=await fetch('/api/workspace/upload?path='+encodeURIComponent(path),{method:'POST',body});const data=await response.json();if(!response.ok)throw Error(data.error);});}}/></label><button className="btn btn-sm" onClick={()=>setEditing({path:relative('new.txt'),content:'',sha256:'missing',newFile:true})}>新建文本</button></div>
  <div className="workspace-files">{entries.length===0&&<p className="memory-help">把文件拖到这里或点击上传，再让 AI 处理。</p>}{entries.map(entry=><div className="workspace-file" key={entry.name}><button title={entry.name} onClick={()=>entry.directory?setPath(relative(entry.name)):act(async()=>{const value=await api('/workspace/action','POST',{name:'workspace_read',arguments:{path:relative(entry.name)}});setEditing(value);})}>{entry.directory?'📁':'📄'} {entry.name}</button>{!entry.directory&&<button className="btn btn-sm" onClick={()=>download(entry.name)}>下载</button>}</div>)}</div>
  {editing&&<div className="workspace-editor"><input aria-label="工作区文件名" value={editing.path} disabled={!editing.newFile} onChange={e=>setEditing({...editing,path:e.target.value})}/><textarea aria-label="工作区文件内容" value={editing.content} onChange={e=>setEditing({...editing,content:e.target.value})}/><div className="memory-controls"><button className="btn btn-sm" disabled={busy} onClick={()=>act(async()=>{await api('/workspace/action','POST',{name:'workspace_write',arguments:{path:editing.path,content:editing.content,expectedHash:editing.sha256}});setEditing(null);})}>保存文件</button><button className="btn btn-sm" onClick={()=>setEditing(null)}>取消</button></div></div>}
  </>:<p className="memory-help">在配置中选择本机工作区目录并启用，然后把文件放进去与 AI 协作。</p>}
  {error&&<p className="form-err" role="alert">{error}</p>}
 </section>;
}
