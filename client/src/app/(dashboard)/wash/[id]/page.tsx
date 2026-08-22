'use client';

// Карточка стирки (перенос legacy renderWashCard + saveResult,
// server/public/index.html:581-850). Отдельного API нет: стирка ищется по id
// в getDayList её дня (день находим по кэшу, иначе — выбранная дата раздела).
// Несохранённый ввод (вес/мешки/пересчёт) — в локальном состоянии, keyed by id,
// чтобы переживать рефетч (как state.counts/weights/bags в legacy).
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarClock,
  Check,
  Clock,
  MessageSquare,
  Waves,
} from 'lucide-react';
import { useApiMutation, useDayList } from '@/hooks/use-api';
import { useSectionDate } from '@/hooks/use-section-date';
import { useUiStore } from '@/stores/ui';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Empty } from '@/components/ui/Empty';
import { Skeleton, SkeletonCards } from '@/components/ui/Skeleton';
import { formatDateRu, timeOf } from '@/lib/dates';
import { num } from '@/lib/format';
import type { DayListRes, DayWash, ItemType, Wash } from '@/types/api';
import { Stepper } from './Stepper';
import { NumInputModal } from './NumInputModal';
import { StartWashModal } from './StartWashModal';
import { StorageCheckModal } from './StorageCheckModal';
import { AddItemTypeModal } from './AddItemTypeModal';
import { EditWashModal } from './EditWashModal';
import { DeferWashModal } from './DeferWashModal';
import { IssueDateModal } from './IssueDateModal';
import { StatusTimeline } from './StatusTimeline';
import styles from './wash-id.module.css';

const WEIGHT_STEPS = [
  { delta: -1, label: '−1' },
  { delta: -0.1, label: '−0.1' },
  { delta: 0.1, label: '+0.1' },
  { delta: 1, label: '+1' },
  { delta: 5, label: '+5' },
];
const BAG_STEPS = [
  { delta: -1, label: '−' },
  { delta: 1, label: '+' },
];

function totalQty(counts: Record<string, number>): number {
  return Object.keys(counts).reduce((s, k) => s + (counts[k] || 0), 0);
}

function countsToItems(counts: Record<string, number>) {
  return Object.keys(counts)
    .filter((k) => counts[k] > 0)
    .map((k) => ({ item_type_id: k, qty: counts[k] }));
}

type ModalKind = 'start' | 'storage' | 'addType' | 'edit' | 'defer' | 'issueDate';
type ConfirmKind = 'delete' | 'cancel' | 'issued';

interface NumInputState {
  title: string;
  current: number | string;
  isFloat: boolean;
  onOk: (v: number) => void;
}

export default function WashCardPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const toast = useUiStore((s) => s.toast);
  const qc = useQueryClient();
  const [sectionDate] = useSectionDate('wash');

  // Стирка может быть не за выбранную в разделе дату (переход из диалога
  // закрытия смены, прямая ссылка) — ищем день по кэшу dayList.
  let washDate = sectionDate;
  for (const [, d] of qc.getQueriesData<DayListRes>({ queryKey: ['dayList'] })) {
    if (d?.washes?.some((x) => x.id === id)) {
      washDate = d.date;
      break;
    }
  }
  const { data, isPending, isError, error, refetch } = useDayList(washDate);

  // --- Несохранённый ввод (аналог state.counts/weights/bags/extraTypes/checkedDirty) ---
  const [countsMap, setCountsMap] = useState<Record<string, Record<string, number>>>({});
  const [weightsMap, setWeightsMap] = useState<Record<string, number>>({});
  const [bagsMap, setBagsMap] = useState<Record<string, number>>({});
  const [extraMap, setExtraMap] = useState<Record<string, string[]>>({});
  const [checkedMap, setCheckedMap] = useState<Record<string, boolean>>({});
  const [createdTypes, setCreatedTypes] = useState<ItemType[]>([]);
  const [mode, setMode] = useState<'full' | 'partial'>('full');

  const [modal, setModal] = useState<ModalKind | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const [numInput, setNumInput] = useState<NumInputState | null>(null);

  function clearDrafts() {
    setCountsMap((m) => ({ ...m, [id]: {} }));
    setWeightsMap((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
    setBagsMap((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
    setExtraMap((m) => ({ ...m, [id]: [] }));
  }

  const completeMut = useApiMutation<{ ok: true; wash: Wash }>('completeWash', {
    invalidate: 'operational',
    onSuccess: (res) => {
      clearDrafts();
      const st = res.wash.status;
      toast(
        st === 'partial'
          ? 'Частично завершено: чистое на складе'
          : st === 'stored'
            ? 'Стирка завершена ✓ бельё на склад'
            : 'Стирка завершена ✓'
      );
      router.push('/wash');
    },
  });
  const deleteMut = useApiMutation('deleteWash', {
    invalidate: 'operational',
    onSuccess: () => {
      toast('Стирка удалена ✓');
      router.push('/wash');
    },
  });
  const cancelMut = useApiMutation('cancelWash', {
    invalidate: 'operational',
    onSuccess: () => {
      toast('Стирка отменена');
      router.push('/wash');
    },
  });
  const issuedMut = useApiMutation('markIssued', {
    invalidate: 'operational',
    onSuccess: () => {
      toast('Выдано ✓');
      router.push('/wash');
    },
  });
  // «Запомнить для клиента» — фоновая операция, без инвалидации (legacy: silent catch)
  const rememberMut = useApiMutation('rememberClientItemType');

  useEffect(() => {
    if (isError && error) toast(error.message || 'Ошибка загрузки', 'err');
  }, [isError, error, toast]);

  if (isPending) {
    return (
      <div className={styles.page}>
        <Skeleton height={32} width={260} />
        <SkeletonCards count={3} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Empty
        icon={<Waves size={40} />}
        title="Не удалось загрузить данные"
        hint={error?.message || 'Проверьте связь.'}
        action={<Button onClick={() => refetch()}>Повторить</Button>}
      />
    );
  }

  const w: DayWash | undefined = (data.washes || []).find((x) => x.id === id);
  if (!w) {
    return (
      <Empty
        icon={<Waves size={40} />}
        title="Стирка не найдена"
        hint="Возможно, она перенесена на другой день или удалена."
        action={<Button onClick={() => router.push('/wash')}>К списку</Button>}
      />
    );
  }

  // --- Производные значения (как в legacy renderWashCard) ---
  const counts = countsMap[id] || {};
  // При достирке (partial_rest) форма вводит ДЕЛЬТУ остатка: не префиллим вес
  // первой части, иначе completeWash суммирует его дважды (server/api.js completeWash).
  const weight =
    weightsMap[id] != null ? weightsMap[id] : w.partial_rest ? 0 : num(w.dirty_weight_kg) || 0;
  const bagsVal = bagsMap[id] || 0;
  const extra = extraMap[id] || [];
  const checkedDirty = !!checkedMap[id];
  const acc = w.client_accounting || 'both';
  const canEdit = w.status === 'done' || w.status === 'stored' || w.status === 'partial';
  const total = totalQty(counts);

  const dayTypes = data.itemTypes || [];
  const types: ItemType[] = [
    ...dayTypes,
    ...createdTypes.filter((t) => !dayTypes.some((d) => d.id === t.id)),
  ];
  // Видимые виды белья: список клиента (или все) + добавленные вручную + ненулевой пересчёт
  const vis: ItemType[] =
    w.client_item_types && w.client_item_types.length
      ? types.filter((t) => w.client_item_types.indexOf(t.id) !== -1)
      : types.slice();
  types.forEach((t) => {
    if (vis.indexOf(t) === -1 && (extra.indexOf(t.id) !== -1 || (counts[t.id] || 0) > 0)) {
      vis.push(t);
    }
  });

  // --- Степперы ---
  const stepWeight = (d: number) =>
    setWeightsMap((m) => ({
      ...m,
      [id]: Math.max(0, Math.round(((m[id] != null ? m[id] : weight) + d) * 10) / 10),
    }));
  const stepBags = (d: number) =>
    setBagsMap((m) => ({ ...m, [id]: Math.max(0, (m[id] || 0) + d) }));
  const stepCount = (tid: string, d: number) =>
    setCountsMap((m) => ({
      ...m,
      [id]: { ...(m[id] || {}), [tid]: Math.max(0, ((m[id] || {})[tid] || 0) + d) },
    }));

  // --- Сохранение результата (legacy saveResult) ---
  function saveResult() {
    const kgVal =
      weightsMap[id] != null ? weightsMap[id] : w!.partial_rest ? 0 : num(w!.dirty_weight_kg) || 0;
    const bagsCount = bagsMap[id] || 0;
    if (acc !== 'count' && kgVal <= 0) {
      toast('Укажите вес чистого белья', 'err');
      return;
    }
    if (bagsCount <= 0) {
      toast('Укажите количество мешков', 'err');
      return;
    }
    completeMut.mutate([w!.id, countsToItems(counts), kgVal, mode, bagsCount]);
  }

  const dirtyOk = w.has_dirty || checkedDirty;
  const canDefer = w.status === 'planned' || w.status === 'in_progress' || w.status === 'partial';
  const canCancel = w.status === 'planned' || w.status === 'no_linen'; // сервер: cancel из planned/no_linen
  const canDelete = w.status !== 'issued'; // owner; выданную удалять нельзя
  const canIssue = w.status === 'done' || w.status === 'stored';

  return (
    <div className={styles.page}>
      <div className={styles.backRow}>
        <Button
          variant="subtle"
          size="sm"
          icon={<ArrowLeft size={15} />}
          onClick={() => router.push('/wash')}
        >
          Список
        </Button>
      </div>
      <PageHeader title={w.client_name} actions={<StatusBadge status={w.status} />} />

      {w.partial_rest && (
        <Card>
          <div className={styles.meta}>
            Уже постирано:{' '}
            {(w.prev_items || [])
              .map((it) => `${it.item_name || it.item_type_id} ×${it.qty}`)
              .join(', ')}
            {w.prev_kg !== '' && w.prev_kg != null && <> · {num(w.prev_kg)} кг</>}
            {num(w.prev_bags) > 0 && <> · {num(w.prev_bags)} мешк.</>}
          </div>
          <div className={styles.meta}>
            В форму ниже вносите только остаток — итоги стирки посчитаются вместе.
          </div>
        </Card>
      )}

      {w.comment && (
        <Card>
          <div className={styles.meta}>
            <MessageSquare size={13} /> {w.comment}
          </div>
        </Card>
      )}

      <Card>
        <div className={styles.meta}>
          Выдача: <b>{w.issue_date}</b>{' '}
          {canIssue && (
            <Button
              variant="subtle"
              size="sm"
              icon={<CalendarClock size={14} />}
              onClick={() => setModal('issueDate')}
            >
              Изменить дату
            </Button>
          )}
        </div>

        {/* Шаг 1: перевод в работу + проверка склада */}
        {(w.status === 'planned' || w.status === 'no_linen') && (
          <>
            {w.status === 'no_linen' && (
              <div className={styles.meta}>Белья нет — проверено в {timeOf(w.done_at)}.</div>
            )}
            {dirtyOk ? (
              <div className={styles.rowBtns}>
                <Button onClick={() => setModal('start')}>В работу</Button>
              </div>
            ) : w.status === 'planned' && w.has_clean ? (
              <div className={styles.meta}>
                Грязного нет. На складе уже есть чистое бельё этого клиента.
              </div>
            ) : w.status === 'planned' ? (
              <div className={styles.meta}>
                Грязного белья этого клиента на складе нет — стирать нечего.
              </div>
            ) : null}
            <div className={styles.rowBtns}>
              <Button variant="ghost" onClick={() => setModal('storage')}>
                Проверить на складе
              </Button>
            </div>
          </>
        )}

        {w.status === 'ready_clean' && (
          <div className={styles.meta}>
            Чистое бельё уже на складе — проверено в {timeOf(w.done_at)}. Стирать не нужно,
            клиент готов к развозу.
          </div>
        )}

        {/* Шаг 2: вес/мешки (в работе) или просмотр (завершённая) */}
        {w.status === 'in_progress' && (
          <>
            {acc !== 'count' && (
              <>
                <div className={styles.resLabel}>Вес чистого белья</div>
                {w.partial_rest && w.prev_kg !== '' && w.prev_kg != null && (
                  <div className={styles.meta}>в первой части: {num(w.prev_kg)} кг</div>
                )}
                <div className={styles.rowBtns}>
                  <Stepper
                    value={weight}
                    steps={WEIGHT_STEPS}
                    onStep={stepWeight}
                    onValueClick={() =>
                      setNumInput({
                        title: 'Вес чистого белья, кг',
                        current: weight,
                        isFloat: true,
                        onOk: (v) => setWeightsMap((m) => ({ ...m, [id]: v })),
                      })
                    }
                  />
                </div>
              </>
            )}
            {/* Мешки — всегда (обязательны при завершении), даже при учёте «только количество» */}
            <div className={styles.resLabel}>Мешки</div>
            {w.partial_rest && num(w.prev_bags) > 0 && (
              <div className={styles.meta}>в первой части: {num(w.prev_bags)} мешк.</div>
            )}
            <div className={styles.rowBtns}>
              <Stepper
                value={bagsVal}
                steps={BAG_STEPS}
                onStep={stepBags}
                onValueClick={() =>
                  setNumInput({
                    title: 'Мешков получилось',
                    current: bagsVal,
                    isFloat: false,
                    onOk: (v) => setBagsMap((m) => ({ ...m, [id]: v })),
                  })
                }
              />
            </div>
          </>
        )}
        {canEdit && (
          <div className={styles.meta}>
            Вес:{' '}
            <b>{w.dirty_weight_kg !== '' && w.dirty_weight_kg != null ? `${num(w.dirty_weight_kg)} кг` : '—'}</b>
            {num(w.bags) > 0 && (
              <>
                {' '}
                · Мешков: <b>{num(w.bags)}</b>
              </>
            )}
          </div>
        )}
      </Card>

      {/* Состав: пересчёт по типам со степперами */}
      {(w.status === 'in_progress' || canEdit) && acc !== 'weight' && (
        <Card>
          <div className={styles.cardTitle}>Состав</div>
          {vis.map((t) => (
            <div key={t.id} className={styles.itemRow}>
              <span className={styles.itemName}>{t.name}</span>
              <Stepper
                value={counts[t.id] || 0}
                steps={BAG_STEPS}
                onStep={(d) => stepCount(t.id, d)}
                onValueClick={() =>
                  setNumInput({
                    title: 'Количество, шт',
                    current: counts[t.id] || 0,
                    isFloat: false,
                    onOk: (v) =>
                      setCountsMap((m) => ({ ...m, [id]: { ...(m[id] || {}), [t.id]: v } })),
                  })
                }
              />
            </div>
          ))}
          <div className={styles.totalRow}>
            Всего: <b className="mono">{total}</b> шт
          </div>
          {w.status === 'in_progress' && (
            <div className={styles.rowBtns}>
              <Button variant="ghost" onClick={() => setModal('addType')}>
                + Добавить вид белья
              </Button>
            </div>
          )}
          {canEdit && (
            <div className={styles.rowBtns}>
              <Button variant="ghost" onClick={() => setModal('edit')}>
                Изменить данные
              </Button>
            </div>
          )}
        </Card>
      )}
      {canEdit && acc === 'weight' && (
        <Card>
          <div className={styles.rowBtns}>
            <Button variant="ghost" onClick={() => setModal('edit')}>
              Изменить данные
            </Button>
          </div>
        </Card>
      )}

      {/* Результат стирки (legacy res-card) */}
      {w.status === 'in_progress' && (
        <Card>
          <div className={styles.cardTitle}>Результат</div>
          <label
            className={`${styles.resCard} ${mode === 'full' ? styles.resCardActive : ''}`}
            data-tone="done"
          >
            <input
              type="radio"
              name="wmode"
              checked={mode === 'full'}
              onChange={() => setMode('full')}
            />
            <span className={styles.resIco}>
              <Check size={15} />
            </span>
            <span className={styles.resText}>
              <b>Выполнено полностью</b>
              <div className={styles.resHint}>Всё постирано — чистое готово к развозу</div>
            </span>
          </label>
          <label
            className={`${styles.resCard} ${mode === 'partial' ? styles.resCardActive : ''}`}
            data-tone="partial"
          >
            <input
              type="radio"
              name="wmode"
              checked={mode === 'partial'}
              onChange={() => setMode('partial')}
            />
            <span className={styles.resIco}>
              <Clock size={15} />
            </span>
            <span className={styles.resText}>
              <b>Выполнено частично</b>
              <div className={styles.resHint}>
                Чистое уйдёт на склад, остаток достируем позже
              </div>
            </span>
          </label>
          <div className={styles.rowBtns}>
            <Button onClick={saveResult} busy={completeMut.isPending}>
              Сохранить результат
            </Button>
          </div>
        </Card>
      )}

      {/* Выдача клиенту (done/stored, сервер: issue из done/stored) */}
      {canIssue && (
        <Card>
          <div className={styles.rowBtns}>
            <Button onClick={() => setConfirm('issued')}>Отметить выданным</Button>
          </div>
        </Card>
      )}

      <Card>
        <div className={styles.cardTitle}>История статусов</div>
        <StatusTimeline w={w} />
      </Card>

      {canDefer && (
        <div>
          <Button variant="ghost" onClick={() => setModal('defer')}>
            Перенести на другой день
          </Button>
        </div>
      )}
      {canCancel && (
        <div>
          <Button variant="subtle" onClick={() => setConfirm('cancel')}>
            Отменить стирку
          </Button>
        </div>
      )}
      {canDelete && (
        <div>
          <Button variant="subtle" onClick={() => setConfirm('delete')}>
            <span style={{ color: 'var(--danger)' }}>Удалить стирку</span>
          </Button>
        </div>
      )}

      {/* --- Модалки --- */}
      {modal === 'start' && (
        <StartWashModal w={w} onDone={() => router.push('/wash')} onClose={() => setModal(null)} />
      )}
      {modal === 'storage' && (
        <StorageCheckModal
          w={w}
          checkedDirty={checkedDirty}
          onHasDirty={() => setCheckedMap((m) => ({ ...m, [id]: true }))}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'addType' && (
        <AddItemTypeModal
          w={w}
          types={types}
          counts={counts}
          extra={extra}
          onPick={(tid, remember) => {
            setExtraMap((m) => ({ ...m, [id]: [...(m[id] || []), tid] }));
            if (remember) rememberMut.mutate([w.client_id, tid]);
          }}
          onCreated={(t) => setCreatedTypes((list) => [...list, t])}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'edit' && (
        <EditWashModal
          w={w}
          counts={counts}
          totalQty={total}
          onSaved={() => setCountsMap((m) => ({ ...m, [id]: {} }))}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'defer' && (
        <DeferWashModal w={w} onDone={() => router.push('/wash')} onClose={() => setModal(null)} />
      )}
      {modal === 'issueDate' && <IssueDateModal w={w} onClose={() => setModal(null)} />}

      {/* --- Подтверждения --- */}
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        onConfirm={() => deleteMut.mutate(w.id)}
        text={`Удалить стирку «${w.client_name}» от ${formatDateRu(
          w.wash_date
        )} безвозвратно? Позиции и складские записи этой стирки тоже удалятся.`}
        okLabel="Удалить"
        danger
        busy={deleteMut.isPending}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        onConfirm={() => cancelMut.mutate(w.id)}
        text={`Отменить стирку «${w.client_name}» от ${formatDateRu(
          w.wash_date
        )}? Запись останется в отчёте как отменённая.`}
        okLabel="Отменить стирку"
        danger
        busy={cancelMut.isPending}
      />
      <ConfirmDialog
        open={confirm === 'issued'}
        onClose={() => setConfirm(null)}
        onConfirm={() => issuedMut.mutate(w.id)}
        text={`Отметить выдачу клиенту «${w.client_name}»?`}
        okLabel="Выдано"
        busy={issuedMut.isPending}
      />

      {numInput && (
        <NumInputModal
          title={numInput.title}
          current={numInput.current}
          isFloat={numInput.isFloat}
          onOk={numInput.onOk}
          onClose={() => setNumInput(null)}
        />
      )}
    </div>
  );
}
