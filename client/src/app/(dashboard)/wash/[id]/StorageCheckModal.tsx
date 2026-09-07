'use client';

// Проверка склада: три карточки-вердикта, выбор + «Подтвердить» (редизайн,
// .superdesign/tmp/storage-check-approved.html). Снятие стирки — назад на доску.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { WashingMachine, CheckCircle2, XCircle, Check } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { StorageAccountSummary } from '@/components/StorageAccountSummary';
import { ManualCleanModal } from '@/app/worker/ManualCleanModal';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import type { DayWash, ItemType } from '@/types/api';
import styles from '@/components/storage-check.module.css';

type Verdict = 'has_dirty' | 'no_dirty' | 'already_clean';

const CARDS: { v: Verdict; title: string; sub: string; icon: typeof WashingMachine }[] = [
  { v: 'has_dirty', title: 'Есть грязное бельё', sub: 'Начать стирку', icon: WashingMachine },
  { v: 'already_clean', title: 'Есть чистое бельё', sub: 'Готово к выдаче', icon: CheckCircle2 },
  { v: 'no_dirty', title: 'Нет белья на складе', sub: 'Стирка снимается', icon: XCircle },
];

export interface StorageCheckModalProps {
  w: DayWash;
  itemTypes: ItemType[];
  checkedDirty: boolean;
  onHasDirty: () => void;
  onClose: () => void;
}

export function StorageCheckModal({ w, itemTypes, checkedDirty, onHasDirty, onClose }: StorageCheckModalProps) {
  const router = useRouter();
  const toast = useUiStore((s) => s.toast);
  // P8: ручное внесение чистого — отдельный шаг, после успеха возврат сюда
  const [manualClean, setManualClean] = useState(false);
  // Выбранный вердикт (по умолчанию — текущий); submit только по «Подтвердить»
  const [picked, setPicked] = useState<Verdict | null>(null);

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

  const blockedClean = !w.has_clean;
  const selected = picked ?? (current === 'already_clean' && blockedClean ? 'no_dirty' : current);

  function submit() {
    mutation.mutate([w.id, selected], {
      onSuccess: () => {
        onClose();
        if (selected === 'has_dirty') {
          onHasDirty();
          toast('Грязное подтверждено ✓');
          // остаёмся в карточке — появится «В работу»
        } else {
          toast('Подтверждено ✓');
          router.push('/wash'); // стирка снята — назад на доску
        }
      },
    });
  }

  if (manualClean) {
    return (
      <ManualCleanModal
        wash={w}
        itemTypes={itemTypes}
        successToast="Чистое внесено ✓ — подтвердите проверку склада"
        onClose={() => setManualClean(false)}
      />
    );
  }

  return (
    <Modal open onClose={onClose} title="Проверка склада" titleRight={w.client_name}>
      <div className={styles.form}>
        <StorageAccountSummary storage={w.storage} />
        <div className={styles.cards}>
          {CARDS.map(({ v, title, sub, icon: Icon }) => {
            const blocked = v === 'already_clean' && blockedClean;
            const isSelected = selected === v && !blocked;
            return (
              <div key={v}>
                <button
                  type="button"
                  className={`${styles.card} ${isSelected ? styles.selected : ''} ${blocked ? styles.disabled : ''}`}
                  onClick={() => !blocked && setPicked(v)}
                  disabled={blocked}
                  aria-pressed={isSelected}
                >
                  <span className={styles.badge}>
                    <Icon size={20} aria-hidden />
                  </span>
                  <span className={styles.cardBody}>
                    <div className={styles.cardTitle}>{title}</div>
                    <div className={styles.cardSub}>{sub}</div>
                  </span>
                  {isSelected && <Check size={20} className={styles.check} aria-hidden />}
                </button>
                {blocked && (
                  <>
                    <div className={styles.blockedNote}>По учёту чистого на складе нет</div>
                    <button type="button" className={styles.manualLink} onClick={() => setManualClean(true)}>
                      Внести чистое вручную…
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className={styles.actions}>
          <Button className={styles.confirmBtn} onClick={submit} busy={mutation.isPending}>
            Подтвердить
          </Button>
          <Button variant="subtle" className={styles.backBtn} onClick={onClose} disabled={mutation.isPending}>
            Назад
          </Button>
        </div>
      </div>
    </Modal>
  );
}
