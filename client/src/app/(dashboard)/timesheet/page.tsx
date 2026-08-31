'use client';

// Табель: часы работников + авто-статистика точек развоза (день/месяц/год).
// Часы правятся кликом по строке/ячейке (WorkHoursModal); развозы считаются
// сервером из Deliveries (getDeliveryPointStats) и не редактируются.
import { useEffect, useMemo, useState } from 'react';
import { Clock, ChevronLeft, ChevronRight } from 'lucide-react';
import { useWorkHours, useDeliveryPointStats, usePayroll } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { StatRow } from '@/components/ui/StatRow';
import { StatCard } from '@/components/ui/StatCard';
import { FilterPills } from '@/components/ui/FilterPills';
import { DataTable, DataTableColumn } from '@/components/ui/DataTable';
import { Empty } from '@/components/ui/Empty';
import { Button } from '@/components/ui/Button';
import { Skeleton, SkeletonCards } from '@/components/ui/Skeleton';
import { WorkHoursModal } from '@/components/WorkHoursModal';
import { AdjustmentModal } from '@/components/payroll/AdjustmentModal';
import { todayStr, shiftDateStr, formatDateRu } from '@/lib/dates';
import { money } from '@/lib/format';
import type { WorkHoursEntry, DeliveryPointStatsDay, PayrollEmployee } from '@/types/api';
import styles from './timesheet.module.css';

type Mode = 'day' | 'month' | 'year';

const MONTHS_NOM = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

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

// Сдвиг якорной даты на N дней/месяцев/лет (для стрелок навигации)
function shiftAnchor(dateStr: string, mode: Mode, dir: number): string {
  if (mode === 'day') return shiftDateStr(dateStr, dir);
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + (mode === 'month' ? dir : 0), d));
  if (mode === 'year') dt.setUTCFullYear(dt.getUTCFullYear() + dir);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// Все даты месяца якорной даты ('yyyy-MM-dd'[])
function monthDays(anchor: string): string[] {
  const { from, to } = monthRange(anchor);
  const days: string[] = [];
  for (let d = from; d <= to; d = shiftDateStr(d, 1)) days.push(d);
  return days;
}

function hoursOf(e: WorkHoursEntry | undefined): string {
  return e ? e.hours : '';
}

function sumHours(entries: WorkHoursEntry[]): number {
  return Math.round(entries.reduce((s, e) => s + (Number(e.hours) || 0), 0) * 10) / 10;
}

interface EditTarget {
  userId: string;
  userName: string;
  date: string;
  entry?: WorkHoursEntry;
}

export default function TimesheetPage() {
  const [mode, setMode] = useState<Mode>('day');
  const [anchor, setAnchor] = useState(todayStr());
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [adjOpen, setAdjOpen] = useState(false);
  const toast = useUiStore((s) => s.toast);

  const range = useMemo(() => {
    if (mode === 'day') return { from: anchor, to: anchor };
    if (mode === 'month') return monthRange(anchor);
    return yearRange(anchor);
  }, [mode, anchor]);

  const periodLabel = useMemo(() => {
    if (mode === 'day') return formatDateRu(anchor);
    if (mode === 'month') {
      const [y, m] = anchor.split('-').map(Number);
      return `${MONTHS_NOM[m - 1]} ${y}`;
    }
    return `${anchor.split('-')[0]} год`;
  }, [mode, anchor]);

  const hoursQ = useWorkHours(range.from, range.to);
  const statsQ = useDeliveryPointStats(range.from, range.to);
  // Начисления (P3/P4) нужны только в режиме «Месяц» — в день/год запрос не делаем
  const payrollQ = usePayroll(range.from, range.to, mode === 'month');

  useEffect(() => {
    const err = hoursQ.error || statsQ.error || payrollQ.error;
    if (err) toast(err.message || 'Ошибка загрузки табеля', 'err');
  }, [hoursQ.error, statsQ.error, payrollQ.error, toast]);

  const workers = useMemo(() => hoursQ.data?.workers || [], [hoursQ.data]);
  const entries = useMemo(() => hoursQ.data?.entries || [], [hoursQ.data]);
  const statDays = useMemo(() => statsQ.data?.days || [], [statsQ.data]);

  // Начисления по user_id (режим «Месяц»)
  const payrollByUser = useMemo(() => {
    const m: Record<string, PayrollEmployee> = {};
    (payrollQ.data?.employees || []).forEach((e) => { m[e.user_id] = e; });
    return m;
  }, [payrollQ.data]);

  // Водители с итогом за месяц — для блока «Развозы водителя»
  const payrollDrivers = useMemo(
    () => (payrollQ.data?.employees || []).filter((e) => e.role === 'driver'),
    [payrollQ.data]
  );

  // Быстрый доступ к отметке: 'user_id|date' → entry
  const entryByKey = useMemo(() => {
    const m: Record<string, WorkHoursEntry> = {};
    entries.forEach((e) => { m[`${e.user_id}|${e.date}`] = e; });
    return m;
  }, [entries]);

  // --- Часы: режим «День» — таблица работник | часы | действие ---
  const dayColumns: DataTableColumn[] = [
    { key: 'name', title: 'Работник' },
    {
      key: 'hours',
      title: 'Часы',
      align: 'right',
      mono: true,
      render: (w: { id: string }) => hoursOf(entryByKey[`${w.id}|${anchor}`]) || '—',
    },
    {
      key: 'actions',
      title: '',
      align: 'right',
      render: (w: { id: string; name: string }) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setEdit({ userId: w.id, userName: w.name, date: anchor, entry: entryByKey[`${w.id}|${anchor}`] })
          }
        >
          Изменить
        </Button>
      ),
    },
  ];

  // --- Часы: режим «Год» — работник × 12 месяцев + итог ---
  const yearRows = useMemo(
    () =>
      workers.map((w) => {
        const mine = entries.filter((e) => e.user_id === w.id);
        const byMonth: number[] = Array(12).fill(0);
        mine.forEach((e) => {
          byMonth[Number(e.date.slice(5, 7)) - 1] += Number(e.hours) || 0;
        });
        return { id: w.id, name: w.name, byMonth, total: sumHours(mine) };
      }),
    [workers, entries]
  );

  const yearColumns: DataTableColumn[] = useMemo(
    () => [
      { key: 'name', title: 'Работник' },
      ...MONTHS_SHORT.map((m, i) => ({
        key: `m${i}`,
        title: m,
        align: 'right' as const,
        mono: true,
        render: (r: (typeof yearRows)[number]) => (r.byMonth[i] ? r.byMonth[i] : '—'),
      })),
      { key: 'total', title: 'Итого', align: 'right', mono: true },
    ],
    []
  );

  // --- Развозы: итоги периода и разбивка ---
  const statsTotals = useMemo(
    () =>
      statDays.reduce(
        (t, d) => ({
          total: t.total + d.total,
          only_delivery: t.only_delivery + d.only_delivery,
          only_pickup: t.only_pickup + d.only_pickup,
          both: t.both + d.both,
        }),
        { total: 0, only_delivery: 0, only_pickup: 0, both: 0 }
      ),
    [statDays]
  );

  // Режим «Год»: агрегация развозов по месяцам
  const statsByMonth = useMemo(() => {
    const rows: Array<DeliveryPointStatsDay & { month: string }> = [];
    statDays.forEach((d) => {
      const mIdx = Number(d.date.slice(5, 7)) - 1;
      const label = MONTHS_NOM[mIdx];
      let row = rows.find((r) => r.month === label);
      if (!row) {
        row = { month: label, date: d.date, total: 0, only_delivery: 0, only_pickup: 0, both: 0 };
        rows.push(row);
      }
      row.total += d.total;
      row.only_delivery += d.only_delivery;
      row.only_pickup += d.only_pickup;
      row.both += d.both;
    });
    return rows;
  }, [statDays]);

  const statsColumns: DataTableColumn[] = [
    {
      key: 'date',
      title: mode === 'year' ? 'Месяц' : 'Дата',
      render: (d: DeliveryPointStatsDay & { month?: string }) =>
        mode === 'year' ? d.month : formatDateRu(d.date, false),
    },
    { key: 'total', title: 'Всего точек', align: 'right', mono: true },
    { key: 'only_delivery', title: 'Только доставка', align: 'right', mono: true },
    { key: 'only_pickup', title: 'Только забор', align: 'right', mono: true },
    { key: 'both', title: 'Доставка + забор', align: 'right', mono: true },
  ];

  const isPending = hoursQ.isPending || statsQ.isPending || (mode === 'month' && payrollQ.isPending);
  const isError =
    (hoursQ.isError && !hoursQ.data) ||
    (statsQ.isError && !statsQ.data) ||
    (mode === 'month' && payrollQ.isError && !payrollQ.data);

  return (
    <div className={styles.page}>
      <FilterPills
        options={[
          { key: 'day', label: 'День' },
          { key: 'month', label: 'Месяц' },
          { key: 'year', label: 'Год' },
        ]}
        active={mode}
        onChange={(key) => setMode(key as Mode)}
      />

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
        {anchor !== todayStr() && (
          <Button variant="subtle" size="sm" onClick={() => setAnchor(todayStr())}>
            Сегодня
          </Button>
        )}
        {mode === 'month' && (
          <>
            <div className={styles.spacer} />
            <Button size="sm" onClick={() => setAdjOpen(true)}>
              + Корректировка
            </Button>
          </>
        )}
      </div>

      {isPending ? (
        <>
          <SkeletonCards count={4} />
          <Skeleton height={52} lines={5} radius={0} />
        </>
      ) : isError ? (
        <Empty
          icon={<Clock size={40} />}
          title="Не удалось загрузить табель"
          hint={hoursQ.error?.message || statsQ.error?.message || payrollQ.error?.message}
          action={
            <Button
              onClick={() => {
                hoursQ.refetch();
                statsQ.refetch();
                if (mode === 'month') payrollQ.refetch();
              }}
            >
              Повторить
            </Button>
          }
        />
      ) : (
        <>
          {/* ===== Часы работников ===== */}
          <h2 className={styles.sectionTitle}>Часы работников</h2>

          {mode === 'day' &&
            (workers.length === 0 ? (
              <Empty icon={<Clock size={40} />} title="Работников нет" hint="Добавьте их в разделе «Сотрудники»." />
            ) : (
              <DataTable columns={dayColumns} rows={workers} keyField="id" />
            ))}

          {mode === 'month' &&
            (workers.length === 0 ? (
              <Empty icon={<Clock size={40} />} title="Работников нет" hint="Добавьте их в разделе «Сотрудники»." />
            ) : (
              <div className={styles.matrixWrap}>
                <table className={styles.matrix}>
                  <thead>
                    <tr>
                      <th className={styles.matrixName}>Работник</th>
                      {monthDays(anchor).map((d) => (
                        <th key={d} className={styles.matrixDay}>
                          {Number(d.slice(8, 10))}
                        </th>
                      ))}
                      <th className={styles.matrixDay}>Σ</th>
                      <th className={styles.matrixDay}>Начислено, ₽</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workers.map((w) => {
                      const mine = entries.filter((e) => e.user_id === w.id);
                      const pay = payrollByUser[w.id];
                      return (
                        <tr key={w.id}>
                          <td className={styles.matrixName}>{w.name}</td>
                          {monthDays(anchor).map((d) => {
                            const e = entryByKey[`${w.id}|${d}`];
                            return (
                              <td
                                key={d}
                                className={`${styles.matrixCell} ${e ? styles.matrixFilled : ''}`}
                                onClick={() => setEdit({ userId: w.id, userName: w.name, date: d, entry: e })}
                              >
                                {e ? e.hours : ''}
                              </td>
                            );
                          })}
                          <td className={`${styles.matrixCell} ${styles.matrixTotal}`}>{sumHours(mine) || ''}</td>
                          <td className={`${styles.matrixCell} ${styles.matrixTotal}`}>
                            {pay ? (
                              <>
                                {money(pay.total)}
                                {pay.rate_missing && <span className={styles.miss}>нет ставки</span>}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}

          {mode === 'year' &&
            (yearRows.length === 0 ? (
              <Empty icon={<Clock size={40} />} title="Работников нет" hint="Добавьте их в разделе «Сотрудники»." />
            ) : (
              <DataTable columns={yearColumns} rows={yearRows} keyField="id" />
            ))}

          {/* ===== Развозы водителя ===== */}
          <h2 className={styles.sectionTitle}>Развозы водителя</h2>

          <StatRow>
            <StatCard label="Всего точек" value={statsTotals.total} tone="ok" />
            <StatCard label="Только доставка" value={statsTotals.only_delivery} />
            <StatCard label="Только забор" value={statsTotals.only_pickup} />
            <StatCard label="Доставка + забор" value={statsTotals.both} />
          </StatRow>

          {mode === 'month' &&
            payrollDrivers.map((d) => (
              <div key={d.user_id} className={styles.driverTotal}>
                <b>{d.name}:</b> Точек {d.points} × {money(d.point_rate)} ₽ + подъёмы {d.lift_floors} эт. ×{' '}
                {money(d.lift_floor_rate)} ₽ + корректировки {money(d.adjustments_total)} ₽ ={' '}
                <b>{money(d.total)} ₽</b>
                {d.rate_missing && <span className={styles.miss}>нет ставки</span>}
              </div>
            ))}

          {mode !== 'day' && (
            <DataTable
              columns={statsColumns}
              rows={mode === 'year' ? statsByMonth : statDays}
              keyField={mode === 'year' ? 'month' : 'date'}
              empty={<Empty title="Выполненных развозов не было" hint={periodLabel} />}
            />
          )}
        </>
      )}

      {edit && (
        <WorkHoursModal
          userId={edit.userId}
          userName={edit.userName}
          date={edit.date}
          entry={edit.entry}
          onClose={() => setEdit(null)}
        />
      )}

      <AdjustmentModal
        open={adjOpen}
        onClose={() => setAdjOpen(false)}
        employees={payrollQ.data?.employees || []}
      />
    </div>
  );
}
