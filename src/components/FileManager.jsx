import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  fsClipboard,
  addFsClipboard,
  removeFsClipboardItem,
  clearFsClipboard,
  setFsClipboard,
  subscribeFsClipboard
} from '../fsclip.js';

const pad2 = (n) => String(n).padStart(2, '0');
const fmtSize = (n, isDir) => {
  if (isDir) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
};
const fmtTime = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// File → ArrayBuffer → base64
const bufToB64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

// base64 → UTF-8 String
const b64ToUtf8 = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
};

// 文件管理：每个会话一个实例；session = { id, hostId, title, pinned }
export default function FileManager({ session, active, hosts = [], onOpenTerminalAt }) {
  const [cwd, setCwd] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [entries, setEntries] = useState([]);
  const [sel, setSel] = useState(new Set());        // 选中的文件名集合
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [menu, setMenu] = useState(null);           // { x, y, name|null } 右键菜单
  const [editing, setEditing] = useState(null);     // { path, content, origContent, saving, savedTip } 编辑器
  const [propsInfo, setPropsInfo] = useState(null); // 右键“属性”
  const [clipState, setClipState] = useState({ op: fsClipboard.op, items: fsClipboard.items || [] });
  const [clipPop, setClipPop] = useState(false);    // 剪贴板折叠列表（点外部才关）
  const [clipDragging, setClipDragging] = useState(false); // 正在从折叠列表中拖拽路径
  const [fmDrag, setFmDrag] = useState(false);      // 列表整体拖拽高亮
  const [dropFolder, setDropFolder] = useState(null); // 正在悬停的目标子文件夹名
  const [lasso, setLasso] = useState(null);         // 鼠标框选矩形 { left, top, width, height }
  const [newMenu, setNewMenu] = useState(false);    // 「新建」下拉
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashItems, setTrashItems] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [transfer, setTransfer] = useState(null);   // { title, detail, pct, speed, canCancel }

  const uploadRef = useRef(null);
  const clipWrapRef = useRef(null);
  const listRef = useRef(null);
  const editorGutterRef = useRef(null);
  const editorTextareaRef = useRef(null);
  const abortUploadRef = useRef(false);
  const justLassoedRef = useRef(false);

  // 跨标签页剪贴板订阅：任何标签页复制/剪切/取消/粘贴，所有 FileManager 实例即时同步
  useEffect(() => {
    return subscribeFsClipboard((clip) => {
      setClipState({ op: clip.op, items: [...(clip.items || [])] });
    });
  }, []);

  const hostId = session?.hostId;
  const cwdStorageKey = session?.id ? `shellpilot-fm-cwd-${session.id}` : null;
  const [sortBy, setSortBy] = useState(() => {
    try { return localStorage.getItem('shellpilot-fm-sortby') || 'name'; } catch (_) { return 'name'; }
  });
  const [sortOrder, setSortOrder] = useState(() => {
    try { return localStorage.getItem('shellpilot-fm-sortorder') || 'asc'; } catch (_) { return 'asc'; }
  });

  const toggleSort = (col) => {
    if (sortBy === col) {
      const next = sortOrder === 'asc' ? 'desc' : 'asc';
      setSortOrder(next);
      try { localStorage.setItem('shellpilot-fm-sortorder', next); } catch (_) {}
    } else {
      setSortBy(col);
      const next = col === 'name' ? 'asc' : 'desc';
      setSortOrder(next);
      try {
        localStorage.setItem('shellpilot-fm-sortby', col);
        localStorage.setItem('shellpilot-fm-sortorder', next);
      } catch (_) {}
    }
  };

  const sorted = [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'd' ? -1 : 1;
    let diff = 0;
    if (sortBy === 'name') {
      diff = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    } else if (sortBy === 'size') {
      diff = (a.size || 0) - (b.size || 0);
    } else if (sortBy === 'mtime') {
      diff = (a.mtime || 0) - (b.mtime || 0);
    }
    return sortOrder === 'asc' ? diff : -diff;
  });

  const list = async (p) => {
    if (!p) return;
    setLoading(true);
    setErr('');
    try {
      const r = await api(`/fs/list?host=${encodeURIComponent(hostId)}&path=${encodeURIComponent(p)}`);
      setEntries(r.entries || []);
      setCwd(p);
      setPathInput(p);
      setSel(new Set());
      if (cwdStorageKey) {
        try { localStorage.setItem(cwdStorageKey, p); } catch (_) {}
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  // 激活时优先恢复上次浏览的文件夹路径；若无则进入该机器的家目录
  const [connectionVersion,setConnectionVersion]=useState(0);
  useEffect(()=>{
    const restored=(event)=>{if(event.detail?.hostId===hostId) { if(cwd) list(cwd); else setConnectionVersion((value)=>value+1); }};
    window.addEventListener('shellpilot-ssh-reconnected',restored);
    return ()=>window.removeEventListener('shellpilot-ssh-reconnected',restored);
  },[hostId,cwd]);
  useEffect(() => {
    if (!active || !hostId || cwd) return;
    (async () => {
      const savedPath = cwdStorageKey ? localStorage.getItem(cwdStorageKey) : null;
      if (savedPath && savedPath.startsWith('/')) {
        try {
          const r = await api(`/fs/list?host=${encodeURIComponent(hostId)}&path=${encodeURIComponent(savedPath)}`);
          setEntries(r.entries || []);
          setCwd(savedPath);
          setPathInput(savedPath);
          return;
        } catch (_) {}
      }
      try {
        const r = await api(`/fs/home?host=${encodeURIComponent(hostId)}`);
        list(r.home || '/');
      } catch (e) {
        setErr(e.message);
      }
    })();
  }, [active, hostId, connectionVersion]);

  // 点外部关闭：右键菜单 / 新建下拉 / 剪贴板折叠列表
  useEffect(() => {
    const onDocClick = (e) => {
      if (!e.target.closest('.fm-menu')) setMenu(null);
      if (!e.target.closest('.fm-new-wrap')) setNewMenu(false);
      if (clipWrapRef.current && !clipWrapRef.current.contains(e.target)) {
        setClipPop(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  if (!session) return null;

  const full = (name) => (cwd === '/' ? '/' + name : cwd.replace(/\/+$/, '') + '/' + name);
  const selPaths = () => sorted.filter((e) => sel.has(e.name)).map((e) => ({ path: full(e.name), name: e.name, type: e.type }));
  const one = () => (sel.size === 1 ? selPaths()[0] : null);

  const act = async (fn, done) => {
    setErr('');
    setLoading(true);
    try {
      await fn();
      if (done) await done();
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  const doDelete = (names) => act(async () => {
    if (!names || !names.length) return;
    if (!confirm(`删除 ${names.length} 项？（移入回收站，可在回收站恢复或彻底删除）`)) return;
    await api('/fs/delete', 'POST', { host: hostId, paths: names.map(full) });
    await list(cwd);
  });

  const doNewDir = () => {
    const name = prompt('新文件夹名称：');
    if (!name) return;
    act(async () => {
      await api('/fs/mkdir', 'POST', { host: hostId, path: full(name) });
      await list(cwd);
    });
  };

  const doNewFile = () => {
    const name = prompt('新文件名称：');
    if (!name) return;
    act(async () => {
      await api('/fs/newfile', 'POST', { host: hostId, path: full(name) });
      await list(cwd);
    });
  };

  const doRename = (name) => {
    const to = prompt('重命名为：', name);
    if (!to || to === name) return;
    act(async () => {
      await api('/fs/rename', 'POST', { host: hostId, from: full(name), to: full(to) });
      await list(cwd);
    });
  };

  const hostNameOf = (hid) => (hosts.find((h) => h.id === hid) || {}).name || hid;

  const doCopyOrCut = (op, names) => {
    const targetNames = names && names.length ? names : Array.from(sel);
    if (!targetNames.length) return;
    const targetSet = new Set(targetNames);
    const items = sorted
      .filter((e) => targetSet.has(e.name))
      .map((s) => ({
        host: hostId,
        path: full(s.name),
        name: s.name,
        type: s.type,
        op
      }));
    if (!items.length) return;
    setSel(new Set(targetNames));
    if (op === 'copy') {
      addFsClipboard('copy', items);
    } else {
      setFsClipboard('cut', items);
    }
  };

  const cancelClip = () => {
    clearFsClipboard();
    setClipPop(false);
  };

  const cancelClipItem = (itemHost, itemPath, ev) => {
    if (ev) ev.stopPropagation();
    removeFsClipboardItem(itemHost, itemPath);
  };

  // 通用粘贴函数：支持逐项展示跨机传输进度
  const pasteItems = (rawItems, targetDir = cwd, forceKind = null) => act(async () => {
    if (!rawItems || !rawItems.length || !targetDir) return;
    const isCurrentDir = targetDir === cwd;
    const exist = isCurrentDir ? new Set(entries.map((e) => e.name)) : new Set();
    const items = rawItems.map((it) => {
      const base = it.name || it.path.replace(/\/+$/, '').split('/').pop();
      let asName = base;
      let i = 2;
      while (exist.has(asName) && !(forceKind === 'cut' && it.host === hostId && it.path === targetDir.replace(/\/+$/, '') + '/' + asName)) {
        asName = `${base} (${i++})`;
      }
      exist.add(asName);
      return {
        host: it.host,
        path: it.path,
        kind: forceKind || it.op || fsClipboard.op || 'copy',
        asName,
        orig: it
      };
    });

    try {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const srcHostName = hostNameOf(it.host);
        setTransfer({
          title: `正在粘贴 (${i + 1}/${items.length}): ${it.asName}`,
          detail: `${srcHostName}:${it.path} → ${targetDir}`,
          pct: Math.round(((i + 0.2) / items.length) * 100),
          speed: it.host === hostId ? '本机快拷' : '跨机中转中…',
          canCancel: false
        });
        await api('/fs/paste', 'POST', {
          host: hostId,
          destDir: targetDir,
          items: [{ host: it.host, path: it.path, kind: it.kind, asName: it.asName }]
        });
        if (it.kind === 'cut') {
          removeFsClipboardItem(it.host, it.path);
        }
      }
    } finally {
      setTransfer(null);
    }
    setClipPop(false);
    await list(cwd);
  });

  const paste = () => {
    if (!fsClipboard.items.length) return;
    pasteItems(fsClipboard.items, cwd);
  };

  // 点击文件区域之外的任何地方 → 取消选中状态
  // （文件列表自己管理选中；按钮/输入框/菜单/弹窗等交互元素不在此列）
  useEffect(() => {
    if (!active) return;
    const onDocMouseDown = (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.fm-list, .fm-menu, .overlay, .fm-drag-handle, button, input, textarea, select, label, a, [contenteditable]')) return;
      setSel(new Set());
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [active]);

  // 快捷键支持：Ctrl+C 复制选中、Ctrl+X 剪切、Ctrl+V 粘贴、Ctrl+A 全选、Delete 删除
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e) => {
      if (editing || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        if (sel.size > 0) { e.preventDefault(); doCopyOrCut('copy'); }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
        if (sel.size > 0) { e.preventDefault(); doCopyOrCut('cut'); }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        if (fsClipboard.items.length > 0) { e.preventDefault(); paste(); }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        setSel(new Set(sorted.map((x) => x.name)));
      } else if (e.key === 'Delete' && sel.size > 0) {
        e.preventDefault();
        doDelete(Array.from(sel));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, sel, editing, sorted, hostId, cwd]);

  const doCompress = () => {
    const items = selPaths();
    if (!items.length) return;
    const name = prompt('压缩包名称（.tar.gz）：', items[0].name + '.tar.gz');
    if (!name) return;
    act(async () => {
      await api('/fs/compress', 'POST', { host: hostId, paths: items.map((s) => s.path), destFile: full(name) });
      await list(cwd);
    });
  };

  const doExtract = (name) => act(async () => {
    await api('/fs/extract', 'POST', { host: hostId, path: full(name), destDir: cwd });
    await list(cwd);
  });

  const download = (name) => {
    const a = document.createElement('a');
    a.href = `/api/fs/download?host=${encodeURIComponent(hostId)}&path=${encodeURIComponent(full(name))}`;
    a.download = name;
    a.click();
  };

  const openEditor = (name) => act(async () => {
    const r = await api(`/fs/read?host=${encodeURIComponent(hostId)}&path=${encodeURIComponent(full(name))}`);
    const rawBin = atob(r.data);
    if (rawBin.includes('\u0000')) {
      alert('这是二进制文件，不能直接文本编辑，请下载后处理。');
      return;
    }
    const text = b64ToUtf8(r.data);
    setEditing({ path: full(name), content: text, origContent: text, saving: false, savedTip: '' });
  });

  const saveEditor = async (closeAfter = false) => {
    if (!editing) return;
    setEditing((prev) => prev ? { ...prev, saving: true, savedTip: '' } : null);
    setErr('');
    try {
      const b64 = bufToB64(new TextEncoder().encode(editing.content));
      await api('/fs/write', 'POST', { host: hostId, path: editing.path, data: b64 });
      if (closeAfter) {
        setEditing(null);
        await list(cwd);
      } else {
        const now = new Date();
        const tStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
        setEditing((prev) => prev ? {
          ...prev,
          origContent: prev.content,
          saving: false,
          savedTip: `✓ 已保存 (${tStr})`
        } : null);
        list(cwd);
      }
    } catch (e) {
      setEditing((prev) => prev ? { ...prev, saving: false } : null);
      alert('保存失败: ' + e.message);
    }
  };

  // 分片上传：实时显示文件名、百分比、已传/总大小、速度 (MB/s)，并支持随时取消
  const doUpload = async (files, targetDir = cwd) => {
    if (!files || !files.length) return;
    const fileList = Array.from(files);
    const totalBytes = fileList.reduce((acc, f) => acc + f.size, 0);
    let uploadedBytes = 0;
    const startTs = Date.now();
    abortUploadRef.current = false;

    setErr('');
    setLoading(true);
    const CHUNK_SIZE = 1024 * 1024; // 1MB 分片，兼顾速度与实时进度刷新

    const fmtSpeed = (bytes, ms) => {
      const sec = Math.max(0.1, ms / 1000);
      const bps = bytes / sec;
      if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
      if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s';
      return Math.round(bps) + ' B/s';
    };

    try {
      for (let fIdx = 0; fIdx < fileList.length; fIdx++) {
        const f = fileList[fIdx];
        if (abortUploadRef.current) break;
        if (f.size > 500 * 1024 * 1024) {
          alert(`「${f.name}」超过 500MB，网页端单文件上限 500MB。`);
          continue;
        }
        if (f.size === 0) {
          setTransfer({
            title: `正在上传 (${fIdx + 1}/${fileList.length}): ${f.name}`,
            detail: `0 B / ${fmtSize(totalBytes, false)}`,
            pct: totalBytes ? Math.round((uploadedBytes / totalBytes) * 100) : 100,
            speed: fmtSpeed(uploadedBytes, Date.now() - startTs),
            canCancel: true
          });
          await api('/fs/upload-chunk', 'POST', { host: hostId, dir: targetDir, name: f.name, data: '', append: false });
          continue;
        }

        let offset = 0;
        let chunkIdx = 0;
        while (offset < f.size) {
          if (abortUploadRef.current) break;
          const end = Math.min(offset + CHUNK_SIZE, f.size);
          const slice = f.slice(offset, end);
          const buf = await slice.arrayBuffer();
          const b64 = bufToB64(buf);

          const pct = totalBytes > 0 ? Math.min(99, Math.round(((uploadedBytes + (end - offset) * 0.5) / totalBytes) * 100)) : 50;
          setTransfer({
            title: `正在上传 (${fIdx + 1}/${fileList.length}): ${f.name}`,
            detail: `${fmtSize(uploadedBytes, false)} / ${fmtSize(totalBytes, false)}`,
            pct,
            speed: fmtSpeed(uploadedBytes, Date.now() - startTs),
            canCancel: true
          });

          await api('/fs/upload-chunk', 'POST', {
            host: hostId,
            dir: targetDir,
            name: f.name,
            data: b64,
            append: chunkIdx > 0
          });

          offset = end;
          chunkIdx++;
          uploadedBytes += slice.size;

          setTransfer({
            title: `正在上传 (${fIdx + 1}/${fileList.length}): ${f.name}`,
            detail: `${fmtSize(uploadedBytes, false)} / ${fmtSize(totalBytes, false)}`,
            pct: totalBytes > 0 ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 100,
            speed: fmtSpeed(uploadedBytes, Date.now() - startTs),
            canCancel: true
          });
        }
      }
      await list(cwd);
    } catch (e) {
      setErr(e.message);
    } finally {
      setTransfer(null);
      setLoading(false);
    }
  };

  const openTrash = () => act(async () => {
    setTrashOpen(true);
    setTrashLoading(true);
    try {
      const r = await api(`/fs/trash?host=${encodeURIComponent(hostId)}`);
      setTrashItems(r.items || []);
    } finally {
      setTrashLoading(false);
    }
  });

  const trashRestore = (it) => act(async () => {
    await api('/fs/trash/restore', 'POST', { host: hostId, trashPath: it.trashPath, origPath: it.origPath });
    const r = await api(`/fs/trash?host=${encodeURIComponent(hostId)}`);
    setTrashItems(r.items || []);
    await list(cwd);
  });

  const trashPurge = (it) => act(async () => {
    await api('/fs/trash/purge', 'POST', { host: hostId, ...(it ? { trashPath: it.trashPath } : {}) });
    const r = await api(`/fs/trash?host=${encodeURIComponent(hostId)}`);
    setTrashItems(r.items || []);
  });

  // 处理拖放数据解析（来自折叠弹窗的剪贴板项 / 来自文件列表的行 / 来自外部桌面的文件）
  const handleDropToTarget = (ev, targetDir, targetFolderName = null) => {
    ev.preventDefault();
    ev.stopPropagation();
    setFmDrag(false);
    setDropFolder(null);
    setClipDragging(false);

    // 1. 检查是否是从折叠弹窗拖拽过来的复制项
    const clipRaw = ev.dataTransfer.getData('application/x-sp-clip-item');
    if (clipRaw) {
      try {
        const item = JSON.parse(clipRaw);
        if (item && item.host && item.path) {
          pasteItems([item], targetDir, 'copy');
          return;
        }
      } catch (_) {}
    }

    // 2. 检查是否是从文件列表拖拽过来的行（跨文件夹移动或跨标签页复制）
    const rowsRaw = ev.dataTransfer.getData('application/x-sp-fm-rows');
    if (rowsRaw) {
      try {
        const payload = JSON.parse(rowsRaw);
        if (payload && Array.isArray(payload.items) && payload.items.length) {
          if (payload.host === hostId && payload.cwd === targetDir) return;
          if (targetFolderName && payload.host === hostId && payload.cwd === cwd && payload.items.some((x) => x.name === targetFolderName)) {
            return;
          }
          const kind = payload.host === hostId ? 'cut' : 'copy';
          pasteItems(payload.items, targetDir, kind);
          return;
        }
      } catch (_) {}
    }

    // 3. 检查是否是操作系统本地拖入的文件上传
    if (ev.dataTransfer.files && ev.dataTransfer.files.length) {
      doUpload(ev.dataTransfer.files, targetDir);
    }
  };

  // 鼠标拖拽框选（Lasso Selection）
  // 起手范围：文件列表内部 + 列表左缘与面板边距之间的竖向空缝（与列表同高）。
  // 点击其他任何地方（document 级监听）取消选中。
  const onListMouseDown = (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest('.fm-toolbar, .fm-clip-wrap, .fm-clip-paths-dropdown, .fm-new-wrap, .fm-menu, .overlay, .modal, button, input')) {
      return;
    }
    const container = listRef.current;
    if (!container) return;

    const zoom = parseFloat(document.documentElement.style.zoom || '1') || 1;
    const rect = container.getBoundingClientRect();
    const inList = ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
    if (inList) {
      if (ev.clientX > rect.right - 14 * zoom || ev.clientY > rect.bottom - 14 * zoom) return;
      if (ev.target.closest('.fm-head')) return;
    } else {
      // 竖缝：列表左边缘与侧边间缝隙（与列表同高）
      if (ev.clientX >= rect.left || ev.clientY < rect.top || ev.clientY > rect.bottom) return;
    }

    const rowEl = ev.target.closest('.fm-row[data-name]');
    const rowName = rowEl ? rowEl.getAttribute('data-name') : null;
    if (ev.target.closest('.fm-drag-handle') || (rowName && sel.has(rowName) && !ev.ctrlKey && !ev.metaKey)) {
      return;
    }
    // 防止框选拖动时选中文本
    ev.preventDefault();

    const startClientX = ev.clientX;
    const startClientY = ev.clientY;
    const startScrollTop = container.scrollTop;
    const baseSel = ev.ctrlKey || ev.metaKey ? new Set(sel) : new Set();
    let isLassoing = false;
    let lastX = ev.clientX;
    let lastY = ev.clientY;
    let scrollTimer = null;

    // 拖到列表上下边缘时自动滚动
    const stopAutoScroll = () => {
      if (scrollTimer) { clearInterval(scrollTimer); scrollTimer = null; }
    };
    const autoScrollTick = () => {
      const z = parseFloat(document.documentElement.style.zoom || '1') || 1;
      const r = container.getBoundingClientRect();
      const zone = 28 * z;
      let dy = 0;
      if (lastY < r.top + zone) dy = -Math.max(2, Math.ceil((r.top + zone - lastY) / (5 * z)));
      else if (lastY > r.bottom - zone) dy = Math.max(2, Math.ceil((lastY - (r.bottom - zone)) / (5 * z)));
      if (!dy) return;
      container.scrollTop += dy;
      onMouseMove({ clientX: lastX, clientY: lastY });
    };
    const maybeAutoScroll = () => {
      stopAutoScroll();
      const z = parseFloat(document.documentElement.style.zoom || '1') || 1;
      const r = container.getBoundingClientRect();
      const zone = 28 * z;
      if (lastY < r.top + zone || lastY > r.bottom - zone) scrollTimer = setInterval(autoScrollTick, 16);
    };

    const onMouseMove = (moveEv) => {
      lastX = moveEv.clientX;
      lastY = moveEv.clientY;
      const dy = lastY - startClientY;
      if (!isLassoing && Math.abs(dy) < 5) return;
      isLassoing = true;
      maybeAutoScroll();

      const z = parseFloat(document.documentElement.style.zoom || '1') || 1;
      const curRect = container.getBoundingClientRect();
      const y1 = (startClientY - curRect.top) / z + startScrollTop;
      const y2 = (lastY - curRect.top) / z + container.scrollTop;

      // Explorer 样式框选：横向铺满列表宽度，纵向换算为未缩放逻辑坐标（避免 style.zoom 二次缩放导致错位）
      const left = 0;
      const top = Math.min(y1, y2);
      const width = container.clientWidth;
      const height = Math.abs(y2 - y1);
      setLasso({ left, top, width, height });

      const boxTop = Math.min(y1, y2);
      const boxBottom = Math.max(y1, y2);

      const nextSel = new Set(baseSel);
      const rows = container.querySelectorAll('.fm-row[data-name]');
      rows.forEach((r) => {
        const rTop = r.offsetTop;
        const rBottom = rTop + r.offsetHeight;
        const overlap = rTop < boxBottom && rBottom > boxTop;
        if (overlap) {
          const n = r.getAttribute('data-name');
          if (n) nextSel.add(n);
        }
      });
      setSel(nextSel);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      stopAutoScroll();
      if (isLassoing) {
        justLassoedRef.current = true;
        setLasso(null);
        setTimeout(() => { justLassoedRef.current = false; }, 80);
      } else if (!rowName && !ev.ctrlKey && !ev.metaKey) {
        setSel(new Set());
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const menuItems = () => {
    const m = [];
    if (menu?.name) {
      const e = entries.find((x) => x.name === menu.name);
      const targetNames = sel.has(menu.name) && sel.size > 1 ? Array.from(sel) : [menu.name];
      if (e?.type === 'd') {
        m.push({ label: '打开', fn: () => list(full(e.name)) });
        if (onOpenTerminalAt) {
          m.push({ label: '在此文件夹打开终端', fn: () => onOpenTerminalAt(hostId, full(e.name)) });
        }
      } else if (e) {
        m.push({ label: '编辑', fn: () => openEditor(e.name) });
        if (onOpenTerminalAt) {
          m.push({ label: '在当前目录打开终端', fn: () => onOpenTerminalAt(hostId, cwd) });
        }
      }
      if (e && /\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar|zip)$/i.test(e.name)) m.push({ label: '解压到当前目录', fn: () => doExtract(e.name) });
      if (e && e.type !== 'd') m.push({ label: '下载', fn: () => download(e.name) });
      m.push({ label: '重命名', fn: () => doRename(menu.name) });
      m.push({
        label: targetNames.length > 1 ? `复制（已选 ${targetNames.length} 项）` : '复制',
        fn: () => doCopyOrCut('copy', targetNames)
      });
      m.push({
        label: targetNames.length > 1 ? `剪切（已选 ${targetNames.length} 项）` : '剪切',
        fn: () => doCopyOrCut('cut', targetNames)
      });
      m.push({ label: '属性', fn: () => act(async () => {
        const r = await api(`/fs/stat?host=${encodeURIComponent(hostId)}&path=${encodeURIComponent(full(menu.name))}`);
        setPropsInfo(r);
      }) });
      m.push({
        label: targetNames.length > 1 ? `删除（已选 ${targetNames.length} 项）` : '删除',
        fn: () => doDelete(targetNames)
      });
    } else {
      if (onOpenTerminalAt) {
        m.push({ label: '在当前目录打开终端', fn: () => onOpenTerminalAt(hostId, cwd) });
      }
      m.push({ label: '新建文件夹', fn: doNewDir });
      m.push({ label: '新建文件', fn: doNewFile });
      if (clipN > 0) m.push({ label: `粘贴（${clipN} 项）`, fn: paste });
      m.push({ label: '上传文件', fn: () => uploadRef.current?.click() });
      m.push({ label: '刷新', fn: () => list(cwd) });
    }
    return m;
  };

  const clipN = clipState.items.length;
  const pasteDisabled = clipN === 0;

  return (
    <div className="fm-wrap" onMouseDown={onListMouseDown}>
      <div className="fm-toolbar">
        <button className="btn btn-sm" title="上一级" onClick={() => list(cwd.replace(/\/[^/]*\/?$/, '') || '/')}>↑</button>
        <button className="btn btn-sm" title="刷新" onClick={() => list(cwd)}>刷新</button>
        <input
          className="fm-path"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && pathInput.startsWith('/')) list(pathInput.replace(/\/+$/, '') || '/'); }}
          title="输入绝对路径回车跳转"
        />
        {onOpenTerminalAt && (
          <button
            className="btn btn-sm"
            title={`在当前目录 (${cwd || '/'}) 打开终端`}
            onClick={() => onOpenTerminalAt(hostId, cwd || '/')}
          >
            &gt;_ 终端
          </button>
        )}
        <div className="fm-new-wrap">
          <button className="btn btn-sm" onClick={() => setNewMenu(!newMenu)}>＋ 新建</button>
          {newMenu && (
            <div className="fm-new-menu" onMouseDown={(e) => e.stopPropagation()}>
              <button className="fm-menu-item" onClick={() => { setNewMenu(false); doNewDir(); }}>文件夹</button>
              <button className="fm-menu-item" onClick={() => { setNewMenu(false); doNewFile(); }}>文件</button>
            </div>
          )}
        </div>
        <button className="btn btn-sm" onClick={() => uploadRef.current?.click()}>上传</button>
        <input ref={uploadRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { doUpload(e.target.files); e.target.value = ''; }} />
        <button
          className="btn btn-sm"
          disabled={!sel.size}
          onClick={() => doCopyOrCut('copy')}
          onDragOver={(ev) => ev.preventDefault()}
          onDrop={(ev) => {
            ev.preventDefault();
            const rowsRaw = ev.dataTransfer.getData('application/x-sp-fm-rows');
            if (rowsRaw) {
              try {
                const payload = JSON.parse(rowsRaw);
                if (payload?.items?.length) addFsClipboard('copy', payload.items);
              } catch (_) {}
            }
          }}
          title="复制选中（支持把文件直接拖到此按钮加入复制池）"
        >
          复制
        </button>
        <button className="btn btn-sm" disabled={!sel.size} onClick={() => doCopyOrCut('cut')} title="剪切选中（可在其他标签页粘贴，含其他机器）">剪切</button>
        <button className="btn btn-sm" disabled={pasteDisabled} onClick={paste}>粘贴{clipN > 0 ? ` (${clipN})` : ''}</button>
        <button className="btn btn-sm" disabled={!sel.size} onClick={doCompress}>压缩</button>
        <button className="btn btn-sm" disabled={sel.size !== 1 || one()?.type === 'd'} onClick={() => { const o = one(); o && download(o.name); }}>下载</button>
        <button className="btn btn-sm" onClick={openTrash}>回收站</button>
        <button className="btn btn-sm" disabled={!sel.size} onClick={() => doDelete(Array.from(sel))}>删除</button>
        {clipN > 0 && (() => {
          const hostSet = new Set(clipState.items.map((it) => it.host));
          const firstIt = clipState.items[0];
          const firstHostName = firstIt ? hostNameOf(firstIt.host) : '';
          return (
            <div
              className="fm-clip-wrap"
              ref={clipWrapRef}
              onDragOver={(ev) => ev.preventDefault()}
              onDrop={(ev) => {
                ev.preventDefault();
                const rowsRaw = ev.dataTransfer.getData('application/x-sp-fm-rows');
                if (rowsRaw) {
                  try {
                    const payload = JSON.parse(rowsRaw);
                    if (payload?.items?.length) addFsClipboard('copy', payload.items);
                  } catch (_) {}
                }
              }}
            >
              <span className="fm-clip-tag">
                {clipState.op === 'cut' ? '已剪切' : '已复制'} {clipN} 项{hostSet.size > 1 ? `（跨 ${hostSet.size} 台机器）` : ` · ${firstHostName}`}:
              </span>
              <button
                type="button"
                className="fm-clip-path-btn"
                onClick={() => setClipPop(!clipPop)}
                title="点击展开/折叠路径列表（展开后可按住路径直接拖拽到文件列表中复制）"
              >
                <span className="fm-clip-single-path">
                  {hostSet.size > 1 ? `[${firstHostName}] ${firstIt?.path}` : firstIt?.path}
                </span>
                <span className="fm-clip-arrow">{clipPop ? '▴' : '▾'}</span>
              </button>
              <span className="fm-clip-note">（可到其他标签页/其他机器粘贴）</span>
              <button
                type="button"
                className="fm-clip-cancel"
                title="清空全部复制"
                onClick={cancelClip}
              >
                取消
              </button>

              {clipPop && (
                <div
                  className={'fm-clip-paths-dropdown' + (clipDragging ? ' dragging' : '')}
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {clipState.items.map((it, i) => (
                    <div
                      key={`${it.host}:${it.path}`}
                      className="fm-clip-path-line"
                      draggable
                      onMouseDown={(e) => e.stopPropagation()}
                      onDragStart={(ev) => {
                        ev.stopPropagation();
                        ev.dataTransfer.setData('application/x-sp-clip-item', JSON.stringify(it));
                        ev.dataTransfer.setData('text/plain', it.path);
                        ev.dataTransfer.effectAllowed = 'copy';
                        setClipDragging(true);
                      }}
                      onDragEnd={(ev) => {
                        ev.stopPropagation();
                        setClipDragging(false);
                      }}
                      title={`按住可拖拽到文件列表直接复制 · [${hostNameOf(it.host)}] ${it.path}`}
                    >
                      <span className="fm-clip-path-idx">{i + 1}.</span>
                      <span className="fm-clip-path-host">{hostNameOf(it.host)}</span>
                      <span className="fm-clip-path-text">{it.path}</span>
                      <button
                        type="button"
                        className="fm-clip-item-del"
                        title="取消复制此项"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => cancelClipItem(it.host, it.path, e)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* 实时传输进度条（分片上传 / 跨机粘贴） */}
      {transfer && (
        <div className="fm-transfer-bar">
          <div className="fm-transfer-info">
            <span className="fm-transfer-title">{transfer.title}</span>
            <span className="fm-transfer-detail">{transfer.detail}</span>
            <span className="fm-transfer-speed">{transfer.speed} · {transfer.pct}%</span>
            {transfer.canCancel && (
              <button
                className="btn btn-sm danger"
                onClick={() => { abortUploadRef.current = true; }}
              >取消</button>
            )}
          </div>
          <div className="fm-transfer-track">
            <div className="fm-transfer-fill" style={{ width: `${transfer.pct}%` }} />
          </div>
        </div>
      )}

      {err && (
        <div className="fm-err" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{err}</span>
          <button className="btn btn-sm" onClick={() => { setErr(''); if (!cwd) { api(`/fs/home?host=${encodeURIComponent(hostId)}`).then(r => list(r.home || '/')).catch(e => setErr(e.message)); } else { list(cwd); } }}>
            重试连接
          </button>
        </div>
      )}

      <div
        ref={listRef}
        className={'fm-list' + (fmDrag ? ' drag' : '')}
        onDragOver={(ev) => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'copy';
          if (!fmDrag) setFmDrag(true);
        }}
        onDragLeave={(ev) => {
          if (ev.currentTarget === ev.target || !ev.currentTarget.contains(ev.relatedTarget)) {
            setFmDrag(false);
            setDropFolder(null);
          }
        }}
        onDrop={(ev) => handleDropToTarget(ev, cwd, null)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, name: null });
        }}
      >
        <div className="fm-row fm-head">
          <span className="fm-name fm-sortable" onClick={() => toggleSort('name')} title="点击按名称排序 (升序/降序)">
            名称 {sortBy === 'name' && <span className="sort-arrow">{sortOrder === 'asc' ? '▲' : '▼'}</span>}
          </span>
          <span className="fm-size fm-sortable" onClick={() => toggleSort('size')} title="点击按大小排序 (升序/降序)">
            大小 {sortBy === 'size' && <span className="sort-arrow">{sortOrder === 'asc' ? '▲' : '▼'}</span>}
          </span>
          <span className="fm-time fm-sortable" onClick={() => toggleSort('mtime')} title="点击按修改时间排序 (最新/最早)">
            修改时间 {sortBy === 'mtime' && <span className="sort-arrow">{sortOrder === 'asc' ? '▲' : '▼'}</span>}
          </span>
        </div>
        {loading && !transfer && <div className="fm-loading">加载中…</div>}
        {!loading && sorted.length === 0 && <div className="fm-loading">空目录（可将文件或折叠列表中的路径拖放到此处）</div>}
        {sorted.map((e) => {
          const isSelected = sel.has(e.name);
          const isDropTarget = dropFolder === e.name && e.type === 'd';
          return (
            <div
              key={e.name}
              data-name={e.name}
              className={'fm-row' + (isSelected ? ' on' : '') + (isDropTarget ? ' drop-target' : '')}
              draggable={isSelected}
              onDragStart={(ev) => {
                const dragNames = sel.has(e.name) ? Array.from(sel) : [e.name];
                if (!sel.has(e.name)) setSel(new Set([e.name]));
                const dragItems = sorted
                  .filter((x) => dragNames.includes(x.name))
                  .map((x) => ({ host: hostId, path: full(x.name), name: x.name, type: x.type, op: 'copy' }));
                ev.dataTransfer.setData('application/x-sp-fm-rows', JSON.stringify({ host: hostId, cwd, items: dragItems }));
                if (e.type !== 'd' && dragItems.length === 1) {
                  const url = `${location.origin}/api/fs/download?host=${encodeURIComponent(hostId)}&path=${encodeURIComponent(full(e.name))}`;
                  ev.dataTransfer.setData('DownloadURL', `application/octet-stream:${e.name}:${url}`);
                  ev.dataTransfer.setData('text/uri-list', url);
                }
                ev.dataTransfer.setData('text/sp-fm-name', e.name);
                ev.dataTransfer.effectAllowed = 'copyMove';
              }}
              onDragOver={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (e.type === 'd') {
                  if (dropFolder !== e.name) setDropFolder(e.name);
                } else {
                  if (dropFolder) setDropFolder(null);
                }
              }}
              onDragLeave={(ev) => {
                if (e.type === 'd' && !ev.currentTarget.contains(ev.relatedTarget)) {
                  if (dropFolder === e.name) setDropFolder(null);
                }
              }}
              onDrop={(ev) => {
                if (e.type === 'd') {
                  handleDropToTarget(ev, full(e.name), e.name);
                } else {
                  handleDropToTarget(ev, cwd, null);
                }
              }}
              onClick={(ev) => {
                if (justLassoedRef.current) return;
                setSel((prev) => {
                  const next = ev.ctrlKey || ev.metaKey ? new Set(prev) : new Set();
                  next.has(e.name) && (ev.ctrlKey || ev.metaKey) ? next.delete(e.name) : next.add(e.name);
                  return next;
                });
              }}
              onDoubleClick={() => { e.type === 'd' ? list(full(e.name)) : openEditor(e.name); }}
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (!sel.has(e.name)) setSel(new Set([e.name]));
                setMenu({ x: ev.clientX, y: ev.clientY, name: e.name });
              }}
            >
              <span className="fm-name">
                <span
                  className="fm-drag-handle"
                  draggable
                  onDragStart={(ev) => {
                    ev.stopPropagation();
                    const dragNames = sel.has(e.name) ? Array.from(sel) : [e.name];
                    if (!sel.has(e.name)) setSel(new Set([e.name]));
                    const dragItems = sorted
                      .filter((x) => dragNames.includes(x.name))
                      .map((x) => ({ host: hostId, path: full(x.name), name: x.name, type: x.type, op: 'copy' }));
                    ev.dataTransfer.setData('application/x-sp-fm-rows', JSON.stringify({ host: hostId, cwd, items: dragItems }));
                    if (e.type !== 'd' && dragItems.length === 1) {
                      const url = `${location.origin}/api/fs/download?host=${encodeURIComponent(hostId)}&path=${encodeURIComponent(full(e.name))}`;
                      ev.dataTransfer.setData('DownloadURL', `application/octet-stream:${e.name}:${url}`);
                      ev.dataTransfer.setData('text/uri-list', url);
                    }
                    ev.dataTransfer.setData('text/sp-fm-name', e.name);
                    ev.dataTransfer.effectAllowed = 'copyMove';
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }}>
                    {e.type === 'd'
                      ? <path d="M1.5 3.5h4.6l1.4 1.8h7v7.2a1.3 1.3 0 0 1-1.3 1.3H2.8a1.3 1.3 0 0 1-1.3-1.3V3.5z" fill="none" stroke="#e2a85c" strokeWidth="1.4" strokeLinejoin="round" />
                      : <g><path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="#8b93a3" strokeWidth="1.4" strokeLinejoin="round" /><path d="M9.5 1.5v3h3" fill="none" stroke="#8b93a3" strokeWidth="1.2" /></g>}
                  </svg>
                  {e.name}
                </span>
              </span>
              <span className="fm-size">{fmtSize(e.size, e.type === 'd')}</span>
              <span className="fm-time">{fmtTime(e.mtime)}</span>
            </div>
          );
        })}
        {lasso && (
          <div
            className="fm-lasso"
            style={{
              left: lasso.left,
              top: lasso.top,
              width: lasso.width,
              height: lasso.height
            }}
          />
        )}
      </div>

      {trashOpen && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setTrashOpen(false)}>
          <div className="modal fm-trash-modal">
            <div className="modal-title">回收站（删除的文件在这里，可恢复）</div>
            <div className="fm-trash-list">
              {trashLoading && <div className="fm-loading">加载中…</div>}
              {!trashLoading && trashItems.length === 0 && <div className="fm-loading">回收站是空的</div>}
              {trashItems.map((it) => (
                <div key={it.trashPath} className="fm-trash-row">
                  <div className="fm-trash-info">
                    <div className="fm-trash-name">{it.name}</div>
                    <div className="fm-trash-orig">{it.origPath}</div>
                  </div>
                  <button className="btn btn-sm" onClick={() => trashRestore(it)}>恢复</button>
                  <button className="btn btn-sm danger" onClick={() => { if (confirm('彻底删除「' + it.name + '」？不可恢复')) trashPurge(it); }}>彻底删除</button>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              {trashItems.length > 0 && <button className="btn danger" onClick={() => { if (confirm('清空回收站？全部彻底删除，不可恢复')) trashPurge(null); }}>清空回收站</button>}
              <button className="btn" onClick={() => setTrashOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {menu && (
        <div
          className="fm-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(ev) => ev.stopPropagation()}
        >
          {menuItems().map((it) => (
            <button
              key={it.label}
              className="fm-menu-item"
              onMouseDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => {
                ev.stopPropagation();
                setMenu(null);
                it.fn();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}

      {propsInfo && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setPropsInfo(null)}>
          <div className="modal fm-props">
            <div className="modal-title">属性</div>
            <div className="fm-props-grid">
              <span>名称</span><span>{propsInfo.name}</span>
              <span>路径</span><span>{propsInfo.path}</span>
              <span>大小</span><span>{propsInfo.size < 1024 ? propsInfo.size + ' B' : propsInfo.size < 1048576 ? (propsInfo.size / 1024).toFixed(1) + ' KB' : propsInfo.size < 1073741824 ? (propsInfo.size / 1048576).toFixed(1) + ' MB' : (propsInfo.size / 1073741824).toFixed(2) + ' GB'}</span>
              <span>权限</span><span>{propsInfo.perms}（{propsInfo.permsOctal}）</span>
              <span>所有者</span><span>{propsInfo.owner} : {propsInfo.group}</span>
              <span>修改时间</span><span>{new Date(propsInfo.mtime).toLocaleString()}</span>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setPropsInfo(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {editing && (() => {
        const isDirty = editing.content !== editing.origContent;
        const lineCount = Math.max(1, editing.content.split('\n').length);
        const hasCrlf = editing.content.includes('\r\n');
        const closeEditor = () => {
          if (isDirty && !confirm('文件有未保存的修改，确定放弃修改并关闭吗？')) return;
          setEditing(null);
        };
        return (
          <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeEditor()}>
            <div className="modal fm-editor">
              <div className="fm-editor-hdr">
                <div className="fm-editor-title">
                  <span>{editing.path}</span>
                  {isDirty && <span className="fm-editor-dirty">● 未保存</span>}
                  {!isDirty && editing.savedTip && <span className="fm-editor-saved">{editing.savedTip}</span>}
                </div>
                <div className="fm-editor-meta">
                  <span>{lineCount} 行 · {editing.content.length} 字符</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    title="点击切换 LF / CRLF 换行符（Linux 脚本推荐使用 LF）"
                    onClick={() => {
                      const nextContent = hasCrlf
                        ? editing.content.replace(/\r\n/g, '\n')
                        : editing.content.replace(/\r?\n/g, '\r\n');
                      setEditing({ ...editing, content: nextContent, savedTip: '' });
                    }}
                  >
                    换行: {hasCrlf ? 'CRLF (点此转LF)' : 'LF'}
                  </button>
                </div>
              </div>

              <div className="fm-editor-body">
                <div className="fm-editor-gutter" ref={editorGutterRef}>
                  {Array.from({ length: lineCount }, (_, i) => (
                    <div key={i + 1}>{i + 1}</div>
                  ))}
                </div>
                <textarea
                  ref={editorTextareaRef}
                  className="fm-editor-text"
                  value={editing.content}
                  onChange={(e) => setEditing({ ...editing, content: e.target.value, savedTip: '' })}
                  onScroll={(e) => {
                    if (editorGutterRef.current) {
                      editorGutterRef.current.scrollTop = e.target.scrollTop;
                    }
                  }}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                      e.preventDefault();
                      saveEditor(false);
                    } else if (e.key === 'Tab') {
                      e.preventDefault();
                      const ta = e.target;
                      const start = ta.selectionStart;
                      const end = ta.selectionEnd;
                      const next = editing.content.slice(0, start) + '  ' + editing.content.slice(end);
                      setEditing({ ...editing, content: next, savedTip: '' });
                      requestAnimationFrame(() => {
                        ta.selectionStart = ta.selectionEnd = start + 2;
                      });
                    }
                  }}
                  spellCheck={false}
                />
              </div>

              <div className="modal-actions">
                <button className="btn" onClick={closeEditor}>关闭</button>
                <button className="btn" disabled={editing.saving} onClick={() => saveEditor(false)}>
                  {editing.saving ? '保存中…' : '保存 (Ctrl+S)'}
                </button>
                <button className="btn primary" disabled={editing.saving} onClick={() => saveEditor(true)}>
                  保存并关闭
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
