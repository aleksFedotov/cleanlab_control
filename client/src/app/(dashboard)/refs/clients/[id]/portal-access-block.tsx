'use client';

// Блок «Доступ в портал» в карточке клиента (тикет P1): заводит аккаунт роли
// client (setClientAccess), сбрасывает пароль (resetClientPassword), включает/
// отключает доступ (reactivateUser/deactivateUser). Пароль показывается один раз.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { getSession } from '@/lib/session';
import { useApiMutation, useUsers } from '@/hooks/use-api';
import { Accordion } from '@/components/ui/Accordion';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import styles from '../../refs.module.css';

function genPassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const buf = new Uint32Array(10);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

export function PortalAccessBlock({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const usersQ = useUsers();
  const account = (usersQ.data?.users || []).find(
    (u) => u.role === 'client' && u.client_id === clientId
  );

  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  // Пароль, показанный после последнего сохранения/сброса (один раз)
  const [shownPassword, setShownPassword] = useState('');
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetDraft, setResetDraft] = useState('');
  const [disableConfirm, setDisableConfirm] = useState(false);

  const invalidateUsers = () => qc.invalidateQueries({ queryKey: ['users'] });

  const save = useMutation({
    mutationFn: () =>
      api('setClientAccess', getSession()?.token || '', clientId, login.trim(), password),
    onSuccess: () => {
      setLoginError('');
      setShownPassword(password);
      setPassword('');
      invalidateUsers();
    },
    onError: (e: Error) => setLoginError(e.message || 'Ошибка сервера'),
  });

  const reset = useMutation({
    mutationFn: () =>
      api('resetClientPassword', getSession()?.token || '', clientId, resetDraft),
    onSuccess: () => {
      setShownPassword(resetDraft);
      setResetDraft('');
      setResetConfirm(false);
      invalidateUsers();
    },
  });

  const deactivate = useApiMutation('deactivateUser', { onSuccess: () => setDisableConfirm(false) });
  const reactivate = useApiMutation('reactivateUser');

  const summary = !account
    ? 'не настроен'
    : account.active === 'да'
      ? `логин: ${account.login}`
      : 'отключён';

  return (
    <Accordion id="client-portal" title="Доступ в портал" summary={summary}>
      {!account ? (
        <>
          <div className={styles.fieldRow}>
            <input
              type="text"
              placeholder="Логин"
              autoComplete="off"
              value={login}
              onChange={(e) => {
                setLogin(e.target.value);
                setLoginError('');
              }}
            />
          </div>
          {loginError && <div className={styles.err}>{loginError}</div>}
          <div className={styles.fieldRow} style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              placeholder="Пароль"
              autoComplete="new-password"
              style={{ flex: 1 }}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button variant="subtle" size="sm" onClick={() => setPassword(genPassword())}>
              Сгенерировать
            </Button>
          </div>
          <div className={styles.hint}>
            Пароль покажется один раз — передайте его клиенту. Логин должен быть уникальным.
          </div>
          <div style={{ marginTop: 8 }}>
            <Button
              variant="primary"
              busy={save.isPending}
              disabled={!login.trim() || !password}
              onClick={() => save.mutate()}
            >
              Сохранить доступ
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className={styles.fieldRow}>
            <input type="text" value={account.login} readOnly aria-label="Логин клиента" />
          </div>
          {account.active === 'да' ? (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => {
                    setResetDraft(genPassword());
                    setResetConfirm(true);
                  }}
                >
                  Сбросить пароль
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDisableConfirm(true)}>
                  Отключить доступ
                </Button>
              </div>
              <div className={styles.hint}>
                По этому логину клиент входит в личный кабинет с телефона.
              </div>
            </>
          ) : (
            <>
              <div className={styles.warnHint}>Доступ отключён — вход для клиента закрыт</div>
              <div style={{ marginTop: 8 }}>
                <Button variant="subtle" size="sm" busy={reactivate.isPending} onClick={() => reactivate.mutate(account.id)}>
                  Включить доступ
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {shownPassword && (
        <div className={styles.warnHint}>
          Новый пароль: <span className={styles.monoNum}>{shownPassword}</span> — показан один раз,
          передайте его клиенту.
        </div>
      )}

      <ConfirmDialog
        open={resetConfirm}
        onClose={() => setResetConfirm(false)}
        onConfirm={() => reset.mutate()}
        text={`Задать клиенту новый пароль? Старый перестанет работать. Новый пароль: ${resetDraft}`}
        okLabel="Сбросить"
        busy={reset.isPending}
      />
      <ConfirmDialog
        open={disableConfirm}
        onClose={() => setDisableConfirm(false)}
        onConfirm={() => {
          if (account) deactivate.mutate(account.id);
        }}
        text="Клиент не сможет входить в портал. Данные сохранятся, доступ можно вернуть кнопкой «Включить доступ»."
        okLabel="Отключить"
        danger
        busy={deactivate.isPending}
      />
    </Accordion>
  );
}
