'use client';

// P8: блок «Сейчас по учёту» в модалке проверки склада — цифры клиента
// до выбора вердикта: чистое (кг · шт · меш.) и число грязных партий
// (веса у грязного нет — появляется при взвешивании на старте стирки).
import { plural } from '@/lib/format';
import type { DayWash } from '@/types/api';
import styles from './StorageAccountSummary.module.css';

export function StorageAccountSummary({ storage: s }: { storage: DayWash['storage'] }) {
  const cleanParts =
    s.clean > 0
      ? [
          s.clean_kg > 0 ? `${s.clean_kg} кг` : '',
          s.clean_items > 0 ? `${s.clean_items} шт` : '',
          s.clean_bags > 0 ? `${s.clean_bags} меш.` : '',
        ].filter(Boolean)
      : [];
  const cleanText = cleanParts.length > 0 ? cleanParts.join(' · ') : 'нет';
  const dirtyText = s.dirty > 0 ? `${s.dirty} ${plural(s.dirty, 'партия', 'партии', 'партий')}` : 'нет';

  return (
    <div className={styles.box}>
      <div className={styles.title}>Сейчас по учёту</div>
      <div className={styles.row}>
        Чистое: <b>{cleanText}</b>
      </div>
      <div className={styles.row}>
        Грязное: <b>{dirtyText}</b>
      </div>
    </div>
  );
}
