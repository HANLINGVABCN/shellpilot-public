import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ws } from '../ws.js';
import {api} from '../api.js';
import {attachTerminalHistory} from '../terminal-history.js';

// 每个终端会话一个实例；session = { id, hostId, title }
const connectedPrinted = new Set();

export default function TerminalView({ session, active, pendingCwd, onClearPendingCwd }) {
  const ref = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const fitFrame = useRef(null);
  const historyRef=useRef(null);

  // 右键菜单
  const [menu, setMenu] = useState(null);

  // 终端内搜索 (Ctrl+F)
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchKw, setSearchKw] = useState('');
  const [matches, setMatches] = useState([]);
  const [matchIdx, setMatchIdx] = useState(0);
  const searchInputRef = useRef(null);

  const sendInput = (data) => {
    if (!session?.id) return;
    historyRef.current?.input(data);
    ws.send({ type: 'term-input', sessionId: session.id, data });
  };

  useEffect(() => {
    if (!session?.id) return;
    const sid = session.id;
    const hostId = session.hostId;
    const term = new Terminal({
      allowProposedApi: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#0a0d13',
        foreground: '#dfe4ee',
        cursor: '#e2a85c',
        selectionBackground: 'rgba(79,140,255,0.35)',
        black: '#1b2030', red: '#ff6b6b', green: '#3dd68c', yellow: '#fbbf24',
        blue: '#4f8cff', magenta: '#c792ea', cyan: '#4dd0e1', white: '#dfe4ee'
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    termRef.current = term;
    fitRef.current = fit;
    const history=attachTerminalHistory(term,ref.current);historyRef.current=history;
    let historyLive=true;api('/terminal/history?host='+encodeURIComponent(hostId)).then(value=>{if(historyLive)history.setCommands(value.commands);}).catch(()=>{});

    // 选中即自动复制到系统剪贴板
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel && sel.length > 0) {
        navigator.clipboard?.writeText(sel).catch(() => {});
      }
    });

    // 快捷键：Ctrl+F 打开搜索，Ctrl+Shift+C 复制
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown') {
        if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'f') {
          ev.preventDefault();
          setSearchOpen(true);
          setTimeout(() => searchInputRef.current?.focus(), 20);
          return false;
        }
        if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'c') {
          const sel = term.getSelection();
          if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
          return false;
        }
      }
      return history.key(ev);
    });

    const initCwd = pendingCwd;
    if (initCwd && onClearPendingCwd) onClearPendingCwd();
    const attach = (cwdToUse) => ws.send({ type: 'attach', sessionId: sid, hostId, ...(cwdToUse ? { cwd: cwdToUse } : {}) });
    attach(initCwd);

    let lastErr = '';
    let needReset = false;
    const offs = [
      ws.on('term-data', (m) => { if (m.sessionId === sid) term.write(m.data); }),
      ws.on('term-replay', (m) => {
        if (m.sessionId === sid && m.data) { history.reset();term.reset(); term.write(m.data); }
      }),
      ws.on('terminal-history',m=>{if(m.hostId===hostId)history.setCommands(m.commands);}),
      ws.on('_close',()=>history.reset()),
      ws.on('status', (m) => {
        if (m.sessionId !== sid) return;
        if (m.state === 'connected') {
          history.setToken(m.shellIntegration);
          lastErr = '';
          if (needReset) {
            needReset = false;
            term.reset();
          }
          if (!connectedPrinted.has(sid)) {
            connectedPrinted.add(sid);
            term.write('\x1b[32m✓ 已连接\x1b[0m' + (m.os ? '  ' + String(m.os).replace(/\n/g, ' · ') : '') + '\r\n\r\n');
          }
        } else if (m.state === 'error') {
          history.reset();
          needReset = true;
          if (m.message !== lastErr) {
            lastErr = m.message;
            term.write('\r\n\x1b[31m✗ ' + (m.message || '连接失败') + '\x1b[0m\r\n\r\n');
          }
        } else if (m.state === 'host-key-required') {
          history.reset();
          needReset = true;
          if (m.message !== lastErr) {
            lastErr = m.message;
            term.write('\r\n\x1b[33m● ' + m.message + '\x1b[0m\r\n\r\n');
          }
        } else if (m.state === 'closed') {
          history.reset();
          needReset = true;
          if (m.message !== lastErr) {
            lastErr = m.message;
            term.write('\r\n\x1b[33m⛔ ' + (m.message || '连接已断开') + '\x1b[0m\r\n\r\n');
          }
        }
      }),
      ws.on('_open', () => attach())
    ];
    term.onData((d) => sendInput(d));

    const fitNow = () => {
      try {
        if (ref.current && ref.current.clientWidth > 0 && ref.current.clientHeight > 0) {
          // The terminal itself has neutral CSS zoom, so mouse coordinates and
          // xterm's cell measurements use the same coordinate system.
          const uiZoom = parseFloat(document.documentElement.style.getPropertyValue('--sp-ui-zoom')) || 1;
          const size = Math.round(13 * uiZoom * 10) / 10;
          if (term.options.fontSize !== size) term.options.fontSize = size;
          fit.fit();
          ws.send({ type: 'term-resize', sessionId: sid, cols: term.cols, rows: term.rows });
        }
      } catch {}
    };
    const scheduleFit = () => {
      cancelAnimationFrame(fitFrame.current);
      fitFrame.current = requestAnimationFrame(() => { fitFrame.current = null; fitNow(); });
    };
    scheduleFit();
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(ref.current);
    window.addEventListener('resize', scheduleFit);
    window.addEventListener('shellpilot-zoom', scheduleFit);
    document.fonts?.addEventListener('loadingdone', scheduleFit);
    let live = true;
    document.fonts?.ready.then(() => { if (live) scheduleFit(); });

    return () => {
      historyLive=false;history.dispose();historyRef.current=null;
      offs.forEach((f) => f());
      ro.disconnect();
      live = false;
      cancelAnimationFrame(fitFrame.current);
      window.removeEventListener('resize', scheduleFit);
      window.removeEventListener('shellpilot-zoom', scheduleFit);
      document.fonts?.removeEventListener('loadingdone', scheduleFit);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [session?.id]);

  // 每次切回该终端或有新的目录跳转请求时：重新 attach 并重算尺寸
  const didMountAttach = useRef(false);
  useEffect(() => {
    if (active && session?.id) {
      if (!didMountAttach.current) {
        didMountAttach.current = true;
      } else {
        const cwdToUse = pendingCwd;
        if (cwdToUse && onClearPendingCwd) onClearPendingCwd();
        ws.send({
          type: 'attach',
          sessionId: session.id,
          hostId: session.hostId,
          ...(cwdToUse ? { cwd: cwdToUse } : {})
        });
      }
      setTimeout(() => {
        try {
          if (ref.current && ref.current.clientWidth > 0 && fitRef.current && termRef.current) {
            fitRef.current.fit();
            ws.send({ type: 'term-resize', sessionId: session.id, cols: termRef.current.cols, rows: termRef.current.rows });
            termRef.current.focus();
          }
        } catch {}
      }, 30);
    }
  }, [active, session?.id, pendingCwd]);

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = (e) => {
      if (e.target && e.target.closest && e.target.closest('.fm-menu')) return;
      setMenu(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  // 执行终端缓冲搜索
  const runSearch = (kw, jumpIdx = 0) => {
    const term = termRef.current;
    if (!term || !kw) {
      setMatches([]);
      setMatchIdx(0);
      term?.clearSelection();
      return;
    }
    const buf = term.buffer.active;
    const lowerKw = kw.toLowerCase();
    const found = [];
    for (let r = 0; r < buf.length; r++) {
      const lineObj = buf.getLine(r);
      if (!lineObj) continue;
      const lineStr = lineObj.translateToString(true);
      const lowerLine = lineStr.toLowerCase();
      let pos = 0;
      while ((pos = lowerLine.indexOf(lowerKw, pos)) !== -1) {
        found.push({ row: r, col: pos, len: kw.length });
        pos += kw.length;
      }
    }
    setMatches(found);
    if (found.length > 0) {
      const idx = ((jumpIdx % found.length) + found.length) % found.length;
      setMatchIdx(idx);
      const m = found[idx];
      term.select(m.col, m.row, m.len);
      term.scrollToLine(Math.max(0, m.row - Math.floor(term.rows / 2)));
    } else {
      setMatchIdx(0);
      term.clearSelection();
    }
  };

  const stepSearch = (delta) => {
    if (!matches.length) return;
    const nextIdx = ((matchIdx + delta) % matches.length + matches.length) % matches.length;
    setMatchIdx(nextIdx);
    const term = termRef.current;
    const m = matches[nextIdx];
    if (term && m) {
      term.select(m.col, m.row, m.len);
      term.scrollToLine(Math.max(0, m.row - Math.floor(term.rows / 2)));
    }
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendInput(text);
    } catch {}
  };

  if (!session) return null;

  return (
    <div
      className="terminal-wrap"
      onContextMenu={(e) => {
        e.preventDefault();
        const sel = termRef.current?.getSelection() || '';
        setMenu({
          x: Math.min(e.clientX, window.innerWidth - 190),
          y: Math.min(e.clientY, window.innerHeight - 220),
          sel
        });
      }}
    >
      {/* 终端内搜索浮层 (按 Ctrl+F 或右键菜单呼出) */}
      {searchOpen && (
        <div className="term-search-bar">
          <input
            ref={searchInputRef}
            value={searchKw}
            onChange={(e) => {
              setSearchKw(e.target.value);
              runSearch(e.target.value, 0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stepSearch(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                setSearchOpen(false);
                termRef.current?.focus();
              }
            }}
            placeholder="查找终端输出 (Enter 下一个)…"
          />
          <span className="term-search-count">
            {searchKw ? (matches.length ? `${matchIdx + 1} / ${matches.length}` : '无匹配') : ''}
          </span>
          <button className="btn btn-sm" disabled={!matches.length} onClick={() => stepSearch(-1)} title="上一个 (Shift+Enter)">↑</button>
          <button className="btn btn-sm" disabled={!matches.length} onClick={() => stepSearch(1)} title="下一个 (Enter)">↓</button>
          <button className="btn btn-sm" onClick={() => { setSearchOpen(false); termRef.current?.focus(); }}>×</button>
        </div>
      )}

      <div ref={ref} className="terminal-el" />

      {/* 终端右键菜单 */}
      {menu && (
        <div
          className="fm-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="fm-menu-item"
            disabled={!menu.sel}
            onClick={() => {
              if (menu.sel) navigator.clipboard?.writeText(menu.sel).catch(() => {});
              setMenu(null);
              termRef.current?.focus();
            }}
          >复制</button>
          <button
            className="fm-menu-item"
            onClick={() => {
              setMenu(null);
              pasteClipboard();
              termRef.current?.focus();
            }}
          >粘贴</button>
          <button
            className="fm-menu-item"
            onClick={() => {
              setMenu(null);
              setSearchOpen(true);
              setTimeout(() => searchInputRef.current?.focus(), 20);
            }}
          >搜索 (Ctrl+F)</button>
          <button
            className="fm-menu-item"
            onClick={() => {
              setMenu(null);
              termRef.current?.selectAll();
              termRef.current?.focus();
            }}
          >全选</button>
          <button
            className="fm-menu-item"
            onClick={() => {
              setMenu(null);
              termRef.current?.clear();
              termRef.current?.focus();
            }}
          >清屏</button>
          <button
            className="fm-menu-item"
            onClick={() => {
              setMenu(null);
              ws.send({ type: 'attach', sessionId: session.id, hostId: session.hostId });
              termRef.current?.focus();
            }}
          >重新连接</button>
        </div>
      )}
    </div>
  );
}
