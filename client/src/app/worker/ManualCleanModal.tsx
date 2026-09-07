'use client';

// P8: ручное внесение чистого белья на склад (addManualClean).
// Два варианта: из карточки дня (wash — клиент и режим учёта известны)
// и со страницы склада владельца (clients — выбор активного клиента).
// Мешки/комментарий обязательны всегда; вес обязателен, кроме accounting='count';
// штуки обязательны при 'count', опциональны при 'both'.
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import type { Client, DayWash } from '@/types/api';
import styles from './ManualCleanModal.module.css';

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

function buildSchema(needClient: boolean, accounting: string) {
  return z
    .object({
      clientId: needClient ? z.string().min(1, 'Выберите клиента') : z.string(),
      weightKg: optNum,
      itemsTotal: optNum,
      bags: z.number({ error: 'Укажите мешки' }).int('Целое число').positive('Мешков должно быть > 0'),
      comment: z.string().trim().min(1, 'Укажите, откуда бельё'),
    })
    .superRefine((v, ctx) => {
      if (accounting !== 'count' && (!v.weightKg || v.weightKg <= 0)) {
        ctx.addIssue({ code: 'custom', path: ['weightKg'], message: 'Укажите вес (> 0)' });
      }
      if (accounting === 'count' && (!v.itemsTotal || v.itemsTotal <= 0)) {
        ctx.addIssue({ code: 'custom', path: ['itemsTotal'], message: 'Укажите штуки (> 0)' });
      }
    });
}

export type ManualCleanModalProps = {
  onClose: () => void;
  successToast?: string;
} & ({ wash: DayWash; clients?: undefined } | { clients: Client[]; wash?: undefined });

export function ManualCleanModal(props: ManualCleanModalProps) {
  const { onClose, successToast = 'Чистое внесено ✓' } = props;
  const toast = useUiStore((s) => s.toast);
  const clients = props.clients;

  const client = clients ? clients.find((c) => c.id === selectedId) : undefined;
  const accounting = props.wash ? props.wash.client_accounting : client?.accounting || 'weight';
  const clientName = props.wash ? props.wash.client_name : client?.name || '';

  const schema = useMemo(() => buildSchema(!!clients, accounting), [clients, accounting]);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { clientId: '', comment: '' },
  });
  const selectedId = watch('clientId');

  const mutation = useApiMutation('addManualClean', {
    invalidate: 'operational',
    onSuccess: () => {
      toast(successToast);
      onClose();
    },
  });

  const onSubmit = handleSubmit((v) => {
    const clientId = props.wash ? props.wash.client_id : v.clientId;
    mutation.mutate([
      clientId,
      accounting === 'count' ? '' : v.weightKg || '',
      v.itemsTotal || '',
      v.bags,
      v.comment.trim(),
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
        {(accounting === 'count' || accounting === 'both') && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              Штук{accounting === 'both' ? ' (необязательно)' : ''}
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
