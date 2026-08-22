'use client';

import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { useRequireRole } from '@/hooks/use-session';
import styles from './dashboard.module.css';

// Каркас владельца: сайдбар + хедер + контент. Guard: только owner.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = useRequireRole(['owner']);
  if (!session) return null; // редирект на /login внутри guard'а
  return (
    <div className={styles.shell}>
      <Sidebar />
      <div className={styles.main}>
        <Header />
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}
