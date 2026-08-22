'use client';

// Модалка карточки склада: подробности + действия по состоянию белья.
// Порт openStorageCard из legacy (server/public/index.html:1980-2087).
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { todayStr, shiftDateStr } from '@/lib/dates';
import type { StorageEntry } from './storage-entry';
import { daysDiff } from './storage-entry';
import styles from './storage.module.css';

type View = 'main' | 'defer' | 'issueDate';

const deferSchema = z.object({
  date: z
    .string()
    .min(1, 'Укажите дату')
    .refine((d) => d >= todayStr(), 'Дата не раньше сегодня'),
});
const issueSchema = z.object({ date: z.string().min(1, 'Укажите дату') });

type DateForm = z.infer<typeof issueSchema>;

export interface StorageCardModalProps {
  entry: StorageEntry;
  types: Record<string, string>;
  onClose: () => void;
}

export function StorageCardModal({ entry: e, types, onClose }: StorageCardModalProps) {
  const toast = useUiStore((s) => s.toast);
  const [view, setView] = useState<View>('main');
  const [confirmIssue, setConfirmIssue] = useState(false);
  const today = todayStr();

  const addWash = useApiMutation('addUnplannedWash', {
    invalidate: 'operational',
    onSuccess: () => { onClose(); toast('В плане на сегодня ✓'); },
  });
  const deferReturn = useApiMutation('deferWash', {
    invalidate: 'operational',
    onSuccess: () => { onClose(); toast('Вернули в стирку ✓'); },
  });
  const deferMove = useApiMutation('deferWash', {
    invalidate: 'operational',
    onSuccess: () => { onClose(); toast('Перенесено ✓'); },
  });
  // «Оставить на складе» — решение владельца запоминаем на сервере (hold),
  // иначе запись продолжает висеть как «требует решения».
  const holdPartial = useApiMutation('holdPartialWash', {
    invalidate: 'operational',
    onSuccess: () => { onClose(); toast('Осталось на складе ✓'); },
  });
  // Legacy после «Добавить в развоз» склад НЕ перезагружает — только тост.
  const addDelivery = useApiMutation('addDeliveryVisit', {
    invalidate: ['deliveryVisits'],
    onSuccess: () => { onClose(); toast('В развозе на завтра ✓'); },
  });
  const markIssued = useApiMutation('markIssued', {
    invalidate: 'operational',
    onSuccess: () => { setConfirmIssue(false); onClose(); toast('Выдано ✓'); },
  });
  const updateIssue = useApiMutation('updateIssueDate', {
    invalidate: 'operational',
    onSuccess: () => { onClose(); toast('Дата обновлена ✓'); },
  });

  const deferForm = useForm<DateForm>({
    resolver: zodResolver(deferSchema),
    defaultValues: { date: shiftDateStr(today, 1) },
  });
  const issueForm = useForm<DateForm>({
    resolver: zodResolver(issueSchema),
    defaultValues: { date: e.issue_date || today },
  });

  const positions = (e.items || [])
    .map((it) => `${types[it.item_type_id] || it.item_type_id} ×${it.qty}`)
    .join(', ');
  const overdueDays = e.kind === 'clean' ? daysDiff(e.issue_date, today) : 0;

  const title =
    view === 'defer' ? 'Перенести стирку' : view === 'issueDate' ? 'Дата выдачи' : e.client_name;

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={title}
        footer={
          view === 'defer' ? (
            <>
              <Button variant="subtle" onClick={onClose}>Назад</Button>
              <Button
                busy={deferMove.isPending}
                onClick={deferForm.handleSubmit((v) =>
                  deferMove.mutate([e.washId, v.date, 'перенос со склада'])
                )}
              >
                Перенести
              </Button>
            </>
          ) : view === 'issueDate' ? (
            <>
              <Button variant="subtle" onClick={onClose}>Назад</Button>
              <Button
                busy={updateIssue.isPending}
                onClick={issueForm.handleSubmit((v) => updateIssue.mutate([e.id, v.date]))}
              >
                Сохранить
              </Button>
            </>
          ) : (
            <Button variant="subtle" onClick={onClose}>Назад</Button>
          )
        }
      >
        {view === 'defer' && (
          <form
            className={styles.form}
            onSubmit={deferForm.handleSubmit((v) =>
              deferMove.mutate([e.washId, v.date, 'перенос со склада'])
            )}
          >
            <div className={styles.meta}>{e.client_name} · частично выполнено</div>
            <input type="date" min={today} {...deferForm.register('date')} />
            {deferForm.formState.errors.date && (
              <div className={styles.formError}>{deferForm.formState.errors.date.message}</div>
            )}
          </form>
        )}

        {view === 'issueDate' && (
          <form
            className={styles.form}
            onSubmit={issueForm.handleSubmit((v) => updateIssue.mutate([e.id, v.date]))}
          >
            <input type="date" {...issueForm.register('date')} />
            {issueForm.formState.errors.date && (
              <div className={styles.formError}>{issueForm.formState.errors.date.message}</div>
            )}
          </form>
        )}

        {view === 'main' && e.kind === 'dirty' && (
          <>
            <div className={styles.meta}>
              К стирке · грязное бельё, принято: <b>{e.since}</b>
            </div>
            <div className={styles.meta}>Вес и количество появятся после стирки.</div>
            <div className={styles.actions}>
              <Button
                className={styles.actionBtn}
                busy={addWash.isPending}
                onClick={() => addWash.mutate([e.client_id, 'со склада'])}
              >
                Поставить в стирку
              </Button>
            </div>
          </>
        )}

        {view === 'main' && e.kind === 'partial' && (
          <>
            <div className={styles.meta}>
              <b>Стирка выполнена частично</b> — работник не завершил её полностью.
            </div>
            <div className={styles.meta}>
              Фактический результат:{' '}
              <b>
                {e.kg} кг · {e.total} шт{e.bags > 0 ? ` · ${e.bags} меш.` : ''}
              </b>
            </div>
            <div className={styles.meta}>
              На складе с {e.since}.{' '}
              {e.washStatus !== 'partial'
                ? 'Остаток уже в плане стирки — достирка идёт по карточке дня.'
                : e.hold
                  ? 'Решение принято: оставлено на складе — вернуть в стирку можно в любой момент.'
                  : 'Клиент НЕ готов к развозу — решение принимает владелец.'}
            </div>
            {e.washStatus === 'partial' && (
              <div className={styles.actions}>
              <Button
                className={styles.actionBtn}
                busy={deferReturn.isPending}
                onClick={() => deferReturn.mutate([e.washId, today, 'возврат в стирку со склада'])}
              >
                Вернуть в стирку
              </Button>
              <Button variant="ghost" className={styles.actionBtn} onClick={() => setView('defer')}>
                Перенести на другой день
              </Button>
              {!e.hold && (
                <Button
                  variant="ghost"
                  className={styles.actionBtn}
                  busy={holdPartial.isPending}
                  onClick={() => holdPartial.mutate([e.washId])}
                >
                  Оставить на складе
                </Button>
              )}
              </div>
            )}
          </>
        )}

        {view === 'main' && e.kind === 'clean' && (
          <>
            <div className={styles.meta}>
              Чистое ·{' '}
              <b>
                {e.kg} кг · {e.total} шт{e.bags > 0 ? ` · ${e.bags} меш.` : ''}
              </b>
            </div>
            {positions && <div className={styles.meta}>{positions}</div>}
            <div className={styles.meta}>
              Выдача: <b>{e.issue_date}</b>
              {overdueDays > 0 && (
                <>
                  {' · '}
                  <span className={styles.overdue}>просрочено на {overdueDays} дн.</span>
                </>
              )}
            </div>
            <div className={styles.actions}>
              <Button
                className={styles.actionBtn}
                busy={addDelivery.isPending}
                onClick={() => addDelivery.mutate([e.client_id, shiftDateStr(today, 1)])}
              >
                Добавить в развоз
              </Button>
              <Button variant="ghost" className={styles.actionBtn} onClick={() => setConfirmIssue(true)}>
                Выдано
              </Button>
              <Button variant="ghost" className={styles.actionBtn} onClick={() => setView('issueDate')}>
                Изменить дату
              </Button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmIssue}
        onClose={() => setConfirmIssue(false)}
        onConfirm={() => markIssued.mutate([e.id])}
        text={`Отметить выдачу клиенту «${e.client_name}»?`}
        okLabel="Выдано"
        busy={markIssued.isPending}
      />
    </>
  );
}
