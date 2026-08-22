'use client';

// Диалог карточки плана: перенос (+1..+3 дня или произвольная дата) и удаление —
// порт openWeekCard (server/public/index.html:1785-1834). Перенос только вперёд, как в legacy.
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { formatDateRu, shiftDateStr, weekdayOf } from '@/lib/dates';
import type { DecoratedVisit } from '@/types/api';
import styles from './plan.module.css';

export interface WeekCardDialogProps {
  card: DecoratedVisit | null;
  onClose: () => void;
}

export function WeekCardDialog({ card, onClose }: WeekCardDialogProps) {
  const toast = useUiStore((s) => s.toast);
  const moveMut = useApiMutation('moveWeekCard', { invalidate: 'operational' });
  const delMut = useApiMutation('removeWeekCard', { invalidate: 'operational' });
  const [newDate, setNewDate] = useState('');
  const [movingTo, setMovingTo] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  // Сброс состояния при открытии другой карточки — корректировка при рендере (без эффекта)
  const cardId = card?.id ?? null;
  const [prevCardId, setPrevCardId] = useState(cardId);
  if (cardId !== prevCardId) {
    setPrevCardId(cardId);
    setNewDate('');
    setMovingTo(null);
    setConfirmDel(false);
  }

  if (!card) return null;
  const c = card;

  // Не «planned» — только просмотр: перенос и удаление недоступны (как в legacy)
  if (c.status !== 'planned') {
    return (
      <Modal
        open
        onClose={onClose}
        title={c.client_name}
        footer={
          <Button variant="ghost" onClick={onClose}>
            Назад
          </Button>
        }
      >
        <div className={styles.dialogHint}>
          Статус: <StatusBadge status={c.status} size="sm" /> — перенос и удаление недоступны
        </div>
      </Modal>
    );
  }

  const quick = [1, 2, 3].map((n) => shiftDateStr(c.date, n));
  const canMove = !!newDate && newDate > c.date;

  async function doMove(d: string) {
    setMovingTo(d);
    try {
      await moveMut.mutateAsync([c.id, d]);
      toast(`Перенесено на ${weekdayOf(d)}, ${formatDateRu(d)}`);
      onClose();
    } catch {
      // Текст ошибки уже показал useApiMutation
    } finally {
      setMovingTo(null);
    }
  }

  async function doRemove() {
    try {
      await delMut.mutateAsync([c.id]);
      toast('Убрано из плана');
      setConfirmDel(false);
      onClose();
    } catch {
      // Текст ошибки уже показал useApiMutation
    }
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={c.client_name}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={!!movingTo}>
              Отмена
            </Button>
            <Button
              variant="ghost"
              className={styles.delBtn}
              onClick={() => setConfirmDel(true)}
              disabled={!!movingTo}
            >
              Убрать из плана
            </Button>
          </>
        }
      >
        <div className={styles.dialogHint}>
          Текущая доставка:{' '}
          <b>
            {weekdayOf(c.date)}, {formatDateRu(c.date)}
          </b>
        </div>
        <div className={styles.dialogLabel}>Перенести на:</div>
        <div className={styles.quickRow}>
          {quick.map((d) => (
            <Button
              key={d}
              variant="ghost"
              busy={movingTo === d}
              disabled={!!movingTo && movingTo !== d}
              onClick={() => doMove(d)}
            >
              {weekdayOf(d)} {formatDateRu(d, false)}
            </Button>
          ))}
        </div>
        <div className={styles.dialogLabel}>Другая дата:</div>
        <div className={styles.dateRow}>
          <input
            type="date"
            value={newDate}
            min={shiftDateStr(c.date, 1)}
            onChange={(e) => setNewDate(e.target.value)}
            disabled={!!movingTo}
          />
          <Button busy={movingTo !== null && movingTo === newDate} disabled={!canMove || !!movingTo} onClick={() => doMove(newDate)}>
            Перенести
          </Button>
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmDel}
        onClose={() => setConfirmDel(false)}
        onConfirm={doRemove}
        text={`Убрать «${c.client_name}» из плана на ${formatDateRu(c.date)}? Клиент останется в справочнике.`}
        okLabel="Убрать из плана"
        danger
        busy={delMut.isPending}
      />
    </>
  );
}
