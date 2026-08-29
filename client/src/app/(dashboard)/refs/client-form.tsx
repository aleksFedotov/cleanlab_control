'use client';

// Форма клиента (создание/редактирование) — перенос renderClientDetail
// (legacy index.html:2375-2451) в Modal. Поля 1:1: name, type,
// address, contact, comment, item_types (массив id), accounting +
// опциональные реквизиты: inn, kpp, legal_address.
// У существующего клиента — секции P2: эффективный прайс, привязка видов
// белья к позициям счёта и формирование счёта за период.
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import {
  useApiMutation, useBillingItems, useTariffs, useClientItemBilling,
} from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import { todayStr } from '@/lib/dates';
import type { BillingItem, Client, ItemType } from '@/types/api';
import { parseItemTypes } from './refs-utils';
import styles from './refs.module.css';

const CLIENT_TYPES = ['отель', 'ресторан', 'спа', 'прочее'] as const;
const ACCOUNTING = [
  ['both', 'Вес + количество'],
  ['weight', 'Только вес'],
  ['count', 'Только количество'],
] as const;

const schema = z.object({
  name: z.string().trim().min(1, 'Укажите название'),
  type: z.string(),
  address: z.string(),
  contact: z.string(),
  comment: z.string(),
  item_types: z.array(z.string()),
  accounting: z.enum(['both', 'weight', 'count']),
  // Реквизиты — опционально; если заполнены, проверяем формат
  inn: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d{10}$|^\d{12}$/.test(v), 'ИНН — 10 или 12 цифр'),
  kpp: z.string().trim().refine((v) => v === '' || /^\d{9}$/.test(v), 'КПП — 9 цифр'),
  legal_address: z.string(),
});
type FormValues = z.infer<typeof schema>;

// --- P2: секции существующего клиента ---

// Переопределение цены клиента: инпут; пусто = наследовать дефолт прачки
function ClientPriceRow({
  item,
  clientId,
  defaultPrice,
  overridePrice,
}: {
  item: BillingItem;
  clientId: string;
  defaultPrice: string;
  overridePrice: string | undefined; // undefined — переопределения нет
}) {
  const [value, setValue] = useState(overridePrice ?? '');
  const save = useApiMutation('saveTariff', {
    invalidate: ['tariffs'],
    onSuccess: () => useUiStore.getState().toast('Цена сохранена'),
  });
  const mark =
    overridePrice !== undefined && overridePrice !== ''
      ? 'переопределено'
      : defaultPrice
        ? 'наследовано'
        : 'не задана';
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
          save.mutate([clientId, item.id, v]);
        }}
        aria-label={`Цена клиента: ${item.name}`}
      />
      <span className={styles.sub}>{mark}</span>
    </div>
  );
}

// Привязка видов белья клиента к позициям счёта
function ClientBindingsSection({
  client,
  types,
  pieceItems,
}: {
  client: Client;
  types: ItemType[];
  pieceItems: BillingItem[];
}) {
  const bindingsQ = useClientItemBilling(client.id);
  const save = useApiMutation('saveClientItemBilling', {
    invalidate: ['clientItemBilling', ...OPERATIONAL_PREFIXES],
    onSuccess: () => useUiStore.getState().toast('Сохранено'),
  });
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

  if (!rows.length) return <div className={styles.hint}>Нет активных видов белья</div>;
  return (
    <>
      {rows.map((t) => {
        const bound = Object.prototype.hasOwnProperty.call(bindings, t.id);
        const sel = bound ? (bindings[t.id] === '' ? '__weight__' : bindings[t.id]) : '__default__';
        // Эффективное значение: привязка ?? дефолт типа ?? вес
        const effBid = bound ? bindings[t.id] : t.billing_item_id || '';
        const effName = effBid ? pieceItems.find((b) => b.id === effBid)?.name || effBid : 'в счёт по весу';
        return (
          <div key={t.id} className={styles.tariffRow}>
            <span className={styles.tariffName}>{t.name}</span>
            <select
              aria-label={`Привязка: ${t.name}`}
              value={sel}
              onChange={(e) => {
                const v = e.target.value;
                const bid = v === '__default__' ? null : v === '__weight__' ? '' : v;
                save.mutate([client.id, t.id, bid]);
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
    </>
  );
}

// Счёт за период: открывает печатный вид /invoice в новой вкладке
function InvoiceSection({ clientId }: { clientId: string }) {
  const today = todayStr();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  return (
    <div className={styles.invoiceRow}>
      <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="С" />
      <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="По" />
      <Button
        variant="subtle"
        size="sm"
        disabled={!from || !to}
        onClick={() =>
          window.open(`/invoice?client=${clientId}&from=${from}&to=${to}`, '_blank')
        }
      >
        Сформировать
      </Button>
    </div>
  );
}

// P2-секции существующего клиента: эффективный прайс, привязки видов белья, счёт.
// Отдельный компонент: данные грузятся только когда есть client.id, и react-hook-form
// формы клиента не мешает мемоизации здесь.
function ClientBillingSections({ client, activeTypes }: { client: Client; activeTypes: ItemType[] }) {
  const billing = useBillingItems();
  const tariffsQ = useTariffs();
  const activeBillingItems = useMemo(
    () => (billing.data?.items || []).filter((b) => b.active === 'да'),
    [billing.data]
  );
  const pieceItems = useMemo(
    () => activeBillingItems.filter((b) => b.kind === 'wash_pcs'),
    [activeBillingItems]
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

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Эффективный прайс</div>
        <div className={styles.tariffHead}>
          <span>Позиция</span>
          <span>Дефолт</span>
          <span>Цена клиента</span>
          <span />
        </div>
        {activeBillingItems.map((b) => (
          <ClientPriceRow
            key={b.id}
            item={b}
            clientId={client.id}
            defaultPrice={tariffMaps.def[b.id] || ''}
            overridePrice={tariffMaps.own[b.id]}
          />
        ))}
        {!activeBillingItems.length && (
          <div className={styles.hint}>Нет активных позиций прайса</div>
        )}
        <div className={styles.hint}>Пустая цена клиента — наследуется дефолт прачки.</div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Привязка видов белья</div>
        <ClientBindingsSection client={client} types={activeTypes} pieceItems={pieceItems} />
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Счёт за период</div>
        <InvoiceSection clientId={client.id} />
      </div>
    </>
  );
}

export interface ClientFormProps {
  client: Client | null; // null — новый клиент
  itemTypes: ItemType[];
  onClose: () => void;
  onArchive: (c: Client) => void;
}

export function ClientForm({ client, itemTypes, onClose, onArchive }: ClientFormProps) {
  // В форме — только активные виды белья (legacy renderClientDetail)
  const activeTypes = itemTypes.filter((t) => t.active === 'да');
  const acc =
    client && (client.accounting === 'weight' || client.accounting === 'count')
      ? client.accounting
      : 'both';

  const save = useApiMutation('saveClient', {
    invalidate: ['refs', ...OPERATIONAL_PREFIXES],
    onSuccess: () => {
      useUiStore.getState().toast('Сохранено');
      onClose();
    },
  });

  // P2: прайс и привязки — только для существующего клиента (нужен id)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: client?.name || '',
      type: client?.type || 'отель',
      address: client?.address || '',
      contact: client?.contact || '',
      comment: client?.comment || '',
      item_types: client ? parseItemTypes(client.item_types) : [],
      accounting: acc,
      inn: client?.inn || '',
      kpp: client?.kpp || '',
      legal_address: client?.legal_address || '',
    },
  });

  function onSubmit(v: FormValues) {
    const payload: Record<string, unknown> = { ...v, item_types: v.item_types || [] };
    if (client?.id) payload.id = client.id;
    save.mutate(payload);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={client ? client.name : 'Новый клиент'}
      footer={
        <>
          {client?.id && client.active === 'да' && (
            <Button variant="danger" onClick={() => onArchive(client)} disabled={save.isPending}>
              В архив
            </Button>
          )}
          <Button variant="subtle" onClick={onClose} disabled={save.isPending}>
            Отмена
          </Button>
          <Button type="submit" form="clientForm" busy={save.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <form id="clientForm" onSubmit={handleSubmit(onSubmit)} className={styles.form}>
        <div>
          <input type="text" placeholder="Название *" autoFocus {...register('name')} />
          {errors.name && <div className={styles.err}>{errors.name.message}</div>}
        </div>
        <div >
          <select aria-label="Тип клиента" {...register('type')}>
            {CLIENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <input type="text" placeholder="Адрес" {...register('address')} />
        <input type="text" placeholder="Контакт" {...register('contact')} />
        <input type="text" placeholder="Комментарий" {...register('comment')} />

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Реквизиты (необязательно)</div>
          <div>
            <input
              type="text"
              inputMode="numeric"
              placeholder="ИНН"
              {...register('inn')}
            />
            {errors.inn && <div className={styles.err}>{errors.inn.message}</div>}
          </div>
          <div>
            <input
              type="text"
              inputMode="numeric"
              placeholder="КПП"
              {...register('kpp')}
            />
            {errors.kpp && <div className={styles.err}>{errors.kpp.message}</div>}
          </div>
          <input type="text" placeholder="Юридический адрес" {...register('legal_address')} />
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Виды белья</div>
          <div className={styles.hint}>Ничего не отмечено — работник увидит все виды.</div>
          <div className={styles.checkList}>
            {activeTypes.map((t) => (
              <label key={t.id} className={styles.checkRow}>
                <input type="checkbox" value={t.id} {...register('item_types')} />
                <span>{t.name}</span>
              </label>
            ))}
            {!activeTypes.length && <div className={styles.hint}>Нет активных видов белья</div>}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Учёт результата</div>
          {ACCOUNTING.map(([v, label]) => (
            <label key={v} className={styles.checkRow}>
              <input type="radio" value={v} {...register('accounting')} />
              <span>{label}</span>
            </label>
          ))}
        </div>

        {client?.id && <ClientBillingSections client={client} activeTypes={activeTypes} />}
      </form>
    </Modal>
  );
}
