'use client';

// Перенос стирки на другой день (legacy openDefer, server/public/index.html:982-1008).
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useUiStore } from '@/stores/ui';
import { api } from '@/lib/api';
import { getSession } from '@/lib/session';
import { OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import { shiftDateStr } from '@/lib/dates';
import type { DayReportRes } from '@/types/api';
import styles from './report.module.css';

type ReportWash = DayReportRes['washes'][number];

const schema = z.object({
  date: z.string().min(1, 'Выберите дату'),
  reason: z.string(),
});

type FormValues = z.infer<typeof schema>;

export interface DeferWashModalProps {
  wash: ReportWash;
  onClose: () => void;
}

export function DeferWashModal({ wash, onClose }: DeferWashModalProps) {
  const toast = useUiStore((s) => s.toast);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { date: shiftDateStr(wash.wash_date, 1), reason: '' },
  });

  const qc = useQueryClient();
  // deferWash принимает 3 аргумента — локальная мутация с поведением useApiMutation.
  const mutation = useMutation({
    mutationFn: (args: unknown[]) =>
      api('deferWash', getSession()?.token || '', ...args),
    onSuccess: () => {
      OPERATIONAL_PREFIXES.forEach((p) => qc.invalidateQueries({ queryKey: [p] }));
      toast('Стирка перенесена ✓');
      onClose();
    },
    onError: (e: Error) => toast(e.message || 'Ошибка сервера', 'err'),
  });

  const onSubmit = handleSubmit((v) => {
    mutation.mutate([wash.id, v.date, v.reason]);
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
            onClick={() => setValue('date', shiftDateStr(wash.wash_date, 1))}
          >
            Завтра
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setValue('date', shiftDateStr(wash.wash_date, 2))}
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
