'use client';

// Форма клиента (создание/редактирование) — перенос renderClientDetail
// (legacy index.html:2375-2451) в Modal. Поля 1:1: name, type,
// address, contact, comment, item_types (массив id), accounting +
// опциональные реквизиты: inn, kpp, legal_address.
// P2.1: новый клиент — обычная форма с «Создать»; существующий — мгновенное
// сохранение (текст по onBlur, селекты/чекбоксы/радио по onChange), секции
// «Реквизиты»/«Цены»/«Привязка видов белья» свёрнуты в Accordion со сводками,
// футер «В архив» + «Закрыть» (закрытие ничего не откатывает).
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Accordion } from '@/components/ui/Accordion';
import { FilterPills } from '@/components/ui/FilterPills';
import {
  useApiMutation, useBillingItems, useTariffs, useClientItemBilling,
} from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import { todayStr } from '@/lib/dates';
import { plural } from '@/lib/format';
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

// Микроиндикатор «✓ Сохранено»: появляется при смене метки `at`,
// сам гаснет через CSS-анимацию (~2.5 c)
function SavedMark({ at }: { at: number | null }) {
  if (!at) return null;
  return (
    <span key={at} className={styles.savedMark}>
      ✓ Сохранено
    </span>
  );
}

// --- Прайс клиента (P2.1: сортировка, фильтр, бейджи) ---

type PriceMark = 'override' | 'inherit' | 'missing';

function priceMark(defaultPrice: string, overridePrice: string | undefined): PriceMark {
  if (overridePrice !== undefined && overridePrice !== '') return 'override';
  return defaultPrice ? 'inherit' : 'missing';
}

const MARK_BADGE: Record<PriceMark, [string, string]> = {
  override: [styles.badgeOverride, 'переопределено'],
  inherit: [styles.badgeInherit, 'наследовано'],
  missing: [styles.badgeMissing, 'не задана'],
};

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
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const save = useApiMutation('saveTariff', { invalidate: ['tariffs'] });
  const mark = priceMark(defaultPrice, overridePrice);
  const [badgeCls, badgeText] = MARK_BADGE[mark];
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
          save.mutate([clientId, item.id, v], { onSuccess: () => setSavedAt(Date.now()) });
        }}
        aria-label={`Цена клиента: ${item.name}`}
      />
      <span className={`${styles.badge} ${badgeCls}`}>{badgeText}</span>
      <SavedMark at={savedAt} />
    </div>
  );
}

// Эффективный прайс: переопределённые и без цены — сразу, остальные под спойлером
function ClientPricesSection({ client }: { client: Client }) {
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

// Сводка для заголовка аккордеона «Цены»: «2 переопределены · 1 без цены»
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

// Привязка видов белья клиента к позициям счёта.
// Видны только виды с явной привязкой; остальные — под спойлером «Настроить по видам (N)».
function ClientBindingsSection({
  client,
  types,
  pieceItems,
  onCount,
}: {
  client: Client;
  types: ItemType[];
  pieceItems: BillingItem[];
  onCount?: (explicit: number) => void;
}) {
  const bindingsQ = useClientItemBilling(client.id);
  const save = useApiMutation('saveClientItemBilling', {
    invalidate: ['clientItemBilling', ...OPERATIONAL_PREFIXES],
  });
  const [showAll, setShowAll] = useState(false);
  const [savedMark, setSavedMark] = useState<{ id: string; at: number } | null>(null);
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

  // Сводка аккордеона: сообщаем число явных привязок наверх
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
          <div key={t.id} className={styles.tariffRow}>
            <span className={styles.tariffName}>{t.name}</span>
            <select
              aria-label={`Привязка: ${t.name}`}
              value={sel}
              onChange={(e) => {
                const v = e.target.value;
                const bid = v === '__default__' ? null : v === '__weight__' ? '' : v;
                save.mutate([client.id, t.id, bid], {
                  onSuccess: () => setSavedMark({ id: t.id, at: Date.now() }),
                });
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
            <SavedMark at={savedMark?.id === t.id ? savedMark.at : null} />
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

// Счёт за период: пилюли месяца + произвольный период; открывает /invoice в новой вкладке
function InvoiceSection({ clientId }: { clientId: string }) {
  const today = todayStr();
  const [mode, setMode] = useState('month');
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);

  function range(): [string, string] {
    if (mode === 'month') return [`${today.slice(0, 8)}01`, today];
    if (mode === 'prev') {
      // Прошлый календарный месяц: 1-е — последний день
      const first = new Date(`${today.slice(0, 8)}01T00:00:00`);
      first.setMonth(first.getMonth() - 1);
      const last = new Date(first);
      last.setMonth(last.getMonth() + 1);
      last.setDate(0);
      const iso = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return [iso(first), iso(last)];
    }
    return [from, to];
  }

  const [f, t] = range();
  return (
    <div className={styles.invoiceRow}>
      <FilterPills
        options={[
          { key: 'month', label: 'Этот месяц' },
          { key: 'prev', label: 'Прошлый' },
          { key: 'custom', label: 'Период' },
        ]}
        active={mode}
        onChange={setMode}
      />
      {mode === 'custom' && (
        <>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="С" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="По" />
        </>
      )}
      <Button
        variant="subtle"
        size="sm"
        disabled={!f || !t}
        onClick={() => window.open(`/invoice?client=${clientId}&from=${f}&to=${t}`, '_blank')}
      >
        Сформировать
      </Button>
    </div>
  );
}

// --- Создание клиента: обычная форма с zod-валидацией и кнопкой «Создать» ---

function ClientCreateForm({
  itemTypes,
  onClose,
}: {
  itemTypes: ItemType[];
  onClose: () => void;
}) {
  const save = useApiMutation('saveClient', {
    invalidate: ['refs', ...OPERATIONAL_PREFIXES],
    onSuccess: () => {
      useUiStore.getState().toast('Сохранено');
      onClose();
    },
  });

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      type: 'отель',
      address: '',
      contact: '',
      comment: '',
      item_types: [],
      accounting: 'both',
      inn: '',
      kpp: '',
      legal_address: '',
    },
  });

  const requisitesFilled = !!(watch('inn') || watch('kpp') || watch('legal_address'));

  function onSubmit(v: FormValues) {
    save.mutate({ ...v, item_types: v.item_types || [] });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Новый клиент"
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={save.isPending}>
            Отмена
          </Button>
          <Button type="submit" form="clientForm" busy={save.isPending}>
            Создать
          </Button>
        </>
      }
    >
      <form id="clientForm" onSubmit={handleSubmit(onSubmit)} className={styles.form}>
        <div>
          <input type="text" placeholder="Название *" autoFocus {...register('name')} />
          {errors.name && <div className={styles.err}>{errors.name.message}</div>}
        </div>
        <div>
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

        <Accordion
          id="client-requisites"
          title="Реквизиты"
          summary={requisitesFilled ? 'заполнены' : 'не заполнены'}
        >
          <div>
            <input type="text" inputMode="numeric" placeholder="ИНН" {...register('inn')} />
            {errors.inn && <div className={styles.err}>{errors.inn.message}</div>}
          </div>
          <div>
            <input type="text" inputMode="numeric" placeholder="КПП" {...register('kpp')} />
            {errors.kpp && <div className={styles.err}>{errors.kpp.message}</div>}
          </div>
          <input type="text" placeholder="Юридический адрес" {...register('legal_address')} />
        </Accordion>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Виды белья</div>
          <div className={styles.hint}>Ничего не отмечено — работник увидит все виды.</div>
          <div className={styles.checkList}>
            {itemTypes.map((t) => (
              <label key={t.id} className={styles.checkRow}>
                <input type="checkbox" value={t.id} {...register('item_types')} />
                <span>{t.name}</span>
              </label>
            ))}
            {!itemTypes.length && <div className={styles.hint}>Нет активных видов белья</div>}
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
      </form>
    </Modal>
  );
}

// --- Редактирование: мгновенное сохранение всех полей ---

function ClientEditForm({
  client,
  itemTypes,
  onClose,
  onArchive,
}: {
  client: Client;
  itemTypes: ItemType[];
  onClose: () => void;
  onArchive: (c: Client) => void;
}) {
  const acc =
    client.accounting === 'weight' || client.accounting === 'count' ? client.accounting : 'both';

  // Локальные значения полей; инициализация из клиента
  const [fields, setFields] = useState({
    name: client.name || '',
    type: client.type || 'отель',
    address: client.address || '',
    contact: client.contact || '',
    comment: client.comment || '',
    item_types: parseItemTypes(client.item_types),
    accounting: acc as 'both' | 'weight' | 'count',
    inn: client.inn || '',
    kpp: client.kpp || '',
    legal_address: client.legal_address || '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});
  const [boundCount, setBoundCount] = useState(0);

  const save = useApiMutation('saveClient', {
    invalidate: ['refs', ...OPERATIONAL_PREFIXES],
  });

  // Мгновенное сохранение: полный payload с подменой одного поля, модалка не закрывается
  function saveField(field: string, value: unknown) {
    // Клиентская валидация реквизитов: при ошибке на сервер не уходит
    if (field === 'inn') {
      const v = String(value).trim();
      if (v !== '' && !/^\d{10}$|^\d{12}$/.test(v)) {
        setErrors((e) => ({ ...e, inn: 'ИНН — 10 или 12 цифр' }));
        return;
      }
    }
    if (field === 'kpp') {
      const v = String(value).trim();
      if (v !== '' && !/^\d{9}$/.test(v)) {
        setErrors((e) => ({ ...e, kpp: 'КПП — 9 цифр' }));
        return;
      }
    }
    setErrors((e) => ({ ...e, [field]: '' }));
    const next = { ...fields, [field]: value };
    save.mutate(
      { ...next, id: client.id },
      { onSuccess: () => setSavedAt((s) => ({ ...s, [field]: Date.now() })) }
    );
  }

  // Текст: сохранение по onBlur, только если изменилось
  function blur(field: keyof typeof fields) {
    return () => {
      const initial = {
        name: client.name || '',
        address: client.address || '',
        contact: client.contact || '',
        comment: client.comment || '',
        inn: client.inn || '',
        kpp: client.kpp || '',
        legal_address: client.legal_address || '',
      } as Record<string, string>;
      if (!(field in initial)) return;
      if (String(fields[field]) === initial[field]) return;
      saveField(field, fields[field]);
    };
  }

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
  const priceSummary = useMemo(() => {
    const def: Record<string, string> = {};
    const own: Record<string, string> = {};
    (tariffsQ.data?.tariffs || []).forEach((t) => {
      if (!t.client_id) def[t.billing_item_id] = t.price;
      else if (t.client_id === client.id) own[t.billing_item_id] = t.price;
    });
    return pricesSummary(activeBillingItems, def, own);
  }, [tariffsQ.data, client.id, activeBillingItems]);

  const requisitesFilled = !!(fields.inn || fields.kpp || fields.legal_address);

  return (
    <Modal
      open
      onClose={onClose}
      title={client.name}
      footer={
        <>
          {client.active === 'да' && (
            <Button variant="danger" onClick={() => onArchive(client)}>
              В архив
            </Button>
          )}
          <Button variant="subtle" onClick={onClose}>
            Закрыть
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.fieldRow}>
          <input
            type="text"
            placeholder="Название *"
            autoFocus
            value={fields.name}
            onChange={(e) => setFields({ ...fields, name: e.target.value })}
            onBlur={blur('name')}
          />
          <SavedMark at={savedAt.name ?? null} />
        </div>
        <div className={styles.fieldRow}>
          <select
            aria-label="Тип клиента"
            value={fields.type}
            onChange={(e) => {
              setFields({ ...fields, type: e.target.value });
              saveField('type', e.target.value);
            }}
          >
            {CLIENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <SavedMark at={savedAt.type ?? null} />
        </div>
        <div className={styles.fieldRow}>
          <input
            type="text"
            placeholder="Адрес"
            value={fields.address}
            onChange={(e) => setFields({ ...fields, address: e.target.value })}
            onBlur={blur('address')}
          />
          <SavedMark at={savedAt.address ?? null} />
        </div>
        <div className={styles.fieldRow}>
          <input
            type="text"
            placeholder="Контакт"
            value={fields.contact}
            onChange={(e) => setFields({ ...fields, contact: e.target.value })}
            onBlur={blur('contact')}
          />
          <SavedMark at={savedAt.contact ?? null} />
        </div>
        <div className={styles.fieldRow}>
          <input
            type="text"
            placeholder="Комментарий"
            value={fields.comment}
            onChange={(e) => setFields({ ...fields, comment: e.target.value })}
            onBlur={blur('comment')}
          />
          <SavedMark at={savedAt.comment ?? null} />
        </div>

        <Accordion
          id="client-requisites"
          title="Реквизиты"
          summary={requisitesFilled ? 'заполнены' : 'не заполнены'}
        >
          <div className={styles.fieldRow}>
            <input
              type="text"
              inputMode="numeric"
              placeholder="ИНН"
              value={fields.inn}
              onChange={(e) => setFields({ ...fields, inn: e.target.value })}
              onBlur={blur('inn')}
            />
            <SavedMark at={savedAt.inn ?? null} />
          </div>
          {errors.inn && <div className={styles.err}>{errors.inn}</div>}
          <div className={styles.fieldRow}>
            <input
              type="text"
              inputMode="numeric"
              placeholder="КПП"
              value={fields.kpp}
              onChange={(e) => setFields({ ...fields, kpp: e.target.value })}
              onBlur={blur('kpp')}
            />
            <SavedMark at={savedAt.kpp ?? null} />
          </div>
          {errors.kpp && <div className={styles.err}>{errors.kpp}</div>}
          <div className={styles.fieldRow}>
            <input
              type="text"
              placeholder="Юридический адрес"
              value={fields.legal_address}
              onChange={(e) => setFields({ ...fields, legal_address: e.target.value })}
              onBlur={blur('legal_address')}
            />
            <SavedMark at={savedAt.legal_address ?? null} />
          </div>
        </Accordion>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Виды белья</div>
          <div className={styles.hint}>Ничего не отмечено — работник увидит все виды.</div>
          <div className={styles.checkList}>
            {itemTypes.map((t) => (
              <label key={t.id} className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={fields.item_types.includes(t.id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...fields.item_types, t.id]
                      : fields.item_types.filter((id) => id !== t.id);
                    setFields({ ...fields, item_types: next });
                    saveField('item_types', next);
                  }}
                />
                <span>{t.name}</span>
              </label>
            ))}
            {!itemTypes.length && <div className={styles.hint}>Нет активных видов белья</div>}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Учёт результата</div>
          {ACCOUNTING.map(([v, label]) => (
            <label key={v} className={styles.checkRow}>
              <input
                type="radio"
                name="accounting"
                checked={fields.accounting === v}
                onChange={() => {
                  setFields({ ...fields, accounting: v as typeof fields.accounting });
                  saveField('accounting', v);
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>

        <Accordion id="client-prices" title="Цены" summary={priceSummary}>
          <ClientPricesSection client={client} />
        </Accordion>

        <Accordion
          id="client-bindings"
          title="Привязка видов белья"
          summary={boundCount ? `${boundCount} ${plural(boundCount, 'настроена', 'настроены', 'настроены')}` : 'все по весу / как у типа'}
        >
          <ClientBindingsSection
            client={client}
            types={itemTypes}
            pieceItems={pieceItems}
            onCount={setBoundCount}
          />
        </Accordion>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Счёт за период</div>
          <InvoiceSection clientId={client.id} />
        </div>
      </div>
    </Modal>
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
  if (!client) return <ClientCreateForm itemTypes={activeTypes} onClose={onClose} />;
  return (
    <ClientEditForm
      client={client}
      itemTypes={activeTypes}
      onClose={onClose}
      onArchive={onArchive}
    />
  );
}
