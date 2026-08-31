'use client';

// Переиспользуемый аккордеон: заголовок-кнопка + сводка + контент.
// Состояние открытия персистится в ui store по id (где раскрыл — там и откроется).
import { ReactNode } from 'react';
import { useUiStore } from '@/stores/ui';
import styles from './Accordion.module.css';

export interface AccordionProps {
  id: string; // ключ персиста состояния
  title: string;
  summary?: string; // серая сводка в заголовке свёрнутой секции
  defaultOpen?: boolean;
  children?: ReactNode;
}

export function Accordion({ id, title, summary, defaultOpen = false, children }: AccordionProps) {
  const stored = useUiStore((s) => s.accordions[id]);
  const toggleAccordion = useUiStore((s) => s.toggleAccordion);
  const open = stored === undefined ? defaultOpen : stored;

  return (
    <div className={styles.accordion}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => toggleAccordion(id, defaultOpen)}
      >
        <span className={`${styles.arrow} ${open ? styles.arrowOpen : ''}`}>▸</span>
        <span className={styles.title}>{title}</span>
        {summary && <span className={styles.summary}>{summary}</span>}
      </button>
      {open && <div className={styles.body}>{children}</div>}
    </div>
  );
}
