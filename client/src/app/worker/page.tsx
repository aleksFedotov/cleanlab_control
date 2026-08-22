'use client';

// Мобильный экран работника (спека §6, логика — legacy renderDay/renderWashCard
// для роли worker, server/public/index.html:465-957). Всегда «сегодня» —
// у работника нет DateNav. Вкладки — локальное состояние, не маршруты.
import { useState } from 'react';
import { ClipboardList, Package, User, Waves } from 'lucide-react';
import { useRequireRole, useLogout } from '@/hooks/use-session';
import { useDayList } from '@/hooks/use-api';
import { MobileLayout, MobileSection } from '@/components/layout/MobileLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Empty } from '@/components/ui/Empty';
import { Skeleton, SkeletonCards } from '@/components/ui/Skeleton';
import { todayStr, timeOf } from '@/lib/dates';
import { num, kg, bags as bagsFmt, items as itemsFmt } from '@/lib/format';
import { roleLabel } from '@/lib/dicts';
import type { DayWash } from '@/types/api';
import { CompleteWashModal } from './CompleteWashModal';
import { StartWashModal } from './StartWashModal';
import { StorageCheckModal } from './StorageCheckModal';
import styles from './worker.module.css';

type Tab = 'tasks' | 'storage' | 'profile';

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? 'доброе утро' : h < 18 ? 'добрый день' : 'добрый вечер';
  return `${name}, ${part}`;
}

// Стирка «в работе»: детали + большая кнопка завершения (спека §6)
function ActiveWashCard({ w, onComplete }: { w: DayWash; onComplete: () => void }) {
  const meta: string[] = [];
  if (num(w.items_total) > 0) meta.push(itemsFmt(num(w.items_total)));
  if (w.dirty_weight_kg !== '' && w.dirty_weight_kg != null) meta.push(kg(w.dirty_weight_kg));
  const started = timeOf(w.started_at);
  return (
    <Card className={styles.washCard}>
      <div className={styles.washHead}>
        <span className={styles.washName}>{w.client_name}</span>
        <StatusBadge status={w.status} />
      </div>
      {meta.length > 0 && <div className={styles.washMeta}>{meta.join(' · ')}</div>}
      {started && <div className={styles.washMeta}>Начата в {started}</div>}
      {w.comment && <div className={styles.washMeta}>{w.comment}</div>}
      <Button className={styles.bigBtn} onClick={onComplete}>
        Завершить стирку
      </Button>
    </Card>
  );
}

// Стирка из очереди: «Начать стирку» (если грязное есть/подтверждено) +
// «Проверить на складе» (legacy renderWashCard шаг 1)
function QueuedWashCard({
  w,
  checkedDirty,
  onStart,
  onCheck,
}: {
  w: DayWash;
  checkedDirty: boolean;
  onStart: () => void;
  onCheck: () => void;
}) {
  const dirtyOk = w.has_dirty || checkedDirty;
  return (
    <Card className={styles.washCard}>
      <div className={styles.washHead}>
        <span className={styles.washName}>{w.client_name}</span>
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
        <div className={styles.washMeta}>
          Частично постирано: готово {(w.prev_items || []).reduce((s, it) => s + it.qty, 0)} поз.,{' '}
          {w.prev_kg} кг, {w.prev_bags} мешк. — остаток грязный
        </div>
      )}
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
    </Card>
  );
}

export default function WorkerPage() {
  const session = useRequireRole(['worker']);
  const logout = useLogout();
  const [tab, setTab] = useState<Tab>('tasks');

  const day = useDayList(todayStr());
  // NB: getStorage на сервере — owner-only (server/api.js:671), работнику он вернёт
  // «Нет доступа» и выкинет из сессии. Склад работника строим из флагов
  // has_dirty/has_clean, которые getDayList раздаёт работнику легально.

  // Модалки и локальные подтверждения грязного (аналог state.checkedDirty)
  const [completeId, setCompleteId] = useState<string | null>(null);
  const [startId, setStartId] = useState<string | null>(null);
  const [checkId, setCheckId] = useState<string | null>(null);
  const [checkedMap, setCheckedMap] = useState<Record<string, boolean>>({});

  if (!session) return null;

  const washes = day.data?.washes || [];
  const inProgress = washes.filter((w) => w.status === 'in_progress');
  const queue = washes.filter((w) => w.status === 'planned' || w.status === 'no_linen');
  const doneCount = washes.filter(
    (w) =>
      w.status === 'done' ||
      w.status === 'stored' ||
      w.status === 'partial' ||
      w.status === 'ready_clean'
  ).length;

  const completeWash = completeId ? washes.find((w) => w.id === completeId) : undefined;
  const startWash = startId ? washes.find((w) => w.id === startId) : undefined;
  const checkWash = checkId ? washes.find((w) => w.id === checkId) : undefined;

  const nav = [
    { key: 'tasks', label: 'Задачи', icon: <ClipboardList size={19} /> },
    { key: 'storage', label: 'Склад', icon: <Package size={19} /> },
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
              <MobileSection label="Сейчас в работе">
                {inProgress.length === 0 ? (
                  <Empty title="Сейчас ничего не стирается" hint="Возьмите стирку из очереди ниже." />
                ) : (
                  inProgress.map((w) => (
                    <ActiveWashCard key={w.id} w={w} onComplete={() => setCompleteId(w.id)} />
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
                    />
                  ))
                )}
              </MobileSection>
            </>
          )}
        </>
      )}

      {tab === 'storage' && (
        <>
          {day.isPending && <SkeletonCards count={4} />}
          {day.isError && !day.data && (
            <Empty
              icon={<Package size={40} />}
              title="Не удалось загрузить склад"
              hint={day.error?.message || 'Проверьте связь.'}
              action={<Button onClick={() => day.refetch()}>Повторить</Button>}
            />
          )}
          {day.data && (
            <>
              <MobileSection label="Грязное на складе">
                {washes.filter((w) => w.has_dirty).length === 0 ? (
                  <Empty title="Грязного белья нет" />
                ) : (
                  washes
                    .filter((w) => w.has_dirty)
                    .map((w) => (
                      <Card key={w.id} className={styles.washCard}>
                        <div className={styles.washHead}>
                          <span className={styles.washName}>{w.client_name}</span>
                          <StatusBadge status="planned" size="sm" />
                        </div>
                        <div className={styles.washMeta}>
                          {[w.dirty_weight_kg !== '' ? kg(w.dirty_weight_kg) : '', num(w.bags) > 0 ? bagsFmt(num(w.bags)) : '']
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </Card>
                    ))
                )}
              </MobileSection>
              <MobileSection label="Чистое на складе">
                {washes.filter((w) => w.has_clean).length === 0 ? (
                  <Empty title="Чистого белья нет" />
                ) : (
                  washes
                    .filter((w) => w.has_clean)
                    .map((w) => (
                      <Card key={w.id} className={styles.washCard}>
                        <div className={styles.washHead}>
                          <span className={styles.washName}>{w.client_name}</span>
                          <StatusBadge status="ready_clean" size="sm" />
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
    </MobileLayout>
  );
}
