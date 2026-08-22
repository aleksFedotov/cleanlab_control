'use client';

// Перенос стирки на другой день (legacy openDefer, server/public/index.html:982-1009).
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { shiftDateStr } from '@/lib/dates';
import type { DayWash } from '@/types/api';
import styles from './wash-id.module.css';

const schema = z.object({
  date: z.string().min(1, 'Выберите дату'),
  reason: z.string(),
});

type FormValues = z.infer<typeof schema>;

export interface DeferWashModalProps {
  w: DayWash;
  onDone: () => void;
  onClose: () => void;
}

export function DeferWashModal({ w, onDone, onClose }: DeferWashModalProps) {
  const toast = useUiStore((s) => s.toast);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { date: shiftDateStr(w.wash_date, 1), reason: '' },
  });

  const mutation = useApiMutation('deferWash', {
    invalidate: 'operational',
    onSuccess: () => {
      toast('Стирка перенесена ✓');
      onClose();
      onDone(); // стирка уехала на другой день — назад на доску
    },
  });

  const onSubmit = handleSubmit((v) => {
    mutation.mutate([w.id, v.date, v.reason]);
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Перенести стирку"
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={mutation.isPending}>
            Назад
          </Button>
          <Button onClick={onSubmit} busy={mutation.isPending}>
            Перенести
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.quickRow}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setValue('date', shiftDateStr(w.wash_date, 1))}
          >
            Завтра
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setValue('date', shiftDateStr(w.wash_date, 2))}
          >
            Послезавтра
          </Button>
        </div>
        <label className={styles.field}>
          <input type="date" {...register('date')} />
          {errors.date && <span className={styles.fieldErr}>{errors.date.message}</span>}
        </label>
        <label className={styles.field}>
          <input type="text" placeholder="Причина (необязательно)" {...register('reason')} />
        </label>
      </div>
    </Modal>
  );
}
