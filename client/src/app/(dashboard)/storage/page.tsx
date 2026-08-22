'use client';

// Страница «Склад» — порт renderStorage из server/public/index.html:1838-1977.
// Сводка (StatRow) + поиск по клиенту + FilterPills (Все/К стирке/Готово/Требует решения)
// + список карточек белья; тап по карточке — модалка с действиями (storage-card-modal).
import { useEffect, useMemo, useState } from 'react';
import { Package, Search } from 'lucide-react';
import { useStorage } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { StatRow } from '@/components/ui/StatRow';
import { StatCard } from '@/components/ui/StatCard';
import { FilterPills } from '@/components/ui/FilterPills';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Empty } from '@/components/ui/Empty';
import { Button } from '@/components/ui/Button';
import { Skeleton, SkeletonCards } from '@/components/ui/Skeleton';
import { todayStr } from '@/lib/dates';
import type { StorageEntry } from './storage-entry';
import { buildEntries, metaOf } from './storage-entry';
import { StorageCardModal } from './storage-card-modal';
import styles from './storage.module.css';

const FILTERS = [
  { key: 'all', label: 'Все' },
  { key: 'dirty', label: 'К стирке' },
  { key: 'partial', label: 'Частичные' },
  { key: 'clean', label: 'Готово' },
  { key: 'attn', label: 'Требует решения' },
];

export default function StoragePage() {
  const { data, isLoading, isError, error, refetch } = useStorage();
  const toast = useUiStore((s) => s.toast);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<StorageEntry | null>(null);

  const today = todayStr();

  const entries = useMemo(() => (data ? buildEntries(data, today) : []), [data, today]);
  const types = useMemo(() => {
    const m: Record<string, string> = {};
    (data?.itemTypes || []).forEach((t) => {
      m[t.id] = t.name;
    });
    return m;
  }, [data]);

  // Ошибка API — тост (спека §7); блок с «Повторить» — ниже, если данных нет.
  useEffect(() => {
    if (isError) toast(error?.message || 'Ошибка загрузки склада', 'err');
  }, [isError, error, toast]);

  const stats = useMemo(() => {
    let dirtyN = 0;
    let readyN = 0;
    let attnN = 0;
    let totalKg = 0;
    entries.forEach((e) => {
      if (e.kind === 'dirty') dirtyN++;
      if (e.kind === 'clean') {
        if (!e.attn) readyN++;
        totalKg += e.kg || 0;
      }
      if (e.attn) attnN++;
    });
    return { dirtyN, readyN, attnN, totalKg: Math.round(totalKg * 10) / 10 };
  }, [entries]);

  const counts = useMemo(
    () => ({
      all: entries.length,
      dirty: entries.filter((e) => e.kind === 'dirty').length,
      partial: entries.filter((e) => e.kind === 'partial').length,
      clean: entries.filter((e) => e.kind === 'clean').length,
      attn: entries.filter((e) => e.attn).length,
    }),
    [entries]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      const okKind = filter === 'all' || (filter === 'attn' ? e.attn : e.kind === filter);
      const okQ = !q || e.client_name.toLowerCase().includes(q);
      return okKind && okQ;
    });
  }, [entries, filter, query]);

  if (isLoading) {
    return (
      <div className={styles.skel}>
        <SkeletonCards count={4} />
        <Skeleton height={42} radius={8} />
        <Skeleton height={34} width="70%" radius={999} />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={84} radius={14} />
        ))}
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className={styles.errorBox}>
        <div>{error?.message || 'Ошибка загрузки склада'}</div>
        <Button variant="ghost" onClick={() => refetch()}>
          Повторить
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      <StatRow>
        <StatCard label="К стирке" value={stats.dirtyN} />
        <StatCard label="Готовы к развозу" value={stats.readyN} tone="ok" />
        <StatCard
          label="Требуют решения"
          value={stats.attnN}
          tone={stats.attnN > 0 ? 'warn' : 'default'}
        />
        <StatCard label="Чистого белья" value={stats.totalKg} unit="кг" />
      </StatRow>

      <div className={styles.searchWrap}>
        <span className={styles.searchIcon}>
          <Search size={16} aria-hidden />
        </span>
        <input
          type="search"
          placeholder="Поиск по клиенту…"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
        />
      </div>

      <FilterPills
        options={FILTERS.map((f) => ({
          key: f.key,
          label: f.label,
          count: counts[f.key as keyof typeof counts],
        }))}
        active={filter}
        onChange={setFilter}
      />

      {entries.length === 0 ? (
        <Empty
          icon={<Package size={40} aria-hidden />}
          title="Склад пуст"
          hint="Здесь появится бельё после приёмки и стирки"
        />
      ) : filtered.length === 0 ? (
        <Empty
          icon={<Search size={40} aria-hidden />}
          title="Ничего не найдено"
          hint="Попробуйте другой фильтр или поисковый запрос"
        />
      ) : (
        <div className={styles.list}>
          {filtered.map((e) => (
            <Card
              key={`${e.kind}-${e.id}`}
              interactive
              className={`${styles.card} ${e.attn ? styles.cardAttn : ''}`}
              onClick={() => setSelected(e)}
            >
              <div className={styles.cardTop}>
                <span className={styles.name}>{e.client_name}</span>
                <StatusBadge status={e.statusKey} size="sm" />
              </div>
              <div className={styles.meta}>{metaOf(e)}</div>
              <div
                className={`${styles.status} ${
                  e.overdueDays > 0
                    ? styles.statusLate
                    : e.kind === 'partial'
                      ? styles.statusWarn
                      : ''
                }`}
              >
                {e.statusText}
              </div>
            </Card>
          ))}
        </div>
      )}

      {selected && (
        <StorageCardModal
          key={`${selected.kind}-${selected.id}`}
          entry={selected}
          types={types}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
