import React, {useEffect, useRef, useState} from 'react';
import {api} from '../api.js';
import {ws} from '../ws.js';
import {collectWorkspaceDrop, workspaceSelection, workspaceUploadBody} from '../workspace-upload.js';

const full = (parent,name) => parent ? parent+'/'+name : name;
const size = entry => entry.directory ? '—' : entry.size<1024 ? entry.size+' B' : entry.size<1048576 ? (entry.size/1024).toFixed(1)+' KB' : (entry.size/1048576).toFixed(1)+' MB';
const time = value => value ? new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).replaceAll('/','-') : '—';
let clipboard = null;

export default function WorkspaceFiles({config,active,session,onPath,onConfigure,onOpenTerminal}) {
  const path = session.path||'';
  const [entries,setEntries] = useState([]), [input,setInput] = useState('/workspace/'+path), [selected,setSelected] = useState(new Set());
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [menu,setMenu] = useState(null), [prompt,setPrompt] = useState(null), [editing,setEditing] = useState(null);
  const [sort,setSort] = useState({key:'name',descending:false}), [drag,setDrag] = useState(false), [progress,setProgress] = useState(null), [clipVersion,setClipVersion] = useState(0);
  const uploadInput = useRef(null), folderInput = useRef(null), request = useRef(null), locked = useRef(false);
  const load = async (target=path) => {
    if(!config.enabled) return;
    const result = await api('/workspace/files?path='+encodeURIComponent(target));
    setEntries(result.entries||[]);setSelected(new Set());setInput('/workspace'+(target ? '/'+target : ''));if(target!==path) onPath(target);
  };
  useEffect(() => {setInput('/workspace'+(path ? '/'+path : ''));if(active&&config.enabled) load().catch(e=>setError(e.message));},[active,path,config.enabled,config.directory]);
  useEffect(() => {
    const click = event => {if(!event.target.closest('.fm-menu')) setMenu(null);};
    const changed = () => setClipVersion(value=>value+1);
    document.addEventListener('mousedown',click);window.addEventListener('shellpilot-workspace-clipboard',changed);
    const off = ws.on('workspace-files-changed',() => {if(active) load().catch(e=>setError(e.message));});
    return () => {off();document.removeEventListener('mousedown',click);window.removeEventListener('shellpilot-workspace-clipboard',changed);};
  },[active,path,config.enabled]);
  useEffect(() => () => request.current?.abort(),[]);
  const act = async (fn,refresh=true) => {
    if(locked.current) return;
    locked.current=true;setBusy(true);setError('');
    try {await fn();if(refresh) await load();} catch(e) {setError(e.message);await load().catch(()=>{});} finally {locked.current=false;setBusy(false);}
  };
  const action = (name,args) => api('/workspace/action','POST',{name,arguments:args});
  const navigate = target => act(() => load(target),false);
  const sorted = [...entries].sort((a,b) => {
    if(a.directory!==b.directory) return a.directory ? -1 : 1;
    const value = sort.key==='name' ? a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'}) : (a[sort.key]||0)-(b[sort.key]||0);
    return sort.descending ? -value : value;
  });
  const chosen = sorted.filter(entry=>selected.has(entry.name));
  const read = entry => act(async () => {const value=await action('workspace_read',{path:full(path,entry.name)});setEditing(value);});
  const download = entry => act(async () => {
    const filePath=full(path,entry.name);
    if(/Android/i.test(navigator.userAgent)) {await api('/workspace/user-download','POST',{path:filePath});return;}
    const response=await fetch('/api/workspace/download?path='+encodeURIComponent(filePath));
    if(!response.ok) throw Error((await response.json()).error);
    const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');anchor.href=url;anchor.download=entry.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  const upload = (selection,target=path) => act(async () => {
    const value=await selection;
    if(!value.files.length&&!value.directories.length) return;
    await new Promise((resolve,reject) => {
      const xhr = new XMLHttpRequest();request.current=xhr;
      xhr.open('POST','/api/workspace/upload?path='+encodeURIComponent(target));
      xhr.upload.onprogress = event => setProgress({percent:event.lengthComputable ? Math.floor(event.loaded/event.total*100) : 0,count:value.files.length});
      xhr.onload = () => {request.current=null;setProgress(null);let data;try {data=JSON.parse(xhr.responseText);} catch {reject(Error('上传响应无效'));return;}xhr.status>=200&&xhr.status<300 ? resolve(data) : reject(Error(data.error||'上传失败'));};
      xhr.onerror = () => {request.current=null;setProgress(null);reject(Error('上传中断，请刷新查看已保存的文件'));};
      xhr.onabort = () => {request.current=null;setProgress(null);reject(Error('已取消上传，已完成的文件保留'));};
      setProgress({percent:0,count:value.files.length});xhr.send(workspaceUploadBody(value));
    });
  });
  const drop = (event,target=path) => {
    if(!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();event.stopPropagation();setDrag(false);
    const selection=collectWorkspaceDrop(event.dataTransfer);upload(selection,target);
  };
  const copy = move => {clipboard={directory:config.directory,paths:chosen.map(entry=>full(path,entry.name)),move};window.dispatchEvent(new Event('shellpilot-workspace-clipboard'));};
  const paste = () => act(async () => {if(!clipboard||clipboard.directory!==config.directory) return;await action('workspace_copy',{paths:clipboard.paths,path,move:clipboard.move});if(clipboard.move) clipboard=null;window.dispatchEvent(new Event('shellpilot-workspace-clipboard'));});
  const newItem = directory => setPrompt({kind:directory?'directory':'file',name:directory?'新文件夹':'new.txt'});
  const submit = () => act(async () => {
    if(prompt.kind==='delete') {
      for(const entry of chosen) await action('workspace_delete',{path:full(path,entry.name),recursive:true});
    } else if(prompt.kind==='rename') {
      await action('workspace_rename',{path:full(path,prompt.original),to:full(path,prompt.name)});
    } else {
      await action(prompt.kind==='directory'?'workspace_mkdir':'workspace_write',{path:full(path,prompt.name),content:'',expectedHash:'missing'});
    }
    setPrompt(null);
  });
  const context = (event,entry) => {event.preventDefault();event.stopPropagation();if(entry&&!selected.has(entry.name)) setSelected(new Set([entry.name]));setMenu({x:Math.min(event.clientX,window.innerWidth-195),y:Math.min(event.clientY,window.innerHeight-245),entry});};
  return <div className="fm-wrap workspace-file-manager">
    <div className="fm-toolbar">
      <button className="btn btn-sm" title="上一级" disabled={busy||!path} onClick={()=>navigate(path.split('/').slice(0,-1).join('/'))}>↑</button>
      <button className="btn btn-sm" disabled={busy||!config.enabled} onClick={()=>act(()=>load())}>刷新</button>
      <input className="fm-path" aria-label="工作区路径" value={input} title={config.directory} disabled={busy} onChange={event=>setInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){const target=input==='/workspace'?'':input.startsWith('/workspace/')?input.slice(11):input;if(target.startsWith('/')) setError('请输入 /workspace 内的路径');else navigate(target);}}}/>
      <button className="btn btn-sm" disabled={busy||!config.enabled} onClick={()=>onOpenTerminal(path)}>&gt;_ 终端</button>
      <button className="btn btn-sm" onClick={onConfigure}>⚙ 配置</button>
    </div>
    {config.enabled ? <>
      <div className="fm-toolbar">
        <button className="btn btn-sm" disabled={busy} onClick={()=>newItem(true)}>＋ 文件夹</button>
        <button className="btn btn-sm" disabled={busy} onClick={()=>newItem(false)}>新建文本</button>
        <button className="btn btn-sm" disabled={busy} onClick={()=>uploadInput.current.click()}>上传文件</button>
        <button className="btn btn-sm" disabled={busy} onClick={()=>folderInput.current.click()}>上传文件夹</button>
        <input ref={uploadInput} type="file" multiple hidden aria-label="上传工作区文件" onChange={event=>{const selection=workspaceSelection(event.target.files);event.target.value='';upload(selection);}}/>
        <input ref={folderInput} type="file" multiple webkitdirectory="" directory="" hidden aria-label="上传工作区文件夹" onChange={event=>{const selection=workspaceSelection(event.target.files);event.target.value='';upload(selection);}}/>
        <button className="btn btn-sm" disabled={busy||!chosen.length} onClick={()=>copy(false)}>复制</button>
        <button className="btn btn-sm" disabled={busy||!chosen.length} onClick={()=>copy(true)}>剪切</button>
        <button className="btn btn-sm" disabled={busy||!clipboard||clipboard.directory!==config.directory} onClick={paste}>粘贴</button>
        <button className="btn btn-sm" disabled={busy||chosen.length!==1} onClick={()=>setPrompt({kind:'rename',original:chosen[0].name,name:chosen[0].name})}>重命名</button>
        <button className="btn btn-sm" disabled={busy||chosen.length!==1||chosen[0]?.directory} onClick={()=>download(chosen[0])}>下载</button>
        <button className="btn btn-sm danger" disabled={busy||!chosen.length} onClick={()=>setPrompt({kind:'delete'})}>删除</button>
      </div>
      {progress && <div className="fm-transfer-bar" role="status"><div className="fm-transfer-info"><span>上传 {progress.count} 个文件</span><span className="fm-transfer-speed">{progress.percent}%</span><button className="btn btn-sm" onClick={()=>request.current?.abort()}>取消</button></div><div className="fm-transfer-track"><div className="fm-transfer-fill" style={{width:progress.percent+'%'}}/></div></div>}
      {prompt && <div className="workspace-file-prompt">{prompt.kind==='delete' ? <span>删除选中的 {chosen.length} 项及其中内容？</span> : <input aria-label="文件或文件夹名称" autoFocus value={prompt.name} onChange={event=>setPrompt({...prompt,name:event.target.value})} onKeyDown={event=>{if(event.key==='Enter') submit();if(event.key==='Escape') setPrompt(null);}}/>}<button className="btn btn-sm" disabled={busy} onClick={submit}>{prompt.kind==='delete'?'删除':'保存'}</button><button className="btn btn-sm" disabled={busy} onClick={()=>setPrompt(null)}>取消</button></div>}
      {editing && <div className="workspace-editor"><div className="fm-editor-hdr"><strong>{editing.path}</strong><button className="btn btn-sm" disabled={busy} onClick={()=>act(async()=>{await action('workspace_write',{path:editing.path,content:editing.content,expectedHash:editing.sha256});setEditing(null);})}>保存文件</button><button className="btn btn-sm" onClick={()=>setEditing(null)}>取消</button></div><textarea aria-label="工作区文件内容" value={editing.content} onChange={event=>setEditing({...editing,content:event.target.value})}/></div>}
      <div className={'fm-list'+(drag?' drag':'')} onContextMenu={event=>context(event,null)} onDragOver={event=>{if(Array.from(event.dataTransfer.types).includes('Files')&&!busy){event.preventDefault();event.dataTransfer.dropEffect='copy';setDrag(true);}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget)) setDrag(false);}} onDrop={drop}>
        <div className="fm-row fm-head">{[['name','名称','fm-name'],['size','大小','fm-size'],['mtime','修改时间','fm-time']].map(([key,label,style])=><span key={key} className={style+' fm-sortable'} onClick={()=>setSort({key,descending:sort.key===key?!sort.descending:false})}>{label} {sort.key===key&&(sort.descending?'▼':'▲')}</span>)}</div>
        {busy&&!progress && <div className="fm-loading">处理中…</div>}
        {!busy&&!entries.length && <div className="fm-loading">空目录，可上传或拖入文件和文件夹</div>}
        {sorted.map(entry=><div key={entry.name} data-name={entry.name} className={'fm-row'+(selected.has(entry.name)?' on':'')} tabIndex={0}
          onClick={event=>setSelected(previous=>{const next=event.ctrlKey||event.metaKey?new Set(previous):new Set();next.has(entry.name)?next.delete(entry.name):next.add(entry.name);return next;})}
          onDoubleClick={()=>entry.directory?navigate(full(path,entry.name)):read(entry)} onKeyDown={event=>{if(event.key==='Enter') entry.directory?navigate(full(path,entry.name)):read(entry);}}
          onContextMenu={event=>context(event,entry)} onDrop={event=>drop(event,entry.directory?full(path,entry.name):path)}>
          <span className="fm-name" title={entry.name}>{entry.directory?'📁':'📄'} {entry.name}</span><span className="fm-size">{size(entry)}</span><span className="fm-time">{time(entry.mtime)}</span>
        </div>)}
      </div>
      <div className="workspace-file-status"><span>{entries.length} 项{selected.size?'，已选 '+selected.size+' 项':''}</span><span title={config.directory}>{config.directory}</span></div>
    </> : <div className="workspace-file-empty"><span>📁</span><p>选择目录并启用工作区</p><button className="btn primary" onClick={onConfigure}>⚙ 配置</button></div>}
    {error && <div className="fm-err" role="alert">{error}<button className="btn btn-sm" onClick={()=>act(()=>load())}>重试</button></div>}
    {menu && <div className="fm-menu" style={{left:menu.x,top:menu.y}} onMouseDown={event=>event.stopPropagation()}>
      <button className="fm-menu-item" onClick={()=>{const target=menu.entry?.directory?full(path,menu.entry.name):path;setMenu(null);onOpenTerminal(target);}}>在此处打开终端</button>
      {menu.entry && <button className="fm-menu-item" onClick={()=>{const entry=menu.entry;setMenu(null);entry.directory?navigate(full(path,entry.name)):read(entry);}}>打开</button>}
      <button className="fm-menu-item" onClick={()=>{setMenu(null);folderInput.current.click();}}>上传文件夹</button>
      <button className="fm-menu-item" onClick={()=>{setMenu(null);newItem(true);}}>新建文件夹</button>
      <button className="fm-menu-item" onClick={()=>{setMenu(null);onConfigure();}}>⚙ 配置</button>
    </div>}
  </div>;
}
