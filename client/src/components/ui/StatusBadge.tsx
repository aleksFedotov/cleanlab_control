'use client';

import { statusInfo } from '@/lib/dicts';
import styles from './StatusBadge.module.css';

export interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const info = statusInfo(status);
  const cls = [styles.badge, styles[info.tone], size === 'sm' ? styles.sm : '']
    .filter(Boolean)
    .join(' ');
  return <span className={cls}>{info.label}</span>;
}
