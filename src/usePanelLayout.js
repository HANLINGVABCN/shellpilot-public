import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const DEFAULT_WIDTHS = { side: 244, chat: 390 };
const MIN_WIDTHS = { side: 200, chat: 270 };
const MAIN_MIN = 340;
const DIVIDER_WIDTH = 5;
const WIDTHS_KEY = 'shellpilot-widths';
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function readWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) || '{}');
    return Object.fromEntries(Object.entries(DEFAULT_WIDTHS).map(([key, fallback]) => [key,
      Number.isFinite(saved?.[key]) && saved[key] > 0
        ? clamp(saved[key], MIN_WIDTHS[key], Number.MAX_SAFE_INTEGER) : fallback
    ]));
  } catch { return { ...DEFAULT_WIDTHS }; }
}

function readZoom() {
  try {
    const value = Number(localStorage.getItem('shellpilot-zoom') || '1');
    return Number.isFinite(value) && value > 0 ? clamp(value, .7, 1.5) : 1;
  } catch { return 1; }
}

// 窗口临时变窄只收缩显示宽度，恢复窗口时仍使用用户原来的偏好。
function fitWidths(preferred, available, visible) {
  const keys = ['side', 'chat'].filter((key) => visible[key]);
  const minTotal = keys.reduce((sum, key) => sum + MIN_WIDTHS[key], 0);
  const extra = keys.reduce((sum, key) => sum + preferred[key] - MIN_WIDTHS[key], 0);
  const room = Math.max(0, available - MAIN_MIN - keys.length * DIVIDER_WIDTH - minTotal);
  const ratio = extra > room ? room / extra : 1;
  return Object.fromEntries(Object.keys(preferred).map((key) => [key,
    visible[key] ? MIN_WIDTHS[key] + (preferred[key] - MIN_WIDTHS[key]) * ratio : preferred[key]
  ]));
}

export default function usePanelLayout({ android, sidebarOpen, chatOpen }) {
  const [preferred, setPreferred] = useState(readWidths);
  const [requestedZoom, setRequestedZoom] = useState(readZoom);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const resizeRef = useRef(null);
  const visible = { side: sidebarOpen, chat: chatOpen };
  const minimum = MAIN_MIN + (sidebarOpen ? MIN_WIDTHS.side + DIVIDER_WIDTH : 0)
    + (chatOpen ? MIN_WIDTHS.chat + DIVIDER_WIDTH : 0);
  const zoom = android ? 1 : Math.min(requestedZoom, Math.max(1, viewportWidth) / minimum);
  const available = Math.max(1, viewportWidth) / zoom;
  const widths = android ? preferred : fitWidths(preferred, available, visible);

  useLayoutEffect(() => {
    const html = document.documentElement;
    html.style.zoom = String(zoom);
    html.style.setProperty('--sp-ui-zoom', String(zoom));
    html.style.setProperty('--sp-main-min-width', `${MAIN_MIN}px`);
  }, [zoom]);

  useEffect(() => {
    let frame;
    const resize = () => {
      resizeRef.current?.finish('commit');
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setViewportWidth(window.innerWidth));
    };
    const changeZoom = () => {
      resizeRef.current?.finish('commit');
      setRequestedZoom(readZoom());
    };
    window.addEventListener('resize', resize);
    window.addEventListener('shellpilot-zoom', changeZoom);
    return () => {
      cancelAnimationFrame(frame);
      resizeRef.current?.finish('dispose');
      window.removeEventListener('resize', resize);
      window.removeEventListener('shellpilot-zoom', changeZoom);
    };
  }, []);

  useEffect(() => {
    resizeRef.current?.finish('commit');
  }, [sidebarOpen, chatOpen, android]);

  const beginResize = (event, which) => {
    if (android || event.button !== 0 || !event.isPrimary) return;
    resizeRef.current?.finish('commit');
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const scale = Number(getComputedStyle(document.documentElement).zoom) || 1;
    const availableNow = document.getElementById('app').getBoundingClientRect().width / scale;
    const other = which === 'side' ? 'chat' : 'side';
    const dividerTotal = (Number(sidebarOpen) + Number(chatOpen)) * DIVIDER_WIDTH;
    const budget = availableNow - MAIN_MIN - dividerTotal;
    const max = Math.max(MIN_WIDTHS[which], budget - (visible[other] ? MIN_WIDTHS[other] : 0));
    const original = preferred;
    const startWidths = widths;
    let nextX = startX, lastWidths = startWidths, frame = null, changed = false, ended = false;

    const flush = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      // clientX 是屏幕坐标；面板宽度是缩放前的 CSS 尺寸。
      const delta = (nextX - startX) / scale;
      const width = clamp(startWidths[which] + (which === 'chat' ? -delta : delta), MIN_WIDTHS[which], max);
      const previousWidths = lastWidths;
      lastWidths = { ...startWidths, [which]: width };
      if (visible[other]) lastWidths[other] = Math.max(MIN_WIDTHS[other], Math.min(startWidths[other], budget - width));
      if (['side', 'chat'].some((key) => Math.abs(lastWidths[key] - previousWidths[key]) > .01)) {
        changed = true;
        setPreferred(lastWidths);
      }
    };
    const move = (ev) => {
      if (ev.pointerId !== pointerId) return;
      nextX = ev.clientX;
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    const finish = (mode = 'commit') => {
      if (ended) return;
      ended = true;
      if (mode === 'commit' && frame !== null) flush();
      else if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', keydown, true);
      target.removeEventListener('lostpointercapture', blur);
      resizeRef.current = null;
      document.body.classList.remove('dragging');
      try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId); } catch {}
      if (mode === 'cancel' && changed) setPreferred(original);
      if (mode === 'commit' && changed) {
        try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(lastWidths)); } catch {}
      }
    };
    const up = (ev) => { if (ev.pointerId === pointerId) finish(); };
    const blur = () => finish();
    const keydown = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish('cancel'); }
    };
    resizeRef.current = { finish };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', keydown, true);
    target.addEventListener('lostpointercapture', blur);
    document.body.classList.add('dragging');
    try { target.setPointerCapture(pointerId); } catch {}
  };

  return { sideW: widths.side, chatW: widths.chat, beginResize };
}
