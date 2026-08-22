'use client';

import { ReactNode } from 'react';
import styles from './StatCard.module.css';

export interface StatRowProps {
  children?: ReactNode;
}

export function StatRow({ children }: StatRowProps) {
  return <div className={styles.row}>{children}</div>;
}
