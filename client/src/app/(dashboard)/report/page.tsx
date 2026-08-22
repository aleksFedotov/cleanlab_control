'use client';

// Отчёт за день: сводка (StatRow) + фильтры + таблица стирок с раскрытием.
// Перенос legacy renderReport/openReportRow (server/public/index.html:2114-2232).
import { useEffect, useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { useDayReport, useApiMutation } from '@/hooks/use-api';
import { useSectionDate } from '@/hooks/use-section-date';
import { useUiStore } from '@/stores/ui';
import { StatRow } from '@/components/ui/StatRow';
import { StatCard } from '@/components/ui/StatCard';
import { FilterPills } from '@/components/ui/FilterPills';
import { DataTable, DataTableColumn } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Empty } from '@/components/ui/Empty';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Skeleton, SkeletonCards } from '@/components/ui/Skeleton';
import { formatDateRu } from '@/lib/dates';
import { kg, num } from '@/lib/format';
import type { DayReportRes, Wash } from '@/types/api';
import { EditWashModal } from './EditWashModal';
import { DeferWashModal } from './DeferWashModal';
import styles from './report.module.css';

type ReportWash = DayReportRes['washes'][number];
type ReportGroup = 'all' | 'done' | 'todo' | 'deferred' | 'cancelled';

// Группа статуса для фильтра отчёта (порт legacy reportGroup)
function reportGroup(w: Wash): Exclude<ReportGroup, 'all'> {
  if (w.status === 'cancelled') return 'cancelled';
  if (w.deferred_from) return 'deferred';
  if (['planned', 'no_linen', 'in_progress'].includes(w.status)) return 'todo';
  return 'done'; // done/stored/issued/partial/ready_clean
}

// Допустимые действия со стиркой (порт legacy openReportRow)
function canEdit(w: Wash): boolean {
  return w.status === 'done' || w.status === 'stored' || w.status === 'partial';
}
function canDefer(w: Wash): boolean {
  return ['planned', 'in_progress', 'partial'].includes(w.status);
}
function canDelete(w: Wash): boolean {
  return w.status !== 'issued';
}

const FILTER_LABELS: Array<[Exclude<ReportGroup, 'all'>, string]> = [
  ['done', 'Завершено'],
  ['todo', 'К стирке'],
  ['deferred', 'Перенесено'],
  ['cancelled', 'Отменено'],
];

const columns: DataTableColumn[] = [
  { key: 'client_name', title: 'Клиент' },
  {
    key: 'weight',
    title: 'Вес',
    align: 'right',
    mono: true,
    render: (w: ReportWash) => (w.dirty_weight_kg ? kg(w.dirty_weight_kg) : '—'),
  },
  {
    key: 'kinds',
    title: 'Бельё',
    align: 'right',
    mono: true,
    render: (w: ReportWash) => ((w.items || []).length ? `${w.items.length} видов` : '—'),
  },
  {
    key: 'count',
    title: 'Кол-во',
    align: 'right',
    mono: true,
    render: (w: ReportWash) =>
      (w.items_total ? `${num(w.items_total)} шт.` : '—') +
      (num(w.bags) > 0 ? ` · ${num(w.bags)} меш.` : ''),
  },
  {
    key: 'status',
    title: 'Статус',
    render: (w: ReportWash) => (
      <StatusBadge status={reportGroup(w) === 'deferred' ? 'deferred' : w.status} size="sm" />
    ),
  },
  {
    key: 'reason',
    title: 'Причина',
    render: (w: ReportWash) =>
      w.deferred_from
        ? `с ${w.deferred_from}${w.deferred_reason ? `: ${w.deferred_reason}` : ''}`
        : '—',
  },
];

export default function ReportPage() {
  const [date] = useSectionDate('report');
  const { data, isPending, isError, error, refetch } = useDayReport(date);
  const toast = useUiStore((s) => s.toast);

  // Фильтр сохраняется при переходе по датам (как state.repFilter в legacy)
  const [filter, setFilter] = useState<ReportGroup>('all');
  const [editWash, setEditWash] = useState<ReportWash | null>(null);
  const [deferWash, setDeferWash] = useState<ReportWash | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ReportWash | null>(null);

  const deleteMutation = useApiMutation('deleteWash', {
    invalidate: 'operational',
    onSuccess: () => {
      setDeleteTarget(null);
      toast('Стирка удалена ✓');
    },
  });

  useEffect(() => {
    if (isError && error) toast(error.message || 'Ошибка загрузки отчёта', 'err');
  }, [isError, error, toast]);

  // Завершённые и прочие сверху, незавершённые — внизу (legacy, spec §7.3)
  const rows = useMemo(() => {
    const list = (data?.washes || []).slice().sort((a, b) => {
      const openA = a.status === 'planned' || a.status === 'in_progress' ? 1 : 0;
      const openB = b.status === 'planned' || b.status === 'in_progress' ? 1 : 0;
      return openA - openB;
    });
    return list;
  }, [data]);

  const counts = useMemo(() => {
    const c: Record<Exclude<ReportGroup, 'all'>, number> = {
      done: 0,
      todo: 0,
      deferred: 0,
      cancelled: 0,
    };
    rows.forEach((w) => {
      c[reportGroup(w)] += 1;
    });
    return c;
  }, [rows]);

  const visibleRows = useMemo(
    () => (filter === 'all' ? rows : rows.filter((w) => reportGroup(w) === filter)),
    [rows, filter]
  );

  if (isPending) {
    return (
      <div className={styles.page}>
        <SkeletonCards count={5} />
        <Skeleton height={38} width={420} radius={999} />
        <Skeleton height={52} lines={5} radius={0} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Empty
        icon={<BarChart3 size={40} />}
        title="Не удалось загрузить отчёт"
        hint={error?.message}
        action={<Button onClick={() => refetch()}>Повторить</Button>}
      />
    );
  }

  const r = data.report;
  const shift = data.shift;

  return (
    <div className={styles.page}>
      <StatRow>
        <StatCard label="Постирано" value={r.totalKg} unit="кг" tone="ok" />
        <StatCard label="Завершено" value={r.washesDone} tone="ok" />
        <StatCard label="На складе" value={r.stored} />
        <StatCard label="Перенесено" value={r.deferred} tone={r.deferred ? 'warn' : 'default'} />
        <StatCard label="Отменено" value={r.cancelled} tone={r.cancelled ? 'late' : 'default'} />
      </StatRow>
      {(shift || r.issued > 0) && (
        <div className={styles.meta}>
          {r.issued > 0 && (
            <span>
              Выдано клиентам: <b>{r.issued}</b>
            </span>
          )}
          {shift && (
            <span>
              Смена:{' '}
              <b>
                {shift.status === 'closed' ? `закрыта в ${shift.closed_at}` : 'открыта'}
              </b>
            </span>
          )}
        </div>
      )}

      <FilterPills
        options={[
          { key: 'all', label: 'Все', count: rows.length },
          ...FILTER_LABELS.map(([key, label]) => ({ key, label, count: counts[key] })),
        ]}
        active={filter}
        onChange={(key) => setFilter(key as ReportGroup)}
      />

      <DataTable
        columns={columns}
        rows={visibleRows}
        keyField="id"
        empty={<Empty icon={<BarChart3 size={40} />} title="Стирок не было" />}
        expandable={(w: ReportWash) => (
          <div className={styles.detail}>
            <div className={styles.detailMeta}>
              <b>
                {w.dirty_weight_kg ? kg(w.dirty_weight_kg) : '—'}
                {w.items_total ? ` · ${num(w.items_total)} шт.` : ''}
                {num(w.bags) > 0 ? ` · ${num(w.bags)} меш.` : ''}
              </b>
              {w.deferred_from && <span> · перенесено с {w.deferred_from}</span>}
            </div>
            {w.deferred_reason && (
              <div className={styles.detailMeta}>Причина переноса: {w.deferred_reason}</div>
            )}
            {(w.items || []).length ? (
              <div className={styles.items}>
                {w.items.map((it) => (
                  <div key={it.id} className={styles.itemRow}>
                    <span>{it.item_name}</span>
                    <span className={styles.qty}>×{num(it.qty)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.detailMeta}>Позиций нет</div>
            )}
            {(canEdit(w) || canDefer(w) || canDelete(w)) && (
              <div className={styles.detailActions}>
                {canEdit(w) && (
                  <Button size="sm" onClick={() => setEditWash(w)}>
                    Изменить данные
                  </Button>
                )}
                {canDefer(w) && (
                  <Button size="sm" variant="ghost" onClick={() => setDeferWash(w)}>
                    Перенести на другой день
                  </Button>
                )}
                {canDelete(w) && (
                  <Button size="sm" variant="danger" onClick={() => setDeleteTarget(w)}>
                    Удалить стирку
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      />

      {editWash && <EditWashModal wash={editWash} onClose={() => setEditWash(null)} />}
      {deferWash && <DeferWashModal wash={deferWash} onClose={() => setDeferWash(null)} />}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        text={
          deleteTarget
            ? `Удалить стирку «${deleteTarget.client_name}» от ${formatDateRu(
                deleteTarget.wash_date
              )} безвозвратно?`
            : ''
        }
        okLabel="Удалить"
        danger
        busy={deleteMutation.isPending}
      />
    </div>
  );
}
