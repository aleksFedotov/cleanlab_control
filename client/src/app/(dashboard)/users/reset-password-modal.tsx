'use client';

// Модалка сброса пароля — замена legacy prompt('Новый пароль сотрудника:')
// (server/public/index.html:1460-1468). API: resetUserPassword(token, userId, newPassword).
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import type { UserRow } from '@/types/api';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import styles from './users.module.css';

const schema = z.object({ password: z.string().min(1, 'Укажите новый пароль') });

export interface ResetPasswordModalProps {
  user: UserRow | null;
  onClose: () => void;
}

export function ResetPasswordModal({ user, onClose }: ResetPasswordModalProps) {
  const toast = useUiStore((s) => s.toast);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<{ password: string }>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (user) reset({ password: '' });
  }, [user, reset]);

  // Пароль не влияет на список — инвалидация не нужна (как в legacy: без перерисовки)
  const mut = useApiMutation('resetUserPassword', {
    onSuccess: () => {
      toast('Пароль изменён');
      onClose();
    },
  });

  const submit = handleSubmit((v) => {
    if (user) mut.mutate([user.id, v.password]);
  });

  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title={user ? `Сброс пароля: ${user.name}` : 'Сброс пароля'}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={mut.isPending}>
            Отмена
          </Button>
          <Button onClick={submit} busy={mut.isPending}>
            Сменить пароль
          </Button>
        </>
      }
    >
      <form className={styles.form} onSubmit={submit}>
        <label className={styles.field}>
          <span className={styles.label}>Новый пароль</span>
          <input
            type="password"
            {...register('password')}
            autoComplete="new-password"
            autoFocus={!!user}
          />
          {errors.password && <span className={styles.err}>{errors.password.message}</span>}
        </label>
      </form>
    </Modal>
  );
}
