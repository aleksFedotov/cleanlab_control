'use client';

// Прайс клиента (P2.1: сортировка, фильтр; P2.3: вынесено из client-form.tsx,
// бейдж «наследовано» удалён — наследованные строки тихие, SavedMark убран,
// статус сохранения уходит наверх через onSaving/onSaved).
import { useMemo, useState } from 'react';
import { useApiMutation, useBillingItems, useTariffs } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { plural } from '@/lib/format';
import type { BillingItem, Client, Tariff } from '@/types/api';
import styles from './refs.module.css';

export interface SaveStatusCallbacks {
  onSaving?: () => void;
  onSaved?: () => void;
}

// Пороговая позиция — единственная trip с max_kg и oneway ≠ да (как isThresholdTrip
// в refs/page.tsx); только у неё есть per-клиентский порог веса.
const isThresholdTrip = (b: BillingItem) =>
  b.kind === 'trip' && !!b.max_kg && b.oneway !== 'да';

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

// Переопределение цены клиента: инпут; пусто = наследовать дефолт прачки.
// У пороговой позиции доставки — второй инпут «порог, кг» (пусто = дефолт позиции).
function ClientPriceRow({
  item,
  clientId,
  defaultPrice,
  override,
  onSaving,
  onSaved,
}: {
  item: BillingItem;
  clientId: string;
  defaultPrice: string;
  override: Tariff | undefined; // undefined — переопределения нет
} & SaveStatusCallbacks) {
  const overridePrice = override?.price;
  const overrideThreshold = override?.max_kg || '';
  const isThreshold = isThresholdTrip(item);
  const [value, setValue] = useState(overridePrice ?? '');
  const [threshold, setThreshold] = useState(overrideThreshold);
  const save = useApiMutation('saveTariff', { invalidate: ['tariffs'] });
  const toast = useUiStore((s) => s.toast);
  const badge = MARK_BADGE[priceMark(defaultPrice, overridePrice)];

  function saveAll(price: string, thresholdKg: string) {
    onSaving?.();
    const args = isThreshold ? [clientId, item.id, price, thresholdKg] : [clientId, item.id, price];
    save.mutate(args, { onSuccess: () => onSaved?.() });
  }

  function blurPrice() {
    const v = value.trim().replace(',', '.');
    if (v === (overridePrice ?? '')) return;
    saveAll(v, threshold.trim());
  }

  function blurThreshold() {
    const v = threshold.trim();
    if (v === overrideThreshold) return;
    if (v !== '') {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        toast('Порог — целое число больше 0', 'err');
        setThreshold(overrideThreshold);
        return;
      }
      if (!window.confirm(
        `Сделать платной доставку менее ${n} кг для этого клиента? Прошлые периоды в счетах и «Финансах» пересчитаются.`
      )) {
        setThreshold(overrideThreshold);
        return;
      }
    } else if (!window.confirm(
      `Вернуть дефолтный порог доставки (${item.max_kg} кг)? Прошлые периоды пересчитаются.`
    )) {
      setThreshold(overrideThreshold);
      return;
    }
    saveAll(value.trim().replace(',', '.'), v);
  }

  const priceInput = (
    <input
      className={styles.priceInput}
      type="text"
      inputMode="decimal"
      placeholder={defaultPrice || '—'}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={blurPrice}
      aria-label={`Цена клиента: ${item.name}`}
    />
  );

  return (
    <div className={styles.tariffRow}>
      <span className={styles.tariffName}>{item.name}</span>
      <span className={styles.tariffDef}>{defaultPrice || '—'}</span>
      {isThreshold ? (
        <span className={styles.tariffInputs}>
          {priceInput}
          <input
            className={`${styles.priceInput} ${styles.thresholdInput}`}
            type="text"
            inputMode="numeric"
            placeholder={item.max_kg}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            onBlur={blurThreshold}
            aria-label="Порог платной доставки клиента, кг"
            title="Порог платной доставки, кг (пусто — дефолт)"
          />
          <span className={styles.hint}>кг</span>
        </span>
      ) : priceInput}
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
    const own: Record<string, Tariff> = {};
    (tariffsQ.data?.tariffs || []).forEach((t) => {
      if (!t.client_id) def[t.billing_item_id] = t.price;
      else if (t.client_id === client.id) own[t.billing_item_id] = t;
    });
    return { def, own };
  }, [tariffsQ.data, client.id]);

  // Сортировка: переопределённые → с дефолтом → без цены
  const rows = useMemo(() => {
    const rank = (b: BillingItem) => {
      const m = priceMark(tariffMaps.def[b.id] || '', tariffMaps.own[b.id]?.price);
      return m === 'override' ? 0 : m === 'inherit' ? 1 : 2;
    };
    return [...activeBillingItems].sort((a, b) => rank(a) - rank(b));
  }, [activeBillingItems, tariffMaps]);

  // Видны сразу: переопределённые и без цены; «с дефолтом» — под спойлером
  const important = rows.filter(
    (b) => priceMark(tariffMaps.def[b.id] || '', tariffMaps.own[b.id]?.price) !== 'inherit'
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
          override={tariffMaps.own[b.id]}
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
      <div className={styles.hint}>У «Доставки менее N кг» второе поле — порог веса клиента; пусто — наследуется дефолт.</div>
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
