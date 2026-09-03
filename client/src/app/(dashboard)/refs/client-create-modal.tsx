'use client';

// Компактная модалка создания клиента (P2.3): только Название*, Тип, Контакт
// с label сверху; остальное — дефолты (type=отель, accounting=both,
// item_types=[] = все виды), донастройка — на странице клиента после создания.
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import type { Client } from '@/types/api';
import styles from './refs.module.css';

const CLIENT_TYPES = ['отель', 'ресторан', 'спа', 'прочее'] as const;

const schema = z.object({
  name: z.string().trim().min(1, 'Укажите название'),
  type: z.string(),
  contact: z.string(),
});
type FormValues = z.infer<typeof schema>;

export function ClientCreateModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const save = useApiMutation<{ client: Client }>('saveClient', {
    invalidate: ['refs', ...OPERATIONAL_PREFIXES],
    onSuccess: (res) => {
      useUiStore.getState().toast('Клиент создан');
      onClose();
      router.push(`/refs/clients/${res.client.id}`);
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', type: 'отель', contact: '' },
  });

  function onSubmit(v: FormValues) {
    save.mutate({
      ...v,
      address: '',
      comment: '',
      item_types: [],
      accounting: 'both',
      inn: '',
      kpp: '',
      legal_address: '',
      access_note: '',
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Новый клиент"
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={save.isPending}>
            Отмена
          </Button>
          <Button type="submit" form="clientCreateForm" busy={save.isPending}>
            Создать
          </Button>
        </>
      }
    >
      <div className={styles.hint}>Остальное настроите позже в карточке клиента</div>
      <form id="clientCreateForm" onSubmit={handleSubmit(onSubmit)} className={styles.form}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="clientName">Название *</label>
          <input id="clientName" type="text" autoFocus {...register('name')} />
          {errors.name && <div className={styles.err}>{errors.name.message}</div>}
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="clientType">Тип</label>
          <select id="clientType" {...register('type')}>
            {CLIENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="clientContact">Контакт</label>
          <input id="clientContact" type="text" {...register('contact')} />
        </div>
      </form>
    </Modal>
  );
}
