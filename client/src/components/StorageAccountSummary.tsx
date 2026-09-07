'use client';

// P8: блок «По учёту» в модалке проверки склада — цифры клиента
// до выбора вердикта: чистое (кг · шт · меш.) и число грязных партий
// (веса у грязного нет — появляется при взвешивании на старте стирки).
// Раскрывашка «Детально по типам» — разбивка чистого из стирок
// (clean_detail); если чистое внесено только вручную — её нет.
import { PackageCheck, PackageX, ChevronRight } from 'lucide-react';
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
  const detail = s.clean_detail || [];

  return (
    <div className={styles.box}>
      <div className={styles.title}>По учёту</div>
      <div className={styles.rows}>
        <div className={styles.row}>
          <PackageCheck size={16} className={styles.iconClean} aria-hidden />
          <span>
            Чистое: <b>{cleanText}</b>
          </span>
        </div>
        <div className={styles.row}>
          <PackageX size={16} className={styles.iconDirty} aria-hidden />
          <span>
            Грязное: <b>{dirtyText}</b>
          </span>
        </div>
      </div>
      {s.clean > 0 && detail.length > 0 && (
        <details className={styles.details}>
          <summary className={styles.summary}>
            <span>Детально по типам</span>
            <span className={styles.summaryCount}>
              ({detail.length} {plural(detail.length, 'тип', 'типа', 'типов')})
            </span>
            <ChevronRight size={16} className={styles.chevron} aria-hidden />
          </summary>
          <div className={styles.detailList}>
            {detail.map((d) => (
              <div key={d.name} className={styles.detailRow}>
                <span>{d.name}</span>
                <span className={styles.detailQty}>{d.qty}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
