'use client';

// Прайс клиента (P2.1: сортировка, фильтр; P2.3: вынесено из client-form.tsx,
// бейдж «наследовано» удалён — наследованные строки тихие, SavedMark убран,
// статус сохранения уходит наверх через onSaving/onSaved).
import { useMemo, useState } from 'react';
import { useApiMutation, useBillingItems, useTariffs } from '@/hooks/use-api';
import { plural } from '@/lib/format';
import type { BillingItem, Client } from '@/types/api';
import styles from './refs.module.css';

export interface SaveStatusCallbacks {
  onSaving?: () => void;
  onSaved?: () => void;
}

type PriceMark = 'override' | 'inherit' | 'missing';

function priceMark(defaultPrice: string, overridePrice: string | undefined): PriceMark {
  if (overridePrice !== undefined && overridePrice !== '') return 'override';
  return defaultPrice ? 'inherit' : 'missing';
}

// Бейджи только об отклонениях: «переопределено» и «не задана»; наследование — дефолт, без бейджа
const MARK_BADGE: Partial<Record<PriceMark, [string, string]>> = {
  override: [styles.badgeOverride, 'переопределено'],
  missing: [styles.badgeMissing, 'не задана'],
};

// Переопределение цены клиента: инпут; пусто = наследовать дефолт прачки
function ClientPriceRow({
  item,
  clientId,
  defaultPrice,
  overridePrice,
  onSaving,
  onSaved,
}: {
  item: BillingItem;
  clientId: string;
  defaultPrice: string;
  overridePrice: string | undefined; // undefined — переопределения нет
} & SaveStatusCallbacks) {
  const [value, setValue] = useState(overridePrice ?? '');
  const save = useApiMutation('saveTariff', { invalidate: ['tariffs'] });
  const badge = MARK_BADGE[priceMark(defaultPrice, overridePrice)];
  return (
    <div className={styles.tariffRow}>
      <span className={styles.tariffName}>{item.name}</span>
      <span className={styles.tariffDef}>{defaultPrice || '—'}</span>
      <input
        className={styles.priceInput}
        type="text"
        inputMode="decimal"
        placeholder={defaultPrice || '—'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const v = value.trim().replace(',', '.');
          if (v === (overridePrice ?? '')) return;
          onSaving?.();
          save.mutate([clientId, item.id, v], { onSuccess: () => onSaved?.() });
        }}
        aria-label={`Цена клиента: ${item.name}`}
      />
      {badge ? <span className={`${styles.badge} ${badge[0]}`}>{badge[1]}</span> : <span />}
    </div>
  );
}

// Эффективный прайс: переопределённые и без цены — сразу, остальные под спойлером
export function ClientPricesSection({
  client,
  onSaving,
  onSaved,
}: { client: Client } & SaveStatusCallbacks) {
  const billing = useBillingItems();
  const tariffsQ = useTariffs();
  const [showAll, setShowAll] = useState(false);
  const activeBillingItems = useMemo(
    () => (billing.data?.items || []).filter((b) => b.active === 'да'),
    [billing.data]
  );
  // Тарифы: дефолты (client_id='') и переопределения этого клиента
  const tariffMaps = useMemo(() => {
    const def: Record<string, string> = {};
    const own: Record<string, string> = {};
    (tariffsQ.data?.tariffs || []).forEach((t) => {
      if (!t.client_id) def[t.billing_item_id] = t.price;
      else if (t.client_id === client.id) own[t.billing_item_id] = t.price;
    });
    return { def, own };
  }, [tariffsQ.data, client.id]);

  // Сортировка: переопределённые → с дефолтом → без цены
  const rows = useMemo(() => {
    const rank = (b: BillingItem) => {
      const m = priceMark(tariffMaps.def[b.id] || '', tariffMaps.own[b.id]);
      return m === 'override' ? 0 : m === 'inherit' ? 1 : 2;
    };
    return [...activeBillingItems].sort((a, b) => rank(a) - rank(b));
  }, [activeBillingItems, tariffMaps]);

  // Видны сразу: переопределённые и без цены; «с дефолтом» — под спойлером
  const important = rows.filter(
    (b) => priceMark(tariffMaps.def[b.id] || '', tariffMaps.own[b.id]) !== 'inherit'
  );
  const visible = showAll ? rows : important;

  return (
    <>
      <div className={styles.tariffHead}>
        <span>Позиция</span>
        <span>Дефолт</span>
        <span>Цена клиента</span>
        <span />
      </div>
      {visible.map((b) => (
        <ClientPriceRow
          key={b.id}
          item={b}
          clientId={client.id}
          defaultPrice={tariffMaps.def[b.id] || ''}
          overridePrice={tariffMaps.own[b.id]}
          onSaving={onSaving}
          onSaved={onSaved}
        />
      ))}
      {!rows.length && <div className={styles.hint}>Нет активных позиций прайса</div>}
      {rows.length > important.length && (
        <button type="button" className={styles.moreBtn} onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Скрыть' : `Показать все позиции (${rows.length})`}
        </button>
      )}
      <div className={styles.hint}>Пустая цена клиента — наследуется дефолт прачки.</div>
    </>
  );
}

// Сводка для подписи вкладки «Цены»: «2 переопределены · 1 без цены»
export function pricesSummary(
  items: BillingItem[],
  def: Record<string, string>,
  own: Record<string, string>
): string {
  let overrides = 0;
  let missing = 0;
  items.forEach((b) => {
    const m = priceMark(def[b.id] || '', own[b.id]);
    if (m === 'override') overrides++;
    else if (m === 'missing') missing++;
  });
  const parts: string[] = [];
  if (overrides) parts.push(`${overrides} ${plural(overrides, 'переопределена', 'переопределены', 'переопределены')}`);
  if (missing) parts.push(`${missing} без цены`);
  return parts.length ? parts.join(' · ') : 'все по дефолту';
}
