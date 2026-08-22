'use client';

// Внеплановая стирка на сегодня (legacy openAddWash, server/public/index.html:1012-1030).
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import type { Client } from '@/types/api';
import styles from './wash.module.css';

const schema = z.object({
  clientId: z.string().min(1, 'Выберите клиента'),
  comment: z.string(),
});

type FormValues = z.infer<typeof schema>;

export interface AddWashModalProps {
  clients: Client[];
  onClose: () => void;
}

export function AddWashModal({ clients, onClose }: AddWashModalProps) {
  const toast = useUiStore((s) => s.toast);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { clientId: clients[0]?.id || '', comment: '' },
  });

  const mutation = useApiMutation('addUnplannedWash', {
    invalidate: 'operational',
    onSuccess: () => {
      toast('Стирка добавлена ✓');
      onClose();
    },
  });

  const onSubmit = handleSubmit((v) => {
    mutation.mutate([v.clientId, v.comment]);
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Новая стирка (сегодня)"
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={mutation.isPending}>
            Назад
          </Button>
          <Button onClick={onSubmit} busy={mutation.isPending}>
            Добавить
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Клиент</span>
          <select {...register('clientId')}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {errors.clientId && <span className={styles.fieldErr}>{errors.clientId.message}</span>}
        </label>
        <label className={styles.field}>
          <input type="text" placeholder="Комментарий" {...register('comment')} />
        </label>
      </div>
    </Modal>
  );
}
