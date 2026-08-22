'use client';

// Правка веса/пересчёта завершённой стирки из отчёта (legacy openEditDialog, spec §7.3).
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useRefs } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { api } from '@/lib/api';
import { getSession } from '@/lib/session';
import { OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import { num } from '@/lib/format';
import type { DayReportRes } from '@/types/api';
import styles from './report.module.css';

type ReportWash = DayReportRes['washes'][number];

const schema = z.object({
  weight: z.number().min(0, 'Не отрицательное'),
  bags: z.number().int('Целое число').min(0, 'Не отрицательное'),
});

type FormValues = z.infer<typeof schema>;

export interface EditWashModalProps {
  wash: ReportWash;
  onClose: () => void;
}

export function EditWashModal({ wash, onClose }: EditWashModalProps) {
  const toast = useUiStore((s) => s.toast);
  const refs = useRefs();
  const types = (refs.data?.itemTypes || []).filter((t) => t.active === 'да');

  const [counts, setCounts] = useState<Record<string, number>>(() => {
    const c: Record<string, number> = {};
    (wash.items || []).forEach((it) => {
      c[it.item_type_id] = num(it.qty);
    });
    return c;
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { weight: num(wash.dirty_weight_kg), bags: num(wash.bags) },
  });

  const qc = useQueryClient();
  // editWashData принимает 4 аргумента — useApiMutation прокидывает только один,
  // поэтому локальная мутация с тем же поведением (инвалидация operational + тост).
  const mutation = useMutation({
    mutationFn: (args: unknown[]) =>
      api('editWashData', getSession()?.token || '', ...args),
    onSuccess: () => {
      OPERATIONAL_PREFIXES.forEach((p) => qc.invalidateQueries({ queryKey: [p] }));
      toast('Данные обновлены ✓');
      onClose();
    },
    onError: (e: Error) => toast(e.message || 'Ошибка сервера', 'err'),
  });

  const onSubmit = handleSubmit((v) => {
    const items = Object.keys(counts)
      .filter((k) => counts[k] > 0)
      .map((k) => ({ item_type_id: k, qty: counts[k] }));
    mutation.mutate([wash.id, v.weight, items, v.bags]);
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Изменить данные: ${wash.client_name}`}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={mutation.isPending}>
            Назад
          </Button>
          <Button onClick={onSubmit} busy={mutation.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Вес, кг</span>
          <input type="number" inputMode="decimal" step="0.1" min="0" {...register('weight', { valueAsNumber: true })} />
          {errors.weight && <span className={styles.fieldErr}>{errors.weight.message}</span>}
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Мешков</span>
          <input type="number" inputMode="numeric" step="1" min="0" {...register('bags', { valueAsNumber: true })} />
          {errors.bags && <span className={styles.fieldErr}>{errors.bags.message}</span>}
        </label>
        <div className={styles.items}>
          {types.map((t) => (
            <div key={t.id} className={styles.itemRow}>
              <span>{t.name}</span>
              <div className={styles.stepper}>
                <button
                  type="button"
                  onClick={() =>
                    setCounts((c) => ({ ...c, [t.id]: Math.max(0, (c[t.id] || 0) - 1) }))
                  }
                >
                  −
                </button>
                <span className={styles.qty}>{counts[t.id] || 0}</span>
                <button
                  type="button"
                  onClick={() => setCounts((c) => ({ ...c, [t.id]: (c[t.id] || 0) + 1 }))}
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
