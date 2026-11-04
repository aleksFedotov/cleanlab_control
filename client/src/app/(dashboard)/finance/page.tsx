'use client';

// Финансы (P4): начисления по клиентам за месяц, год или произвольный период.
// Раскрытие строки клиента — строки счёта + ссылка на печатный счёт (/invoice).
import { useEffect, useMemo, useState } from 'react';
import { CircleDollarSign, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { useFinanceSummary } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { StatRow } from '@/components/ui/StatRow';
import { StatCard } from '@/components/ui/StatCard';
import { FilterPills } from '@/components/ui/FilterPills';
import { DataTable, DataTableColumn } from '@/components/ui/DataTable';
import { Empty } from '@/components/ui/Empty';
import { Button } from '@/components/ui/Button';
import { Skeleton, SkeletonCards } from '@/components/ui/Skeleton';
import { todayStr, formatDateRu } from '@/lib/dates';
import { kg, num, money } from '@/lib/format';
import type { FinanceSummaryClient } from '@/types/api';
import styles from './finance.module.css';

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
    key: 'weight_kg',
    title: 'Вес',
    align: 'right',
    mono: true,
    render: (c: FinanceSummaryClient) => (c.weight_kg ? kg(c.weight_kg) : '—'),
  },
  {
    key: 'items_total',
    title: 'Вещей',
    align: 'right',
    mono: true,
    render: (c: FinanceSummaryClient) => (c.items_total ? `${num(c.items_total)} шт.` : '—'),
  },
  {
    key: 'trips',
    title: 'Рейсы',
    align: 'right',
    mono: true,
    render: (c: FinanceSummaryClient) => c.trips || '—',
  },
  {
    key: 'lifts',
    title: 'Подъёмы',
    align: 'right',
    mono: true,
    render: (c: FinanceSummaryClient) => c.lifts || '—',
  },
  {
    key: 'amount',
    title: 'Начислено, ₽',
    align: 'right',
    mono: true,
    render: (c: FinanceSummaryClient) => (
      <span className={styles.amountCell}>
        {money(c.amount)} ₽
        {c.missing_prices > 0 && <span className={styles.warnBadge}>не все цены заданы</span>}
      </span>
    ),
  },
];

export default function FinancePage() {
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

  const { data, isPending, isError, error, refetch } = useFinanceSummary(range.from, range.to);

  useEffect(() => {
    if (isError && error) toast(error.message || 'Ошибка загрузки финансов', 'err');
  }, [isError, error, toast]);

  const clients = useMemo(() => data?.clients || [], [data]);
  const totals = data?.totals;
  const hasMissingPrices = clients.some((c) => c.missing_prices > 0);

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
          icon={<CircleDollarSign size={40} />}
          title="Не удалось загрузить финансы"
          hint={error?.message}
          action={<Button onClick={() => refetch()}>Повторить</Button>}
        />
      ) : (
        <>
          <StatRow>
            <StatCard label="Клиентов" value={clients.length} />
            <StatCard label="Стирок" value={totals?.washes ?? 0} />
            <StatCard label="Вес" value={totals?.weight_kg ?? 0} unit="кг" />
            <StatCard label="Вещей" value={totals?.items_total ?? 0} unit="шт." />
            <StatCard
              label="Начислено"
              value={money(totals?.amount ?? 0)}
              unit="₽"
              tone={hasMissingPrices ? 'warn' : 'ok'}
              sub={hasMissingPrices ? 'не все цены заданы' : undefined}
            />
          </StatRow>

          <DataTable
            columns={columns}
            rows={clients}
            keyField="client_id"
            empty={
              <Empty
                icon={<CircleDollarSign size={40} />}
                title="За период начислений не было"
                hint={periodLabel}
              />
            }
            expandable={(c: FinanceSummaryClient) => (
              <div className={styles.detail}>
                {c.lines.length ? (
                  <table className={styles.lines}>
                    <thead>
                      <tr>
                        <th>Позиция</th>
                        <th>Кол-во</th>
                        <th>Цена</th>
                        <th>Сумма</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.lines.map((l) => (
                        <tr key={l.billing_item_id}>
                          <td>{l.name}</td>
                          <td>
                            {num(l.qty)} {l.unit}
                          </td>
                          <td>
                            {l.price === null ? (
                              <span className={styles.noPrice}>цена не задана</span>
                            ) : (
                              `${money(l.price)} ₽`
                            )}
                          </td>
                          <td>{l.amount === null ? '—' : `${money(l.amount)} ₽`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className={styles.detailMeta}>Позиций нет</div>
                )}
                <div>
                  <a
                    className={styles.invoiceLink}
                    href={`/invoice?client=${c.client_id}&from=${range.from}&to=${range.to}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink size={14} />
                    Открыть счёт
                  </a>
                </div>
              </div>
            )}
          />
        </>
      )}
    </div>
  );
}
