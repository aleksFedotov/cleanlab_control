'use client';

// Зарплаты (P3, owner): авторасчёт за месяц по сотрудникам + ручные корректировки.
// Ставки приходят из getPayroll уже разрешёнными сервером; список корректировок
// (с удалением) — из listPayAdjustments, в раскрытой строке сотрудника.
import { useEffect, useMemo, useState } from 'react';
import { Wallet, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { usePayroll, usePayAdjustments, useDeletePayAdjustment, usePaySettings, useSavePaySettings } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { DataTable, DataTableColumn } from '@/components/ui/DataTable';
import { Empty } from '@/components/ui/Empty';
import { Button } from '@/components/ui/Button';
import { Skeleton, SkeletonCards } from '@/components/ui/Skeleton';
import { Accordion } from '@/components/ui/Accordion';
import { AdjustmentModal } from '@/components/payroll/AdjustmentModal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { todayStr, formatDateRu } from '@/lib/dates';
import { money } from '@/lib/format';
import { roleLabel } from '@/lib/dicts';
import type { PayrollEmployee, PayAdjustmentListItem, PaySettings } from '@/types/api';
import styles from './payroll.module.css';

const MONTHS_NOM = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

// Первый/последний день месяца даты 'yyyy-MM-dd' (как в timesheet)
function monthRange(dateStr: string): { from: string; to: string } {
  const [y, m] = dateStr.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

// Сдвиг якорной даты на N месяцев (для стрелок навигации)
function shiftMonth(dateStr: string, dir: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + dir, d));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// Подпись ставок по роли
function ratesLabel(e: PayrollEmployee): string {
  return e.role === 'driver'
    ? `${money(e.point_rate)} ₽/точка · ${money(e.lift_floor_rate)} ₽/этаж`
    : `${money(e.shift_base)} ₽ / ${e.shift_norm_hours} ч`;
}

function signed(v: number): string {
  return `${v > 0 ? '+' : ''}${money(v)} ₽`;
}

// --- P3.1: дефолтные ставки прачки ---
// Пустое поле = вернуться к встроенному дефолту (сервер удаляет ключ Settings).

const PAY_SETTING_FIELDS: { key: keyof PaySettings; label: string }[] = [
  { key: 'point_rate', label: 'За точку, ₽' },
  { key: 'lift_floor_rate', label: 'За этаж подъёма, ₽' },
  { key: 'shift_base', label: 'Ставка смены, ₽' },
  { key: 'shift_norm_hours', label: 'Норма часов смены' },
];

// Внутренняя форма: монтируется с готовыми данными (начальные значения — из useState)
function PaySettingsForm({ initial }: { initial: PaySettings }) {
  const toast = useUiStore((s) => s.toast);
  const [values, setValues] = useState<Record<keyof PaySettings, string>>({
    point_rate: String(initial.point_rate),
    lift_floor_rate: String(initial.lift_floor_rate),
    shift_base: String(initial.shift_base),
    shift_norm_hours: String(initial.shift_norm_hours),
  });
  const saveMut = useSavePaySettings(() => toast('Ставки сохранены ✓'));

  return (
    <div className={styles.settingsForm}>
      <div className={styles.settingsGrid}>
        {PAY_SETTING_FIELDS.map((f) => (
          <label key={f.key} className={styles.settingsField}>
            <span className={styles.settingsLabel}>{f.label}</span>
            <input
              type="number"
              min="0"
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <div className={styles.settingsActions}>
        <Button size="sm" onClick={() => saveMut.mutate(values)} disabled={saveMut.isPending}>
          Сохранить
        </Button>
      </div>
      <div className={styles.settingsHint}>
        Новые ставки применяются ко всем периодам, прошлые месяцы пересчитаются.
        Персональные ставки — в карточке сотрудника (раздел «Сотрудники»); пустое поле
        здесь = встроенный дефолт (250 / 100 / 4000 / 12).
      </div>
    </div>
  );
}

function PaySettingsBlock() {
  const settingsQ = usePaySettings();
  return (
    <Accordion id="pay-settings" title="Ставки по умолчанию">
      {settingsQ.isPending || !settingsQ.data ? (
        <Skeleton height={38} lines={2} radius={8} />
      ) : (
        // key — перемонтирование формы при смене данных (начальные значения свежие)
        <PaySettingsForm
          key={JSON.stringify(settingsQ.data.settings)}
          initial={settingsQ.data.settings}
        />
      )}
    </Accordion>
  );
}

// Раскрытая строка: начисления по дням + корректировки сотрудника за период
function DayDetails({ e, from, to }: { e: PayrollEmployee; from: string; to: string }) {
  const adjQ = usePayAdjustments(e.user_id, from, to);
  const adjustments = adjQ.data?.adjustments || [];
  const [delTarget, setDelTarget] = useState<PayAdjustmentListItem | null>(null);
  const delMut = useDeletePayAdjustment(() => setDelTarget(null));

  return (
    <>
      {!e.days.length && <div className={styles.detailEmpty}>Начислений за период нет</div>}
      {e.days.length > 0 && (
        <table className={styles.days}>
          <thead>
            <tr>
              <th>Дата</th>
              <th>{e.role === 'driver' ? 'Точки' : 'Часы'}</th>
              {e.role === 'driver' && <th>Подъёмы, эт.</th>}
              <th>Сумма</th>
            </tr>
          </thead>
          <tbody>
            {e.days.map((d) => (
              <tr key={d.date}>
                <td>{formatDateRu(d.date, false)}</td>
                <td>{e.role === 'driver' ? d.points || '—' : d.hours || '—'}</td>
                {e.role === 'driver' && <td>{d.lift_floors || '—'}</td>}
                <td>{money(d.amount)} ₽</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adjustments.length > 0 && (
        <>
          <div className={styles.adjTitle}>Корректировки (включены в суммы дней)</div>
          <table className={styles.days}>
            <tbody>
              {adjustments.map((a) => (
                <tr key={a.id}>
                  <td>{formatDateRu(a.date, false)}</td>
                  <td>{signed(a.amount)}</td>
                  <td className={styles.adjComment}>{a.comment || '—'}</td>
                  <td>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Удалить корректировку"
                      onClick={() => setDelTarget(a)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <ConfirmDialog
        open={!!delTarget}
        onClose={() => setDelTarget(null)}
        onConfirm={() => delTarget && delMut.mutate(delTarget.id)}
        text={
          delTarget
            ? `Удалить корректировку ${signed(delTarget.amount)} от ${formatDateRu(delTarget.date, false)}${delTarget.comment ? ` («${delTarget.comment}»)` : ''}?`
            : ''
        }
        okLabel="Удалить"
        danger
        busy={delMut.isPending}
      />
    </>
  );
}

export default function PayrollPage() {
  const [anchor, setAnchor] = useState(todayStr());
  const [adjOpen, setAdjOpen] = useState(false);
  const toast = useUiStore((s) => s.toast);

  const range = useMemo(() => monthRange(anchor), [anchor]);
  const periodLabel = useMemo(() => {
    const [y, m] = anchor.split('-').map(Number);
    return `${MONTHS_NOM[m - 1]} ${y}`;
  }, [anchor]);

  const query = usePayroll(range.from, range.to);
  useEffect(() => {
    if (query.error) toast(query.error.message || 'Ошибка загрузки зарплат', 'err');
  }, [query.error, toast]);

  const employees = useMemo(() => query.data?.employees || [], [query.data]);

  const columns: DataTableColumn[] = [
    {
      key: 'name',
      title: 'Сотрудник',
      render: (e: PayrollEmployee) => (
        <span className={styles.nameWrap}>
          {e.name}
          <span className={styles.sub}>{roleLabel(e.role)}</span>
          {e.rate_missing && <span className={styles.miss}>нет ставки</span>}
        </span>
      ),
    },
    { key: 'rates', title: 'Ставки', render: (e: PayrollEmployee) => ratesLabel(e) },
    {
      key: 'qty',
      title: 'Точки / часы',
      align: 'right',
      mono: true,
      render: (e: PayrollEmployee) => (e.role === 'driver' ? e.points : e.hours),
    },
    {
      key: 'lifts',
      title: 'Подъёмы',
      align: 'right',
      mono: true,
      render: (e: PayrollEmployee) =>
        e.role === 'driver' ? `${e.lift_floors} эт. · ${money(e.amount_lifts)} ₽` : '—',
    },
    {
      key: 'base',
      title: 'Начислено',
      align: 'right',
      mono: true,
      render: (e: PayrollEmployee) => `${money(e.amount_points + e.amount_shift)} ₽`,
    },
    {
      key: 'adj',
      title: 'Корректировки',
      align: 'right',
      mono: true,
      render: (e: PayrollEmployee) => (e.adjustments_total !== 0 ? signed(e.adjustments_total) : '—'),
    },
    {
      key: 'total',
      title: 'Итого',
      align: 'right',
      mono: true,
      render: (e: PayrollEmployee) => <b>{money(e.total)} ₽</b>,
    },
  ];

  const isError = query.isError && !query.data;

  return (
    <div className={styles.page}>
      <div className={styles.periodRow}>
        <button
          type="button"
          className={styles.navBtn}
          aria-label="Предыдущий месяц"
          onClick={() => setAnchor((a) => shiftMonth(a, -1))}
        >
          <ChevronLeft size={18} />
        </button>
        <span className={styles.periodLabel}>{periodLabel}</span>
        <button
          type="button"
          className={styles.navBtn}
          aria-label="Следующий месяц"
          onClick={() => setAnchor((a) => shiftMonth(a, 1))}
        >
          <ChevronRight size={18} />
        </button>
        {monthRange(todayStr()).from !== range.from && (
          <Button variant="subtle" size="sm" onClick={() => setAnchor(todayStr())}>
            Сегодня
          </Button>
        )}
        <div className={styles.spacer} />
        <Button size="sm" onClick={() => setAdjOpen(true)} disabled={!employees.length}>
          + Корректировка
        </Button>
      </div>

      <PaySettingsBlock />

      {query.isPending ? (
        <>
          <SkeletonCards count={3} />
          <Skeleton height={52} lines={5} radius={0} />
        </>
      ) : isError ? (
        <Empty
          icon={<Wallet size={40} />}
          title="Не удалось загрузить зарплаты"
          hint={query.error?.message}
          action={<Button onClick={() => query.refetch()}>Повторить</Button>}
        />
      ) : employees.length === 0 ? (
        <Empty
          icon={<Wallet size={40} />}
          title="Сотрудников нет"
          hint="Добавьте работников и водителей в разделе «Сотрудники»."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={employees}
          keyField="user_id"
          expandable={(e: PayrollEmployee) => <DayDetails e={e} from={range.from} to={range.to} />}
        />
      )}

      <AdjustmentModal open={adjOpen} onClose={() => setAdjOpen(false)} employees={employees} />
    </div>
  );
}
