'use client';

import { useUiStore } from '@/stores/ui';
import styles from './Toast.module.css';

export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);

  if (!toasts.length) return null;

  return (
    <div className={styles.host}>
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`${styles.toast} ${t.kind === 'err' ? styles.err : styles.ok}`}
          onClick={() => dismissToast(t.id)}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}
