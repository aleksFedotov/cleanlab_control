'use client';

// «История статусов» — вертикальный таймлайн (спека §5): точка цвета статуса +
// подпись + время в mono. Источники — поля started_at/done_at/issued_at/deferred_from.
import { timeOf } from '@/lib/dates';
import type { DayWash } from '@/types/api';
import styles from './wash-id.module.css';

interface Entry {
  key: string;
  label: string;
  time: string;
  tone: 'ok' | 'wash' | 'warn' | 'neutral';
  sub?: string;
}

export function StatusTimeline({ w }: { w: DayWash }) {
  const entries: Entry[] = [];

  if (w.deferred_from) {
    entries.push({
      key: 'deferred',
      label: `Перенесена с ${w.deferred_from}`,
      time: '',
      tone: 'warn',
      sub: w.deferred_reason || undefined,
    });
  }
  if (w.started_at) {
    entries.push({ key: 'started', label: 'В работе', time: timeOf(w.started_at), tone: 'wash' });
  }
  if (w.done_at) {
    const label =
      w.status === 'no_linen'
        ? 'Проверено: белья нет'
        : w.status === 'ready_clean'
          ? 'Проверено: чистое на складе'
          : w.status === 'partial'
            ? 'Завершено частично'
            : 'Готово';
    entries.push({
      key: 'done',
      label,
      time: timeOf(w.done_at),
      tone: w.status === 'partial' ? 'warn' : 'ok',
    });
  }
  if (w.issued_at) {
    entries.push({ key: 'issued', label: 'Выдано', time: timeOf(w.issued_at), tone: 'neutral' });
  }

  if (!entries.length) {
    return <div className={styles.meta}>Событий пока нет</div>;
  }

  return (
    <div className={styles.timeline}>
      {entries.map((e) => (
        <div key={e.key} className={styles.tlItem}>
          <span className={styles.tlDot} data-tone={e.tone} />
          <div className={styles.tlBody}>
            <span>{e.label}</span>
            {e.time && <span className={styles.tlTime}>{e.time}</span>}
            {e.sub && <span className={styles.tlSub}>Причина: {e.sub}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
