'use client';

// Диалог закрытия смены (legacy openShiftClose, server/public/index.html:1033-1082).
// Данные — useShiftCloseState (всегда «сегодня» на сервере), мутация closeShift.
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Skeleton } from '@/components/ui/Skeleton';
import { useApiMutation, useShiftCloseState } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import styles from './wash.module.css';

const REASONS: Record<string, string> = {
  washing_incomplete: 'стирка не завершена',
  partial: 'стирка частичная',
  no_clean: 'нет чистого белья',
};

export interface ShiftCloseDialogProps {
  open: boolean;
  onClose: () => void;
  // Переход к стирке из списка блокеров. У работника нет страницы стирки —
  // без пропа кнопка «Открыть» не показывается.
  onOpenWash?: (washId: string) => void;
}

export function ShiftCloseDialog({ open, onClose, onOpenWash }: ShiftCloseDialogProps) {
  const toast = useUiStore((s) => s.toast);
  const { data, isPending, isError, error, refetch } = useShiftCloseState(open);
  const [forceConfirm, setForceConfirm] = useState(false);

  const closeMutation = useApiMutation('closeShift', {
    invalidate: 'operational',
    onSuccess: () => {
      setForceConfirm(false);
      toast('Смена закрыта ✓');
      onClose();
    },
  });

  const hasBlockers = !!data && data.blockers.length > 0;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={data ? `Закрытие смены ${data.date}` : 'Закрытие смены'}
        footer={
          isPending || isError || !data ? (
            <Button variant="subtle" onClick={onClose}>
              Назад
            </Button>
          ) : hasBlockers ? (
            <>
              <Button variant="subtle" onClick={onClose} disabled={closeMutation.isPending}>
                Назад
              </Button>
              <Button variant="danger" onClick={() => setForceConfirm(true)}>
                Закрыть с незавершёнными
              </Button>
            </>
          ) : (
            <>
              <Button variant="subtle" onClick={onClose} disabled={closeMutation.isPending}>
                Назад
              </Button>
              <Button
                variant="danger"
                onClick={() => closeMutation.mutate([])}
                busy={closeMutation.isPending}
              >
                Закрыть смену
              </Button>
            </>
          )
        }
      >
        {isPending && <Skeleton height={14} lines={4} />}
        {isError && !isPending && (
          <div className={styles.form}>
            <div className={styles.dlgMeta}>{error?.message || 'Ошибка загрузки'}</div>
            <div>
              <Button variant="ghost" size="sm" onClick={() => refetch()}>
                Повторить
              </Button>
            </div>
          </div>
        )}
        {data && hasBlockers && (
          <div className={styles.form}>
            <div className={styles.blockers}>
              <b>Незавершённые стирки ({data.blockers.length}):</b>
              {data.blockers.map((w) => (
                <div key={w.id} className={styles.blockerRow}>
                  <span>
                    {w.client_name} · {w.status === 'in_progress' ? 'в работе' : 'не начата'}
                  </span>
                  {onOpenWash && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onClose();
                        onOpenWash(w.id);
                      }}
                    >
                      Открыть
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <div className={styles.dlgMeta}>
              Перенести незавершённые стирки на другой день может только владелец — после
              закрытия он получит предупреждение.
            </div>
          </div>
        )}
        {data && !hasBlockers && (
          <div className={styles.form}>
            <div className={styles.dlgMeta}>
              Постирано <b>{data.report.totalKg} кг</b> · Завершено{' '}
              <b>{data.report.washesDone}</b> · Перенесено <b>{data.report.deferred}</b>
            </div>
            {data.notReady.length > 0 && (
              <div className={styles.blockers}>
                <b>К завтрашнему развозу не готовы:</b>
                {data.notReady.map((n) => (
                  <div key={n.visit_id} className={styles.dlgMeta}>
                    {n.client_name} — {REASONS[n.reason] || n.reason}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={forceConfirm}
        onClose={() => setForceConfirm(false)}
        onConfirm={() => closeMutation.mutate(true)}
        text={
          data
            ? `В смене остались незавершённые стирки (${data.blockers.length}). ` +
              'Подтверждаете, что знаете об этом? Владелец получит предупреждение и сможет перенести их на другой день.'
            : ''
        }
        okLabel="Закрыть смену"
        danger
        busy={closeMutation.isPending}
      />
    </>
  );
}
