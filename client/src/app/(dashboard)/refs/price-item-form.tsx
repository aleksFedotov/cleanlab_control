'use client';

// Форма позиции прайса (создание/редактирование) — saveBillingItem (P2).
// Поля max_kg/oneway — только для рейсов (trip), per_floor — только для подъёма (lift).
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import type { BillingItem, BillingKind } from '@/types/api';
import styles from './refs.module.css';

const KINDS: Array<[BillingKind, string]> = [
  ['wash_weight', 'Стирка по весу'],
  ['wash_pcs', 'Стирка поштучно'],
  ['trip', 'Рейс'],
  ['lift', 'Подъём на этаж'],
];
const UNITS = ['кг', 'шт', 'рейс', 'этаж'] as const;

const schema = z.object({
  name: z.string().trim().min(1, 'Укажите название'),
  kind: z.enum(['wash_weight', 'wash_pcs', 'trip', 'lift']),
  unit: z.enum(UNITS),
  ext_code: z.string(),
  max_kg: z.string().trim().refine((v) => v === '' || Number(v) > 0, 'Ярус — положительное число'),
  oneway: z.boolean(),
  per_floor: z.boolean(),
  active: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

export interface PriceItemFormProps {
  item: BillingItem | null; // null — новая позиция
  onClose: () => void;
}

export function PriceItemForm({ item, onClose }: PriceItemFormProps) {
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
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: item?.name || '',
      kind: item?.kind || 'wash_weight',
      unit: (item?.unit as (typeof UNITS)[number]) || 'кг',
      ext_code: item?.ext_code || '',
      max_kg: item?.max_kg || '',
      oneway: item?.oneway === 'да',
      per_floor: item?.per_floor === 'да',
      active: item ? item.active === 'да' : true,
    },
  });

  const kind = watch('kind');

  function onSubmit(v: FormValues) {
    const payload: Record<string, unknown> = {
      name: v.name,
      kind: v.kind,
      unit: v.unit,
      ext_code: v.ext_code,
      max_kg: v.kind === 'trip' ? v.max_kg : '',
      oneway: v.kind === 'trip' && v.oneway ? 'да' : '',
      per_floor: v.kind === 'lift' && v.per_floor ? 'да' : '',
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
        <select aria-label="Тип позиции" {...register('kind')}>
          {KINDS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <select aria-label="Единица" {...register('unit')}>
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <input type="text" placeholder="Код НФ (ext_code)" {...register('ext_code')} />
        {kind === 'trip' && (
          <>
            <div>
              <input
                type="text"
                inputMode="numeric"
                placeholder="Ярус max_kg (пусто — без яруса)"
                {...register('max_kg')}
              />
              {errors.max_kg && <div className={styles.err}>{errors.max_kg.message}</div>}
            </div>
            <label className={styles.checkRow}>
              <input type="checkbox" {...register('oneway')} />
              <span>Только одна нога (в одну сторону)</span>
            </label>
          </>
        )}
        {kind === 'lift' && (
          <label className={styles.checkRow}>
            <input type="checkbox" {...register('per_floor')} />
            <span>За каждый этаж</span>
          </label>
        )}
        <label className={styles.checkRow}>
          <input type="checkbox" {...register('active')} />
          <span>Активна</span>
        </label>
      </form>
    </Modal>
  );
}
