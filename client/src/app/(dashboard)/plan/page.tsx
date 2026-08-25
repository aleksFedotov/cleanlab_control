'use client';

// «План» — недельная доска развоза (спека §5). Перенос renderWeek (server/public/index.html:1713-1837).
// Навигация по неделям — DateNav в хедере layout'а (weekMode); здесь только читаем date из стора.
// Сервер сам нормализует любой день недели до понедельника (res.monday).
import { useEffect, useState } from 'react';
import { CalendarOff, Copy, Plus } from 'lucide-react';
import { useWeekPlan } from '@/hooks/use-api';
import { useSectionDate } from '@/hooks/use-section-date';
import { useUiStore } from '@/stores/ui';
import { WEEKDAYS, formatDateRu, isToday } from '@/lib/dates';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Button } from '@/components/ui/Button';
import { Empty } from '@/components/ui/Empty';
import { Skeleton } from '@/components/ui/Skeleton';
import type { DecoratedVisit } from '@/types/api';
import { WeekAddDialog } from './week-add-dialog';
import { WeekCardDialog } from './week-card-dialog';
import { WeekCopyDialog } from './week-copy-dialog';
import styles from './plan.module.css';

export default function PlanPage() {
  const [date] = useSectionDate('plan');
  const q = useWeekPlan(date);
  const toast = useUiStore((s) => s.toast);
  const [addDate, setAddDate] = useState<string | null>(null);
  const [copyDate, setCopyDate] = useState<string | null>(null);
  const [card, setCard] = useState<DecoratedVisit | null>(null);

  // Ошибка API — тост (спека §7); блок «Повторить» — ниже, если данных нет вообще
  useEffect(() => {
    if (q.isError) toast(q.error.message || 'Ошибка загрузки плана', 'err');
  }, [q.isError, q.error, toast]);

  // Загрузка — скелетон, повторяющий сетку недели (спека §7)
  if (q.isPending) {
    return (
      <div className={styles.board}>
        {WEEKDAYS.map((w) => (
          <div key={w} className={styles.col}>
            <Skeleton height={14} width="55%" />
            <Skeleton height={54} radius={10} />
            <Skeleton height={54} radius={10} />
          </div>
        ))}
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <Empty
        icon={<CalendarOff size={28} />}
        title="Не удалось загрузить план"
        hint={q.error?.message}
        action={
          <Button variant="ghost" onClick={() => q.refetch()}>
            Повторить
          </Button>
        }
      />
    );
  }

  const res = q.data;
  const clients = res.clients || [];

  return (
    <>
      <div className={styles.board}>
        {res.days.map((d, i) => (
          <section key={d.date} className={`${styles.col} ${isToday(d.date) ? styles.today : ''}`}>
            <h3 className={styles.colHead}>
              {WEEKDAYS[i]}, {formatDateRu(d.date, false)}
            </h3>
            {d.cards.map((c) => (
              <button key={c.id} type="button" className={styles.card} onClick={() => setCard(c)}>
                <span className={styles.cardName}>{c.client_name}</span>
                <span className={styles.cardMeta}>
                  <StatusBadge status={c.status} size="sm" />
                  {(c.has_clean || c.has_dirty) && (
                    <span className={styles.cardFlags}>
                      {[c.has_clean ? 'чистое' : '', c.has_dirty ? 'грязное' : '']
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                </span>
              </button>
            ))}
            <button
              type="button"
              className={styles.add}
              onClick={() => {
                if (!clients.length) {
                  toast('Сначала добавьте клиента в Справочниках');
                  return;
                }
                setAddDate(d.date);
              }}
            >
              <Plus size={15} aria-hidden /> Добавить
            </button>
            <button type="button" className={styles.copy} onClick={() => setCopyDate(d.date)}>
              <Copy size={15} aria-hidden /> Копировать
            </button>
          </section>
        ))}
      </div>

      <WeekAddDialog
        date={addDate}
        clients={clients}
        cards={res.days.find((d) => d.date === addDate)?.cards || []}
        onClose={() => setAddDate(null)}
      />
      <WeekCopyDialog
        date={copyDate}
        cards={res.days.find((d) => d.date === copyDate)?.cards || []}
        onClose={() => setCopyDate(null)}
      />
      <WeekCardDialog card={card} onClose={() => setCard(null)} />
    </>
  );
}
