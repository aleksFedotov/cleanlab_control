'use client';

// Форма позиции прайса (создание/редактирование) — saveBillingItem (P2).
// P2.2: свободное создание только для стирки (по весу / поштучно); позиции
// доставки и подъёма фиксированы и здесь не редактируются. Единица
// выставляется по kind (кг/шт), селекта единицы нет.
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation, useBillingItems } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import type { BillingItem, BillingKind } from '@/types/api';
import styles from './refs.module.css';

const KINDS: Array<[BillingKind, string]> = [
  ['wash_weight', 'Стирка по весу'],
  ['wash_pcs', 'Стирка поштучно'],
];

const schema = z.object({
  name: z.string().trim().min(1, 'Укажите название'),
  kind: z.enum(['wash_weight', 'wash_pcs']),
  ext_code: z.string(),
  active: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

export interface PriceItemFormProps {
  item: BillingItem | null; // null — новая позиция
  onClose: () => void;
}

export function PriceItemForm({ item, onClose }: PriceItemFormProps) {
  const billing = useBillingItems();
  const save = useApiMutation('saveBillingItem', {
    invalidate: ['billingItems', 'tariffs'],
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
    defaultValues: {
      name: item?.name || '',
      kind: item?.kind === 'wash_pcs' ? 'wash_pcs' : 'wash_weight',
      ext_code: item?.ext_code || '',
      active: item ? item.active === 'да' : true,
    },
  });

  // Весовая позиция на прачку одна: вариант «по весу» недоступен,
  // если активная весовая уже есть (сервер тоже отвергнет).
  const weightTaken = (billing.data?.items || []).some(
    (b) => b.kind === 'wash_weight' && b.active === 'да' && b.id !== item?.id
  );

  function onSubmit(v: FormValues) {
    const payload: Record<string, unknown> = {
      name: v.name,
      kind: v.kind,
      ext_code: v.ext_code,
      active: v.active ? 'да' : 'нет',
    };
    if (item) payload.id = item.id;
    save.mutate(payload);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={item ? item.name : 'Новая позиция прайса'}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={save.isPending}>
            Назад
          </Button>
          <Button type="submit" form="priceItemForm" busy={save.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <form id="priceItemForm" onSubmit={handleSubmit(onSubmit)} className={styles.form}>
        <div>
          <input type="text" placeholder="Название *" autoFocus {...register('name')} />
          {errors.name && <div className={styles.err}>{errors.name.message}</div>}
        </div>
        <div className={styles.checkRow} role="radiogroup" aria-label="Тип позиции">
          {KINDS.map(([v, label]) => (
            <label key={v} className={styles.checkRow}>
              <input
                type="radio"
                value={v}
                disabled={v === 'wash_weight' && weightTaken}
                {...register('kind')}
              />
              <span>
                {label}
                {v === 'wash_weight' && weightTaken && ' (уже есть активная)'}
              </span>
            </label>
          ))}
        </div>
        <input type="text" placeholder="Код НФ (ext_code)" {...register('ext_code')} />
        <label className={styles.checkRow}>
          <input type="checkbox" {...register('active')} />
          <span>Активна</span>
        </label>
      </form>
    </Modal>
  );
}
