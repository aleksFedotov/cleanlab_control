'use client';

// Страница «Стирка» — доска дня (перенос legacy renderDay/renderWashList,
// server/public/index.html:465-574). Дата — из хедера layout'а (useSectionDate).
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutGrid, Plus, Rows3, Waves } from 'lucide-react';
import { useDayList } from '@/hooks/use-api';
import { useSectionDate } from '@/hooks/use-section-date';
import { useUiStore } from '@/stores/ui';
import { Button } from '@/components/ui/Button';
import { Empty } from '@/components/ui/Empty';
import { Skeleton, SkeletonCards } from '@/components/ui/Skeleton';
import type { DayWash } from '@/types/api';
import { WashCard, GhostCard } from './WashCard';
import { AddWashModal } from './AddWashModal';
import { ShiftCloseDialog } from './ShiftCloseDialog';
import styles from './wash.module.css';

// Колонки доски — как в legacy renderWashList
const COLS: Array<{ key: string; title: string; match: (w: DayWash) => boolean }> = [
  { key: 'todo', title: 'К стирке', match: (w) => w.status === 'planned' },
  { key: 'doing', title: 'В работе', match: (w) => w.status === 'in_progress' },
  {
    key: 'done',
    title: 'Готово',
    match: (w) =>
      w.status === 'done' ||
      w.status === 'stored' ||
      w.status === 'partial' ||
      w.status === 'ready_clean' ||
      w.status === 'no_linen',
  },
];

const ARROWS = ['→ к стирке', '→ в работе', '→ готово'];

export default function WashPage() {
  const router = useRouter();
  const [date] = useSectionDate('wash');
  const { data, isPending, isError, error, refetch } = useDayList(date);
  const toast = useUiStore((s) => s.toast);
  const viewMode = useUiStore((s) => s.washViewMode);
  const setViewMode = useUiStore((s) => s.setWashViewMode);

  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);

  useEffect(() => {
    if (isError && error) toast(error.message || 'Ошибка загрузки', 'err');
  }, [isError, error, toast]);

  // Поиск по клиенту (legacy washSearch)
  const washes = useMemo(() => {
    const list = data?.washes || [];
    const q = search.trim().toLowerCase();
    return q ? list.filter((w) => w.client_name.toLowerCase().includes(q)) : list;
  }, [data, search]);

  if (isPending) {
    return (
      <div className={styles.page}>
        <Skeleton height={38} width={420} />
        <SkeletonCards count={6} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Empty
        icon={<Waves size={40} />}
        title="Не удалось загрузить данные"
        hint={error?.message || 'Проверьте связь.'}
        action={<Button onClick={() => refetch()}>Повторить</Button>}
      />
    );
  }

  const shiftClosed = !!data.shift && data.shift.status === 'closed';
  const colIdx = (w: DayWash) => COLS.findIndex((c) => c.match(w));

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <input
          className={styles.search}
          placeholder="Поиск по клиенту…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className={styles.viewToggle}>
          <button
            type="button"
            className={`${styles.viewBtn} ${viewMode === 'board' ? styles.on : ''}`}
            title="Списки по колонкам"
            onClick={() => setViewMode('board')}
          >
            <LayoutGrid size={15} /> Доска
          </button>
          <button
            type="button"
            className={`${styles.viewBtn} ${viewMode === 'list' ? styles.on : ''}`}
            title="Клиент держит свою строку"
            onClick={() => setViewMode('list')}
          >
            <Rows3 size={15} /> По строкам
          </button>
        </div>
        <div className={styles.toolbarSpacer} />
        <div className={styles.toolbarActions}>
          {shiftClosed ? (
            <span className={styles.shiftChip}>Смена закрыта в {data.shift!.closed_at}</span>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setCloseOpen(true)}>
              Закрыть смену
            </Button>
          )}
          <Button icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>
            Добавить стирку
          </Button>
        </div>
      </div>

      {washes.length === 0 ? (
        <Empty
          icon={<Waves size={40} />}
          title={search ? 'Ничего не найдено' : 'Стирок нет'}
          hint={search ? 'Попробуйте изменить запрос.' : `На ${data.date} стирок нет.`}
          action={
            !search ? (
              <Button icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>
                Добавить стирку
              </Button>
            ) : undefined
          }
        />
      ) : viewMode === 'list' ? (
        // Режим «по строкам»: каждый клиент держит свою строку, в пустых ячейках — призрак
        <div className={styles.rowsBoard}>
          {COLS.map((col) => (
            <div key={col.key} className={styles.colHead}>
              {col.title}
            </div>
          ))}
          {washes.map((w) => {
            const active = colIdx(w);
            return COLS.map((col, i) =>
              i === active ? (
                <WashCard key={`${w.id}-${i}`} w={w} />
              ) : (
                <GhostCard key={`${w.id}-${i}`} name={w.client_name} arrow={ARROWS[active] || ''} />
              )
            );
          })}
        </div>
      ) : (
        // Доска: три колонки-списка по статусам
        <div className={styles.board}>
          {COLS.map((col) => {
            const list = washes.filter(col.match);
            return (
              <div key={col.key}>
                <div className={styles.colHead}>
                  {col.title} <span className={styles.colCount}>({list.length})</span>
                </div>
                <div className={styles.colList}>
                  {list.length ? (
                    list.map((w) => <WashCard key={w.id} w={w} />)
                  ) : (
                    <div className={styles.colEmpty}>—</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {addOpen && <AddWashModal clients={data.clients || []} onClose={() => setAddOpen(false)} />}
      <ShiftCloseDialog
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        onOpenWash={(id) => router.push('/wash/' + id)}
      />
    </div>
  );
}
