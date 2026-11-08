import React, { useRef, useState } from 'react';
import { loadOrder, createSortable, makeClickSuppressor } from '../sortable.js';
import { PanelLeftIcon, GridIcon, PromptIcon, ChartIcon, SlidersIcon, EditIcon, TrashIcon, FolderIcon } from '../icons.jsx';

const NAV = [
  { id: 'home', icon: <GridIcon />, label: '机器总览' },
  { id: 'work', icon: <PromptIcon />, label: '工作台' },
  { id: 'settings', icon: <SlidersIcon />, label: '配置' }
];

export default function Sidebar({
  width, view, setView, onHide, hosts, probeMap, termHostIds, dataUnavailable=false,
  onOpenTerminal, onOpenMonitor, onOpenFiles, onAdd, onEdit, onDelete, onCloseHost
}) {
  const [order, setOrder] = useState(() => loadOrder('shellpilot-nav-order', NAV.map((n) => n.id)));
  const orderRef = useRef(order);
  const navRef = useRef(null);
  const [dragId, setDragId] = useState(null);
  const suppress = useRef(makeClickSuppressor());
  const [kw, setKw] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState(() => {
    try { return JSON.parse(localStorage.getItem('shellpilot-collapsed-groups') || '{}') || {}; } catch { return {}; }
  });

  const toggleGroup = (g) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [g]: !prev[g] };
      try { localStorage.setItem('shellpilot-collapsed-groups', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const setOrderBoth = (o) => {
    orderRef.current = o;
    setOrder(o);
    try { localStorage.setItem('shellpilot-nav-order', JSON.stringify(o)); } catch {}
  };

  // 长按拖动排序；排第一的成为打开软件时的默认页
  const startNavDrag = createSortable({
    getOrder: () => orderRef.current,
    setOrder: setOrderBoth,
    containerRef: navRef,
    itemSelector: '.nav-item',
    onDragStart: (id) => setDragId(id),
    onDragEnd: (dragged) => { setDragId(null); if (dragged) suppress.current.suppress(); }
  });

  const dotOf = (h) => {
    const p = (probeMap || {})[h.id] || {};
    return p.state === 'online' ? 'green' : ['connecting','host-key-required'].includes(p.state) ? 'amber' : ['error','offline'].includes(p.state) ? 'red' : 'gray';
  };

  const q = kw.trim().toLowerCase();
  const filteredHosts = q
    ? hosts.filter((h) =>
        (h.name || '').toLowerCase().includes(q) ||
        (h.host || '').toLowerCase().includes(q) ||
        (h.username || '').toLowerCase().includes(q) ||
        (h.group || '').toLowerCase().includes(q)
      )
    : hosts;

  const hasAnyGroup = hosts.some((h) => (h.group || '').trim());
  const groups = [];
  if (hasAnyGroup) {
    const map = new Map();
    for (const h of filteredHosts) {
      const g = (h.group || '').trim() || '默认分组';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(h);
    }
    for (const [g, list] of map.entries()) groups.push({ name: g, list });
  } else {
    groups.push({ name: null, list: filteredHosts });
  }

  const renderHostItem = (h) => {
    const jumpHost = h.jumpHostId ? hosts.find((x) => x.id === h.jumpHostId) : null;
    return (
      <div
        key={h.id}
        className="host-item"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/sp-host', h.id);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => onOpenTerminal(h.id)}
        title={
          `点击打开终端 · 拖到右侧工作区可新开一个终端` +
          (jumpHost ? `\n跳板机: ${jumpHost.name} (${jumpHost.host})` : '')
        }
      >
        <span className={'dot ' + dotOf(h)} title={(probeMap[h.id] || {}).state === 'online' ? 'SSH 已连接' : (probeMap[h.id] || {}).error || '尚未连接'} />
        <div className="host-info">
          <div className="host-name">
            {h.name}
            {jumpHost && <span className="host-jump-badge" title={`经跳板机: ${jumpHost.name}`}>跳</span>}
          </div>
          <div className="host-addr">{h.username}@{h.host}</div>
          {probeMap[h.id]?.state === 'host-key-required' && <button className="host-identity-action" onClick={(event)=>{event.stopPropagation();onOpenTerminal(h.id);}}>身份变化 · 查看并连接</button>}
        </div>
        <div className="host-ops" onClick={(e) => e.stopPropagation()}>
          <button title="新开一个终端标签" onClick={() => onOpenTerminal(h.id, true)}><PromptIcon size={12} /></button>
          <button title="新开一个监控标签" onClick={() => onOpenMonitor(h.id, true)}><ChartIcon size={12} /></button>
          <button title="新开一个文件管理标签" onClick={() => onOpenFiles(h.id, true)}><FolderIcon size={12} /></button>
          {termHostIds?.has?.(h.id) && (
            <button title="断开" onClick={() => onCloseHost(h.id)}>⏏</button>
          )}
          <button title="编辑" onClick={() => onEdit(h)}><EditIcon size={12} /></button>
          <button title="删除" className="danger" onClick={() => onDelete(h)}><TrashIcon size={12} /></button>
        </div>
      </div>
    );
  };

  return (
    <div className="sidebar" style={{ width, minWidth: width }}>
      <div className="logo">
        <img className="logo-mark" src="/shellpilot.svg" alt="ShellPilot" />
        <div>
          <div className="logo-name">ShellPilot</div>
          <div className="logo-sub">AI SSH 工作台</div>
        </div>
        <button className="side-hide" title="收起侧栏" onClick={onHide}><PanelLeftIcon /></button>
      </div>

      <div className="nav" ref={navRef} title="长按拖动可调整顺序，第一位的为默认页">
        {order.map((id) => {
          const n = NAV.find((x) => x.id === id);
          return (
            <button
              key={id}
              className={'nav-item' + (view === id ? ' on' : '') + (dragId === id ? ' dragging' : '')}
              onMouseDown={startNavDrag(id)}
              onClick={() => { if (!suppress.current.isSuppressed()) setView(id); }}
            >
              <span>{n.icon}</span> {n.label}
            </button>
          );
        })}
      </div>

      <div className="side-label">服务器（{hosts.length}）</div>
      {hosts.some((host)=>probeMap[host.id]?.state==='host-key-required') && <div className="identity-summary"><span>{hosts.filter((host)=>probeMap[host.id]?.state==='host-key-required').length} 台服务器身份待处理</span><button onClick={()=>onOpenTerminal(hosts.find((host)=>probeMap[host.id]?.state==='host-key-required').id)}>查看</button></div>}
      {hosts.length > 0 && (
        <div className="side-search-wrap">
          <input
            className="side-search"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="搜索机器名称 / IP / 分组…"
          />
          {kw && <button className="side-search-clear" onClick={() => setKw('')} title="清空搜索">×</button>}
        </div>
      )}
      <div className="host-list">
        {hosts.length === 0 && !dataUnavailable && (
          <div className="empty-tip">还没有服务器<br />点下面按钮添加第一台</div>
        )}
        {hosts.length > 0 && filteredHosts.length === 0 && (
          <div className="empty-tip">未找到匹配的服务器</div>
        )}
        {groups.map((grp) => {
          if (!grp.name) return grp.list.map(renderHostItem);
          const collapsed = !!collapsedGroups[grp.name] && !q;
          return (
            <div key={grp.name} className="host-group">
              <div className="host-group-hdr" onClick={() => toggleGroup(grp.name)}>
                <span className="host-group-arrow">{collapsed ? '▸' : '▾'}</span>
                <span className="host-group-name">{grp.name}</span>
                <span className="host-group-cnt">{grp.list.length}</span>
              </div>
              {!collapsed && grp.list.map(renderHostItem)}
            </div>
          );
        })}
      </div>

      <button className="btn add-host" disabled={dataUnavailable} onClick={onAdd}>＋ 添加服务器</button>
    </div>
  );
}
