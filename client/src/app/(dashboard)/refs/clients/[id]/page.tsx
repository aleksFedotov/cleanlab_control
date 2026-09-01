'use client';

// Страница клиента /refs/clients/[id] (P2.3): вместо модалки. Шапка с крошками,
// пилюлей типа и единым индикатором автосохранения; меню «⋯» — дублирование и
// архив; вкладки Профиль/Цены/Привязки (активная — в ?tab=, задел под P4).
// Механика сохранения — как в бывшей ClientEditForm: текст по onBlur (если
// изменилось), селекты/чипы по onChange, полный payload с подменой поля.
import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { MoreHorizontal, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Empty } from '@/components/ui/Empty';
import { FilterPills } from '@/components/ui/FilterPills';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs } from '@/components/ui/Tabs';
import { Accordion } from '@/components/ui/Accordion';
import {
  useApiMutation, useBillingItems, useClientItemBilling, useRefs, useTariffs,
} from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import { plural } from '@/lib/format';
import type { Client, ItemType } from '@/types/api';
import { parseItemTypes } from '../../refs-utils';
import { ClientPricesSection, pricesSummary, SaveStatusCallbacks } from '../../client-prices-section';
import { ClientBindingsSection } from '../../client-bindings-section';
import styles from '../../refs.module.css';
import pillStyles from '@/components/ui/FilterPills.module.css';

const CLIENT_TYPES = ['отель', 'ресторан', 'спа', 'прочее'] as const;
const ACCOUNTING = [
  { key: 'both', label: 'Вес + количество' },
  { key: 'weight', label: 'Только вес' },
  { key: 'count', label: 'Только количество' },
] as const;

const REFS_INVALIDATE = ['refs', ...OPERATIONAL_PREFIXES];

function timeNow(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Вкладка «Профиль»: локальные значения инициализируются из клиента один раз
// (keyed по client.id снаружи), сохранение — мгновенное, как в ClientEditForm.
function ProfileTab({
  client,
  itemTypes,
  onSaving,
  onSaved,
}: { client: Client; itemTypes: ItemType[] } & SaveStatusCallbacks) {
  const acc =
    client.accounting === 'weight' || client.accounting === 'count' ? client.accounting : 'both';
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
  // Режим «Виды белья»: null — из данных ([] = все виды), локальный override —
  // чтобы «Только выбранные» с пустым выбором не откатывалось на «все виды»
  const [typesMode, setTypesMode] = useState<'all' | 'selected' | null>(null);

  const save = useApiMutation('saveClient', {
    invalidate: REFS_INVALIDATE,
    onSuccess: () => onSaved?.(),
  });

  // Мгновенное сохранение: полный payload с подменой одного поля
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
    onSaving?.();
    save.mutate({ ...next, id: client.id });
  }

  // Текст: сохранение по onBlur, только если изменилось
  function blur(field: 'name' | 'address' | 'contact' | 'comment' | 'inn' | 'kpp' | 'legal_address') {
    return () => {
      const initial: Record<string, string> = {
        name: client.name || '',
        address: client.address || '',
        contact: client.contact || '',
        comment: client.comment || '',
        inn: client.inn || '',
        kpp: client.kpp || '',
        legal_address: client.legal_address || '',
      };
      if (String(fields[field]) === initial[field]) return;
      saveField(field, fields[field]);
    };
  }

  const requisitesFilled = !!(fields.inn || fields.kpp || fields.legal_address);
  const effTypesMode = typesMode ?? (fields.item_types.length ? 'selected' : 'all');

  return (
    <div className={styles.form}>
      <div className={styles.fieldRow}>
        <input
          type="text"
          placeholder="Название *"
          value={fields.name}
          onChange={(e) => setFields({ ...fields, name: e.target.value })}
          onBlur={blur('name')}
        />
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
      </div>
      <div className={styles.fieldRow}>
        <input
          type="text"
          placeholder="Адрес"
          value={fields.address}
          onChange={(e) => setFields({ ...fields, address: e.target.value })}
          onBlur={blur('address')}
        />
      </div>
      <div className={styles.fieldRow}>
        <input
          type="text"
          placeholder="Контакт"
          value={fields.contact}
          onChange={(e) => setFields({ ...fields, contact: e.target.value })}
          onBlur={blur('contact')}
        />
      </div>
      <div className={styles.fieldRow}>
        <input
          type="text"
          placeholder="Комментарий"
          value={fields.comment}
          onChange={(e) => setFields({ ...fields, comment: e.target.value })}
          onBlur={blur('comment')}
        />
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
        </div>
      </Accordion>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Виды белья</div>
        <FilterPills
          options={[
            { key: 'all', label: 'Все виды белья' },
            { key: 'selected', label: 'Только выбранные' },
          ]}
          active={effTypesMode}
          onChange={(k) => {
            if (k === 'all') {
              setTypesMode(null);
              if (fields.item_types.length) {
                setFields({ ...fields, item_types: [] });
                saveField('item_types', []);
              }
            } else {
              setTypesMode('selected');
            }
          }}
        />
        {effTypesMode === 'all' ? (
          <div className={styles.hint}>Работник увидит все активные виды — ограничений нет</div>
        ) : (
          <>
            <div className={pillStyles.row}>
              {itemTypes.map((t) => {
                const on = fields.item_types.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`${pillStyles.pill} ${on ? pillStyles.active : ''}`}
                    aria-pressed={on}
                    onClick={() => {
                      const next = on
                        ? fields.item_types.filter((x) => x !== t.id)
                        : [...fields.item_types, t.id];
                      setFields({ ...fields, item_types: next });
                      saveField('item_types', next);
                    }}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
            {!itemTypes.length && <div className={styles.hint}>Нет активных видов белья</div>}
            <div className={styles.hint}>
              Выбрано: <span className={styles.monoNum}>{fields.item_types.length}</span> из{' '}
              <span className={styles.monoNum}>{itemTypes.length}</span>
            </div>
            {!fields.item_types.length && (
              <div className={styles.warnHint}>Внимание: работник не увидит ни одного вида</div>
            )}
          </>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Учёт результата</div>
        <FilterPills
          options={ACCOUNTING.map((a) => ({ key: a.key, label: a.label }))}
          active={fields.accounting}
          onChange={(k) => {
            const v = k as 'both' | 'weight' | 'count';
            setFields({ ...fields, accounting: v });
            saveField('accounting', v);
          }}
        />
      </div>
    </div>
  );
}

function ClientPageInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useUiStore((s) => s.toast);

  const refs = useRefs();
  const billing = useBillingItems();
  const tariffsQ = useTariffs();
  const bindingsQ = useClientItemBilling(id);

  const client = useMemo(
    () => (refs.data?.clients || []).find((c) => c.id === id),
    [refs.data, id]
  );
  const itemTypes = useMemo(
    () => (refs.data?.itemTypes || []).filter((t) => t.active === 'да'),
    [refs.data]
  );

  // --- Единый индикатор сохранения: число мутаций в полёте + время последнего ---
  const [pending, setPending] = useState(0);
  const [savedAt, setSavedAt] = useState('');
  const onSaving = () => setPending((p) => p + 1);
  const onSaved = () => {
    setPending((p) => Math.max(0, p - 1));
    setSavedAt(timeNow());
  };

  // --- Сводки вкладок ---
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
      else if (t.client_id === id) own[t.billing_item_id] = t.price;
    });
    return pricesSummary(activeBillingItems, def, own);
  }, [tariffsQ.data, id, activeBillingItems]);

  const boundCount = useMemo(() => {
    const bound = new Set((bindingsQ.data?.bindings || []).map((b) => b.item_type_id));
    const ownIds = client ? parseItemTypes(client.item_types) : [];
    const rows = ownIds.length ? itemTypes.filter((t) => ownIds.includes(t.id)) : itemTypes;
    return rows.filter((t) => bound.has(t.id)).length;
  }, [bindingsQ.data, client, itemTypes]);

  // --- Меню «⋯»: дублирование, архив ---
  const [menuOpen, setMenuOpen] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);

  const duplicate = useApiMutation<{ client: Client }>('saveClient', {
    invalidate: REFS_INVALIDATE,
    onSuccess: (res) => {
      toast('Клиент продублирован');
      router.push(`/refs/clients/${res.client.id}`);
    },
  });
  const archive = useApiMutation('deleteClient', {
    invalidate: REFS_INVALIDATE,
    onSuccess: () => {
      toast('Клиент в архиве');
      router.push('/refs');
    },
  });
  const restore = useApiMutation('saveClient', {
    invalidate: REFS_INVALIDATE,
    onSuccess: () => toast('Клиент возвращён из архива'),
  });

  // --- Вкладки: активная из ?tab= (default — профиль, параметр не пишем) ---
  const tabParam = searchParams.get('tab');
  const tab = tabParam === 'prices' || tabParam === 'bindings' ? tabParam : 'profile';
  const setTab = (key: string) => {
    router.replace(key === 'profile' ? `/refs/clients/${id}` : `/refs/clients/${id}?tab=${key}`, {
      scroll: false,
    });
  };

  if (refs.isPending) {
    return (
      <div className={styles.page}>
        <Skeleton height={12} width="30%" />
        <Skeleton height={24} width="40%" />
        <Skeleton height={36} radius={8} />
        <Skeleton height={44} radius={10} />
        <Skeleton height={44} radius={10} />
        <Skeleton height={44} radius={10} />
      </div>
    );
  }

  if (!client) {
    return (
      <div className={styles.page}>
        <Empty
          icon={<Users size={28} />}
          title="Клиент не найден"
          hint="Возможно, клиент был удалён"
          action={
            <Button variant="ghost" onClick={() => router.push('/refs')}>
              К списку клиентов
            </Button>
          }
        />
      </div>
    );
  }

  const isArchived = client.active !== 'да';

  return (
    <div className={styles.page}>
      {/* Шапка: крошки, заголовок, индикатор сохранения, меню */}
      <nav className={styles.crumbs} aria-label="Хлебные крошки">
        <Link href="/refs">Справочники</Link>
        <span aria-hidden> / </span>
        <Link href="/refs">Клиенты</Link>
        <span aria-hidden> / </span>
        <span>{client.name}</span>
      </nav>
      <div className={styles.clientHead}>
        <div className={styles.clientTitleRow}>
          <h1 className={styles.clientTitle}>{client.name}</h1>
          {client.type && <span className={styles.typePill}>{client.type}</span>}
          {isArchived && <span className={`${styles.badge} ${styles.badgeArchived}`}>в архиве</span>}
        </div>
        <div className={styles.clientHeadRight}>
          <span className={styles.saveStatus} role="status">
            {pending > 0 ? (
              'Сохранение…'
            ) : savedAt ? (
              <>
                <span className={styles.saveOk}>✓</span> Сохранено ·{' '}
                <span className={styles.saveTime}>{savedAt}</span>
              </>
            ) : (
              'Изменения сохраняются автоматически'
            )}
          </span>
          <div className={styles.menuWrap}>
            <Button
              variant="subtle"
              size="sm"
              icon={<MoreHorizontal size={16} />}
              aria-label="Действия с клиентом"
              onClick={() => setMenuOpen(!menuOpen)}
            />
            {menuOpen && (
              <>
                <div className={styles.menuOverlay} onClick={() => setMenuOpen(false)} />
                <div className={styles.menu} role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      setMenuOpen(false);
                      duplicate.mutate({
                        name: `${client.name} (копия)`,
                        type: client.type,
                        address: client.address,
                        contact: client.contact,
                        comment: client.comment,
                        item_types: parseItemTypes(client.item_types),
                        accounting: client.accounting || 'both',
                        inn: client.inn,
                        kpp: client.kpp,
                        legal_address: client.legal_address,
                      });
                    }}
                  >
                    Дублировать
                  </button>
                  <div className={styles.menuSep} />
                  {isArchived ? (
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      onClick={() => {
                        setMenuOpen(false);
                        restore.mutate({ id: client.id, active: 'да' });
                      }}
                    >
                      Вернуть из архива
                    </button>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      className={`${styles.menuItem} ${styles.menuDanger}`}
                      onClick={() => {
                        setMenuOpen(false);
                        setArchiveConfirm(true);
                      }}
                    >
                      В архив
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <Tabs
        options={[
          { key: 'profile', label: 'Профиль' },
          { key: 'prices', label: 'Цены', hint: priceSummary },
          {
            key: 'bindings',
            label: 'Привязки',
            hint: boundCount
              ? `${boundCount} ${plural(boundCount, 'настроена', 'настроены', 'настроены')}`
              : 'все по весу / как у типа',
          },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'profile' && (
        <ProfileTab
          key={client.id}
          client={client}
          itemTypes={itemTypes}
          onSaving={onSaving}
          onSaved={onSaved}
        />
      )}

      {tab === 'prices' && (
        <ClientPricesSection client={client} onSaving={onSaving} onSaved={onSaved} />
      )}

      {tab === 'bindings' && (
        <ClientBindingsSection
          client={client}
          types={itemTypes}
          pieceItems={pieceItems}
          onSaving={onSaving}
          onSaved={onSaved}
        />
      )}

      <ConfirmDialog
        open={archiveConfirm}
        onClose={() => setArchiveConfirm(false)}
        onConfirm={() => archive.mutate(client.id)}
        text={`Клиент «${client.name}» уйдёт в архив: обратимо, пропадёт из списков для новых стирок и визитов.`}
        okLabel="В архив"
        danger
        busy={archive.isPending}
      />
    </div>
  );
}

export default function ClientPage() {
  return (
    <Suspense>
      <ClientPageInner />
    </Suspense>
  );
}
