'use client';

// Страница «Прачки» (legacy: renderLaundries, server/public/index.html:1487-1531).
import { useEffect, useState } from 'react';
import { Building2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useLaundries, useApiMutation } from '@/hooks/use-api';
import { getSession } from '@/lib/session';
import { useUiStore } from '@/stores/ui';
import type { LaundryRow } from '@/types/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Empty } from '@/components/ui/Empty';
import { Skeleton } from '@/components/ui/Skeleton';
import { LaundryFormModal } from './laundry-form-modal';
import styles from './page.module.css';

interface CreateLaundryRes {
  ok: true;
  laundry: { id: string; name: string };
  tvKey: string;
}

export default function LaundriesPage() {
  const { data, isPending, isError, error, refetch } = useLaundries();
  const toast = useUiStore((s) => s.toast);

  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<LaundryRow | null>(null);
  const [deactivating, setDeactivating] = useState<LaundryRow | null>(null);

  // Ошибка чтения без данных — тост один раз (спека §7).
  useEffect(() => {
    if (isError && !data) toast(error?.message || 'Ошибка сервера', 'err');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isError]);

  const activeLaundryId = getSession()?.laundryId || '';

  const createMut = useApiMutation<CreateLaundryRes>('createLaundry', {
    invalidate: ['laundries'],
    onSuccess: (r) => {
      toast(`Прачка «${r.laundry.name}» добавлена ✓`);
      setCreateOpen(false);
    },
  });

  const renameMut = useApiMutation('updateLaundry', {
    invalidate: ['laundries'],
    onSuccess: () => {
      toast('Сохранено ✓');
      setRenaming(null);
    },
  });

  const deactivateMut = useApiMutation('deactivateLaundry', {
    invalidate: ['laundries'],
    onSuccess: () => {
      toast('Отключена');
      setDeactivating(null);
    },
  });

  const laundries = data?.laundries || [];

  const columns: DataTableColumn[] = [
    { key: 'name', title: 'Название' },
    {
      key: 'tv',
      title: 'Табло',
      render: (l: LaundryRow) =>
        l.tvKey ? (
          <span className={styles.tvCell}>
            <a href={`/tv.html?key=${l.tvKey}`} target="_blank" rel="noopener noreferrer">
              Табло
            </a>
            <span className={`mono ${styles.tvKey}`}>{l.tvKey}</span>
          </span>
        ) : (
          <span className={styles.muted}>нет ключа</span>
        ),
    },
    {
      key: 'actions',
      title: '',
      align: 'right',
      render: (l: LaundryRow) => (
        <span className={styles.actions}>
          <Button
            variant="subtle"
            size="sm"
            icon={<Pencil size={16} />}
            aria-label="Переименовать"
            onClick={() => setRenaming(l)}
          />
          {l.id === activeLaundryId ? (
            <span className={styles.muted}>активна</span>
          ) : (
            <Button
              variant="subtle"
              size="sm"
              icon={<Trash2 size={16} />}
              aria-label="Отключить"
              onClick={() => setDeactivating(l)}
            />
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Прачки"
        actions={
          <Button icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
            Добавить
          </Button>
        }
      />

      {isPending ? (
        <div className={styles.loading}>
          <Skeleton height={44} radius={10} lines={4} />
        </div>
      ) : isError && !data ? (
        <Empty
          icon={<Building2 size={40} />}
          title="Не удалось загрузить прачки"
          hint={error?.message}
          action={<Button onClick={() => refetch()}>Повторить</Button>}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={laundries}
          keyField="id"
          empty={
            <Empty
              icon={<Building2 size={40} />}
              title="Прачек пока нет"
              hint="Добавьте первую прачку, чтобы вести по ней учёт"
              action={
                <Button icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
                  Добавить
                </Button>
              }
            />
          }
        />
      )}

      <LaundryFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Новая прачка"
        submitLabel="Добавить"
        busy={createMut.isPending}
        onSubmit={(name) => createMut.mutate({ name })}
      />

      <LaundryFormModal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="Переименовать прачку"
        initialName={renaming?.name || ''}
        submitLabel="Сохранить"
        busy={renameMut.isPending}
        onSubmit={(name) => renaming && renameMut.mutate({ id: renaming.id, name })}
      />

      <ConfirmDialog
        open={!!deactivating}
        onClose={() => setDeactivating(null)}
        onConfirm={() => deactivating && deactivateMut.mutate(deactivating.id)}
        text="Отключить прачку? Данные сохранятся, но прачка пропадёт из списков."
        okLabel="Отключить"
        danger
        busy={deactivateMut.isPending}
      />
    </>
  );
}
