'use client';

// Модалка «Добавить / Изменить сотрудника» — перенос inline-формы legacy renderUsers
// (#uForm, server/public/index.html:1382-1439). В режиме редактирования пароль
// скрыт (его меняет «Сбросить пароль»), id редактируемого — в editing.
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { getSession } from '@/lib/session';
import { roleLabel } from '@/lib/dicts';
import type { Client, UserRole, UserRow } from '@/types/api';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import styles from './users.module.css';

const ROLES: UserRole[] = ['worker', 'driver', 'client', 'owner'];

interface FormValues {
  name: string;
  role: UserRole;
  login: string;
  password: string;
  clientId: string;
}

export interface UserFormModalProps {
  open: boolean;
  editing: UserRow | null;
  clients: Client[]; // только активные (фильтр — в page.tsx, как в legacy)
  onClose: () => void;
}

export function UserFormModal({ open, editing, clients, onClose }: UserFormModalProps) {
  const toast = useUiStore((s) => s.toast);

  // Обязательность пароля и clientId зависит от режима/роли (правила — как на сервере)
  const schema = useMemo(
    () =>
      z
        .object({
          name: z.string().trim().min(1, 'Укажите имя'),
          role: z.enum(['worker', 'driver', 'client', 'owner']),
          login: z.string().trim().min(1, 'Укажите логин'),
          password: z.string(),
          clientId: z.string(),
        })
        .superRefine((v, ctx) => {
          if (!editing && !v.password) {
            ctx.addIssue({ code: 'custom', path: ['password'], message: 'Укажите пароль' });
          }
          if (v.role === 'client' && !v.clientId) {
            ctx.addIssue({ code: 'custom', path: ['clientId'], message: 'Выберите клиента' });
          }
        }),
    [editing]
  );

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', role: 'worker', login: '', password: '', clientId: '' },
  });

  // Заполнение формы при открытии (legacy enterEdit) / сброс при добавлении
  useEffect(() => {
    if (!open) return;
    reset({
      name: editing?.name || '',
      role: editing?.role || 'worker',
      login: editing?.login || '',
      password: '',
      clientId: editing?.client_id || clients[0]?.id || '',
    });
  }, [open, editing, clients, reset]);

  const role = watch('role');

  const onSaved = () => {
    toast('Сохранено');
    onClose();
  };
  const createMut = useApiMutation('createUser', { invalidate: ['users'], onSuccess: onSaved });
  const updateMut = useApiMutation('updateUser', { invalidate: ['users'], onSuccess: onSaved });
  const busy = createMut.isPending || updateMut.isPending;

  const submit = handleSubmit((v) => {
    if (editing) {
      const payload: Record<string, string> = {
        id: editing.id,
        name: v.name,
        role: v.role,
        login: v.login,
      };
      if (v.role === 'client') payload.clientId = v.clientId;
      updateMut.mutate(payload);
    } else {
      const payload: Record<string, string> = {
        laundryId: getSession()?.laundryId || '',
        name: v.name,
        role: v.role,
        login: v.login,
        password: v.password,
      };
      if (v.role === 'client') payload.clientId = v.clientId;
      createMut.mutate(payload);
    }
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Изменить: ${editing.name}` : 'Добавить сотрудника'}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={submit} busy={busy}>
            {editing ? 'Сохранить' : 'Добавить сотрудника'}
          </Button>
        </>
      }
    >
      <form className={styles.form} onSubmit={submit}>
        <label className={styles.field}>
          <span className={styles.label}>Имя</span>
          <input {...register('name')} autoFocus />
          {errors.name && <span className={styles.err}>{errors.name.message}</span>}
        </label>
        <div className={styles.formRow}>
          <label className={styles.field}>
            <span className={styles.label}>Роль</span>
            <select {...register('role')}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Логин</span>
            <input {...register('login')} autoComplete="off" />
            {errors.login && <span className={styles.err}>{errors.login.message}</span>}
          </label>
        </div>
        {!editing && (
          <label className={styles.field}>
            <span className={styles.label}>Пароль</span>
            <input type="password" {...register('password')} autoComplete="new-password" />
            {errors.password && <span className={styles.err}>{errors.password.message}</span>}
          </label>
        )}
        {role === 'client' && (
          <label className={styles.field}>
            <span className={styles.label}>Клиент</span>
            <select {...register('clientId')}>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {errors.clientId && <span className={styles.err}>{errors.clientId.message}</span>}
          </label>
        )}
      </form>
    </Modal>
  );
}
