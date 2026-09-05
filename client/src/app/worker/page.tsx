'use client';

// Мобильный экран работника (спека §6, логика — legacy renderDay/renderWashCard
// для роли worker, server/public/index.html:465-957). Всегда «сегодня» —
// у работника нет DateNav. Вкладки — локальное состояние, не маршруты.
import { useState } from 'react';
import { CalendarClock, ClipboardList, Clock, Plus, Trash2, User, Waves, AlertTriangle} from 'lucide-react';
import { useRequireRole, useLogout } from '@/hooks/use-session';
import { useApiMutation, useDayList, useWorkHours } from '@/hooks/use-api';
import { MobileLayout, MobileSection } from '@/components/layout/MobileLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Empty } from '@/components/ui/Empty';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Skeleton, SkeletonCards } from '@/components/ui/Skeleton';
import { todayStr, timeOf, shiftDateStr, formatDateRu } from '@/lib/dates';
import { num, kg, bags as bagsFmt, items as itemsFmt } from '@/lib/format';
import { roleLabel } from '@/lib/dicts';
import type { DayWash, WorkHoursEntry } from '@/types/api';
import { WorkHoursModal } from '@/components/WorkHoursModal';
import { CompleteWashModal } from './CompleteWashModal';
import { StartWashModal } from './StartWashModal';
import { StorageCheckModal } from './StorageCheckModal';
import { EditDoneWashModal } from './EditDoneWashModal';
import { AddWashModal } from '../(dashboard)/wash/AddWashModal';
import { DeferWashModal } from '../(dashboard)/wash/[id]/DeferWashModal';
import { ShiftCloseDialog } from '../(dashboard)/wash/ShiftCloseDialog';
import styles from './worker.module.css';

type Tab = 'tasks' | 'hours' | 'profile';

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? 'доброе утро' : h < 18 ? 'добрый день' : 'добрый вечер';
  return `${name}, ${part}`;
}

// Стирка «в работе»: детали + большая кнопка завершения (спека §6)
function ActiveWashCard({
  w,
  showDate,
  onComplete,
  onDefer,
  onDelete,
}: {
  w: DayWash;
  showDate?: boolean;
  onComplete: () => void;
  onDefer: () => void;
  onDelete: () => void;
}) {
  const meta: string[] = [];
  if (num(w.items_total) > 0) meta.push(itemsFmt(num(w.items_total)));
  if (w.dirty_weight_kg !== '' && w.dirty_weight_kg != null) meta.push(kg(w.dirty_weight_kg));
  const started = timeOf(w.started_at);
  return (
    <Card className={`${styles.washCard} ${w.status === 'no_linen' ? styles.washCardNoLinen : ''}`}>
      <div className={styles.washHead}>
        <span className={styles.washName}>{w.client_name}</span>
        {showDate && <span className={styles.dateChip}>от {formatDateRu(w.wash_date, false)}</span>}
        <StatusBadge status={w.status} />
      </div>
      {w.partial_rest && (
        <div className={`${styles.washMeta} ${styles.cmWarn}`}>
          <AlertTriangle size={13} /> Частично постирано: готово {(w.prev_items || []).reduce((s, it) => s + it.qty, 0)} поз.,{' '}
          {w.prev_kg} кг, {w.prev_bags} мешк. — остаток грязный
        </div>
      )}
      {meta.length > 0 && <div className={styles.washMeta}>{meta.join(' · ')}</div>}
      {started && <div className={styles.washMeta}>Начата в {started}</div>}
      {w.comment && <div className={styles.washMeta}>{w.comment}</div>}
      <Button className={styles.bigBtn} onClick={onComplete}>
        Завершить стирку
      </Button>
      <div className={styles.washActions}>
        <Button variant="ghost" size="sm" icon={<CalendarClock size={14} />} onClick={onDefer}>
          Перенести
        </Button>
        <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={onDelete}>
          Удалить
        </Button>
      </div>
    </Card>
  );
}

// Стирка из очереди: «Начать стирку» (если грязное есть/подтверждено) +
// «Проверить на складе» (legacy renderWashCard шаг 1)
function QueuedWashCard({
  w,
  checkedDirty,
  showDate,
  allowStart = true,
  onStart,
  onCheck,
  onDefer,
  onDelete,
}: {
  w: DayWash;
  checkedDirty: boolean;
  showDate?: boolean;
  // partial без решения владельца стартовать нельзя (только перенос) — кнопку прячем
  allowStart?: boolean;
  onStart: () => void;
  onCheck: () => void;
  onDefer: () => void;
  onDelete: () => void;
}) {
  const dirtyOk = allowStart && (w.has_dirty || checkedDirty);
  return (
    <Card className={`${styles.washCard} ${w.status === 'no_linen' ? styles.washCardNoLinen : ''}`}>
      <div className={styles.washHead}>
        <span className={styles.washName}>{w.client_name}</span>
        {showDate && <span className={styles.dateChip}>от {formatDateRu(w.wash_date, false)}</span>}
        <StatusBadge status={w.status} />
      </div>
      {w.status === 'no_linen' ? (
        <div className={styles.washMeta}>Белья нет — проверено в {timeOf(w.done_at)}</div>
      ) : (
        <div className={styles.washMeta}>
          {w.has_dirty
            ? 'Есть грязное — можно в работу'
            : w.has_clean
              ? 'Бельё уже чистое'
              : 'Нет белья на складе'}
        </div>
      )}
      {w.partial_rest && (
        <div className={`${styles.washMeta} ${styles.cmWarn}`}>
          <AlertTriangle size={13} /> Частично постирано: готово {(w.prev_items || []).reduce((s, it) => s + it.qty, 0)} поз.,{' '}
          {w.prev_kg} кг, {w.prev_bags} мешк. — остаток грязный
        </div>
      )}
      {/* {!!w.piece_types?.length && (
        <div className={styles.plaque}>Отобрать до взвешивания: {w.piece_types.join(', ')}</div>
      )} */}
      <div className={styles.washActions}>
        {dirtyOk && (
          <Button variant="ghost" className={styles.bigBtn} onClick={onStart}>
            Начать стирку
          </Button>
        )}
        <Button variant="ghost" className={styles.bigBtn} onClick={onCheck}>
          Проверить на складе
        </Button>
      </div>
      <div className={styles.washActions}>
        <Button variant="ghost" size="sm" icon={<CalendarClock size={14} />} onClick={onDefer}>
          Перенести
        </Button>
        <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={onDelete}>
          Удалить
        </Button>
      </div>
    </Card>
  );
}

export default function WorkerPage() {
  const session = useRequireRole(['worker']);
  const logout = useLogout();
  const [tab, setTab] = useState<Tab>('tasks');
  const [search, setSearch] = useState('');

  const day = useDayList(todayStr());
  // Отметки часов: месяц назад — месяц вперёд (можно ставить за будущие дни).
  // Сервер отдаёт работнику только его записи (server/workhours.js getWorkHours).
  const hoursQ = useWorkHours(shiftDateStr(todayStr(), -30), shiftDateStr(todayStr(), 30));
  const [hoursEdit, setHoursEdit] = useState<{ date: string; entry?: WorkHoursEntry } | null>(null);

  // Модалки и локальные подтверждения грязного (аналог state.checkedDirty)
  const [completeId, setCompleteId] = useState<string | null>(null);
  const [startId, setStartId] = useState<string | null>(null);
  const [checkId, setCheckId] = useState<string | null>(null);
  const [checkedMap, setCheckedMap] = useState<Record<string, boolean>>({});
  // Добавление/перенос/удаление/правка завершённой — работнику (владелец получает Telegram)
  const [addOpen, setAddOpen] = useState(false);
  const [deferId, setDeferId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  // Закрытие смены — диалог общий с дашбордом (ShiftCloseDialog)
  const [closeOpen, setCloseOpen] = useState(false);

  const deleteMut = useApiMutation('deleteWash', {
    invalidate: 'operational',
    onSuccess: () => setDeleteId(null),
  });

  if (!session) return null;

  const washes = day.data?.washes || [];
  // P7: «Осталось со вчера» — незавершённые вчерашние стирки
  const overdueAll = day.data?.overdue || [];
  // Поиск по клиенту (как washSearch на дашборде)
  const q = search.trim().toLowerCase();
  const matchQ = (w: DayWash) => w.client_name.toLowerCase().includes(q);
  const visible = q ? washes.filter(matchQ) : washes;
  const overdue = q ? overdueAll.filter(matchQ) : overdueAll;
  const inProgress = visible.filter((w) => w.status === 'in_progress');
  const queue = visible.filter((w) => w.status === 'planned');
  const doneList = visible.filter(
    (w) =>
      w.status === 'done' ||
      w.status === 'stored' ||
      w.status === 'partial' ||
      w.status === 'ready_clean' ||
      w.status === 'no_linen'
  );
  const doneCount = doneList.length;
  const shiftClosed = !!day.data?.shift && day.data.shift.status === 'closed';

  // Модалки ищут стирку и в сегодняшнем дне, и в просроченных (P7)
  const allWashes = washes.concat(overdueAll);
  const completeWash = completeId ? allWashes.find((w) => w.id === completeId) : undefined;
  const startWash = startId ? allWashes.find((w) => w.id === startId) : undefined;
  const checkWash = checkId ? allWashes.find((w) => w.id === checkId) : undefined;
  const deferWash = deferId ? allWashes.find((w) => w.id === deferId) : undefined;
  const deleteWash = deleteId ? allWashes.find((w) => w.id === deleteId) : undefined;
  const editWash = editId ? allWashes.find((w) => w.id === editId) : undefined;

  // Отметки часов, новые сверху; отметка за сегодня — отдельно для карточки
  const hoursEntries = (hoursQ.data?.entries || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  const todayEntry = hoursEntries.find((e) => e.date === todayStr());

  const nav = [
    { key: 'tasks', label: 'Задачи', icon: <ClipboardList size={19} /> },
    { key: 'hours', label: 'Часы', icon: <Clock size={19} /> },
    { key: 'profile', label: 'Профиль', icon: <User size={19} /> },
  ];

  const stats = [
    { value: inProgress.length, label: 'В работе' },
    { value: queue.length, label: 'В очереди' },
    { value: doneCount, label: 'Готово', tone: 'ok' as const },
  ];

  return (
    <MobileLayout
      contextLine={`Смена · ${day.data?.laundryName || 'Прачечная'}`}
      greeting={greeting(session.name)}
      stats={stats}
      nav={nav}
      activeNav={tab}
      onNav={(k) => setTab(k as Tab)}
    >
      {tab === 'tasks' && (
        <>
          {day.isPending && (
            <>
              <Skeleton height={12} width="40%" />
              <SkeletonCards count={3} />
            </>
          )}
          {day.isError && !day.data && (
            <Empty
              icon={<Waves size={40} />}
              title="Не удалось загрузить задачи"
              hint={day.error?.message || 'Проверьте связь.'}
              action={<Button onClick={() => day.refetch()}>Повторить</Button>}
            />
          )}
          {day.data && (
            <>
              <Button
                variant="ghost"
                className={styles.bigBtn}
                icon={<Plus size={16} />}
                onClick={() => setAddOpen(true)}
              >
                Добавить стирку
              </Button>
              <input
                type="search"
                className={styles.search}
                placeholder="Поиск по клиенту…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {overdue.length > 0 && (
                <MobileSection label={`Осталось со вчера (${overdue.length})`}>
                  {overdue.map((w) =>
                    w.status === 'in_progress' ? (
                      <ActiveWashCard
                        key={w.id}
                        w={w}
                        showDate
                        onComplete={() => setCompleteId(w.id)}
                        onDefer={() => setDeferId(w.id)}
                        onDelete={() => setDeleteId(w.id)}
                      />
                    ) : (
                      <QueuedWashCard
                        key={w.id}
                        w={w}
                        showDate
                        allowStart={w.status !== 'partial'}
                        checkedDirty={!!checkedMap[w.id]}
                        onStart={() => setStartId(w.id)}
                        onCheck={() => setCheckId(w.id)}
                        onDefer={() => setDeferId(w.id)}
                        onDelete={() => setDeleteId(w.id)}
                      />
                    )
                  )}
                </MobileSection>
              )}
              <MobileSection label="Сейчас в работе">
                {inProgress.length === 0 ? (
                  <Empty title="Сейчас ничего не стирается" hint="Возьмите стирку из очереди ниже." />
                ) : (
                  inProgress.map((w) => (
                    <ActiveWashCard
                      key={w.id}
                      w={w}
                      onComplete={() => setCompleteId(w.id)}
                      onDefer={() => setDeferId(w.id)}
                      onDelete={() => setDeleteId(w.id)}
                    />
                  ))
                )}
              </MobileSection>
              <MobileSection label="Дальше по очереди">
                {queue.length === 0 ? (
                  <Empty title="Очередь пуста" hint="Все стирки на сегодня разобраны." />
                ) : (
                  queue.map((w) => (
                    <QueuedWashCard
                      key={w.id}
                      w={w}
                      checkedDirty={!!checkedMap[w.id]}
                      onStart={() => setStartId(w.id)}
                      onCheck={() => setCheckId(w.id)}
                      onDefer={() => setDeferId(w.id)}
                      onDelete={() => setDeleteId(w.id)}
                    />
                  ))
                )}
              </MobileSection>
              <MobileSection label="Готово">
                {doneList.length === 0 ? (
                  <Empty title="Пока ничего не готово" hint="Завершённые стирки появятся здесь." />
                ) : (
                  doneList.map((w) => {
                    const meta: string[] = [];
                    if (num(w.items_total) > 0) meta.push(itemsFmt(num(w.items_total)));
                    if (num(w.dirty_weight_kg) > 0) meta.push(kg(w.dirty_weight_kg));
                    if (num(w.bags) > 0) meta.push(bagsFmt(num(w.bags)));
                    return (
                      <Card
                        key={w.id}
                        className={`${styles.washCard} ${w.status === 'no_linen' ? styles.washCardNoLinen : ''}`}
                      >
                        <div className={styles.washHead}>
                          <span className={styles.washName}>{w.client_name}</span>
                          <StatusBadge status={w.status} />
                        </div>
                        {meta.length > 0 && <div className={styles.washMeta}>{meta.join(' · ')}</div>}
                        <Button variant="ghost" className={styles.bigBtn} onClick={() => setEditId(w.id)}>
                          Исправить данные
                        </Button>
                      </Card>
                    );
                  })
                )}
              </MobileSection>
              {shiftClosed ? (
                <div className={styles.washMeta}>Смена закрыта в {day.data.shift!.closed_at}</div>
              ) : (
                <Button
                  variant="danger"
                  className={styles.bigBtn}
                  onClick={() => setCloseOpen(true)}
                >
                  Закрыть смену
                </Button>
              )}
            </>
          )}
        </>
      )}

      {tab === 'hours' && (
        <>
          {hoursQ.isPending && <SkeletonCards count={3} />}
          {hoursQ.isError && !hoursQ.data && (
            <Empty
              icon={<Clock size={40} />}
              title="Не удалось загрузить часы"
              hint={hoursQ.error?.message || 'Проверьте связь.'}
              action={<Button onClick={() => hoursQ.refetch()}>Повторить</Button>}
            />
          )}
          {hoursQ.data && (
            <>
              <MobileSection label="Сегодня">
                <Card className={styles.washCard}>
                  {todayEntry ? (
                    <div className={styles.washHead}>
                      <span className={styles.washName}>{todayEntry.hours} ч.</span>
                    </div>
                  ) : (
                    <div className={styles.washMeta}>Часы за сегодня не отмечены</div>
                  )}
                  <Button
                    className={styles.bigBtn}
                    onClick={() => setHoursEdit({ date: todayStr(), entry: todayEntry })}
                  >
                    {todayEntry ? 'Изменить' : 'Отметить часы'}
                  </Button>
                </Card>
              </MobileSection>
              <Button
                variant="ghost"
                className={styles.bigBtn}
                icon={<Plus size={16} />}
                onClick={() => setHoursEdit({ date: todayStr() })}
              >
                Отметить за другой день
              </Button>
              <MobileSection label="Последние отметки">
                {hoursEntries.length === 0 ? (
                  <Empty title="Отметок пока нет" hint="Отметьте часы за сегодня или другой день." />
                ) : (
                  hoursEntries.map((e) => (
                    <Card
                      key={e.id}
                      interactive
                      className={styles.washCard}
                      onClick={() => setHoursEdit({ date: e.date, entry: e })}
                    >
                      <div className={styles.washHead}>
                        <span className={styles.washName}>{formatDateRu(e.date)}</span>
                        <span className={styles.washMeta}>{e.hours} ч.</span>
                      </div>
                    </Card>
                  ))
                )}
              </MobileSection>
            </>
          )}
        </>
      )}

      {tab === 'profile' && (
        <MobileSection label="Профиль">
          <Card className={styles.washCard}>
            <div className={styles.profileName}>{session.name}</div>
            <div className={styles.washMeta}>Роль: {roleLabel(session.role)}</div>
            <div className={styles.washMeta}>
              Прачка: {day.data?.laundryName || '—'}
            </div>
            <Button variant="ghost" className={styles.bigBtn} onClick={logout}>
              Выход
            </Button>
          </Card>
        </MobileSection>
      )}

      {/* --- Модалки --- */}
      {completeWash && day.data && (
        <CompleteWashModal
          w={completeWash}
          itemTypes={day.data.itemTypes || []}
          onClose={() => setCompleteId(null)}
        />
      )}
      {startWash && <StartWashModal w={startWash} onClose={() => setStartId(null)} />}
      {checkWash && (
        <StorageCheckModal
          w={checkWash}
          checkedDirty={!!checkedMap[checkWash.id]}
          onHasDirty={() => setCheckedMap((m) => ({ ...m, [checkWash.id]: true }))}
          onClose={() => setCheckId(null)}
        />
      )}
      {addOpen && day.data && (
        <AddWashModal clients={day.data.clients || []} onClose={() => setAddOpen(false)} />
      )}
      {deferWash && (
        <DeferWashModal w={deferWash} onDone={() => {}} onClose={() => setDeferId(null)} />
      )}
      {deleteWash && (
        <ConfirmDialog
          open
          danger
          busy={deleteMut.isPending}
          text={`Удалить стирку «${deleteWash.client_name}»? Действие необратимо, владелец получит уведомление.`}
          okLabel="Удалить"
          onClose={() => setDeleteId(null)}
          onConfirm={() => deleteMut.mutate(deleteWash.id)}
        />
      )}
      {editWash && day.data && (
        <EditDoneWashModal
          w={editWash}
          itemTypes={day.data.itemTypes || []}
          onClose={() => setEditId(null)}
        />
      )}
      {/* У работника нет страницы стирки — onOpenWash не передаём, кнопки «Открыть» нет */}
      <ShiftCloseDialog open={closeOpen} onClose={() => setCloseOpen(false)} />
      {hoursEdit && (
        <WorkHoursModal
          userName={session.name}
          date={hoursEdit.date}
          entry={hoursEdit.entry}
          onClose={() => setHoursEdit(null)}
        />
      )}
    </MobileLayout>
  );
}
