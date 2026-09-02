'use client';

// Модалка «Добавить / Изменить сотрудника» — перенос inline-формы legacy renderUsers
// (#uForm, server/public/index.html:1382-1439). В режиме редактирования пароль
// скрыт (его меняет «Сбросить пароль»), id редактируемого — в editing.
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useApiMutation, usePayRates, useSavePayRate } from '@/hooks/use-api';
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
  pointRate: string;
  liftRate: string;
  shiftBase: string;
  shiftNorm: string;
}

// Ставка: пусто (= дефолт прачки) или неотрицательное число — как в savePayRate
const rateField = z.string().refine(
  (v) => v.trim() === '' || (isFinite(Number(v)) && Number(v) >= 0),
  'Ставка: неотрицательное число или пусто'
);

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
          pointRate: rateField,
          liftRate: rateField,
          shiftBase: rateField,
          shiftNorm: rateField,
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
    defaultValues: {
      name: '', role: 'worker', login: '', password: '', clientId: '',
      pointRate: '', liftRate: '', shiftBase: '', shiftNorm: '',
    },
  });

  // Текущие переопределения ставок редактируемого сотрудника ('' = дефолт прачки)
  const ratesQ = usePayRates();
  const rateRow = useMemo(
    () => (editing ? (ratesQ.data?.rates || []).find((r) => r.user_id === editing.id) : undefined),
    [editing, ratesQ.data]
  );

  // Заполнение формы при открытии (legacy enterEdit) / сброс при добавлении
  useEffect(() => {
    if (!open) return;
    reset({
      name: editing?.name || '',
      role: editing?.role || 'worker',
      login: editing?.login || '',
      password: '',
      clientId: editing?.client_id || clients[0]?.id || '',
      pointRate: rateRow?.point_rate || '',
      liftRate: rateRow?.lift_floor_rate || '',
      shiftBase: rateRow?.shift_base || '',
      shiftNorm: rateRow?.shift_norm_hours || '',
    });
  }, [open, editing, clients, rateRow, reset]);

  const role = watch('role');

  const onSaved = () => {
    toast('Сохранено');
    onClose();
  };
  const createMut = useApiMutation('createUser', { invalidate: ['users'], onSuccess: onSaved });
  const updateMut = useApiMutation('updateUser', { invalidate: ['users'], onSuccess: onSaved });
  // Ставки сохраняем только для существующего сотрудника (при создании id ещё нет)
  const rateMut = useSavePayRate();
  const busy = createMut.isPending || updateMut.isPending || rateMut.isPending;

  const submit = handleSubmit((v) => {
    if (editing) {
      const payload: Record<string, string> = {
        id: editing.id,
        name: v.name,
        role: v.role,
        login: v.login,
      };
      if (v.role === 'client') payload.clientId = v.clientId;
      updateMut.mutate(payload, {
        onSuccess: () => {
          if (v.role === 'driver' || v.role === 'worker') {
            rateMut.mutate([
              editing.id,
              {
                point_rate: v.pointRate.trim(),
                lift_floor_rate: v.liftRate.trim(),
                shift_base: v.shiftBase.trim(),
                shift_norm_hours: v.shiftNorm.trim(),
              },
            ]);
          }
        },
      });
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
        {editing && (role === 'driver' || role === 'worker') && (
          <>
            <span className={styles.label}>Ставки оплаты (пусто = дефолт прачки)</span>
            {role === 'driver' && (
              <div className={styles.formRow}>
                <label className={styles.field}>
                  <span className={styles.label}>За точку, ₽</span>
                  <input type="number" min="0" step="any" {...register('pointRate')} />
                  {errors.pointRate && <span className={styles.err}>{errors.pointRate.message}</span>}
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>За этаж подъёма, ₽</span>
                  <input type="number" min="0" step="any" {...register('liftRate')} />
                  {errors.liftRate && <span className={styles.err}>{errors.liftRate.message}</span>}
                </label>
              </div>
            )}
            {role === 'worker' && (
              <div className={styles.formRow}>
                <label className={styles.field}>
                  <span className={styles.label}>Ставка смены, ₽</span>
                  <input type="number" min="0" step="any" {...register('shiftBase')} />
                  {errors.shiftBase && <span className={styles.err}>{errors.shiftBase.message}</span>}
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Норма часов смены</span>
                  <input type="number" min="0" step="any" {...register('shiftNorm')} />
                  {errors.shiftNorm && <span className={styles.err}>{errors.shiftNorm.message}</span>}
                </label>
              </div>
            )}
          </>
        )}
      </form>
    </Modal>
  );
}
