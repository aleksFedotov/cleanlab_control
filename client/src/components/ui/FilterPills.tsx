'use client';

import styles from './FilterPills.module.css';

export interface FilterPillOption {
  key: string;
  label: string;
  count?: number;
}

export interface FilterPillsProps {
  options: FilterPillOption[];
  active: string;
  onChange: (key: string) => void;
}

export function FilterPills({ options, active, onChange }: FilterPillsProps) {
  return (
    <div className={styles.row}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`${styles.pill} ${o.key === active ? styles.active : ''}`}
          onClick={() => onChange(o.key)}
        >
          {o.label}
          {o.count !== undefined && <span className={styles.count}> · {o.count}</span>}
        </button>
      ))}
    </div>
  );
}
