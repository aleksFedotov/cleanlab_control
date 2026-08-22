'use client';

import { ReactNode } from 'react';
import styles from './Empty.module.css';

export interface EmptyProps {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}

export function Empty({ icon, title, hint, action }: EmptyProps) {
  return (
    <div className={styles.empty}>
      {icon && <div className={styles.iconWrap}>{icon}</div>}
      <div className={styles.title}>{title}</div>
      {hint && <div className={styles.hint}>{hint}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
