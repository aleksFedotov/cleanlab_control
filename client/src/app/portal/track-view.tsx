'use client';

// Трекинг сдачи (портал, тикет P1 этап 4): вертикальная цепочка клиентских
// статусов (пройденные заполнены, текущий подсвечен), даты событий. После
// завершения стирки — две колонки «Заявлено / Постирано»; до неё — подсказка,
// а не нули. Особые случаи: «Бельё не передано», «Сдача отменена» + комментарий.
import { Check } from 'lucide-react';
import { useClientTrack } from '@/hooks/use-api';
import { formatDateRu, timeOf } from '@/lib/dates';
import type { PortalRequest } from '@/types/api';
import styles from './portal.module.css';

function atLabel(at: string): string {
  if (!at) return '';
  const date = at.slice(0, 10);
  const time = timeOf(at);
  return `${formatDateRu(date, false)}${time ? ' · ' + time : ''}`;
}

export function TrackView({
  request,
  typeNames,
}: {
  request: PortalRequest;
  typeNames: Record<string, string>;
}) {
  const track = useClientTrack(request.id);

  if (track.isLoading) return <div className={styles.hint}>Загрузка трека…</div>;
  if (track.isError || !track.data) {
    return <div className={styles.hint}>Не удалось загрузить трек. Попробуйте ещё раз.</div>;
  }

  const { status, steps, fact } = track.data;
  const special = status.step === -1;

  return (
    <div className={styles.track} data-testid="track">
      <div className={styles.trackHead}>
        <span className={styles.trackStatus} data-testid="track-current">
          {status.label}
        </span>
        {status.note && <span className={styles.trackNote}>{status.note}</span>}
      </div>

      {special && status.key === 'cancelled' && status.note && (
        <div className={styles.roBox}>{status.note}</div>
      )}

      <ol className={styles.steps}>
        {steps.map((s) => (
          <li
            key={s.key}
            className={`${styles.step} ${s.done ? styles.stepDone : ''} ${s.current ? styles.stepCurrent : ''}`}
            data-done={s.done || undefined}
          >
            <span className={styles.stepDot}>{s.done && !s.current ? <Check size={12} /> : null}</span>
            <span className={styles.stepBody}>
              <span className={styles.stepLabel}>{s.label}</span>
              {s.at && <span className={styles.stepAt}>{atLabel(s.at)}</span>}
              {s.current && s.key === 'driver_coming' && (
                <span className={styles.stepAt}>сегодня</span>
              )}
            </span>
          </li>
        ))}
      </ol>

      <div className={styles.trackLabel}>Пересчёт</div>
      {fact ? (
        <div className={styles.fact} data-testid="track-fact">
          <div className={styles.factCol}>
            <div className={styles.factHead}>Заявлено</div>
            {request.items.map((it) => (
              <div key={it.item_type_id} className={styles.factRow}>
                <span>{typeNames[it.item_type_id] || it.item_type_id}</span>
                <span>×{Number(it.qty)}</span>
              </div>
            ))}
            {request.items.length === 0 && <div className={styles.factRow}>—</div>}
            {Number(request.bags) > 0 && (
              <div className={styles.factRow}>
                <span>Мешки</span>
                <span>{Number(request.bags)}</span>
              </div>
            )}
          </div>
          <div className={styles.factCol}>
            <div className={styles.factHead}>Постирано</div>
            {fact.items.map((it) => (
              <div key={it.item_type_id} className={styles.factRow}>
                <span>{it.name}</span>
                <span>×{it.qty}</span>
              </div>
            ))}
            {fact.items.length === 0 && <div className={styles.factRow}>—</div>}
            {fact.weight_kg != null && (
              <div className={styles.factRow}>
                <span>Вес</span>
                <span>{fact.weight_kg} кг</span>
              </div>
            )}
            {fact.bags != null && (
              <div className={styles.factRow}>
                <span>Мешки</span>
                <span>{fact.bags}</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.factPending}>После стирки здесь появится фактический пересчёт</div>
      )}
    </div>
  );
}
