'use client';

// Диалог копирования плана другого дня в выбранный — полная замена: карточки
// целевого дня снимаются (removeWeekCard), затем вставляются все карточки
// источника. Источник — getWeekPlan(srcDate) (сервер нормализует дату до
// понедельника недели), вставка — последовательные addWeekCard, как в week-add-dialog.
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { api } from '@/lib/api';
import { getSession } from '@/lib/session';
import { useUiStore } from '@/stores/ui';
import { formatDateRu, shiftDateStr } from '@/lib/dates';
import type { DecoratedVisit, WeekPlanRes } from '@/types/api';
import styles from './plan.module.css';

export interface WeekCopyDialogProps {
  date: string | null;
  cards: DecoratedVisit[];
  onClose: () => void;
}

export function WeekCopyDialog({ date, cards, onClose }: WeekCopyDialogProps) {
  const toast = useUiStore((s) => s.toast);
  const addMut = useApiMutation('addWeekCard', { invalidate: 'operational' });
  // Удаление без инвалидации — общий рефетч сделает последний addWeekCard
  const delMut = useApiMutation('removeWeekCard');
  const [mode, setMode] = useState<'prev' | 'other'>('prev');
  const [srcDate, setSrcDate] = useState('');
  const [busy, setBusy] = useState(false);

  // Сброс выбора при смене дня — корректировка состояния при рендере (без эффекта)
  const [prevDate, setPrevDate] = useState(date);
  if (date !== prevDate) {
    setPrevDate(date);
    setMode('prev');
    setSrcDate('');
    setBusy(false);
  }

  function close() {
    setMode('prev');
    setSrcDate('');
    onClose();
  }

  async function submit() {
    if (!date) return;
    const src = mode === 'prev' ? shiftDateStr(date, -1) : srcDate;
    if (!src) {
      toast('Выберите дату', 'err');
      return;
    }
    if (src === date) {
      toast('Нельзя скопировать день сам в себя', 'err');
      return;
    }
    setBusy(true);
    try {
      const res = await api<WeekPlanRes>('getWeekPlan', getSession()?.token || '', src);
      const srcCards = res.days.find((d) => d.date === src)?.cards || [];
      if (!srcCards.length) {
        toast(`В день ${formatDateRu(src)} план пуст`, 'err');
        return;
      }
      // Полная замена дня: сначала снимаем текущие карточки, потом копируем все
      // карточки источника. Последовательно, чтобы не гонять запросы параллельно.
      for (const c of cards) {
        await delMut.mutateAsync(c.id);
      }
      for (const c of srcCards) {
        await addMut.mutateAsync([c.client_id, date]);
      }
      toast(`Скопировано: ${srcCards.length}`);
      close();
    } catch {
      // Текст ошибки уже показал useApiMutation/api; диалог закрываем, как в legacy
      close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!date}
      onClose={close}
      title={date ? `Скопировать в ${formatDateRu(date)}` : ''}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Назад
          </Button>
          <Button onClick={submit} busy={busy}>
            Скопировать
          </Button>
        </>
      }
    >
      <div className={styles.dialogHint}>Откуда скопировать план:</div>
      <div className={styles.pickList}>
        <label className={styles.pick}>
          <input
            type="radio"
            name="copyMode"
            checked={mode === 'prev'}
            disabled={busy}
            onChange={() => setMode('prev')}
          />
          <span>
            Предыдущий день{date ? ` — ${formatDateRu(shiftDateStr(date, -1))}` : ''}
          </span>
        </label>
        <label className={styles.pick}>
          <input
            type="radio"
            name="copyMode"
            checked={mode === 'other'}
            disabled={busy}
            onChange={() => setMode('other')}
          />
          <span>Другой день</span>
        </label>
      </div>
      {mode === 'other' && (
        <div className={styles.dateRow}>
          <input
            type="date"
            value={srcDate}
            disabled={busy}
            onChange={(e) => setSrcDate(e.target.value)}
          />
        </div>
      )}
    </Modal>
  );
}
