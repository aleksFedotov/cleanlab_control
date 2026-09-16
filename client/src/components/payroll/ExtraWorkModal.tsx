'use client';

// Модалка доп. работы (P12). Два режима:
// - driver: дата фиксирована (DateNav экрана), запись всегда за себя;
// - owner: выбор водителя + дата, плюс правка существующей записи (editing).
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useAddExtraWork, useEditExtraWork, useClientsBrief } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { todayStr } from '@/lib/dates';
import { roleLabel } from '@/lib/dicts';
import type { ExtraWorkListItem, PayrollEmployee } from '@/types/api';
import styles from './ExtraWorkModal.module.css';

export interface ExtraWorkModalProps {
  open: boolean;
  onClose: () => void;
  mode: 'driver' | 'owner';
  // driver: дата с экрана «Маршрут», ввод только на неё
  date?: string;
  // owner: сотрудники для выбора (только водители показываем)
  employees?: PayrollEmployee[];
  // owner: правка существующей записи
  editing?: ExtraWorkListItem | null;
  // P12.1: предзаполненный клиент из карточки визита (clientName — для option,
  // если клиента нет в списке активных), lockClient — select заблокирован
  clientId?: string;
  clientName?: string;
  lockClient?: boolean;
}

export function ExtraWorkModal({ open, onClose, mode, date, employees = [], editing, clientId, clientName, lockClient }: ExtraWorkModalProps) {
  // Монтируем форму заново при каждом открытии — черновик сбрасывается сам
  if (!open) return null;
  return (
    <ExtraWorkForm
      onClose={onClose}
      mode={mode}
      date={date}
      employees={employees}
      editing={editing}
      clientId={clientId}
      clientName={clientName}
      lockClient={lockClient}
    />
  );
}

function ExtraWorkForm({ onClose, mode, date, employees = [], editing, clientId: presetClientId, clientName, lockClient }: Omit<ExtraWorkModalProps, 'open'>) {
  const drivers = employees.filter((e) => e.role === 'driver');
  const [userId, setUserId] = useState(editing?.user_id || drivers[0]?.user_id || '');
  const [clientId, setClientId] = useState(editing?.client_id || presetClientId || '');
  const [workDate, setWorkDate] = useState(editing?.date || date || todayStr());
  const [amount, setAmount] = useState(editing ? String(editing.amount) : '');
  const [comment, setComment] = useState(editing?.comment || '');
  const toast = useUiStore((s) => s.toast);

  const clients = useClientsBrief();
  const addMut = useAddExtraWork(() => {
    toast('Доп. работа добавлена ✓');
    onClose();
  });
  const editMut = useEditExtraWork(() => {
    toast('Доп. работа сохранена ✓');
    onClose();
  });
  const busy = addMut.isPending || editMut.isPending;

  function submit() {
    if (!clientId) return toast('Выберите клиента', 'err');
    const amt = Number(amount);
    if (amount === '' || !isFinite(amt) || amt <= 0) return toast('Сумма: положительное число', 'err');
    if ((mode === 'owner' || editing) && !comment.trim()) return toast('Комментарий обязателен', 'err');
    if (editing) {
      editMut.mutate([editing.id, { date: workDate, client_id: clientId, amount: amt, comment: comment.trim() }]);
    } else if (mode === 'owner') {
      if (!userId) return toast('Выберите водителя', 'err');
      addMut.mutate([clientId, workDate, amt, comment.trim(), userId]);
    } else {
      addMut.mutate([clientId, workDate, amt, comment.trim()]);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Правка доп. работы' : 'Доп. работа'}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={submit} busy={busy}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {mode === 'owner' && !editing && (
          <label className={styles.field}>
            <span className={styles.label}>Водитель</span>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              {drivers.map((e) => (
                <option key={e.user_id} value={e.user_id}>
                  {e.name} — {roleLabel(e.role)}
                </option>
              ))}
            </select>
          </label>
        )}
        {editing && (
          <div className={styles.field}>
            <span className={styles.label}>Сотрудник</span>
            <div>{editing.user_name}</div>
          </div>
        )}
        <label className={styles.field}>
          <span className={styles.label}>Клиент</span>
          <select value={clientId} disabled={lockClient} onChange={(e) => setClientId(e.target.value)}>
            <option value="">— выберите —</option>
            {lockClient && presetClientId && clientName && !(clients.data?.clients || []).some((c) => c.id === presetClientId) && (
              <option value={presetClientId}>{clientName}</option>
            )}
            {(clients.data?.clients || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.formRow}>
          {mode === 'owner' && (
            <label className={styles.field}>
              <span className={styles.label}>Дата</span>
              <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
            </label>
          )}
          <label className={styles.field}>
            <span className={styles.label}>Сумма, ₽</span>
            <input
              type="number"
              min="0.01"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="500"
            />
          </label>
        </div>
        <label className={styles.field}>
          <span className={styles.label}>Что делал{mode === 'driver' && !editing ? ' (необязательно)' : ''}</span>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="погрузка, подъём нестандарта…" />
        </label>
      </div>
    </Modal>
  );
}
