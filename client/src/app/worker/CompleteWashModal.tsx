'use client';

// Завершение стирки из модалки (упрощение экрана владельца до степперов).
// Поля и payload — 1:1 с legacy saveResult (server/public/index.html:831-850):
// completeWash(washId, items, weightKg, mode, bags).
import { useState } from 'react';
import { Check, Clock } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { num } from '@/lib/format';
import type { DayWash, ItemType, Wash } from '@/types/api';
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
  onValueChange,
  step = 1,
}: {
  value: number;
  steps: Array<{ delta: number; label: string }>;
  onStep: (delta: number) => void;
  onValueChange: (value: number) => void;
  step?: number;
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
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={step}
        className={styles.stepperInput}
        value={value === 0 ? '' : value}
        placeholder="0"
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          onValueChange(Number.isNaN(v) ? 0 : Math.max(0, v));
        }}
        onFocus={(e) => e.target.select()}
      />
    </div>
  );
}

function countsToItems(counts: Record<string, number>) {
  return Object.keys(counts)
    .filter((k) => counts[k] > 0)
    .map((k) => ({ item_type_id: k, qty: counts[k] }));
}

export interface CompleteWashModalProps {
  w: DayWash;
  itemTypes: ItemType[];
  onClose: () => void;
}

export function CompleteWashModal({ w, itemTypes, onClose }: CompleteWashModalProps) {
  const toast = useUiStore((s) => s.toast);
  const acc = w.client_accounting || 'both';

  const [counts, setCounts] = useState<Record<string, number>>({});
  const [weight, setWeight] = useState<number>(num(w.dirty_weight_kg) || 0);
  const [bags, setBags] = useState<number>(0);
  const [mode, setMode] = useState<'full' | 'partial'>('full');

  // Видимые виды белья: список клиента или весь справочник (legacy renderWashCard)
  const vis: ItemType[] =
    w.client_item_types && w.client_item_types.length
      ? itemTypes.filter((t) => w.client_item_types.indexOf(t.id) !== -1)
      : itemTypes.slice();

  const total = Object.keys(counts).reduce((s, k) => s + (counts[k] || 0), 0);

  const mutation = useApiMutation<{ ok: true; wash: Wash }>('completeWash', {
    invalidate: 'operational',
    onSuccess: (res) => {
      const st = res.wash.status;
      toast(
        st === 'partial'
          ? 'Частично завершено: чистое на складе'
          : st === 'stored'
            ? 'Стирка завершена ✓ бельё на склад'
            : 'Стирка завершена ✓'
      );
      onClose();
    },
  });

  function save() {
    console.log(counts)
    if (acc !== 'count' && weight <= 0) {
      toast('Укажите вес грязного белья', 'err');
      return;
    }
    if (bags <= 0) {
      toast('Укажите количество мешков', 'err');
      return;
    }
    if(acc !== 'weight' && Object.keys(counts).length === 0 ) {
      toast('Укажите количество вещей', 'err');
      return;
    }
    mutation.mutate([w.id, countsToItems(counts), weight, mode, bags]);
  }

  const stepCount = (tid: string, d: number) =>
    setCounts((m) => ({ ...m, [tid]: Math.max(0, (m[tid] || 0) + d) }));

  return (
    <Modal
      open
      onClose={onClose}
      title={`Завершить: ${w.client_name}`}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={mutation.isPending}>
            Отмена
          </Button>
          <Button onClick={save} busy={mutation.isPending}>
            Сохранить результат
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
              onValueChange={(v) => setWeight(Math.round(v * 10) / 10)}
              step={0.1}
            />
          </div>
        )}
        {/* Мешки — всегда (обязательны при завершении) */}
        <div>
          <div className={styles.fieldLabel}>Мешки</div>
          <Stepper
            value={bags}
            steps={UNIT_STEPS}
            onStep={(d) => setBags((v) => Math.max(0, v + d))}
            onValueChange={(v) => setBags(Math.round(v))}
          />
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
                  onValueChange={(v) =>
                    setCounts((m) => ({ ...m, [t.id]: Math.max(0, Math.round(v)) }))
                  }
                />
              </div>
            ))}
            <div className={styles.totalRow}>
              Всего: <b className="mono">{total}</b> шт
            </div>
          </div>
        )}
        <div>
          <div className={styles.fieldLabel}>Результат</div>
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
              <div className={styles.resHint}>Чистое уйдёт на склад, остаток достируем позже</div>
            </span>
          </label>
        </div>
      </div>
    </Modal>
  );
}
