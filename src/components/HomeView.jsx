import React, { useEffect, useState } from 'react';
import { ws } from '../ws.js';
import { api } from '../api.js';

const fmtUp = (sec) => {
  if (!sec) return '--';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}天${h}时` : h > 0 ? `${h}时${m}分` : `${m}分`;
};

function BarRow({ label, pct, text, color }) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <div className="bar-track"><div className="bar-fill" style={{ width: p + '%', background: color }} /></div>
      <span className="bar-text" style={{ color }}>{text}</span>
    </div>
  );
}

function ProbeCard({ p, onClick, onIdentity }) {
  const s = p.sample;
  const connected = p.state === 'online';
  const online = connected && s;
  return (
    <div className={'probe-card' + (p.state==='host-key-required' ? ' awaiting-identity' : connected ? '' : ' off')} onClick={onClick} title="点击查看性能监控">
      <div className="pc-head">
        <span className={'dot ' + (connected ? 'green' : ['connecting','host-key-required'].includes(p.state) ? 'amber' : 'red')} />
        <span className="pc-name">{p.name}</span>
        <span className="pc-go">管理 ›</span>
      </div>
      {online ? (
        <>
          <BarRow label="CPU" pct={s.cpu} text={s.cpu.toFixed(1) + '%'} color="#e2a85c" />
          <BarRow label="内存" pct={s.memPct} text={`${(s.memUsed / 1024).toFixed(0)}/${(s.memTotal / 1024).toFixed(0)}MB`} color="#69b98c" />
          <BarRow label="磁盘" pct={s.diskPct} text={s.diskTotalKB ? `${(s.diskUsedKB / 1048576).toFixed(1)}/${(s.diskTotalKB / 1048576).toFixed(0)}G` : s.diskPct + '%'} color="#e0705c" />
          <div className="pc-row">
            <span>{s.platform==='windows' ? 'Windows' : `负载 ${s.load1.toFixed(2)}`}</span>
            <span>↑{(s.txS / 1024).toFixed(1)}K ↓{(s.rxS / 1024).toFixed(1)}K</span>
            <span>运行 {fmtUp(s.uptime)}</span>
          </div>
        </>
      ) : (
        <div className="pc-offline">
          {connected ? `✓ SSH 已连接 · ${p.metricsError || '暂无性能数据'}` : p.state === 'host-key-required' ? <><div>服务器身份变化，连接已暂停</div><button className="btn btn-sm" onClick={(event)=>{event.stopPropagation();onIdentity();}}>查看指纹并连接</button></> : p.state === 'connecting' ? '⏳ 正在连接…' : `⛔ 离线：${p.error || '未知原因'}`}
        </div>
      )}
    </div>
  );
}

export default function HomeView({ onOpenHost, onOpenIdentity, connectionMap = {} }) {
  const [probes, setProbes] = useState({});

  useEffect(() => {
    api('/probe').then((list) => {
      const map = {};
      for (const p of list) map[p.hostId] = p;
      setProbes(map);
    }).catch(() => {});
    return ws.on('probe', (m) => setProbes((prev) => ({ ...prev, [m.hostId]: m })));
  }, []);

  const list = Object.values({...probes,...connectionMap}).filter((probe) => probe.hostId);
  const online = list.filter((p) => p.state === 'online').length;
  const pending = list.filter((p) => p.state === 'host-key-required').length;

  return (
    <div className="home-wrap">
      <div className="home-head">
        <h1>机器总览</h1>
        <span className="home-sub">{online} 在线{pending>0 && ` · ${pending} 身份待处理`} · {list.length - online - pending} 离线 · 共 {list.length} 台 · 每 3 秒刷新</span>
      </div>
      <div className="home-grid">
        {list.length === 0 && (
          <div className="empty-tip" style={{ gridColumn: '1/-1' }}>
            还没有服务器。点左侧「＋ 添加服务器」开始，添加后这里会实时显示所有机器的状态。
          </div>
        )}
        {list.map((p) => (
          <ProbeCard key={p.hostId} p={p} onClick={() => onOpenHost(p.hostId)} onIdentity={()=>onOpenIdentity(p.hostId)} />
        ))}
      </div>
    </div>
  );
}
