'use client';

// «План» — недельная доска развоза (спека §5). Перенос renderWeek (server/public/index.html:1713-1837).
// Навигация по неделям — DateNav в хедере layout'а (weekMode); здесь только читаем date из стора.
// Сервер сам нормализует любой день недели до понедельника (res.monday).
import { useEffect, useState } from 'react';
import { CalendarOff, Copy, Plus } from 'lucide-react';
import { useApiMutation, useWeekPlan } from '@/hooks/use-api';
import { useSectionDate } from '@/hooks/use-section-date';
import { useUiStore } from '@/stores/ui';
import { WEEKDAYS, formatDateRu, isToday, todayStr, weekdayOf } from '@/lib/dates';
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
  // DnD: перетаскиваемая карточка (id + её текущая дата) и колонка под курсором
  const [drag, setDrag] = useState<{ id: string; date: string } | null>(null);
  const [overDate, setOverDate] = useState<string | null>(null);
  const moveMut = useApiMutation('moveWeekCard', { invalidate: 'operational' });

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

  // Drop в любой день, кроме текущего дня карточки, но не раньше сегодняшней даты
  const today = todayStr();
  const canDrop = (date: string) => !!drag && date !== drag.date && date >= today && !moveMut.isPending;

  async function handleDrop(date: string) {
    if (!drag || !canDrop(date)) return;
    const id = drag.id;
    setDrag(null);
    setOverDate(null);
    try {
      await moveMut.mutateAsync([id, date]);
      toast(`Перенесено на ${weekdayOf(date)}, ${formatDateRu(date)}`);
    } catch {
      // Текст ошибки уже показал useApiMutation
    }
  }

  return (
    <>
      <div className={styles.board}>
        {res.days.map((d, i) => (
          <section
            key={d.date}
            className={`${styles.col} ${isToday(d.date) ? styles.today : ''} ${
              overDate === d.date && canDrop(d.date) ? styles.dropTarget : ''
            }`}
            onDragOver={(e) => {
              if (canDrop(d.date)) {
                e.preventDefault(); // без этого drop не сработает
                e.dataTransfer.dropEffect = 'move';
                if (overDate !== d.date) setOverDate(d.date);
              }
            }}
            onDragLeave={() => {
              if (overDate === d.date) setOverDate(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(d.date);
            }}
          >
            <h3 className={styles.colHead}>
              {WEEKDAYS[i]}, {formatDateRu(d.date, false)}
            </h3>
            {d.cards.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`${styles.card} ${drag?.id === c.id ? styles.dragging : ''}`}
                onClick={() => setCard(c)}
                draggable={c.status === 'planned'}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', c.id);
                  setDrag({ id: c.id, date: c.date });
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOverDate(null);
                }}
              >
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
