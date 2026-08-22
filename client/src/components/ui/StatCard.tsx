'use client';

import styles from './StatCard.module.css';

export interface StatCardProps {
  label: string;
  value: string | number;
  unit?: string;
  sub?: string;
  tone?: 'ok' | 'warn' | 'late' | 'default';
}

export function StatCard({ label, value, unit, sub, tone = 'default' }: StatCardProps) {
  const valueCls = [styles.value, tone !== 'default' ? styles[tone] : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={styles.card}>
      <div className={styles.label}>{label}</div>
      <div className={styles.valueRow}>
        <span className={valueCls}>{value}</span>
        {unit && <span className={styles.unit}>{unit}</span>}
      </div>
      {sub && <div className={`${styles.sub} ${tone !== 'default' ? styles[tone] : ''}`}>{sub}</div>}
    </div>
  );
}
