'use client';

import { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDateRu, formatWeekRu, mondayOf, shiftDateStr, todayStr } from '@/lib/dates';
import styles from './DateNav.module.css';

export interface DateNavProps {
  date: string; // 'yyyy-MM-dd'
  onChange: (date: string) => void;
  weekMode?: boolean;
}

export function DateNav({ date, onChange, weekMode = false }: DateNavProps) {
  const pickerRef = useRef<HTMLInputElement>(null);

  const step = weekMode ? 7 : 1;
  const isCurrent = weekMode ? mondayOf(date) === mondayOf(todayStr()) : date === todayStr();
  const label = weekMode ? formatWeekRu(mondayOf(date)) : formatDateRu(date);

  const openPicker = () => {
    const el = pickerRef.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker();
        return;
      } catch {
        // fallback ниже
      }
    }
    el.focus();
    el.click();
  };

  return (
    <div className={styles.nav}>
      <button
        type="button"
        className={styles.arrow}
        onClick={() => onChange(shiftDateStr(date, -step))}
        aria-label="Назад"
      >
        <ChevronLeft size={16} />
      </button>

      <button type="button" className={styles.date} onClick={openPicker} title="Выбрать дату">
        {label}
      </button>
      <input
        ref={pickerRef}
        type="date"
        className={styles.hiddenPicker}
        value={date}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        aria-hidden
        tabIndex={-1}
      />

      <button
        type="button"
        className={styles.arrow}
        onClick={() => onChange(shiftDateStr(date, step))}
        aria-label="Вперёд"
      >
        <ChevronRight size={16} />
      </button>

      <button
        type="button"
        className={styles.today}
        disabled={isCurrent}
        onClick={() => onChange(weekMode ? mondayOf(todayStr()) : todayStr())}
      >
        Сегодня
      </button>
    </div>
  );
}
