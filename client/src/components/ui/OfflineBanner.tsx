'use client';

import { useUiStore } from '@/stores/ui';
import styles from './OfflineBanner.module.css';

export function OfflineBanner() {
  const offline = useUiStore((s) => s.offline);
  if (!offline) return null;
  return (
    <div className={styles.banner}>Нет соединения, данные могут быть неактуальны</div>
  );
}
