// 长按拖动排序列表的通用逻辑（侧边栏导航与工作台标签共用）
// 用法：createSortable({ getOrder, setOrder, containerRef, itemSelector, onDragStart, onDragEnd })
// 返回 mousedown 事件处理器。长按 300ms 或拖动 6px 进入排序模式，拖到目标项上实时换位。

export function loadOrder(key, defaultOrder) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (Array.isArray(saved)) {
      const merged = saved.filter((id) => defaultOrder.includes(id));
      for (const id of defaultOrder) if (!merged.includes(id)) merged.push(id);
      return merged;
    }
  } catch {}
  return [...defaultOrder];
}

export function createSortable({ getOrder, setOrder, containerRef, itemSelector, onDragStart, onDragEnd }) {
  return (id) => (e) => {
    e.preventDefault();
    let idx = getOrder().indexOf(id);
    if (idx < 0) return;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false, timer = null;

    const begin = () => {
      dragging = true;
      document.body.classList.add('sorting');
      onDragStart && onDragStart(id);
    };
    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) > 6 || Math.abs(ev.clientY - startY) > 6) begin();
        else return;
      }
      const els = [...(containerRef.current?.querySelectorAll(itemSelector) || [])];
      const t = els.findIndex((el) => {
        const r = el.getBoundingClientRect();
        return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      });
      if (t >= 0 && t !== idx) {
        const o = [...getOrder()];
        const [it] = o.splice(idx, 1);
        o.splice(t, 0, it);
        idx = t;
        setOrder(o);
      }
    };
    const up = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('sorting');
      onDragEnd && onDragEnd(dragging);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    timer = setTimeout(begin, 300);
  };
}

// 拖拽结束后短暂抑制下一次 click（防止拖完误触发点击跳转）
export function makeClickSuppressor() {
  const ref = { current: false };
  return {
    suppress: () => {
      ref.current = true;
      setTimeout(() => { ref.current = false; }, 60);
    },
    isSuppressed: () => ref.current
  };
}
