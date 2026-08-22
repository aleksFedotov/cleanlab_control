'use client';

// Проверка склада: три варианта в любом состоянии — подтвердить текущее
// или изменить на одно из двух других (legacy openStorageCheck,
// server/public/index.html:919-957).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import type { DayWash } from '@/types/api';
import styles from './wash-id.module.css';

type Verdict = 'has_dirty' | 'no_dirty' | 'already_clean';

const LABELS: Record<Verdict, string> = {
  has_dirty: 'Есть грязное бельё',
  no_dirty: 'Нет белья на складе',
  already_clean: 'Есть чистое бельё',
};

export interface StorageCheckModalProps {
  w: DayWash;
  checkedDirty: boolean;
  onHasDirty: () => void;
  onClose: () => void;
}

export function StorageCheckModal({ w, checkedDirty, onHasDirty, onClose }: StorageCheckModalProps) {
  const router = useRouter();
  const toast = useUiStore((s) => s.toast);
  const [pending, setPending] = useState<Verdict | null>(null);

  const mutation = useApiMutation('confirmStorageCheck', { invalidate: 'operational' });

  const current: Verdict =
    w.status === 'no_linen'
      ? 'no_dirty'
      : w.status === 'ready_clean'
        ? 'already_clean'
        : w.has_dirty || checkedDirty
          ? 'has_dirty'
          : w.has_clean
            ? 'already_clean'
            : 'no_dirty';

  const order: Verdict[] = [
    current,
    ...(['has_dirty', 'no_dirty', 'already_clean'] as Verdict[]).filter((v) => v !== current),
  ];

  function pick(verdict: Verdict) {
    setPending(verdict);
    mutation.mutate([w.id, verdict], {
      onSuccess: () => {
        onClose();
        if (verdict === 'has_dirty') {
          onHasDirty();
          toast('Грязное подтверждено ✓');
          // остаёмся в карточке — появится «В работу»
        } else {
          toast('Подтверждено ✓');
          router.push('/wash'); // стирка снята — назад на доску
        }
      },
      onError: () => setPending(null),
    });
  }

  return (
    <Modal open onClose={onClose} title="Проверка склада">
      <div className={styles.form}>
        <div className={styles.meta}>
          <b>{w.client_name}</b>
        </div>
        {order.map((v, i) => (
          <Button
            key={v}
            variant={i === 0 ? 'primary' : v === 'no_dirty' ? 'danger' : 'ghost'}
            onClick={() => pick(v)}
            busy={pending === v && mutation.isPending}
            disabled={mutation.isPending && pending !== v}
          >
            {i === 0 ? 'Подтвердить: ' : 'Изменить: '}
            {LABELS[v]}
          </Button>
        ))}
        <div>
          <Button variant="subtle" onClick={onClose} disabled={mutation.isPending}>
            Назад
          </Button>
        </div>
      </div>
    </Modal>
  );
}
