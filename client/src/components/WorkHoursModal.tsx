'use client';

// Отметка/правка рабочих часов: дата + число часов. Общий для работника
// (вкладка «Часы», userId — свой) и владельца (табель, userId работника).
// hours=0 или пусто — сервер удаляет отметку (server/workhours.js setWorkHours).
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { formatDateRu } from '@/lib/dates';
import type { WorkHoursEntry } from '@/types/api';
import styles from './WorkHoursModal.module.css';

export interface WorkHoursModalProps {
  userId?: string; // для работника можно опустить — сервер подставит из сессии
  userName?: string;
  date: string; // yyyy-MM-dd, можно менять
  entry?: WorkHoursEntry; // существующая отметка (правка)
  onClose: () => void;
}

export function WorkHoursModal({ userId, userName, date, entry, onClose }: WorkHoursModalProps) {
  const toast = useUiStore((s) => s.toast);
  const [day, setDay] = useState(entry?.date || date);
  const [hours, setHours] = useState(entry ? String(entry.hours) : '');

  const mutation = useApiMutation('setWorkHours', {
    invalidate: ['workHours'],
    onSuccess: () => {
      toast('Сохранено ✓');
      onClose();
    },
  });

  function submit() {
    if (!day) {
      toast('Выберите дату', 'err');
      return;
    }
    const h = parseFloat(hours.replace(',', '.'));
    if (hours.trim() === '' ) {
      toast('Укажите часы (0 — убрать отметку)', 'err');
      return;
    }
    if (!isFinite(h) || h < 0 || h > 24) {
      toast('Часы: число от 0 до 24', 'err');
      return;
    }
    mutation.mutate([userId || '', day, h]);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Часы: ${userName || 'отметка'} · ${formatDateRu(day, false)}`}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={mutation.isPending}>
            Отмена
          </Button>
          <Button onClick={submit} busy={mutation.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Дата</span>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Отработано часов (0 — убрать отметку)</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.5"
            min="0"
            max="24"
            placeholder="например, 7.5"
            autoFocus
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}
