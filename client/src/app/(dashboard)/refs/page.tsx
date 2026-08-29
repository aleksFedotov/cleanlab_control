'use client';

// Справочники (owner): клиенты + виды белья. Перенос renderRefs/renderRefsBody
// из legacy server/public/index.html:2272-2372. Подвкладки, поиск, фильтр
// все/активные/архив; архивация — через ConfirmDialog (deleteClient / saveItemType).
import { useEffect, useMemo, useState } from 'react';
import {
  Plus, Pencil, Trash2, RotateCcw, Search, Users, Shirt, TriangleAlert, ReceiptText,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { DataTable, DataTableColumn } from '@/components/ui/DataTable';
import { FilterPills } from '@/components/ui/FilterPills';
import { Empty } from '@/components/ui/Empty';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
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

  // Архивация/возврат вида белья — saveItemType с переключением active (legacy data-ttoggle)
  const toggleType = useApiMutation('saveItemType', {
    invalidate: REFS_INVALIDATE,
    onSuccess: () => {
      setConfirm(null);
      toast('Сохранено');
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
    () => billingItems.filter((b) => !q || b.name.toLowerCase().includes(q)),
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
          {c.active === 'да' && (
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
    { key: 'max_kg', title: 'Ярус, кг', align: 'right', mono: true, render: (b: BillingItem) => b.max_kg || '—' },
    { key: 'oneway', title: 'В одну сторону', render: (b: BillingItem) => b.oneway === 'да' ? 'да' : '—' },
    { key: 'per_floor', title: 'За этаж', render: (b: BillingItem) => b.per_floor === 'да' ? 'да' : '—' },
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

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        danger
        okLabel={confirm?.kind === 'type' || confirm?.kind === 'price' ? 'Архивировать' : 'В архив'}
        busy={archiveClient.isPending || toggleType.isPending || togglePrice.isPending}
        text={
          confirm?.kind === 'client'
            ? `Клиент «${confirm.row.name}» уйдёт в архив: пропадёт из списков для новых стирок и визитов.`
            : confirm?.kind === 'type'
              ? `Вид белья «${confirm.row.name}» будет архивирован и пропадёт из форм стирки.`
              : confirm?.kind === 'price'
                ? `Позиция прайса «${confirm.row.name}» будет архивирована и перестанет попадать в новые счета.`
                : ''
        }
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === 'client') archiveClient.mutate(confirm.row.id);
          else if (confirm.kind === 'type') toggleType.mutate({ id: confirm.row.id, active: 'нет' });
          else togglePrice.mutate({ ...confirm.row, active: 'нет' });
        }}
      />
    </>
  );
}
