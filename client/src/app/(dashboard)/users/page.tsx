'use client';

// «Сотрудники» — перенос legacy renderUsers (server/public/index.html:1356-1486).
// Список пользователей прачки + добавление/редактирование (модалка), сброс пароля,
// деактивация/реактивация, привязка Telegram-кодом.
import { useEffect, useState, type ReactNode } from 'react';
import {
  CircleAlert,
  KeyRound,
  Pencil,
  Plus,
  Send,
  Trash2,
  UserCheck,
  Users as UsersIcon,
  UserX,
} from 'lucide-react';
import { useApiMutation, useRefs, useUsers } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { roleLabel } from '@/lib/dicts';
import type { UserRow } from '@/types/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Empty } from '@/components/ui/Empty';
import { Skeleton } from '@/components/ui/Skeleton';
import { UserFormModal } from './user-form-modal';
import { ResetPasswordModal } from './reset-password-modal';
import { DeleteUserDialog } from './delete-user-dialog';
import styles from './users.module.css';

export default function UsersPage() {
  const toast = useUiStore((s) => s.toast);
  const usersQuery = useUsers();
  const refsQuery = useRefs();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [deactTarget, setDeactTarget] = useState<UserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [tgCode, setTgCode] = useState<string | null>(null);

  const users = usersQuery.data?.users || [];
  // Как в legacy: в форму и подписи идут только активные клиенты
  const clients = (refsQuery.data?.clients || []).filter((c) => c.active === 'да');

  // Ошибка чтения — тост (спека §7); «Повторить» рендерится ниже, если данных нет
  useEffect(() => {
    if (usersQuery.error) toast(usersQuery.error.message || 'Ошибка загрузки', 'err');
  }, [usersQuery.error, toast]);

  const reactivateMut = useApiMutation('reactivateUser', {
    invalidate: ['users'],
    onSuccess: () => toast('Включён'),
  });
  const deactivateMut = useApiMutation('deactivateUser', {
    invalidate: ['users'],
    onSuccess: () => {
      toast('Отключён');
      setDeactTarget(null);
    },
  });
  const tgBindMut = useApiMutation<{ code: string }>('makeTelegramBindCode', {
    onSuccess: (res) => setTgCode(res.code),
  });

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (u: UserRow) => {
    setEditing(u);
    setFormOpen(true);
  };

  // Отключённые — приглушены, как в legacy (opacity .5 на всю строку)
  const dim = (u: UserRow, node: ReactNode) => (
    <div className={u.active !== 'да' ? styles.inactive : undefined}>{node}</div>
  );

  const columns: DataTableColumn[] = [
    {
      key: 'name',
      title: 'Имя',
      render: (u: UserRow) =>
        dim(
          u,
          <span className={styles.nameWrap}>
            <span>{u.name}</span>
            {u.active !== 'да' && <span className={styles.sub}>(отключён)</span>}
            {u.role === 'client' && (
              <span className={styles.sub}>{clientNameOf(clients, u.client_id)}</span>
            )}
          </span>
        ),
    },
    {
      key: 'role',
      title: 'Роль',
      render: (u: UserRow) => dim(u, <span className={styles.roleBadge}>{roleLabel(u.role)}</span>),
    },
    {
      key: 'login',
      title: 'Логин',
      render: (u: UserRow) => dim(u, u.login),
    },
    {
      key: 'actions',
      title: '',
      align: 'right',
      render: (u: UserRow) => {
        const inactive = u.active !== 'да';
        // Удаление доступно для любой роли (себя удалить не даст сервер);
        // для владельца в диалоге — доп. подтверждение фразой
        const deleteBtn = (
          <Button
            variant="subtle"
            size="sm"
            icon={<Trash2 size={15} />}
            title="Удалить"
            aria-label={`Удалить ${u.name}`}
            onClick={() => setDeleteTarget(u)}
          />
        );
        return (
          <div className={`${styles.actions} ${inactive ? styles.inactive : ''}`}>
            <Button
              variant="subtle"
              size="sm"
              icon={<Pencil size={15} />}
              title="Изменить"
              aria-label={`Изменить ${u.name}`}
              onClick={() => openEdit(u)}
            />
            {inactive ? (
              <>
                <Button
                  variant="subtle"
                  size="sm"
                  icon={<UserCheck size={15} />}
                  title="Включить"
                  aria-label={`Включить ${u.name}`}
                  busy={reactivateMut.isPending && reactivateMut.variables === u.id}
                  onClick={() => reactivateMut.mutate(u.id)}
                />
                {deleteBtn}
              </>
            ) : (
              <>
                {u.role !== 'owner' && (
                  <>
                    <Button
                      variant="subtle"
                      size="sm"
                      icon={<KeyRound size={15} />}
                      title="Сбросить пароль"
                      aria-label={`Сбросить пароль: ${u.name}`}
                      onClick={() => setResetTarget(u)}
                    />
                    <Button
                      variant="subtle"
                      size="sm"
                      icon={<UserX size={15} />}
                      title="Отключить"
                      aria-label={`Отключить ${u.name}`}
                      onClick={() => setDeactTarget(u)}
                    />
                  </>
                )}
                {deleteBtn}
              </>
            )}
          </div>
        );
      },
    },
  ];

  let content: ReactNode;
  if (usersQuery.isPending) {
    content = (
      <div className={styles.skel} aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} height={46} radius="var(--radius-m)" />
        ))}
      </div>
    );
  } else if (usersQuery.isError && !users.length) {
    content = (
      <Empty
        icon={<CircleAlert size={28} />}
        title="Не удалось загрузить сотрудников"
        hint={usersQuery.error?.message}
        action={
          <Button variant="ghost" onClick={() => usersQuery.refetch()}>
            Повторить
          </Button>
        }
      />
    );
  } else if (!users.length) {
    content = (
      <Empty
        icon={<UsersIcon size={28} />}
        title="Сотрудников пока нет"
        hint="Добавьте работника, водителя или клиента"
        action={
          <Button icon={<Plus size={16} />} onClick={openCreate}>
            Добавить
          </Button>
        }
      />
    );
  } else {
    content = <DataTable columns={columns} rows={users} keyField="id" />;
  }

  return (
    <>
      <PageHeader
        title="Сотрудники"
        actions={
          <>
            <Button
              variant="ghost"
              icon={<Send size={15} />}
              busy={tgBindMut.isPending}
              onClick={() => tgBindMut.mutate([])}
            >
              Привязать Telegram
            </Button>
            <Button icon={<Plus size={16} />} onClick={openCreate}>
              Добавить
            </Button>
          </>
        }
      />
      {content}

      <UserFormModal
        open={formOpen}
        editing={editing}
        clients={clients}
        onClose={() => setFormOpen(false)}
      />
      <ResetPasswordModal user={resetTarget} onClose={() => setResetTarget(null)} />
      <DeleteUserDialog user={deleteTarget} onClose={() => setDeleteTarget(null)} />
      <ConfirmDialog
        open={!!deactTarget}
        onClose={() => setDeactTarget(null)}
        onConfirm={() => deactTarget && deactivateMut.mutate(deactTarget.id)}
        text="Отключить сотрудника? Вход под его логином перестанет работать."
        okLabel="Отключить"
        danger
        busy={deactivateMut.isPending}
      />
      <Modal
        open={!!tgCode}
        onClose={() => setTgCode(null)}
        title="Привязка Telegram"
        footer={
          <Button onClick={() => setTgCode(null)}>Понятно</Button>
        }
      >
        <div className={styles.tgCode}>{tgCode}</div>
        <p className={styles.tgHint}>
          Отправьте этот код боту в Telegram — он действует 10 минут.
        </p>
      </Modal>
    </>
  );
}

function clientNameOf(clients: { id: string; name: string }[], id: string): string {
  const c = clients.filter((x) => x.id === id)[0];
  return c ? c.name : '';
}
