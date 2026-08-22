'use client';

// Мобильный каркас работника/водителя (спека §6): без сайдбара, одна колонка,
// шапка-контекст + приветствие + мини-статистики, нижняя навигация.
import styles from './MobileLayout.module.css';

export interface MobileStat {
  value: string | number;
  label: string;
  tone?: 'ok' | 'warn' | 'late' | 'default';
}

export interface MobileNavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
}

export function MobileLayout({
  contextLine,
  greeting,
  stats,
  nav,
  activeNav,
  onNav,
  children,
}: {
  contextLine: string;
  greeting: string;
  stats?: MobileStat[];
  nav: MobileNavItem[];
  activeNav: string;
  onNav: (key: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.context}>{contextLine}</div>
        <div className={styles.greeting}>{greeting}</div>
        {stats && stats.length > 0 && (
          <div className={styles.stats}>
            {stats.map((s) => (
              <div key={s.label} className={styles.stat}>
                <div className={`${styles.statValue} ${s.tone ? styles[`tone_${s.tone}`] : ''}`}>{s.value}</div>
                <div className={styles.statLabel}>{s.label}</div>
              </div>
            ))}
          </div>
        )}
      </header>
      <main className={styles.content}>{children}</main>
      <nav className={styles.bottomNav}>
        {nav.map((n) => (
          <button
            key={n.key}
            className={`${styles.navItem} ${n.key === activeNav ? styles.navActive : ''}`}
            onClick={() => onNav(n.key)}
          >
            <span className={styles.navIcon}>{n.icon}</span>
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// Метка секции (спека §6: 11px/700 uppercase, letter-spacing 1px)
export function MobileSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionLabel}>{label}</div>
      {children}
    </section>
  );
}
