import React, { useEffect, useRef, useState } from 'react';

const compactScreen = () => window.matchMedia('(max-width: 760px)').matches;
const preferenceKey = (mobile) => `shellpilot-composer-height-${mobile ? 'mobile' : 'desktop'}`;
const defaultHeight = (mobile) => mobile ? 72 : 64;
const minimumHeight = (mobile) => mobile ? 48 : 40;
function savedHeight(mobile) {
  try {
    const saved = Number(localStorage.getItem(preferenceKey(mobile)));
    if (Number.isFinite(saved) && saved >= minimumHeight(mobile)) return saved;
  } catch {}
  return defaultHeight(mobile);
}

export default function ResizableChatInput({ value, onChange, onKeyDown, placeholder }) {
  const [mobile, setMobile] = useState(compactScreen);
  const [preferred, setPreferred] = useState(() => savedHeight(compactScreen()));
  const [maximum, setMaximum] = useState(Infinity);
  const textarea = useRef(null);
  const drag = useRef(null);
  const minimum = minimumHeight(mobile);
  const height = Math.max(minimum, Math.min(preferred, maximum));

  const persistHeight = (next) => {
    setPreferred(next);
    try { localStorage.setItem(preferenceKey(mobile), String(next)); } catch {}
  };
  const finishDrag = (event, save = true) => {
    const current = drag.current;
    if (!current || (event && event.pointerId !== current.pointerId)) return;
    drag.current = null;
    document.body.classList.remove('composer-resizing');
    if (current.edge.hasPointerCapture(current.pointerId)) current.edge.releasePointerCapture(current.pointerId);
    if (save) persistHeight(current.lastHeight);
  };

  useEffect(() => {
    const field = textarea.current;
    const panel = field.closest('.chat-panel');
    const history = panel.querySelector('.chat-list');
    let frame;
    const measure = () => {
      if (!panel.clientHeight || !field.offsetHeight || history.offsetParent === null) return;
      // Allow the composer to use the available space, leaving the conversation
      // and bottom actions reachable. No fixed 360px or viewport-percentage cap.
      const reserve = Math.min(96, panel.clientHeight * 0.2);
      const next = Math.max(minimum, field.offsetHeight + history.clientHeight - reserve);
      setMaximum((previous) => Math.abs(previous - next) < 1 ? previous : next);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(panel);
    observer.observe(history);
    schedule();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [minimum]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const changed = () => {
      finishDrag(null, false);
      setMobile(query.matches);
      setPreferred(savedHeight(query.matches));
    };
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  useEffect(() => () => {
    const current = drag.current;
    drag.current = null;
    document.body.classList.remove('composer-resizing');
    if (current?.edge.hasPointerCapture(current.pointerId)) current.edge.releasePointerCapture(current.pointerId);
  }, []);

  const startDrag = (event) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    const field = textarea.current;
    const logicalHeight = field.offsetHeight;
    const scale = field.getBoundingClientRect().height / logicalHeight || 1;
    const panel = field.closest('.chat-panel');
    const history = panel.querySelector('.chat-list');
    const available = Math.max(minimum, logicalHeight + history.clientHeight - Math.min(96, panel.clientHeight * 0.2));
    drag.current = { pointerId: event.pointerId, edge: event.currentTarget,
      startY: event.clientY, startHeight: logicalHeight, scale,
      maximum: available, minimum, lastHeight: logicalHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('composer-resizing');
  };
  const moveDrag = (event) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const next = Math.round(Math.max(current.minimum, Math.min(current.maximum,
      current.startHeight + (current.startY - event.clientY) / current.scale)));
    current.lastHeight = next;
    setPreferred(next);
  };
  const keyboardResize = (event) => {
    let next;
    if (event.key === 'ArrowUp') next = height + (event.shiftKey ? 32 : 8);
    else if (event.key === 'ArrowDown') next = height - (event.shiftKey ? 32 : 8);
    else if (event.key === 'Home') next = defaultHeight(mobile);
    else return;
    event.preventDefault();
    persistHeight(Math.max(minimum, Math.min(maximum, next)));
  };

  return <div className="chat-editor">
    <div className="chat-input-resize-edge" role="separator" tabIndex={0}
      aria-label="调整 AI 输入框高度" aria-orientation="horizontal"
      aria-valuemin={minimum} aria-valuemax={Number.isFinite(maximum) ? Math.floor(maximum) : undefined}
      aria-valuenow={Math.round(height)} title="拖动上边缘调整高度，双击恢复默认"
      onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag}
      onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
      onDoubleClick={() => persistHeight(defaultHeight(mobile))} onKeyDown={keyboardResize} />
    <textarea ref={textarea} rows={2} aria-label="AI 任务输入框" style={{ height }}
      value={value} placeholder={placeholder} onChange={onChange} onKeyDown={onKeyDown} />
  </div>;
}
