'use client';

// Карточка стирки на доске (порт cardHtml из legacy renderWashList,
// server/public/index.html:505-528). Клик → страница стирки.
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  MessageSquare,
  PackageX,
  Undo2,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { timeOf } from '@/lib/dates';
import { num } from '@/lib/format';
import type { DayWash } from '@/types/api';
import styles from './wash.module.css';

export function WashCard({ w }: { w: DayWash }) {
  const router = useRouter();

  // Метаданные строкой «кг · шт · меш.» — как в legacy
  const meta: string[] = [];
  if (w.dirty_weight_kg !== '' && w.dirty_weight_kg != null) meta.push(`${num(w.dirty_weight_kg)} кг`);
  if (w.items_total !== '' && w.items_total != null) meta.push(`${num(w.items_total)} шт`);
  if (num(w.bags) > 0) meta.push(`${num(w.bags)} меш.`);
  if (w.status === 'stored') meta.push(`выдача ${w.issue_date}`);

  return (
    <Card interactive className={styles.wcard} onClick={() => router.push('/wash/' + w.id)}>
      <div className={styles.wcardHead}>
        <div className={styles.nm}>{w.client_name}</div>
        <StatusBadge status={w.status} size="sm" />
      </div>
      {w.status === 'no_linen' && (
        <div className={`${styles.cm} ${styles.cmLate}`}>
          <PackageX size={13} /> Белья нет · проверено {timeOf(w.done_at)}
        </div>
      )}
      {w.status === 'ready_clean' && (
        <div className={`${styles.cm} ${styles.cmOk}`}>
          <CheckCircle2 size={13} /> Чистое бельё · проверено {timeOf(w.done_at)}
        </div>
      )}
      {w.partial_rest && (
        <div className={`${styles.cm} ${styles.cmWarn}`}>
          <AlertTriangle size={13} /> Частично постирано: готово{' '}
          {(w.prev_items || []).reduce((s, it) => s + it.qty, 0)} поз., {num(w.prev_kg)} кг,{' '}
          {num(w.prev_bags)} меш. — остаток грязный
        </div>
      )}
      {w.status === 'planned' && (
        <div className={`${styles.cm} ${w.has_dirty ? styles.cmWarn : ''}`}>
          {w.has_dirty
            ? 'Есть грязное — можно в работу'
            : w.has_clean
              ? 'Бельё уже чистое'
              : 'Нет белья на складе'}
        </div>
      )}
      {w.deferred_from && (
        <div className={styles.cm}>
          <Undo2 size={13} /> с {w.deferred_from}
        </div>
      )}
      {meta.length > 0 && <div className={styles.cm}>{meta.join(' · ')}</div>}
      {w.comment && (
        <div className={styles.cm}>
          <MessageSquare size={13} /> {w.comment}
        </div>
      )}
      {w.status === 'stored' && <div className={styles.cm}>На складе</div>}
      {w.status === 'partial' && (
        <div className={`${styles.cm} ${styles.cmWarn}`}>
          <AlertTriangle size={13} /> Частично — клиент не готов
        </div>
      )}
    </Card>
  );
}

// Призрак в режиме «по строкам»: имя + колонка назначения (legacy ghost)
export function GhostCard({ name, arrow }: { name: string; arrow: string }) {
  return (
    <Card className={`${styles.wcard} ${styles.ghost}`}>
      <div className={styles.nm}>{name}</div>
      <div className={styles.cm}>{arrow}</div>
    </Card>
  );
}
