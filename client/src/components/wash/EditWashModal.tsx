'use client';

// Правка веса/мешков/пересчёта завершённой стирки (legacy confirmEdit,
// server/public/index.html:959-979, spec §7.3). Единая модалка для карточки
// стирки и отчёта (R8): типы грузятся через useRefs, по умолчанию counts
// строятся из w.items; карточка передаёт несохранённые правки степперов
// через initialCounts/initialTotal.
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation, useRefs } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { num } from '@/lib/format';
import styles from './wash-modals.module.css';

// weight/bags — строки, парсим при сабмите (как legacy: parseFloat/parseInt || 0)
const schema = z.object({
  weight: z.string(),
  bags: z.string(),
});

type FormValues = z.infer<typeof schema>;

// Узкий структурный тип: модалке не важно, из какого ответа пришла стирка
export interface EditWashModalProps {
  w: {
    id: string;
    client_name: string;
    dirty_weight_kg: number | string;
    bags: number | string;
    items?: { item_type_id: string; qty: number | string }[];
  };
  initialCounts?: Record<string, number>; // карточка: несохранённые правки степперов
  initialTotal?: number;                  // карточка: total для плашки «Новый пересчёт»
  onSaved?: () => void;                   // карточка: обнулить countsMap
  onClose: () => void;
}

export function EditWashModal({ w, initialCounts, initialTotal, onSaved, onClose }: EditWashModalProps) {
  const toast = useUiStore((s) => s.toast);
  const refs = useRefs();
  const types = (refs.data?.itemTypes || []).filter((t) => t.active === 'да');

  const [counts, setCounts] = useState<Record<string, number>>(() => {
    if (initialCounts) return initialCounts;
    const c: Record<string, number> = {};
    (w.items || []).forEach((it) => {
      c[it.item_type_id] = num(it.qty);
    });
    return c;
  });
  const itemsSum = Object.keys(counts).reduce((s, k) => s + (counts[k] || 0), 0);
  // Плашка «Новый пересчёт» — только в контексте карточки (initialTotal)
  const total = initialTotal ?? itemsSum;

  const {
    register,
    handleSubmit,
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { weight: String(num(w.dirty_weight_kg)), bags: String(num(w.bags)) },
  });

  const mutation = useApiMutation('editWashData', {
    invalidate: 'operational',
    onSuccess: () => {
      toast('Данные обновлены ✓');
      onSaved?.();
      onClose();
    },
  });

  const onSubmit = handleSubmit((v) => {
    const items = Object.keys(counts)
      .filter((k) => counts[k] > 0)
      .map((k) => ({ item_type_id: k, qty: counts[k] }));
    const kg = parseFloat(String(v.weight).replace(',', '.')) || 0;
    const bagsCount = parseInt(String(v.bags), 10) || 0;
    mutation.mutate([w.id, kg, items, bagsCount]);
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Изменить данные: ${w.client_name}`}
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
        {initialTotal !== undefined && (
          <div className={styles.meta}>
            Новый пересчёт: <b>{total} шт</b>
          </div>
        )}
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Вес, кг</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0"
            {...register('weight')}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Мешков</span>
          <input type="number" inputMode="numeric" step="1" min="0" {...register('bags')} />
        </label>
        {types.length > 0 && (
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
        )}
      </div>
    </Modal>
  );
}
