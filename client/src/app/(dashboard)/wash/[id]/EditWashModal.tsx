'use client';

// Правка веса/пересчёта/мешков завершённой стирки (legacy confirmEdit,
// server/public/index.html:959-979). Пересчёт приходит из состояния карточки.
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { num } from '@/lib/format';
import type { DayWash } from '@/types/api';
import styles from './wash-id.module.css';

// weight/bags — строки, парсим при сабмите (как legacy: parseFloat/parseInt || 0)
const schema = z.object({
  weight: z.string(),
  bags: z.string(),
});

type FormValues = z.infer<typeof schema>;

export interface EditWashModalProps {
  w: DayWash;
  counts: Record<string, number>;
  totalQty: number;
  onSaved: () => void;
  onClose: () => void;
}

export function EditWashModal({ w, counts, totalQty, onSaved, onClose }: EditWashModalProps) {
  const toast = useUiStore((s) => s.toast);

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
      onSaved();
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
      title="Изменить данные стирки"
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
        <div className={styles.meta}>
          Новый пересчёт: <b>{totalQty} шт</b>
        </div>
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
      </div>
    </Modal>
  );
}
