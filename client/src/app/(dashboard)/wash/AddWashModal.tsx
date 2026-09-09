'use client';

// Внеплановая стирка на сегодня (legacy openAddWash, server/public/index.html:1012-1030).
// Выбор клиента — поиск + видимый список (паттерн из delivery/AddVisitModal).
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check } from 'lucide-react';
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
  const [query, setQuery] = useState('');

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { clientId: '', comment: '' },
  });

  const selectedId = watch('clientId');

  const list = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? clients.filter(
          (c) =>
            c.name.toLowerCase().includes(needle) ||
            (c.address || '').toLowerCase().includes(needle)
        )
      : clients;
    return filtered.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [clients, query]);

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
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Клиент</span>
          <input
            type="search"
            className={styles.search}
            placeholder="Поиск по названию или адресу…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className={styles.pickList}>
            {list.length === 0 && <div className={styles.pickEmpty}>Никого не найдено</div>}
            {list.map((c) => {
              const active = c.id === selectedId;
              return (
                <div
                  key={c.id}
                  className={`${styles.pickRow} ${active ? styles.pickRowActive : ''}`}
                  onClick={() => setValue('clientId', c.id, { shouldValidate: true })}
                >
                  <div className={styles.pickMain}>
                    <div className={styles.pickName}>{c.name}</div>
                    {(c.type || c.address) && (
                      <div className={styles.pickMeta}>
                        {c.type || ''}
                        {c.type && c.address ? ' · ' : ''}
                        {c.address || ''}
                      </div>
                    )}
                  </div>
                  {active && (
                    <span className={styles.pickCheck}>
                      <Check size={16} />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {errors.clientId && <span className={styles.fieldErr}>{errors.clientId.message}</span>}
        </div>
        <label className={styles.field}>
          <input type="text" placeholder="Комментарий" {...register('comment')} />
        </label>
      </div>
    </Modal>
  );
}
