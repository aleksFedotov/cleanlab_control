'use client';

// Модал точки развоза (P6) — общий для экрана водителя («Маршрут»/«История»)
// и страницы «Развоз» у владельца.
// Открытый визит (planned): степпер этажа + кнопки действий (driverAction).
// Закрытый визит: правка этажа (setVisitLiftFloor, сохраняется кнопкой) и блок
// «Исправить» — отмены ошибочных действий (correctVisit). После отмены визит
// снова planned и модал перерисовывается в режим действий (родитель передаёт
// визит из query-данных по id, а не снапшот).
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { DecoratedVisit } from '@/types/api';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { num, bags } from '@/lib/format';
import { timeOf } from '@/lib/dates';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import styles from './VisitEditModal.module.css';

// Водительский тип визита шире (address/access_note), у владельца их нет — оба optional
export type VisitEditTarget = DecoratedVisit & { address?: string; access_note?: string };

export interface VisitEditModalProps {
  visit: VisitEditTarget | null;
  onClose: () => void;
}

type DriverAction = 'take_clean' | 'deliver_clean' | 'pickup_dirty' | 'both' | 'empty';
type CorrectOp = 'undo_empty' | 'undo_take_clean' | 'undo_deliver' | 'undo_pickup';

// Действия по состоянию точки — 1:1 из legacy openDriverVisit
function actionsFor(v: VisitEditTarget): Array<{ act: DriverAction; label: string; primary: boolean }> {
  const rows: Array<{ act: DriverAction; label: string; primary: boolean }> = [];
  const stockBags = num(v.clean_stock_bags);
  if (v.clean_taken_at && !v.delivered_at) {
    // Комбо: чистое у водителя и грязное ещё не забрано — одна кнопка вместо двух
    if (!v.picked_at) rows.push({ act: 'both', label: 'Отдал чистое, забрал грязное', primary: true });
    rows.push({ act: 'deliver_clean', label: 'Доставлено', primary: !v.picked_at ? false : true });
  } else if (v.has_clean) {
    rows.push({ act: 'take_clean', label: 'Взял чистое' + (stockBags ? ` (${bags(stockBags)})` : ''), primary: true });
  }
  if (!v.picked_at) rows.push({ act: 'pickup_dirty', label: 'Забрал грязное', primary: rows.length === 0 });
  if (!v.clean_taken_at && !v.picked_at) rows.push({ act: 'empty', label: 'Ничего нет', primary: false });
  return rows;
}

// Метастрока точки — 1:1 из legacy renderDriver
function visitMeta(v: VisitEditTarget, done: boolean): string[] {
  const meta: string[] = [];
  if (v.address) meta.push(v.address);
  if (!done) {
    if (v.clean_taken_at && !v.delivered_at) {
      meta.push('🚚 чистое у вас' + (num(v.clean_bags) ? `: ${bags(num(v.clean_bags))}` : ''));
    } else if (v.has_clean) {
      meta.push('✨ чистое на складе: ' + (num(v.clean_stock_bags) ? bags(num(v.clean_stock_bags)) : 'есть'));
    }
    if (v.picked_at) meta.push('🟥 грязное у вас');
    else meta.push('🧺 забрать грязное');
  }
  return meta;
}

// Отмены по текущему состоянию визита (P6). Условия — как на сервере (correctVisit).
function correctionsFor(v: VisitEditTarget): Array<{ op: CorrectOp; label: string; what: string }> {
  const rows: Array<{ op: CorrectOp; label: string; what: string }> = [];
  if (v.status === 'empty') rows.push({ op: 'undo_empty', label: 'Отменить «Ничего нет»', what: '«Ничего нет»' });
  if (v.delivered_at && (v.status === 'delivered' || v.status === 'both')) {
    rows.push({ op: 'undo_deliver', label: 'Отменить выдачу чистого', what: 'выдачу чистого' });
  }
  if (v.picked_at) rows.push({ op: 'undo_pickup', label: 'Отменить забор грязного', what: 'забор грязного' });
  if (v.clean_taken_at && !v.delivered_at) {
    rows.push({ op: 'undo_take_clean', label: 'Отменить «Взял чистое»', what: '«Взял чистое»' });
  }
  return rows;
}

export function VisitEditModal({ visit, onClose }: VisitEditModalProps) {
  const toast = useUiStore((s) => s.toast);
  const [floor, setFloor] = useState(1);
  const [noteOpen, setNoteOpen] = useState(false);
  const [takeConfirm, setTakeConfirm] = useState(false);
  const [undoTarget, setUndoTarget] = useState<{ op: CorrectOp; what: string } | null>(null);

  // Этаж и блок «Как пройти» сбрасываются при смене точки
  // (adjust-state-during-render вместо эффекта — рекомендация react.dev)
  const [prevVisitId, setPrevVisitId] = useState(visit?.id);
  if (visit?.id !== prevVisitId) {
    setPrevVisitId(visit?.id);
    setFloor(Math.max(1, Math.floor(num(visit?.lift_floor)) || 1));
    setNoteOpen(false);
  }

  const actionMut = useApiMutation('driverAction', {
    invalidate: 'operational',
    onSuccess: () => {
      toast('Отмечено ✓');
      onClose();
    },
  });
  const correctMut = useApiMutation('correctVisit', {
    invalidate: 'operational',
    // Модал не закрываем: визит снова planned → появятся кнопки действий
    onSuccess: () => toast('Исправлено ✓'),
  });
  const floorMut = useApiMutation('setVisitLiftFloor', {
    invalidate: 'operational',
    onSuccess: () => toast('Этаж сохранён ✓'),
  });

  const closed = !!visit && visit.status !== 'planned';
  const corrections = visit ? correctionsFor(visit) : [];
  // Правка этажа в закрытом визите: показываем «Сохранить», только если значение изменилось
  const savedFloor = Math.max(1, Math.floor(num(visit?.lift_floor)) || 1);
  const floorDirty = closed && floor !== savedFloor;

  const runAction = (act: DriverAction) => {
    if (!visit) return;
    const lift = floor > 2 ? floor : null; // пусто/1/2 — без доплаты (сервер нормализует)
    if (act === 'take_clean') {
      // Как в legacy: подтверждение перед take_clean
      setTakeConfirm(true);
      return;
    }
    actionMut.mutate([visit.id, act, lift]);
  };

  return (
    <>
      <Modal open={!!visit} onClose={onClose} title={visit?.client_name || ''}>
        {visit && (
          <>
            {closed ? (
              <div className={styles.metaDim}>
                {[
                  visit.address,
                  visit.delivered_at && `Выдано ${timeOf(visit.delivered_at)}`,
                  visit.picked_at && `Забрано ${timeOf(visit.picked_at)}`,
                  visit.clean_taken_at && !visit.delivered_at && 'Чистое у водителя',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            ) : (
              <div className={styles.metaDim}>{visitMeta(visit, false).join(' · ')}</div>
            )}
            {visit.access_note && (
              <>
                <Button
                  variant="ghost"
                  className={styles.bigBtn}
                  icon={<KeyRound size={16} />}
                  onClick={() => setNoteOpen((o) => !o)}
                >
                  Как пройти
                </Button>
                {noteOpen && <div className={styles.accessNote}>{visit.access_note}</div>}
              </>
            )}
            <div className={styles.floorRow}>
              <span className={styles.floorLabel}>Этаж</span>
              <Button
                variant="subtle"
                size="sm"
                aria-label="Этаж ниже"
                disabled={floor <= 1}
                onClick={() => setFloor((f) => Math.max(1, f - 1))}
              >
                −
              </Button>
              <span className={styles.floorVal}>{floor}</span>
              <Button
                variant="subtle"
                size="sm"
                aria-label="Этаж выше"
                onClick={() => setFloor((f) => f + 1)}
              >
                +
              </Button>
              {floor > 2 && <span className={styles.metaDim}>доплата за подъём</span>}
              {floorDirty && (
                <Button
                  variant="subtle"
                  size="sm"
                  busy={floorMut.isPending}
                  onClick={() => floorMut.mutate([visit.id, floor])}
                >
                  Сохранить
                </Button>
              )}
            </div>
            {!closed &&
              actionsFor(visit).map((a) => (
                <Button
                  key={a.act}
                  variant={a.primary ? 'primary' : 'ghost'}
                  className={styles.bigBtn}
                  busy={actionMut.isPending}
                  onClick={() => runAction(a.act)}
                >
                  {a.label}
                </Button>
              ))}
            {corrections.length > 0 && (
              <>
                {closed && <div className={styles.correctLabel}>Исправить</div>}
                {corrections.map((c) => (
                  <Button
                    key={c.op}
                    variant="ghost"
                    className={styles.bigBtn}
                    busy={correctMut.isPending}
                    onClick={() => setUndoTarget({ op: c.op, what: c.what })}
                  >
                    {c.label}
                  </Button>
                ))}
              </>
            )}
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={takeConfirm}
        onClose={() => setTakeConfirm(false)}
        onConfirm={() => {
          if (visit) actionMut.mutate([visit.id, 'take_clean', floor > 2 ? floor : null]);
          setTakeConfirm(false);
        }}
        text="Чистое бельё взято со склада?"
        okLabel="Да, взял"
        busy={actionMut.isPending}
      />

      <ConfirmDialog
        open={!!undoTarget}
        onClose={() => setUndoTarget(null)}
        onConfirm={() => {
          if (visit && undoTarget) correctMut.mutate([visit.id, undoTarget.op]);
          setUndoTarget(null);
        }}
        text={
          visit && undoTarget
            ? `Отменить ${undoTarget.what} по точке «${visit.client_name}»? Счёт и зарплата за период пересчитаются.`
            : ''
        }
        okLabel="Отменить действие"
        busy={correctMut.isPending}
      />
    </>
  );
}
