import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import StorageIssue from './components/StorageIssue.jsx';
import { ws } from './ws.js';
import Sidebar from './components/Sidebar.jsx';
import HostModal from './components/HostModal.jsx';
import TerminalView from './components/TerminalView.jsx';
import MonitorView from './components/MonitorView.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import SettingsView from './components/SettingsView.jsx';
import HomeView from './components/HomeView.jsx';
import { loadOrder, createSortable, makeClickSuppressor } from './sortable.js';
import { PanelLeftIcon, PanelRightIcon, PromptIcon, ChartIcon, PinIcon, FolderIcon } from './icons.jsx';
import FileManager from './components/FileManager.jsx';
import HostIdentityPrompt from './components/HostIdentityPrompt.jsx';
import WorkspacePanel from './components/WorkspacePanel.jsx';

// 工作台一级标签：终端 / 性能监控 / 文件管理；二级标签是机器（逻辑完全一致：多开、×关闭、图钉固定、拖拽）
const L1S = [
  { id: 'terminal', label: '终端' },
  { id: 'monitor', label: '性能监控' },
  { id: 'files', label: '文件管理' },
  { id: 'workspace', label: '📁 工作区' }
];

const newSessionId = () => 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// 会话状态持久化：刷新网页时完整保留所有打开的终端/监控/文件管理标签及当前选中项；重启软件保留固定标签或上次未关闭标签
const PINNED_TERM_KEY = 'shellpilot-pinned-term';
const PINNED_MON_KEY = 'shellpilot-pinned-mon';
const PINNED_FILE_KEY = 'shellpilot-pinned-file';
const SESS_TERM_KEY = 'shellpilot-sess-term';
const SESS_MON_KEY = 'shellpilot-sess-mon';
const SESS_FILE_KEY = 'shellpilot-sess-file';
const ACTIVE_TERM_KEY = 'shellpilot-active-term';
const ACTIVE_MON_KEY = 'shellpilot-active-mon';
const ACTIVE_FILE_KEY = 'shellpilot-active-file';

const loadSessions = (sessKey, pinnedKey) => {
  try {
    // 优先从 sessionStorage 恢复刷新前的所有标签；若无则从 localStorage 恢复
    const rawSess = sessionStorage.getItem(sessKey) || localStorage.getItem(sessKey) || localStorage.getItem(pinnedKey) || '[]';
    const arr = JSON.parse(rawSess);
    return Array.isArray(arr) ? arr.filter((t) => t && t.id && t.hostId) : [];
  } catch { return []; }
};

const loadActiveId = (activeKey, list) => {
  try {
    const saved = sessionStorage.getItem(activeKey) || localStorage.getItem(activeKey);
    if (saved && list.some((s) => s.id === saved)) return saved;
  } catch {}
  return list[0]?.id || null;
};

export default function App() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [mobilePage, setMobilePage] = useState('main');
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const changed = () => setMobile(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  const [hosts, setHosts] = useState([]);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [storageError,setStorageError]=useState('');
  useEffect(()=>{
    const failed=event=>setStorageError(event.detail);
    window.addEventListener('shellpilot-storage-error',failed);
    api('/storage/status').then(status=>{if(status.error)setStorageError(status.error);}).catch(()=>{});
    const off=ws.on('storage-error',m=>setStorageError(m.error));
    return()=>{window.removeEventListener('shellpilot-storage-error',failed);off();};
  },[]);
  const [probeMap, setProbeMap] = useState({});               // hostId → 探针状态（侧栏圆点 / 监控状态）
  const [statusBySession, setStatusBySession] = useState({}); // sessionId → 终端连接状态
  // 默认页 = 上次停留的页面（首次则取侧栏排在第一位的导航项）
  const [view, setView] = useState(() => {
    const saved = localStorage.getItem('shellpilot-last-view');
    return ['home', 'work', 'settings'].includes(saved) ? saved : loadOrder('shellpilot-nav-order', ['home', 'work', 'settings'])[0];
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => { try { localStorage.setItem('shellpilot-last-view', view); } catch {} }, [view]);
  const [l1, setL1] = useState(() => {
    const saved = localStorage.getItem('shellpilot-l1');
    return L1S.some((t) => t.id === saved) ? saved : loadOrder('shellpilot-tab-order', L1S.map((t) => t.id))[0];
  });
  useEffect(() => { try { localStorage.setItem('shellpilot-l1', l1); } catch {} }, [l1]);
  const [workspaceOpened,setWorkspaceOpened]=useState(l1==='workspace');
  useEffect(()=>{if(l1==='workspace')setWorkspaceOpened(true);},[l1]);
  const [l1Order, setL1Order] = useState(() => loadOrder('shellpilot-tab-order', L1S.map((t) => t.id)));
  const l1OrderRef = useRef(l1Order);
  const l1TabsRef = useRef(null);
  const [l1DragId, setL1DragId] = useState(null);
  const l1Suppress = useRef(makeClickSuppressor());

  const setL1OrderBoth = (o) => {
    l1OrderRef.current = o;
    setL1Order(o);
    try { localStorage.setItem('shellpilot-tab-order', JSON.stringify(o)); } catch {}
  };

  const startL1Drag = createSortable({
    getOrder: () => l1OrderRef.current,
    setOrder: setL1OrderBoth,
    containerRef: l1TabsRef,
    itemSelector: '.tab',
    onDragStart: (id) => setL1DragId(id),
    onDragEnd: (dragged) => { setL1DragId(null); if (dragged) l1Suppress.current.suppress(); }
  });

  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem('shellpilot-chat-open') !== 'hidden');
  useEffect(() => {
    try { localStorage.setItem('shellpilot-chat-open', chatOpen ? 'open' : 'hidden'); } catch {}
  }, [chatOpen]);
  const [hostModal, setHostModal] = useState(null);
  // 二级标签：终端会话、监控页、文件管理（刷新网页时全部保留）
  const [termSessions, setTermSessions] = useState(() => loadSessions(SESS_TERM_KEY, PINNED_TERM_KEY));
  const [activeTerm, setActiveTerm] = useState(() => loadActiveId(ACTIVE_TERM_KEY, loadSessions(SESS_TERM_KEY, PINNED_TERM_KEY)));
  const [monSessions, setMonSessions] = useState(() => loadSessions(SESS_MON_KEY, PINNED_MON_KEY));
  const [activeMon, setActiveMon] = useState(() => loadActiveId(ACTIVE_MON_KEY, loadSessions(SESS_MON_KEY, PINNED_MON_KEY)));
  const [fileSessions, setFileSessions] = useState(() => loadSessions(SESS_FILE_KEY, PINNED_FILE_KEY));
  const [activeFile, setActiveFile] = useState(() => loadActiveId(ACTIVE_FILE_KEY, loadSessions(SESS_FILE_KEY, PINNED_FILE_KEY)));
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState(null); // 底部提示条（连接反馈）

  // 标签与当前选中项持久化：sessionStorage + localStorage 同步保存所有打开的会话，刷新网页完全保留
  useEffect(() => {
    try {
      sessionStorage.setItem(SESS_TERM_KEY, JSON.stringify(termSessions));
      localStorage.setItem(SESS_TERM_KEY, JSON.stringify(termSessions));
      localStorage.setItem(PINNED_TERM_KEY, JSON.stringify(termSessions.filter((s) => s.pinned)));
    } catch {}
  }, [termSessions]);
  useEffect(() => {
    try {
      sessionStorage.setItem(SESS_MON_KEY, JSON.stringify(monSessions));
      localStorage.setItem(SESS_MON_KEY, JSON.stringify(monSessions));
      localStorage.setItem(PINNED_MON_KEY, JSON.stringify(monSessions.filter((s) => s.pinned)));
    } catch {}
  }, [monSessions]);
  useEffect(() => {
    try {
      sessionStorage.setItem(SESS_FILE_KEY, JSON.stringify(fileSessions));
      localStorage.setItem(SESS_FILE_KEY, JSON.stringify(fileSessions));
      localStorage.setItem(PINNED_FILE_KEY, JSON.stringify(fileSessions.filter((s) => s.pinned)));
    } catch {}
  }, [fileSessions]);
  useEffect(() => {
    try {
      sessionStorage.setItem(ACTIVE_TERM_KEY, activeTerm || '');
      localStorage.setItem(ACTIVE_TERM_KEY, activeTerm || '');
    } catch {}
  }, [activeTerm]);
  useEffect(() => {
    try {
      sessionStorage.setItem(ACTIVE_MON_KEY, activeMon || '');
      localStorage.setItem(ACTIVE_MON_KEY, activeMon || '');
    } catch {}
  }, [activeMon]);
  useEffect(() => {
    try {
      sessionStorage.setItem(ACTIVE_FILE_KEY, activeFile || '');
      localStorage.setItem(ACTIVE_FILE_KEY, activeFile || '');
    } catch {}
  }, [activeFile]);

  const fileRef = useRef(fileSessions);
  fileRef.current = fileSessions;

  const termRef = useRef(termSessions);
  const monRef = useRef(monSessions);
  const hostsRef = useRef(hosts);
  termRef.current = termSessions;
  monRef.current = monSessions;
  hostsRef.current = hosts;

  // 打开或刷新网页：所有已打开的终端标签自动连接恢复、监控标签自动拉取历史曲线
  const bootAt = useRef(Date.now());
  useEffect(() => {
    termRef.current.forEach((s, i) => {
      setTimeout(() => ws.send({ type: 'attach', sessionId: s.id, hostId: s.hostId }), 120 * i);
    });
    monRef.current.forEach((s, i) => {
      setTimeout(() => ws.send({ type: 'metrics-sub', hostId: s.hostId }), 100 * i);
    });
  }, []);

  const togglePin = (kind, id) => {
    const upd = (list) => list.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s));
    if (kind === 'term') setTermSessions(upd(termRef.current));
    else if (kind === 'mon') setMonSessions(upd(monRef.current));
    else setFileSessions(upd(fileRef.current));
  };

  // 二级标签条拖拽排序（终端 / 监控同一套逻辑）
  const termStripRef = useRef(null);
  const monStripRef = useRef(null);
  const [termDragId, setTermDragId] = useState(null);
  const [monDragId, setMonDragId] = useState(null);
  const termSuppress = useRef(makeClickSuppressor());
  const monSuppress = useRef(makeClickSuppressor());

  const startTermStripDrag = createSortable({
    getOrder: () => termRef.current.map((s) => s.id),
    setOrder: (o) => setTermSessions(o.map((id) => termRef.current.find((s) => s.id === id)).filter(Boolean)),
    containerRef: termStripRef,
    itemSelector: '.subtab',
    onDragStart: (id) => setTermDragId(id),
    onDragEnd: (dragged) => { setTermDragId(null); if (dragged) termSuppress.current.suppress(); }
  });

  const startMonStripDrag = createSortable({
    getOrder: () => monRef.current.map((s) => s.id),
    setOrder: (o) => setMonSessions(o.map((id) => monRef.current.find((s) => s.id === id)).filter(Boolean)),
    containerRef: monStripRef,
    itemSelector: '.subtab',
    onDragStart: (id) => setMonDragId(id),
    onDragEnd: (dragged) => { setMonDragId(null); if (dragged) monSuppress.current.suppress(); }
  });

  // 左右两栏宽度（可拖拽，记忆在 localStorage）
  const [chatW, setChatW] = useState(() => {
    try { return JSON.parse(localStorage.getItem('shellpilot-widths') || '{}').chat || 390; } catch { return 390; }
  });
  const [sideW, setSideW] = useState(() => {
    try { return JSON.parse(localStorage.getItem('shellpilot-widths') || '{}').side || 244; } catch { return 244; }
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('shellpilot-sidebar') !== 'hidden');
  const toggleSidebar = () => setSidebarOpen((v) => {
    localStorage.setItem('shellpilot-sidebar', v ? 'hidden' : 'open');
    return !v;
  });

  const beginResize = (e, which) => {
    e.preventDefault();
    const isChat = which === 'chat';
    const startW = isChat ? chatW : sideW;
    const startX = e.clientX;
    let last = startW;
    // 基本不限制拖拽范围，只挡住拖出屏幕（最小留一点显示拖拽把手）
    const min = 60, max = Math.max(min, window.innerWidth - 260);
    const move = (ev) => {
      const delta = ev.clientX - startX;
      last = Math.min(max, Math.max(min, isChat ? startW - delta : startW + delta));
      isChat ? setChatW(last) : setSideW(last);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('dragging');
      try {
        const prev = JSON.parse(localStorage.getItem('shellpilot-widths') || '{}');
        localStorage.setItem('shellpilot-widths', JSON.stringify({ ...prev, [isChat ? 'chat' : 'side']: last }));
      } catch {}
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.classList.add('dragging');
  };

  const loadHosts = () => api('/hosts').then((list) => { setHosts(list); setHostsLoaded(true); }).catch(() => {});
  useEffect(() => { loadHosts(); }, []);
  useEffect(() => ws.on('hosts-changed', loadHosts), []);

  // 全局界面缩放（配置页里选择，作用于整个软件，记住选择）。
  // 叠加窗口自适应：布局设计宽 844，窗口宽度不足(844×偏好)时整体再缩，
  // 保证任何窗口尺寸下四边贴合、内容永不被挤出。
  useEffect(() => {
    const apply = () => {
      const pref = parseFloat(localStorage.getItem('shellpilot-zoom') || '1');
      const u = Number.isFinite(pref) && pref > 0 ? pref : 1;
      const total = window.matchMedia('(max-width: 760px)').matches ? 1 : Math.min(1.5, Math.max(0.75, u), window.innerWidth / 844);
      document.documentElement.style.zoom = total;
      document.documentElement.style.setProperty('--sp-ui-zoom', String(total));
    };
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('shellpilot-zoom', apply);
    const viewport = window.visualViewport;
    const fitHeight = () => document.documentElement.style.setProperty('--sp-viewport-height', `${viewport?.height || window.innerHeight}px`);
    fitHeight();
    viewport?.addEventListener('resize', fitHeight);
    window.addEventListener('resize', fitHeight);
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('shellpilot-zoom', apply);
      viewport?.removeEventListener('resize', fitHeight);
      window.removeEventListener('resize', fitHeight);
    };
  }, []);

  // 导入配置后刷新机器列表
  useEffect(() => {
    const reload = () => loadHosts();
    window.addEventListener('shellpilot-hosts-changed', reload);
    return () => window.removeEventListener('shellpilot-hosts-changed', reload);
  }, []);

  // 探针状态（每 3 秒广播）：侧栏圆点、监控页头部
  useEffect(() => {
    api('/probe').then((list) => {
      const m = {};
      for (const p of list) m[p.hostId] = p;
      setProbeMap(m);
    }).catch(() => {});
    return ws.on('probe', (m) => setProbeMap((prev) => ({ ...prev, [m.hostId]: m })));
  }, []);

  // 终端连接状态（按 sessionId）；状态变化弹底部提示条（重连反馈）
  const toastTimer = useRef(null);
  const lastToast = useRef({ text: '', ts: 0 });
  const showToast = (text) => {
    const now = Date.now();
    if (lastToast.current.text === text && now - lastToast.current.ts < 15000) return; // 自动重连反复失败时不刷屏
    lastToast.current = { text, ts: now };
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };
  const openWebLink = (event) => {
    if(event.type==='auxclick' && event.button!==1)return;
    const anchor=event.target.closest?.('a[href]');if(!anchor)return;
    const href=anchor.getAttribute('href');
    if(!href || href.startsWith('#'))return;
    event.preventDefault();
    let url;try{url=new URL(href,location.href);}catch{showToast('链接格式不正确');return;}
    if(!['http:','https:'].includes(url.protocol)){showToast('仅支持网页链接');return;}
    api('/open-external-url','POST',{url:url.href}).catch((error)=>showToast(error.message));
  };
  // 断开后自动重连（8 秒一次；关掉的标签不再重连；打开软件头 3 秒的批量连接不弹提示）
  const retryTimers = useRef({});
  const autoRetrying = useRef({});
  const identityDependents = useRef(new Map());
  const trustedEvents = useRef(new Map());
  const requestIdentity = (hostId) => window.dispatchEvent(new CustomEvent('shellpilot-ssh-identity', {detail:{hostId}}));
  useEffect(() => {
    const retry = (hostId) => {
      if (Date.now() - (trustedEvents.current.get(hostId) || 0) < 1000) return;
      trustedEvents.current.set(hostId, Date.now());
      const targets = new Set([hostId, ...(identityDependents.current.get(hostId) || [])]);
      identityDependents.current.delete(hostId);
      for (const session of termRef.current.filter((session) => targets.has(session.hostId))) {
        clearTimeout(retryTimers.current[session.id]);
        autoRetrying.current[session.id] = false;
        ws.send({type:'attach',sessionId:session.id,hostId:session.hostId});
      }
      for (const id of targets) window.dispatchEvent(new CustomEvent('shellpilot-ssh-reconnected',{detail:{hostId:id}}));
    };
    const offRequired = ws.on('ssh-host-key-required', (message) => {
      const id = message.key?.hostId;
      if (!id) return;
      const targets = identityDependents.current.get(id) || new Set();
      targets.add(message.retryHostId || id);
      identityDependents.current.set(id, targets);
    });
    const offTrusted = ws.on('ssh-host-key-trusted', (message) => retry(message.hostId));
    const localTrusted = (event) => retry(event.detail.hostId);
    window.addEventListener('shellpilot-ssh-identity-trusted', localTrusted);
    return () => { offRequired(); offTrusted(); window.removeEventListener('shellpilot-ssh-identity-trusted', localTrusted); };
  }, []);
  useEffect(() => ws.on('status', (m) => {
    if (!m.sessionId) return;
    setStatusBySession((prev) => ({ ...prev, [m.sessionId]: { state: m.state, message: m.message, os: m.os } }));
    const t = termRef.current.find((s) => s.id === m.sessionId);
    if (!t) return;
    if (m.state === 'host-key-required') {
      clearTimeout(retryTimers.current[m.sessionId]);
      autoRetrying.current[m.sessionId] = false;
      return;
    }
    if ((m.state === 'error' || m.state === 'closed')) {
      clearTimeout(retryTimers.current[m.sessionId]);
      retryTimers.current[m.sessionId] = setTimeout(() => {
        if (termRef.current.some((s) => s.id === m.sessionId)) {
          autoRetrying.current[m.sessionId] = true;
          ws.send({ type: 'attach', sessionId: m.sessionId, hostId: m.hostId });
        }
      }, 8000);
    }
    if (m.state === 'connected') {
      autoRetrying.current[m.sessionId] = false;
      if (Date.now() - bootAt.current > 3000) showToast('✓ 已连接 ' + t.title);
    } else if (m.state === 'error' && !autoRetrying.current[m.sessionId]) {
      if (Date.now() - bootAt.current > 3000) showToast('✗ ' + (m.message || '连接失败'));
    }
  }), []);

  // AI 请求执行命令 → 审批条在对话面板内展示；若面板被收起则自动展开
  useEffect(() => ws.on('tool-request', () => { setChatOpen(true); setMobilePage('chat'); }), []);

  // ---- 打开 / 关闭终端与监控（同一套逻辑） ----
  // 点机器 = 复用已有标签，没有才新建；＋按钮 / 拖机器进来 = 强制新开
  const makeTab = (list, hid) => {
    const h = hostsRef.current.find((x) => x.id === hid) || {};
    const count = list.filter((s) => s.hostId === hid).length;
    return { id: newSessionId(), hostId: hid, title: (h.name || '机器') + (count ? ' ·' + (count + 1) : ''), pinned: false };
  };

  const [pendingCwds, setPendingCwds] = useState({});

  const openTerminalAt = (hostId, dirPath) => {
    const list = termRef.current;
    const target = makeTab(list, hostId);
    setTermSessions([...list, target]);
    const sid = target.id;
    if (dirPath) {
      setPendingCwds((prev) => ({ ...prev, [sid]: dirPath }));
    }
    setActiveTerm(sid);
    setView('work');
    setL1('terminal');
  };

  const openTerminal = (hostId, forceNew = false) => {
    requestIdentity(hostId);
    const list = termRef.current;
    const existing = !forceNew && list.find((s) => s.hostId === hostId);
    if (existing) {
      setActiveTerm(existing.id);
    } else {
      const s = makeTab(list, hostId);
      setTermSessions([...list, s]);
      setActiveTerm(s.id);
    }
    setView('work');
    setL1('terminal');
  };

  const openMonitor = (hostId, forceNew = false) => {
    requestIdentity(hostId);
    const list = monRef.current;
    const existing = !forceNew && list.find((s) => s.hostId === hostId);
    if (existing) {
      setActiveMon(existing.id);
    } else {
      const s = makeTab(list, hostId);
      setMonSessions([...list, s]);
      setActiveMon(s.id);
    }
    setView('work');
    setL1('monitor');
  };

  const openFiles = (hostId, forceNew = false) => {
    requestIdentity(hostId);
    const list = fileRef.current;
    const existing = !forceNew && list.find((s) => s.hostId === hostId);
    if (existing) {
      setActiveFile(existing.id);
    } else {
      const s = makeTab(list, hostId);
      setFileSessions([...list, s]);
      setActiveFile(s.id);
    }
    setView('work');
    setL1('files');
  };

  const closeFile = (sid) => {
    try { localStorage.removeItem('shellpilot-fm-cwd-' + sid); } catch {}
    const list = fileRef.current;
    const idx = list.findIndex((s) => s.id === sid);
    const next = list.filter((s) => s.id !== sid);
    setFileSessions(next);
    if (activeFile === sid) setActiveFile(next[Math.min(idx, next.length - 1)]?.id || null);
  };

  const closeTerm = (sid) => {
    const list = termRef.current;
    const idx = list.findIndex((s) => s.id === sid);
    const next = list.filter((s) => s.id !== sid);
    setTermSessions(next);
    setStatusBySession((prev) => {
      const cp = { ...prev };
      delete cp[sid];
      return cp;
    });
    if (activeTerm === sid) setActiveTerm(next[Math.min(idx, next.length - 1)]?.id || null);
    clearTimeout(retryTimers.current[sid]);
    ws.send({ type: 'detach', sessionId: sid });
  };

  const closeMon = (sid) => {
    const list = monRef.current;
    const idx = list.findIndex((s) => s.id === sid);
    const next = list.filter((s) => s.id !== sid);
    setMonSessions(next);
    if (activeMon === sid) setActiveMon(next[Math.min(idx, next.length - 1)]?.id || null);
  };

  const delHost = async (h) => {
    if (!confirm(`确定删除「${h.name}」？（只删记录，不影响服务器）`)) return;
    await api('/hosts/' + h.id, 'DELETE').catch(() => {});
    ws.send({ type: 'close-host', hostId: h.id });
    termRef.current.filter((s) => s.hostId === h.id).forEach((s) => closeTerm(s.id));
    monRef.current.filter((s) => s.hostId === h.id).forEach((s) => closeMon(s.id));
    fileRef.current.filter((s) => s.hostId === h.id).forEach((s) => closeFile(s.id));
    loadHosts();
  };

  const activeTermSession = termSessions.find((s) => s.id === activeTerm);
  const activeMonSession = monSessions.find((s) => s.id === activeMon);
  const activeFileSession = fileSessions.find((s) => s.id === activeFile);
  const activeWorkHost = (l1 === 'terminal' ? activeTermSession : l1 === 'monitor' ? activeMonSession : l1 === 'files' ? activeFileSession : null)?.hostId;
  const connectionMap = {...probeMap};
  for (const session of termSessions) {
    const status = statusBySession[session.id];
    if (status?.state === 'connected') {
      connectionMap[session.hostId] = {...connectionMap[session.hostId], hostId:session.hostId, name:hosts.find((host)=>host.id===session.hostId)?.name, state:'online', error:null, terminalConnected:true};
    } else if (status?.state === 'host-key-required' && !connectionMap[session.hostId]?.terminalConnected) {
      connectionMap[session.hostId] = {...connectionMap[session.hostId], state:'host-key-required', error:status.message};
    }
  }

  return (
    <div id="app" className={mobile ? `mobile-layout mobile-${mobilePage}` : ''} onClickCapture={openWebLink} onAuxClickCapture={openWebLink}>
      {mobile && (
        <nav className="mobile-nav" aria-label="主导航">
          <button className={mobilePage === 'hosts' ? 'on' : ''} onClick={() => setMobilePage('hosts')}>服务器</button>
          <button className={mobilePage === 'main' && view === 'home' ? 'on' : ''} onClick={() => { setMobilePage('main'); setView('home'); }}>总览</button>
          <button className={mobilePage === 'main' && view === 'work' ? 'on' : ''} onClick={() => { setMobilePage('main'); setView('work'); }}>工作台</button>
          <button className={mobilePage === 'chat' ? 'on' : ''} onClick={() => { setMobilePage('chat'); setChatOpen(true); }}>AI</button>
          <button className={mobilePage === 'main' && view === 'settings' ? 'on' : ''} onClick={() => { setMobilePage('main'); setView('settings'); }}>设置</button>
        </nav>
      )}
      {(sidebarOpen || mobile) && (
        <>
          <Sidebar
            width={sideW}
            view={view} setView={setView} onHide={toggleSidebar}
            hosts={hosts} probeMap={connectionMap} dataUnavailable={!!storageError}
            termHostIds={new Set([...termSessions.map((s) => s.hostId), ...monSessions.map((s) => s.hostId), ...fileSessions.map((s) => s.hostId)])}
            onOpenTerminal={(...args) => { openTerminal(...args); setMobilePage('main'); }}
            onOpenMonitor={(...args) => { openMonitor(...args); setMobilePage('main'); }}
            onOpenFiles={(...args) => { openFiles(...args); setMobilePage('main'); }}
            onAdd={() => setHostModal({})}
            onEdit={(h) => setHostModal(h)}
            onDelete={delHost}
            onCloseHost={(id) => {
              ws.send({ type: 'close-host', hostId: id });
              termRef.current.filter((s) => s.hostId === id).forEach((s) => {
                setStatusBySession((prev) => ({ ...prev, [s.id]: { state: 'closed', message: '已在侧栏断开' } }));
              });
            }}
          />
          <div className="drag-handle-v" onMouseDown={(e) => beginResize(e, 'side')} title="拖拽调整宽度" />
        </>
      )}

      {!sidebarOpen && (
        <button className="sidebar-tab" title="展开侧栏" onClick={toggleSidebar}><PanelLeftIcon size={13} /></button>
      )}

      <div className="main">
        {view !== 'work' && (
          <button
            className={'btn btn-sm ai-toggle ai-float' + (chatOpen ? ' on' : '')}
            title={chatOpen ? '收起 AI 对话' : '展开 AI 对话'}
            onClick={() => { setChatOpen(!chatOpen); if (mobile) { setChatOpen(true); setMobilePage('chat'); } }}
          >
            <PanelRightIcon /> AI
          </button>
        )}

        {storageError ? <StorageIssue error={storageError} onRecovered={()=>{setStorageError('');loadHosts();window.dispatchEvent(new Event('shellpilot-hosts-changed'));}}/> : view === 'home' ? (
          <HomeView onOpenHost={openMonitor} onOpenIdentity={(hostId)=>{openTerminal(hostId);setMobilePage('main');}} connectionMap={connectionMap} />
        ) : view === 'work' ? (
          <>
            {/* 顶上一行：终端 / 性能监控（长按拖动调顺序）+ AI 开关 */}
            <div className="tabbar">
              <div className="tab-left">
                <div className="tabs" ref={l1TabsRef} title="长按拖动可调整顺序，第一位的为进入工作台时的默认页">
                  {l1Order.map((id) => {
                    const t = L1S.find((x) => x.id === id);
                    const n = id === 'terminal' ? termSessions.length : id === 'monitor' ? monSessions.length : id === 'files' ? fileSessions.length : 0;
                  return (
                  <button
                    key={id}
                    className={'tab' + (l1 === id ? ' on' : '') + (l1DragId === id ? ' dragging' : '')}
                    onMouseDown={startL1Drag(id)}
                    onClick={() => { if (!l1Suppress.current.isSuppressed()) setL1(id); }}
                  >
                    {t.label}{n > 0 ? ` (${n})` : ''}
                  </button>
                  );
                  })}
                </div>
              </div>
              <div className="tab-right">
                <button
                  className={'btn btn-sm ai-toggle' + (chatOpen ? ' on' : '')}
                  title={chatOpen ? '收起 AI 对话' : '展开 AI 对话'}
                  onClick={() => { setChatOpen(!chatOpen); if (mobile) { setChatOpen(true); setMobilePage('chat'); } }}
                >
                  <PanelRightIcon /> AI
                </button>
              </div>
            </div>

            {/* 二级标签条：终端 / 监控同一套交互（点击切换、×关闭、条内拖拽排序、＋新开） */}
            {l1!=='workspace'&&<div className="subtabs" ref={l1 === 'terminal' ? termStripRef : l1 === 'monitor' ? monStripRef : null}>
              {l1 === 'terminal' ? (
                <>
                  {termSessions.map((s) => {
                    const h = hosts.find((x) => x.id === s.hostId);
                    const st = statusBySession[s.id]?.state;
                    const dot = st === 'connected' ? 'green' : ['connecting','host-key-required'].includes(st) ? 'amber' : 'red';
                    return (
                      <div
                        key={s.id}
                        className={'subtab' + (activeTerm === s.id ? ' on' : '') + (termDragId === s.id ? ' dragging' : '')}
                        onMouseDown={startTermStripDrag(s.id)}
                        onClick={() => { if (!termSuppress.current.isSuppressed()) setActiveTerm(s.id); }}
                        onDoubleClick={() => {
                          // 双击标签 = 重连
                          showToast('正在重连 ' + s.title + ' …');
                          setStatusBySession((prev) => ({ ...prev, [s.id]: { state: 'connecting' } }));
                          ws.send({ type: 'attach', sessionId: s.id, hostId: s.hostId });
                        }}
                        title={(h ? `${h.username}@${h.host}\n` : '') + '双击重连'}
                      >
                        <span className={'dot ' + dot} /><span className="subtab-title" title={s.title}>{s.title}</span>
                        <button
                          className={'st-pin' + (s.pinned ? ' on' : '')}
                          title={s.pinned ? '取消固定（重启后不再保留）' : '固定标签（重启软件后自动恢复并连接）'}
                          onClick={(e) => { e.stopPropagation(); togglePin('term', s.id); }}
                        ><PinIcon size={11} filled={s.pinned} /></button>
                        <button className="st-close" title="关闭此终端" onClick={(e) => { e.stopPropagation(); closeTerm(s.id); }}>×</button>
                      </div>
                    );
                  })}
                  <button
                    className="st-add"
                    title={activeTermSession ? `给「${activeTermSession.title}」所在机器再开一个终端` : '先在左侧点一台机器'}
                    disabled={!activeTermSession}
                    onClick={() => activeTermSession && openTerminal(activeTermSession.hostId, true)}
                  >＋ 终端</button>
                  {termSessions.length === 0 && <span className="subtab-hint">点左侧一台机器开始，或把它拖到下面区域</span>}
                </>
              ) : l1 === 'monitor' ? (
                <>
                  {monSessions.map((s) => {
                    const h = hosts.find((x) => x.id === s.hostId);
                    const ps = (connectionMap[s.hostId] || {}).state;
                    const dot = ps === 'online' ? 'green' : ps === 'connecting' ? 'amber' : 'red';
                    return (
                      <div
                        key={s.id}
                        className={'subtab' + (activeMon === s.id ? ' on' : '') + (monDragId === s.id ? ' dragging' : '')}
                        onMouseDown={startMonStripDrag(s.id)}
                        onClick={() => { if (!monSuppress.current.isSuppressed()) setActiveMon(s.id); }}
                        onDoubleClick={() => { showToast('正在刷新 ' + s.title + ' …'); ws.send({ type: 'metrics-sub', hostId: s.hostId }); }}
                        title={(h ? `${h.username}@${h.host}\n` : '') + '双击刷新数据'}
                      >
                        <span className={'dot ' + dot} /><span className="subtab-title" title={s.title}>{s.title}</span>
                        <button
                          className={'st-pin' + (s.pinned ? ' on' : '')}
                          title={s.pinned ? '取消固定（重启后不再保留）' : '固定标签（重启软件后自动恢复）'}
                          onClick={(e) => { e.stopPropagation(); togglePin('mon', s.id); }}
                        ><PinIcon size={11} filled={s.pinned} /></button>
                        <button className="st-close" title="关闭此页" onClick={(e) => { e.stopPropagation(); closeMon(s.id); }}>×</button>
                      </div>
                    );
                  })}
                  <button
                    className="st-add"
                    title={activeMonSession ? `给「${activeMonSession.title}」所在机器再开一个监控` : '先在左侧点一台机器'}
                    disabled={!activeMonSession}
                    onClick={() => activeMonSession && openMonitor(activeMonSession.hostId, true)}
                  >＋ 监控</button>
                  {monSessions.length === 0 && <span className="subtab-hint">点左侧机器的「监控」，或把它拖到下面区域</span>}
                </>
              ) : (
                <>
                  {fileSessions.map((s) => {
                    const h = hosts.find((x) => x.id === s.hostId);
                    const ps = (connectionMap[s.hostId] || {}).state;
                    const dot = ps === 'online' ? 'green' : ps === 'connecting' ? 'amber' : 'red';
                    return (
                      <div
                        key={s.id}
                        className={'subtab' + (activeFile === s.id ? ' on' : '')}
                        onClick={() => setActiveFile(s.id)}
                        title={(h ? `${h.username}@${h.host}\n` : '') + '点击打开'}
                      >
                        <span className={'dot ' + dot} /><span className="subtab-title" title={s.title}>{s.title}</span>
                        <button
                          className={'st-pin' + (s.pinned ? ' on' : '')}
                          title={s.pinned ? '取消固定（重启后不再保留）' : '固定标签（重启软件后自动恢复）'}
                          onClick={(e) => { e.stopPropagation(); togglePin('files', s.id); }}
                        ><PinIcon size={11} filled={s.pinned} /></button>
                        <button className="st-close" title="关闭此页" onClick={(e) => { e.stopPropagation(); closeFile(s.id); }}>×</button>
                      </div>
                    );
                  })}
                  <button
                    className="st-add"
                    title={activeFileSession ? `给「${activeFileSession.title}」所在机器再开一个文件管理` : '先在左侧点一台机器'}
                    disabled={!activeFileSession}
                    onClick={() => activeFileSession && openFiles(activeFileSession.hostId, true)}
                  >＋ 文件</button>
                  {fileSessions.length === 0 && <span className="subtab-hint">点左侧机器的「文件」，或把它拖到下面区域</span>}
                </>
              )}
            </div>}

            <div className="work">
              <div
                className={'stage' + (dragOver ? ' drop-ok' : '')}
                onDragOver={(e) => {
                  if (l1!=='workspace'&&e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('text/sp-host')) {
                    e.preventDefault();
                    setDragOver(true);
                  }
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const hid = e.dataTransfer.getData('text/sp-host');
                  if(l1==='workspace')return;
                  if (!hid) return;
                  // 拖到哪个页就开哪个：终端 = 新开终端；监控 = 新开监控；文件管理 = 新开文件管理
                  if (l1 === 'monitor') openMonitor(hid, true);
                  else if (l1 === 'files') openFiles(hid, true);
                  else openTerminal(hid, true);
                }}
              >
                {dragOver && (
                  <div className="drop-hint">
                    {l1 === 'monitor' ? '松手为这台机器新开一个监控' : l1 === 'files' ? '松手打开这台机器的文件管理' : '松手为这台机器新开一个终端'}
                  </div>
                )}
                <HostIdentityPrompt hostId={activeWorkHost} hosts={hosts} />
                <div className="stage-content">
                {(workspaceOpened||l1==='workspace')&&<div className={'stage-pane'+(l1==='workspace'?' show':'')}><WorkspacePanel fullPage active={l1==='workspace'}/></div>}
                {l1 === 'terminal' && termSessions.map((s) => (
                  <div key={s.id} className={'stage-pane' + (activeTerm === s.id ? ' show' : '')}>
                    <TerminalView
                      session={s}
                      active={activeTerm === s.id}
                      pendingCwd={pendingCwds[s.id]}
                      onClearPendingCwd={() => setPendingCwds((prev) => {
                        if (!prev[s.id]) return prev;
                        const cp = { ...prev };
                        delete cp[s.id];
                        return cp;
                      })}
                    />
                  </div>
                ))}
                {l1 === 'terminal' && termSessions.length === 0 && (
                  <div className="stage-pane show"><div className="empty-center">点左侧一台机器开始，或把它拖到这里新开终端</div></div>
                )}
                {l1 === 'monitor' && monSessions.map((s) => (
                  <div key={s.id} className={'stage-pane' + (activeMon === s.id ? ' show' : '')}>
                    <MonitorView hostId={s.hostId} active={activeMon === s.id} connection={connectionMap[s.hostId]} />
                  </div>
                ))}
                {l1 === 'monitor' && monSessions.length === 0 && (
                  <div className="stage-pane show"><div className="empty-center">点左侧机器上的「监控」图标，或把机器拖到这里</div></div>
                )}
                {l1 === 'files' && fileSessions.map((s) => (
                  <div key={s.id} className={'stage-pane' + (activeFile === s.id ? ' show' : '')}>
                    <FileManager session={s} active={activeFile === s.id} hosts={hosts} onOpenTerminalAt={openTerminalAt} />
                  </div>
                ))}
                {l1 === 'files' && fileSessions.length === 0 && (
                  <div className="stage-pane show"><div className="empty-center">点左侧机器上的「文件」图标，或把机器拖到这里</div></div>
                )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <SettingsView />
        )}
      </div>

      {/* AI 对话：所有页面都挂右侧（总览 / 工作台 / 配置） */}
      {(chatOpen || mobile) && !storageError && (
        <>
          <div className="drag-handle-v" onMouseDown={(e) => beginResize(e, 'chat')} title="拖拽调整宽度" />
          <ChatPanel hosts={hosts} hostsLoaded={hostsLoaded} probeMap={connectionMap} width={chatW} onOpenSettings={() => { setView('settings'); setMobilePage('main'); }} />
        </>
      )}

      {hostModal && (
        <HostModal
          host={hostModal.id ? hostModal : null}
          hosts={hosts}
          onClose={() => setHostModal(null)}
          onSaved={() => { setHostModal(null); loadHosts(); }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
