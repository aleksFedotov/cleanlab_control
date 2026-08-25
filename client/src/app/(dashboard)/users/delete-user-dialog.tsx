'use client';

// Диалог удаления сотрудника. Для любой роли — подтверждение «Вы уверены…»;
// для владельца (role === 'owner') дополнительно нужно ввести фразу
// «Удалить владельца <имя>» — иначе кнопка удаления неактивна.
import { useState } from 'react';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import type { UserRow } from '@/types/api';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import styles from './users.module.css';

export interface DeleteUserDialogProps {
  user: UserRow | null;
  onClose: () => void;
}

export function DeleteUserDialog({ user, onClose }: DeleteUserDialogProps) {
  const toast = useUiStore((s) => s.toast);
  const [phrase, setPhrase] = useState('');

  // Закрытие всегда сбрасывает введённую фразу
  const close = () => {
    setPhrase('');
    onClose();
  };

  const deleteMut = useApiMutation('deleteUser', {
    invalidate: ['users'],
    onSuccess: () => {
      toast('Удалён');
      close();
    },
  });

  if (!user) return null;

  const isOwner = user.role === 'owner';
  const requiredPhrase = `Удалить владельца ${user.name}`;
  const canConfirm = !isOwner || phrase.trim() === requiredPhrase;

  return (
    <Modal
      open={!!user}
      onClose={close}
      title="Подтверждение"
      footer={
        <>
          <Button variant="subtle" onClick={close} disabled={deleteMut.isPending}>
            Отмена
          </Button>
          <Button
            variant="danger"
            disabled={!canConfirm}
            busy={deleteMut.isPending}
            onClick={() => deleteMut.mutate(user.id)}
          >
            Удалить
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <p className={styles.deleteText}>
          Вы уверены, что хотите удалить {user.name}? Это действие необратимо.
        </p>
        {isOwner && (
          <label className={styles.field}>
            <span className={styles.label}>
              Введите фразу: <b>{requiredPhrase}</b>
            </span>
            <input
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoComplete="off"
              autoFocus
            />
          </label>
        )}
      </div>
    </Modal>
  );
}
