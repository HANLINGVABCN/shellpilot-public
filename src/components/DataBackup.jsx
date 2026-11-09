import React,{useEffect,useRef,useState} from 'react';
import {api} from '../api.js';
import {fileToBase64} from '../binary.js';

const categories=[['hosts','服务器'],['providers','AI 提供商'],['chats','对话记录'],['memories','记忆']];
const empty=()=>Object.fromEntries(categories.map(([key])=>[key,false]));
const available=counts=>Object.fromEntries(categories.map(([key])=>[key,(counts[key]||0)>0]));

export default function DataBackup({onImported}){
  const [file,setFile]=useState(null),[password,setPassword]=useState(''),[exportPassword,setExportPassword]=useState('');
  const [preview,setPreview]=useState(null),[sections,setSections]=useState(empty),[hostIds,setHostIds]=useState(new Set()),[providerIds,setProviderIds]=useState(new Set());
  const [mode,setMode]=useState('merge'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState('');
  const dialog=useRef(null);
  useEffect(()=>{
    if(!preview)return;
    dialog.current?.focus();
    const key=event=>{if(event.key==='Escape'&&!busy)setPreview(null);if(event.key==='Tab'){
      const controls=[...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled)')];const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }};
    document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
  },[preview,busy]);
  const perform=async fn=>{setBusy(true);setError('');setDone('');try{await fn();}catch(error){setError(error.message);}finally{setBusy(false);}};
  const openExport=()=>perform(async()=>{
    const value=await api('/export/preview');setPreview({kind:'export',counts:value.counts});setSections(available(value.counts));
  });
  const openImport=()=>perform(async()=>{
    const data=await fileToBase64(file);const value=await api('/import/preview','POST',{password,data});
    setPreview({...value,kind:'import',data,password,fileName:file.name});setSections(empty());setMode('merge');
    setHostIds(new Set(value.hosts.map(host=>host.id)));setProviderIds(new Set(value.providers.map(provider=>provider.id)));
  });
  const allSelected=preview&&categories.every(([key])=>!preview.counts[key]||sections[key])
    &&(!sections.hosts||preview.kind==='export'||hostIds.size===preview.hosts.length)
    &&(!sections.providers||preview.kind==='export'||providerIds.size===preview.providers.length);
  const selectAll=()=>{
    setSections(allSelected?empty():available(preview.counts));
    if(preview.kind==='import'&&!allSelected){setHostIds(new Set(preview.hosts.map(host=>host.id)));setProviderIds(new Set(preview.providers.map(provider=>provider.id)));}
  };
  const selected=categories.filter(([key])=>sections[key]);
  const validSelection=selected.length>0&&(preview?.kind!=='import'||(!sections.hosts||hostIds.size>0)&&(!sections.providers||providerIds.size>0));
  const confirm=()=>perform(async()=>{
    if(preview.kind==='export'){
      if(!exportPassword)throw Error('请设置导出密码');
      const response=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:exportPassword,sections})});
      if(!response.ok)throw Error((await response.json()).error||'导出失败');
      const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');anchor.href=url;anchor.download='shellpilot-export-'+Date.now()+'.spex';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      setDone('已导出：'+selected.map(([,label])=>label).join('、'));setPreview(null);setExportPassword('');
    }else{
      await api('/import','POST',{password:preview.password,data:preview.data,sections,hostIds:[...hostIds],providerIds:[...providerIds],mode});
      setPreview(null);setDone('已导入：'+selected.map(([,label])=>label).join('、'));
      window.dispatchEvent(new Event('shellpilot-hosts-changed'));await onImported?.();
    }
  });
  const toggleItem=(id,setter,enabled)=>setter(previous=>{const next=new Set(previous);enabled?next.add(id):next.delete(id);return next;});
  return <>
    <div className="sec-title">数据导入 / 导出</div>
    <div className="card backup-card">
      <button className="btn" disabled={busy} onClick={openExport}>📤 导出数据</button>
      <div className="backup-import-row"><input type="file" aria-label="导入配置文件" accept=".spex" disabled={busy} onChange={event=>{setFile(event.target.files[0]||null);setError('');setDone('');}}/><input type="password" aria-label="导入密码" placeholder="导入密码" value={password} disabled={busy} onChange={event=>setPassword(event.target.value)}/><button className="btn" disabled={busy||!file||!password} onClick={openImport}>{busy&&!preview?'正在检测…':'📂 检测并选择'}</button></div>
      {!preview&&error&&<p className="form-err" role="alert">{error}</p>}
      {done&&<p className="backup-done" role="status">{done}</p>}
    </div>
    {preview&&<div className="overlay" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)setPreview(null);}}>
      <div className="modal import-modal backup-modal" role="dialog" aria-modal="true" aria-labelledby="backup-dialog-title" ref={dialog} tabIndex={-1}>
        <div className="backup-dialog-header"><div className="modal-title" id="backup-dialog-title">{preview.kind==='export'?'选择要导出的内容':'选择要导入的内容'}</div><button className="btn btn-sm" disabled={busy||!categories.some(([key])=>preview.counts[key]>0)} onClick={selectAll}>{allSelected?'取消全选':'全选'}</button></div>
        {preview.kind==='import'&&<p className="backup-file-name">{preview.fileName}</p>}
        <div className="backup-options">{categories.map(([key,label])=>{
          const count=preview.counts[key]||0;
          return <label key={key} className={'backup-option'+(!count?' unavailable':'')}><input type="checkbox" aria-label={label} checked={!!sections[key]} disabled={busy||!count} onChange={event=>setSections(previous=>({...previous,[key]:event.target.checked}))}/><span>{label}</span><small>{count?count+' '+(key==='memories'?'条':key==='chats'?'个对话':key==='hosts'?'台':'个'):preview.kind==='import'?'文件中没有':'暂无数据'}</small></label>;
        })}</div>
        {preview.kind==='export'?<div className="backup-password"><label htmlFor="backup-export-password">导出密码</label><input id="backup-export-password" type="password" value={exportPassword} autoComplete="new-password" disabled={busy} onChange={event=>setExportPassword(event.target.value)} placeholder="设置备份文件密码"/></div>:<>
          {(sections.hosts||sections.providers)&&<div className="import-cols">
            {sections.hosts&&<div className="import-col"><label className="import-col-head"><input type="checkbox" aria-label="全选服务器" disabled={busy} checked={hostIds.size===preview.hosts.length} onChange={event=>setHostIds(event.target.checked?new Set(preview.hosts.map(host=>host.id)):new Set())}/>服务器</label>{preview.hosts.map(host=><label className="import-item" key={host.id}><input type="checkbox" checked={hostIds.has(host.id)} disabled={busy} onChange={event=>toggleItem(host.id,setHostIds,event.target.checked)}/><span className="ii-name">{host.name}</span><span className="ii-sub">{host.username}@{host.host}:{host.port}</span></label>)}</div>}
            {sections.providers&&<div className="import-col"><label className="import-col-head"><input type="checkbox" aria-label="全选AI提供商" disabled={busy} checked={providerIds.size===preview.providers.length} onChange={event=>setProviderIds(event.target.checked?new Set(preview.providers.map(provider=>provider.id)):new Set())}/>AI 提供商</label>{preview.providers.map(provider=><label className="import-item" key={provider.id}><input type="checkbox" checked={providerIds.has(provider.id)} disabled={busy} onChange={event=>toggleItem(provider.id,setProviderIds,event.target.checked)}/><span className="ii-name">{provider.name}</span><span className="ii-sub">{provider.modelCount} 个模型</span></label>)}</div>}
          </div>}
          <div className="import-mode"><label><input type="radio" name="import-mode" disabled={busy} checked={mode==='merge'} onChange={()=>setMode('merge')}/><span><b>合并导入</b>，保留现有内容</span></label><label><input type="radio" name="import-mode" disabled={busy} checked={mode==='overwrite'} onChange={()=>setMode('overwrite')}/><span><b>覆盖所选类别</b>，未勾选的数据保留</span></label></div>
        </>}
        {error&&<p className="form-err" role="alert">{error}</p>}
        <div className="modal-actions"><button className="btn" disabled={busy} onClick={()=>setPreview(null)}>取消</button><button className="btn primary" disabled={busy||!validSelection||(preview.kind==='export'&&!exportPassword)} onClick={confirm}>{busy?<><span className="spinner-dot"/>{preview.kind==='export'?'正在导出…':'正在导入…'}</>:preview.kind==='export'?'确认导出':'确认导入'}</button></div>
      </div>
    </div>}
  </>;
}
