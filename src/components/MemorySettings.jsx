import React,{useEffect,useState} from 'react';
import {api} from '../api.js';
import {ws} from '../ws.js';

export default function MemorySettings({settings,onSave}){
  const [items,setItems]=useState([]),[filter,setFilter]=useState('enabled'),[search,setSearch]=useState('');
  const [selected,setSelected]=useState([]),[editing,setEditing]=useState(null),[deleting,setDeleting]=useState(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [autoEnabled,setAutoEnabled]=useState(settings.autoMemory!==false),[savingAuto,setSavingAuto]=useState(false);
  useEffect(()=>{if(!savingAuto)setAutoEnabled(settings.autoMemory!==false);},[settings.autoMemory,savingAuto]);
  const toggleAuto=async(enabled)=>{
    setAutoEnabled(enabled);setSavingAuto(true);setError('');
    const ok=await onSave({...settings,autoMemory:enabled});
    if(ok===false){setAutoEnabled(settings.autoMemory!==false);setError('自动记忆开关保存失败，请重试');}
    setSavingAuto(false);
  };
  const load=()=>api('/memories').then((data)=>{setItems(data.memories||[]);setSelected((ids)=>ids.filter((id)=>data.memories.some((memory)=>memory.id===id)));}).catch((error)=>setError(error.message));
  useEffect(()=>{load();return ws.on('memories-changed',load);},[]);
  const action=async(fn)=>{setBusy(true);setError('');try{await fn();await load();}catch(error){setError(error.message);await load();}finally{setBusy(false);}};
  const toggleParticipation=(memory,enabled)=>{setItems((items)=>items.map((item)=>item.id===memory.id?{...item,enabled}:item));action(()=>api(`/memories/${memory.id}`,'PUT',{enabled}));};
  const visible=items.filter((memory)=>(filter==='all'||(filter==='enabled'?memory.enabled!==false:memory.enabled===false)) && `${memory.topic} ${memory.content}`.toLowerCase().includes(search.toLowerCase()));
  const save=()=>action(async()=>{
    const result=await api(editing.id?`/memories/${editing.id}`:'/memories',editing.id?'PUT':'POST',editing);
    if(result.status==='duplicate'){setError('已有相同记忆，未重复添加。');return;}
    setEditing(null);
  });
  const batch=(enabled)=>action(async()=>{await api('/memories/batch','POST',{ids:selected,enabled});setSelected([]);});
  return <>
    <div className="sec-title">长期记忆</div>
    <div className="card memory-settings">
      <label className="memory-auto"><input type="checkbox" disabled={savingAuto} checked={autoEnabled} onChange={(event)=>toggleAuto(event.target.checked)}/><span>允许 AI 主动记住新内容</span></label>
      <p className="memory-help">这个开关只控制自动保存。已有记忆按每条「参与回答」开关使用，关闭自动记忆后仍然生效。</p>
      <div className="memory-controls"><input aria-label="搜索记忆" placeholder="搜索记忆" value={search} onChange={(event)=>setSearch(event.target.value)}/><select aria-label="记忆筛选" value={filter} onChange={(event)=>setFilter(event.target.value)}><option value="enabled">启用中</option><option value="disabled">已停用</option><option value="all">全部</option></select><button className="btn" onClick={()=>{setEditing({content:'',enabled:true});setError('');}}>添加记忆</button></div>
      {editing && <div className="memory-editor"><label>内容<textarea aria-label="记忆内容" rows={3} maxLength={2000} value={editing.content} onChange={(event)=>setEditing({...editing,content:event.target.value})} placeholder="例如：解释 Linux 命令时用简单的话"/></label><label className="memory-auto"><input type="checkbox" checked={editing.enabled!==false} onChange={(event)=>setEditing({...editing,enabled:event.target.checked})}/>参与回答</label><div className="memory-controls"><button className="btn" disabled={busy} onClick={()=>setEditing(null)}>取消编辑</button><button className="btn primary" disabled={busy||!editing.content.trim()} onClick={save}>保存记忆</button></div></div>}
      {selected.length>0 && <div className="memory-controls"><span>已选 {selected.length} 条</span><button className="btn btn-sm" disabled={busy} onClick={()=>batch(true)}>启用所选</button><button className="btn btn-sm" disabled={busy} onClick={()=>batch(false)}>停用所选</button><button className="btn btn-sm danger" disabled={busy} onClick={()=>setDeleting([...selected])}>删除所选记忆</button></div>}
      {deleting && <div className="chat-delete-confirm"><p>删除这 {deleting.length} 条记忆？删除后无法恢复。</p><div className="memory-controls"><button className="btn btn-sm" disabled={busy} onClick={()=>setDeleting(null)}>取消删除记忆</button><button className="btn btn-sm danger" disabled={busy} onClick={()=>action(async()=>{await api('/memories/batch','POST',{ids:deleting,action:'delete'});setDeleting(null);setSelected([]);})}>确认删除记忆</button></div></div>}
      {error && <div className="form-err" role="alert">{error}</div>}
      <div className="memory-list" role="list">{visible.length===0 && <p className="memory-help">没有符合筛选的记忆</p>}{visible.map((memory,index)=><article className={"memory-row"+(memory.enabled===false?" disabled":"")} key={memory.id} role="listitem"><input type="checkbox" aria-label={"选择记忆 "+(index+1)} disabled={busy} checked={selected.includes(memory.id)} onChange={event=>setSelected(ids=>event.target.checked?[...ids,memory.id]:ids.filter(id=>id!==memory.id))}/><button className="memory-edit" aria-label={"编辑记忆 "+(index+1)} disabled={busy} onClick={()=>{setEditing({...memory,expectedUpdatedAt:memory.updatedAt});setError("");}}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M10.5 2.5l3 3-7.5 7.5-3.5.5.5-3.5z"/></svg></button><button className="memory-content" title={memory.content} onClick={()=>{setEditing({...memory,expectedUpdatedAt:memory.updatedAt});setError("");}}>{memory.content}</button><button className={"memory-state"+(memory.enabled===false?"":" on")} aria-label={"参与回答 "+(index+1)} aria-pressed={memory.enabled!==false} disabled={busy} onClick={()=>toggleParticipation(memory,memory.enabled===false)}>{memory.enabled===false?"关闭中":"启用中"}</button></article>)}</div>
    </div>
  </>;
}
