'use client';

// Форма вида белья (создание/переименование) — перенос openTypeForm
// (legacy index.html:2452-2469) в Modal.
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import type { ItemType } from '@/types/api';
import styles from './refs.module.css';

const schema = z.object({
  name: z.string().trim().min(1, 'Укажите название'),
});
type FormValues = z.infer<typeof schema>;

export interface TypeFormProps {
  type: ItemType | null; // null — новый вид
  onClose: () => void;
}

export function TypeForm({ type, onClose }: TypeFormProps) {
  const save = useApiMutation('saveItemType', {
    invalidate: ['refs', ...OPERATIONAL_PREFIXES],
    onSuccess: () => {
      useUiStore.getState().toast('Сохранено');
      onClose();
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: type?.name || '' },
  });

  function onSubmit(v: FormValues) {
    const payload: Record<string, unknown> = { name: v.name };
    if (type) payload.id = type.id;
    save.mutate(payload);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={type ? 'Переименовать тип' : 'Новый тип белья'}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={save.isPending}>
            Назад
          </Button>
          <Button type="submit" form="typeForm" busy={save.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <form id="typeForm" onSubmit={handleSubmit(onSubmit)} className={styles.form}>
        <div>
          <input type="text" placeholder="Название" autoFocus {...register('name')} />
          {errors.name && <div className={styles.err}>{errors.name.message}</div>}
        </div>
      </form>
    </Modal>
  );
}
