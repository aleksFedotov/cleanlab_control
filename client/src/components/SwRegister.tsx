'use client';

// Регистрация service worker (PWA). Только в production, ошибки игнорируем —
// отсутствие SW не должно ломать приложение (обычный доступ через браузер сохраняется).
import { useEffect } from 'react';

export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    };
    window.addEventListener('load', onLoad);
    return () => window.removeEventListener('load', onLoad);
  }, []);
  return null;
}
