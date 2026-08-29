'use client';

// Форма вида белья (создание/переименование) — перенос openTypeForm
// (legacy index.html:2452-2469) в Modal.
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation, useBillingItems } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import type { ItemType } from '@/types/api';
import styles from './refs.module.css';

const schema = z.object({
  name: z.string().trim().min(1, 'Укажите название'),
  // Позиция в счёте (только штучные wash_pcs); '' — в счёт по весу
  billing_item_id: z.string(),
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
  const billing = useBillingItems();
  const pieceItems = (billing.data?.items || []).filter(
    (b) => b.kind === 'wash_pcs' && b.active === 'да'
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: type?.name || '', billing_item_id: type?.billing_item_id || '' },
  });

  function onSubmit(v: FormValues) {
    const payload: Record<string, unknown> = { name: v.name, billing_item_id: v.billing_item_id };
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
        <div>
          <div className={styles.sectionTitle}>Позиция в счёте</div>
          <select aria-label="Позиция в счёте" {...register('billing_item_id')}>
            <option value="">В счёт по весу</option>
            {pieceItems.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <div className={styles.hint}>
            Штучная позиция — бельё этого вида отбирается до взвешивания и идёт в счёт поштучно.
          </div>
        </div>
      </form>
    </Modal>
  );
}
