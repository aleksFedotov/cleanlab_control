'use client';

// Привязка видов белья клиента к позициям счёта (P2.3: вынесено из
// client-form.tsx без изменения логики; SavedMark убран, статус — наверх).
// Видны только виды с явной привязкой; остальные — под спойлером «Настроить по видам (N)».
import { useEffect, useMemo, useState } from 'react';
import { useApiMutation, useClientItemBilling } from '@/hooks/use-api';
import { OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import type { BillingItem, Client, ItemType } from '@/types/api';
import { parseItemTypes } from './refs-utils';
import type { SaveStatusCallbacks } from './client-prices-section';
import styles from './refs.module.css';

export function ClientBindingsSection({
  client,
  types,
  pieceItems,
  onCount,
  onSaving,
  onSaved,
}: {
  client: Client;
  types: ItemType[];
  pieceItems: BillingItem[];
  onCount?: (explicit: number) => void;
} & SaveStatusCallbacks) {
  const bindingsQ = useClientItemBilling(client.id);
  const save = useApiMutation('saveClientItemBilling', {
    invalidate: ['clientItemBilling', ...OPERATIONAL_PREFIXES],
  });
  const [showAll, setShowAll] = useState(false);
  const bindings = useMemo(() => {
    const m: Record<string, string> = {};
    (bindingsQ.data?.bindings || []).forEach((b) => {
      m[b.item_type_id] = b.billing_item_id;
    });
    return m;
  }, [bindingsQ.data]);

  // Виды клиента: свой список, либо все активные (пустой список = все виды)
  const ownIds = parseItemTypes(client.item_types);
  const rows = ownIds.length ? types.filter((t) => ownIds.includes(t.id)) : types;
  const typeById = useMemo(() => {
    const m: Record<string, ItemType> = {};
    types.forEach((t) => (m[t.id] = t));
    return m;
  }, [types]);

  const explicit = rows.filter((t) => Object.prototype.hasOwnProperty.call(bindings, t.id));
  const visible = showAll ? rows : explicit;

  // Сводка вкладки: сообщаем число явных привязок наверх
  useEffect(() => {
    onCount?.(explicit.length);
  }, [explicit.length, onCount]);

  if (!rows.length) return <div className={styles.hint}>Нет активных видов белья</div>;
  return (
    <>
      {visible.map((t) => {
        const bound = Object.prototype.hasOwnProperty.call(bindings, t.id);
        const sel = bound ? (bindings[t.id] === '' ? '__weight__' : bindings[t.id]) : '__default__';
        // Эффективное значение: привязка ?? дефолт типа ?? вес
        const effBid = bound ? bindings[t.id] : t.billing_item_id || '';
        const effName = effBid ? pieceItems.find((b) => b.id === effBid)?.name || effBid : 'в счёт по весу';
        return (
          <div key={t.id} className={styles.bindingRow}>
            <span className={styles.tariffName}>{t.name}</span>
            <select
              aria-label={`Привязка: ${t.name}`}
              value={sel}
              onChange={(e) => {
                const v = e.target.value;
                const bid = v === '__default__' ? null : v === '__weight__' ? '' : v;
                onSaving?.();
                save.mutate([client.id, t.id, bid], { onSuccess: () => onSaved?.() });
              }}
            >
              <option value="__default__">
                Как у типа ({typeById[t.id]?.billing_item_id ? 'штучно' : 'по весу'})
              </option>
              <option value="__weight__">В счёт по весу</option>
              {pieceItems.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <span className={styles.sub}>{effName}</span>
          </div>
        );
      })}
      {!explicit.length && !showAll && (
        <div className={styles.hint}>Явных привязок нет — все виды идут по дефолту типа.</div>
      )}
      {rows.length > explicit.length && (
        <button type="button" className={styles.moreBtn} onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Скрыть' : `Настроить по видам (${rows.length})`}
        </button>
      )}
    </>
  );
}
