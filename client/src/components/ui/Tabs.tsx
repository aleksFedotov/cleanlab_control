'use client';

// Подчёркнутые вкладки (P2.3): активная — --bluing + линия 2px снизу,
// опциональная серая подпись (сводка). На узких экранах — горизонтальный
// скролл без скроллбара (как FilterPills).
import styles from './Tabs.module.css';

export interface TabOption {
  key: string;
  label: string;
  hint?: string; // сводка 12px под/рядом с подписью, напр. «2 переопределены»
}

export interface TabsProps {
  options: TabOption[];
  active: string;
  onChange: (key: string) => void;
}

export function Tabs({ options, active, onChange }: TabsProps) {
  return (
    <div className={styles.tabs} role="tablist">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={o.key === active}
          className={`${styles.tab} ${o.key === active ? styles.active : ''}`}
          onClick={() => onChange(o.key)}
        >
          {o.label}
          {o.hint && <span className={styles.hint}> · {o.hint}</span>}
        </button>
      ))}
    </div>
  );
}
