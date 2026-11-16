import { useEffect, useState } from 'react';

// 按平台启用，桌面窗口缩窄时仍保留原有桌面布局。
export const isAndroidDevice = (userAgent = navigator.userAgent) => /Android/i.test(userAgent);

export function useAndroidViewport() {
  const [android] = useState(isAndroidDevice);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    if (!android) return;
    const html = document.documentElement;
    html.classList.add('sp-android');
    const viewport = window.visualViewport;
    let fullHeight = window.innerHeight;
    let lastWidth = window.innerWidth;
    let frame;
    const update = () => {
      // 保留用户的双指放大，不把缩放误判成软键盘。
      if (viewport && viewport.scale > 1.05) return;
      const height = viewport?.height || window.innerHeight;
      if (Math.abs(window.innerWidth - lastWidth) > 80) {
        fullHeight = window.innerHeight;
        lastWidth = window.innerWidth;
      }
      fullHeight = Math.max(fullHeight, window.innerHeight, height);
      const keyboard = fullHeight - height > 120;
      html.style.setProperty('--sp-viewport-height', `${height}px`);
      html.style.setProperty('--sp-viewport-top', `${viewport?.offsetTop || 0}px`);
      html.classList.toggle('sp-keyboard-open', keyboard);
      setKeyboardOpen(keyboard);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      html.classList.remove('sp-android', 'sp-keyboard-open');
      html.style.removeProperty('--sp-viewport-height');
      html.style.removeProperty('--sp-viewport-top');
    };
  }, [android]);

  return { android, keyboardOpen };
}
