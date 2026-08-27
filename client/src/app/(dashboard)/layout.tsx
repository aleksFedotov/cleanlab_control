'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { useRequireRole } from '@/hooks/use-session';
import styles from './dashboard.module.css';

// Каркас владельца: сайдбар + хедер + контент. Guard: только owner.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = useRequireRole(['owner']);
  const pathname = usePathname();
  if (!session) return null; // редирект на /login внутри guard'а
  // «План» — широкая недельная доска: на десктопе отдаём ей всю ширину контента
  const wide = pathname.startsWith('/plan');
  return (
    <div className={styles.shell}>
      <Sidebar />
      <div className={styles.main}>
        <Header />
        <main className={`${styles.content} ${wide ? styles.contentWide : ''}`}>{children}</main>
      </div>
    </div>
  );
}
