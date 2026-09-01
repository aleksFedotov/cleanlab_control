'use client';

// Справочники (owner): клиенты + виды белья. Перенос renderRefs/renderRefsBody
// из legacy server/public/index.html:2272-2372. Подвкладки, поиск, фильтр
// все/активные/архив; корзина открывает диалог выбора: архив (обратимо)
// или удаление совсем (deleteClient=архив / purgeClient, saveItemType /
// deleteItemType, saveBillingItem / deleteBillingItem).
import { useEffect, useMemo, useState } from 'react';
import {
  Plus, Pencil, Trash2, RotateCcw, Search, Users, Shirt, TriangleAlert, ReceiptText,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { DataTable, DataTableColumn } from '@/components/ui/DataTable';
import { FilterPills } from '@/components/ui/FilterPills';
import { Empty } from '@/components/ui/Empty';
import { Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/Skeleton';
import { useRefs, useBillingItems, useTariffs, useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import { plural } from '@/lib/format';
import type { BillingItem, Client, ItemType } from '@/types/api';
import { ClientForm } from './client-form';
import { TypeForm } from './type-form';
import { PriceItemForm } from './price-item-form';
import { parseItemTypes } from './refs-utils';
import styles from './refs.module.css';

type RefsTab = 'clients' | 'types' | 'price';
type ClientFilter = 'all' | 'active' | 'archived';

// P2.2: позиции доставки/подъёма — фиксированный блок, свободные — только стирка
const isLogistics = (b: BillingItem) => b.kind === 'trip' || b.kind === 'lift';

// Пороговая позиция — единственная trip с max_kg и oneway ≠ да (P2.2)
const isThresholdTrip = (b: BillingItem) =>
  b.kind === 'trip' && !!b.max_kg && b.oneway !== 'да';

const BILLING_KIND_LABELS: Record<string, string> = {
  wash_weight: 'Стирка по весу',
  wash_pcs: 'Поштучно',
  trip: 'Рейс',
  lift: 'Подъём',
};

// Инлайн-редактор дефолтной цены позиции (saveTariff с clientId='' — дефолт прачки)
function DefaultPriceCell({ item, price }: { item: BillingItem; price: string }) {
  const [value, setValue] = useState(price);
  const save = useApiMutation('saveTariff', {
    invalidate: ['tariffs'],
    onSuccess: () => useUiStore.getState().toast('Цена сохранена'),
  });
  return (
    <input
      className={styles.priceInput}
      type="text"
      inputMode="decimal"
      placeholder="—"
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const v = value.trim().replace(',', '.');
        if (v === price) return;
        save.mutate(['', item.id, v]);
      }}
      aria-label={`Дефолтная цена: ${item.name}`}
    />
  );
}

// Инлайн-редактор кода НФ системной позиции (P2.2) — saveBillingItem с id.
function ExtCodeCell({ item }: { item: BillingItem }) {
  const [value, setValue] = useState(item.ext_code || '');
  const save = useApiMutation('saveBillingItem', {
    invalidate: ['billingItems'],
    onSuccess: () => useUiStore.getState().toast('Код НФ сохранён'),
  });
  return (
    <input
      className={styles.priceInput}
      type="text"
      placeholder="—"
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const v = value.trim();
        if (v === (item.ext_code || '')) return;
        save.mutate({ id: item.id, kind: item.kind, ext_code: v });
      }}
      aria-label={`Код НФ: ${item.name}`}
    />
  );
}

// Инлайн-поле порога платной доставки N (P2.2): число > 0 с подтверждением;
// имя позиции в счёте генерируется сервером («Доставка менее N кг»).
function ThresholdCell({ item }: { item: BillingItem }) {
  const [value, setValue] = useState(item.max_kg || '');
  const toast = useUiStore((s) => s.toast);
  const save = useApiMutation('saveBillingItem', {
    invalidate: ['billingItems'],
    onSuccess: () => useUiStore.getState().toast('Порог сохранён'),
  });
  return (
    <input
      className={styles.priceInput}
      type="text"
      inputMode="numeric"
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const v = value.trim();
        if (v === item.max_kg) return;
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          toast('Порог — целое число больше 0', 'err');
          setValue(item.max_kg || '');
          return;
        }
        if (!window.confirm(
          `Сделать платной доставку менее ${n} кг? Прошлые периоды в счетах и «Финансах» пересчитаются.`
        )) {
          setValue(item.max_kg || '');
          return;
        }
        save.mutate({ id: item.id, kind: item.kind, max_kg: String(n) });
      }}
      aria-label="Порог платной доставки, кг"
    />
  );
}

// Клиенты/виды белья видны на операционных экранах (стирка, развоз, склад) —
// инвалидируем refs + все операционные чтения.
const REFS_INVALIDATE = ['refs', ...OPERATIONAL_PREFIXES];

export default function RefsPage() {
  const refs = useRefs();
  const billing = useBillingItems();
  const tariffsQ = useTariffs();
  const toast = useUiStore((s) => s.toast);

  const [tab, setTab] = useState<RefsTab>('clients');
  const [filter, setFilter] = useState<ClientFilter>('active');
  const [search, setSearch] = useState('');
  const [clientForm, setClientForm] = useState<Client | 'new' | null>(null);
  const [typeForm, setTypeForm] = useState<ItemType | 'new' | null>(null);
  const [priceForm, setPriceForm] = useState<BillingItem | 'new' | null>(null);
  const [confirm, setConfirm] = useState<
    { kind: 'client'; row: Client } | { kind: 'type'; row: ItemType } | { kind: 'price'; row: BillingItem } | null
  >(null);

  // §7: ошибка API — тост; на месте контента «Повторить», если данных нет
  useEffect(() => {
    if (refs.isError) toast(refs.error?.message || 'Не удалось загрузить справочники', 'err');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs.isError, refs.error]);

  const archiveClient = useApiMutation('deleteClient', {
    invalidate: REFS_INVALIDATE,
    onSuccess: () => {
      setConfirm(null);
      toast('Клиент в архиве');
    },
  });

  // Возврат клиента из архива — saveClient с active=да (сервер мержит поля)
  const restoreClient = useApiMutation('saveClient', {
    invalidate: REFS_INVALIDATE,
    onSuccess: () => toast('Клиент возвращён из архива'),
  });

  // Удаление клиента совсем; сервер откажет, если есть стирки/визиты (ошибка → тост)
  const purgeClientM = useApiMutation('purgeClient', {
    invalidate: REFS_INVALIDATE,
    onSuccess: () => {
      setConfirm(null);
      toast('Клиент удалён');
    },
  });

  // Архивация/возврат вида белья — saveItemType с переключением active (legacy data-ttoggle)
  const toggleType = useApiMutation('saveItemType', {
    invalidate: REFS_INVALIDATE,
    onSuccess: () => {
      setConfirm(null);
      toast('Сохранено');
    },
  });

  // Удаление вида белья совсем; сервер откажет, если вид используется у клиентов
  const deleteTypeM = useApiMutation('deleteItemType', {
    invalidate: REFS_INVALIDATE,
    onSuccess: () => {
      setConfirm(null);
      toast('Вид белья удалён');
    },
  });

  // Архивация/возврат позиции прайса — saveBillingItem с переключением active.
  // Удаление почти всегда запрещено сервером (используется в тарифах/привязках), поэтому архивируем.
  const togglePrice = useApiMutation('saveBillingItem', {
    invalidate: ['billingItems', 'tariffs'],
    onSuccess: () => {
      setConfirm(null);
      toast('Сохранено');
    },
  });

  // Удаление позиции прайса совсем (только стирка; сервер проверяет использование)
  const deletePriceM = useApiMutation('deleteBillingItem', {
    invalidate: ['billingItems', 'tariffs'],
    onSuccess: () => {
      setConfirm(null);
      toast('Позиция удалена');
    },
  });

  const clients = useMemo(() => refs.data?.clients || [], [refs.data]);
  const itemTypes = useMemo(() => refs.data?.itemTypes || [], [refs.data]);
  const billingItems = useMemo(() => billing.data?.items || [], [billing.data]);
  // Дефолтные цены прачки (client_id='') по позиции
  const defaultPrices = useMemo(() => {
    const m: Record<string, string> = {};
    (tariffsQ.data?.tariffs || []).forEach((t) => {
      if (!t.client_id) m[t.billing_item_id] = t.price;
    });
    return m;
  }, [tariffsQ.data]);

  const q = search.trim().toLowerCase();

  // Сколько клиентов используют каждый вид белья (legacy usage по всем клиентам)
  const typeUsage = useMemo(() => {
    const usage: Record<string, number> = {};
    clients.forEach((c) => {
      parseItemTypes(c.item_types).forEach((tid) => {
        usage[tid] = (usage[tid] || 0) + 1;
      });
    });
    return usage;
  }, [clients]);

  const visibleClients = useMemo(
    () =>
      clients.filter((c) => {
        if (filter === 'active' && c.active !== 'да') return false;
        if (filter === 'archived' && c.active === 'да') return false;
        if (!q) return true;
        return [c.name, c.type, c.address, c.contact]
          .join(' ')
          .toLowerCase()
          .includes(q);
      }),
    [clients, filter, q]
  );

  const visibleTypes = useMemo(
    () => itemTypes.filter((t) => !q || t.name.toLowerCase().includes(q)),
    [itemTypes, q]
  );

  const visiblePriceItems = useMemo(
    () => billingItems.filter((b) => !isLogistics(b) && (!q || b.name.toLowerCase().includes(q))),
    [billingItems, q]
  );
  const logisticsItems = useMemo(
    () => billingItems.filter((b) => isLogistics(b) && (!q || b.name.toLowerCase().includes(q))),
    [billingItems, q]
  );

  const clientColumns: DataTableColumn[] = [
    {
      key: 'name',
      title: 'Название',
      render: (c: Client) => (
        <span className={c.active !== 'да' ? styles.muted : ''}>
          <span className={styles.cellName}>{c.name}</span>
          {c.active !== 'да' && <span className={styles.sub}> (архив)</span>}
        </span>
      ),
    },
    { key: 'type', title: 'Тип', render: (c: Client) => c.type || '—' },
    { key: 'address', title: 'Адрес', render: (c: Client) => c.address || '—' },
    { key: 'contact', title: 'Контакт', render: (c: Client) => c.contact || '—' },
    {
      key: 'item_types',
      title: 'Виды белья',
      render: (c: Client) => {
        const n = parseItemTypes(c.item_types).length;
        return n ? `${n} ${plural(n, 'вид', 'вида', 'видов')} белья` : 'все виды';
      },
    },
    {
      key: 'actions',
      title: '',
      align: 'right',
      render: (c: Client) => (
        <span className={styles.rowActions}>
          <Button
            variant="subtle"
            size="sm"
            icon={<Pencil size={15} />}
            aria-label="Изменить"
            onClick={(e) => {
              e.stopPropagation();
              setClientForm(c);
            }}
          />
          {c.active === 'да' ? (
            <Button
              variant="subtle"
              size="sm"
              icon={<Trash2 size={15} />}
              aria-label="В архив"
              onClick={(e) => {
                e.stopPropagation();
                setConfirm({ kind: 'client', row: c });
              }}
            />
          ) : (
            <>
              <Button
                variant="subtle"
                size="sm"
                icon={<RotateCcw size={15} />}
                aria-label="Вернуть из архива"
                busy={restoreClient.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  restoreClient.mutate({ id: c.id, active: 'да' });
                }}
              />
              <Button
                variant="subtle"
                size="sm"
                icon={<Trash2 size={15} />}
                aria-label="Удалить совсем"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirm({ kind: 'client', row: c });
                }}
              />
            </>
          )}
        </span>
      ),
    },
  ];

  const typeColumns: DataTableColumn[] = [
    {
      key: 'name',
      title: 'Название',
      render: (t: ItemType) => (
        <span className={t.active !== 'да' ? styles.muted : ''}>
          <span className={styles.cellName}>{t.name}</span>
          {t.active !== 'да' && <span className={styles.sub}> (архив)</span>}
        </span>
      ),
    },
    {
      key: 'usage',
      title: 'Клиентов',
      align: 'right',
      mono: true,
      render: (t: ItemType) => typeUsage[t.id] || 0,
    },
    {
      key: 'actions',
      title: '',
      align: 'right',
      render: (t: ItemType) => (
        <span className={styles.rowActions}>
          <Button
            variant="subtle"
            size="sm"
            icon={<Pencil size={15} />}
            aria-label="Переименовать"
            onClick={() => setTypeForm(t)}
          />
          {t.active === 'да' ? (
            <Button
              variant="subtle"
              size="sm"
              icon={<Trash2 size={15} />}
              aria-label="Архивировать"
              onClick={() => setConfirm({ kind: 'type', row: t })}
            />
          ) : (
            <Button
              variant="subtle"
              size="sm"
              icon={<RotateCcw size={15} />}
              aria-label="Вернуть"
              busy={toggleType.isPending}
              onClick={() => toggleType.mutate({ id: t.id, active: 'да' })}
            />
          )}
        </span>
      ),
    },
  ];

  const priceColumns: DataTableColumn[] = [
    {
      key: 'name',
      title: 'Название',
      render: (b: BillingItem) => (
        <span className={b.active !== 'да' ? styles.muted : ''}>
          <span className={styles.cellName}>{b.name}</span>
          {b.active !== 'да' && <span className={styles.sub}> (архив)</span>}
        </span>
      ),
    },
    { key: 'kind', title: 'Тип', render: (b: BillingItem) => BILLING_KIND_LABELS[b.kind] || b.kind },
    { key: 'unit', title: 'Ед.' },
    { key: 'ext_code', title: 'Код НФ', render: (b: BillingItem) => b.ext_code || '—' },
    {
      key: 'price',
      title: 'Цена по умолч.',
      align: 'right',
      render: (b: BillingItem) => <DefaultPriceCell item={b} price={defaultPrices[b.id] || ''} />,
    },
    {
      key: 'actions',
      title: '',
      align: 'right',
      render: (b: BillingItem) => (
        <span className={styles.rowActions}>
          <Button
            variant="subtle"
            size="sm"
            icon={<Pencil size={15} />}
            aria-label="Изменить"
            onClick={() => setPriceForm(b)}
          />
          {b.active === 'да' ? (
            <Button
              variant="subtle"
              size="sm"
              icon={<Trash2 size={15} />}
              aria-label="Архивировать"
              onClick={() => setConfirm({ kind: 'price', row: b })}
            />
          ) : (
            <Button
              variant="subtle"
              size="sm"
              icon={<RotateCcw size={15} />}
              aria-label="Вернуть"
              busy={togglePrice.isPending}
              onClick={() => togglePrice.mutate({ ...b, active: 'да' })}
            />
          )}
        </span>
      ),
    },
  ];

  // Фиксированный блок «Доставка и подъём» (P2.2): без удаления, активности
  // и параметров; у пороговой — инлайн-порог N, у всех — цена и код НФ.
  // Legacy-позиции (созданные до запрета) — только архивация/возврат.
  const logisticsColumns: DataTableColumn[] = [
    {
      key: 'name',
      title: 'Название',
      render: (b: BillingItem) => (
        <span className={b.active !== 'да' ? styles.muted : ''}>
          <span className={styles.cellName}>{b.name}</span>
          {b.active !== 'да' && <span className={styles.sub}> (архив)</span>}
        </span>
      ),
    },
    {
      key: 'max_kg',
      title: 'Порог, кг',
      align: 'right',
      mono: true,
      render: (b: BillingItem) =>
        isThresholdTrip(b) ? <ThresholdCell item={b} /> : (b.max_kg || '—'),
    },
    {
      key: 'ext_code',
      title: 'Код НФ',
      render: (b: BillingItem) => <ExtCodeCell item={b} />,
    },
    {
      key: 'price',
      title: 'Цена по умолч.',
      align: 'right',
      render: (b: BillingItem) => <DefaultPriceCell item={b} price={defaultPrices[b.id] || ''} />,
    },
    {
      key: 'actions',
      title: '',
      align: 'right',
      render: (b: BillingItem) =>
        // legacy (не из системного набора): только архивация/возврат
        !isThresholdTrip(b) && !(b.kind === 'trip' && b.oneway === 'да') && !(b.kind === 'lift' && b.per_floor === 'да') ? (
          <span className={styles.rowActions}>
            {b.active === 'да' ? (
              <Button
                variant="subtle"
                size="sm"
                icon={<Trash2 size={15} />}
                aria-label="Архивировать"
                onClick={() => setConfirm({ kind: 'price', row: b })}
              />
            ) : (
              <Button
                variant="subtle"
                size="sm"
                icon={<RotateCcw size={15} />}
                aria-label="Вернуть"
                busy={togglePrice.isPending}
                onClick={() => togglePrice.mutate({ id: b.id, kind: b.kind, active: 'да' })}
              />
            )}
          </span>
        ) : null,
    },
  ];

  const addButton = (
    <Button icon={<Plus size={16} />} onClick={() => (tab === 'clients' ? setClientForm('new') : tab === 'types' ? setTypeForm('new') : setPriceForm('new'))}>
      {tab === 'clients' ? 'Добавить клиента' : tab === 'types' ? 'Добавить вид' : 'Добавить позицию'}
    </Button>
  );

  let body;
  if (refs.isPending) {
    body = (
      <div className={styles.skel}>
        <Skeleton height={36} radius={8} />
        <Skeleton height={40} radius={8} />
        <Skeleton height={44} radius={10} />
        <Skeleton height={44} radius={10} />
        <Skeleton height={44} radius={10} />
        <Skeleton height={44} radius={10} />
      </div>
    );
  } else if (refs.isError && !refs.data) {
    body = (
      <Empty
        icon={<TriangleAlert size={28} />}
        title="Не удалось загрузить справочники"
        hint={refs.error?.message}
        action={
          <Button variant="ghost" onClick={() => refs.refetch()}>
            Повторить
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        <FilterPills
          options={[
            { key: 'clients', label: 'Клиенты' },
            { key: 'types', label: 'Виды белья' },
            { key: 'price', label: 'Прайс' },
          ]}
          active={tab}
          onChange={(k) => {
            setTab(k as RefsTab);
            setSearch('');
          }}
        />
        <div className={styles.searchWrap}>
          <Search size={16} className={styles.searchIcon} aria-hidden />
          <input
            className={styles.search}
            placeholder={
              tab === 'clients' ? 'Поиск по названию, адресу, контакту…' : tab === 'types' ? 'Поиск вида белья…' : 'Поиск позиции прайса…'
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {tab === 'clients' ? (
          <>
            <FilterPills
              options={[
                { key: 'all', label: 'Все' },
                { key: 'active', label: 'Активные' },
                { key: 'archived', label: 'Архив' },
              ]}
              active={filter}
              onChange={(k) => setFilter(k as ClientFilter)}
            />
            <DataTable
              columns={clientColumns}
              rows={visibleClients}
              keyField="id"
              onRowClick={(c: Client) => setClientForm(c)}
              empty={
                q ? (
                  <Empty icon={<Search size={26} />} title="Ничего не найдено" hint={`По запросу «${search.trim()}» клиентов нет`} />
                ) : (
                  <Empty
                    icon={<Users size={28} />}
                    title={filter === 'archived' ? 'Архив пуст' : 'Клиентов пока нет'}
                    hint={filter === 'archived' ? 'Архивированные клиенты появятся здесь' : 'Добавьте первого клиента'}
                    action={
                      filter !== 'archived' ? (
                        <Button icon={<Plus size={16} />} onClick={() => setClientForm('new')}>
                          Добавить клиента
                        </Button>
                      ) : undefined
                    }
                  />
                )
              }
            />
          </>
        ) : tab === 'types' ? (
          <DataTable
            columns={typeColumns}
            rows={visibleTypes}
            keyField="id"
            empty={
              q ? (
                <Empty icon={<Search size={26} />} title="Ничего не найдено" hint={`По запросу «${search.trim()}» видов белья нет`} />
              ) : (
                <Empty
                  icon={<Shirt size={28} />}
                  title="Видов белья пока нет"
                  hint="Добавьте первый вид белья"
                  action={
                    <Button icon={<Plus size={16} />} onClick={() => setTypeForm('new')}>
                      Добавить вид
                    </Button>
                  }
                />
              )
            }
          />
        ) : (
          <>
            <div className={styles.hint}>Стирка</div>
            <DataTable
              columns={priceColumns}
              rows={visiblePriceItems}
              keyField="id"
              empty={
                q ? (
                  <Empty icon={<Search size={26} />} title="Ничего не найдено" hint={`По запросу «${search.trim()}» позиций прайса нет`} />
                ) : (
                  <Empty
                    icon={<ReceiptText size={28} />}
                    title="Позиций прайса пока нет"
                    hint="Добавьте первую позицию прайса"
                    action={
                      <Button icon={<Plus size={16} />} onClick={() => setPriceForm('new')}>
                        Добавить позицию
                      </Button>
                    }
                  />
                )
              }
            />
            <div className={styles.hint}>
              В счёте должна быть ровно одна активная весовая позиция — в неё идёт всё бельё без штучной привязки.
            </div>
            {logisticsItems.length > 0 && (
              <>
                <div className={styles.hint}>Доставка и подъём</div>
                <DataTable columns={logisticsColumns} rows={logisticsItems} keyField="id" />
                <div className={styles.hint}>
                  Позиции фиксированы: редактируются только цены и коды НФ, у «Доставки менее N кг» —
                  ещё и порог N (прошлые периоды пересчитаются). Доставка от N кг — бесплатно;
                  цены для конкретного клиента — в карточке клиента.
                </div>
              </>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader title="Справочники" actions={refs.data ? addButton : undefined} />
      <div className={styles.page}>{body}</div>

      {clientForm !== null && (
        <ClientForm
          client={clientForm === 'new' ? null : clientForm}
          itemTypes={itemTypes}
          onClose={() => setClientForm(null)}
          onArchive={(c) => {
            setClientForm(null);
            setConfirm({ kind: 'client', row: c });
          }}
        />
      )}

      {typeForm !== null && (
        <TypeForm type={typeForm === 'new' ? null : typeForm} onClose={() => setTypeForm(null)} />
      )}

      {priceForm !== null && (
        <PriceItemForm item={priceForm === 'new' ? null : priceForm} onClose={() => setPriceForm(null)} />
      )}

      {(() => {
        const canDelete = !!confirm && !(confirm.kind === 'price' && isLogistics(confirm.row));
        const canArchive = !!confirm && confirm.row.active === 'да';
        const busy =
          archiveClient.isPending || toggleType.isPending || togglePrice.isPending ||
          purgeClientM.isPending || deleteTypeM.isPending || deletePriceM.isPending;
        const name = confirm?.row.name || '';
        const text =
          confirm?.kind === 'client'
            ? `Клиент «${name}»: архив — обратимо, пропадёт из списков для новых стирок и визитов. Удаление совсем возможно, только если у клиента ещё не было стирок и визитов.`
            : confirm?.kind === 'type'
              ? `Вид белья «${name}»: архив — обратимо, пропадёт из форм стирки. Удалить совсем можно, только если вид не привязан ни у одного клиента.`
              : confirm?.kind === 'price'
                ? isLogistics(confirm.row)
                  ? `Позиция прайса «${name}» будет архивирована и перестанет попадать в новые счета.`
                  : `Позиция прайса «${name}»: архив — обратимо, позиция перестанет попадать в новые счета. Удалить совсем можно, только если позиция не используется в тарифах и привязках.`
                : '';
        return (
          <Modal
            open={confirm !== null}
            onClose={() => setConfirm(null)}
            title="Подтверждение"
            footer={
              <>
                <Button variant="subtle" onClick={() => setConfirm(null)} disabled={busy}>
                  Отмена
                </Button>
                {canArchive && (
                  <Button
                    busy={archiveClient.isPending || toggleType.isPending || togglePrice.isPending}
                    disabled={busy}
                    onClick={() => {
                      if (!confirm) return;
                      if (confirm.kind === 'client') archiveClient.mutate(confirm.row.id);
                      else if (confirm.kind === 'type') toggleType.mutate({ id: confirm.row.id, active: 'нет' });
                      else togglePrice.mutate({ ...confirm.row, active: 'нет' });
                    }}
                  >
                    В архив
                  </Button>
                )}
                {canDelete && (
                  <Button
                    variant="danger"
                    busy={purgeClientM.isPending || deleteTypeM.isPending || deletePriceM.isPending}
                    disabled={busy}
                    onClick={() => {
                      if (!confirm) return;
                      if (confirm.kind === 'client') purgeClientM.mutate(confirm.row.id);
                      else if (confirm.kind === 'type') deleteTypeM.mutate(confirm.row.id);
                      else deletePriceM.mutate(confirm.row.id);
                    }}
                  >
                    Удалить совсем
                  </Button>
                )}
              </>
            }
          >
            {text}
          </Modal>
        );
      })()}
    </>
  );
}
