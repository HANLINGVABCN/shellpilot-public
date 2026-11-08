import React,{useEffect,useState} from 'react';
import {api} from '../api.js';
import {ws} from '../ws.js';
export const workspaceSupported=()=>/Windows/i.test(navigator.userAgent);
export function WorkspaceSettings(){
 const [config,setConfig]=useState({directory:'',enabled:false,network:false}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const load=()=>api('/workspace').then(setConfig).catch(e=>setError(e.message));
 useEffect(()=>{if(workspaceSupported())load();return ws.on('workspace-changed',()=>{if(workspaceSupported())load();});},[]);
 if(!workspaceSupported())return null;
 const act=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
 return <><div className="sec-title">本机 AI 工作区</div><div className="card workspace-settings">
  <div className="workspace-directory"><input aria-label="工作区目录" placeholder="选择一个专门的文件夹" value={config.directory} onChange={e=>setConfig({...config,directory:e.target.value})}/><button className="btn" disabled={busy} onClick={()=>act(async()=>{const value=await api('/workspace/pick','POST',{});if(value.directory)setConfig({...config,directory:value.directory});})}>选择目录</button></div>
  <div className="memory-controls"><label className="memory-auto"><input type="checkbox" checked={config.enabled} onChange={e=>setConfig({...config,enabled:e.target.checked})}/>启用工作区</label><label className="memory-auto"><input type="checkbox" checked={config.network} onChange={e=>setConfig({...config,network:e.target.checked})}/>允许工作区联网</label><button className="btn primary" disabled={busy||!config.directory.trim()} onClick={()=>act(async()=>{await api('/workspace','PUT',config);await load();})}>保存工作区</button></div>
  <p className="memory-help">AI 在这个目录读写文件和运行命令。Windows AppContainer 限制工作区外的用户文件，程序安装和系统目录不授予写权限。</p>
  {error&&<p className="form-err" role="alert">{error}</p>}
 </div></>;
}
export default function WorkspacePanel({onClose,onSettings}){
 const [config,setConfig]=useState({}),[entries,setEntries]=useState([]),[path,setPath]=useState(''),[editing,setEditing]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=async()=>{const value=await api('/workspace');setConfig(value);if(value.enabled){const files=await api('/workspace/files?path='+encodeURIComponent(path));setEntries(files.entries||[]);}};
 useEffect(()=>{load().catch(e=>setError(e.message));const off=ws.on('workspace-changed',()=>load().catch(e=>setError(e.message)));return off;},[path]);
 const act=async fn=>{setBusy(true);setError('');try{await fn();await load();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const relative=name=>path?path+'/'+name:name;
 const download=name=>act(async()=>{const response=await fetch('/api/workspace/download?path='+encodeURIComponent(relative(name)));if(!response.ok)throw Error((await response.json()).error);const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
 return <section className="workspace-panel"><div className="workspace-heading"><strong>工作区</strong><span title={config.directory}>{path||config.directory||'未配置'}</span><button className="btn btn-sm" onClick={onSettings}>配置</button><button className="workspace-close" aria-label="关闭工作区列表" onClick={onClose}>×</button></div>
  {config.enabled?<><div className="workspace-tools"><button className="btn btn-sm" disabled={!path} onClick={()=>setPath(path.split('/').slice(0,-1).join('/'))}>上一级</button><button className="btn btn-sm" onClick={()=>act(load)}>刷新</button><label className="btn btn-sm workspace-upload">上传文件<input type="file" multiple disabled={busy} onChange={e=>{const chosen=[...e.target.files];e.target.value='';act(async()=>{const body=new FormData();chosen.forEach(file=>body.append('files',file));const response=await fetch('/api/workspace/upload?path='+encodeURIComponent(path),{method:'POST',body});const data=await response.json();if(!response.ok)throw Error(data.error);});}}/></label><button className="btn btn-sm" onClick={()=>setEditing({path:relative('new.txt'),content:'',sha256:'missing',newFile:true})}>新建文本</button></div>
  <div className="workspace-files">{entries.map(entry=><div className="workspace-file" key={entry.name}><button title={entry.name} onClick={()=>entry.directory?setPath(relative(entry.name)):act(async()=>{const value=await api('/workspace/action','POST',{name:'workspace_read',arguments:{path:relative(entry.name)}});setEditing(value);})}>{entry.directory?'📁':'📄'} {entry.name}</button>{!entry.directory&&<button className="btn btn-sm" onClick={()=>download(entry.name)}>下载</button>}</div>)}</div>
  {editing&&<div className="workspace-editor"><input aria-label="工作区文件名" value={editing.path} disabled={!editing.newFile} onChange={e=>setEditing({...editing,path:e.target.value})}/><textarea aria-label="工作区文件内容" value={editing.content} onChange={e=>setEditing({...editing,content:e.target.value})}/><div className="memory-controls"><button className="btn btn-sm" disabled={busy} onClick={()=>act(async()=>{await api('/workspace/action','POST',{name:'workspace_write',arguments:{path:editing.path,content:editing.content,expectedHash:editing.sha256}});setEditing(null);})}>保存文件</button><button className="btn btn-sm" onClick={()=>setEditing(null)}>取消</button></div></div>}
  </>:<p className="memory-help">在配置中选择本机工作区目录并启用，然后把文件放进去与 AI 协作。</p>}
  {error&&<p className="form-err" role="alert">{error}</p>}
 </section>;
}
