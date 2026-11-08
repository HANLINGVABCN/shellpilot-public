import React, { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { ws } from '../ws.js';

const MAX_POINTS = 180;
const pad2 = (n) => String(n).padStart(2, '0');
const fmtClock = (sec) => {
  if (sec == null) return '--';
  const d = new Date(sec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

// 悬停图表显示对应点的数值（不悬停 = 显示最新一个）；onCursor(idx, left, top) 供跟随鼠标的提示框使用
function makeChart(el, seriesOpts, yRange, onCursor, yAxisValues, yAxisSize) {
  return new uPlot(
    {
      width: el.clientWidth || 600,
      height: 170,
      series: [{}, ...seriesOpts],
      axes: [
        {
          stroke: '#6b7488', grid: { stroke: 'rgba(255,255,255,0.05)', width: 1 }, ticks: { show: false }, font: '11px system-ui',
          values: (u, ticks) => ticks.map((v) => { const d = new Date(v * 1000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; })
        },
        {
          stroke: '#6b7488', grid: { stroke: 'rgba(255,255,255,0.05)', width: 1 }, ticks: { show: false }, font: '11px system-ui',
          ...(yAxisSize ? { size: yAxisSize } : {}),
          ...(yAxisValues ? { values: yAxisValues } : {})
        }
      ],
      scales: yRange ? { y: { range: yRange } } : {},
      legend: { show: false },
      cursor: { show: true, drag: { setScale: false } },
      hooks: { setCursor: [(u) => onCursor(u.cursor.idx, u.cursor.left, u.cursor.top)] }
    },
    [[], []],
    el
  );
}

const baseSeries = (label, stroke, fill) => ({
  label, stroke, width: 1.8, fill,
  points: { show: false },
  value: (u, v) => (v == null ? '--' : v.toFixed(1))
});

// 取某个位置的点（idx 为空 = 最新）
const at = (arr, idx) => (arr.length === 0 ? null : arr[idx == null ? arr.length - 1 : idx]);

export default function MonitorView({ hostId, active, connection }) {
  const cpuEl = useRef(null), memEl = useRef(null), netEl = useRef(null);
  const charts = useRef({});
  const data = useRef({ cpu: [], mem: [], net: [] });
  const memTotalRef = useRef(0);
  const [stats, setStats] = useState(null);
  const [osInfo, setOsInfo] = useState('');
  const [cpuTip, setCpuTip] = useState(null);   // { idx, left, top } | null
  const [memTip, setMemTip] = useState(null);
  const [netTip, setNetTip] = useState(null);

  useEffect(() => {
    data.current = { cpu: [], mem: [], net: [] };
    memTotalRef.current = 0;
    setStats(null);
    setOsInfo('');
    setCpuTip(null); setMemTip(null); setNetTip(null);

    if (!hostId) return;

    // 向后端要该机器的历史采样（不需要 attach 终端会话）
    ws.send({ type: 'metrics-sub', hostId });

    const c = charts.current;
    c.cpu = makeChart(cpuEl.current, [baseSeries('CPU %', '#e2a85c', 'rgba(226,168,92,0.08)')], [0, 100],
      (idx, left, top) => setCpuTip(idx == null ? null : { idx, left, top }),
      (u, ticks) => ticks.map((v) => `${v}%`));
    c.mem = makeChart(memEl.current, [baseSeries('内存 %', '#69b98c', 'rgba(105,185,140,0.08)')], [0, 100],
      (idx, left, top) => setMemTip(idx == null ? null : { idx, left, top }),
      (u, ticks) => ticks.map((v) => memTotalRef.current > 0 ? `${Math.round(v)}% · ${(v / 100 * memTotalRef.current / 1048576).toFixed(1)}G` : `${v}%`),
      82);
    c.net = makeChart(netEl.current, [
      baseSeries('下载 KB/s', '#5fa8a0', 'rgba(95,168,160,0.08)'),
      baseSeries('上传 KB/s', '#d9b36a', 'rgba(217,179,106,0.08)')
    ], null, (idx, left, top) => setNetTip(idx == null ? null : { idx, left, top }));

    const apply = () => {
      const d = data.current;
      c.cpu && c.cpu.setData([d.cpu.map((p) => p[0]), d.cpu.map((p) => p[1])]);
      c.mem && c.mem.setData([d.mem.map((p) => p[0]), d.mem.map((p) => p[1])]);
      c.net && c.net.setData([d.net.map((p) => p[0]), d.net.map((p) => p[1]), d.net.map((p) => p[2])]);
    };

    const push = (arr, point) => {
      arr.push(point);
      if (arr.length > MAX_POINTS) arr.shift();
    };

    // probe 事件与 metrics 事件都带 sample：终端未连接时监控页也能持续刷新
    const onSample = (m) => {
      if (m.hostId !== hostId || !m.sample) return;
      const s = m.sample;
      memTotalRef.current = s.memTotal || memTotalRef.current;
      push(data.current.cpu, [s.t, +s.cpu.toFixed(1)]);
      push(data.current.mem, [s.t, +s.memPct.toFixed(1)]);
      push(data.current.net, [s.t, +(s.rxS / 1024).toFixed(2), +(s.txS / 1024).toFixed(2)]);
      apply();
      setStats(s);
    };

    const offs = [
      ws.on('metrics', onSample),
      ws.on('probe', onSample),
      ws.on('metrics-batch', (m) => {
        if (m.hostId !== hostId) return;
        data.current = { cpu: [], mem: [], net: [] };
        for (const s of m.samples) {
          push(data.current.cpu, [s.t, +s.cpu.toFixed(1)]);
          push(data.current.mem, [s.t, +s.memPct.toFixed(1)]);
          push(data.current.net, [s.t, +(s.rxS / 1024).toFixed(2), +(s.txS / 1024).toFixed(2)]);
        }
        if (m.samples.length) memTotalRef.current = m.samples[m.samples.length - 1].memTotal || memTotalRef.current;
        apply();
        if (m.samples.length) setStats(m.samples[m.samples.length - 1]);
      }),
      ws.on('status', (m) => { if (m.hostId === hostId && m.os) setOsInfo(m.os); })
    ];

    const ro = new ResizeObserver(() => {
      try {
        const w = cpuEl.current?.clientWidth;
        if (w > 0) {
          // 注意：setSize 必须同时传 height，否则 uPlot 会把高度抹成 0 导致图表空白
          c.cpu?.setSize({ width: w, height: 170 });
          c.mem?.setSize({ width: w, height: 170 });
          c.net?.setSize({ width: w, height: 170 });
        }
      } catch {}
    });
    cpuEl.current && ro.observe(cpuEl.current);

    return () => {
      offs.forEach((f) => f());
      ro.disconnect();
      c.cpu?.destroy(); c.mem?.destroy(); c.net?.destroy();
      charts.current = {};
    };
  }, [hostId]);

  // 切到监控页时主动量宽重设尺寸（RO 偶发不触发，这条保底）
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      try {
        const w = cpuEl.current?.clientWidth;
        if (w > 0) {
          charts.current.cpu?.setSize({ width: w, height: 170 });
          charts.current.mem?.setSize({ width: w, height: 170 });
          charts.current.net?.setSize({ width: w, height: 170 });
        }
      } catch {}
    }, 60);
    return () => clearTimeout(t);
  }, [active, hostId]);

  if (!hostId) return <div className="monitor-wrap"><div className="empty-center">从左侧选择一台服务器</div></div>;

  const d = data.current;
  const cpuPt = at(d.cpu, cpuTip?.idx);
  const memPt = at(d.mem, memTip?.idx);
  const netPt = at(d.net, netTip?.idx);
  const memGB = (pct) => (memTotalRef.current > 0 ? ` · ${(pct / 100 * memTotalRef.current / 1048576).toFixed(1)} GB` : '');

  const fmtUp = (sec) => {
    if (!sec) return '--';
    const day = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return day > 0 ? `${day}天${h}时` : h > 0 ? `${h}时${m}分` : `${m}分`;
  };

  return (
    <div className="monitor-wrap">
      <div className="stat-row">
        <StatCard label="CPU 使用率" value={stats ? stats.cpu.toFixed(1) + '%' : '--'} color="#e2a85c" />
        <StatCard label="内存" value={stats ? (stats.memUsed / 1024).toFixed(0) + ' / ' + (stats.memTotal / 1024).toFixed(0) + ' MB' : '--'} color="#69b98c" />
        <StatCard label={stats?.platform==='windows'?'系统':'负载 (1分钟)'} value={stats?.platform==='windows'?'Windows':stats ? stats.load1.toFixed(2) : '--'} color="#d9b36a" />
        <StatCard label="↓ 下载" value={stats ? (stats.rxS / 1024).toFixed(1) + ' KB/s' : '--'} color="#5fa8a0" />
        <StatCard label="↑ 上传" value={stats ? (stats.txS / 1024).toFixed(1) + ' KB/s' : '--'} color="#d98c5f" />
        <StatCard label={stats?.platform==='windows'?'系统盘':'磁盘 (/)'} value={stats ? (stats.diskTotalKB ? `${(stats.diskUsedKB / 1048576).toFixed(1)} / ${(stats.diskTotalKB / 1048576).toFixed(0)} GB · ${stats.diskPct}%` : `已用 ${stats.diskPct}%`) : '--'} color="#e0705c" />
        <StatCard label="已运行" value={fmtUp(stats?.uptime)} color="#828a94" />
      </div>
      {!stats && (
        <div className="monitor-empty">
          {connection?.state==='online' ? `SSH 已连接 · ${connection.metricsError || '暂无性能数据；Windows 等系统的终端连接不受影响'}` : connection?.state==='host-key-required' ? '正在等待保存服务器身份，请在页面上方直接处理后继续连接。' : connection?.error || '暂无性能数据，正在等待连接和采样。'}
        </div>
      )}
      {osInfo && <div className="os-line">{osInfo.split('\n').join(' · ')}</div>}
      <div className="chart-card">
        <div className="chart-head">
          <span className="chart-title">CPU (%)</span>
          <span className="chart-live">
            <i style={{ background: '#e2a85c' }} />
            {cpuPt ? `${fmtClock(cpuPt[0])} · ${cpuPt[1].toFixed(1)}%` : '--'}
          </span>
        </div>
        <div ref={cpuEl} />
        {cpuTip && cpuPt && (
          <div className="chart-tip" style={{ left: Math.min(cpuTip.left + 14, (cpuEl.current?.clientWidth || 300) - 150), top: Math.max(cpuTip.top - 14, 2) }}>
            <div className="tip-t">{fmtClock(cpuPt[0])}</div>
            <div>CPU {cpuPt[1].toFixed(1)}%</div>
          </div>
        )}
      </div>
      <div className="chart-card">
        <div className="chart-head">
          <span className="chart-title">内存 (%, GB)</span>
          <span className="chart-live">
            <i style={{ background: '#69b98c' }} />
            {memPt ? `${fmtClock(memPt[0])} · ${memPt[1].toFixed(1)}%${memGB(memPt[1])}` : '--'}
          </span>
        </div>
        <div ref={memEl} />
        {memTip && memPt && (
          <div className="chart-tip" style={{ left: Math.min(memTip.left + 14, (memEl.current?.clientWidth || 300) - 170), top: Math.max(memTip.top - 14, 2) }}>
            <div className="tip-t">{fmtClock(memPt[0])}</div>
            <div>内存 {memPt[1].toFixed(1)}%{memGB(memPt[1])}</div>
          </div>
        )}
      </div>
      <div className="chart-card">
        <div className="chart-head">
          <span className="chart-title">网络流量 (KB/s)</span>
          <span className="chart-live">
            <i style={{ background: '#5fa8a0' }} />
            {netPt ? `${fmtClock(netPt[0])} · ↓${netPt[1].toFixed(2)}` : '--'}
            <i style={{ background: '#d9b36a' }} />
            {netPt ? `↑${netPt[2].toFixed(2)}` : ''}
          </span>
        </div>
        <div ref={netEl} />
        {netTip && netPt && (
          <div className="chart-tip" style={{ left: Math.min(netTip.left + 14, (netEl.current?.clientWidth || 300) - 180), top: Math.max(netTip.top - 14, 2) }}>
            <div className="tip-t">{fmtClock(netPt[0])}</div>
            <div>↓{netPt[1].toFixed(2)} KB/s · ↑{netPt[2].toFixed(2)} KB/s</div>
          </div>
        )}
      </div>
      <div className="monitor-note">每 2 秒采集一次 · 鼠标放到图上可看每个时间点的数值 · 最多展示最近 6 分钟</div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>{value}</div>
    </div>
  );
}
