'use client';

// P8: ручное внесение чистого белья на склад (addManualClean).
// Два варианта: из карточки дня (wash — клиент и режим учёта известны)
// и со страницы склада владельца (clients — выбор активного клиента).
// Мешки/комментарий обязательны всегда; вес обязателен, кроме accounting='count'.
// При accounting !== 'weight' штуки вводятся по видам белья степперами (как в
// CompleteWashModal): видимые типы — список клиента или весь справочник;
// itemsTotal = сумма по видам. При 'weight' — одиночное необязательное поле «Штук».
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Stepper } from '@/components/Stepper';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import type { Client, DayWash, ItemType } from '@/types/api';
import styles from './ManualCleanModal.module.css';

const UNIT_STEPS = [
  { delta: -1, label: '−' },
  { delta: 1, label: '+' },
];

type FormValues = {
  clientId: string;
  weightKg?: number;
  itemsTotal?: number;
  bags: number;
  comment: string;
};

// Пустой ввод числового поля (valueAsNumber даёт NaN) → «не задано»
const optNum = z.preprocess(
  (v) => (typeof v === 'number' && Number.isNaN(v) ? undefined : v),
  z.number().optional()
);

function buildSchema(needClient: boolean) {
  return z.object({
    clientId: needClient ? z.string().min(1, 'Выберите клиента') : z.string(),
    weightKg: optNum,
    itemsTotal: optNum,
    bags: z.number({ error: 'Укажите мешки' }).int('Целое число').positive('Мешков должно быть > 0'),
    comment: z.string().trim().min(1, 'Укажите, откуда бельё'),
  });
}

type Schema = ReturnType<typeof buildSchema>;
// preprocess даёт input unknown — форма типизирована по input, submit — по output
type FormInput = z.input<Schema>;

// Список видов клиента: Clients.item_types — JSON-массив id строкой; пусто = все типы
function parseClientTypes(raw: string): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export type ManualCleanModalProps = {
  itemTypes: ItemType[];
  onClose: () => void;
  successToast?: string;
} & ({ wash: DayWash; clients?: undefined } | { clients: Client[]; wash?: undefined });

export function ManualCleanModal(props: ManualCleanModalProps) {
  const { onClose, itemTypes, successToast = 'Чистое внесено ✓' } = props;
  const toast = useUiStore((s) => s.toast);
  const clients = props.clients;

  const schema = useMemo(() => buildSchema(!!clients), [clients]);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors },
  } = useForm<FormInput, unknown, FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { clientId: '', comment: '' },
  });
  const selectedId = watch('clientId');

  const client = clients ? clients.find((c) => c.id === selectedId) : undefined;
  const accounting = props.wash ? props.wash.client_accounting : client?.accounting || 'weight';
  const clientName = props.wash ? props.wash.client_name : client?.name || '';

  // По-типовой ввод количества (как CompleteWashModal): степперы по видам белья
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [itemsErr, setItemsErr] = useState('');

  // Видимые виды: список клиента (DayWash.client_item_types / Clients.item_types)
  // или весь справочник
  const ownIds = props.wash ? props.wash.client_item_types : parseClientTypes(client?.item_types || '');
  const vis: ItemType[] = useMemo(
    () => (ownIds && ownIds.length ? itemTypes.filter((t) => ownIds.indexOf(t.id) !== -1) : itemTypes.slice()),
    [itemTypes, ownIds]
  );
  const showItemList = accounting !== 'weight' && vis.length > 0;
  const itemsSum = Object.keys(counts).reduce((s, k) => s + (counts[k] || 0), 0);

  const mutation = useApiMutation('addManualClean', {
    invalidate: 'operational',
    onSuccess: () => {
      toast(successToast);
      onClose();
    },
  });

  const stepCount = (tid: string, d: number) =>
    setCounts((m) => ({ ...m, [tid]: Math.max(0, (m[tid] || 0) + d) }));

  const onSubmit = handleSubmit((v) => {
    // Вес обязателен, кроме accounting='count'; штуки при count — сумма по видам > 0
    if (accounting !== 'count' && (!v.weightKg || v.weightKg <= 0)) {
      setError('weightKg', { message: 'Укажите вес (> 0)' });
      return;
    }
    if (accounting === 'count' && (showItemList ? itemsSum <= 0 : !v.itemsTotal || v.itemsTotal <= 0)) {
      if (showItemList) setItemsErr('Укажите штуки (> 0)');
      else setError('itemsTotal', { message: 'Укажите штуки (> 0)' });
      return;
    }
    const clientId = props.wash ? props.wash.client_id : v.clientId;
    const items = showItemList
      ? Object.keys(counts)
          .filter((k) => counts[k] > 0)
          .map((k) => ({ item_type_id: k, qty: counts[k] }))
      : [];
    mutation.mutate([
      clientId,
      accounting === 'count' ? '' : v.weightKg || '',
      showItemList ? itemsSum || '' : v.itemsTotal || '',
      v.bags,
      v.comment.trim(),
      items,
    ]);
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={props.wash ? `Чистое вручную: ${clientName}` : 'Внести чистое вручную'}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={mutation.isPending}>
            Назад
          </Button>
          <Button onClick={onSubmit} busy={mutation.isPending}>
            Внести
          </Button>
        </>
      }
    >
      <form className={styles.form} onSubmit={onSubmit}>
        {clients && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Клиент</span>
            <select {...register('clientId')}>
              <option value="">— выберите клиента —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {errors.clientId && <span className={styles.fieldErr}>{errors.clientId.message}</span>}
          </label>
        )}
        {accounting !== 'count' && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Вес, кг</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              min="0"
              {...register('weightKg', { valueAsNumber: true })}
            />
            {errors.weightKg && <span className={styles.fieldErr}>{errors.weightKg.message}</span>}
          </label>
        )}
        {showItemList ? (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Количество по видам</span>
            {vis.map((t) => (
              <div key={t.id} className={styles.itemRow}>
                <span className={styles.itemName}>{t.name}</span>
                <Stepper
                  value={counts[t.id] || 0}
                  steps={UNIT_STEPS}
                  onStep={(d) => stepCount(t.id, d)}
                  onValueChange={(v) =>
                    setCounts((m) => ({ ...m, [t.id]: Math.max(0, Math.round(v)) }))
                  }
                />
              </div>
            ))}
            <div className={styles.totalRow}>
              Всего: <b className="mono">{itemsSum}</b> шт
            </div>
            {itemsErr && <span className={styles.fieldErr}>{itemsErr}</span>}
          </div>
        ) : (
          // Без списка видов (учёт «по весу» или пустой справочник) — одно поле
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              Штук{accounting === 'count' ? '' : ' (необязательно)'}
            </span>
            <input
              type="number"
              inputMode="numeric"
              step="1"
              min="0"
              {...register('itemsTotal', { valueAsNumber: true })}
            />
            {errors.itemsTotal && (
              <span className={styles.fieldErr}>{errors.itemsTotal.message}</span>
            )}
          </label>
        )}
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Мешков</span>
          <input
            type="number"
            inputMode="numeric"
            step="1"
            min="1"
            {...register('bags', { valueAsNumber: true })}
          />
          {errors.bags && <span className={styles.fieldErr}>{errors.bags.message}</span>}
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Комментарий — откуда бельё</span>
          <textarea rows={2} {...register('comment')} />
          {errors.comment && <span className={styles.fieldErr}>{errors.comment.message}</span>}
        </label>
      </form>
    </Modal>
  );
}
