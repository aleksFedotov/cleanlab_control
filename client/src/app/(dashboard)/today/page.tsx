'use client';

// Главная «Сегодня» — дашборд владельца: критически важное на текущий день.
// Всегда сегодня, без DateNav. Операционный развоз переехал в /delivery.
import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { useDayList, useDeliveryVisits, useStorage } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { todayStr } from '@/lib/dates';
import { num } from '@/lib/format';
import { StatRow } from '@/components/ui/StatRow';
import { StatCard } from '@/components/ui/StatCard';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Empty } from '@/components/ui/Empty';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { NOT_READY_REASONS, visitState } from '../delivery/visit-state';
import { buildEntries } from '../storage/storage-entry';
import styles from './today.module.css';

export default function TodayDashboard() {
  const router = useRouter();
  const toast = useUiStore((s) => s.toast);
  const today = todayStr();

  const day = useDayList(today);
  const delivery = useDeliveryVisits(today);
  const storage = useStorage();

  useEffect(() => {
    if (day.isError) toast(day.error.message || 'Ошибка загрузки стирок', 'err');
  }, [day.isError, day.error, toast]);
  useEffect(() => {
    if (delivery.isError) toast(delivery.error.message || 'Ошибка загрузки развоза', 'err');
  }, [delivery.isError, delivery.error, toast]);
  useEffect(() => {
    if (storage.isError) toast(storage.error.message || 'Ошибка загрузки склада', 'err');
  }, [storage.isError, storage.error, toast]);

  // Стирки дня
  const washes = day.data?.washes || [];
  const inProgress = washes.filter((w) => w.status === 'in_progress');
  const queue = washes.filter((w) => w.status === 'planned' || w.status === 'no_linen');
  const doneList = washes.filter(
    (w) =>
      w.status === 'done' || w.status === 'stored' || w.status === 'partial' || w.status === 'ready_clean'
  );
  const doneKg = Math.round(doneList.reduce((s, w) => s + num(w.dirty_weight_kg), 0) * 10) / 10;
  const shift = day.data?.shift || null;

  // Развоз сегодня
  const visits = delivery.data?.visits || [];
  const doneDel = visits.filter((v) => v.status === 'delivered' || v.status === 'both').length;
  const donePick = visits.filter((v) => v.status === 'picked' || v.status === 'both').length;
  const notReady = delivery.data?.notReady || [];
  const reasonByClient = useMemo(() => {
    const m = new Map<string, string>();
    (delivery.data?.notReady || []).forEach((n) => m.set(n.client_id, n.reason));
    return m;
  }, [delivery.data]);

  // Склад: позиции, требующие внимания (просрочка выдачи, частичные без решения)
  const attnStorage = useMemo(
    () => (storage.data ? buildEntries(storage.data, today).filter((e) => e.attn) : []),
    [storage.data, today]
  );

  const hasAlerts = notReady.length > 0 || attnStorage.length > 0;

  if (day.isLoading || delivery.isLoading || storage.isLoading) {
    return (
      <div className={styles.stack}>
        <div className={styles.skelStats}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={76} radius={14} />
          ))}
        </div>
        <Skeleton height={120} radius={14} />
        <Skeleton height={200} radius={14} />
      </div>
    );
  }

  if (day.isError && delivery.isError && storage.isError) {
    return (
      <Empty
        icon={<AlertTriangle size={28} />}
        title="Не удалось загрузить дашборд"
        hint="Проверьте связь."
        action={
          <Button
            variant="primary"
            onClick={() => {
              day.refetch();
              delivery.refetch();
              storage.refetch();
            }}
          >
            Повторить
          </Button>
        }
      />
    );
  }

  return (
    <div className={styles.stack}>
      <StatRow>
        <StatCard
          label="Смена"
          value={shift?.status === 'closed' ? 'закрыта' : 'открыта'}
          tone={shift?.status === 'closed' ? 'ok' : 'default'}
          sub={shift?.status === 'closed' && shift.closed_at ? `в ${shift.closed_at}` : undefined}
        />
        <StatCard label="В работе" value={inProgress.length} />
        <StatCard label="В очереди" value={queue.length} tone={queue.length > 0 ? 'warn' : 'default'} />
        <StatCard label="Готово" value={doneList.length} unit={doneKg > 0 ? `· ${doneKg} кг` : undefined} tone="ok" />
        <StatCard
          label="Визиты сегодня"
          value={visits.length}
          sub={`${doneDel} выдано · ${donePick} забрано`}
        />
      </StatRow>

      {hasAlerts && (
        <div className={styles.alerts}>
          <div className={styles.alertsTitle}>
            <AlertTriangle size={16} /> Требуют внимания
          </div>
          {notReady.map((n) => (
            <div key={n.visit_id} className={styles.aRow}>
              <span className={styles.aName}>
                {n.client_name}{' '}
                <span className={styles.aWhy}>— {NOT_READY_REASONS[n.reason] || n.reason}</span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => router.push('/delivery')}>
                Развоз
              </Button>
            </div>
          ))}
          {attnStorage.map((e) => (
            <div key={`${e.kind}-${e.id}`} className={styles.aRow}>
              <span className={styles.aName}>
                {e.client_name} <span className={styles.aWhy}>— {e.statusText}</span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => router.push('/storage')}>
                Склад
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className={styles.cols}>
        <Card className={styles.listCard}>
          <div className={styles.listTitle}>Стирки дня</div>
          {inProgress.length === 0 && queue.length === 0 && doneList.length === 0 ? (
            <div className={styles.emptyLine}>Стирок нет</div>
          ) : (
            <>
              {[...inProgress, ...queue, ...doneList].map((w, i) => (
                <button key={w.id} className={styles.row} onClick={() => router.push('/wash')}>
                  <span className={styles.rowName}>
                    {i + 1}. {w.client_name}
                  </span>
                  <StatusBadge status={w.status} size="sm" />
                </button>
              ))}
            </>
          )}
        </Card>

        <Card className={styles.listCard}>
          <div className={styles.listTitle}>Развоз сегодня</div>
          {visits.length === 0 ? (
            <div className={styles.emptyLine}>Визитов нет</div>
          ) : (
            visits.map((v, i) => {
              const st = visitState(v, reasonByClient.get(v.client_id), today);
              return (
                <button key={v.id} className={styles.row} onClick={() => router.push('/delivery')}>
                  <span className={styles.rowName}>
                    {i + 1}. {v.client_name}
                  </span>
                  {st.badgeKey ? (
                    <StatusBadge status={st.badgeKey} size="sm" />
                  ) : (
                    <span className={styles.noteChip}>{st.noteText}</span>
                  )}
                </button>
              );
            })
          )}
        </Card>
      </div>
    </div>
  );
}
