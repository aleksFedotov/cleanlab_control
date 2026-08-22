'use client';

// «В работу» — перевод стирки в работу (legacy startBtn + startWash,
// server/public/index.html:714-722). Вес грязного необязателен на старте
// (сервер: weightKg > 0 — записать, иначе пропустить).
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import type { DayWash } from '@/types/api';
import styles from './wash-id.module.css';

const schema = z.object({
  weight: z.string(),
});

type FormValues = z.infer<typeof schema>;

export interface StartWashModalProps {
  w: DayWash;
  onDone: () => void;
  onClose: () => void;
}

export function StartWashModal({ w, onDone, onClose }: StartWashModalProps) {
  const toast = useUiStore((s) => s.toast);

  const { register, handleSubmit } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { weight: '' },
  });

  const mutation = useApiMutation('startWash', {
    invalidate: 'operational',
    onSuccess: () => {
      toast('В работе ✓');
      onClose();
      onDone(); // назад на доску цеха
    },
  });

  const onSubmit = handleSubmit((v) => {
    const kg = parseFloat(String(v.weight).replace(',', '.')) || 0;
    mutation.mutate(kg > 0 ? [w.id, kg] : w.id);
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`В работу: ${w.client_name}`}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={mutation.isPending}>
            Отмена
          </Button>
          <Button onClick={onSubmit} busy={mutation.isPending}>
            В работу
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Вес грязного белья, кг (необязательно)</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0"
            placeholder="—"
            autoFocus
            {...register('weight')}
          />
        </label>
      </div>
    </Modal>
  );
}
