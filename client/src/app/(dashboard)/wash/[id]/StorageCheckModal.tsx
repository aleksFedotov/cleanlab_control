'use client';

// Проверка склада: три варианта в любом состоянии — подтвердить текущее
// или изменить на одно из двух других (legacy openStorageCheck,
// server/public/index.html:919-957).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { StorageAccountSummary } from '@/components/StorageAccountSummary';
import { ManualCleanModal } from '@/app/worker/ManualCleanModal';
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
  // P8: ручное внесение чистого — отдельный шаг, после успеха возврат сюда
  const [manualClean, setManualClean] = useState(false);

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

  if (manualClean) {
    return (
      <ManualCleanModal
        wash={w}
        successToast="Чистое внесено ✓ — подтвердите проверку склада"
        onClose={() => setManualClean(false)}
      />
    );
  }

  return (
    <Modal open onClose={onClose} title="Проверка склада">
      <div className={styles.form}>
        <div className={styles.meta}>
          <b>{w.client_name}</b>
        </div>
        <StorageAccountSummary storage={w.storage} />
        {order.map((v, i) => {
          const blocked = v === 'already_clean' && !w.has_clean;
          return (
            <div key={v}>
              <Button
                variant={i === 0 ? 'primary' : v === 'no_dirty' ? 'danger' : 'ghost'}
                onClick={() => pick(v)}
                busy={pending === v && mutation.isPending}
                disabled={(mutation.isPending && pending !== v) || blocked}
              >
                {i === 0 ? 'Подтвердить: ' : 'Изменить: '}
                {LABELS[v]}
              </Button>
              {blocked && (
                <>
                  <div className={styles.meta}>По учёту чистого на складе нет</div>
                  <Button variant="ghost" onClick={() => setManualClean(true)}>
                    Внести чистое вручную…
                  </Button>
                </>
              )}
            </div>
          );
        })}
        <div>
          <Button variant="subtle" onClick={onClose} disabled={mutation.isPending}>
            Назад
          </Button>
        </div>
      </div>
    </Modal>
  );
}
