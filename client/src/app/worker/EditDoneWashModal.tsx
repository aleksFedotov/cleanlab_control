'use client';

// Правка завершённой стирки работником (если ошиблись при завершении):
// вес, мешки, количество вещей — степперами, как в CompleteWashModal.
// Сервер: editWashData (worker — пока смена дня открыта, server/api.js).
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { num } from '@/lib/format';
import type { DayWash, ItemType } from '@/types/api';
import styles from './worker.module.css';

const WEIGHT_STEPS = [
  { delta: -1, label: '−1' },
  { delta: -0.1, label: '−0.1' },
  { delta: 0.1, label: '+0.1' },
  { delta: 1, label: '+1' },
  { delta: 5, label: '+5' },
];
const UNIT_STEPS = [
  { delta: -1, label: '−' },
  { delta: 1, label: '+' },
];

function Stepper({
  value,
  steps,
  onStep,
}: {
  value: number;
  steps: Array<{ delta: number; label: string }>;
  onStep: (delta: number) => void;
}) {
  return (
    <div className={styles.stepper}>
      {steps.map((s) => (
        <button
          key={s.label}
          type="button"
          className={styles.stepperBtn}
          onClick={() => onStep(s.delta)}
        >
          {s.label}
        </button>
      ))}
      <span className={styles.stepperVal}>{value}</span>
    </div>
  );
}

export interface EditDoneWashModalProps {
  w: DayWash;
  itemTypes: ItemType[];
  onClose: () => void;
}

export function EditDoneWashModal({ w, itemTypes, onClose }: EditDoneWashModalProps) {
  const toast = useUiStore((s) => s.toast);
  const acc = w.client_accounting || 'both';

  // Стартовые значения — текущий результат стирки (items приходят из getDayList)
  const [counts, setCounts] = useState<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    (w.items || []).forEach((it) => {
      m[it.item_type_id] = it.qty;
    });
    return m;
  });
  const [weight, setWeight] = useState<number>(num(w.dirty_weight_kg) || 0);
  const [bags, setBags] = useState<number>(num(w.bags) || 0);

  // Видимые виды белья: список клиента или весь справочник; плюс типы, которые
  // уже есть в стирке, даже если их нет в списке клиента (legacy-данные)
  const vis: ItemType[] =
    w.client_item_types && w.client_item_types.length
      ? itemTypes.filter((t) => w.client_item_types.indexOf(t.id) !== -1)
      : itemTypes.slice();
  (w.items || []).forEach((it) => {
    if (!vis.some((t) => t.id === it.item_type_id)) {
      vis.push({ id: it.item_type_id, name: it.item_name || it.item_type_id } as ItemType);
    }
  });

  const total = Object.keys(counts).reduce((s, k) => s + (counts[k] || 0), 0);

  const mutation = useApiMutation('editWashData', {
    invalidate: 'operational',
    onSuccess: () => {
      toast('Данные обновлены ✓');
      onClose();
    },
  });

  function save() {
    const items = Object.keys(counts)
      .filter((k) => counts[k] > 0)
      .map((k) => ({ item_type_id: k, qty: counts[k] }));
    mutation.mutate([w.id, weight, items, bags]);
  }

  const stepCount = (tid: string, d: number) =>
    setCounts((m) => ({ ...m, [tid]: Math.max(0, (m[tid] || 0) + d) }));

  return (
    <Modal
      open
      onClose={onClose}
      title={`Исправить: ${w.client_name}`}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={mutation.isPending}>
            Отмена
          </Button>
          <Button onClick={save} busy={mutation.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {acc !== 'count' && (
          <div>
            <div className={styles.fieldLabel}>Вес чистого белья, кг</div>
            <Stepper
              value={weight}
              steps={WEIGHT_STEPS}
              onStep={(d) => setWeight((v) => Math.max(0, Math.round((v + d) * 10) / 10))}
            />
          </div>
        )}
        <div>
          <div className={styles.fieldLabel}>Мешки</div>
          <Stepper value={bags} steps={UNIT_STEPS} onStep={(d) => setBags((v) => Math.max(0, v + d))} />
        </div>
        {acc !== 'weight' && vis.length > 0 && (
          <div>
            <div className={styles.fieldLabel}>Количество вещей</div>
            {vis.map((t) => (
              <div key={t.id} className={styles.itemRow}>
                <span className={styles.itemName}>{t.name}</span>
                <Stepper
                  value={counts[t.id] || 0}
                  steps={UNIT_STEPS}
                  onStep={(d) => stepCount(t.id, d)}
                />
              </div>
            ))}
            <div className={styles.totalRow}>
              Всего: <b className="mono">{total}</b> шт
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
