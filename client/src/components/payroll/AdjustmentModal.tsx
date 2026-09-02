'use client';

// Модалка ручной корректировки зарплаты (премия/штраф). Общая для страниц
// «Зарплата» (payroll) и «Табель» в режиме месяца (P4).
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useSavePayAdjustment } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { todayStr } from '@/lib/dates';
import { roleLabel } from '@/lib/dicts';
import type { PayrollEmployee } from '@/types/api';
import styles from './AdjustmentModal.module.css';

export interface AdjustmentModalProps {
  open: boolean;
  onClose: () => void;
  employees: PayrollEmployee[];
}

export function AdjustmentModal({ open, onClose, employees }: AdjustmentModalProps) {
  // Монтируем форму заново при каждом открытии — черновик сбрасывается сам
  if (!open) return null;
  return <AdjustmentForm onClose={onClose} employees={employees} />;
}

function AdjustmentForm({ onClose, employees }: { onClose: () => void; employees: PayrollEmployee[] }) {
  const [userId, setUserId] = useState(employees[0]?.user_id || '');
  const [date, setDate] = useState(todayStr());
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const toast = useUiStore((s) => s.toast);

  const mutation = useSavePayAdjustment(() => {
    toast('Корректировка сохранена');
    onClose();
  });

  function submit() {
    if (!userId) return toast('Выберите сотрудника', 'err');
    const amt = Number(amount);
    if (amount === '' || !isFinite(amt)) return toast('Сумма: число со знаком', 'err');
    mutation.mutate([userId, date, amt, comment.trim()]);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Корректировка"
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
          <span className={styles.label}>Сотрудник</span>
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            {employees.map((e) => (
              <option key={e.user_id} value={e.user_id}>
                {e.name} — {roleLabel(e.role)}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.formRow}>
          <label className={styles.field}>
            <span className={styles.label}>Дата</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Сумма, ₽</span>
            <input
              type="number"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="+500 премия / −300 штраф"
            />
          </label>
        </div>
        <label className={styles.field}>
          <span className={styles.label}>Комментарий</span>
          <input value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
