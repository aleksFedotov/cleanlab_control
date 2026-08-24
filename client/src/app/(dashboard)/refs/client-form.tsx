'use client';

// Форма клиента (создание/редактирование) — перенос renderClientDetail
// (legacy index.html:2375-2451) в Modal. Поля 1:1: name, type,
// address, contact, comment, item_types (массив id), accounting +
// опциональные реквизиты: inn, kpp, legal_address.
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import type { Client, ItemType } from '@/types/api';
import { parseItemTypes } from './refs-utils';
import styles from './refs.module.css';

const CLIENT_TYPES = ['отель', 'ресторан', 'спа', 'прочее'] as const;
const ACCOUNTING = [
  ['both', 'Вес + количество'],
  ['weight', 'Только вес'],
  ['count', 'Только количество'],
] as const;

const schema = z.object({
  name: z.string().trim().min(1, 'Укажите название'),
  type: z.string(),
  address: z.string(),
  contact: z.string(),
  comment: z.string(),
  item_types: z.array(z.string()),
  accounting: z.enum(['both', 'weight', 'count']),
  // Реквизиты — опционально; если заполнены, проверяем формат
  inn: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d{10}$|^\d{12}$/.test(v), 'ИНН — 10 или 12 цифр'),
  kpp: z.string().trim().refine((v) => v === '' || /^\d{9}$/.test(v), 'КПП — 9 цифр'),
  legal_address: z.string(),
});
type FormValues = z.infer<typeof schema>;

export interface ClientFormProps {
  client: Client | null; // null — новый клиент
  itemTypes: ItemType[];
  onClose: () => void;
  onArchive: (c: Client) => void;
}

export function ClientForm({ client, itemTypes, onClose, onArchive }: ClientFormProps) {
  // В форме — только активные виды белья (legacy renderClientDetail)
  const activeTypes = itemTypes.filter((t) => t.active === 'да');
  const acc =
    client && (client.accounting === 'weight' || client.accounting === 'count')
      ? client.accounting
      : 'both';

  const save = useApiMutation('saveClient', {
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
    defaultValues: {
      name: client?.name || '',
      type: client?.type || 'отель',
      address: client?.address || '',
      contact: client?.contact || '',
      comment: client?.comment || '',
      item_types: client ? parseItemTypes(client.item_types) : [],
      accounting: acc,
      inn: client?.inn || '',
      kpp: client?.kpp || '',
      legal_address: client?.legal_address || '',
    },
  });

  function onSubmit(v: FormValues) {
    const payload: Record<string, unknown> = { ...v, item_types: v.item_types || [] };
    if (client?.id) payload.id = client.id;
    save.mutate(payload);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={client ? client.name : 'Новый клиент'}
      footer={
        <>
          {client?.id && client.active === 'да' && (
            <Button variant="danger" onClick={() => onArchive(client)} disabled={save.isPending}>
              В архив
            </Button>
          )}
          <Button variant="subtle" onClick={onClose} disabled={save.isPending}>
            Отмена
          </Button>
          <Button type="submit" form="clientForm" busy={save.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <form id="clientForm" onSubmit={handleSubmit(onSubmit)} className={styles.form}>
        <div>
          <input type="text" placeholder="Название *" autoFocus {...register('name')} />
          {errors.name && <div className={styles.err}>{errors.name.message}</div>}
        </div>
        <div >
          <select aria-label="Тип клиента" {...register('type')}>
            {CLIENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <input type="text" placeholder="Адрес" {...register('address')} />
        <input type="text" placeholder="Контакт" {...register('contact')} />
        <input type="text" placeholder="Комментарий" {...register('comment')} />

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Реквизиты (необязательно)</div>
          <div>
            <input
              type="text"
              inputMode="numeric"
              placeholder="ИНН"
              {...register('inn')}
            />
            {errors.inn && <div className={styles.err}>{errors.inn.message}</div>}
          </div>
          <div>
            <input
              type="text"
              inputMode="numeric"
              placeholder="КПП"
              {...register('kpp')}
            />
            {errors.kpp && <div className={styles.err}>{errors.kpp.message}</div>}
          </div>
          <input type="text" placeholder="Юридический адрес" {...register('legal_address')} />
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Виды белья</div>
          <div className={styles.hint}>Ничего не отмечено — работник увидит все виды.</div>
          <div className={styles.checkList}>
            {activeTypes.map((t) => (
              <label key={t.id} className={styles.checkRow}>
                <input type="checkbox" value={t.id} {...register('item_types')} />
                <span>{t.name}</span>
              </label>
            ))}
            {!activeTypes.length && <div className={styles.hint}>Нет активных видов белья</div>}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Учёт результата</div>
          {ACCOUNTING.map(([v, label]) => (
            <label key={v} className={styles.checkRow}>
              <input type="radio" value={v} {...register('accounting')} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </form>
    </Modal>
  );
}
