import React, {useEffect, useRef, useState} from 'react';
import {api} from '../api.js';
import {ws} from '../ws.js';
import {PinIcon} from '../icons.jsx';
import WorkspaceTerminal from './WorkspaceTerminal.jsx';
import WorkspaceFiles from './WorkspaceFiles.jsx';

export const workspaceSupported = () => /Windows|Android/i.test(navigator.userAgent);
const phases = {'not-installed':'未安装', downloading:'正在下载', verifying:'正在校验', extracting:'正在解压', installed:'已安装', paused:'已暂停', failed:'安装失败', 'confirm-installation':'等待安卓安装确认'};
const storageKey = 'shellpilot-workspace-tabs';
const fresh = type => ({id:crypto.randomUUID(), type, path:'', pinned:false});
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    const ids = new Set();
    const tabs = (saved?.tabs || []).filter(tab => tab?.id && ['files','terminal','config'].includes(tab.type) && !ids.has(tab.id) && ids.add(tab.id))
      .map(tab => ({...tab, path:typeof tab.path === 'string' ? tab.path : '', pinned:!!tab.pinned}));
    if (tabs.length) return {tabs, active:tabs.some(tab => tab.id === saved.active) ? saved.active : tabs[0].id};
  } catch {}
  const first = fresh('files');
  return {tabs:[first], active:first.id};
}

export function LinuxRuntimeSettings({onTerminal}) {
  const [state,setState] = useState({phase:'not-installed'}), [error,setError] = useState(''), [busy,setBusy] = useState(false), [confirmUninstall,setConfirmUninstall] = useState(false);
  const load = () => api('/workspace/linux','GET',undefined,{timeoutMs:10000}).then(value => {setState(value);setError('');}).catch(e => setError(e.message));
  useEffect(() => {load();const off = ws.on('linux-install-state',load);const timer = setInterval(load,2500);return () => {off();clearInterval(timer);};},[]);
  const action = async path => {setBusy(true);setError('');try {await api('/workspace/linux/'+path,'POST',{});await load();} catch(e) {setError(e.message);} finally {setBusy(false);}};
  const installing = ['downloading','verifying','extracting'].includes(state.phase);
  const received = Number(state.received)||0, total = Number(state.total)||0;
  return <div className="card linux-runtime">
    <div className="workspace-heading"><strong>Alpine Linux</strong><span>{state.running ? '运行中' : phases[state.phase]||state.phase} {state.version||''}</span></div>
    {installing && <div className="linux-progress" role="status"><span className="spinner-dot" aria-hidden="true"/>{phases[state.phase]} {received.toLocaleString('en-US')}/{total.toLocaleString('en-US')}B{total>0 && <progress value={received} max={total}/>}</div>}
    <div className="memory-controls">
      {!state.installed && <button className="btn primary" disabled={busy||installing||state.available===false} onClick={() => action('install')}>{state.phase==='confirm-installation' ? '完成安装' : ['paused','failed'].includes(state.phase) ? '继续安装' : '安装 Linux 工作区'}</button>}
      {installing && <button className="btn" disabled={busy} onClick={() => action('pause')}>暂停安装</button>}
      {state.installed && <><button className="btn" disabled={busy} onClick={() => action(state.running ? 'stop' : 'start')}>{state.running ? '停止运行' : '启动环境'}</button>{onTerminal && <button className="btn" disabled={busy} onClick={onTerminal}>打开终端</button>}<button className="btn danger" disabled={busy} onClick={() => setConfirmUninstall(true)}>卸载运行环境</button></>}
    </div>
    {confirmUninstall && <div className="workspace-uninstall"><p>卸载 Linux 运行环境，保留工作文件。</p><div className="memory-controls"><button className="btn" onClick={() => setConfirmUninstall(false)}>取消</button><button className="btn danger" disabled={busy} onClick={async () => {await action('uninstall');setConfirmUninstall(false);}}>卸载并保留文件</button></div></div>}
    {(error||state.error) && <p className="form-err" role="alert">{error||state.error}</p>}
  </div>;
}

export function WorkspaceSettings({onTerminal}) {
  const android = /Android/i.test(navigator.userAgent);
  const [config,setConfig] = useState({directory:android ? '/workspace' : '',enabled:false,network:false,autoStart:false,engine:'linux'});
  const [busy,setBusy] = useState(false), [saving,setSaving] = useState(false), [error,setError] = useState(''), [loaded,setLoaded] = useState(false);
  const load = () => api('/workspace','GET',undefined,{timeoutMs:10000}).then(value => {setConfig({...value,engine:'linux'});setLoaded(true);setError('');}).catch(e => setError(e.message));
  useEffect(() => {if(workspaceSupported()) load();return ws.on('workspace-changed',() => {if(workspaceSupported()) load();});},[]);
  const act = async fn => {setBusy(true);setError('');try {await fn();} catch(e) {setError(e.message);} finally {setBusy(false);}};
  const save = async () => {setSaving(true);try {await act(async () => {await api('/workspace','PUT',{...config,engine:'linux'},{timeoutMs:60000});await load();});} finally {setSaving(false);}};
  if(!workspaceSupported()) return null;
  return <div className="workspace-configuration">
    <div className="sec-title">工作区配置</div>
    <div className="card workspace-settings">
      <label className="workspace-field-label">工作区目录</label>
      {!android ? <div className="workspace-directory"><input aria-label="工作区目录" disabled={busy||!loaded} placeholder="选择一个专门的文件夹" value={config.directory} onChange={e => setConfig({...config,directory:e.target.value})}/><button className="btn" disabled={busy||!loaded} onClick={() => act(async () => {const value = await api('/workspace/pick','POST',{});if(value.directory) setConfig({...config,directory:value.directory});})}>选择目录</button></div> : <p className="memory-help">手机本机工作区 /workspace</p>}
      <div className="workspace-options">
        <label className="memory-auto"><input type="checkbox" disabled={busy||!loaded} checked={config.enabled} onChange={e => setConfig({...config,enabled:e.target.checked})}/>启用工作区</label>
        <label className="memory-auto"><input type="checkbox" disabled={busy||!loaded} checked={config.network} onChange={e => setConfig({...config,network:e.target.checked})}/>允许工作区联网</label>
        <label className="memory-auto"><input type="checkbox" disabled={busy||!loaded} checked={!!config.autoStart} onChange={e => setConfig({...config,autoStart:e.target.checked})}/>随软件启动 Linux 环境</label>
      </div>
      <button className="btn primary" aria-busy={saving} disabled={busy||!loaded||(!android&&!config.directory.trim())} onClick={save}>{saving ? '保存中…' : '保存工作区'}</button>
      {saving && <p className="workspace-saving" role="status"><span className="spinner-dot" aria-hidden="true"/>正在保存中，权限设置可能耗时较长，请稍候</p>}
      {error && <p className="form-err" role="alert">{error}{!loaded && <button className="btn btn-sm" onClick={load}>重新读取工作区</button>}</p>}
    </div>
    <LinuxRuntimeSettings onTerminal={onTerminal}/>
  </div>;
}

export default function WorkspacePanel({onClose,fullPage=false,active=true}) {
  const [state,setState] = useState(restore), [config,setConfig] = useState({}), [error,setError] = useState(''), [newMenu,setNewMenu] = useState(false);
  const [started,setStarted] = useState(new Set());
  const strip = useRef(null), dragged = useRef(null);
  const load = () => api('/workspace').then(setConfig).catch(e => setError(e.message));
  useEffect(() => {load();return ws.on('workspace-changed',load);},[]);
  useEffect(() => {try {localStorage.setItem(storageKey,JSON.stringify(state));} catch {}},[state]);
  useEffect(() => {if(active) strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'});},[state.active,active]);
  useEffect(() => {const tab = state.tabs.find(tab => tab.id===state.active);if(active && tab?.type==='terminal') setStarted(previous => new Set(previous).add(tab.id));},[active,state.active]);
  useEffect(() => {const listener = () => setNewMenu(false);document.addEventListener('mousedown',listener);return () => document.removeEventListener('mousedown',listener);},[]);
  const open = (type,path='') => {
    setNewMenu(false);
    setState(previous => {
      const existing = type==='config' && previous.tabs.find(tab => tab.type==='config');
      if(existing) return {...previous,active:existing.id};
      const tab = {...fresh(type),path};
      return {tabs:[...previous.tabs,tab],active:tab.id};
    });
  };
  const close = id => setState(previous => {
    const index = previous.tabs.findIndex(tab => tab.id===id), tabs = previous.tabs.filter(tab => tab.id!==id);
    if(!tabs.length) {const tab = fresh('files');return {tabs:[tab],active:tab.id};}
    return {tabs,active:previous.active===id ? tabs[Math.min(index,tabs.length-1)].id : previous.active};
  });
  const update = (id,patch) => setState(previous => ({...previous,tabs:previous.tabs.map(tab => tab.id===id ? {...tab,...patch} : tab)}));
  const selected = state.tabs.find(tab => tab.id===state.active);
  return <section className={'workspace-panel'+(fullPage ? ' workspace-page' : '')}>
    <div className="workspace-tabbar">
      <div className="subtabs workspace-subtabs" ref={strip} role="tablist" aria-label="工作区小标签">
        {state.tabs.map((tab,index) => <div key={tab.id} role="tab" tabIndex={tab.id===state.active ? 0 : -1} aria-selected={tab.id===state.active} data-tab-id={tab.id}
          className={'subtab workspace-subtab'+(tab.id===state.active ? ' on' : '')} draggable
          onDragStart={event => {dragged.current = tab.id;event.dataTransfer.setData('text/sp-workspace-tab',tab.id);event.dataTransfer.effectAllowed='move';}}
          onDragOver={event => {if(dragged.current) event.preventDefault();}}
          onDrop={event => {if(!dragged.current) return;event.preventDefault();event.stopPropagation();const id=dragged.current;dragged.current=null;if(id===tab.id) return;setState(previous => {const tabs=previous.tabs.filter(item=>item.id!==id),item=previous.tabs.find(item=>item.id===id);tabs.splice(tabs.findIndex(item=>item.id===tab.id),0,item);return {...previous,tabs};});}}
          onDragEnd={() => {dragged.current=null;}} onClick={() => setState(previous => ({...previous,active:tab.id}))}
          onKeyDown={event => {if(event.target!==event.currentTarget) return;if(['Enter',' '].includes(event.key)){event.preventDefault();setState(previous=>({...previous,active:tab.id}));}if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const next=state.tabs[(index+(event.key==='ArrowRight'?1:state.tabs.length-1))%state.tabs.length];setState(previous=>({...previous,active:next.id}));}if(event.key==='Delete') close(tab.id);}}>
          <span aria-hidden="true">{tab.type==='files' ? '📁' : tab.type==='terminal' ? '>_' : '⚙'}</span>
          <span className="subtab-title" title={tab.path ? '/workspace/'+tab.path : ''}>{tab.type==='files' ? '文件管理' : tab.type==='terminal' ? '终端' : '配置'}{tab.path ? ' · '+tab.path.split('/').pop() : ''}</span>
          <button className={'st-pin'+(tab.pinned ? ' on' : '')} aria-label={tab.pinned ? '取消固定标签' : '固定标签'} title={tab.pinned ? '取消固定' : '固定标签'} onClick={event => {event.stopPropagation();update(tab.id,{pinned:!tab.pinned});}}><PinIcon size={11} filled={tab.pinned}/></button>
          <button className="st-close" aria-label="关闭标签" title="关闭此页" onClick={event => {event.stopPropagation();close(tab.id);}}>×</button>
        </div>)}
      </div>
      <div className="workspace-tab-actions" onMouseDown={event => event.stopPropagation()}>
        <div className="fm-new-wrap"><button className="st-add" aria-label="新建工作区标签" onClick={() => setNewMenu(!newMenu)}>＋</button>{newMenu && <div className="fm-new-menu"><button className="fm-menu-item" onClick={() => open('files')}>📁 文件管理</button><button className="fm-menu-item" onClick={() => open('terminal',selected?.path||'')}> &gt;_ 终端</button></div>}</div>
        {selected?.type==='terminal' && <button className="btn btn-sm" onClick={() => open('config')}>⚙ 配置</button>}
        {!fullPage && <button className="workspace-close" aria-label="关闭工作区列表" onClick={onClose}>×</button>}
      </div>
    </div>
    {error && <div className="fm-err" role="alert">{error}</div>}
    <div className="workspace-tab-content">
      {state.tabs.map(tab => <div className={'workspace-tab-pane'+(tab.id===state.active ? ' on' : '')} key={tab.id}>
        {tab.type==='files' && <WorkspaceFiles config={config} active={active&&tab.id===state.active} session={tab} onPath={path => update(tab.id,{path})} onConfigure={() => open('config')} onOpenTerminal={path => open('terminal',path)}/>}
        {tab.type==='terminal' && started.has(tab.id) && <WorkspaceTerminal session={tab} active={active&&tab.id===state.active} onClose={() => close(tab.id)} onConfigure={() => open('config')}/>}
        {tab.type==='config' && <WorkspaceSettings onTerminal={() => open('terminal')}/>}
      </div>)}
    </div>
  </section>;
}
