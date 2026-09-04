'use client';

// Развоз: контроль готовности, не планировщик. (Переехало из раздела «Сегодня».)
// Порт legacy renderDelivery (server/public/index.html:1534-1712) + openDeliveryAdd.
// Дата — из хедера (DateNav layout'а) через useSectionDate('delivery').
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Plus, Truck, X } from 'lucide-react';
import type { DecoratedVisit } from '@/types/api';
import { useDeliveryVisits, useApiMutation } from '@/hooks/use-api';
import { useSectionDate } from '@/hooks/use-section-date';
import { useUiStore } from '@/stores/ui';
import { formatDateRu, isToday, timeOf } from '@/lib/dates';
import { bags } from '@/lib/format';
import { StatRow } from '@/components/ui/StatRow';
import { StatCard } from '@/components/ui/StatCard';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { FilterPills } from '@/components/ui/FilterPills';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { VisitEditModal } from '@/components/VisitEditModal';
import { Empty } from '@/components/ui/Empty';
import { Skeleton } from '@/components/ui/Skeleton';
import { AddVisitModal } from './AddVisitModal';
import { NOT_READY_REASONS, visitDetails, visitState } from './visit-state';
import styles from './delivery.module.css';

export default function TodayPage() {
  const [date] = useSectionDate('delivery');
  const query = useDeliveryVisits(date);
  const toast = useUiStore((s) => s.toast);

  const [filter, setFilter] = useState('all');
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [poTarget, setPoTarget] = useState<string | null>(null); // visitId для setPickupOnly(true)
  const [unpoId, setUnpoId] = useState<string | null>(null); // busy на «отменить» pickup_only
  // Правка закрытого визита (P6): id, визит достаём из query-данных
  const [editId, setEditId] = useState<string | null>(null);

  // Ошибка API: тост (§7); «Повторить» на месте контента — ниже, когда данных нет
  useEffect(() => {
    if (query.isError) toast(query.error.message || 'Не удалось загрузить развоз', 'err');
  }, [query.isError, query.error, toast]);

  const removeMut = useApiMutation('removeDeliveryVisit', { invalidate: 'operational' });
  const pickupOnlyMut = useApiMutation('setPickupOnly', { invalidate: 'operational' });

  const res = query.data;

  // Адрес и причина неготовности по client_id — как в legacy (addrByClient / notReadyByClient)
  const addrByClient = useMemo(() => {
    const m = new Map<string, string>();
    (res?.clients || []).forEach((c) => m.set(c.id, c.address));
    return m;
  }, [res]);
  const reasonByClient = useMemo(() => {
    const m = new Map<string, string>();
    (res?.notReady || []).forEach((n) => m.set(n.client_id, n.reason));
    return m;
  }, [res]);

  // Сводка дня — счётчики 1:1 из legacy
  const stats = useMemo(() => {
    const visits = res?.visits || [];
    let doneDel = 0;
    let donePick = 0;
    let readyCnt = 0;
    let workKg = 0;
    let workBags = 0;
    visits.forEach((v) => {
      if (v.status === 'delivered' || v.status === 'both') doneDel++;
      if (v.status === 'picked' || v.status === 'both') donePick++;
      if (v.status === 'planned' && v.has_clean) {
        workKg += v.clean_kg;
        workBags += v.clean_stock_bags;
        if (!v.clean_taken_at && !reasonByClient.get(v.client_id)) readyCnt++;
      }
    });
    return { doneDel, donePick, readyCnt, workKg, workBags };
  }, [res, reasonByClient]);

  // Счётчики для FilterPills и отфильтрованный список
  const { counts, filtered } = useMemo(() => {
    const c = { ready: 0, wash: 0, queue: 0, late: 0 };
    const list: DecoratedVisit[] = [];
    (res?.visits || []).forEach((v) => {
      const st = visitState(v, reasonByClient.get(v.client_id), date);
      if (st.category) c[st.category]++;
      if (filter === 'all' || st.category === filter) list.push(v);
    });
    return { counts: c, filtered: list };
  }, [res, reasonByClient, date, filter]);

  function confirmPickupOnly() {
    if (!poTarget) return;
    pickupOnlyMut.mutate([poTarget, true], {
      onSuccess: () => {
        setPoTarget(null);
        toast('Точка подтверждена: только забрать грязное ✓');
      },
    });
  }

  function unsetPickupOnly(v: DecoratedVisit) {
    setUnpoId(v.id);
    pickupOnlyMut.mutate([v.id, false], {
      onSuccess: () => toast('Пометка снята'),
      onSettled: () => setUnpoId(null),
    });
  }

  function confirmRemove() {
    if (!removeTarget) return;
    removeMut.mutate(removeTarget.id, {
      onSuccess: () => {
        setRemoveTarget(null);
        toast('Убрано');
      },
    });
  }

  // --- Состояния (спека §7) ---

  if (query.isLoading) {
    return (
      <div className={styles.stack}>
        <div className={styles.skelStats}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={76} radius={14} />
          ))}
        </div>
        <Skeleton height={34} width={340} radius={999} />
        <div className={styles.grid}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} height={66} radius={14} />
          ))}
        </div>
      </div>
    );
  }

  if (query.isError && !res) {
    return (
      <Empty
        icon={<AlertTriangle size={28} />}
        title="Не удалось загрузить развоз"
        hint={query.error.message}
        action={
          <Button variant="primary" onClick={() => query.refetch()} busy={query.isRefetching}>
            Повторить
          </Button>
        }
      />
    );
  }

  if (!res) return null;

  const visits = res.visits;
  const notReady = res.notReady || [];

  return (
    <div className={styles.stack}>
      <StatRow>
        <StatCard
          label={isToday(date) ? 'Визитов сегодня' : `Визитов · ${formatDateRu(date, false)}`}
          value={visits.length}
          sub={`${stats.doneDel} выдано · ${stats.donePick} забрано`}
        />
        <StatCard label="Готовы к выдаче" value={stats.readyCnt} tone="ok" />
        <StatCard label="Не готовы" value={notReady.length} tone="warn" />
        <StatCard
          label="Вес в работе"
          value={stats.workKg}
          unit="кг"
          sub={bags(stats.workBags)}
        />
      </StatRow>

      <FilterPills
        active={filter}
        onChange={setFilter}
        options={[
          { key: 'all', label: 'Все', count: visits.length },
          { key: 'ready', label: 'Готовы', count: counts.ready },
          { key: 'wash', label: 'В стирке', count: counts.wash },
          { key: 'queue', label: 'Очередь', count: counts.queue },
          { key: 'late', label: 'Просрочены', count: counts.late },
        ]}
      />

      {notReady.length > 0 && (
        <div className={styles.blockers}>
          <div className={styles.blockersTitle}>
            <AlertTriangle size={16} /> Не готовы к развозу:
          </div>
          {notReady.map((n) => (
            <div key={n.visit_id} className={styles.bRow}>
              <span className={styles.bName}>
                {n.client_name} <span className={styles.bWhy}>— {NOT_READY_REASONS[n.reason] || n.reason}</span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => setPoTarget(n.visit_id)}>
                Только забрать грязное
              </Button>
            </div>
          ))}
        </div>
      )}

      {visits.length === 0 ? (
        <Empty
          icon={<Truck size={28} />}
          title="Развоз пуст"
          hint="Добавьте клиентов ниже или на вкладке «План»"
        />
      ) : filtered.length === 0 ? (
        <Empty title="В этой категории пусто" />
      ) : (
        <div className={styles.grid}>
          {filtered.map((v) => {
            const reason = reasonByClient.get(v.client_id);
            const st = visitState(v, reason, date);
            const details = visitDetails(v, addrByClient.get(v.client_id), reason);
            // Тайм-чип: развоз чистого — «забрал со склада» / «доставил»;
            // «только забрать грязное» — «—» / «забрал грязное»
            const pickupOnly = v.pickup_only === 'да';
            const t1 = pickupOnly ? null : timeOf(v.clean_taken_at) || null;
            const t2 = pickupOnly ? timeOf(v.picked_at) || null : timeOf(v.delivered_at) || null;
            const isClosed = v.status !== 'planned'; // P6: закрытый визит кликабелен — модал правки
            return (
              <Card
                key={v.id}
                interactive={isClosed}
                onClick={isClosed ? () => setEditId(v.id) : undefined}
                className={`${styles.visit} ${st.overdue ? styles.visitLate : ''}`}
              >
                <div className={`mono ${styles.timeChip}`}>
                  <span title={pickupOnly ? undefined : 'Забрал чистое со склада'}>{t1 || '—'}</span>
                  <span title={pickupOnly ? 'Забрал грязное' : 'Доставил чистое'}>{t2 || '—'}</span>
                </div>
                <div className={styles.visitMain}>
                  <div className={styles.visitName}>{v.client_name}</div>
                  {details.length > 0 && (
                    <div className={styles.visitDetails}>{details.join(' · ')}</div>
                  )}
                </div>
                <div className={styles.visitSide}>
                  {st.badgeKey ? (
                    <StatusBadge status={st.badgeKey} size="sm" />
                  ) : (
                    <span className={styles.noteChip}>{st.noteText}</span>
                  )}
                  {v.status === 'planned' && v.pickup_only === 'да' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      busy={unpoId === v.id}
                      title="Снять пометку «только забрать грязное»"
                      onClick={() => unsetPickupOnly(v)}
                    >
                      отменить
                    </Button>
                  )}
                  {v.status === 'planned' && (
                    <button
                      className={styles.rmBtn}
                      title="Убрать из развоза"
                      onClick={() => setRemoveTarget({ id: v.id, name: v.client_name })}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Button
        variant="primary"
        className={styles.addBtn}
        icon={<Plus size={16} />}
        onClick={() => setAddOpen(true)}
      >
        {isToday(date)
          ? 'Добавить в сегодняшний развоз'
          : `Добавить в развоз на ${formatDateRu(date)}`}
      </Button>

      <AddVisitModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        date={date}
        clients={res.clients}
        visits={visits}
      />

      {/* Правка закрытого визита (P6): этаж + отмены действий водителя; общий модал с экраном водителя */}
      <VisitEditModal
        visit={visits.find((v) => v.id === editId) || null}
        onClose={() => setEditId(null)}
      />

      <ConfirmDialog
        open={poTarget !== null}
        onClose={() => setPoTarget(null)}
        onConfirm={confirmPickupOnly}
        text="Водитель только заберёт грязное, чистое на эту точку не нужно. Подтвердить?"
        okLabel="Подтвердить"
        busy={pickupOnlyMut.isPending}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={confirmRemove}
        text={removeTarget ? `Убрать «${removeTarget.name}» из развоза?` : ''}
        okLabel="Убрать"
        danger
        busy={removeMut.isPending}
      />
    </div>
  );
}
