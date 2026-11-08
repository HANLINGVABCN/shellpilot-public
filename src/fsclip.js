// 文件管理跨标签页多源复制池：支持跨机器累加收集、单项取消、跨端拖放，且刷新网页状态不丢失
const CLIP_STORAGE_KEY = 'shellpilot-fs-clipboard';

const loadSavedClip = () => {
  try {
    const raw = localStorage.getItem(CLIP_STORAGE_KEY);
    if (!raw) return { op: 'copy', items: [] };
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) {
      return { op: parsed.op || 'copy', items: parsed.items };
    }
  } catch (_) {}
  return { op: 'copy', items: [] };
};

const initial = loadSavedClip();

export const fsClipboard = {
  op: initial.op,
  items: initial.items
};

const listeners = new Set();

function saveAndNotify() {
  try {
    localStorage.setItem(CLIP_STORAGE_KEY, JSON.stringify({ op: fsClipboard.op, items: fsClipboard.items }));
  } catch (_) {}
  listeners.forEach((fn) => {
    try {
      fn(fsClipboard);
    } catch (_) {}
  });
}

// 覆盖设置
export function setFsClipboard(op, items = []) {
  const kind = op || 'copy';
  fsClipboard.op = kind;
  fsClipboard.items = items.map((it) => ({ ...it, op: it.op || kind }));
  saveAndNotify();
}

// 追加收集（同 host + path 去重，更新其 op）
export function addFsClipboard(op, newItems = []) {
  const kind = op || 'copy';
  fsClipboard.op = kind;
  const map = new Map();
  for (const it of fsClipboard.items) {
    map.set(`${it.host}:${it.path}`, it);
  }
  for (const it of newItems) {
    map.set(`${it.host}:${it.path}`, { ...it, op: it.op || kind });
  }
  fsClipboard.items = Array.from(map.values());
  saveAndNotify();
}

// 单项取消
export function removeFsClipboardItem(host, path) {
  fsClipboard.items = fsClipboard.items.filter((it) => !(it.host === host && it.path === path));
  if (!fsClipboard.items.length) {
    fsClipboard.op = 'copy';
  }
  saveAndNotify();
}

// 清空全部
export function clearFsClipboard() {
  fsClipboard.items = [];
  fsClipboard.op = 'copy';
  saveAndNotify();
}

export function subscribeFsClipboard(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
