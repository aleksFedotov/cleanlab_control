'use client';

// «Начать стирку» — перевод в работу с необязательным вводом веса грязного
// (legacy startBtn + startWash, server/public/index.html:714-722).
// Сервер: weightKg > 0 — записать, иначе пропустить.
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import type { DayWash } from '@/types/api';
import styles from './worker.module.css';

export interface StartWashModalProps {
  w: DayWash;
  onClose: () => void;
}

export function StartWashModal({ w, onClose }: StartWashModalProps) {
  const toast = useUiStore((s) => s.toast);
  const [weight, setWeight] = useState('');

  const mutation = useApiMutation('startWash', {
    invalidate: 'operational',
    onSuccess: () => {
      toast('В работе ✓');
      onClose();
    },
  });

  function submit() {
    const kg = parseFloat(weight.replace(',', '.')) || 0;
    mutation.mutate(kg > 0 ? [w.id, kg] : w.id);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`В работу: ${w.client_name}`}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={mutation.isPending}>
            Отмена
          </Button>
          <Button onClick={submit} busy={mutation.isPending}>
            В работу
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {!!w.piece_types?.length && (
          <div className={styles.plaque}>
            Отобрать до взвешивания: {w.piece_types.join(', ')}
          </div>
        )}
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Вес грязного белья, кг</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0"
            placeholder="—"
            autoFocus
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}
