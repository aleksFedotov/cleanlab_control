'use client';

// Диалог добавления клиентов в день развоза — порт openWeekAdd (server/public/index.html:1755-1783).
// Клиенты уже в развозе этого дня — disabled, добавление идёт последовательно, как в legacy.
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { formatDateRu } from '@/lib/dates';
import type { Client, DecoratedVisit } from '@/types/api';
import styles from './plan.module.css';

export interface WeekAddDialogProps {
  date: string | null;
  clients: Client[];
  cards: DecoratedVisit[];
  onClose: () => void;
}

export function WeekAddDialog({ date, clients, cards, onClose }: WeekAddDialogProps) {
  const toast = useUiStore((s) => s.toast);
  const addMut = useApiMutation('addWeekCard', { invalidate: 'operational' });
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Сброс выбора при смене дня — корректировка состояния при рендере (без эффекта)
  const [prevDate, setPrevDate] = useState(date);
  if (date !== prevDate) {
    setPrevDate(date);
    setPicked([]);
    setBusy(false);
  }

  const inDay = new Set(cards.map((c) => c.client_id));

  function close() {
    setPicked([]);
    onClose();
  }

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  async function submit() {
    if (!date) return;
    if (!picked.length) {
      toast('Отметьте хотя бы одного клиента', 'err');
      return;
    }
    setBusy(true);
    try {
      // Последовательно, чтобы не гонять запросы параллельно (как в legacy)
      for (const cid of picked) {
        await addMut.mutateAsync([cid, date]);
      }
      toast(`Добавлено: ${picked.length}`);
      close();
    } catch {
      // Текст ошибки уже показал useApiMutation; диалог закрываем, как в legacy
      close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!date}
      onClose={close}
      title={date ? `Развоз ${formatDateRu(date)}` : ''}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Назад
          </Button>
          <Button onClick={submit} busy={busy}>
            Добавить выбранных
          </Button>
        </>
      }
    >
      <div className={styles.dialogHint}>Отметьте клиентов (можно несколько):</div>
      <div className={styles.pickList}>
        {clients.map((c) => {
          const taken = inDay.has(c.id);
          return (
            <label key={c.id} className={`${styles.pick} ${taken ? styles.pickTaken : ''}`}>
              <input
                type="checkbox"
                checked={picked.includes(c.id)}
                disabled={taken || busy}
                onChange={() => toggle(c.id)}
              />
              <span>
                {c.name}
                {taken ? ' — уже в развозе' : ''}
              </span>
            </label>
          );
        })}
      </div>
    </Modal>
  );
}
