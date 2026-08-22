'use client';

// Правка даты выдачи у завершённой стирки (legacy stEditDate,
// server/public/index.html:2072-2086; сервер разрешает только done/stored).
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
  date: z.string().min(1, 'Выберите дату'),
});

type FormValues = z.infer<typeof schema>;

export interface IssueDateModalProps {
  w: DayWash;
  onClose: () => void;
}

export function IssueDateModal({ w, onClose }: IssueDateModalProps) {
  const toast = useUiStore((s) => s.toast);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { date: w.issue_date },
  });

  const mutation = useApiMutation('updateIssueDate', {
    invalidate: 'operational',
    onSuccess: () => {
      toast('Дата обновлена ✓');
      onClose();
    },
  });

  const onSubmit = handleSubmit((v) => {
    mutation.mutate([w.id, v.date]);
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Дата выдачи"
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
          <input type="date" {...register('date')} />
          {errors.date && <span className={styles.fieldErr}>{errors.date.message}</span>}
        </label>
      </div>
    </Modal>
  );
}
