'use client';

// Сводный отчёт: итоги по клиентам (мешки/вес/вещи) за месяц, год или произвольный
// период. Раскрытие строки клиента — разбивка по видам вещей за тот же период.
import { useEffect, useMemo, useState } from 'react';
import { PieChart, ChevronLeft, ChevronRight } from 'lucide-react';
import { useSummaryReport } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { StatRow } from '@/components/ui/StatRow';
import { StatCard } from '@/components/ui/StatCard';
import { FilterPills } from '@/components/ui/FilterPills';
import { DataTable, DataTableColumn } from '@/components/ui/DataTable';
import { Empty } from '@/components/ui/Empty';
import { Button } from '@/components/ui/Button';
import { Skeleton, SkeletonCards } from '@/components/ui/Skeleton';
import { todayStr, formatDateRu } from '@/lib/dates';
import { kg, num, bags } from '@/lib/format';
import type { SummaryReportClient } from '@/types/api';
import styles from './summary.module.css';

type Mode = 'month' | 'year' | 'custom';

const MONTHS_NOM = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

// Первый/последний день месяца даты 'yyyy-MM-dd'
function monthRange(dateStr: string): { from: string; to: string } {
  const [y, m] = dateStr.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

function yearRange(dateStr: string): { from: string; to: string } {
  const y = dateStr.split('-')[0];
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

// Сдвиг якорной даты на N месяцев/лет (для стрелок навигации)
function shiftAnchor(dateStr: string, mode: 'month' | 'year', dir: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + (mode === 'month' ? dir : 0), d));
  if (mode === 'year') dt.setUTCFullYear(dt.getUTCFullYear() + dir);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

const columns: DataTableColumn[] = [
  { key: 'client_name', title: 'Клиент' },
  { key: 'washes', title: 'Стирок', align: 'right', mono: true },
  {
    key: 'bags',
    title: 'Мешки',
    align: 'right',
    mono: true,
    render: (c: SummaryReportClient) => (c.bags ? bags(c.bags) : '—'),
  },
  {
    key: 'weight_kg',
    title: 'Вес',
    align: 'right',
    mono: true,
    render: (c: SummaryReportClient) => (c.weight_kg ? kg(c.weight_kg) : '—'),
  },
  {
    key: 'items_total',
    title: 'Вещей',
    align: 'right',
    mono: true,
    render: (c: SummaryReportClient) => (c.items_total ? `${num(c.items_total)} шт.` : '—'),
  },
];

export default function SummaryPage() {
  const [mode, setMode] = useState<Mode>('month');
  const [anchor, setAnchor] = useState(todayStr());
  // Произвольный период: черновик в инпутах + применённый диапазон (запрос — по кнопке)
  const [draftFrom, setDraftFrom] = useState(monthRange(todayStr()).from);
  const [draftTo, setDraftTo] = useState(todayStr());
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const toast = useUiStore((s) => s.toast);

  const range = useMemo(() => {
    if (mode === 'month') return monthRange(anchor);
    if (mode === 'year') return yearRange(anchor);
    return custom || { from: '', to: '' };
  }, [mode, anchor, custom]);

  const periodLabel = useMemo(() => {
    if (mode === 'month') {
      const [y, m] = anchor.split('-').map(Number);
      return `${MONTHS_NOM[m - 1]} ${y}`;
    }
    if (mode === 'year') return `${anchor.split('-')[0]} год`;
    return custom ? `${formatDateRu(custom.from)} — ${formatDateRu(custom.to)}` : 'Выберите период';
  }, [mode, anchor, custom]);

  const { data, isPending, isError, error, refetch } = useSummaryReport(range.from, range.to);

  useEffect(() => {
    if (isError && error) toast(error.message || 'Ошибка загрузки отчёта', 'err');
  }, [isError, error, toast]);

  const clients = useMemo(() => data?.clients || [], [data]);
  const totals = useMemo(
    () =>
      clients.reduce(
        (t, c) => ({
          washes: t.washes + c.washes,
          bags: t.bags + c.bags,
          weight: Math.round((t.weight + c.weight_kg) * 10) / 10,
          items: t.items + c.items_total,
        }),
        { washes: 0, bags: 0, weight: 0, items: 0 }
      ),
    [clients]
  );

  const applyCustom = () => {
    if (!draftFrom || !draftTo) return;
    if (draftFrom > draftTo) {
      toast('Дата «с» позже даты «по»', 'err');
      return;
    }
    setCustom({ from: draftFrom, to: draftTo });
  };

  return (
    <div className={styles.page}>
      <FilterPills
        options={[
          { key: 'month', label: 'Месяц' },
          { key: 'year', label: 'Год' },
          { key: 'custom', label: 'Период' },
        ]}
        active={mode}
        onChange={(key) => setMode(key as Mode)}
      />

      {mode === 'custom' ? (
        <div className={styles.periodRow}>
          <input
            type="date"
            className={styles.dateInput}
            value={draftFrom}
            onChange={(e) => setDraftFrom(e.target.value)}
          />
          <span className={styles.dash}>—</span>
          <input
            type="date"
            className={styles.dateInput}
            value={draftTo}
            onChange={(e) => setDraftTo(e.target.value)}
          />
          <Button size="sm" onClick={applyCustom}>
            Показать
          </Button>
          {custom && <span className={styles.periodLabel}>{periodLabel}</span>}
        </div>
      ) : (
        <div className={styles.periodRow}>
          <button
            type="button"
            className={styles.navBtn}
            aria-label="Назад"
            onClick={() => setAnchor((a) => shiftAnchor(a, mode, -1))}
          >
            <ChevronLeft size={18} />
          </button>
          <span className={styles.periodLabel}>{periodLabel}</span>
          <button
            type="button"
            className={styles.navBtn}
            aria-label="Вперёд"
            onClick={() => setAnchor((a) => shiftAnchor(a, mode, 1))}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      {isPending ? (
        <>
          <SkeletonCards count={5} />
          <Skeleton height={52} lines={5} radius={0} />
        </>
      ) : isError || !data ? (
        <Empty
          icon={<PieChart size={40} />}
          title="Не удалось загрузить отчёт"
          hint={error?.message}
          action={<Button onClick={() => refetch()}>Повторить</Button>}
        />
      ) : (
        <>
          <StatRow>
            <StatCard label="Клиентов" value={clients.length} />
            <StatCard label="Стирок" value={totals.washes} />
            <StatCard label="Мешков" value={totals.bags} />
            <StatCard label="Вес" value={totals.weight} unit="кг" tone="ok" />
            <StatCard label="Вещей" value={totals.items} unit="шт." />
          </StatRow>

          <DataTable
            columns={columns}
            rows={clients}
            keyField="client_id"
            empty={
              <Empty
                icon={<PieChart size={40} />}
                title="За период стирок не было"
                hint={periodLabel}
              />
            }
            expandable={(c: SummaryReportClient) => (
              <div className={styles.detail}>
                <div className={styles.detailMeta}>
                  За период {periodLabel}:{' '}
                  <b>
                    {c.weight_kg ? kg(c.weight_kg) : '—'}
                    {c.items_total ? ` · ${num(c.items_total)} шт.` : ''}
                    {c.bags ? ` · ${bags(c.bags)}` : ''}
                  </b>
                </div>
                {c.items.length ? (
                  <div className={styles.items}>
                    {c.items.map((it) => (
                      <div key={it.item_type_id} className={styles.itemRow}>
                        <span>{it.item_name}</span>
                        <span className={styles.qty}>×{num(it.qty)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.detailMeta}>Позиций нет</div>
                )}
              </div>
            )}
          />
        </>
      )}
    </div>
  );
}
